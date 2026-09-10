import { FileCredentialStore } from '@agent-core/auth';
import { type ModelReasoningRequest } from '@agent-core/model';
import { JsonlEventRepository } from '@agent-core/persistence/node';
import { loginOpenAICodexDeviceCode } from '@agent-core/provider-openai-codex';
import { agentEventCodec, sourceRef, type AgentEvent } from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
import {
  ApplicationEvents,
  progressReplacementKey,
  SessionNotes,
  type SessionNoteRead
} from '@agents/application';
import { randomUUID } from 'node:crypto';
import { readRecordedMutationPatches } from '../changes/run-change-report.js';
import type { CodingSession } from '../coding-session.js';
import { type CodingAgentProviderId } from '../configuration.js';
import type { CodingRunResult } from '../outcome.js';
import { resolveCodingAuthority, type CodingPermissionMode } from '../security/permission-mode.js';
import { createTrustDecision } from '../security/workspace-trust.js';
import { closeCodingSession } from '../session.js';
import { ModelSelectionStore } from '../state/model-selection-store.js';
import {
  codingWorkspaceSessionBinding,
  openCodingWorkspace,
  type OpenCodingWorkspace
} from '../workspace.js';
import type {
  CodingApplicationEvent,
  CodingApplicationState,
  CodingLoginResult,
  CodingRuntimeDetails,
  CodingSubmissionResult
} from './contracts.js';
import {
  admittedTrustLevel,
  createRuntime,
  loadProjectConfiguration,
  parseProviderId,
  persistedModelSettings,
  readCodingHistoryPage,
  readCodingSessionView,
  requireIdleSession,
  resolveRuntimeSettingsSelection,
  selectSession,
  type CodingAgentRuntimeComposition,
  type CodingApplicationOptions,
  type RuntimeSettingsSelection
} from './runtime.js';

export class CodingApplication {
  private readonly events = new ApplicationEvents<CodingApplicationEvent>((event) =>
    event.type === 'run.progress' ? progressReplacementKey(event.event) : undefined
  );
  private run: Promise<void> = Promise.resolve();
  private workspace: OpenCodingWorkspace;
  private runtime: CodingAgentRuntimeComposition | undefined;
  private runtimeUnsubscribe: (() => void) | undefined;
  private selectedSessionId: string | undefined;
  private resolvedSettings: RuntimeSettingsSelection = {};
  private configurationLoaded = false;
  private started = false;
  private closed = false;
  private closeCompletion: Promise<void> | undefined;
  private applicationState: CodingApplicationState;

  constructor(
    private readonly options: CodingApplicationOptions,
    workspace: OpenCodingWorkspace
  ) {
    this.workspace = workspace;
    this.applicationState = Object.freeze({
      status: 'initializing',
      requirements: Object.freeze([]),
      runtimeDetails: Object.freeze({ workspaceTrust: workspace.security.trustLevel })
    });
  }

  state(): CodingApplicationState {
    return this.runtime === undefined
      ? this.applicationState
      : { ...this.applicationState, session: this.runtime.agent.state() };
  }

  subscribe(listener: (event: CodingApplicationEvent) => void | Promise<void>): () => void {
    return this.events.subscribe(listener);
  }

  start(): Promise<void> {
    return this.serial(async () => {
      if (this.started) return;
      this.started = true;
      await this.refreshAndActivate();
    });
  }

  submit(task: string, options?: Parameters<CodingSession['submit']>[1]): Promise<CodingSubmissionResult> {
    return this.serial(async () => {
      if (!task.trim()) throw new Error('A submission requires non-empty text.');
      if (this.runtime === undefined) await this.refreshAndActivate();
      if (this.runtime === undefined)
        return {
          kind: 'rejected',
          reason: 'setup_required',
          requirements: this.applicationState.requirements
        };
      return this.runtime.agent.submit({ task }, options);
    });
  }

  resolveApproval(input: Parameters<CodingSession['resolveApproval']>[0]) {
    return this.requireRuntime().agent.resolveApproval(input);
  }

  async updateQueuedSubmission(...args: Parameters<CodingSession['updateQueuedSubmission']>): Promise<void> {
    await this.requireRuntime().agent.updateQueuedSubmission(...args);
    await this.publishState('ready', []);
  }

  async listFiles(
    directory = '.',
    prefix = ''
  ): Promise<readonly { readonly path: string; readonly kind: 'file' | 'directory' }[]> {
    this.assertOpen();
    const decision = this.workspace.security.decide('workspace_read');
    if (decision.kind !== 'allowed') throw new Error(decision.reason);
    const canonical = this.workspace.fileRoot.canonicalPath(directory);
    const handle = await this.workspace.fileRoot.openDirectory(canonical);
    try {
      return (await handle.entries())
        .flatMap((entry) => {
          const path = canonical === '.' ? entry.name : `${canonical}/${entry.name}`;
          return entry.name.startsWith(prefix) &&
            !this.workspace.fileRoot.isReservedPath(path) &&
            (entry.type === 'file' || entry.type === 'directory')
            ? [{ path, kind: entry.type }]
            : [];
        })
        .sort((left, right) => left.path.localeCompare(right.path));
    } finally {
      await handle.close();
    }
  }

  close(): Promise<void> {
    this.closeCompletion ??= this.closeOwnedResources();
    return this.closeCompletion;
  }

  private async closeOwnedResources(): Promise<void> {
    this.closed = true;
    await this.run.catch(() => undefined);
    const runtime = this.runtime;
    this.runtime = undefined;
    this.runtimeUnsubscribe?.();
    this.runtimeUnsubscribe = undefined;
    const failures: unknown[] = [];
    if (runtime !== undefined) {
      try {
        await runtime.agent.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await closeCodingSession(runtime);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      this.workspace.fileRoot.close();
    } catch (error) {
      failures.push(error);
    }
    this.events.close();
    if (failures.length > 0) throw new AggregateError(failures, 'Coding application cleanup failed.');
  }

  private async refreshAndActivate(): Promise<void> {
    this.assertOpen();
    if (!this.configurationLoaded) await this.loadConfiguration();
    this.resolvedSettings = await this.resolveSettings();
    const requirements = setupRequirements(this.workspace, this.resolvedSettings);
    if (requirements.length > 0) {
      await this.publishState('setup_required', requirements);
      return;
    }
    if (this.runtime === undefined) await this.activateRuntime();
    await this.publishState('ready', []);
  }

  private async loadConfiguration(): Promise<void> {
    delete this.options.configuration;
    delete this.options.configurationSource;
    if (this.workspace.security.trustLevel !== 'untrusted') {
      const proposal = await loadProjectConfiguration(this.workspace, this.options.config);
      if (proposal) {
        this.options.configuration = proposal.value;
        this.options.configurationSource = Object.freeze({
          sourceUri: proposal.provenance.sourceUri,
          sha256: proposal.provenance.sha256,
          trustLevel: this.workspace.security.trustLevel
        });
      }
    }
    this.configurationLoaded = true;
  }

  private async resolveSettings(): Promise<RuntimeSettingsSelection> {
    const sessions = new JsonlSessionRepository({ rootDir: this.workspace.layout.sessionsDir });
    const session = await selectSession(
      this.options,
      sessions,
      codingWorkspaceSessionBinding(this.workspace.layout.identity),
      this.selectedSessionId
    );
    const persisted = session === undefined ? undefined : await persistedModelSettings(sessions, session);
    const stored = await new ModelSelectionStore(this.workspace.privateState).read();
    return resolveRuntimeSettingsSelection(
      this.options,
      persisted,
      this.workspace.security.decide('project_execution_policy').kind === 'allowed',
      stored
    );
  }

  private async activateRuntime(): Promise<void> {
    const provider = this.resolvedSettings.provider;
    const model = this.resolvedSettings.model;
    if (provider === undefined || model === undefined)
      throw new Error('Runtime activation requires a complete model selection.');
    const activationOptions: CodingApplicationOptions = {
      ...this.options,
      provider,
      model,
      ...(this.resolvedSettings.temperature === undefined
        ? {}
        : { temperature: this.resolvedSettings.temperature }),
      ...(this.resolvedSettings.reasoning === undefined ? {} : { reasoning: this.resolvedSettings.reasoning })
    };
    const runtime = await createRuntime(activationOptions, this.workspace, this.selectedSessionId);
    this.runtime = runtime;
    this.selectedSessionId = runtime.session.id;
    delete this.options.branch;
    this.runtimeUnsubscribe = runtime.agent.subscribe((event) => this.onSessionEvent(runtime, event));
    await runtime.agent.restore();
    await this.emit({ type: 'session.restored', view: await readCodingSessionView(runtime) });
    if (runtime.agent.state().queuedInputs > 0)
      void runtime.agent.waitForIdle().catch((error: unknown) =>
        this.emit({
          type: 'delivery.failed',
          error: error instanceof Error ? error : new Error(String(error))
        })
      );
  }

  private async deactivateRuntime(): Promise<void> {
    const runtime = this.runtime;
    if (runtime === undefined) return;
    requireIdleSession(runtime.agent);
    this.runtime = undefined;
    this.runtimeUnsubscribe?.();
    this.runtimeUnsubscribe = undefined;
    await closeCodingSession(runtime);
  }

  private async onSessionEvent(
    runtime: CodingAgentRuntimeComposition,
    event: import('../coding-session.js').CodingSessionEvent
  ): Promise<void> {
    if (this.runtime !== runtime) return;
    await this.emit(event);
    if (event.type === 'run.completed' && event.result.state === 'ended') {
      const handoff = await runtime.handoffs.read(event.runId);
      if (handoff) await this.emit({ type: 'handoff.ready', handoff });
    }
    if (event.type !== 'run.progress') await this.publishState('ready', []);
  }

  selectProvider(provider: CodingAgentProviderId): Promise<CodingApplicationState> {
    return this.serial(async () => {
      await this.beginReconfiguration();
      this.options.provider = provider;
      delete this.options.model;
      await new ModelSelectionStore(this.workspace.privateState).write({ provider });
      await this.refreshAndActivate();
      return this.state();
    });
  }

  selectModel(value: string): Promise<CodingApplicationState> {
    return this.serial(async () => {
      const model = value.trim();
      if (!model) throw new Error('A model ID is required.');
      const provider = this.options.provider ?? this.resolvedSettings.provider;
      if (provider === undefined) throw new Error('Select a provider before selecting a model.');
      await this.beginReconfiguration();
      this.options.provider = provider;
      this.options.model = model;
      await new ModelSelectionStore(this.workspace.privateState).write({ provider, model });
      await this.refreshAndActivate();
      return this.state();
    });
  }

  selectPermissionMode(permissionMode: CodingPermissionMode): Promise<CodingApplicationState> {
    return this.serial(async () => {
      await this.beginReconfiguration();
      this.options.permissionMode = permissionMode;
      await this.refreshAndActivate();
      return this.state();
    });
  }

  selectWorkspaceTrust(level: 'restricted' | 'trusted'): Promise<CodingApplicationState> {
    return this.serial(async () => {
      await this.beginReconfiguration();
      await this.workspace.trustStore.write(
        createTrustDecision({
          workspace: this.workspace.layout.identity,
          level,
          actorKind: 'user',
          actor: 'local-user'
        })
      );
      this.workspace.fileRoot.close();
      this.workspace = await openCodingWorkspace(
        this.workspace.layout.workspaceRoot,
        this.options.stateRoot ? { stateRoot: this.options.stateRoot } : {}
      );
      this.configurationLoaded = false;
      await this.refreshAndActivate();
      return this.state();
    });
  }

  async login(selected?: CodingAgentProviderId): Promise<CodingLoginResult> {
    const provider = selected ?? this.resolvedSettings.provider;
    if (provider === undefined) throw new Error('Select a provider before authenticating.');
    if (provider === 'ollama') return { kind: 'not_required', provider };
    if (provider === 'openrouter' || provider === 'openai')
      return {
        kind: 'api_key',
        provider,
        available: Boolean(
          process.env[provider === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY']?.trim()
        )
      };
    let delivery: Promise<void> | undefined;
    await loginOpenAICodexDeviceCode({
      store: new FileCredentialStore(),
      key: provider,
      onDeviceCode: (info) => {
        delivery = this.emit({
          type: 'authentication.required',
          verificationUri: info.verificationUri,
          userCode: info.userCode,
          expiresInSeconds: info.expiresInSeconds
        });
      }
    });
    await delivery;
    return { kind: 'authenticated', provider };
  }

  selectTemperature(temperature: number): Promise<CodingApplicationState> {
    return this.serial(async () => {
      if (!Number.isFinite(temperature)) throw new Error('Temperature must be finite.');
      await this.beginReconfiguration();
      this.options.temperature = temperature;
      await this.refreshAndActivate();
      return this.state();
    });
  }

  selectReasoning(reasoning: ModelReasoningRequest): Promise<CodingApplicationState> {
    return this.serial(async () => {
      await this.beginReconfiguration();
      this.options.reasoning = reasoning;
      await this.refreshAndActivate();
      return this.state();
    });
  }

  steer(task: string, expectedRunId?: string): Promise<CodingSubmissionResult> {
    return this.submit(task, {
      delivery: 'steer',
      ...(expectedRunId === undefined ? {} : { expectedRunId })
    });
  }

  follow(task: string): Promise<CodingSubmissionResult> {
    return this.submit(task, { delivery: 'follow_up' });
  }

  listNotes(cursor?: string) {
    const { history, notes } = this.requireRuntime();
    return new SessionNotes(history, notes).list(cursor);
  }
  readNote(request: SessionNoteRead) {
    const { history, notes } = this.requireRuntime();
    return new SessionNotes(history, notes).read(request);
  }

  inspectContext() {
    return this.requireRuntime().context.inspect();
  }

  async retainHistory() {
    const runtime = this.requireRuntime();
    const view = await runtime.history.view();
    return runtime.agent.transitionContext({
      expectedWindowId: view.contextWindow?.windowId ?? null,
      expectedSourceRevision: view.cut.sourceRevision,
      idempotencyKey: randomUUID(),
      reason: 'User requested original history retention.',
      selection: {
        strategy: 'retain',
        retained: view.entries
          .filter((entry) => entry.type !== 'context_transition')
          .map((entry) => sourceRef(view.cut.sessionId, entry)),
        notes: view.contextWindow?.selection.notes ?? [],
        omitted: []
      }
    });
  }

  readPendingSubmissions() {
    const runtime = this.requireRuntime();
    return runtime.sessions.loadPendingSubmissions(runtime.session);
  }

  waitForIdle(): Promise<void> {
    return this.requireRuntime().agent.waitForIdle();
  }
  readHandoff(runId: string) {
    return this.requireRuntime().handoffs.read(runId);
  }
  persistenceLocations(runId: string) {
    const runtime = this.requireRuntime();
    return { ledger: runtime.events.location(runId), session: runtime.sessions.location(runtime.session.id) };
  }
  restoreRun(runId: string): Promise<void> {
    return this.serial(async () => {
      await this.deactivateRuntime();
      const events = new JsonlEventRepository<AgentEvent>({
        rootDir: this.workspace.layout.runsDir,
        codec: agentEventCodec
      });
      const configured = (await events.latestOfType(runId, 'run.configured'))?.event;
      const turn = (await events.latestOfType(runId, 'turn.started'))?.event;
      if (
        configured?.type !== 'run.configured' ||
        turn?.type !== 'turn.started' ||
        turn.sessionId === undefined
      )
        throw new Error(
          `Run ${runId} does not record the model and session identities required for restoration.`
        );
      this.options.provider = parseProviderId(configured.configuration.provider.id);
      this.options.model = configured.configuration.model.id;
      this.selectedSessionId = turn.sessionId;
      this.started = true;
      await this.refreshAndActivate();
    });
  }

  async readChange(runId: string, path: string) {
    const runtime = this.requireRuntime();
    const decision = this.workspace.security.decide('workspace_read');
    if (decision.kind !== 'allowed') throw new Error(decision.reason);
    const handoff = await runtime.handoffs.read(runId);
    const change = handoff?.changeReport.changes.find((change) => change.path === path);
    if (handoff === undefined || change === undefined)
      throw new Error('The requested change is not recorded in this run report.');
    const receipts = handoff.changeReport.mutationReceipts.filter((receipt) =>
      change.receiptSequences.includes(receipt.sequence)
    );
    const patches = await readRecordedMutationPatches(runtime.events, runId, receipts);
    return { change, patches, outcome: handoff.outcome };
  }

  readSession() {
    return readCodingSessionView(this.requireRuntime());
  }

  readHistory(request?: Parameters<JsonlSessionRepository['readBranchPage']>[1]) {
    return readCodingHistoryPage(this.requireRuntime(), request);
  }

  searchHistory(request: Parameters<JsonlSessionRepository['searchBranch']>[1]) {
    const runtime = this.requireRuntime();
    return runtime.sessions.searchBranch(runtime.session, request);
  }

  readHistoryEntry(boundary: Parameters<JsonlSessionRepository['readBranchEntry']>[1], entryId: string) {
    const runtime = this.requireRuntime();
    return runtime.sessions.readBranchEntry(runtime.session, boundary, entryId);
  }

  listSessions() {
    this.assertOpen();
    return new JsonlSessionRepository({ rootDir: this.workspace.layout.sessionsDir }).list();
  }

  selectSession(sessionId: string): Promise<void> {
    return this.serial(async () => {
      await this.deactivateRuntime();
      this.selectedSessionId = sessionId;
      await this.refreshAndActivate();
    });
  }

  async branchFrom(entryId: string, label?: string): Promise<void> {
    const runtime = this.requireRuntime();
    await runtime.agent.branchFrom(entryId, label);
    await this.emit({ type: 'session.restored', view: await readCodingSessionView(runtime) });
  }

  abort(reason?: string, expectedRunId?: string): Promise<boolean> {
    const agent = this.requireRuntime().agent;
    return agent.abort(reason, expectedRunId ?? agent.state().activeRunId);
  }

  async resumeSuspension(expectedRunId?: string): Promise<CodingRunResult> {
    const agent = this.requireRuntime().agent;
    const pending = agent.state().pendingSettlement;
    if (pending) {
      if (expectedRunId !== undefined && pending.runId !== expectedRunId) throw new Error('The selected run has changed.');
      return agent.reconcileWork(pending.runId);
    }
    await agent.restore();
    const suspension = agent.inspectSuspension();
    if (suspension === undefined) throw new Error('The selected session is not suspended.');
    if (expectedRunId !== undefined && suspension.runId !== expectedRunId) throw new Error('The selected run has changed.');
    if (suspension.category === 'external_recovery') return agent.reconcileExternal(suspension.runId);
    if (suspension.category === 'implementation') return agent.resumeImplementation(suspension.runId);
    throw new Error('The suspension requires a decision.');
  }

  private async beginReconfiguration(): Promise<void> {
    if (this.runtime !== undefined) requireIdleSession(this.runtime.agent);
    await this.publishState('initializing', []);
    await this.deactivateRuntime();
  }

  private requireRuntime(): CodingAgentRuntimeComposition {
    if (this.runtime === undefined) throw new Error(setupGuidance(this.applicationState.requirements));
    return this.runtime;
  }

  private async publishState(
    status: CodingApplicationState['status'],
    requirements: readonly CodingApplicationState['requirements'][number][]
  ): Promise<void> {
    const runtime = this.runtime;
    const session = runtime?.agent.state();
    const projectExecutionPolicy =
      this.workspace.security.decide('project_execution_policy').kind === 'allowed';
    const activeConfiguration = projectExecutionPolicy ? this.options.configuration : undefined;
    const permissions =
      runtime?.details.permissions ??
      (this.workspace.security.trustLevel === 'untrusted'
        ? undefined
        : resolveCodingAuthority({
            requestedMode: this.options.permissionMode,
            trust: admittedTrustLevel(this.workspace.security.trustLevel),
            ...(activeConfiguration
              ? {
                  project: {
                    permissions: activeConfiguration.permissions,
                    enabledTools: activeConfiguration.tools.enabled
                  }
                }
              : {}),
            hasVerificationChecks:
              (activeConfiguration?.verification.required.length ?? 0) +
                (activeConfiguration?.verification.advisory.length ?? 0) >
              0
          }).permissions);
    const runtimeDetails: CodingRuntimeDetails = Object.freeze({
      ...(runtime?.details ?? {}),
      ...(this.resolvedSettings.provider === undefined ? {} : { providerId: this.resolvedSettings.provider }),
      ...(this.resolvedSettings.model === undefined ? {} : { modelId: this.resolvedSettings.model }),
      ...(this.resolvedSettings.temperature === undefined
        ? {}
        : { temperature: this.resolvedSettings.temperature }),
      ...(this.resolvedSettings.reasoning?.strategy === 'effort'
        ? { reasoningEffort: this.resolvedSettings.reasoning.effort }
        : {}),
      workspaceTrust: this.workspace.security.trustLevel,
      ...(permissions === undefined ? {} : { permissions })
    });
    this.applicationState = Object.freeze({
      status,
      requirements: Object.freeze([...requirements]),
      runtimeDetails,
      ...(session === undefined ? {} : { session })
    });
    await this.emit({ type: 'application.state.changed', state: this.applicationState });
  }

  private emit(event: CodingApplicationEvent): Promise<void> {
    this.events.publish(event);
    return Promise.resolve();
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.run.then(() => {
      this.assertOpen();
      return run();
    });
    this.run = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Coding application is closed.');
  }
}

function setupRequirements(
  workspace: OpenCodingWorkspace,
  settings: RuntimeSettingsSelection
): readonly CodingApplicationState['requirements'][number][] {
  const requirements: CodingApplicationState['requirements'][number][] = [];
  if (workspace.security.trustLevel === 'untrusted') requirements.push('workspace_trust');
  if (settings.provider === undefined) requirements.push('provider');
  if (settings.model === undefined) requirements.push('model');
  return Object.freeze(requirements);
}

function setupGuidance(requirements: CodingApplicationState['requirements']): string {
  return requirements.length
    ? 'Application setup is incomplete: ' + requirements.join(', ')
    : 'The application runtime is unavailable.';
}

export async function openCodingApplication(
  options: Partial<CodingApplicationOptions> & Pick<CodingApplicationOptions, 'root'>
): Promise<CodingApplication> {
  const workspace = await openCodingWorkspace(
    options.root,
    options.stateRoot ? { stateRoot: options.stateRoot } : {}
  );
  return new CodingApplication(
    { permissionMode: 'review', sessionSelection: { kind: 'new' }, ...options },
    workspace
  );
}

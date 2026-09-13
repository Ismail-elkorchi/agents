import {
  assertModelRequestSupported,
  parseModelSelection,
  type ModelProvider,
  type ModelSelection
} from '@agent-core/model';
import { JsonlEventRepository } from '@agent-core/persistence/node';
import {
  agentEventCodec,
  ApplicationEvents,
  assertHistoryModelCompatibility,
  assertSessionImagesSupported,
  progressReplacementKey,
  SessionNotes,
  sourceRef,
  type AgentEvent,
  type AgentRunResult,
  type AgentSession,
  type SessionNoteRead,
  type SessionSubmissionInput
} from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
import { DEFAULT_LOCAL_TOOL_CONFIGURATION, readRootedImage, readRootedText } from '@agent-core/tools-local';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readRecordedMutationPatches, readRunChangeReport } from '../changes/run-change-report.js';
import { resolveCodingAuthority, type CodingPermissionMode } from '../security/permission-mode.js';
import { createTrustDecision } from '../security/workspace-trust.js';
import { closeCodingSession } from '../session.js';
import { ModelSelectionStore } from '../state/model-selection-store.js';
import { readConfiguredCheckResults } from '../verification/configured-check-tool.js';
import {
  codingWorkspaceSessionBinding,
  openCodingWorkspace,
  type OpenCodingWorkspace
} from '../workspace.js';
import type {
  CodingApplicationEvent,
  CodingApplicationState,
  CodingRuntimeDetails,
  CodingSubmissionResult
} from './contracts.js';
import {
  admittedTrustLevel,
  createProviderRuntime,
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
  private modelOverride:
    | { readonly selection: ModelSelection; readonly adapter: ModelProvider }
    | undefined;
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
      runtimeDetails: Object.freeze({
        workspaceTrust: workspace.security.trustLevel,
        workspacePath: workspace.layout.workspaceRoot
      })
    });
  }

  draftDirectory(): string {
    return `${this.workspace.layout.runtimeDir}/drafts`;
  }

  presentationPath(): string {
    return `${this.workspace.privateState.path}/settings/presentation.json`;
  }

  state(): CodingApplicationState {
    return this.runtime === undefined
      ? this.applicationState
      : { ...this.applicationState, session: this.runtime.agent.state() };
  }

  subscribe(
    listener: (event: CodingApplicationEvent) => void | Promise<void>,
    onFailure: (error: Error) => void
  ): () => void {
    return this.events.subscribe(listener, onFailure);
  }

  start(): Promise<void> {
    return this.serial(async () => {
      if (this.started) return;
      this.started = true;
      await this.refreshAndActivate();
    });
  }

  async readContext(
    filePath: string,
    signal: AbortSignal
  ): Promise<import('@agent-core/runtime').PromptContextItemInput> {
    this.assertOpen();
    const decision = this.workspace.security.decide('workspace_read');
    if (decision.kind !== 'allowed') throw new Error(decision.reason);
    const root = this.workspace.fileRoot;
    const snapshot = await readRootedText(
      root,
      root.canonicalPath(filePath),
      DEFAULT_LOCAL_TOOL_CONFIGURATION.readFiles.maxBytesPerFile,
      signal
    );
    return {
      id: `file:${snapshot.sha256}`,
      title: snapshot.path,
      sourceKind: 'user',
      sourceUri: pathToFileURL(path.join(root.identity.canonicalPath, snapshot.path)).href,
      integrity: 'verified',
      representation: 'full',
      mediaType: 'text/plain',
      content: snapshot.content,
      purpose: 'File snapshot explicitly attached by the user.'
    };
  }

  async readImage(filePath: string, signal?: AbortSignal) {
    this.assertOpen();
    const decision = this.workspace.security.decide('workspace_read');
    if (decision.kind !== 'allowed') throw new Error(decision.reason);
    const runtime = this.requireRuntime();
    const profile = await runtime.provider.describeModel(runtime.agent.state().configuration.model);
    const root = this.workspace.fileRoot;
    if (!profile.modalities.input.includes('image'))
      throw new Error('The selected model does not accept images. Choose an image-capable model.');
    const canonical = root.canonicalPath(filePath);
    const result = await readRootedImage(root, canonical, DEFAULT_LOCAL_TOOL_CONFIGURATION.artifact, {
      signal
    });
    const repository = runtime.artifacts;
    const artifact = await repository.store({
      label: canonical,
      content: result.bytes,
      mediaType: result.mediaType
    });
    const image = { artifact };
    return { path: canonical, image };
  }

  submit(
    input: SessionSubmissionInput,
    options: {
      readonly delivery?: 'default' | 'steer' | 'follow_up';
      readonly expectedRunId?: string;
    } = {}
  ): Promise<CodingSubmissionResult> {
    return this.serial(async () => {
      if (!input.task.trim()) throw new Error('A submission requires non-empty text.');
      if (this.runtime === undefined) await this.refreshAndActivate();
      if (this.runtime === undefined)
        return {
          kind: 'rejected',
          reason: 'setup_required',
          requirements: this.applicationState.requirements
        };
      if (input.images?.length)
        assertSessionImagesSupported(
          input.images,
          await this.runtime.provider.describeModel(this.runtime.agent.state().configuration.model)
        );
      const { relationship, ...runInput } = input;
      return this.runtime.agent.submit(runInput, {
        ...options,
        ...(relationship === undefined ? {} : { relationship })
      });
    });
  }

  resolveApproval(input: Parameters<AgentSession['resolveApproval']>[0]) {
    return this.requireRuntime().agent.resolveApproval(input);
  }

  async updateQueuedSubmission(...args: Parameters<AgentSession['updateQueuedSubmission']>): Promise<void> {
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
    if (this.modelOverride !== undefined) return this.selectionSettings(this.modelOverride.selection);
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

  private async activateRuntime(prepared?: CodingAgentRuntimeComposition): Promise<void> {
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
      ...(this.resolvedSettings.reasoning === undefined
        ? {}
        : { reasoning: this.resolvedSettings.reasoning })
    };
    const runtime =
      prepared ??
      (await createRuntime(
        activationOptions,
        this.workspace,
        { ...this.resolvedSettings, provider, model },
        this.selectedSessionId,
        this.modelOverride?.adapter
      ));
    if (prepared === undefined) {
      try {
        await assertHistoryModelCompatibility({
          history: runtime.history,
          artifacts: runtime.artifacts,
          profile: await runtime.provider.describeModel(model)
        });
      } catch (error) {
        await closeCodingSession(runtime);
        throw error;
      }
    }
    this.runtime = runtime;
    this.selectedSessionId = runtime.session.id;
    delete this.options.branch;
    this.runtimeUnsubscribe = runtime.agent.subscribe(
      (event) => this.onSessionEvent(runtime, event),
      (error) => {
        this.events.fail(error);
      }
    );
    if (prepared === undefined)
      try {
        await runtime.agent.restore();
      } catch (error) {
        this.runtimeUnsubscribe();
        this.runtimeUnsubscribe = undefined;
        this.runtime = undefined;
        await closeCodingSession(runtime);
        throw error;
      }
    await this.emit({ type: 'session.restored', view: await readCodingSessionView(runtime) });
    if (runtime.agent.state().queuedInputs > 0) void runtime.agent.waitForIdle().catch(() => undefined);
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
    event: import('@agent-core/runtime').AgentSessionEvent
  ): Promise<void> {
    if (this.runtime !== runtime) return;
    await this.emit(event);
    if (event.type === 'run.completed')
      await this.emit({
        type: 'verification.updated',
        verification: await readConfiguredCheckResults(runtime.events, event.runId, runtime.configuration)
      });
    if (event.type !== 'run.progress') await this.publishState('ready', []);
  }

  modelSelection(): ModelSelection | undefined {
    const settings = this.resolvedSettings;
    if (settings.provider === undefined || settings.model === undefined) return undefined;
    return {
      provider: settings.provider,
      model: settings.model,
      ...(settings.providerEndpoint === undefined ? {} : { endpoint: settings.providerEndpoint }),
      ...(settings.reasoning === undefined ? {} : { reasoning: settings.reasoning }),
      ...(settings.temperature === undefined ? {} : { temperature: settings.temperature })
    };
  }

  connectProvider(provider: string, endpoint?: string): ModelProvider {
    return createProviderRuntime({
      provider: parseProviderId(provider),
      model: '',
      ...(endpoint === undefined ? {} : { providerEndpoint: endpoint })
    }).provider;
  }

  configureModel(selection: ModelSelection, adapter: ModelProvider): Promise<void> {
    const owned = parseModelSelection(selection);
    return this.serial(async () => {
      const settings = this.selectionSettings(owned);
      if (adapter.id !== settings.provider)
        throw new Error('The selected provider does not match this configuration.');
      const profile = await adapter.describeModel(settings.model);
      assertModelRequestSupported(profile, {
        model: settings.model,
        messages: [],
        ...(settings.reasoning === undefined ? {} : { reasoning: settings.reasoning }),
        ...(settings.temperature === undefined ? {} : { temperature: settings.temperature })
      });
      if (this.runtime !== undefined) requireIdleSession(this.runtime.agent);
      let prepared: CodingAgentRuntimeComposition | undefined;
      try {
        if (this.workspace.security.trustLevel !== 'untrusted') {
          prepared = await createRuntime(
            this.options,
            this.workspace,
            settings,
            this.selectedSessionId,
            adapter
          );
          await assertHistoryModelCompatibility({
            history: prepared.history,
            artifacts: prepared.artifacts,
            profile
          });
          await prepared.agent.restore();
          requireIdleSession(prepared.agent);
        }
        await new ModelSelectionStore(this.workspace.privateState).write({
          ...owned,
          provider: settings.provider
        });
      } catch (error) {
        if (prepared !== undefined) await closeCodingSession(prepared);
        throw error;
      }
      const previous = this.runtime;
      this.runtimeUnsubscribe?.();
      this.runtimeUnsubscribe = undefined;
      this.runtime = undefined;
      this.modelOverride = { selection: owned, adapter };
      this.resolvedSettings = settings;
      if (prepared !== undefined) await this.activateRuntime(prepared);
      await this.publishState(
        prepared === undefined ? 'setup_required' : 'ready',
        prepared === undefined ? setupRequirements(this.workspace, settings) : []
      );
      if (previous !== undefined) await closeCodingSession(previous);
    });
  }

  private selectionSettings(selection: ModelSelection): import('./runtime.js').ResolvedSessionSettings {
    return {
      provider: parseProviderId(selection.provider),
      model: selection.model,
      ...(selection.endpoint === undefined ? {} : { providerEndpoint: selection.endpoint }),
      ...(selection.reasoning === undefined ? {} : { reasoning: selection.reasoning }),
      ...(selection.temperature === undefined ? {} : { temperature: selection.temperature })
    };
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

  steer(input: SessionSubmissionInput, expectedRunId?: string): Promise<CodingSubmissionResult> {
    return this.submit(input, {
      delivery: 'steer',
      ...(expectedRunId === undefined ? {} : { expectedRunId })
    });
  }

  follow(input: SessionSubmissionInput): Promise<CodingSubmissionResult> {
    return this.submit(input, { delivery: 'follow_up' });
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
    return this.requireRuntime().inspectContext();
  }

  listProcesses() {
    return this.requireRuntime().listProcesses();
  }

  controlProcess(
    target: import('../execution/process-controls.js').CodingProcessTarget,
    action: import('../execution/process-controls.js').CodingProcessAction
  ) {
    return this.requireRuntime().controlProcess(target, action);
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
  persistenceLocations(runId: string) {
    const runtime = this.requireRuntime();
    return {
      ledger: runtime.events.location(runId),
      session: runtime.sessions.location(runtime.session.id)
    };
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
    const report = await readRunChangeReport(runtime.events, runId, runtime.workspaceRoot);
    const change = report.changes.find((change) => change.path === path);
    if (change === undefined) throw new Error('The requested change is not recorded in this run.');
    const receipts = report.mutationReceipts.filter((receipt) =>
      change.receiptSequences.includes(receipt.sequence)
    );
    const patches = await readRecordedMutationPatches(runtime.events, runId, receipts);
    return { change, patches };
  }

  readSession() {
    return readCodingSessionView(this.requireRuntime());
  }

  readVerification(runId: string) {
    const runtime = this.requireRuntime();
    return readConfiguredCheckResults(runtime.events, runId, runtime.configuration);
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

  newSession(): Promise<void> {
    return this.serial(async () => {
      await this.deactivateRuntime();
      this.selectedSessionId = undefined;
      this.options.sessionSelection = { kind: 'new' };
      await this.refreshAndActivate();
    });
  }

  selectSession(sessionId: string): Promise<void> {
    return this.serial(async () => {
      await this.deactivateRuntime();
      this.selectedSessionId = sessionId;
      this.modelOverride = undefined;
      delete this.options.provider;
      delete this.options.model;
      delete this.options.providerEndpoint;
      delete this.options.reasoning;
      delete this.options.temperature;
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

  async resumeSuspension(expectedRunId?: string): Promise<AgentRunResult> {
    const agent = this.requireRuntime().agent;
    await agent.restore();
    const suspension = agent.inspectSuspension();
    if (suspension === undefined) throw new Error('The selected session is not suspended.');
    if (expectedRunId !== undefined && suspension.runId !== expectedRunId)
      throw new Error('The selected run has changed.');
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
      ...(this.resolvedSettings.provider === undefined
        ? {}
        : { providerId: this.resolvedSettings.provider }),
      ...(this.resolvedSettings.model === undefined ? {} : { modelId: this.resolvedSettings.model }),
      ...(this.resolvedSettings.temperature === undefined
        ? {}
        : { temperature: this.resolvedSettings.temperature }),
      ...(this.resolvedSettings.reasoning === undefined
        ? {}
        : { reasoning: this.resolvedSettings.reasoning }),
      workspaceTrust: this.workspace.security.trustLevel,
      workspacePath: this.workspace.layout.workspaceRoot,
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

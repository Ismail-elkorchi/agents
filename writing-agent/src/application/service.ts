import {
  assertModelRequestSupported,
  parseModelSelection,
  type ModelProvider,
  type ModelSelection
} from '@agent-core/model';
import { LocalArtifactRepository, atomicWritePrivateJson } from '@agent-core/persistence/node';
import {
  ApplicationEvents,
  assertHistoryModelCompatibility,
  assertSessionImagesSupported,
  ownSessionSubmissionInput,
  progressReplacementKey,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionSubmissionResult,
  type SessionBranchBoundary,
  type SessionBranchPageRequest,
  type SessionBranchSearchRequest,
  type SessionDescriptor,
  type SessionSubmissionInput
} from '@agent-core/runtime';
import {
  JsonlSessionRepository,
  SessionHistoryIndexError,
  SessionHistoryIndexPublicationError,
  SessionHistorySourceError
} from '@agent-core/runtime/node';
import {
  DEFAULT_LOCAL_TOOL_CONFIGURATION,
  readRootedImage,
  readRootedText
} from '@agent-core/tools-local';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWritingProvider, parseWritingProviderId } from '../provider.js';
import {
  createWritingSession,
  recordWritingPermission,
  type WritingConfiguration,
  type WritingMode
} from '../session.js';
import { openWritingWorkspace, type WritingWorkspace } from '../workspace.js';
import {
  WritingDocuments,
  documentSectionSchema,
  documentPassageSchema,
  documentComparisonSchema,
  type DocumentPassageInput
} from '../documents.js';
import type * as z from 'zod';

export type { WritingConfiguration, WritingMode } from '../session.js';
export type { WritingDocument, DocumentRevision, DocumentPassageInput } from '../documents.js';
export interface WritingApplicationOptions {
  readonly rootDirectory: string;
  readonly stateRoot?: string;
  readonly sessionId?: string;
  readonly mode?: WritingMode;
  readonly configuration?: WritingConfiguration;
  readonly modelSelection?: ModelSelection;
  readonly maxOutputTokens?: number;
}
export interface WritingApplicationState {
  readonly historyRecoveryFailures?: Readonly<Record<string, string>>;
  readonly workspace: string;
  readonly sessionId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly mode: WritingMode;
  readonly status: 'ready' | 'running' | 'suspended' | 'configuration_required' | 'closed';
}
export type WritingApplicationEvent =
  | { readonly type: 'history.recovery'; readonly progress: import('@agent-core/runtime/node').HistoryIndexRecoveryProgress }
  | AgentSessionEvent
  | {
      readonly type: 'application.state.changed';
      readonly state: WritingApplicationState;
    };
export type WritingSubmissionResult =
  | (Exclude<AgentSessionSubmissionResult, { readonly kind: 'rejected' }> & { readonly sessionId: string })
  | Extract<AgentSessionSubmissionResult, { readonly kind: 'rejected' }>
  | { readonly kind: 'rejected'; readonly reason: 'configuration_required' };

/** Coordinates workspace authority and a Core session; editorial decisions belong to the conversation. */
export class WritingApplication {
  private readonly events = new ApplicationEvents<WritingApplicationEvent>((event) =>
    event.type === 'run.progress' ? progressReplacementKey(event.event)
      : event.type === 'history.recovery' && event.progress.phase === 'progress'
        ? `history.recovery:${event.progress.sessionId}` : undefined
  );
  private readonly sessions: JsonlSessionRepository;
  private readonly documents: WritingDocuments;
  private descriptor: SessionDescriptor | undefined;
  private readonly initialSessionId: string | undefined;
  private composition: ReturnType<typeof createWritingSession> | undefined;
  private selection: ModelSelection | undefined;
  private configuration: WritingConfiguration | undefined;
  private mode: WritingMode;
  private unsubscribe: (() => void) | undefined;
  private readonly maxOutputTokens: number | undefined;
  private mutations: Promise<void> = Promise.resolve();
  private closeCompletion: Promise<void> | undefined;
  private historyRecovery: AbortController | undefined;
  private readonly historyRecoveryFailures = new Map<string, string>();

  constructor(
    private readonly workspace: WritingWorkspace,
    options: WritingApplicationOptions
  ) {
    this.sessions = new JsonlSessionRepository({
      rootDir: path.join(workspace.stateDirectory, 'sessions')
    });
    this.documents = new WritingDocuments(
      workspace.root,
      new LocalArtifactRepository({
        rootDir: path.join(workspace.stateDirectory, 'artifacts')
      })
    );
    this.initialSessionId = options.sessionId;
    this.maxOutputTokens = options.maxOutputTokens;
    this.configuration = options.configuration;
    this.selection = options.modelSelection;
    this.mode = options.mode ?? 'edit';
  }

  draftDirectory(): string {
    return path.join(this.workspace.stateDirectory, 'drafts');
  }

  presentationPath(): string {
    return path.join(this.workspace.stateDirectory, 'presentation.json');
  }

  state(): WritingApplicationState {
    const phase = this.composition?.agent.state().phase;
    return {
      workspace: this.workspace.directory,
      ...(this.historyRecoveryFailures.size === 0 ? {} : {
        historyRecoveryFailures: Object.fromEntries(this.historyRecoveryFailures)
      }),
      mode: this.mode,
      ...(this.descriptor ? { sessionId: this.descriptor.id } : {}),
      ...(this.configuration
        ? {
            provider: this.configuration.provider.id,
            model: this.configuration.model
          }
        : {}),
      status: this.closeCompletion
        ? 'closed'
        : this.composition === undefined &&
          (this.descriptor !== undefined || (this.configuration === undefined && this.selection === undefined))
          ? 'configuration_required'
          : phase === 'running' || phase === 'suspended'
            ? phase
            : 'ready'
    };
  }

  subscribe(
    listener: (event: WritingApplicationEvent) => void | Promise<void>,
    onFailure: (error: Error) => void
  ) {
    return this.events.subscribe(listener, onFailure);
  }

  start(): Promise<void> {
    return this.mutate(() => this.initializeSession());
  }

  private async initializeSession(): Promise<void> {
    if (this.descriptor) return;
    const summaries = await this.recoverHistoryIndexes(this.initialSessionId);
    this.assertOpen();
    const id = this.initialSessionId ?? summaries[0]?.id;
    this.descriptor =
      id === undefined
        ? await this.sessions.create({ binding: this.workspace.binding })
        : await this.sessions.open(id, this.workspace.binding);
    await this.connect();
  }

  private publishHistoryRecovery(progress: import('@agent-core/runtime/node').HistoryIndexRecoveryProgress): void {
    if (progress.phase === 'failed') this.historyRecoveryFailures.set(progress.sessionId, progress.message);
    else if (progress.phase === 'completed') this.historyRecoveryFailures.delete(progress.sessionId);
    this.events.publish({ type: 'history.recovery', progress });
  }

  private async recoverHistoryIndexes(sessionId?: string) {
    const controller = new AbortController();
    this.historyRecovery = controller;
    let activeSessionId = sessionId;
    const observedFailures = new Map<string, string>();
    try {
      const summaries = await this.sessions.recoverHistoryIndexes(this.workspace.binding, {
          ...(sessionId === undefined ? {} : { sessionId }),
          signal: controller.signal,
          onProgress: (progress) => {
            activeSessionId = progress.phase === 'started' || progress.phase === 'progress'
              ? progress.sessionId : undefined;
            if (progress.phase === 'failed') observedFailures.set(progress.sessionId, progress.message);
            this.publishHistoryRecovery(progress);
          }
        });
      if (sessionId === undefined) {
        this.historyRecoveryFailures.clear();
        for (const [id, message] of observedFailures) this.historyRecoveryFailures.set(id, message);
      } else for (const summary of summaries) this.historyRecoveryFailures.delete(summary.id);
      return summaries;
    } catch (error) {
      const failedSessionId = error instanceof Error && 'sessionId' in error && typeof error.sessionId === 'string'
        ? error.sessionId : activeSessionId;
      if (failedSessionId !== undefined) this.publishHistoryRecovery({
          phase: controller.signal.aborted ? 'cancelled' : 'failed',
          sessionId: failedSessionId,
          message: controller.signal.aborted
            ? `History index recovery cancelled for session ${JSON.stringify(failedSessionId)}. Original history is unchanged.`
            : error instanceof Error ? error.message : String(error)
      });
      if (
        error instanceof SessionHistoryIndexError ||
        error instanceof SessionHistorySourceError ||
        error instanceof SessionHistoryIndexPublicationError ||
        (error instanceof Error && error.name === 'AbortError')
      ) throw error;
      throw new SessionHistoryIndexError(
        failedSessionId,
        error instanceof Error ? error.message : String(error),
        { cause: error }
      );
    } finally {
      this.historyRecovery = undefined;
    }
  }

  modelSelection(): ModelSelection | undefined {
    return (
      this.selection ??
      (this.configuration === undefined
        ? undefined
        : {
            provider: this.configuration.provider.id,
            model: this.configuration.model,
            ...(this.configuration.reasoning === undefined
              ? {}
              : { reasoning: this.configuration.reasoning }),
            ...(this.configuration.temperature === undefined
              ? {}
              : { temperature: this.configuration.temperature })
          })
    );
  }

  connectProvider(provider: string, endpoint?: string): ModelProvider {
    return createWritingProvider({
      provider: parseWritingProviderId(provider),
      ...(endpoint === undefined ? {} : { endpoint })
    }).provider;
  }

  configureModel(
    selection: ModelSelection,
    provider: ModelProvider
  ): Promise<void> {
    const owned = parseModelSelection(selection);
    return this.mutate(async () => {
      const configuration = { ...this.configuration, provider, model: owned.model };
      delete configuration.reasoning;
      delete configuration.temperature;
      if (owned.reasoning !== undefined) configuration.reasoning = owned.reasoning;
      if (owned.temperature !== undefined) configuration.temperature = owned.temperature;
      await this.replaceConfiguration(configuration, owned);
    });
  }

  configure(configuration: WritingConfiguration): Promise<void> {
    return this.mutate(() => this.replaceConfiguration(configuration));
  }

  private async replaceConfiguration(
    configuration: WritingConfiguration,
    selection?: ModelSelection
  ): Promise<void> {
    this.requireIdle();
    if (selection !== undefined && selection.provider !== configuration.provider.id)
      throw new Error('The selected provider does not match this configuration.');
    const profile = await configuration.provider.describeModel(configuration.model);
    assertModelRequestSupported(profile, {
      model: configuration.model,
      messages: [],
      ...(configuration.reasoning === undefined ? {} : { reasoning: configuration.reasoning }),
      ...(configuration.temperature === undefined ? {} : { temperature: configuration.temperature })
    });
    if (this.descriptor === undefined) {
      if (selection !== undefined)
        await atomicWritePrivateJson(
          path.join(this.workspace.stateDirectory, 'model-selection.json'),
          {
            ...selection
          }
        );
      this.configuration = configuration;
      this.selection = selection;
      return;
    }
    const prepared = createWritingSession(
      this.workspace,
      this.requireDescriptor(),
      this.generationConfiguration(configuration)
    );
    try {
      await prepared.agent.changeModel({
        selection: selection ?? {
          provider: configuration.provider.id,
          model: configuration.model,
          ...(configuration.reasoning === undefined ? {} : { reasoning: configuration.reasoning }),
          ...(configuration.temperature === undefined
            ? {}
            : { temperature: configuration.temperature })
        },
        profile,
        artifacts: prepared.artifacts
      });
    } catch (error) {
      await prepared.close();
      throw error;
    }
    const previous = this.composition;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.configuration = configuration;
    this.selection = selection;
    this.composition = prepared;
    this.subscribeComposition();
    await previous?.close();
    if (selection !== undefined) {
      try {
        await atomicWritePrivateJson(
          path.join(this.workspace.stateDirectory, 'model-selection.json'),
          { ...selection }
        );
      } catch (cause) {
        throw new Error('The session model changed, but saving the default model failed.', {
          cause
        });
      }
    }
  }

  setMode(mode: WritingMode): Promise<void> {
    return this.mutate(() => {
      this.requireIdle();
      this.mode = mode;
    });
  }

  async readContext(
    filePath: string,
    signal: AbortSignal
  ): Promise<import('@agent-core/runtime').PromptContextItemInput> {
    this.assertOpen();
    const root = this.workspace.root;
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
    if (this.configuration === undefined) throw new Error('Choose a model before adding an image.');
    const profile = await this.configuration.provider.describeModel(this.configuration.model);
    const root = this.workspace.root;
    if (!profile.modalities.input.includes('image'))
      throw new Error('The selected model does not accept images. Choose an image-capable model.');
    const canonical = root.canonicalPath(filePath);
    const result = await readRootedImage(
      root,
      canonical,
      DEFAULT_LOCAL_TOOL_CONFIGURATION.artifact,
      {
        signal
      }
    );
    const repository = this.composition?.artifacts;
    if (repository === undefined) throw new Error('Start a session before adding an image.');
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
  ): Promise<WritingSubmissionResult> {
    const { relationship, ...owned } = ownSessionSubmissionInput(input);
    const submissionOptions = { ...options, ...(relationship === undefined ? {} : { relationship }) };
    return this.mutate(async () => {
      if (this.descriptor === undefined) await this.initializeSession();
      this.assertOpen();
      if (!this.composition) return { kind: 'rejected', reason: 'configuration_required' };
      if (owned.images?.length)
        assertSessionImagesSupported(
          owned.images,
          await this.composition.provider.describeModel(
            this.composition.agent.state().configuration.model
          )
        );
      const runId = randomUUID();
      await recordWritingPermission(this.workspace, runId, this.mode);
      const sessionId = this.requireDescriptor().id;
      const result = await this.composition.agent.submit(
        { ...owned, runId },
        submissionOptions
      );
      return result.kind === 'rejected' ? result : { ...result, sessionId };
    });
  }

  follow(input: SessionSubmissionInput): Promise<WritingSubmissionResult> {
    return this.submit(input, { delivery: 'follow_up' });
  }

  steer(input: SessionSubmissionInput, expectedRunId: string): Promise<WritingSubmissionResult> {
    return this.submit(input, { delivery: 'steer', expectedRunId });
  }

  async readPendingSubmissions() {
    if (this.descriptor === undefined) throw new Error('No session is open.');
    return this.sessions.loadPendingSubmissions(this.descriptor);
  }

  async updateQueuedSubmission(
    ...args: Parameters<AgentSession['updateQueuedSubmission']>
  ): Promise<void> {
    if (this.composition === undefined) throw new Error('No session is configured.');
    await this.composition.agent.updateQueuedSubmission(...args);
  }

  listSessions() {
    return this.mutate(() => this.recoverHistoryIndexes());
  }

  selectSession(sessionId: string): Promise<void> {
    this.historyRecovery?.abort();
    return this.mutate(async () => {
      this.requireIdle();
      await this.recoverHistoryIndexes(sessionId);
      const descriptor = await this.sessions.open(sessionId, this.workspace.binding);
      await this.disconnect();
      this.descriptor = descriptor;
      await this.connect();
    });
  }

  newSession(): Promise<void> {
    this.historyRecovery?.abort();
    return this.mutate(async () => {
      this.requireIdle();
      await this.disconnect();
      this.descriptor = await this.sessions.create({
        binding: this.workspace.binding
      });
      await this.connect();
    });
  }

  async listDocuments(directory = '.') {
    this.assertOpen();
    const opened = await this.workspace.root.openDirectory(directory);
    try {
      return (await opened.entries())
        .filter(
          (entry) =>
            (entry.type === 'file' || entry.type === 'directory') &&
            !this.workspace.root.isReservedPath(`${directory}/${entry.name}`)
        )
        .map((entry) => ({
          path: path.posix.join(directory, entry.name),
          type: entry.type
        }))
        .sort((left, right) => left.path.localeCompare(right.path));
    } finally {
      await opened.close();
    }
  }

  readDocument(documentPath: string) {
    this.assertOpen();
    return this.documents.read(documentPath, true);
  }

  readDocumentSection(input: z.input<typeof documentSectionSchema>) {
    this.assertOpen();
    return this.documents.section(documentSectionSchema.parse(input));
  }

  readDocumentPassage(input: DocumentPassageInput) {
    this.assertOpen();
    return this.documents.passage(documentPassageSchema.parse(input));
  }

  compareDocumentRevisions(input: z.input<typeof documentComparisonSchema>) {
    this.assertOpen();
    return this.documents.compare(documentComparisonSchema.parse(input));
  }

  readPassageContext(input: unknown) {
    this.assertOpen();
    return this.documents.passageContext(documentPassageSchema.parse(input));
  }

  readSession() {
    this.assertOpen();
    return this.requireAgent().inspect();
  }
  readHistory(request: SessionBranchPageRequest = {}) {
    return this.sessions.readBranchPage(this.requireDescriptor(), request);
  }
  searchHistory(request: SessionBranchSearchRequest) {
    return this.sessions.searchBranch(this.requireDescriptor(), request);
  }
  readHistoryEntry(boundary: SessionBranchBoundary, entryId: string) {
    return this.sessions.readBranchEntry(this.requireDescriptor(), boundary, entryId);
  }

  readHistorySource(request: import('@agent-core/runtime').HistoryReadRequest) {
    if (!this.composition) throw new Error('Open a session before reading original history.');
    return this.composition.history.read(request);
  }

  contextSources(request: import('@agent-core/runtime').HistorySearchRequest) {
    if (!this.composition) throw new Error('Open a session before inspecting context.');
    return this.composition.history.search(request);
  }
  async transitionContext(request: import('@agent-core/runtime').ContextTransitionRequest) {
    const agent = this.requireAgent();
    const selected = await agent.transitionContext(request);
    const suspension = agent.inspectSuspension();
    if (selected.kind === 'selected' && suspension?.category === 'context_admission')
      return { selection: selected, run: await agent.resumeContextAdmission(suspension.runId) };
    return { selection: selected };
  }

  inspectContext() {
    this.assertOpen();
    if (this.composition === undefined)
      throw new Error('Configure a session before inspecting context.');
    return this.composition.inspectContext(this.mode);
  }
  inspectSuspension() {
    this.assertOpen();
    return this.composition?.agent.inspectSuspension();
  }
  abort(runId?: string) {
    this.assertOpen();
    if (runId === undefined && this.historyRecovery !== undefined) {
      this.historyRecovery.abort();
      return Promise.resolve(true);
    }
    return this.composition?.agent.abort('Stopped by the user.', runId) ?? Promise.resolve(false);
  }
  async resume(runId: string) {
    this.assertOpen();
    const agent = this.requireAgent();
    if (agent.inspectSuspension()?.category === 'context_admission')
      return agent.resumeContextAdmission(runId);
    return agent.inspectSuspension()?.category === 'runtime'
      ? agent.resumeRuntime(runId)
      : agent.reconcileExternal(runId);
  }
  resolveApproval(input: Parameters<AgentSession['resolveApproval']>[0]) {
    this.assertOpen();
    return this.requireAgent().resolveApproval(input);
  }

  close(): Promise<void> {
    this.historyRecovery?.abort();
    this.closeCompletion ??= this.mutations.then(async () => {
      try {
        await this.disconnect();
      } finally {
        this.workspace.root.close();
        this.events.close();
      }
    });
    return this.closeCompletion;
  }

  private generationConfiguration(configuration: WritingConfiguration): WritingConfiguration {
    return this.maxOutputTokens === undefined
      ? configuration
      : { ...configuration, maxOutputTokens: this.maxOutputTokens };
  }

  private async connect() {
    if (!this.descriptor) return;
    if (this.configuration === undefined) {
      const recorded = await this.sessions.currentModelSettings(this.descriptor);
      let selection: ModelSelection | undefined = this.selection ?? recorded;
      if (selection === undefined) {
        let encoded: string | undefined;
        try {
          encoded = await readFile(
            path.join(this.workspace.stateDirectory, 'model-selection.json'),
            'utf8'
          );
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
            throw error;
        }
        if (encoded !== undefined) selection = parseModelSelection(JSON.parse(encoded));
      }
      if (selection !== undefined) {
        const provider = this.connectProvider(selection.provider, selection.endpoint);
        this.selection = selection;
        this.configuration = { ...selection, provider };
      }
    }
    if (!this.configuration) return;
    const composition = createWritingSession(
      this.workspace,
      this.descriptor,
      this.generationConfiguration(this.configuration)
    );
    try {
      const profile = await this.configuration.provider.describeModel(this.configuration.model);
      await assertHistoryModelCompatibility({
        history: composition.history,
        artifacts: composition.artifacts,
        profile
      });
      this.composition = composition;
      this.subscribeComposition();
      await composition.agent.restore();
    } catch (error) {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.composition = undefined;
      await composition.close();
      throw error;
    }
    if (this.composition.agent.state().queuedInputs > 0)
      void this.composition.agent.waitForIdle().catch((cause: unknown) => {
        this.events.fail(cause instanceof Error ? cause : new Error(String(cause)));
      });
  }

  private subscribeComposition() {
    if (this.composition === undefined) return;
    this.unsubscribe = this.composition.agent.subscribe(
      (event) => {
        this.events.publish(event);
        if (
          event.type !== 'run.progress' ||
          event.event.type === 'run.phase.changed' ||
          event.event.type === 'run.ended'
        )
          this.events.publish({ type: 'application.state.changed', state: this.state() });
      },
      (error) => {
        this.events.fail(error);
      }
    );
  }

  private async disconnect() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.composition?.close();
    this.composition = undefined;
  }

  private requireAgent() {
    if (!this.composition) throw new Error('Select a provider and model first.');
    return this.composition.agent;
  }
  private requireDescriptor() {
    this.assertOpen();
    if (!this.descriptor) throw new Error('Writing application has not started.');
    return this.descriptor;
  }
  private requireIdle() {
    const state = this.composition?.agent.state();
    if (state && (state.phase !== 'idle' || state.queuedInputs > 0))
      throw new Error('Finish or stop pending work before changing sessions or configuration.');
  }
  private assertOpen() {
    if (this.closeCompletion) throw new Error('Writing application is closed.');
  }
  private mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    this.assertOpen();
    const result = this.mutations.then(() => {
      this.assertOpen();
      return operation();
    }).finally(() => {
      this.events.publish({
        type: 'application.state.changed',
        state: this.state()
      });
    });
    this.mutations = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

export async function openWritingApplication(
  options: WritingApplicationOptions
): Promise<WritingApplication> {
  const workspace = await openWritingWorkspace(options.rootDirectory, options.stateRoot);
  return new WritingApplication(workspace, options);
}

import {
  assertModelRequestSupported,
  parseModelSelection,
  type ModelProvider,
  type ModelSelection
} from '@agent-core/model';
import {
  JsonlEventRepository,
  LocalArtifactRepository,
  atomicWritePrivateJson
} from '@agent-core/persistence/node';
import {
  ApplicationEvents,
  HistoryReader,
  SessionNotes,
  agentEventCodec,
  assertHistoryModelCompatibility,
  assertSessionImagesSupported,
  ownSessionSubmissionInput,
  progressReplacementKey,
  type AgentEvent,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionSubmissionResult,
  type ApplicationDeliveryEvent,
  type SessionBranchBoundary,
  type SessionBranchPageRequest,
  type SessionBranchSearchRequest,
  type SessionDescriptor,
  type SessionNoteRead,
  type SessionSubmissionInput
} from '@agent-core/runtime';
import { JsonlNoteRepository, JsonlSessionRepository } from '@agent-core/runtime/node';
import { DEFAULT_LOCAL_TOOL_CONFIGURATION, readRootedImage, readRootedText } from '@agent-core/tools-local';
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
import { openWritingWorkspace, readWritingDocument, type WritingWorkspace } from '../workspace.js';

export type { WritingConfiguration, WritingMode } from '../session.js';
export type { WritingDocument } from '../workspace.js';
export interface WritingApplicationOptions {
  readonly rootDirectory: string;
  readonly stateRoot?: string;
  readonly sessionId?: string;
  readonly mode?: WritingMode;
  readonly configuration?: WritingConfiguration;
}
export interface WritingApplicationState {
  readonly workspace: string;
  readonly sessionId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly mode: WritingMode;
  readonly status: 'ready' | 'running' | 'suspended' | 'configuration_required' | 'closed';
}
export type WritingApplicationEvent =
  | AgentSessionEvent
  | ApplicationDeliveryEvent
  | {
      readonly type: 'application.state.changed';
      readonly state: WritingApplicationState;
    };
export type WritingSubmissionResult =
  | AgentSessionSubmissionResult
  | { readonly kind: 'rejected'; readonly reason: 'configuration_required' };

/** Coordinates workspace authority and a Core session; editorial decisions belong to the conversation. */
export class WritingApplication {
  private readonly events = new ApplicationEvents<WritingApplicationEvent>((event) =>
    event.type === 'run.progress' ? progressReplacementKey(event.event) : undefined
  );
  private readonly sessions: JsonlSessionRepository;
  private descriptor: SessionDescriptor | undefined;
  private readonly initialSessionId: string | undefined;
  private composition: ReturnType<typeof createWritingSession> | undefined;
  private selection: ModelSelection | undefined;
  private configuration: WritingConfiguration | undefined;
  private mode: WritingMode;
  private unsubscribe: (() => void) | undefined;
  private mutations: Promise<void> = Promise.resolve();
  private closeCompletion: Promise<void> | undefined;

  constructor(
    private readonly workspace: WritingWorkspace,
    options: WritingApplicationOptions
  ) {
    this.sessions = new JsonlSessionRepository({
      rootDir: path.join(workspace.stateDirectory, 'sessions')
    });
    this.initialSessionId = options.sessionId;
    this.configuration = options.configuration;
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
        : this.configuration === undefined
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
    return this.mutate(async () => {
      if (this.descriptor) return;
      const id = this.initialSessionId ?? (await this.listSessions())[0]?.id;
      this.descriptor =
        id === undefined
          ? await this.sessions.create({ binding: this.workspace.binding })
          : await this.sessions.open(id, this.workspace.binding);
      if (this.configuration === undefined) {
        const replay = await this.sessions.loadReplayState(this.descriptor);
        const recorded = [...replay.branch].reverse().find((entry) => entry.type === 'model_settings');
        let selection: ModelSelection | undefined =
          recorded === undefined
            ? undefined
            : {
                provider: recorded.provider,
                model: recorded.model,
                ...(recorded.reasoning === undefined ? {} : { reasoning: recorded.reasoning }),
                ...(recorded.endpoint === undefined ? {} : { endpoint: recorded.endpoint }),
                ...(recorded.temperature === undefined ? {} : { temperature: recorded.temperature })
              };
        if (selection === undefined) {
          let encoded: string | undefined;
          try {
            encoded = await readFile(
              path.join(this.workspace.stateDirectory, 'model-selection.json'),
              'utf8'
            );
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
          }
          if (encoded !== undefined) selection = parseModelSelection(JSON.parse(encoded));
        }
        if (selection !== undefined) {
          const provider = this.connectProvider(selection.provider, selection.endpoint);
          this.selection = selection;
          this.configuration = { ...selection, provider };
        }
      }
      await this.connect();
    });
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

  configureModel(selection: ModelSelection, provider: ModelProvider): Promise<void> {
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
        await atomicWritePrivateJson(path.join(this.workspace.stateDirectory, 'model-selection.json'), {
          ...selection
        });
      this.configuration = configuration;
      this.selection = selection;
      return;
    }
    const prepared = createWritingSession(this.workspace, this.requireDescriptor(), configuration);
    try {
      await assertHistoryModelCompatibility({
        history: prepared.history,
        artifacts: prepared.artifacts,
        profile
      });
      await prepared.agent.restore();
      const state = prepared.agent.state();
      if (state.phase !== 'idle' || state.queuedInputs > 0)
        throw new Error('Finish pending work before changing configuration.');
      if (selection !== undefined)
        await atomicWritePrivateJson(path.join(this.workspace.stateDirectory, 'model-selection.json'), {
          ...selection
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
    const result = await readRootedImage(root, canonical, DEFAULT_LOCAL_TOOL_CONFIGURATION.artifact, {
      signal
    });
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
    options: { readonly delivery?: 'default' | 'steer' | 'follow_up'; readonly expectedRunId?: string } = {}
  ): Promise<WritingSubmissionResult> {
    return this.mutate(async () => {
      if (!this.composition) return { kind: 'rejected', reason: 'configuration_required' };
      if (input.images?.length)
        assertSessionImagesSupported(
          input.images,
          await this.composition.provider.describeModel(this.composition.agent.state().configuration.model)
        );
      const runId = randomUUID();
      await recordWritingPermission(this.workspace, runId, this.mode);
      const { relationship, ...owned } = ownSessionSubmissionInput(input);
      return this.composition.agent.submit(
        { ...owned, runId },
        { ...options, ...(relationship === undefined ? {} : { relationship }) }
      );
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

  async updateQueuedSubmission(...args: Parameters<AgentSession['updateQueuedSubmission']>): Promise<void> {
    if (this.composition === undefined) throw new Error('No session is configured.');
    await this.composition.agent.updateQueuedSubmission(...args);
  }

  listSessions() {
    return this.sessions.list();
  }

  selectSession(sessionId: string): Promise<void> {
    return this.mutate(async () => {
      this.requireIdle();
      const descriptor = await this.sessions.open(sessionId, this.workspace.binding);
      await this.disconnect();
      this.descriptor = descriptor;
      await this.connect();
    });
  }

  newSession(): Promise<void> {
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
        }));
    } finally {
      await opened.close();
    }
  }

  readDocument(documentPath: string) {
    this.assertOpen();
    return readWritingDocument(this.workspace.root, documentPath);
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
  listNotes(cursor?: string) {
    return this.sessionNotes().list(cursor);
  }
  readNote(request: SessionNoteRead) {
    return this.sessionNotes().read(request);
  }
  inspectContext() {
    this.assertOpen();
    if (this.composition === undefined) throw new Error('Configure a session before inspecting context.');
    return this.composition.inspectContext(this.mode);
  }
  inspectSuspension() {
    this.assertOpen();
    return this.composition?.agent.inspectSuspension();
  }
  abort(runId?: string) {
    this.assertOpen();
    return this.requireAgent().abort('Stopped by the user.', runId);
  }
  async resume(runId: string) {
    this.assertOpen();
    const agent = this.requireAgent();
    return agent.inspectSuspension()?.category === 'implementation'
      ? agent.resumeImplementation(runId)
      : agent.reconcileExternal(runId);
  }
  decide(input: Parameters<AgentSession['resolveDecision']>[0]) {
    this.assertOpen();
    return this.requireAgent().resolveDecision(input);
  }
  resolveApproval(input: Parameters<AgentSession['resolveApproval']>[0]) {
    this.assertOpen();
    return this.requireAgent().resolveApproval(input);
  }

  close(): Promise<void> {
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

  private async connect() {
    if (!this.configuration || !this.descriptor) return;
    const composition = createWritingSession(this.workspace, this.descriptor, this.configuration);
    try {
      await assertHistoryModelCompatibility({
        history: composition.history,
        artifacts: composition.artifacts,
        profile: await this.configuration.provider.describeModel(this.configuration.model)
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

  private sessionNotes() {
    this.assertOpen();
    if (this.composition) return new SessionNotes(this.composition.history, this.composition.notes);
    const artifacts = new LocalArtifactRepository({
      rootDir: path.join(this.workspace.stateDirectory, 'artifacts')
    });
    return new SessionNotes(
      new HistoryReader({
        repository: this.sessions,
        session: this.requireDescriptor(),
        artifacts,
        events: new JsonlEventRepository<AgentEvent>({
          rootDir: path.join(this.workspace.stateDirectory, 'runs'),
          codec: agentEventCodec
        })
      }),
      new JsonlNoteRepository({
        rootDir: path.join(this.workspace.stateDirectory, 'notes'),
        artifacts
      })
    );
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
    const result = this.mutations.then(operation).finally(() => {
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

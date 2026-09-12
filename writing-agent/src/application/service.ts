import { JsonlEventRepository, LocalArtifactRepository } from '@agent-core/persistence/node';
import {
  HistoryReader,
  agentEventCodec,
  type AgentEvent,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionSubmissionResult,
  type SessionBranchBoundary,
  type SessionBranchPageRequest,
  type SessionBranchSearchRequest,
  type SessionDescriptor
} from '@agent-core/runtime';
import { JsonlNoteRepository, JsonlSessionRepository } from '@agent-core/runtime/node';
import {
  ApplicationEvents,
  SessionNotes,
  progressReplacementKey,
  type ApplicationDeliveryEvent,
  type SessionNoteRead
} from '@agents/application';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
      await this.connect();
    });
  }

  configure(configuration: WritingConfiguration): Promise<void> {
    return this.mutate(async () => {
      this.requireIdle();
      await this.disconnect();
      this.configuration = configuration;
      await this.connect();
    });
  }

  setMode(mode: WritingMode): Promise<void> {
    return this.mutate(() => {
      this.requireIdle();
      this.mode = mode;
    });
  }

  submit(instruction: string): Promise<WritingSubmissionResult> {
    return this.mutate(async () => {
      if (!this.composition) return { kind: 'rejected', reason: 'configuration_required' };
      const runId = randomUUID();
      await recordWritingPermission(this.workspace, runId, this.mode);
      return this.composition.agent.submit({ task: instruction, runId });
    });
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
    this.composition = createWritingSession(this.workspace, this.descriptor, this.configuration);
    this.unsubscribe = this.composition.agent.subscribe(
      (event) => {
        this.events.publish(event);
        this.events.publish({
          type: 'application.state.changed',
          state: this.state()
        });
      },
      (error) => {
        this.events.fail(error);
      }
    );
    await this.composition.agent.restore();
    if (this.composition.agent.state().queuedInputs > 0)
      void this.composition.agent.waitForIdle().catch((cause: unknown) => {
        this.events.fail(cause instanceof Error ? cause : new Error(String(cause)));
      });
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

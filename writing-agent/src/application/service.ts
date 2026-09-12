import { JsonlEventRepository, LocalArtifactRepository } from '@agent-core/persistence/node';
import {
  agentEventCodec,
  createSessionBinding,
  HistoryReader,
  type AgentProgressEvent,
  type SessionBranchPageRequest,
  type SessionBranchSearchRequest,
  type SessionDescriptor
} from '@agent-core/runtime';
import { JsonlNoteRepository, JsonlSessionRepository } from '@agent-core/runtime/node';
import {
  ApplicationEvents,
  progressReplacementKey,
  SessionNotes,
  type ApplicationDeliveryEvent,
  type SessionNoteRead
} from '@agents/application';
import path from 'node:path';
import { contentId, randomId } from '../canonical.js';
import type {
  ManagedTextResource,
  WritingOperationKind,
  WritingOperationResult,
  WritingSelectedRange
} from '../domain.js';
import { createSingleIntent, type WritingIntentKind } from '../operations.js';
import {
  createManagedTextResource,
  openWritingProject,
  readRootedText,
  registerManagedTextResource,
  writingProjectSessionBinding,
  type WritingProject
} from '../project.js';
import {
  acceptRevisionProposal,
  applyRevisionProposal,
  authorizeRevisionApplication,
  rejectRevisionProposal,
  undoWritingRevision
} from '../revisions.js';
import {
  abortWritingOperation,
  continueWritingOperation,
  decideWritingSuspension,
  inspectWritingSession,
  inspectWritingSuspension,
  resolveWritingApproval,
  resumeWritingSuspension,
  startWritingOperation,
  type RuntimeControlInput,
  type RunWritingOperationInput,
  type WritingOperationSubmission
} from '../runtime.js';
import { applyLocalizedTextEdits, offsetRange } from '../text-ranges.js';

export type WritingConfiguration = Omit<
  RuntimeControlInput,
  'project' | 'sessionId' | 'signal' | 'onProgress'
>;
export interface WritingApplicationOptions {
  readonly sessionId?: string;
  readonly configuration?: WritingConfiguration;
}
export interface WritingSelection {
  readonly projectRevisionId: string;
  readonly resourceId: string;
  readonly resourceSha256: string;
  readonly range?: WritingSelectedRange['range'];
}
export interface WritingDocument {
  readonly selection: WritingSelection;
  readonly resource: ManagedTextResource;
  readonly content: string;
}
export type WritingRecoveryTarget =
  | { readonly kind: 'run'; readonly runId: string }
  | { readonly kind: 'operation'; readonly operationId: string };
type AcceptedOperation = Omit<WritingOperationSubmission, 'completion'>;
export type WritingApplicationState = {
  readonly projectId: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly provider?: string;
} & (
  | { readonly status: 'ready' | 'configuration_required' | 'admitting' | 'closed' }
  | { readonly status: 'running'; readonly operation: AcceptedOperation }
  | { readonly status: 'recovering'; readonly target: WritingRecoveryTarget }
);
export type WritingSubmissionResult =
  | ({ readonly kind: 'accepted' } & WritingOperationSubmission)
  | { readonly kind: 'rejected'; readonly reason: 'busy' | 'configuration_required' };
export type WritingApplicationEvent =
  | ApplicationDeliveryEvent
  | { readonly type: 'application.state.changed'; readonly state: WritingApplicationState }
  | { readonly type: 'operation.accepted'; readonly operation: AcceptedOperation }
  | { readonly type: 'operation.progress'; readonly event: AgentProgressEvent }
  | { readonly type: 'operation.completed'; readonly result: WritingOperationResult }
  | { readonly type: 'operation.failed'; readonly operation: AcceptedOperation; readonly error: Error }
  | { readonly type: 'project.changed'; readonly revisionId: string };
export type WritingOperationRequest = Pick<
  RunWritingOperationInput,
  | 'kind'
  | 'instruction'
  | 'intents'
  | 'mode'
  | 'readableResourceIds'
  | 'contextTokenBudget'
  | 'delegatedApplyPolicy'
  | 'selectedRanges'
  | 'expectedProjectRevisionId'
>;

/** Owns application lifetime and coordinates the existing writing operation and revision services. */
export class WritingApplication {
  private readonly events = new ApplicationEvents<WritingApplicationEvent>((event) =>
    event.type === 'operation.progress' ? progressReplacementKey(event.event) : undefined
  );
  private readonly sessions: JsonlSessionRepository;
  private descriptor: SessionDescriptor | undefined;
  private configuration: WritingConfiguration | undefined;
  private active:
    | { readonly submission: WritingOperationSubmission; readonly controller: AbortController }
    | undefined;
  private recovery:
    | {
        readonly target: WritingRecoveryTarget;
        readonly controller: AbortController;
        readonly completion: Promise<WritingOperationResult>;
      }
    | undefined;
  private admissionController: AbortController | undefined;
  private closeCompletion: Promise<void> | undefined;
  private admitting = false;
  private closed = false;
  private mutations: Promise<void> = Promise.resolve();

  constructor(
    private readonly project: WritingProject,
    private readonly options: WritingApplicationOptions = {}
  ) {
    this.configuration = options.configuration;
    this.sessions = new JsonlSessionRepository({
      rootDir: path.join(project.state.projectDirectory(project.store.identity.projectId), 'sessions')
    });
  }

  state(): WritingApplicationState {
    const details = {
      projectId: this.project.store.identity.projectId,
      ...(this.descriptor === undefined ? {} : { sessionId: this.descriptor.id }),
      ...(this.configuration === undefined
        ? {}
        : { provider: this.configuration.provider.id, model: this.configuration.model })
    };
    if (this.closed) return { ...details, status: 'closed' };
    if (this.recovery !== undefined)
      return { ...details, status: 'recovering', target: this.recovery.target };
    if (this.active !== undefined)
      return { ...details, status: 'running', operation: acceptedOperation(this.active.submission) };
    return {
      ...details,
      status: this.admitting
        ? 'admitting'
        : this.configuration === undefined
          ? 'configuration_required'
          : 'ready'
    };
  }

  subscribe(
    listener: (event: WritingApplicationEvent) => void | Promise<void>,
    onFailure: (error: Error) => void
  ): () => void {
    return this.events.subscribe(listener, onFailure);
  }

  start(): Promise<void> {
    return this.mutate(async () => {
      if (this.descriptor !== undefined) return;
      const binding = writingProjectSessionBinding(this.project);
      const id = this.options.sessionId ?? (await this.listSessions())[0]?.id;
      this.descriptor =
        id === undefined
          ? await this.sessions.create({
              binding,
              ...(this.configuration === undefined
                ? {}
                : { provider: this.configuration.provider.id, model: this.configuration.model })
            })
          : await this.sessions.open(id, binding);
      this.publishState();
    });
  }

  configure(configuration: WritingConfiguration): Promise<void> {
    return this.mutate(async () => {
      this.requireIdle();
      if (
        this.configuration !== undefined &&
        this.descriptor !== undefined &&
        (await this.inspectSuspension()) !== undefined
      )
        throw new Error('Resolve the current suspension before changing model configuration.');
      this.configuration = configuration;
      this.publishState();
    });
  }

  async readProject() {
    this.assertOpen();
    const view = await this.project.store.view();
    return {
      snapshot: view.current,
      proposals: [...view.proposals.values()].map(({ proposal, status }) => ({
        proposalId: proposal.proposalId,
        operationId: proposal.operationId,
        baseProjectRevisionId: proposal.baseProjectRevisionId,
        status
      })),
      operations: [...view.operations.values()].map((operation) => ({
        operationId: operation.operationId,
        sessionId: operation.sessionId,
        instruction: operation.instruction,
        kind: operation.kind,
        attempts: [...view.executionAttempts.values()]
          .filter((attempt) => attempt.operationId === operation.operationId)
          .map((attempt) => ({
            runId: attempt.runId,
            lifecycle: view.operationLifecycles.get(attempt.runId)
          }))
      }))
    };
  }

  async readProposal(proposalId: string) {
    this.assertOpen();
    const view = await this.project.store.view();
    const entry = view.proposals.get(proposalId);
    if (entry === undefined) throw new Error(`Unknown writing proposal: ${proposalId}`);
    return {
      ...entry,
      verification: view.productionVerifications.get(proposalId),
      authorization: view.applyAuthorizations.get(proposalId),
      currentProjectRevisionId: view.current.revision.revisionId
    };
  }

  async compareProposal(proposalId: string) {
    const review = await this.readProposal(proposalId);
    const comparisons = await Promise.all(
      review.proposal.textEdits.map(async (edit) => {
        const before = await this.project.store.readObject(edit.baseSha256);
        const resource = (await this.project.store.view()).current.resources.find(
          (resource) => resource.resourceId === edit.resourceId
        );
        return {
          resourceId: edit.resourceId,
          path: resource?.relativePath ?? edit.resourceId,
          before,
          after: applyLocalizedTextEdits(before, edit).content
        };
      })
    );
    return { review, comparisons };
  }

  async readDocument(resourceId: string): Promise<WritingDocument> {
    this.assertOpen();
    const snapshot = (await this.project.store.view()).current;
    const resource = snapshot.resources.find((resource) => resource.resourceId === resourceId);
    if (resource === undefined) throw new Error(`Unknown managed resource: ${resourceId}`);
    const file = await readRootedText(this.project.authority, resource.relativePath, 16 * 1024 * 1024);
    if (file.sha256 !== resource.currentSha256)
      throw new Error(`Managed resource changed outside its recorded revision: ${resourceId}`);
    return {
      resource,
      content: file.content,
      selection: { projectRevisionId: snapshot.revision.revisionId, resourceId, resourceSha256: file.sha256 }
    };
  }

  async instruct(input: {
    readonly kind: WritingOperationKind;
    readonly instruction: string;
    readonly selection: WritingSelection;
    readonly verification?: 'deterministic' | 'semantic';
  }): Promise<WritingSubmissionResult> {
    const document = await this.readDocument(input.selection.resourceId);
    if (
      document.selection.projectRevisionId !== input.selection.projectRevisionId ||
      document.selection.resourceSha256 !== input.selection.resourceSha256
    )
      throw new Error('The selected document revision is stale.');
    const selectedRanges: WritingSelectedRange[] = [];
    if (input.selection.range !== undefined) {
      const offsets = offsetRange(document.content, input.selection.range);
      if (offsets.start === offsets.end) throw new Error('A selected passage must contain text.');
      selectedRanges.push({
        resourceId: input.selection.resourceId,
        resourceSha256: input.selection.resourceSha256,
        range: input.selection.range,
        rangeId: contentId('selected-range', input.selection)
      });
    }
    return this.submit({
      kind: input.kind,
      instruction: input.instruction,
      expectedProjectRevisionId: input.selection.projectRevisionId,
      selectedRanges,
      intents: [
        createSingleIntent({
          intentId: randomId('intent'),
          kind: intentKind(input.kind),
          instruction: input.instruction,
          ...(input.verification === undefined ? {} : { verification: input.verification }),
          targetResourceIds: [input.selection.resourceId],
          targetRangeIds: selectedRanges.map((range) => range.rangeId)
        })
      ]
    });
  }

  submit(input: WritingOperationRequest): Promise<WritingSubmissionResult> {
    return this.mutate(async () => {
      if (this.active !== undefined || this.recovery !== undefined || this.admitting)
        return { kind: 'rejected', reason: 'busy' };
      if (this.configuration === undefined) return { kind: 'rejected', reason: 'configuration_required' };
      this.admitting = true;
      this.publishState();
      const controller = new AbortController();
      this.admissionController = controller;
      try {
        const submission = await startWritingOperation({
          ...input,
          ...this.control(),
          signal: controller.signal
        });
        const completion = submission.completion
          .finally(() => {
            this.active = undefined;
            this.publishState();
          })
          .then(
            (result) => {
              this.events.publish({ type: 'operation.completed', result });
              return result;
            },
            (error: unknown) => {
              this.events.publish({
                type: 'operation.failed',
                operation: acceptedOperation(submission),
                error: error instanceof Error ? error : new Error(String(error))
              });
              throw error;
            }
          );
        void completion.catch(() => undefined);
        this.active = { submission: { ...submission, completion }, controller };
        this.events.publish({ type: 'operation.accepted', operation: acceptedOperation(submission) });
        return { kind: 'accepted', ...submission, completion };
      } finally {
        this.admissionController = undefined;
        this.admitting = false;
        this.publishState();
      }
    });
  }

  async listSessions() {
    this.assertOpen();
    const binding = createSessionBinding(writingProjectSessionBinding(this.project));
    return (await this.sessions.list())
      .filter((session) => session.bindingSha256 === binding.bindingSha256)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  selectSession(sessionId: string): Promise<void> {
    return this.mutate(async () => {
      this.requireIdle();
      this.descriptor = await this.sessions.open(sessionId, writingProjectSessionBinding(this.project));
      this.publishState();
    });
  }
  readHistory(request?: SessionBranchPageRequest) {
    return this.sessions.readBranchPage(this.session(), request);
  }
  searchHistory(request: SessionBranchSearchRequest) {
    return this.sessions.searchBranch(this.session(), request);
  }
  readHistoryEntry(...args: Tail<Parameters<JsonlSessionRepository['readBranchEntry']>>) {
    return this.sessions.readBranchEntry(this.session(), ...args);
  }
  private sessionNotes() {
    const directory = this.project.state.projectDirectory(this.project.store.identity.projectId);
    const artifacts = new LocalArtifactRepository({ rootDir: path.join(directory, 'artifacts') });
    const history = new HistoryReader({
      repository: this.sessions,
      session: this.session(),
      artifacts,
      events: new JsonlEventRepository({ rootDir: path.join(directory, 'runs'), codec: agentEventCodec })
    });
    return new SessionNotes(
      history,
      new JsonlNoteRepository({ rootDir: path.join(directory, 'notes'), artifacts })
    );
  }
  listNotes(cursor?: string) {
    return this.sessionNotes().list(cursor);
  }
  readNote(request: SessionNoteRead) {
    return this.sessionNotes().read(request);
  }

  readSession() {
    return inspectWritingSession(this.control());
  }
  async readSource(sourceId: string) {
    this.assertOpen();
    const view = await this.project.store.view();
    const source = view.current.sources.find((source) => source.sourceId === sourceId);
    if (source === undefined) throw new Error(`Unknown writing source: ${sourceId}`);
    return { source, content: await this.project.store.readObject(source.exactSha256) };
  }
  inspectSuspension() {
    return inspectWritingSuspension(this.control());
  }
  resume(runId: string) {
    return this.recover({ kind: 'run', runId }, (signal) =>
      resumeWritingSuspension({ ...this.control(), runId, signal })
    );
  }
  decide(input: Omit<Parameters<typeof decideWritingSuspension>[0], keyof RuntimeControlInput>) {
    return this.recover({ kind: 'run', runId: input.runId }, (signal) =>
      decideWritingSuspension({ ...this.control(), ...input, signal })
    );
  }
  resolveApproval(input: Omit<Parameters<typeof resolveWritingApproval>[0], keyof RuntimeControlInput>) {
    return this.recover({ kind: 'run', runId: input.runId }, (signal) =>
      resolveWritingApproval({ ...this.control(), ...input, signal })
    );
  }
  continueOperation(operationId: string, instruction?: string) {
    return this.recover({ kind: 'operation', operationId }, (signal) =>
      continueWritingOperation({
        ...this.control(),
        operationId,
        signal,
        ...(instruction === undefined ? {} : { instruction })
      })
    );
  }

  async abort(runId?: string): Promise<void> {
    this.assertOpen();
    if (this.recovery !== undefined) {
      if (
        runId !== undefined &&
        (this.recovery.target.kind !== 'run' || this.recovery.target.runId !== runId)
      )
        throw new Error('Cancellation identifies a different recovery target.');
      this.recovery.controller.abort(new Error('Writing recovery interrupted by user.'));
      return;
    }
    if (this.admissionController !== undefined && runId === undefined) {
      this.admissionController.abort(new Error('Writing admission interrupted by user.'));
      return;
    }
    if (this.active !== undefined) {
      if (runId !== undefined && runId !== this.active.submission.runId)
        throw new Error('Cancellation identifies a different writing run.');
      this.active.controller.abort(new Error('Writing operation interrupted by user.'));
      return;
    }
    if (runId === undefined) throw new Error('Cancellation requires an active or suspended run identity.');
    await this.recover({ kind: 'run', runId }, (signal) =>
      abortWritingOperation({ ...this.control(), runId, signal })
    );
  }

  accept(input: Parameters<typeof acceptRevisionProposal>[1]) {
    return this.changeProject(() => acceptRevisionProposal(this.project, input));
  }
  reject(proposalId: string, explanation: string) {
    return this.changeProject(() => rejectRevisionProposal(this.project, proposalId, explanation));
  }
  authorize(proposalId: string) {
    return this.changeProject(() => authorizeRevisionApplication(this.project, { proposalId }));
  }
  apply(input: Parameters<typeof applyRevisionProposal>[1]) {
    return this.changeProject(() => applyRevisionProposal(this.project, input));
  }
  undo(input: Parameters<typeof undoWritingRevision>[1]) {
    return this.changeProject(() => undoWritingRevision(this.project, input));
  }
  registerResource(input: Parameters<typeof registerManagedTextResource>[1]) {
    return this.changeProject(() => registerManagedTextResource(this.project, input));
  }
  createResource(input: Parameters<typeof createManagedTextResource>[1]) {
    return this.changeProject(() => createManagedTextResource(this.project, input));
  }

  close(): Promise<void> {
    if (this.closeCompletion !== undefined) return this.closeCompletion;
    this.closed = true;
    const reason = new Error('Writing application closed.');
    this.admissionController?.abort(reason);
    this.active?.controller.abort(reason);
    this.recovery?.controller.abort(reason);
    this.closeCompletion = (async () => {
      await this.mutations;
      this.active?.controller.abort(reason);
      this.recovery?.controller.abort(reason);
      await Promise.allSettled([this.active?.submission.completion, this.recovery?.completion]);
      this.events.close();
      this.project.close();
    })();
    return this.closeCompletion;
  }

  private async recover(
    target: WritingRecoveryTarget,
    action: (signal: AbortSignal) => Promise<WritingOperationResult>
  ): Promise<WritingOperationResult> {
    const admitted = await this.mutate(() => {
      this.requireIdle();
      const controller = new AbortController();
      const completion = action(controller.signal)
        .finally(() => {
          this.recovery = undefined;
          this.publishState();
        })
        .then((result) => {
          this.events.publish({ type: 'operation.completed', result });
          return result;
        });
      void completion.catch(() => undefined);
      this.recovery = { target, controller, completion };
      this.publishState();
      return { completion };
    });
    return admitted.completion;
  }
  private changeProject<T>(action: () => Promise<T>): Promise<T> {
    return this.mutate(async () => {
      this.requireIdle();
      const result = await action();
      await this.projectChanged();
      return result;
    });
  }
  private async projectChanged(): Promise<void> {
    const view = await this.project.store.view();
    this.events.publish({ type: 'project.changed', revisionId: view.current.revision.revisionId });
  }
  private publishState(): void {
    this.events.publish({ type: 'application.state.changed', state: this.state() });
  }
  private control(): RuntimeControlInput {
    this.assertOpen();
    if (this.configuration === undefined) throw new Error('Select a provider and model first.');
    return {
      ...this.configuration,
      project: this.project,
      sessionId: this.session().id,
      onProgress: (event) => {
        this.events.publish({ type: 'operation.progress', event });
      }
    };
  }
  private session(): SessionDescriptor {
    this.assertOpen();
    if (this.descriptor === undefined) throw new Error('Start the writing application first.');
    return this.descriptor;
  }
  private requireIdle(): void {
    if (this.active !== undefined || this.recovery !== undefined || this.admitting)
      throw new Error('Wait for the current writing operation to settle.');
  }
  private assertOpen(): void {
    if (this.closed) throw new Error('Writing application is closed.');
  }
  private mutate<T>(action: () => T | Promise<T>): Promise<T> {
    this.assertOpen();
    const result = this.mutations.then(() => {
      this.assertOpen();
      return action();
    });
    this.mutations = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

type Tail<T extends readonly unknown[]> = T extends readonly [unknown, ...infer Rest] ? Rest : never;
function acceptedOperation(submission: WritingOperationSubmission): AcceptedOperation {
  return {
    operationId: submission.operationId,
    runId: submission.runId,
    sessionId: submission.sessionId,
    submissionId: submission.submissionId
  };
}
function intentKind(kind: WritingOperationKind): WritingIntentKind {
  switch (kind) {
    case 'plan':
      return 'structure.create';
    case 'review':
      return 'review.editorial';
    case 'draft':
      return 'text.draft';
    case 'continue':
      return 'text.continue';
    case 'revise':
      return 'text.revise';
    case 'transform':
      return 'text.transform';
    case 'translate':
      return 'text.translate';
  }
}

export async function openWritingApplication(
  options: Parameters<typeof openWritingProject>[0] & WritingApplicationOptions
): Promise<WritingApplication> {
  return new WritingApplication(await openWritingProject(options), options);
}

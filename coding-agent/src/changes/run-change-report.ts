import { resolveToolObservation } from '@agent-core/runtime';
import type { ArtifactRepository, EventRepository } from '@agent-core/persistence';
import type { AgentEvent } from '@agent-core/runtime';
import { applyPatchOutputSchema, type ApplyPatchOutput } from '@agent-core/tools-local';
import { createHash } from 'node:crypto';
import path from 'node:path';

export interface StructuredMutationReceipt {
  readonly eventId: string;
  readonly sequence: number;
  readonly turnId: string;
  readonly toolBatchId: string;
  readonly callIndex: number;
  readonly callId?: string;
  readonly toolAttempt: number;
  readonly fingerprint: string;
  readonly patchSha256: string;
  readonly applicationStatus: ApplyPatchOutput['applicationStatus'];
  readonly transactionOutcome?: ApplyPatchOutput['transactionOutcome'];
  readonly rootState: ApplyPatchOutput['rootState'];
}

export type WorkspaceFileState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly sha256: string; readonly bytes: number }
  | { readonly kind: 'unknown' };

export interface WorkspaceChange {
  readonly path: string;
  readonly absolutePath: string;
  readonly kind: 'added' | 'modified' | 'deleted' | 'moved';
  readonly destinationPath?: string;
  readonly destinationAbsolutePath?: string;
  readonly before: WorkspaceFileState;
  readonly after: WorkspaceFileState;
  readonly receiptSequences: readonly number[];
  readonly state: 'changed' | 'uncertain';
}

export interface RunChangeReport {
  readonly runId: string;
  readonly changes: readonly WorkspaceChange[];
  readonly mutationReceipts: readonly StructuredMutationReceipt[];
}

interface MutationRecord {
  readonly receipt: StructuredMutationReceipt;
  readonly files: ApplyPatchOutput['files'];
}

/** Reads committed structured workspace mutations directly from the authoritative run ledger. */
export async function readRunChangeReport(
  events: EventRepository<AgentEvent>,
  runId: string,
  workspaceRoot: string,
  artifacts?: ArtifactRepository
): Promise<RunChangeReport> {
  const mutations = await readMutations(events, runId, artifacts);
  const paths = new Map<string, FoldedPath>();
  // Undefined origins mark recreated/deleted paths, so path reuse cannot inherit
  // the provenance of an earlier file that moved elsewhere.
  const origins = new Map<string, { path: string | undefined; sequences: readonly number[] }>();
  for (const mutation of mutations) {
    for (const file of mutation.files) {
      const before = file.operation === 'add'
        ? absent()
        : present(file.oldSha256, file.oldBytes);
      const committed = mutation.receipt.rootState === 'known' &&
        (mutation.receipt.transactionOutcome === 'committed' ||
          mutation.receipt.transactionOutcome === 'committed_with_residue') &&
        file.finalState === 'changed';
      const unchanged = file.finalState === 'unchanged';
      const after = unchanged ? before : committed
        ? file.operation === 'delete' || file.operation === 'move'
          ? absent() : present(file.newSha256, file.newBytes)
        : unknown();
      foldPath(paths, file.path, before, after, mutation.receipt.sequence, file.plannedChange && !unchanged);
      if (file.operation === 'move' && file.destinationPath !== undefined) {
        foldPath(paths, file.destinationPath, absent(), unchanged ? absent() : committed
          ? present(file.newSha256, file.newBytes) : unknown(), mutation.receipt.sequence, file.plannedChange && !unchanged);
        if (committed) {
          const priorOrigin = origins.get(file.path);
          const origin = { path: priorOrigin === undefined ? file.path : priorOrigin.path,
            sequences: [...new Set([...(priorOrigin?.sequences ?? []),
              ...(paths.get(file.path)?.sequences ?? []), mutation.receipt.sequence])] };
          origins.set(file.path, { path: undefined, sequences: [] });
          origins.set(file.destinationPath, origin);
          const destination = paths.get(file.destinationPath);
          if (destination) {
            for (const sequence of origin.sequences)
              if (!destination.sequences.includes(sequence)) destination.sequences.push(sequence);
            destination.sequences.sort((a, b) => a - b);
          }
        } else if (!unchanged) {
          origins.set(file.path, { path: undefined, sequences: [] });
          origins.set(file.destinationPath, { path: undefined, sequences: [] });
        }
      } else if (file.operation === 'add' || file.operation === 'delete') {
        if (!unchanged) origins.set(file.path, { path: undefined, sequences: [] });
      }
    }
  }
  const changes = new Map<string, WorkspaceChange>();
  for (const [filePath, folded] of paths) {
    if (!folded.affected || sameFileState(folded.before, folded.after)) continue;
    changes.set(filePath, workspaceChange(workspaceRoot, filePath, folded));
  }
  // A move is a net removal and creation linked by committed receipts, not merely
  // the last operation seen at either path. Intermediate paths disappear naturally.
  for (const [destinationPath, origin] of origins) {
    const sourcePath = origin.path;
    if (sourcePath === undefined || sourcePath === destinationPath) continue;
    const source = paths.get(sourcePath);
    const destination = paths.get(destinationPath);
    if (source?.before.kind !== 'present' || source.after.kind !== 'absent' ||
      destination?.before.kind !== 'absent' || destination.after.kind !== 'present') continue;
    changes.set(sourcePath, Object.freeze({
      ...workspaceChange(workspaceRoot, sourcePath, {
        before: source.before, after: destination.after, affected: true,
        sequences: [...new Set([...origin.sequences, ...source.sequences, ...destination.sequences])].sort((a, b) => a - b)
      }),
      kind: 'moved', destinationPath,
      destinationAbsolutePath: workspacePath(workspaceRoot, destinationPath)
    }));
    changes.delete(destinationPath);
  }
  return Object.freeze({
    runId,
    changes: Object.freeze(
      [...changes.values()].sort((left, right) => left.path.localeCompare(right.path))
    ),
    mutationReceipts: Object.freeze(mutations.map((mutation) => mutation.receipt))
  });
}

interface FoldedPath {
  readonly before: WorkspaceFileState;
  after: WorkspaceFileState;
  affected: boolean;
  readonly sequences: number[];
}
function absent(): WorkspaceFileState { return Object.freeze({ kind: 'absent' }); }
function unknown(): WorkspaceFileState { return Object.freeze({ kind: 'unknown' }); }
function present(sha256: string | undefined, bytes: number): WorkspaceFileState {
  return sha256 === undefined ? unknown() : Object.freeze({ kind: 'present', sha256, bytes });
}
function sameFileState(left: WorkspaceFileState, right: WorkspaceFileState): boolean {
  return left.kind === 'absent' && right.kind === 'absent' ||
    left.kind === 'present' && right.kind === 'present' && left.sha256 === right.sha256;
}
function foldPath(paths: Map<string, FoldedPath>, filePath: string,
  before: WorkspaceFileState, after: WorkspaceFileState, sequence: number, affected: boolean): void {
  const previous = paths.get(filePath);
  if (previous === undefined) paths.set(filePath, { before, after, affected, sequences: [sequence] });
  else {
    previous.after = after;
    previous.affected ||= affected;
    if (!previous.sequences.includes(sequence)) previous.sequences.push(sequence);
  }
}
function workspaceChange(workspaceRoot: string, filePath: string, folded: FoldedPath): WorkspaceChange {
  const { before, after } = folded;
  return Object.freeze({
    path: filePath, absolutePath: workspacePath(workspaceRoot, filePath),
    kind: before.kind === 'absent' && after.kind === 'present' ? 'added'
      : before.kind === 'present' && after.kind === 'absent' ? 'deleted' : 'modified',
    before, after,
    receiptSequences: Object.freeze([...folded.sequences]),
    state: before.kind === 'unknown' || after.kind === 'unknown' ? 'uncertain' : 'changed'
  });
}

function workspacePath(workspaceRoot: string, relativePath: string): string {
  return path.join(workspaceRoot, ...relativePath.split('/'));
}

/** Retrieves the exact patch inputs identified by structured mutation receipts. */
export async function readRecordedMutationPatches(
  events: EventRepository<AgentEvent>,
  runId: string,
  receipts: readonly StructuredMutationReceipt[]
): Promise<readonly { readonly receipt: StructuredMutationReceipt; readonly patch: string }[]> {
  const expected = new Map(receipts.map((receipt) => [attemptKey(receipt), receipt]));
  const starts = new Map<string, string>();
  const patches: { readonly receipt: StructuredMutationReceipt; readonly patch: string }[] = [];
  for await (const envelope of events.read(runId)) {
    const event = envelope.event;
    if (event.type !== 'tool.started' && event.type !== 'tool.ended') continue;
    const key = attemptKey(event);
    const receipt = expected.get(key);
    if (!receipt) continue;
    if (event.type === 'tool.started') {
      const patch = patchDocument(event);
      if (
        event.fingerprint !== receipt.fingerprint ||
        createHash('sha256').update(patch).digest('hex') !== receipt.patchSha256
      )
        throw new Error('Recorded patch input does not match its mutation receipt.');
      starts.set(key, patch);
      continue;
    }
    const patch = starts.get(key);
    if (!patch || envelope.eventId !== receipt.eventId || envelope.sequence !== receipt.sequence)
      throw new Error('Mutation receipt does not identify its recorded patch.');
    patches.push({ receipt, patch });
    expected.delete(key);
    starts.delete(key);
  }
  if (expected.size > 0) throw new Error('A mutation receipt is missing from the run ledger.');
  return Object.freeze(patches);
}

async function readMutations(
  events: EventRepository<AgentEvent>,
  runId: string,
  artifacts?: ArtifactRepository
): Promise<readonly MutationRecord[]> {
  const starts = new Map<string, Extract<AgentEvent, { type: 'tool.started' }>>();
  const mutations: MutationRecord[] = [];
  for await (const envelope of events.read(runId)) {
    const event = envelope.event;
    if (event.type === 'tool.started' && event.toolName === 'apply_patch') {
      starts.set(attemptKey(event), event);
      continue;
    }
    if (
      event.type !== 'tool.ended' ||
      event.toolName !== 'apply_patch' ||
      event.observation.kind !== 'result'
    )
      continue;
    const observation = await resolveToolObservation(event.observation, artifacts);
    if (observation.kind !== 'result') continue;
    const parsed = applyPatchOutputSchema.safeParse(observation.output);
    if (!parsed.success)
      throw new Error(`Run ${runId} contains an invalid apply_patch observation.`);
    const started = starts.get(attemptKey(event));
    if (!started) throw new Error(`Run ${runId} is missing an apply_patch start record.`);
    const patch = patchDocument(started);
    mutations.push({
      receipt: Object.freeze({
        eventId: envelope.eventId,
        sequence: envelope.sequence,
        turnId: event.turnId,
        toolBatchId: event.toolBatchId,
        callIndex: event.callIndex,
        ...(event.callId ? { callId: event.callId } : {}),
        toolAttempt: event.toolAttempt,
        fingerprint: started.fingerprint,
        patchSha256: createHash('sha256').update(patch).digest('hex'),
        applicationStatus: parsed.data.applicationStatus,
        ...(parsed.data.transactionOutcome
          ? { transactionOutcome: parsed.data.transactionOutcome }
          : {}),
        rootState: parsed.data.rootState
      }),
      files: parsed.data.files
    });
    starts.delete(attemptKey(event));
  }
  return Object.freeze(mutations);
}

function attemptKey(
  event: Pick<
    Extract<AgentEvent, { type: 'tool.started' | 'tool.ended' }>,
    'turnId' | 'toolBatchId' | 'callIndex' | 'callId' | 'toolAttempt'
  >
): string {
  return `${event.turnId}\0${event.toolBatchId}\0${String(event.callIndex)}\0${event.callId ?? ''}\0${String(event.toolAttempt)}`;
}

function patchDocument(event: Extract<AgentEvent, { type: 'tool.started' }>): string {
  if (event.input.input.kind === 'text') return event.input.input.value;
  const patch = event.input.input.value.patch;
  if (typeof patch !== 'string')
    throw new Error('Persisted apply_patch input has no patch document.');
  return patch;
}

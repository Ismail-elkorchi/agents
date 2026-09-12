import type { EventRepository } from '@agent-core/persistence';
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

export interface WorkspaceChange {
  readonly path: string;
  readonly absolutePath: string;
  readonly kind: 'added' | 'modified' | 'deleted' | 'moved';
  readonly destinationPath?: string;
  readonly destinationAbsolutePath?: string;
  readonly beforeSha256?: string;
  readonly afterSha256?: string;
  readonly beforeBytes: number;
  readonly afterBytes: number;
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
  workspaceRoot: string
): Promise<RunChangeReport> {
  const mutations = await readMutations(events, runId);
  const changes = new Map<string, WorkspaceChange>();
  for (const mutation of mutations) {
    for (const file of mutation.files) {
      if (!file.plannedChange || file.finalState === 'unchanged') continue;
      const key = file.operation === 'move' && file.destinationPath
        ? `${file.path}\0${file.destinationPath}`
        : file.path;
      const previous = changes.get(key);
      changes.set(
        key,
        Object.freeze({
          path: file.path,
          absolutePath: workspacePath(workspaceRoot, file.path),
          kind:
            file.operation === 'update'
              ? 'modified'
              : file.operation === 'move'
                ? 'moved'
                : file.operation === 'add'
                  ? 'added'
                  : 'deleted',
          ...(file.destinationPath === undefined ? {} : { destinationPath: file.destinationPath }),
          ...(file.destinationPath === undefined
            ? {}
            : { destinationAbsolutePath: workspacePath(workspaceRoot, file.destinationPath) }),
          ...(previous?.beforeSha256 ?? file.oldSha256
            ? { beforeSha256: previous?.beforeSha256 ?? file.oldSha256 }
            : {}),
          ...(file.newSha256 === undefined ? {} : { afterSha256: file.newSha256 }),
          beforeBytes: previous?.beforeBytes ?? file.oldBytes,
          afterBytes: file.newBytes,
          receiptSequences: Object.freeze([
            ...(previous?.receiptSequences ?? []),
            mutation.receipt.sequence
          ]),
          state:
            mutation.receipt.rootState === 'known' &&
            (mutation.receipt.transactionOutcome === 'committed' ||
              mutation.receipt.transactionOutcome === 'committed_with_residue') &&
            file.finalState === 'changed'
              ? 'changed'
              : 'uncertain'
        })
      );
    }
  }
  return Object.freeze({
    runId,
    changes: Object.freeze([...changes.values()].sort((left, right) => left.path.localeCompare(right.path))),
    mutationReceipts: Object.freeze(mutations.map((mutation) => mutation.receipt))
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
  runId: string
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
    const parsed = applyPatchOutputSchema.safeParse(event.observation.output);
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
      files: parsed.data.files.map((file) => ({
        path: file.path,
        operation: file.operation,
        ...(file.destinationPath === undefined ? {} : { destinationPath: file.destinationPath }),
        hunkCount: file.hunkCount,
        additions: file.additions,
        deletions: file.deletions,
        ...(file.oldSha256 === undefined ? {} : { oldSha256: file.oldSha256 }),
        ...(file.newSha256 === undefined ? {} : { newSha256: file.newSha256 }),
        oldBytes: file.oldBytes,
        newBytes: file.newBytes,
        plannedChange: file.plannedChange,
        finalState: file.finalState,
        ...(file.matchModes === undefined ? {} : { matchModes: file.matchModes }),
        ...(file.exact === undefined ? {} : { exact: file.exact })
      }))
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
  if (typeof patch !== 'string') throw new Error('Persisted apply_patch input has no patch document.');
  return patch;
}

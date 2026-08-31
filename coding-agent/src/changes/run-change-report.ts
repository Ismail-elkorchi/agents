import { createHash } from 'node:crypto';
import type { EventRepository } from '@agent-core/evidence';
import type { AgentEvent, AgentRunResult, AgentVerificationStatus } from '@agent-core/runtime';
import {
  applyPatchOutputSchema,
  captureWorkspaceSnapshot,
  type ApplyPatchOutput,
  type RootedFileAuthority,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotEntry
} from '@agent-core/tools-local';
import { PrivateStateDirectory } from '../state/private-state.js';
import { loadRunWorkspaceBaseline, type RunWorkspaceBaseline } from './workspace-baseline-store.js';

const MAX_REPORT_CHANGES = 200;
const MAX_REPORT_RECEIPTS = 200;

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
  readonly operationStatus: ApplyPatchOutput['operationStatus'];
  readonly transactionOutcome?: ApplyPatchOutput['transactionOutcome'];
  readonly rootState: ApplyPatchOutput['rootState'];
}

interface DecodedMutationReceipt extends StructuredMutationReceipt {
  readonly files: readonly MutationFileReceipt[];
}

interface MutationFileReceipt {
  readonly path: string;
  readonly operation: 'add' | 'update' | 'delete' | 'move';
  readonly destinationPath?: string;
  readonly hunkCount: number;
  readonly additions: number;
  readonly deletions: number;
  readonly oldSha256?: string;
  readonly newSha256?: string;
  readonly oldBytes: number;
  readonly newBytes: number;
  readonly plannedChange: boolean;
  readonly finalState: 'unchanged' | 'changed' | 'uncertain';
  readonly matchModes?: readonly ('exact' | 'trim_trailing_whitespace' | 'trim_surrounding_whitespace' | 'normalize_common_unicode_punctuation')[];
  readonly exact?: boolean;
}

export interface WorkspaceChange {
  readonly path: string;
  readonly kind: 'added' | 'modified' | 'deleted' | 'replaced';
  readonly attribution: 'structured_mutation' | 'external_or_concurrent';
  readonly initial: 'existing' | 'absent';
  readonly versionControlBaseline: 'changed' | 'not_reported' | 'not_applicable' | 'unavailable';
  readonly content: 'text' | 'binary' | 'large' | 'non_file' | 'unknown';
  readonly beforeSha256?: string;
  readonly afterSha256?: string;
  readonly beforeBytes?: number;
  readonly afterBytes?: number;
  readonly receiptSequences: readonly number[];
  readonly conflicts: readonly string[];
}

export interface RunChangeReport {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly baselineDigest: string;
  readonly finalDigest: string;
  readonly coverage: 'complete' | 'partial';
  readonly causes: readonly string[];
  readonly changes: readonly WorkspaceChange[];
  readonly totalChanges: number;
  readonly omittedChanges: number;
  readonly mutationReceipts: readonly StructuredMutationReceipt[];
  readonly totalMutationReceipts: number;
  readonly omittedMutationReceipts: number;
  readonly facts: {
    readonly changedPaths: readonly string[];
    readonly structuredMutationPaths: readonly string[];
    readonly externalOrConcurrentPaths: readonly string[];
    readonly verificationStatus: 'not_available' | AgentVerificationStatus;
  };
}

/** Derives one bounded coding-domain report from the run ledger and exact workspace states. */
export async function createRunChangeReport(input: {
  readonly runId: string;
  readonly root: RootedFileAuthority;
  readonly state: PrivateStateDirectory;
  readonly events: EventRepository<AgentEvent>;
  readonly result?: AgentRunResult;
}): Promise<RunChangeReport> {
  if (input.result?.state === 'ended' && input.result.terminal.runId !== input.runId) {
    throw new Error(`Run result ${input.result.terminal.runId} cannot finalize change report ${input.runId}.`);
  }
  const [baseline, final, mutations] = await Promise.all([
    loadRunWorkspaceBaseline(input.state, input.runId),
    captureWorkspaceSnapshot(input.root),
    readMutationReceipts(input.events, input.runId)
  ]);
  return deriveRunChangeReport(input.runId, baseline, final, mutations.receipts, input.result, mutations.causes);
}

export function deriveRunChangeReport(
  runId: string,
  baseline: RunWorkspaceBaseline,
  final: WorkspaceSnapshot,
  receipts: readonly DecodedMutationReceipt[],
  result?: AgentRunResult,
  mutationCauses: readonly string[] = []
): RunChangeReport {
  const before = new Map(baseline.workspace.entries.map((entry) => [entry.path, entry]));
  const after = new Map(final.entries.map((entry) => [entry.path, entry]));
  const predicted = new Map<string, PredictedState>();
  const receiptSequences = new Map<string, Set<number>>();
  const conflicts = new Map<string, Set<string>>();
  const touched = new Set<string>();
  for (const receipt of receipts) applyReceipt(receipt, before, predicted, receiptSequences, conflicts, touched);

  for (const path of touched) {
    const expected = predicted.get(path) ?? stateFromEntry(before.get(path));
    if (!predictedMatches(expected, after.get(path))) addConflict(conflicts, path, 'final_state_does_not_match_structured_mutation_receipts');
  }

  const versionControlBaseline = initialVersionControlPaths(baseline);
  const changedPaths = [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => changedEntry(before.get(path), after.get(path)))
    .filter((path) => !directoryOnlyChange(before.get(path), after.get(path)))
    .sort(compareCodeUnits);
  const changes = changedPaths.map((path): WorkspaceChange => {
    const beforeEntry = before.get(path);
    const afterEntry = after.get(path);
    const pathConflicts = Object.freeze([...(conflicts.get(path) ?? [])].sort(compareCodeUnits));
    const attributed = touched.has(path) && pathConflicts.length === 0;
    return Object.freeze({
      path,
      kind: changeKind(beforeEntry, afterEntry),
      attribution: attributed ? 'structured_mutation' : 'external_or_concurrent',
      initial: beforeEntry === undefined ? 'absent' : 'existing',
      versionControlBaseline: versionControlBaseline.kind === 'observed'
        ? versionControlBaseline.paths.has(path) ? 'changed' : 'not_reported'
        : versionControlBaseline.kind,
      content: changeContent(beforeEntry, afterEntry),
      ...(beforeEntry?.sha256 ? { beforeSha256: beforeEntry.sha256 } : {}),
      ...(afterEntry?.sha256 ? { afterSha256: afterEntry.sha256 } : {}),
      ...(beforeEntry?.bytes !== undefined ? { beforeBytes: beforeEntry.bytes } : {}),
      ...(afterEntry?.bytes !== undefined ? { afterBytes: afterEntry.bytes } : {}),
      receiptSequences: Object.freeze([...(receiptSequences.get(path) ?? [])].sort((left, right) => left - right)),
      conflicts: pathConflicts
    });
  });
  const retainedChanges = Object.freeze(changes.slice(0, MAX_REPORT_CHANGES));
  const retainedReceipts = Object.freeze(receipts.slice(0, MAX_REPORT_RECEIPTS).map(publicReceipt));
  const causes = new Set([...baseline.workspace.causes.map((cause) => `baseline:${cause}`), ...final.causes.map((cause) => `final:${cause}`)]);
  for (const cause of mutationCauses) causes.add(`mutation_receipts:${cause}`);
  if (baseline.workspace.coverage === 'partial') causes.add('baseline:partial');
  if (final.coverage === 'partial') causes.add('final:partial');
  if (baseline.versionControl.kind === 'unavailable') causes.add('version_control:unavailable');
  else if (baseline.versionControl.kind === 'git') {
    if (baseline.versionControl.status.kind === 'unavailable') causes.add('version_control:unavailable');
    else if (baseline.versionControl.status.coverage === 'partial') causes.add('version_control:partial');
  }
  if (changes.length > retainedChanges.length) causes.add('changes:retention_limit');
  if (receipts.length > retainedReceipts.length) causes.add('mutation_receipts:retention_limit');
  if (conflicts.size > 0) causes.add('mutation_receipts:conflict');
  const verificationStatus = result?.state === 'ended' ? result.terminal.verificationStatus : 'not_available';
  return Object.freeze({
    schemaVersion: 1,
    runId,
    baselineDigest: baseline.workspace.digest,
    finalDigest: final.digest,
    coverage: causes.size === 0 ? 'complete' : 'partial',
    causes: Object.freeze([...causes].sort(compareCodeUnits)),
    changes: retainedChanges,
    totalChanges: changes.length,
    omittedChanges: changes.length - retainedChanges.length,
    mutationReceipts: retainedReceipts,
    totalMutationReceipts: receipts.length,
    omittedMutationReceipts: receipts.length - retainedReceipts.length,
    facts: Object.freeze({
      changedPaths: Object.freeze(retainedChanges.map((change) => change.path)),
      structuredMutationPaths: Object.freeze(retainedChanges.filter((change) => change.attribution === 'structured_mutation').map((change) => change.path)),
      externalOrConcurrentPaths: Object.freeze(retainedChanges.filter((change) => change.attribution === 'external_or_concurrent').map((change) => change.path)),
      verificationStatus
    })
  });
}

export function decodeRunChangeReport(value: unknown, expectedRunId?: string): RunChangeReport {
  if (!record(value)
    || Object.keys(value).some((key) => !['schemaVersion', 'runId', 'baselineDigest', 'finalDigest', 'coverage', 'causes', 'changes', 'totalChanges', 'omittedChanges', 'mutationReceipts', 'totalMutationReceipts', 'omittedMutationReceipts', 'facts'].includes(key))
    || value.schemaVersion !== 1
    || typeof value.runId !== 'string' || (expectedRunId !== undefined && value.runId !== expectedRunId)
    || !sha256(value.baselineDigest) || !sha256(value.finalDigest)
    || (value.coverage !== 'complete' && value.coverage !== 'partial')
    || !stringList(value.causes)
    || !Array.isArray(value.changes) || value.changes.length > MAX_REPORT_CHANGES
    || !nonNegativeInteger(value.totalChanges) || !nonNegativeInteger(value.omittedChanges)
    || value.totalChanges !== value.changes.length + value.omittedChanges
    || !Array.isArray(value.mutationReceipts) || value.mutationReceipts.length > MAX_REPORT_RECEIPTS
    || !nonNegativeInteger(value.totalMutationReceipts) || !nonNegativeInteger(value.omittedMutationReceipts)
    || value.totalMutationReceipts !== value.mutationReceipts.length + value.omittedMutationReceipts
    || !record(value.facts)) throw new Error('Persisted run change report is invalid.');
  const changes = Object.freeze(value.changes.map(decodeWorkspaceChange));
  const mutationReceipts = Object.freeze(value.mutationReceipts.map(decodeMutationReceipt));
  const facts = decodeFacts(value.facts);
  return Object.freeze({
    schemaVersion: 1,
    runId: value.runId,
    baselineDigest: value.baselineDigest,
    finalDigest: value.finalDigest,
    coverage: value.coverage,
    causes: Object.freeze([...value.causes]),
    changes,
    totalChanges: value.totalChanges,
    omittedChanges: value.omittedChanges,
    mutationReceipts,
    totalMutationReceipts: value.totalMutationReceipts,
    omittedMutationReceipts: value.omittedMutationReceipts,
    facts
  });
}

function decodeWorkspaceChange(value: unknown): WorkspaceChange {
  if (!record(value)
    || Object.keys(value).some((key) => !['path', 'kind', 'attribution', 'initial', 'versionControlBaseline', 'content', 'beforeSha256', 'afterSha256', 'beforeBytes', 'afterBytes', 'receiptSequences', 'conflicts'].includes(key))
    || typeof value.path !== 'string'
    || !changeKindValue(value.kind)
    || (value.attribution !== 'structured_mutation' && value.attribution !== 'external_or_concurrent')
    || (value.initial !== 'existing' && value.initial !== 'absent')
    || (value.versionControlBaseline !== 'changed' && value.versionControlBaseline !== 'not_reported'
      && value.versionControlBaseline !== 'not_applicable' && value.versionControlBaseline !== 'unavailable')
    || !changeContentValue(value.content)
    || (value.beforeSha256 !== undefined && !sha256(value.beforeSha256))
    || (value.afterSha256 !== undefined && !sha256(value.afterSha256))
    || (value.beforeBytes !== undefined && !nonNegativeInteger(value.beforeBytes))
    || (value.afterBytes !== undefined && !nonNegativeInteger(value.afterBytes))
    || !integerList(value.receiptSequences)
    || !stringList(value.conflicts)) throw new Error('Persisted workspace change is invalid.');
  return Object.freeze({
    path: value.path,
    kind: value.kind,
    attribution: value.attribution,
    initial: value.initial,
    versionControlBaseline: value.versionControlBaseline,
    content: value.content,
    ...(typeof value.beforeSha256 === 'string' ? { beforeSha256: value.beforeSha256 } : {}),
    ...(typeof value.afterSha256 === 'string' ? { afterSha256: value.afterSha256 } : {}),
    ...(typeof value.beforeBytes === 'number' ? { beforeBytes: value.beforeBytes } : {}),
    ...(typeof value.afterBytes === 'number' ? { afterBytes: value.afterBytes } : {}),
    receiptSequences: Object.freeze([...value.receiptSequences]),
    conflicts: Object.freeze([...value.conflicts])
  });
}

function decodeMutationReceipt(value: unknown): StructuredMutationReceipt {
  if (!record(value)
    || Object.keys(value).some((key) => !['eventId', 'sequence', 'turnId', 'toolBatchId', 'callIndex', 'callId', 'toolAttempt', 'fingerprint', 'patchSha256', 'operationStatus', 'transactionOutcome', 'rootState'].includes(key))
    || typeof value.eventId !== 'string' || !nonNegativeInteger(value.sequence)
    || typeof value.turnId !== 'string' || typeof value.toolBatchId !== 'string'
    || !nonNegativeInteger(value.callIndex) || (value.callId !== undefined && typeof value.callId !== 'string')
    || !nonNegativeInteger(value.toolAttempt) || typeof value.fingerprint !== 'string' || !sha256(value.patchSha256)
    || !operationStatus(value.operationStatus)
    || (value.transactionOutcome !== undefined && !transactionOutcome(value.transactionOutcome))
    || (value.rootState !== 'known' && value.rootState !== 'uncertain')) throw new Error('Persisted structured mutation receipt is invalid.');
  return Object.freeze({
    eventId: value.eventId,
    sequence: value.sequence,
    turnId: value.turnId,
    toolBatchId: value.toolBatchId,
    callIndex: value.callIndex,
    ...(typeof value.callId === 'string' ? { callId: value.callId } : {}),
    toolAttempt: value.toolAttempt,
    fingerprint: value.fingerprint,
    patchSha256: value.patchSha256,
    operationStatus: value.operationStatus,
    ...(transactionOutcome(value.transactionOutcome) ? { transactionOutcome: value.transactionOutcome } : {}),
    rootState: value.rootState
  });
}

function decodeFacts(value: Record<string, unknown>): RunChangeReport['facts'] {
  if (Object.keys(value).some((key) => !['changedPaths', 'structuredMutationPaths', 'externalOrConcurrentPaths', 'verificationStatus'].includes(key))
    || !stringList(value.changedPaths) || !stringList(value.structuredMutationPaths) || !stringList(value.externalOrConcurrentPaths)
    || !verificationStatus(value.verificationStatus)) throw new Error('Persisted run change facts are invalid.');
  return Object.freeze({
    changedPaths: Object.freeze([...value.changedPaths]),
    structuredMutationPaths: Object.freeze([...value.structuredMutationPaths]),
    externalOrConcurrentPaths: Object.freeze([...value.externalOrConcurrentPaths]),
    verificationStatus: value.verificationStatus
  });
}

async function readMutationReceipts(
  events: EventRepository<AgentEvent>,
  runId: string
): Promise<{ readonly receipts: readonly DecodedMutationReceipt[]; readonly causes: readonly string[] }> {
  const starts = new Map<string, Extract<AgentEvent, { type: 'tool.started' }>>();
  const receipts: DecodedMutationReceipt[] = [];
  const causes = new Set<string>();
  for await (const envelope of events.read(runId)) {
    const event = envelope.event;
    if (event.type === 'tool.started' && event.toolName === 'apply_patch') {
      starts.set(attemptKey(event), event);
      continue;
    }
    if (event.type !== 'tool.ended' || event.toolName !== 'apply_patch' || event.observation.kind !== 'result') continue;
    const parsed = applyPatchOutputSchema.safeParse(event.observation.output);
    if (!parsed.success) throw new Error(`Run ${runId} contains an invalid persisted apply_patch observation at sequence ${String(envelope.sequence)}.`);
    const started = starts.get(attemptKey(event));
    if (!started) throw new Error(`Run ${runId} is missing the apply_patch start for sequence ${String(envelope.sequence)}.`);
    starts.delete(attemptKey(event));
    const patch = patchDocument(started);
    receipts.push(Object.freeze({
      eventId: envelope.eventId,
      sequence: envelope.sequence,
      turnId: event.turnId,
      toolBatchId: event.toolBatchId,
      callIndex: event.callIndex,
      ...(event.callId ? { callId: event.callId } : {}),
      toolAttempt: event.toolAttempt,
      fingerprint: started.fingerprint,
      patchSha256: createHash('sha256').update(patch).digest('hex'),
      operationStatus: parsed.data.operationStatus,
      ...(parsed.data.transactionOutcome ? { transactionOutcome: parsed.data.transactionOutcome } : {}),
      rootState: parsed.data.rootState,
      files: Object.freeze(parsed.data.files.map((file): MutationFileReceipt => Object.freeze({
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
        ...(file.matchModes === undefined ? {} : { matchModes: Object.freeze([...file.matchModes]) }),
        ...(file.exact === undefined ? {} : { exact: file.exact })
      })))
    }));
    if (parsed.data.transactionOutcome === 'committed_with_residue') causes.add('journal_residue');
    if (parsed.data.rootState === 'uncertain' || parsed.data.transactionOutcome === 'rollback_failed') causes.add('uncertain_workspace_state');
  }
  if (starts.size > 0) causes.add('unsettled_structured_mutation');
  return Object.freeze({ receipts: Object.freeze(receipts), causes: Object.freeze([...causes].sort(compareCodeUnits)) });
}

interface PredictedState { readonly kind: 'absent' | 'file'; readonly sha256?: string; readonly bytes?: number; readonly mode?: number }

function applyReceipt(
  receipt: DecodedMutationReceipt,
  baseline: ReadonlyMap<string, WorkspaceSnapshotEntry>,
  predicted: Map<string, PredictedState>,
  sequences: Map<string, Set<number>>,
  conflicts: Map<string, Set<string>>,
  touched: Set<string>
): void {
  if (receipt.rootState !== 'known' || (receipt.transactionOutcome !== 'committed' && receipt.transactionOutcome !== 'committed_with_residue')) {
    for (const file of receipt.files) for (const path of operationPaths(file)) addConflict(conflicts, path, 'mutation_outcome_not_known_committed');
    return;
  }
  for (const file of receipt.files) {
    if (file.finalState !== 'changed') continue;
    const paths = operationPaths(file);
    for (const path of paths) {
      touched.add(path);
      let values = sequences.get(path);
      if (!values) { values = new Set(); sequences.set(path, values); }
      values.add(receipt.sequence);
    }
    const source = predicted.get(file.path) ?? stateFromEntry(baseline.get(file.path));
    if (file.operation === 'add') {
      if (source.kind !== 'absent') addConflict(conflicts, file.path, 'add_source_was_not_absent');
      predicted.set(file.path, predictedFile(file, undefined));
      continue;
    }
    if (source.kind !== 'file' || source.sha256 !== file.oldSha256) addConflict(conflicts, file.path, 'before_hash_does_not_match_receipt_chain');
    if (file.operation === 'delete') { predicted.set(file.path, Object.freeze({ kind: 'absent' })); continue; }
    if (file.operation === 'move') {
      const destination = file.destinationPath;
      if (!destination) { addConflict(conflicts, file.path, 'move_destination_missing'); continue; }
      const destinationState = predicted.get(destination) ?? stateFromEntry(baseline.get(destination));
      if (destinationState.kind !== 'absent') addConflict(conflicts, destination, 'move_destination_was_not_absent');
      predicted.set(file.path, Object.freeze({ kind: 'absent' }));
      predicted.set(destination, predictedFile(file, source.mode));
      continue;
    }
    predicted.set(file.path, predictedFile(file, source.mode));
  }
}

function predictedFile(file: MutationFileReceipt, mode: number | undefined): PredictedState {
  return Object.freeze({
    kind: 'file',
    ...(file.newSha256 ? { sha256: file.newSha256 } : {}),
    bytes: file.newBytes,
    ...(mode === undefined ? {} : { mode })
  });
}

function predictedMatches(expected: PredictedState, actual: WorkspaceSnapshotEntry | undefined): boolean {
  if (expected.kind === 'absent') return actual === undefined;
  return actual?.kind === 'file'
    && expected.sha256 !== undefined
    && actual.sha256 === expected.sha256
    && actual.bytes === expected.bytes
    && (expected.mode === undefined || actual.mode === expected.mode);
}

function stateFromEntry(entry: WorkspaceSnapshotEntry | undefined): PredictedState {
  if (!entry) return Object.freeze({ kind: 'absent' });
  if (entry.kind !== 'file') return Object.freeze({ kind: 'file' });
  return Object.freeze({
    kind: 'file',
    ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
    ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }),
    ...(entry.mode === undefined ? {} : { mode: entry.mode })
  });
}

function initialVersionControlPaths(baseline: RunWorkspaceBaseline):
  | { readonly kind: 'observed'; readonly paths: ReadonlySet<string> }
  | { readonly kind: 'not_applicable' }
  | { readonly kind: 'unavailable' } {
  if (baseline.versionControl.kind === 'none') return Object.freeze({ kind: 'not_applicable' });
  if (baseline.versionControl.kind !== 'git' || baseline.versionControl.status.kind !== 'observed') return Object.freeze({ kind: 'unavailable' });
  return Object.freeze({ kind: 'observed', paths: new Set(baseline.versionControl.status.entries.map((entry) => entry.path)) });
}

function changedEntry(before: WorkspaceSnapshotEntry | undefined, after: WorkspaceSnapshotEntry | undefined): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

function directoryOnlyChange(before: WorkspaceSnapshotEntry | undefined, after: WorkspaceSnapshotEntry | undefined): boolean {
  return (before === undefined || before.kind === 'directory') && (after === undefined || after.kind === 'directory');
}

function changeKind(before: WorkspaceSnapshotEntry | undefined, after: WorkspaceSnapshotEntry | undefined): WorkspaceChange['kind'] {
  if (!before) return 'added';
  if (!after) return 'deleted';
  return before.kind === after.kind ? 'modified' : 'replaced';
}

function changeContent(before: WorkspaceSnapshotEntry | undefined, after: WorkspaceSnapshotEntry | undefined): WorkspaceChange['content'] {
  const entry = after ?? before;
  if (entry?.kind !== 'file') return 'non_file';
  if (entry.content) return entry.content;
  return entry.bytes !== undefined ? 'large' : 'unknown';
}

function operationPaths(file: MutationFileReceipt): readonly string[] {
  return file.operation === 'move' && file.destinationPath ? [file.path, file.destinationPath] : [file.path];
}

function addConflict(conflicts: Map<string, Set<string>>, path: string, cause: string): void {
  let values = conflicts.get(path);
  if (!values) { values = new Set(); conflicts.set(path, values); }
  values.add(cause);
}

function attemptKey(event: Pick<Extract<AgentEvent, { type: 'tool.started' | 'tool.ended' }>, 'turnId' | 'toolBatchId' | 'callIndex' | 'callId' | 'toolAttempt'>): string {
  return `${event.turnId}\0${event.toolBatchId}\0${String(event.callIndex)}\0${event.callId ?? ''}\0${String(event.toolAttempt)}`;
}

function patchDocument(event: Extract<AgentEvent, { type: 'tool.started' }>): string {
  if (event.input.input.kind === 'text') return event.input.input.value;
  const patch = event.input.input.value.patch;
  if (typeof patch !== 'string') throw new Error('Persisted apply_patch input has no patch document.');
  return patch;
}

function publicReceipt(receipt: DecodedMutationReceipt): StructuredMutationReceipt {
  return Object.freeze({
    eventId: receipt.eventId,
    sequence: receipt.sequence,
    turnId: receipt.turnId,
    toolBatchId: receipt.toolBatchId,
    callIndex: receipt.callIndex,
    ...(receipt.callId ? { callId: receipt.callId } : {}),
    toolAttempt: receipt.toolAttempt,
    fingerprint: receipt.fingerprint,
    patchSha256: receipt.patchSha256,
    operationStatus: receipt.operationStatus,
    ...(receipt.transactionOutcome ? { transactionOutcome: receipt.transactionOutcome } : {}),
    rootState: receipt.rootState
  });
}

function compareCodeUnits(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function sha256(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function nonNegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function stringList(value: unknown): value is readonly string[] { return Array.isArray(value) && value.every((item) => typeof item === 'string'); }
function integerList(value: unknown): value is readonly number[] { return Array.isArray(value) && value.every(nonNegativeInteger); }
function changeKindValue(value: unknown): value is WorkspaceChange['kind'] { return value === 'added' || value === 'modified' || value === 'deleted' || value === 'replaced'; }
function changeContentValue(value: unknown): value is WorkspaceChange['content'] { return value === 'text' || value === 'binary' || value === 'large' || value === 'non_file' || value === 'unknown'; }
function operationStatus(value: unknown): value is ApplyPatchOutput['operationStatus'] { return value === 'dry_run' || value === 'no_change' || value === 'applied' || value === 'not_applied' || value === 'uncertain'; }
function transactionOutcome(value: unknown): value is NonNullable<ApplyPatchOutput['transactionOutcome']> { return value === 'committed' || value === 'committed_with_residue' || value === 'rolled_back' || value === 'rollback_failed'; }
function verificationStatus(value: unknown): value is RunChangeReport['facts']['verificationStatus'] { return value === 'not_available' || value === 'not_required' || value === 'not_run' || value === 'passed' || value === 'failed' || value === 'inconclusive'; }

import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  RootedFileAuthority,
  rootedFileIdentitiesEqual,
  TextPatchJournal,
  captureWorkspaceSnapshot,
  changedWorkspacePaths,
  type RootedFileIdentity,
  type TextPatchRemovePlan,
  type TextPatchTransactionPlan,
  type TextPatchWritePlan,
  type TextTransactionReceipt,
  type TextTransactionResult,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotEntry
} from '@agent-core/tools-local';
import {
  createAgentDispositionEffectPlan,
  type AgentDispositionDecision,
  type AgentDispositionEffectPlan
} from '@agent-core/runtime';
import type { EffectRecoveryCapability } from '@agent-core/effects';
import { parseJsonValue, type JsonValue } from '@agent-core/json';

export interface IsolatedWorkingCopyDescriptor {
  readonly implementationId: string;
  readonly workingCopyId: string;
  readonly runId: string;
  readonly sourceId: string;
}

export interface WorkingCopyCheckpoint {
  readonly checkpointId: string;
  readonly digest: string;
  readonly coverage: 'complete' | 'partial';
  readonly causes: readonly string[];
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface WorkingCopyDiffEntry {
  readonly path: string;
  readonly kind: 'added' | 'modified' | 'deleted' | 'replaced';
  readonly content: 'text' | 'binary' | 'directory' | 'other';
  readonly beforeSha256?: string;
  readonly afterSha256?: string;
}

export interface WorkingCopyDiff {
  readonly preChangeDigest: string;
  readonly workingCopyDigest: string;
  readonly coverage: 'complete' | 'partial';
  readonly causes: readonly string[];
  readonly entries: readonly WorkingCopyDiffEntry[];
}

export type WorkingCopyApplicationResult =
  | Readonly<{ readonly status: 'applied'; readonly preChangeDigest: string; readonly workingCopyDigest: string; readonly changedPaths: readonly string[]; readonly transactionId: string }>
  | Readonly<{ readonly status: 'not_applied'; readonly reason: string }>;

export type WorkingCopyApplicationReconciliation =
  | Readonly<{ readonly status: 'settled'; readonly result: WorkingCopyApplicationResult }>
  | Readonly<{ readonly status: 'running' | 'unknown' | 'expired' }>;

export interface WorkingCopyApplyAuthorization {
  readonly authorization: JsonValue;
  readonly recovery: EffectRecoveryCapability;
  start(signal: AbortSignal): Promise<WorkingCopyApplicationResult>;
  reconcile(signal: AbortSignal): Promise<WorkingCopyApplicationReconciliation>;
  release(): Promise<void>;
}

export interface CodingWorkingCopy {
  readonly descriptor: IsolatedWorkingCopyDescriptor;
  readonly preChange: WorkingCopyCheckpoint;
  checkpoint(label: string, signal?: AbortSignal): Promise<WorkingCopyCheckpoint>;
  diff(signal?: AbortSignal): Promise<WorkingCopyDiff>;
  rollback(checkpointId: string, signal?: AbortSignal): Promise<WorkingCopyCheckpoint>;
  authorizeApply(signal?: AbortSignal): Promise<WorkingCopyApplyAuthorization | WorkingCopyApplicationResult>;
  release(): Promise<void>;
}

/** Converts an exact working-copy application into the disposition effect that owns acceptance. */
export async function createWorkingCopyDisposition(
  workingCopy: CodingWorkingCopy,
  signal?: AbortSignal
): Promise<AgentDispositionDecision | AgentDispositionEffectPlan> {
  const authorization = await workingCopy.authorizeApply(signal);
  if (!isApplyAuthorization(authorization)) return applicationDecision(authorization);
  return createAgentDispositionEffectPlan({
    authorization: parseJsonValue(authorization.authorization),
    recovery: authorization.recovery,
    start: async (startSignal) => applicationDecision(await authorization.start(startSignal)),
    reconcile: async (reconcileSignal) => {
      const reconciliation = await authorization.reconcile(reconcileSignal);
      return reconciliation.status === 'settled'
        ? Object.freeze({ status: 'settled' as const, decision: applicationDecision(reconciliation.result) })
        : reconciliation;
    },
    release: () => authorization.release()
  });
}

const IMPLEMENTATION_ID = 'coding-agent.isolated-working-copy@1';
const APPLICATION_RECONCILER_ID = 'coding-agent.working-copy-application@1';

interface WorkingCopyManifest {
  readonly version: 1;
  readonly runId: string;
  readonly sourceId: string;
  readonly preChangeDigest: string;
}

/** Persistent private working copy with exact checkpoints and journaled application. */
export class IsolatedWorkingCopy implements CodingWorkingCopy {
  readonly descriptor: IsolatedWorkingCopyDescriptor;
  readonly preChange: WorkingCopyCheckpoint;
  readonly root: RootedFileAuthority;
  readonly #source: RootedFileAuthority;
  readonly #preChangeSnapshot: WorkspaceSnapshot;
  readonly #directory: string;
  readonly #applicationJournal: TextPatchJournal;
  readonly #workingCopyJournal: TextPatchJournal;
  #released = false;

  private constructor(input: {
    source: RootedFileAuthority;
    preChange: WorkspaceSnapshot;
    directory: string;
    root: RootedFileAuthority;
    applicationJournal: TextPatchJournal;
    workingCopyJournal: TextPatchJournal;
    descriptor: IsolatedWorkingCopyDescriptor;
    preChangeCheckpointId: string;
  }) {
    this.#source = input.source;
    this.#preChangeSnapshot = input.preChange;
    this.#directory = input.directory;
    this.root = input.root;
    this.#applicationJournal = input.applicationJournal;
    this.#workingCopyJournal = input.workingCopyJournal;
    this.descriptor = input.descriptor;
    this.preChange = checkpoint(input.preChangeCheckpointId, input.preChange);
  }

  static async open(input: {
    readonly source: RootedFileAuthority;
    readonly preChange: WorkspaceSnapshot;
    readonly runtimeDirectory: string;
    readonly runId: string;
  }): Promise<IsolatedWorkingCopy> {
    if (input.preChange.coverage !== 'complete') throw new Error('An isolated working copy requires a complete pre-change snapshot.');
    const directory = path.join(input.runtimeDirectory, 'working-copies', identity(input.runId));
    const workspaceDirectory = path.join(directory, 'workspace');
    const manifestPath = path.join(directory, 'manifest.json');
    const sourceId = sourceIdentity(input.source);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const existing = await readManifest(manifestPath);
    const initializing = existing === undefined;
    if (existing === undefined) {
      await restoreWorkspaceSnapshot(input.source, input.preChange, workspaceDirectory);
      const initializedRoot = RootedFileAuthority.adopt(workspaceDirectory);
      try {
        const initialized = await captureWorkspaceSnapshot(initializedRoot);
        if (initialized.coverage !== 'complete' || initialized.digest !== input.preChange.digest) {
          throw new Error(`Working copy ${input.runId} did not reproduce its exact admitted pre-change state.`);
        }
      } finally { initializedRoot.close(); }
    } else if (existing.runId !== input.runId || existing.sourceId !== sourceId || existing.preChangeDigest !== input.preChange.digest) {
      throw new Error(`Working-copy identity conflicts with run ${input.runId}.`);
    }
    const applicationJournalDirectory = path.join(directory, 'application-transactions');
    const workingCopyJournalDirectory = path.join(directory, 'working-copy-transactions');
    await Promise.all([
      mkdir(applicationJournalDirectory, { recursive: true, mode: 0o700 }),
      mkdir(workingCopyJournalDirectory, { recursive: true, mode: 0o700 })
    ]);
    const applicationJournal = TextPatchJournal.adopt(applicationJournalDirectory);
    const workingCopyJournal = TextPatchJournal.adopt(workingCopyJournalDirectory);
    const root = RootedFileAuthority.adopt(workspaceDirectory);
    try {
      const actual = await captureWorkspaceSnapshot(root);
      if (actual.coverage !== 'complete') throw new Error(`Working copy ${input.runId} cannot be observed completely: ${actual.causes.join(', ')}.`);
      const descriptor = Object.freeze({ implementationId: IMPLEMENTATION_ID, workingCopyId: identity(`${input.runId}:${input.preChange.digest}`), runId: input.runId, sourceId });
      const preChangeCheckpointId = identity(`${descriptor.workingCopyId}:preChange:${input.preChange.digest}`);
      const preChangeWorkspace = path.join(directory, 'checkpoints', preChangeCheckpointId, 'workspace');
      const preChangeSnapshotFile = path.join(directory, 'checkpoints', preChangeCheckpointId, 'snapshot.json');
      if (initializing) {
        await restoreWorkspaceSnapshot(root, input.preChange, preChangeWorkspace);
        await writeJsonIfAbsent(preChangeSnapshotFile, input.preChange);
        await writeExclusiveJson(manifestPath, { version: 1, runId: input.runId, sourceId, preChangeDigest: input.preChange.digest });
      } else {
        if (!await directoryExists(preChangeWorkspace)) throw new Error(`Working copy ${input.runId} has no durable pre-change checkpoint.`);
        const storedPreChange = decodeSnapshot(JSON.parse(await readFile(preChangeSnapshotFile, 'utf8')));
        if (storedPreChange.coverage !== 'complete' || storedPreChange.digest !== input.preChange.digest) {
          throw new Error(`Working copy ${input.runId} has a conflicting pre-change checkpoint.`);
        }
      }
      return new IsolatedWorkingCopy({
        source: input.source,
        preChange: input.preChange,
        directory,
        root,
        applicationJournal,
        workingCopyJournal,
        descriptor,
        preChangeCheckpointId
      });
    } catch (error) {
      root.close();
      applicationJournal.close();
      workingCopyJournal.close();
      throw error;
    }
  }

  async checkpoint(label: string, signal?: AbortSignal): Promise<WorkingCopyCheckpoint> {
    this.#assertOpen();
    const normalizedLabel = requiredLabel(label);
    const snapshot = await captureWorkspaceSnapshot(this.root, signal);
    const checkpointId = identity(`${this.descriptor.workingCopyId}:${normalizedLabel}:${snapshot.digest}`);
    if (snapshot.coverage === 'complete') {
      const destination = path.join(this.#directory, 'checkpoints', checkpointId, 'workspace');
      if (!await directoryExists(destination)) await restoreWorkspaceSnapshot(this.root, snapshot, destination);
      await writeJsonIfAbsent(path.join(this.#directory, 'checkpoints', checkpointId, 'snapshot.json'), snapshot);
    }
    return checkpoint(checkpointId, snapshot);
  }

  async diff(signal?: AbortSignal): Promise<WorkingCopyDiff> {
    this.#assertOpen();
    return workspaceDiff(this.#preChangeSnapshot, await captureWorkspaceSnapshot(this.root, signal));
  }

  async rollback(checkpointId: string, signal?: AbortSignal): Promise<WorkingCopyCheckpoint> {
    this.#assertOpen();
    const safeId = safeIdentity(checkpointId, 'checkpoint');
    const snapshotPath = path.join(this.#directory, 'checkpoints', safeId, 'snapshot.json');
    const workspacePath = path.join(this.#directory, 'checkpoints', safeId, 'workspace');
    const target = decodeSnapshot(JSON.parse(await readFile(snapshotPath, 'utf8')));
    const source = RootedFileAuthority.adopt(workspacePath);
    try {
      const current = await captureWorkspaceSnapshot(this.root, signal);
      const unsupported = unsupportedApplicationChanges(current, target);
      if (unsupported.length > 0) throw new Error(`Checkpoint rollback cannot safely represent: ${unsupported.join(', ')}.`);
      const transaction = await planTextTransaction(source, this.root, current, target);
      const transactionId = `rollback-${identity(`${safeId}:${current.digest}:${target.digest}`)}`;
      const result = await this.#workingCopyJournal.withAuthority(this.root, (authority) => authority.commit(transaction, {
        ...(signal === undefined ? {} : { signal }),
        transactionId,
        recoveryPayload: { contract: 'coding-agent.working-copy-rollback@1', workingCopyId: this.descriptor.workingCopyId, checkpointId: safeId }
      }), signal);
      if (!committed(result)) throw new Error(`Checkpoint rollback failed: ${transactionFailure(result)}.`);
      const restored = await captureWorkspaceSnapshot(this.root, signal);
      if (restored.digest !== target.digest || restored.coverage !== 'complete') throw new Error('Checkpoint rollback did not reproduce the exact checkpoint.');
      return checkpoint(safeId, restored);
    } finally { source.close(); }
  }

  async authorizeApply(signal?: AbortSignal): Promise<WorkingCopyApplyAuthorization | WorkingCopyApplicationResult> {
    this.#assertOpen();
    const workingCopy = await captureWorkspaceSnapshot(this.root, signal);
    const diff = workspaceDiff(this.#preChangeSnapshot, workingCopy);
    if (diff.coverage !== 'complete') return notApplied(`Working copy diff is incomplete: ${diff.causes.join(', ')}.`);
    const unsupported = unsupportedApplicationChanges(this.#preChangeSnapshot, workingCopy);
    if (unsupported.length > 0) return notApplied(`Working-copy application cannot safely represent: ${unsupported.join(', ')}.`);
    const transactionId = `apply-${identity(`${this.descriptor.workingCopyId}:${this.#preChangeSnapshot.digest}:${workingCopy.digest}`)}`;
    const prior = await this.#applicationJournal.withAuthority(this.#source, (authority) => authority.receipt(transactionId), signal);
    let applicationPlan: TextPatchTransactionPlan | undefined;
    let planningFailure: string | undefined;
    if (prior === undefined) {
      const currentSource = await captureWorkspaceSnapshot(this.#source, signal);
      if (currentSource.coverage !== 'complete' || currentSource.digest !== this.#preChangeSnapshot.digest) {
        planningFailure = 'The source workspace changed after working-copy isolation; application was not started.';
      } else {
        applicationPlan = await planTextTransaction(this.root, this.#source, this.#preChangeSnapshot, workingCopy);
      }
    }
    const authorization = Object.freeze({
      contract: 'coding-agent.working-copy-application@1',
      workingCopyId: this.descriptor.workingCopyId,
      sourceId: this.descriptor.sourceId,
      runId: this.descriptor.runId,
      preChangeDigest: this.#preChangeSnapshot.digest,
      workingCopyDigest: workingCopy.digest,
      changedPaths: Object.freeze(diff.entries.map((entry) => entry.path)),
      transactionId
    });
    const receiptResult = (receipt: TextTransactionReceipt | undefined) => receipt === undefined
      ? undefined
      : applicationResult(receipt.result, this.#preChangeSnapshot, workingCopy, diff, transactionId);
    const existingResult = receiptResult(prior);
    return Object.freeze({
      authorization,
      recovery: Object.freeze({ kind: 'buffered_mutation' as const, authority: this.#applicationJournal.recoveryIdentity, reconcilerId: APPLICATION_RECONCILER_ID, transactionId }),
      start: async (startSignal: AbortSignal) => {
        if (existingResult) return existingResult;
        if (!applicationPlan) return notApplied(planningFailure ?? 'Working-copy application has no authorized transaction plan.');
        const authorizedPlan = applicationPlan;
        const result = await this.#applicationJournal.withAuthority(this.#source, (authority) => authority.commit(authorizedPlan, {
          signal: startSignal,
          transactionId,
          recoveryPayload: authorization
        }), startSignal);
        const application = applicationResult(result, this.#preChangeSnapshot, workingCopy, diff, transactionId);
        if (application.status === 'applied') {
          const applied = await captureWorkspaceSnapshot(this.#source, startSignal);
          if (applied.coverage !== 'complete' || applied.digest !== workingCopy.digest) return notApplied('Application committed but the source workspace no longer matches the exact working copy.');
        }
        return application;
      },
      reconcile: async (reconcileSignal: AbortSignal) => {
        const receipt = await this.#applicationJournal.withAuthority(this.#source, (authority) => authority.receipt(transactionId), reconcileSignal);
        const result = receiptResult(receipt);
        if (result === undefined) return Object.freeze({ status: 'unknown' as const });
        if (result.status === 'applied') {
          const applied = await captureWorkspaceSnapshot(this.#source, reconcileSignal);
          if (applied.coverage !== 'complete' || applied.digest !== workingCopy.digest) {
            return Object.freeze({ status: 'settled' as const, result: notApplied('Application has a durable commit receipt, but the source workspace no longer matches the exact working copy.') });
          }
        }
        return Object.freeze({ status: 'settled' as const, result });
      },
      release: () => Promise.resolve()
    });
  }

  release(): Promise<void> {
    if (this.#released) return Promise.resolve();
    this.#released = true;
    this.root.close();
    this.#applicationJournal.close();
    this.#workingCopyJournal.close();
    return Promise.resolve();
  }

  #assertOpen(): void { if (this.#released) throw new Error('The working copy has been released.'); }
}

export async function deleteIsolatedWorkingCopy(runtimeDirectory: string, runId: string): Promise<void> {
  await rm(path.join(runtimeDirectory, 'working-copies', identity(runId)), { recursive: true, force: true });
}

export function isolatedWorkingCopyWorkspacePath(runtimeDirectory: string, runId: string): string {
  return path.join(runtimeDirectory, 'working-copies', identity(runId), 'workspace');
}

function workspaceDiff(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkingCopyDiff {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const entries = changedWorkspacePaths(before, after).map((entryPath): WorkingCopyDiffEntry => {
    const initial = beforeByPath.get(entryPath);
    const final = afterByPath.get(entryPath);
    return Object.freeze({
      path: entryPath,
      kind: initial === undefined ? 'added' : final === undefined ? 'deleted' : initial.kind === final.kind ? 'modified' : 'replaced',
      content: diffContent(initial, final),
      ...(initial?.sha256 ? { beforeSha256: initial.sha256 } : {}),
      ...(final?.sha256 ? { afterSha256: final.sha256 } : {})
    });
  });
  const causes = [...before.causes.map((cause) => `pre-change:${cause}`), ...after.causes.map((cause) => `working-copy:${cause}`)];
  return Object.freeze({
    preChangeDigest: before.digest,
    workingCopyDigest: after.digest,
    coverage: before.coverage === 'complete' && after.coverage === 'complete' ? 'complete' : 'partial',
    causes: Object.freeze(causes),
    entries: Object.freeze(entries)
  });
}

function unsupportedApplicationChanges(before: WorkspaceSnapshot, after: WorkspaceSnapshot): readonly string[] {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const changed = changedWorkspacePaths(before, after);
  const unsupported: string[] = [];
  for (const changedPath of changed) {
    const initial = beforeByPath.get(changedPath);
    const final = afterByPath.get(changedPath);
    if (initial?.kind === 'file' && initial.content !== 'text') { unsupported.push(`${changedPath} (binary or unbounded source file)`); continue; }
    if (final?.kind === 'file' && final.content !== 'text') { unsupported.push(`${changedPath} (binary or unbounded working-copy file)`); continue; }
    if (initial?.kind === 'directory' && final === undefined) { unsupported.push(`${changedPath} (directory removal)`); continue; }
    if (initial === undefined && final?.kind === 'directory') {
      const hasAddedFile = changed.some((descendantPath) => descendantPath.startsWith(`${changedPath}/`) && afterByPath.get(descendantPath)?.kind === 'file');
      if (!hasAddedFile || (final.mode ?? 0) % 0o1000 !== 0o700) unsupported.push(`${changedPath} (empty or non-private directory addition)`);
      continue;
    }
    if (initial?.kind === 'directory' && final?.kind === 'directory') {
      unsupported.push(`${changedPath} (directory metadata change)`);
      continue;
    }
    if ((initial !== undefined && initial.kind !== 'file') || (final !== undefined && final.kind !== 'file')) unsupported.push(`${changedPath} (non-file replacement)`);
  }
  return Object.freeze(unsupported);
}

async function planTextTransaction(contentRoot: RootedFileAuthority, targetRoot: RootedFileAuthority, before: WorkspaceSnapshot, after: WorkspaceSnapshot): Promise<TextPatchTransactionPlan> {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const writes: TextPatchWritePlan[] = [];
  const removes: TextPatchRemovePlan[] = [];
  for (const changedPath of changedWorkspacePaths(before, after)) {
    const initial = beforeByPath.get(changedPath);
    const final = afterByPath.get(changedPath);
    if (final?.kind === 'directory' || initial?.kind === 'directory') continue;
    if (final?.kind === 'file') {
      if (final.content !== 'text' || final.sha256 === undefined || final.mode === undefined) throw new Error(`Working-copy file cannot be applied as text: ${changedPath}`);
      const content = await readExactText(contentRoot, final);
      if (initial?.kind === 'file') {
        if (initial.sha256 === undefined || initial.bytes === undefined) throw new Error(`Pre-change file is incomplete: ${changedPath}`);
        const expectedIdentity = await assertExactTarget(targetRoot, changedPath, initial.sha256, initial.bytes);
        writes.push(Object.freeze({ path: changedPath, content, mode: final.mode, overwrite: true, expectedCurrentSha256: initial.sha256, expectedCurrentIdentity: expectedIdentity }));
      } else {
        if ((await targetRoot.inspectPath(changedPath)).kind !== 'absent') throw new Error(`Target appeared before transaction staging: ${changedPath}`);
        writes.push(Object.freeze({ path: changedPath, content, mode: final.mode, overwrite: false, expectedAbsent: true }));
      }
      continue;
    }
    if (initial?.kind === 'file') {
      if (initial.sha256 === undefined || initial.bytes === undefined) throw new Error(`Pre-change file is incomplete: ${changedPath}`);
      const expectedIdentity = await assertExactTarget(targetRoot, changedPath, initial.sha256, initial.bytes);
      removes.push(Object.freeze({ path: changedPath, expectedCurrentSha256: initial.sha256, expectedCurrentIdentity: expectedIdentity }));
    }
  }
  const parentDirsToCreate = changedWorkspacePaths(before, after)
    .filter((changedPath) => beforeByPath.get(changedPath) === undefined && afterByPath.get(changedPath)?.kind === 'directory')
    .sort((left, right) => left.split('/').length - right.split('/').length || compareCodeUnits(left, right));
  return Object.freeze({ writes: Object.freeze(writes), removes: Object.freeze(removes), parentDirsToCreate: Object.freeze(parentDirsToCreate) });
}

async function assertExactTarget(root: RootedFileAuthority, filePath: string, expectedSha256: string, expectedBytes: number): Promise<RootedFileIdentity> {
  const file = await root.openFile(filePath);
  try {
    const identity = file.identity;
    const content = await file.readAll(expectedBytes + 1);
    if (content.byteLength !== expectedBytes || sha256(content) !== expectedSha256
      || !rootedFileIdentitiesEqual(identity, await file.identityNow())
      || !rootedFileIdentitiesEqual(identity, await root.fileIdentity(filePath))) {
      throw new Error(`Target changed before transaction staging: ${filePath}`);
    }
    return identity;
  } finally { await file.close(); }
}

async function readExactText(root: RootedFileAuthority, entry: WorkspaceSnapshotEntry): Promise<string> {
  const file = await root.openFile(entry.path);
  try {
    const bytes = await file.readAll((entry.bytes ?? 0) + 1);
    if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error(`Working copy content changed while staging the transaction: ${entry.path}`);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally { await file.close(); }
}

function applicationResult(result: TextTransactionResult, preChange: WorkspaceSnapshot, workingCopy: WorkspaceSnapshot, diff: WorkingCopyDiff, transactionId: string): WorkingCopyApplicationResult {
  return committed(result)
    ? Object.freeze({ status: 'applied' as const, preChangeDigest: preChange.digest, workingCopyDigest: workingCopy.digest, changedPaths: Object.freeze(diff.entries.map((entry) => entry.path)), transactionId })
    : notApplied(`Working-copy application transaction ${transactionId} did not commit: ${transactionFailure(result)}.`);
}
function isApplyAuthorization(
  value: WorkingCopyApplyAuthorization | WorkingCopyApplicationResult
): value is WorkingCopyApplyAuthorization {
  return 'start' in value && typeof value.start === 'function';
}
function applicationDecision(result: WorkingCopyApplicationResult): AgentDispositionDecision {
  return result.status === 'applied'
    ? Object.freeze({ kind: 'accept' as const })
    : Object.freeze({ kind: 'inconclusive' as const, reason: boundedReason(result.reason) });
}
function committed(result: TextTransactionResult): boolean { return result.outcome === 'committed' || result.outcome === 'committed_with_residue'; }
function transactionFailure(result: TextTransactionResult): string {
  return result.outcome === 'rolled_back' || result.outcome === 'rollback_failed'
    ? `${result.outcome}: ${result.failure.message}`
    : result.outcome;
}
function notApplied(reason: string): WorkingCopyApplicationResult { return Object.freeze({ status: 'not_applied' as const, reason }); }
function boundedReason(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) return 'Working-copy application did not complete.';
  return normalized.length <= 16_000 ? normalized : `${normalized.slice(0, 15_999)}…`;
}
function checkpoint(checkpointId: string, snapshot: WorkspaceSnapshot): WorkingCopyCheckpoint {
  return Object.freeze({ checkpointId, digest: snapshot.digest, coverage: snapshot.coverage, causes: snapshot.causes, fileCount: snapshot.fileCount, totalBytes: snapshot.totalBytes });
}
function diffContent(before: WorkspaceSnapshotEntry | undefined, after: WorkspaceSnapshotEntry | undefined): WorkingCopyDiffEntry['content'] {
  const entry = after ?? before;
  if (entry?.kind === 'directory') return 'directory';
  if (entry?.kind !== 'file') return 'other';
  return entry.content ?? 'binary';
}

/** Materializes an exact private copy of a complete snapshot without following filesystem aliases. */
export async function restoreWorkspaceSnapshot(source: RootedFileAuthority, snapshot: WorkspaceSnapshot, destination: string): Promise<void> {
  if (snapshot.coverage !== 'complete') throw new Error('Only complete workspace snapshots can be materialized.');
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = path.join(parent, `.workspace.${randomUUID()}.tmp`);
  await mkdir(staging, { mode: 0o700 });
  try {
    const directories = snapshot.entries.filter((entry) => entry.kind === 'directory');
    for (const entry of directories) await mkdir(path.join(staging, ...entry.path.split('/')), { recursive: true, mode: 0o700 });
    for (const entry of snapshot.entries) {
      if (entry.kind === 'directory') continue;
      if (entry.kind !== 'file' || entry.sha256 === undefined || entry.bytes === undefined || entry.mode === undefined) throw new Error(`Snapshot contains an unmaterializable entry: ${entry.path}`);
      const sourceFile = await source.openFile(entry.path);
      try {
        const content = await sourceFile.readAll(entry.bytes + 1);
        if (content.byteLength !== entry.bytes || sha256(content) !== entry.sha256) throw new Error(`Source changed before materialization: ${entry.path}`);
        const target = path.join(staging, ...entry.path.split('/'));
        const handle = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(content); await handle.chmod(entry.mode & 0o7777); await handle.sync(); }
        finally { await handle.close(); }
      } finally { await sourceFile.close(); }
    }
    for (const entry of [...directories].sort((left, right) => right.path.split('/').length - left.path.split('/').length)) {
      if (entry.mode !== undefined) await chmod(path.join(staging, ...entry.path.split('/')), entry.mode & 0o7777);
    }
    await syncDirectories(staging, directories.map((entry) => entry.path));
    try { await rename(staging, destination); }
    catch (error) {
      if (nodeCode(error) !== 'EEXIST' && nodeCode(error) !== 'ENOTEMPTY') throw error;
      await rm(staging, { recursive: true, force: true });
    }
    await syncDirectory(parent);
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

async function syncDirectories(root: string, directories: readonly string[]): Promise<void> {
  for (const relative of [...directories].sort((left, right) => right.split('/').length - left.split('/').length)) await syncDirectory(path.join(root, ...relative.split('/')));
  await syncDirectory(root);
}
async function syncDirectory(directory: string): Promise<void> { const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function directoryExists(directory: string): Promise<boolean> {
  try { const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW); try { return (await handle.stat()).isDirectory(); } finally { await handle.close(); } }
  catch (error) { if (nodeCode(error) === 'ENOENT') return false; throw error; }
}
async function readManifest(filePath: string): Promise<WorkingCopyManifest | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (!record(value) || value.version !== 1 || typeof value.runId !== 'string' || typeof value.sourceId !== 'string' || !digest(value.preChangeDigest)) throw new Error(`Invalid working-copy manifest: ${filePath}`);
    return Object.freeze({ version: 1, runId: value.runId, sourceId: value.sourceId, preChangeDigest: value.preChangeDigest });
  } catch (error) { if (nodeCode(error) === 'ENOENT') return undefined; throw error; }
}
async function writeExclusiveJson(filePath: string, value: unknown): Promise<void> { await writeFile(filePath, JSON.stringify(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
async function writeJsonIfAbsent(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try { await writeExclusiveJson(filePath, value); }
  catch (error) { if (nodeCode(error) !== 'EEXIST') throw error; }
}
function decodeSnapshot(value: unknown): WorkspaceSnapshot {
  if (!record(value) || !digest(value.digest) || (value.coverage !== 'complete' && value.coverage !== 'partial') || !Array.isArray(value.causes) || !Array.isArray(value.entries) || !nonnegative(value.fileCount) || !nonnegative(value.totalBytes)) throw new Error('Working copy checkpoint snapshot is invalid.');
  const entries = value.entries.map((entry): WorkspaceSnapshotEntry => {
    if (!record(entry) || typeof entry.path !== 'string' || !snapshotKind(entry.kind)) throw new Error('Working copy checkpoint entry is invalid.');
    return Object.freeze({ path: entry.path, kind: entry.kind, ...(nonnegative(entry.mode) ? { mode: entry.mode } : {}), ...(nonnegative(entry.bytes) ? { bytes: entry.bytes } : {}), ...(digest(entry.sha256) ? { sha256: entry.sha256 } : {}), ...(entry.content === 'text' || entry.content === 'binary' ? { content: entry.content } : {}) });
  });
  if (createHash('sha256').update(JSON.stringify(entries)).digest('hex') !== value.digest) throw new Error('Working copy checkpoint digest is invalid.');
  return Object.freeze({ digest: value.digest, coverage: value.coverage, causes: Object.freeze(value.causes.map(String)), entries: Object.freeze(entries), fileCount: value.fileCount, totalBytes: value.totalBytes });
}
function sourceIdentity(root: RootedFileAuthority): string { return identity(JSON.stringify(root.identity)); }
function identity(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function sha256(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function safeIdentity(value: string, label: string): string { if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`Invalid ${label} identity.`); return value; }
function requiredLabel(value: string): string { const normalized = value.trim(); if (normalized.length === 0 || normalized.length > 200) throw new Error('Checkpoint label must be non-empty and bounded.'); return normalized; }
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function nonnegative(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function snapshotKind(value: unknown): value is WorkspaceSnapshotEntry['kind'] { return value === 'file' || value === 'directory' || value === 'symlink' || value === 'other'; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function nodeCode(error: unknown): string | undefined { return record(error) && typeof error.code === 'string' ? error.code : undefined; }
function compareCodeUnits(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

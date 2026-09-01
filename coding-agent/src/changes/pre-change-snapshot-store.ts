import { createHash } from 'node:crypto';
import {
  captureWorkspaceSnapshot,
  type RootedFileAuthority,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotEntry
} from '@agent-core/tools-local';
import { PrivateStateDirectory } from '../state/private-state.js';
import type { ContentHazard } from '../security/content-provenance.js';
import type { RepositoryVersionControl } from '../workspace/repository-orientation.js';
import type { GitObservationReceipt } from '../workspace/git/repository-observer.js';

const ENTRIES_PER_CHUNK = 1_000;

interface PreChangeSnapshotManifest {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly digest: string;
  readonly coverage: 'complete' | 'partial';
  readonly causes: readonly string[];
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly entryCount: number;
  readonly chunkCount: number;
  readonly versionControlDigest: string;
}

export interface PreChangeSnapshot {
  readonly workspace: WorkspaceSnapshot;
  readonly versionControl: RepositoryVersionControl;
}

/** Returns the immutable pre-effect workspace state owned by one accepted run. */
export async function loadOrCapturePreChangeSnapshot(input: {
  readonly state: PrivateStateDirectory;
  readonly root: RootedFileAuthority;
  readonly runId: string;
  readonly resuming: boolean;
  readonly observeVersionControl: () => Promise<RepositoryVersionControl>;
}): Promise<PreChangeSnapshot> {
  const directory = preChangeSnapshotDirectory(input.runId);
  const stored = await input.state.read(`${directory}/manifest.json`);
  if (stored !== undefined) return loadPreChangeSnapshot(input.state, input.runId);
  if (input.resuming) throw new Error(`Pre-change snapshot for resumed run ${input.runId} is missing.`);

  const versionControlBeforeCapture = await input.observeVersionControl();
  const snapshot = await captureWorkspaceSnapshot(input.root);
  const versionControl = await input.observeVersionControl();
  if (versionControlIdentity(versionControlBeforeCapture) !== versionControlIdentity(versionControl)) {
    throw new Error(`Workspace version-control state changed while run pre-change snapshot ${input.runId} was being captured.`);
  }
  const versionControlText = JSON.stringify(versionControl);
  const versionControlDigest = createHash('sha256').update(versionControlText).digest('hex');
  const chunks = chunk(snapshot.entries, ENTRIES_PER_CHUNK);
  for (let index = 0; index < chunks.length; index += 1) {
    await input.state.write(`${directory}/entries-${String(index)}.json`, JSON.stringify(chunks[index]));
  }
  await input.state.write(`${directory}/version-control.json`, versionControlText);
  const manifest: PreChangeSnapshotManifest = Object.freeze({
    schemaVersion: 1,
    runId: input.runId,
    digest: snapshot.digest,
    coverage: snapshot.coverage,
    causes: snapshot.causes,
    fileCount: snapshot.fileCount,
    totalBytes: snapshot.totalBytes,
    entryCount: snapshot.entries.length,
    chunkCount: chunks.length,
    versionControlDigest
  });
  await input.state.write(`${directory}/manifest.json`, JSON.stringify(manifest));
  return Object.freeze({ workspace: snapshot, versionControl });
}

export async function loadPreChangeSnapshot(
  state: PrivateStateDirectory,
  runId: string
): Promise<PreChangeSnapshot> {
  const directory = preChangeSnapshotDirectory(runId);
  const manifestText = await state.read(`${directory}/manifest.json`);
  if (manifestText === undefined) throw new Error(`Pre-change snapshot for run ${runId} is missing.`);
  return loadPreChange(state, directory, runId, manifestText);
}

export async function deletePreChangeSnapshot(state: PrivateStateDirectory, runId: string): Promise<void> {
  const directory = preChangeSnapshotDirectory(runId);
  const stored = await state.read(`${directory}/manifest.json`);
  if (stored === undefined) return;
  const manifest = decodeManifest(JSON.parse(stored), runId);
  for (let index = 0; index < manifest.chunkCount; index += 1) {
    await state.delete(`${directory}/entries-${String(index)}.json`);
  }
  await state.delete(`${directory}/version-control.json`);
  await state.delete(`${directory}/manifest.json`);
}

async function loadPreChange(
  state: PrivateStateDirectory,
  directory: string,
  runId: string,
  manifestText: string
): Promise<PreChangeSnapshot> {
  const manifest = decodeManifest(JSON.parse(manifestText), runId);
  const entries: WorkspaceSnapshotEntry[] = [];
  for (let index = 0; index < manifest.chunkCount; index += 1) {
    const text = await state.read(`${directory}/entries-${String(index)}.json`);
    if (text === undefined) throw new Error(`Pre-change snapshot ${runId} is missing entry chunk ${String(index)}.`);
    entries.push(...decodeEntries(JSON.parse(text)));
  }
  if (entries.length !== manifest.entryCount) throw new Error(`Pre-change snapshot ${runId} has an invalid entry count.`);
  const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  if (digest !== manifest.digest) throw new Error(`Pre-change snapshot ${runId} failed its content digest.`);
  const fileCount = entries.filter((entry) => entry.kind === 'file' && entry.sha256 !== undefined).length;
  if (fileCount !== manifest.fileCount) throw new Error(`Pre-change snapshot ${runId} has an invalid file count.`);
  const versionControlText = await state.read(`${directory}/version-control.json`);
  if (versionControlText === undefined
    || createHash('sha256').update(versionControlText).digest('hex') !== manifest.versionControlDigest) {
    throw new Error(`Pre-change snapshot ${runId} has an invalid version-control observation.`);
  }
  const versionControl = decodeVersionControl(JSON.parse(versionControlText));
  const workspace = Object.freeze({
    digest,
    coverage: manifest.coverage,
    causes: Object.freeze([...manifest.causes]),
    entries: Object.freeze(entries),
    fileCount,
    totalBytes: manifest.totalBytes
  });
  return Object.freeze({ workspace, versionControl });
}

function decodeManifest(value: unknown, runId: string): PreChangeSnapshotManifest {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !['schemaVersion', 'runId', 'digest', 'coverage', 'causes', 'fileCount', 'totalBytes', 'entryCount', 'chunkCount', 'versionControlDigest'].includes(key))
    || value.schemaVersion !== 1
    || value.runId !== runId
    || !sha256(value.digest)
    || (value.coverage !== 'complete' && value.coverage !== 'partial')
    || !stringArray(value.causes)
    || !nonNegativeInteger(value.fileCount)
    || !nonNegativeInteger(value.totalBytes)
    || !nonNegativeInteger(value.entryCount)
    || !nonNegativeInteger(value.chunkCount)
    || !sha256(value.versionControlDigest)
    || value.chunkCount !== Math.ceil(value.entryCount / ENTRIES_PER_CHUNK)) {
    throw new Error(`Pre-change snapshot manifest for ${runId} is invalid.`);
  }
  return Object.freeze({
    schemaVersion: 1,
    runId,
    digest: value.digest,
    coverage: value.coverage,
    causes: Object.freeze([...value.causes]),
    fileCount: value.fileCount,
    totalBytes: value.totalBytes,
    entryCount: value.entryCount,
    chunkCount: value.chunkCount,
    versionControlDigest: value.versionControlDigest
  });
}

function decodeEntries(value: unknown): readonly WorkspaceSnapshotEntry[] {
  if (!Array.isArray(value) || value.length > ENTRIES_PER_CHUNK) throw new Error('Pre-change snapshot entry chunk is invalid.');
  return Object.freeze(value.map((entry) => {
    if (!isRecord(entry)
      || Object.keys(entry).some((key) => !['path', 'kind', 'mode', 'bytes', 'sha256', 'content'].includes(key))
      || typeof entry.path !== 'string'
      || entry.path.length === 0
      || !isSnapshotKind(entry.kind)
      || (entry.mode !== undefined && !nonNegativeInteger(entry.mode))
      || (entry.bytes !== undefined && !nonNegativeInteger(entry.bytes))
      || (entry.sha256 !== undefined && !sha256(entry.sha256))
      || (entry.content !== undefined && entry.content !== 'text' && entry.content !== 'binary')
      || (entry.kind === 'file' && entry.sha256 !== undefined && entry.content === undefined)
      || (entry.content !== undefined && (entry.kind !== 'file' || entry.sha256 === undefined))) {
      throw new Error('Pre-change snapshot entry is invalid.');
    }
    return Object.freeze({
      path: entry.path,
      kind: entry.kind,
      ...(entry.mode === undefined ? {} : { mode: entry.mode }),
      ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }),
      ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }),
      ...(entry.content === undefined ? {} : { content: entry.content })
    });
  }));
}

function preChangeSnapshotDirectory(runId: string): string {
  return `run-pre-change-snapshots/${createHash('sha256').update(runId).digest('hex')}`;
}

function versionControlIdentity(value: RepositoryVersionControl): string {
  if (value.kind !== 'git') return JSON.stringify(value);
  if (value.status.kind === 'unavailable') return JSON.stringify({ kind: 'git', status: { kind: 'unavailable', reason: value.status.reason } });
  return JSON.stringify({
    kind: 'git',
    status: {
      kind: 'observed',
      ...(value.status.branch ? { branch: value.status.branch } : {}),
      ...(value.status.head ? { head: value.status.head } : {}),
      entries: value.status.entries,
      totalEntries: value.status.totalEntries,
      omittedEntries: value.status.omittedEntries,
      coverage: value.status.coverage
    }
  });
}

function decodeVersionControl(value: unknown): RepositoryVersionControl {
  if (!isRecord(value)) throw new Error('Pre-change snapshot version-control state is invalid.');
  if (value.kind === 'none' && Object.keys(value).length === 1) return Object.freeze({ kind: 'none' });
  if (value.kind === 'unavailable'
    && Object.keys(value).every((key) => key === 'kind' || key === 'reason')
    && typeof value.reason === 'string') return Object.freeze({ kind: 'unavailable', reason: value.reason });
  if (value.kind !== 'git'
    || Object.keys(value).some((key) => key !== 'kind' && key !== 'status')
    || !isRecord(value.status)) throw new Error('Pre-change snapshot version-control state is invalid.');
  const status = value.status;
  if (status.kind === 'unavailable'
    && Object.keys(status).every((key) => key === 'kind' || key === 'reason' || key === 'executionId')
    && typeof status.reason === 'string'
    && (status.executionId === undefined || typeof status.executionId === 'string')) {
    return Object.freeze({ kind: 'git', status: Object.freeze({ kind: 'unavailable', reason: status.reason, ...(status.executionId ? { executionId: status.executionId } : {}) }) });
  }
  if (status.kind !== 'observed'
    || Object.keys(status).some((key) => !['kind', 'branch', 'head', 'entries', 'totalEntries', 'omittedEntries', 'coverage', 'receipt'].includes(key))
    || (status.branch !== undefined && typeof status.branch !== 'string')
    || (status.head !== undefined && typeof status.head !== 'string')
    || !Array.isArray(status.entries)
    || !nonNegativeInteger(status.totalEntries)
    || !nonNegativeInteger(status.omittedEntries)
    || (status.coverage !== 'complete' && status.coverage !== 'partial')
    || !isRecord(status.receipt)) throw new Error('Pre-change snapshot version-control state is invalid.');
  const entries = Object.freeze(status.entries.map((entry) => {
    if (!isRecord(entry)
      || Object.keys(entry).some((key) => !['path', 'state', 'sourcePathSha256', 'hazards'].includes(key))
      || typeof entry.path !== 'string' || typeof entry.state !== 'string' || !sha256(entry.sourcePathSha256)
      || !Array.isArray(entry.hazards)) {
      throw new Error('Pre-change snapshot version-control entry is invalid.');
    }
    const hazards = Object.freeze(entry.hazards.map((hazard: unknown) => decodeContentHazard(hazard)));
    return Object.freeze({ path: entry.path, state: entry.state, sourcePathSha256: entry.sourcePathSha256, hazards });
  }));
  const receipt = decodeReceipt(status.receipt);
  return Object.freeze({
    kind: 'git',
    status: Object.freeze({
      kind: 'observed',
      ...(status.branch ? { branch: status.branch } : {}),
      ...(status.head ? { head: status.head } : {}),
      entries,
      totalEntries: status.totalEntries,
      omittedEntries: status.omittedEntries,
      coverage: status.coverage,
      receipt
    })
  });
}

function decodeReceipt(value: Record<string, unknown>): GitObservationReceipt {
  const required = ['executionId', 'requestDigest', 'policyDigest', 'executionDigest', 'backend', 'backendVersion'];
  if (Object.keys(value).some((key) => ![...required, 'executableIdentityDigest', 'executableContentSha256'].includes(key))
    || required.some((key) => typeof value[key] !== 'string')
    || (value.executableIdentityDigest !== undefined && !sha256(value.executableIdentityDigest))
    || (value.executableContentSha256 !== undefined && !sha256(value.executableContentSha256))) {
    throw new Error('Pre-change snapshot Git receipt is invalid.');
  }
  const executionId = requiredString(value.executionId);
  const requestDigest = requiredString(value.requestDigest);
  const policyDigest = requiredString(value.policyDigest);
  const executionDigest = requiredString(value.executionDigest);
  const backend = requiredString(value.backend);
  const backendVersion = requiredString(value.backendVersion);
  return Object.freeze({
    executionId,
    requestDigest,
    policyDigest,
    executionDigest,
    backend,
    backendVersion,
    ...(typeof value.executableIdentityDigest === 'string' ? { executableIdentityDigest: value.executableIdentityDigest } : {}),
    ...(typeof value.executableContentSha256 === 'string' ? { executableContentSha256: value.executableContentSha256 } : {})
  });
}

function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const chunks: (readonly T[])[] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(Object.freeze(items.slice(index, index + size)));
  return Object.freeze(chunks);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isSnapshotKind(value: unknown): value is WorkspaceSnapshotEntry['kind'] {
  return value === 'file' || value === 'directory' || value === 'symlink' || value === 'other';
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Pre-change snapshot Git receipt is invalid.');
  return value;
}

function isContentHazard(value: unknown): value is ContentHazard {
  return value === 'terminal_control' || value === 'bidirectional_control'
    || value === 'invisible_unicode' || value === 'invalid_unicode';
}

function decodeContentHazard(value: unknown): ContentHazard {
  if (!isContentHazard(value)) throw new Error('Pre-change snapshot version-control hazard is invalid.');
  return value;
}

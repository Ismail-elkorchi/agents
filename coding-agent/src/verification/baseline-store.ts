import { createHash } from 'node:crypto';
import type { WorkspaceFileRoot } from '@agent-core/tools-local';
import { PrivateStateDirectory } from '../state/private-state.js';
import {
  captureWorkspaceSnapshot,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotEntry
} from './workspace-snapshot.js';

const ENTRIES_PER_CHUNK = 1_000;

interface BaselineManifest {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly digest: string;
  readonly coverage: 'complete' | 'partial';
  readonly causes: readonly string[];
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly entryCount: number;
  readonly chunkCount: number;
}

/** Returns the immutable pre-effect workspace state owned by one accepted run. */
export async function loadOrCaptureVerificationBaseline(input: {
  readonly state: PrivateStateDirectory;
  readonly root: WorkspaceFileRoot;
  readonly runId: string;
  readonly resuming: boolean;
}): Promise<WorkspaceSnapshot> {
  const directory = baselineDirectory(input.runId);
  const stored = await input.state.read(`${directory}/manifest.json`);
  if (stored !== undefined) return loadBaseline(input.state, directory, input.runId, stored);
  if (input.resuming) throw new Error(`Verification baseline for resumed run ${input.runId} is missing.`);

  const snapshot = await captureWorkspaceSnapshot(input.root);
  const chunks = chunk(snapshot.entries, ENTRIES_PER_CHUNK);
  for (let index = 0; index < chunks.length; index += 1) {
    await input.state.write(`${directory}/entries-${String(index)}.json`, JSON.stringify(chunks[index]));
  }
  const manifest: BaselineManifest = Object.freeze({
    schemaVersion: 1,
    runId: input.runId,
    digest: snapshot.digest,
    coverage: snapshot.coverage,
    causes: snapshot.causes,
    fileCount: snapshot.fileCount,
    totalBytes: snapshot.totalBytes,
    entryCount: snapshot.entries.length,
    chunkCount: chunks.length
  });
  await input.state.write(`${directory}/manifest.json`, JSON.stringify(manifest));
  return snapshot;
}

export async function deleteVerificationBaseline(state: PrivateStateDirectory, runId: string): Promise<void> {
  const directory = baselineDirectory(runId);
  const stored = await state.read(`${directory}/manifest.json`);
  if (stored === undefined) return;
  const manifest = decodeManifest(JSON.parse(stored), runId);
  for (let index = 0; index < manifest.chunkCount; index += 1) {
    await state.delete(`${directory}/entries-${String(index)}.json`);
  }
  await state.delete(`${directory}/manifest.json`);
}

async function loadBaseline(
  state: PrivateStateDirectory,
  directory: string,
  runId: string,
  manifestText: string
): Promise<WorkspaceSnapshot> {
  const manifest = decodeManifest(JSON.parse(manifestText), runId);
  const entries: WorkspaceSnapshotEntry[] = [];
  for (let index = 0; index < manifest.chunkCount; index += 1) {
    const text = await state.read(`${directory}/entries-${String(index)}.json`);
    if (text === undefined) throw new Error(`Verification baseline ${runId} is missing entry chunk ${String(index)}.`);
    entries.push(...decodeEntries(JSON.parse(text)));
  }
  if (entries.length !== manifest.entryCount) throw new Error(`Verification baseline ${runId} has an invalid entry count.`);
  const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  if (digest !== manifest.digest) throw new Error(`Verification baseline ${runId} failed its content digest.`);
  const fileCount = entries.filter((entry) => entry.kind === 'file' && entry.sha256 !== undefined).length;
  if (fileCount !== manifest.fileCount) throw new Error(`Verification baseline ${runId} has an invalid file count.`);
  return Object.freeze({
    digest,
    coverage: manifest.coverage,
    causes: Object.freeze([...manifest.causes]),
    entries: Object.freeze(entries),
    fileCount,
    totalBytes: manifest.totalBytes
  });
}

function decodeManifest(value: unknown, runId: string): BaselineManifest {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !['schemaVersion', 'runId', 'digest', 'coverage', 'causes', 'fileCount', 'totalBytes', 'entryCount', 'chunkCount'].includes(key))
    || value.schemaVersion !== 1
    || value.runId !== runId
    || !sha256(value.digest)
    || (value.coverage !== 'complete' && value.coverage !== 'partial')
    || !stringArray(value.causes)
    || !nonNegativeInteger(value.fileCount)
    || !nonNegativeInteger(value.totalBytes)
    || !nonNegativeInteger(value.entryCount)
    || !nonNegativeInteger(value.chunkCount)
    || value.chunkCount !== Math.ceil(value.entryCount / ENTRIES_PER_CHUNK)) {
    throw new Error(`Verification baseline manifest for ${runId} is invalid.`);
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
    chunkCount: value.chunkCount
  });
}

function decodeEntries(value: unknown): readonly WorkspaceSnapshotEntry[] {
  if (!Array.isArray(value) || value.length > ENTRIES_PER_CHUNK) throw new Error('Verification baseline entry chunk is invalid.');
  return Object.freeze(value.map((entry) => {
    if (!isRecord(entry)
      || Object.keys(entry).some((key) => !['path', 'kind', 'mode', 'bytes', 'sha256'].includes(key))
      || typeof entry.path !== 'string'
      || entry.path.length === 0
      || !isSnapshotKind(entry.kind)
      || (entry.mode !== undefined && !nonNegativeInteger(entry.mode))
      || (entry.bytes !== undefined && !nonNegativeInteger(entry.bytes))
      || (entry.sha256 !== undefined && !sha256(entry.sha256))) {
      throw new Error('Verification baseline entry is invalid.');
    }
    return Object.freeze({
      path: entry.path,
      kind: entry.kind,
      ...(entry.mode === undefined ? {} : { mode: entry.mode }),
      ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }),
      ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 })
    });
  }));
}

function baselineDirectory(runId: string): string {
  return `verification-baselines/${createHash('sha256').update(runId).digest('hex')}`;
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

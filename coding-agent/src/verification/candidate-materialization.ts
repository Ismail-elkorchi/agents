import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { RootedFileAuthority } from '@agent-core/tools-local';
import type { WorkspaceSnapshot } from './workspace-snapshot.js';

export interface CandidateMaterialization {
  readonly directory: string;
  readonly workspaceRoot: RootedFileAuthority;
  readonly executionRepositoryDirectory: string;
}

/** Materializes one exact, private verifier copy. Existing copies are retained for effect reconciliation. */
export async function materializeVerificationCandidate(input: {
  readonly source: RootedFileAuthority;
  readonly snapshot: WorkspaceSnapshot;
  readonly runtimeDirectory: string;
  readonly runId: string;
  readonly checkId: string;
}): Promise<CandidateMaterialization> {
  if (input.snapshot.coverage !== 'complete') throw new Error('Only complete workspace snapshots can be materialized for verification.');
  const directory = path.join(
    input.runtimeDirectory,
    'verification',
    identity(input.runId),
    identity(input.checkId),
    input.snapshot.digest
  );
  const workspaceDirectory = path.join(directory, 'workspace');
  const executionRepositoryDirectory = path.join(directory, 'executions');
  if (!await directoryExists(workspaceDirectory)) await publishWorkspaceCopy(input.source, input.snapshot, workspaceDirectory);
  await mkdir(executionRepositoryDirectory, { recursive: true, mode: 0o700 });
  return Object.freeze({
    directory,
    workspaceRoot: RootedFileAuthority.adopt(workspaceDirectory),
    executionRepositoryDirectory
  });
}

export async function deleteVerificationMaterializations(runtimeDirectory: string, runId: string): Promise<void> {
  await rm(path.join(runtimeDirectory, 'verification', identity(runId)), { recursive: true, force: true });
}

async function publishWorkspaceCopy(source: RootedFileAuthority, snapshot: WorkspaceSnapshot, destination: string): Promise<void> {
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = path.join(parent, `.workspace.${randomUUID()}.tmp`);
  await mkdir(staging, { mode: 0o700 });
  try {
    const directories = snapshot.entries.filter((entry) => entry.kind === 'directory');
    for (const entry of directories) await mkdir(path.join(staging, ...entry.path.split('/')), { recursive: true, mode: 0o700 });
    for (const entry of snapshot.entries) {
      if (entry.kind === 'directory') continue;
      if (entry.kind !== 'file' || entry.sha256 === undefined || entry.bytes === undefined || entry.mode === undefined) {
        throw new Error(`Workspace snapshot contains an unmaterializable entry: ${entry.path}`);
      }
      const sourceFile = await source.openFile(entry.path);
      try {
        const content = await sourceFile.readAll(entry.bytes + 1);
        const digest = createHash('sha256').update(content).digest('hex');
        if (content.byteLength !== entry.bytes || digest !== entry.sha256) throw new Error(`Workspace file changed before verification materialization: ${entry.path}`);
        const target = path.join(staging, ...entry.path.split('/'));
        const handle = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(content); await handle.chmod(entry.mode & 0o7777); await handle.sync(); }
        finally { await handle.close(); }
      } finally {
        await sourceFile.close();
      }
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
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function syncDirectories(root: string, directories: readonly string[]): Promise<void> {
  for (const relative of [...directories].sort((left, right) => right.split('/').length - left.split('/').length)) {
    await syncDirectory(path.join(root, ...relative.split('/')));
  }
  await syncDirectory(root);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try { return (await handle.stat()).isDirectory(); }
    finally { await handle.close(); }
  } catch (error) {
    if (nodeCode(error) === 'ENOENT') return false;
    throw error;
  }
}

function identity(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nodeCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

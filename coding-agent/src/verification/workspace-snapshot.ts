import { createHash } from 'node:crypto';
import { workspaceFileIdentitiesEqual, type WorkspaceFileRoot } from '@agent-core/tools-local';

const MAX_ENTRIES = 20_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_DEPTH = 64;

export interface WorkspaceSnapshotEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
  readonly mode?: number;
  readonly bytes?: number;
  readonly sha256?: string;
}

export interface WorkspaceSnapshot {
  readonly digest: string;
  readonly coverage: 'complete' | 'partial';
  readonly causes: readonly string[];
  readonly entries: readonly WorkspaceSnapshotEntry[];
  readonly fileCount: number;
  readonly totalBytes: number;
}

/** Captures the exact root-bound file state admitted for verification, excluding authority metadata reserved by the root. */
export async function captureWorkspaceSnapshot(root: WorkspaceFileRoot, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
  const entries: WorkspaceSnapshotEntry[] = [];
  const causes = new Set<string>();
  let totalBytes = 0;
  let stopped = false;

  const walk = async (directoryPath: string, depth: number): Promise<void> => {
    if (stopped) return;
    throwIfAborted(signal);
    if (depth > MAX_DEPTH) { causes.add('depth_limit'); return; }
    const directory = await root.openDirectory(directoryPath);
    let children;
    try { children = [...await directory.entries()].sort((left, right) => compareCodeUnits(left.name, right.name)); }
    finally { await directory.close(); }
    for (const child of children) {
      throwIfAborted(signal);
      const childPath = directoryPath === '.' ? child.name : `${directoryPath}/${child.name}`;
      if (root.isReservedPath(childPath)) continue;
      if (entries.length >= MAX_ENTRIES) { causes.add('entry_limit'); stopped = true; break; }
      if (child.type === 'directory') {
        const handle = await root.openDirectory(childPath);
        try { entries.push(Object.freeze({ path: childPath, kind: 'directory', mode: handle.mode })); }
        finally { await handle.close(); }
        await walk(childPath, depth + 1);
        continue;
      }
      if (child.type !== 'file') {
        entries.push(Object.freeze({ path: childPath, kind: child.type }));
        causes.add(child.type === 'symlink' ? 'symbolic_link' : 'special_file');
        continue;
      }
      const file = await root.openFile(childPath);
      try {
        if (file.size > MAX_FILE_BYTES) {
          entries.push(Object.freeze({ path: childPath, kind: 'file', mode: file.mode, bytes: file.size }));
          causes.add('file_size_limit');
          continue;
        }
        if (totalBytes + file.size > MAX_TOTAL_BYTES) {
          entries.push(Object.freeze({ path: childPath, kind: 'file', mode: file.mode, bytes: file.size }));
          causes.add('total_byte_limit');
          stopped = true;
          break;
        }
        const identity = file.identity;
        const content = await file.readAll(MAX_FILE_BYTES);
        if (!workspaceFileIdentitiesEqual(identity, await file.identityNow())
          || !workspaceFileIdentitiesEqual(identity, await root.fileIdentity(childPath))) {
          causes.add('concurrent_change');
          continue;
        }
        totalBytes += content.byteLength;
        entries.push(Object.freeze({
          path: childPath,
          kind: 'file',
          mode: file.mode,
          bytes: content.byteLength,
          sha256: createHash('sha256').update(content).digest('hex')
        }));
      } catch {
        if (signal?.aborted) throwIfAborted(signal);
        causes.add('unreadable_file');
      } finally {
        await file.close();
      }
    }
  };

  try { await walk('.', 1); }
  catch {
    if (signal?.aborted) throwIfAborted(signal);
    causes.add('unreadable_directory');
  }
  const ownedEntries = Object.freeze([...entries]);
  const digest = createHash('sha256').update(JSON.stringify(ownedEntries)).digest('hex');
  return Object.freeze({
    digest,
    coverage: causes.size === 0 ? 'complete' : 'partial',
    causes: Object.freeze([...causes].sort(compareCodeUnits)),
    entries: ownedEntries,
    fileCount: ownedEntries.filter((entry) => entry.kind === 'file' && entry.sha256 !== undefined).length,
    totalBytes
  });
}

export function changedWorkspacePaths(before: WorkspaceSnapshot, after: WorkspaceSnapshot): readonly string[] {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const paths = new Set([...beforeByPath.keys(), ...afterByPath.keys()]);
  return Object.freeze([...paths].filter((path) => JSON.stringify(beforeByPath.get(path)) !== JSON.stringify(afterByPath.get(path))).sort(compareCodeUnits));
}

export function verifierDefinitionPaths(paths: readonly string[]): readonly string[] {
  return Object.freeze(paths.filter(isVerifierDefinitionPath));
}

function isVerifierDefinitionPath(path: string): boolean {
  const name = path.split('/').at(-1) ?? path;
  return path.startsWith('.github/workflows/')
    || /^(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|deno\.jsonc?|tsconfig(?:\.[^.]+)?\.json)$/u.test(name)
    || /^(?:eslint|jest|vitest|vite|webpack|rollup|biome|ava|mocha|playwright|cypress)(?:\.config)?\./u.test(name)
    || /(?:^|\/)(?:test|tests|spec|specs|__tests__)(?:\/|$)/u.test(path)
    || /(?:\.test|\.spec)\.[^/]+$/u.test(name);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(typeof signal.reason === 'string' ? signal.reason : 'Workspace snapshot aborted.');
}

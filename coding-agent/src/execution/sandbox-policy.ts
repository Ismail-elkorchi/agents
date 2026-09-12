import type {
  FilesystemAccess,
  FilesystemResourcePurpose,
  HostFilesystemResource,
  HostPath,
  IsolatedFilesystemResource,
  IsolatedPath,
  SandboxPolicy
} from '@ismail-elkorchi/sandbox';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export interface CodingCommandEnvironment {
  readonly shellPath: string;
  readonly searchPathName: 'PATH' | 'Path';
  readonly searchPath: string;
  readonly runtimeRoots: readonly CodingRuntimeRoot[];
  commandArguments(command: string): readonly string[];
}

export interface CodingRuntimeRoot {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly execution: 'allow' | 'deny';
}

const READ_ONLY_ACCESS: FilesystemAccess = Object.freeze({
  content: 'read',
  directoryEntries: 'read',
  metadata: 'read',
  execution: 'deny'
});

export const WORKSPACE_ACCESS: FilesystemAccess = Object.freeze({
  content: 'read-write',
  directoryEntries: 'read-write',
  metadata: 'read-write',
  execution: 'allow'
});

export function isolatedPath(value: string): IsolatedPath {
  return { space: 'isolated', path: value };
}

export function hostPath(value: string): HostPath {
  return { space: 'host', path: value };
}

export function isolatedResource(
  id: string,
  source: string,
  target: string,
  access: FilesystemAccess,
  purposes: readonly FilesystemResourcePurpose[],
  rootResolution: 'resolve-once' | 'reject-if-link' = 'resolve-once'
): IsolatedFilesystemResource {
  return {
    id,
    source: hostPath(source),
    target: isolatedPath(target),
    access,
    purposes,
    rootResolution
  };
}

export function hostResource(
  id: string,
  resourcePath: string,
  access: FilesystemAccess,
  purposes: readonly FilesystemResourcePurpose[],
  rootResolution: 'resolve-once' | 'reject-if-link' = 'resolve-once'
): HostFilesystemResource {
  return { id, path: hostPath(resourcePath), access, purposes, rootResolution };
}

export function runtimeAccess(root: CodingRuntimeRoot): FilesystemAccess {
  return Object.freeze({ ...READ_ONLY_ACCESS, execution: root.execution });
}

export function runtimePurposes(root: CodingRuntimeRoot): readonly FilesystemResourcePurpose[] {
  return root.execution === 'allow'
    ? ['executable', 'interpreter', 'loader', 'library', 'data']
    : ['loader', 'library', 'data'];
}

export function isolatedPolicy(input: {
  readonly resources: readonly IsolatedFilesystemResource[];
  readonly home: string;
  readonly temporary: string;
  readonly graceMs: number;
}): SandboxPolicy {
  return {
    filesystem: {
      kind: 'isolated',
      resources: input.resources,
      privateHome: { path: isolatedPath(input.home), sizeBytes: 256 * 1024 * 1024 },
      temporary: {
        path: isolatedPath(input.temporary),
        sizeBytes: 256 * 1024 * 1024,
        executable: false
      }
    },
    network: { mode: 'none' },
    process: {
      visibility: 'session',
      control: 'session',
      termination: { scope: 'descendant-tree', graceMs: input.graceMs }
    },
    ipc: { visibility: 'session' }
  };
}

export function hostPolicy(
  resources: readonly HostFilesystemResource[],
  graceMs: number
): SandboxPolicy {
  return {
    filesystem: { kind: 'host', resources },
    network: { mode: 'none' },
    process: {
      visibility: 'host',
      control: 'session',
      termination: {
        scope: process.platform === 'darwin' ? 'process-group' : 'descendant-tree',
        graceMs
      }
    },
    ipc: { visibility: 'host' }
  };
}

export async function discoverCodingCommandEnvironment(): Promise<CodingCommandEnvironment> {
  const shellPath = await resolveShell();
  const pathEntries = await existingDirectories(environmentPath());
  const activeRuntime = await realpath(process.execPath);
  const candidates: CodingRuntimeRoot[] = [
    ...pathEntries.flatMap(searchDirectoryRoots),
    runtimeRoot(path.dirname(shellPath), 'allow'),
    ...activeRuntimeRoots(activeRuntime),
    ...platformRuntimeRoots()
  ];
  const runtimeRoots = await canonicalRoots(candidates);
  const searchDirectories = [
    path.dirname(shellPath),
    ...pathEntries.filter((directory) =>
      runtimeRoots.some((root) => contains(root.sourcePath, directory))
    )
  ];
  const searchPath = [...new Set(searchDirectories)].join(path.delimiter);
  if (process.platform === 'win32') {
    return Object.freeze({
      shellPath,
      searchPathName: 'Path',
      searchPath,
      runtimeRoots,
      commandArguments: (command: string) => Object.freeze(['/d', '/s', '/c', command])
    });
  }
  return Object.freeze({
    shellPath,
    searchPathName: 'PATH',
    searchPath,
    runtimeRoots,
    commandArguments: (command: string) => Object.freeze(['-c', command])
  });
}

function searchDirectoryRoots(directory: string): readonly CodingRuntimeRoot[] {
  if (path.basename(directory).toLowerCase() !== 'bin') return [runtimeRoot(directory, 'allow')];
  const installation = path.dirname(directory);
  return [runtimeRoot(systemInstallation(installation) ? directory : installation, 'allow')];
}

async function resolveShell(): Promise<string> {
  const candidates =
    process.platform === 'win32'
      ? [process.env.ComSpec, process.env.SystemRoot && path.join(process.env.SystemRoot, 'System32', 'cmd.exe')]
      : [process.env.SHELL, '/bin/sh', '/usr/bin/sh'];
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate)) continue;
    try {
      const metadata = await stat(candidate);
      if (metadata.isFile()) return await realpath(candidate);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
  }
  throw new Error(`No supported command shell is available for ${process.platform}.`);
}

function environmentPath(): readonly string[] {
  const value = process.platform === 'win32' ? process.env.Path ?? process.env.PATH : process.env.PATH;
  if (!value) return [];
  return value
    .split(path.delimiter)
    .map((entry) => entry.replace(/^"|"$/gu, ''))
    .filter((entry) => path.isAbsolute(entry));
}

async function existingDirectories(candidates: readonly string[]): Promise<readonly string[]> {
  const directories: string[] = [];
  for (const candidate of candidates) {
    try {
      const metadata = await stat(candidate);
      if (metadata.isDirectory()) directories.push(await realpath(candidate));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return Object.freeze([...new Set(directories)]);
}

function activeRuntimeRoots(executable: string): readonly CodingRuntimeRoot[] {
  const bin = path.dirname(executable);
  if (path.basename(bin).toLowerCase() !== 'bin') return [runtimeRoot(executable, 'allow')];
  const installation = path.dirname(bin);
  return systemInstallation(installation)
    ? [runtimeRoot(bin, 'allow'), runtimeRoot(path.join(installation, 'lib'), 'allow')]
    : [runtimeRoot(installation, 'allow')];
}

function platformRuntimeRoots(): readonly CodingRuntimeRoot[] {
  if (process.platform === 'win32') {
    return process.env.SystemRoot
      ? [runtimeRoot(process.env.SystemRoot, 'allow')]
      : [];
  }
  if (process.platform === 'darwin') {
    return [
      runtimeRoot('/System', 'allow'),
      runtimeRoot('/usr/lib', 'allow'),
      runtimeRoot('/Library/Apple', 'allow'),
      runtimeRoot('/private/etc', 'deny'),
      runtimeRoot('/private/var/db/timezone', 'deny'),
      runtimeRoot('/dev', 'deny')
    ];
  }
  return [
    runtimeRoot('/bin', 'allow'),
    runtimeRoot('/lib', 'allow'),
    runtimeRoot('/lib64', 'allow'),
    runtimeRoot('/usr/lib', 'allow'),
    runtimeRoot('/usr/lib64', 'allow'),
    runtimeRoot('/usr/local/lib', 'allow'),
    runtimeRoot('/usr/share', 'deny'),
    runtimeRoot('/etc/ssl', 'deny'),
    runtimeRoot('/etc/ca-certificates', 'deny'),
    runtimeRoot('/etc/os-release', 'deny')
  ];
}

async function canonicalRoots(candidates: readonly CodingRuntimeRoot[]): Promise<readonly CodingRuntimeRoot[]> {
  const canonical: {
    sourcePath: string;
    targetPath: string;
    execution: 'allow' | 'deny';
  }[] = [];
  for (const candidate of candidates) {
    try {
      const sourcePath = await realpath(candidate.sourcePath);
      const targetPath = path.normalize(candidate.targetPath);
      const existing = canonical.find((root) => root.targetPath === targetPath);
      if (existing) {
        if (candidate.execution === 'allow') existing.execution = 'allow';
      } else {
        canonical.push({ sourcePath, targetPath, execution: candidate.execution });
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  canonical.sort(
    (left, right) =>
      left.targetPath.length - right.targetPath.length ||
      left.targetPath.localeCompare(right.targetPath)
  );
  const roots: {
    sourcePath: string;
    targetPath: string;
    execution: 'allow' | 'deny';
  }[] = [];
  for (const candidate of canonical) {
    const parent = roots.find((root) => contains(root.targetPath, candidate.targetPath));
    if (parent) {
      if (candidate.execution === 'allow') parent.execution = 'allow';
    } else {
      roots.push(candidate);
    }
  }
  return Object.freeze(roots.map((root) => Object.freeze({ ...root })));
}

export function hostRuntimeRoots(
  candidates: readonly CodingRuntimeRoot[]
): readonly CodingRuntimeRoot[] {
  const sorted = [...candidates].sort(
    (left, right) =>
      left.sourcePath.length - right.sourcePath.length ||
      left.sourcePath.localeCompare(right.sourcePath)
  );
  const roots: {
    sourcePath: string;
    targetPath: string;
    execution: 'allow' | 'deny';
  }[] = [];
  for (const candidate of sorted) {
    const parent = roots.find((root) => contains(root.sourcePath, candidate.sourcePath));
    if (parent) {
      if (candidate.execution === 'allow') parent.execution = 'allow';
    } else {
      roots.push({ ...candidate, targetPath: candidate.sourcePath });
    }
  }
  return Object.freeze(roots.map((root) => Object.freeze({ ...root })));
}

function runtimeRoot(
  resourcePath: string,
  execution: CodingRuntimeRoot['execution']
): CodingRuntimeRoot {
  return { sourcePath: resourcePath, targetPath: resourcePath, execution };
}

function systemInstallation(value: string): boolean {
  if (process.platform === 'win32')
    return process.env.SystemRoot !== undefined && contains(process.env.SystemRoot, value);
  return value === '/usr' || value === '/usr/local';
}

function contains(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

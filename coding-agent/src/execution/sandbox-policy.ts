import type {
  FilesystemAccess,
  IsolatedFilesystemResource,
  IsolatedPath,
  SandboxPolicy
} from '@ismail-elkorchi/sandbox';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const SYSTEM_BIN_DIRECTORIES = [
  '/usr/local/sbin',
  '/usr/local/bin',
  '/usr/sbin',
  '/usr/bin',
  '/sbin',
  '/bin'
];
const SYSTEM_RUNTIME_DIRECTORIES = [
  ...SYSTEM_BIN_DIRECTORIES,
  '/usr/lib',
  '/usr/lib64',
  '/lib',
  '/lib64',
  '/usr/local/lib',
  '/usr/share'
];

export function isolatedPath(value: string): IsolatedPath {
  return { space: 'isolated', path: value };
}

export function filesystemResource(
  id: string,
  source: string,
  target: string,
  access: FilesystemAccess,
  rootResolution: 'resolve-once' | 'reject-if-link' = 'reject-if-link'
): IsolatedFilesystemResource {
  return {
    id,
    source: { space: 'host', path: source },
    target: isolatedPath(target),
    access,
    purposes:
      access.execution === 'allow'
        ? ['executable', 'interpreter', 'loader', 'library', 'data']
        : ['data'],
    rootResolution
  };
}

export const READ_ONLY_ACCESS: FilesystemAccess = Object.freeze({
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

/** Admit installed system tools without exposing host configuration or user data. */
export async function systemRuntimeResources(): Promise<readonly IsolatedFilesystemResource[]> {
  return runtimeResources(SYSTEM_RUNTIME_DIRECTORIES, 'system');
}

async function runtimeResources(
  paths: readonly string[],
  idPrefix: string
): Promise<readonly IsolatedFilesystemResource[]> {
  const resources = await Promise.all(
    paths.map(async (directory, index) => {
      try {
        await stat(directory);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
      }
      return filesystemResource(
        `${idPrefix}-${String(index)}`,
        directory,
        directory,
        { ...READ_ONLY_ACCESS, execution: 'allow' },
        'resolve-once'
      );
    })
  );
  return resources.filter((resource) => resource !== undefined);
}

/** Use the active installation directly; version-manager shims require ambient home state. */
export async function codingToolchain(nodeExecutable: string): Promise<{
  readonly resources: readonly IsolatedFilesystemResource[];
  readonly searchPath: string;
}> {
  const resources = [...(await systemRuntimeResources())];
  const executable = await realpath(nodeExecutable);
  const binDirectory = path.dirname(executable);
  if (!resources.some((resource) => contains(resource.target.path, executable))) {
    // A user may keep Node in ~/bin or directly in their home. Only admit runtime
    // locations; the parent of the executable is not necessarily an installation.
    const locations =
      path.basename(binDirectory) === 'bin'
        ? [binDirectory, path.join(path.dirname(binDirectory), 'lib', 'node_modules')]
        : [executable];
    resources.push(...(await runtimeResources(locations, 'node')));
  }
  return {
    resources,
    searchPath: [...new Set([binDirectory, ...SYSTEM_BIN_DIRECTORIES])].join(':')
  };
}

export function isolatedPolicy(
  resources: readonly IsolatedFilesystemResource[],
  graceMs: number
): SandboxPolicy {
  return {
    filesystem: {
      kind: 'isolated',
      resources,
      privateHome: { path: isolatedPath('/home/sandbox'), sizeBytes: 256 * 1024 * 1024 },
      temporary: { path: isolatedPath('/tmp'), sizeBytes: 256 * 1024 * 1024, executable: false }
    },
    network: { mode: 'none' },
    process: {
      visibility: 'session',
      control: 'session',
      termination: { scope: 'descendant-tree', graceMs }
    },
    ipc: { visibility: 'session' }
  };
}

function contains(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

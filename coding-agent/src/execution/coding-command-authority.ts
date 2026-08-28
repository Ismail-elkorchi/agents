import path from 'node:path';
import type { PrepareCommandRequest } from '@agent-core/tools';
import type { WorkspaceFileRoot } from '@agent-core/tools-local';
import {
  LINUX_PROCESS_BASELINE_REQUIREMENTS,
  createSandbox,
  openSandboxExecutionRepository,
  type SandboxDetachedRunOptions
} from '@ismail-elkorchi/sandbox';
import type { PrivateStateDirectory } from '../state/private-state.js';
import { SandboxCommandExecution, type SandboxPreparedCommand } from './sandbox-command-execution.js';

const TARGET_WORKSPACE = '/workspace';
const MAX_RETAINED_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PROCESSES = 128;

export async function createCodingCommandAuthority(input: {
  readonly repositoryDirectory: string;
  readonly workspaceFileRoot: WorkspaceFileRoot;
  readonly state: PrivateStateDirectory;
}): Promise<SandboxCommandExecution> {
  const sandbox = await createSandbox();
  try {
    const probe = await sandbox.probe();
    const backend = probe.backends.find((candidate) => candidate.id === 'linux-namespace-v1');
    if (!backend?.available) throw new Error('Sandboxed command execution is unavailable on this host.');
  } finally {
    await sandbox.dispose();
  }
  const repository = await openSandboxExecutionRepository({
    directory: input.repositoryDirectory,
    maxRetainedOutputBytes: MAX_RETAINED_OUTPUT_BYTES
  });
  try {
    return await SandboxCommandExecution.create({
      repository,
      workspaceFileRoot: input.workspaceFileRoot,
      state: input.state,
      maxRetainedOutputBytes: MAX_RETAINED_OUTPUT_BYTES,
      createRun: (request, context) => commandRun(request, context.hostWorkspaceRoot),
      validatePrepared
    });
  } catch (error) {
    await repository.close().catch(() => undefined);
    throw error;
  }
}

function commandRun(request: PrepareCommandRequest, hostWorkspaceRoot: string): SandboxDetachedRunOptions {
  return {
    isolation: { kind: 'process' },
    policy: {
      filesystem: {
        runtime: { kind: 'system' },
        grants: [{
          hostPath: hostWorkspaceRoot,
          targetPath: TARGET_WORKSPACE,
          access: 'read-write',
          execution: 'allow',
          rootResolution: 'reject-if-link'
        }],
        privateHome: { enabled: true },
        temporary: { executable: false }
      },
      network: { mode: 'none' },
      process: { hostProcesses: 'deny', hostIpc: 'deny' }
    },
    requirements: LINUX_PROCESS_BASELINE_REQUIREMENTS,
    resources: {
      wallTimeMs: request.timeoutMs,
      memoryBytes: MAX_MEMORY_BYTES,
      maxProcesses: MAX_PROCESSES,
      maxOutputBytes: MAX_RETAINED_OUTPUT_BYTES,
      terminationGraceMs: 1_000
    },
    process: {
      executable: '/bin/sh',
      args: ['-c', request.command],
      cwd: targetDirectory(request.workspacePath),
      environment: {
        base: 'empty',
        set: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', CI: '1' }
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe'
    }
  };
}

function validatePrepared(prepared: SandboxPreparedCommand): void {
  const { summary, enforcement, request } = prepared;
  if (summary.isolation.kind !== 'process' || enforcement.boundary.kind !== 'os-process') throw new Error('Sandbox command preparation did not establish the required process boundary.');
  if (summary.network.mode !== 'none') throw new Error('Sandbox command preparation unexpectedly permits network access.');
  if (summary.filesystem.runtimeView !== 'system' || summary.filesystem.grants.length !== 1) throw new Error('Sandbox command preparation has an unexpected filesystem view.');
  const grant = summary.filesystem.grants[0];
  if (grant?.targetPath !== TARGET_WORKSPACE || grant.access !== 'read-write' || grant.execution !== 'allow') {
    throw new Error('Sandbox command preparation does not contain the required workspace grant.');
  }
  if (summary.execution.executable !== '/bin/sh'
    || summary.execution.args.length !== 2
    || summary.execution.args[0] !== '-c'
    || summary.execution.args[1] !== request.command
    || summary.execution.cwd !== targetDirectory(request.workspacePath)) {
    throw new Error('Sandbox command preparation does not match the requested command identity.');
  }
  if (summary.execution.sensitiveEnvironmentNames.length !== 0
    || summary.execution.environmentNames.length !== 2
    || !summary.execution.environmentNames.includes('PATH')
    || !summary.execution.environmentNames.includes('CI')) {
    throw new Error('Sandbox command preparation has an unexpected environment.');
  }
  for (const required of LINUX_PROCESS_BASELINE_REQUIREMENTS.required) {
    const fact = enforcement.guarantees.find((candidate) => candidate.id === required);
    if (fact?.status !== 'satisfied') throw new Error(`Sandbox command preparation did not satisfy required guarantee ${required}.`);
  }
}

function targetDirectory(workspacePath: string): string {
  if (workspacePath === '' || workspacePath === '.') return TARGET_WORKSPACE;
  const parts = workspacePath.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..' || part.includes('\\'))) {
    throw new Error(`Invalid command workspace path: ${workspacePath}`);
  }
  return path.posix.join(TARGET_WORKSPACE, ...parts);
}

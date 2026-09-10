import type { CommandExecutionPlanRequest } from '@agent-core/tools';
import type { RootedFileAuthority } from '@agent-core/tools-local';
import {
  createSandbox,
  openSandboxExecutionRepository,
  type SandboxDetachedRunOptions
} from '@ismail-elkorchi/sandbox';
import path from 'node:path';
import {
  codingToolchain,
  filesystemResource,
  isolatedPath,
  isolatedPolicy,
  WORKSPACE_ACCESS
} from './sandbox-policy.js';
import type { PrivateStateDirectory } from '../state/private-state.js';
import {
  SandboxCommandExecution,
  type SandboxCommandAuthorization
} from './sandbox-command-execution.js';

// System tools are mutable: observations may be reconciled only for their exact invocation.
export const CODING_COMMAND_ENVIRONMENT_POLICY_ID = 'coding-agent.sandbox-system-environment@1';

const TARGET_WORKSPACE = '/workspace';
const MAX_RETAINED_OUTPUT_BYTES = 8 * 1024 * 1024;

export class CodingCommandUnavailableError extends Error {}

export async function createCodingCommandAuthority(input: {
  readonly repositoryDirectory: string;
  readonly rootedFileAuthority: RootedFileAuthority;
  readonly state: PrivateStateDirectory;
}): Promise<SandboxCommandExecution> {
  const toolchain = await codingToolchain(process.execPath);
  const policy = isolatedPolicy(
    [
      ...toolchain.resources,
      filesystemResource(
        'workspace',
        input.rootedFileAuthority.identity.canonicalPath,
        TARGET_WORKSPACE,
        WORKSPACE_ACCESS
      )
    ],
    1_000
  );
  const sandbox = await createSandbox();
  try {
    const support = await sandbox.probe({ isolation: { kind: 'process' }, policy, requirements: {} });
    if (
      !support.implementations.some((implementation) => implementation.eligibility.state === 'eligible')
    ) {
      const reasons = support.implementations
        .filter(
          (implementation) =>
            implementation.boundary === 'os-process' && implementation.filesystem.includes('isolated')
        )
        .flatMap((implementation) => implementation.eligibility.unmet);
      throw new CodingCommandUnavailableError(
        `Sandbox command execution is unavailable: ${reasons.join('; ') || 'no eligible implementation for isolated process execution'}.`
      );
    }
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
      rootedFileAuthority: input.rootedFileAuthority,
      state: input.state,
      maxRetainedOutputBytes: MAX_RETAINED_OUTPUT_BYTES,
      createRun: (request) => commandRun(request, policy, toolchain.searchPath),
      validateAuthorization
    });
  } catch (error) {
    try {
      await repository.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Sandbox composition and release failed.', {
        cause: cleanupError
      });
    }
    throw error;
  }
}

function commandRun(
  request: CommandExecutionPlanRequest,
  policy: SandboxDetachedRunOptions['policy'],
  searchPath: string
): SandboxDetachedRunOptions {
  return {
    isolation: { kind: 'process' },
    policy,
    requirements: {},
    resources: {
      wallTime: { enforcement: 'hard', scope: 'process', value: request.timeoutMs },
      output: { enforcement: 'hard', scope: 'process', value: MAX_RETAINED_OUTPUT_BYTES }
    },
    process: {
      executable: isolatedPath('/bin/sh'),
      args: ['-c', request.command],
      cwd: isolatedPath(targetDirectory(request.rootedDirectory)),
      environment: {
        set: { PATH: searchPath, HOME: '/home/sandbox', TMPDIR: '/tmp', CI: '1' }
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe'
    }
  };
}

function validateAuthorization(authorization: SandboxCommandAuthorization): void {
  const { summary, enforcement, request } = authorization;
  if (summary.isolation.kind !== 'process' || enforcement.boundary.kind !== 'os-process')
    throw new Error('Sandbox command plan did not establish the required process boundary.');
  if (summary.network.mode !== 'none')
    throw new Error('Sandbox command plan unexpectedly permits network access.');
  const workspace = summary.filesystem.resources.find((resource) => resource.id === 'workspace');
  if (
    summary.filesystem.kind !== 'isolated' ||
    workspace?.target.space !== 'isolated' ||
    workspace.target.path !== TARGET_WORKSPACE ||
    workspace.access.content !== 'read-write' ||
    workspace.access.directoryEntries !== 'read-write' ||
    workspace.access.metadata !== 'read-write' ||
    workspace.access.execution !== 'allow'
  ) {
    throw new Error('Sandbox command plan does not contain the required workspace resource.');
  }
  if (
    summary.execution.executable.space !== 'isolated' ||
    summary.execution.executable.path !== '/bin/sh' ||
    summary.execution.args.length !== 2 ||
    summary.execution.args[0] !== '-c' ||
    summary.execution.args[1] !== request.command ||
    summary.execution.cwd.space !== 'isolated' ||
    summary.execution.cwd.path !== targetDirectory(request.rootedDirectory)
  ) {
    throw new Error('Sandbox command plan does not match the requested command identity.');
  }
  if (
    summary.execution.sensitiveEnvironmentNames.length !== 0 ||
    summary.execution.environmentNames.length !== 4 ||
    !['PATH', 'HOME', 'TMPDIR', 'CI'].every((name) => summary.execution.environmentNames.includes(name))
  ) {
    throw new Error('Sandbox command plan has an unexpected environment.');
  }
}

function targetDirectory(rootedDirectory: string): string {
  if (rootedDirectory === '' || rootedDirectory === '.') return TARGET_WORKSPACE;
  const parts = rootedDirectory.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..' || part.includes('\\'))) {
    throw new Error(`Invalid command rooted directory: ${rootedDirectory}`);
  }
  return path.posix.join(TARGET_WORKSPACE, ...parts);
}

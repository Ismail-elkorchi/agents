import {
  ResourceLeaseCoordinator,
  adoptCommandExecution,
  type CommandExecution,
  type CommandExecutionDescriptor,
  type CommandExecutionOwner,
  type CommandExecutionPlanRequest,
  type CommandExecutionReport,
  type CommandExecutionReservation,
  type CommandExecutionResult,
  type CommandReconciliationResult,
  type StartCommandExecutionOptions
} from '@agent-core/tools';
import type { RootedFileAuthority } from '@agent-core/tools-local';
import {
  createSandbox,
  openSandboxExecutionRepository,
  SandboxRequirementError,
  SandboxUnsupportedError,
  type SandboxDetachedRunOptions,
  type SandboxPath,
  type SandboxPolicy
} from '@ismail-elkorchi/sandbox';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PrivateStateDirectory } from '../state/private-state.js';
import {
  discoverCodingCommandEnvironment,
  hostPath,
  hostPolicy,
  hostResource,
  hostRuntimeRoots,
  isolatedPath,
  isolatedPolicy,
  isolatedResource,
  runtimeAccess,
  runtimePurposes,
  WORKSPACE_ACCESS,
  type CodingCommandEnvironment
} from './sandbox-policy.js';
import {
  SandboxCommandExecution,
  type SandboxCommandAuthorization
} from './sandbox-command-execution.js';

export const CODING_COMMAND_ENVIRONMENT_POLICY_ID = 'coding-agent.observed-command-environment@1';

const MAX_RETAINED_OUTPUT_BYTES = 8 * 1024 * 1024;
const TERMINATION_GRACE_MS = 1_000;

export class CodingCommandUnavailableError extends Error {}

export function createCodingCommandAuthority(input: {
  readonly repositoryDirectory: string;
  readonly rootedFileAuthority: RootedFileAuthority;
  readonly state: PrivateStateDirectory;
}): CommandExecution {
  return new LazySandboxCommandExecution(input);
}

type CodingCommandAuthorityInput = Parameters<typeof createCodingCommandAuthority>[0];

interface CodingSandboxProfile {
  readonly kind: 'isolated' | 'host';
  readonly label: 'isolated workspace' | 'workspace confined';
  readonly policy: SandboxPolicy;
  readonly shell: SandboxPath;
  readonly workspacePath: string;
  readonly environment: Readonly<Record<string, string>>;
}

class LazySandboxCommandExecution implements CommandExecution {
  readonly descriptor: CommandExecutionDescriptor;
  readonly resourceLeases = new ResourceLeaseCoordinator();
  #execution: SandboxCommandExecution | undefined;
  #opening: Promise<SandboxCommandExecution> | undefined;
  #closed = false;

  constructor(private readonly input: CodingCommandAuthorityInput) {
    this.descriptor = Object.freeze({
      implementationId: 'coding-agent.sandbox-command-execution@1',
      recoveryIdentity: `coding-agent-command:${createHash('sha256')
        .update(path.resolve(input.repositoryDirectory))
        .update('\0')
        .update(input.rootedFileAuthority.identity.canonicalPath)
        .digest('hex')}`,
      capabilities: Object.freeze([
        'sandbox-process',
        'caller-process-recovery',
        'staged-authorization'
      ]),
      supportsPty: false
    });
    adoptCommandExecution(this);
  }

  async plan(request: CommandExecutionPlanRequest): Promise<CommandExecutionReservation> {
    return (await this.open()).plan(request);
  }

  async start(
    plan: CommandExecutionReservation,
    options?: StartCommandExecutionOptions
  ): Promise<CommandExecutionResult> {
    return (await this.open()).start(plan, options);
  }

  async query(
    processId: string,
    outputTokenBudget: number,
    yieldMs?: number,
    afterCursor?: number,
    requester?: CommandExecutionOwner
  ): Promise<CommandExecutionResult> {
    return (await this.open()).query(processId, outputTokenBudget, yieldMs, afterCursor, requester);
  }

  async writeInput(processId: string, text: string, requester?: CommandExecutionOwner): Promise<void> {
    await (await this.open()).writeInput(processId, text, requester);
  }

  async closeInput(processId: string, requester?: CommandExecutionOwner): Promise<void> {
    await (await this.open()).closeInput(processId, requester);
  }

  async terminate(
    processId: string,
    requester?: CommandExecutionOwner
  ): Promise<CommandExecutionResult> {
    return (await this.open()).terminate(processId, requester);
  }

  async disposeOwner(ownerId: string): Promise<readonly CommandExecutionReport[]> {
    const execution = await this.openExisting();
    return execution ? execution.disposeOwner(ownerId) : Object.freeze([]);
  }

  recoveredTerminalReports(): readonly CommandExecutionReport[] {
    return this.#execution?.recoveredTerminalReports() ?? Object.freeze([]);
  }

  async acknowledgeTerminalReport(processId: string): Promise<void> {
    const execution = await this.openExisting();
    if (execution) await execution.acknowledgeTerminalReport(processId);
  }

  async reconcile(): Promise<CommandReconciliationResult> {
    const execution = await this.openExisting();
    return execution ? execution.reconcile() : emptyReconciliation();
  }

  async retryReconciliation(): Promise<CommandReconciliationResult> {
    const execution = await this.openExisting();
    return execution ? execution.retryReconciliation() : emptyReconciliation();
  }

  async acknowledgeUnresolved(processIds: readonly string[]): Promise<void> {
    const execution = await this.openExisting();
    if (execution) await execution.acknowledgeUnresolved(processIds);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const execution = this.#execution ?? (await this.#opening);
    if (execution) await execution.close();
  }

  private async openExisting(): Promise<SandboxCommandExecution | undefined> {
    if (this.#execution) return this.#execution;
    if (this.#opening) return this.#opening;
    try {
      await fs.stat(this.input.repositoryDirectory);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
    return this.open();
  }

  private open(): Promise<SandboxCommandExecution> {
    if (this.#closed) return Promise.reject(new Error('Command execution is closed.'));
    this.#opening ??= openCodingCommandAuthority(this.input, this.descriptor, this.resourceLeases).then((execution) => {
      this.#execution = execution;
      return execution;
    });
    return this.#opening;
  }
}

function emptyReconciliation(): CommandReconciliationResult {
  return Object.freeze({ resolved: Object.freeze([]), unresolved: Object.freeze([]) });
}

async function openCodingCommandAuthority(
  input: CodingCommandAuthorityInput,
  descriptor: CommandExecutionDescriptor,
  resourceLeases: ResourceLeaseCoordinator
): Promise<SandboxCommandExecution> {
  const environment = await discoverCodingCommandEnvironment();
  const profile = await selectSandboxProfile(
    input.rootedFileAuthority.identity.canonicalPath,
    environment
  );
  const repository = await openSandboxExecutionRepository({
    directory: input.repositoryDirectory,
    maxRetainedOutputBytes: MAX_RETAINED_OUTPUT_BYTES
  });
  try {
    return await SandboxCommandExecution.create({
      descriptor,
      resourceLeases,
      repository,
      rootedFileAuthority: input.rootedFileAuthority,
      state: input.state,
      maxRetainedOutputBytes: MAX_RETAINED_OUTPUT_BYTES,
      createRun: (request) => commandRun(request, profile, environment),
      validateAuthorization: (authorization) => {
        validateAuthorization(authorization, profile, environment);
      }
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

async function selectSandboxProfile(
  workspaceRoot: string,
  environment: CodingCommandEnvironment
): Promise<CodingSandboxProfile> {
  const candidates = [
    ...(process.platform === 'linux'
      ? [isolatedProfile(workspaceRoot, environment)]
      : []),
    hostProfile(workspaceRoot, environment)
  ];
  const unavailable: string[] = [];
  const sandbox = await createSandbox();
  try {
    for (const candidate of candidates) {
      try {
        const qualification = await sandbox.prepareRun(
          commandRun(qualificationRequest(), candidate, environment)
        );
        await qualification.cancel();
        return candidate;
      } catch (error) {
        if (!(error instanceof SandboxUnsupportedError || error instanceof SandboxRequirementError))
          throw error;
        unavailable.push(`${candidate.label}: ${error.data.message}`);
      }
    }
  } finally {
    await sandbox.dispose();
  }
  throw new CodingCommandUnavailableError(
    `Sandbox command execution is unavailable. ${unavailable.join(' ') || 'No native process implementation satisfies the workspace policy.'}`
  );
}

function isolatedProfile(
  workspaceRoot: string,
  environment: CodingCommandEnvironment
): CodingSandboxProfile {
  const identity = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16);
  const home = `/home/sandbox-${identity}`;
  const temporary = `/tmp/sandbox-${identity}`;
  const resources = [
    ...environment.runtimeRoots.map((root, index) =>
      isolatedResource(
        `runtime-${String(index)}`,
        root.sourcePath,
        root.targetPath,
        runtimeAccess(root),
        runtimePurposes(root)
      )
    ),
    isolatedResource(
      'workspace',
      workspaceRoot,
      workspaceRoot,
      WORKSPACE_ACCESS,
      ['data'],
      'reject-if-link'
    )
  ];
  return Object.freeze({
    kind: 'isolated',
    label: 'isolated workspace',
    policy: isolatedPolicy({ resources, home, temporary, graceMs: TERMINATION_GRACE_MS }),
    shell: isolatedPath(environment.shellPath),
    workspacePath: workspaceRoot,
    environment: Object.freeze({
      [environment.searchPathName]: environment.searchPath,
      HOME: home,
      TMPDIR: temporary
    })
  });
}

function hostProfile(
  workspaceRoot: string,
  environment: CodingCommandEnvironment
): CodingSandboxProfile {
  const resources = [
    ...hostRuntimeRoots(environment.runtimeRoots).map((root, index) =>
      hostResource(
        `runtime-${String(index)}`,
        root.sourcePath,
        runtimeAccess(root),
        runtimePurposes(root)
      )
    ),
    hostResource('workspace', workspaceRoot, WORKSPACE_ACCESS, ['data'], 'reject-if-link')
  ];
  return Object.freeze({
    kind: 'host',
    label: 'workspace confined',
    policy: hostPolicy(resources, TERMINATION_GRACE_MS),
    shell: hostPath(environment.shellPath),
    workspacePath: workspaceRoot,
    environment: Object.freeze({ [environment.searchPathName]: environment.searchPath })
  });
}

function qualificationRequest(): CommandExecutionPlanRequest {
  return Object.freeze({
    command: process.platform === 'win32' ? 'exit /b 0' : ':',
    rootedDirectory: '.',
    pty: false,
    timeoutMs: 10_000,
    yieldMs: 0,
    outputTokenBudget: 0,
    owner: Object.freeze({
      ownerId: 'sandbox-qualification',
      runId: 'sandbox-qualification',
      turnId: 'sandbox-qualification',
      toolBatchId: 'sandbox-qualification',
      callIndex: 0
    })
  });
}

function commandRun(
  request: CommandExecutionPlanRequest,
  profile: CodingSandboxProfile,
  environment: CodingCommandEnvironment
): SandboxDetachedRunOptions {
  const cwd = rootedDirectory(profile.workspacePath, request.rootedDirectory);
  return {
    isolation: { kind: 'process' },
    policy: profile.policy,
    requirements: {},
    resources: {
      wallTime: { enforcement: 'hard', scope: 'process', value: request.timeoutMs },
      output: { enforcement: 'hard', scope: 'process', value: MAX_RETAINED_OUTPUT_BYTES }
    },
    process: {
      executable: profile.shell,
      args: environment.commandArguments(request.command),
      cwd: profile.kind === 'isolated' ? isolatedPath(cwd) : hostPath(cwd),
      environment: { set: profile.environment },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe'
    }
  };
}

function validateAuthorization(
  authorization: SandboxCommandAuthorization,
  profile: CodingSandboxProfile,
  environment: CodingCommandEnvironment
): void {
  const { summary, enforcement, request } = authorization;
  if (summary.isolation.kind !== 'process' || enforcement.boundary.kind !== 'os-process')
    throw new Error('Sandbox command plan did not establish the required process boundary.');
  if (summary.implementation.stability !== 'stable')
    throw new Error('Sandbox command plan selected an implementation without stable conformance.');
  if (summary.network.mode !== 'none')
    throw new Error('Sandbox command plan unexpectedly permits network access.');
  if (summary.filesystem.kind !== profile.kind || enforcement.filesystem.kind !== profile.kind)
    throw new Error('Sandbox command plan changed the selected filesystem layout.');
  const workspace = summary.filesystem.resources.find((resource) => resource.id === 'workspace');
  if (
    workspace?.target.space !== profile.kind ||
    workspace.target.path !== profile.workspacePath ||
    workspace.access.content !== 'read-write' ||
    workspace.access.directoryEntries !== 'read-write' ||
    workspace.access.metadata !== 'read-write' ||
    workspace.access.execution !== 'allow'
  ) {
    throw new Error('Sandbox command plan does not contain the adopted workspace authority.');
  }
  const expectedArguments = environment.commandArguments(request.command);
  const expectedDirectory = rootedDirectory(profile.workspacePath, request.rootedDirectory);
  if (
    summary.execution.executable.space !== profile.kind ||
    summary.execution.executable.path !== profile.shell.path ||
    summary.execution.args.length !== expectedArguments.length ||
    summary.execution.args.some((argument, index) => argument !== expectedArguments[index]) ||
    summary.execution.cwd.space !== profile.kind ||
    summary.execution.cwd.path !== expectedDirectory
  ) {
    throw new Error('Sandbox command plan does not match the requested command identity.');
  }
  const expectedEnvironment = expectedEnvironmentNames(profile);
  const observedEnvironment = [...summary.execution.environmentNames].sort();
  if (
    summary.execution.sensitiveEnvironmentNames.length !== 0 ||
    expectedEnvironment.length !== observedEnvironment.length ||
    expectedEnvironment.some((name, index) => name !== observedEnvironment[index])
  ) {
    throw new Error('Sandbox command plan has an unexpected environment.');
  }
}

function expectedEnvironmentNames(profile: CodingSandboxProfile): readonly string[] {
  const names = new Set(Object.keys(profile.environment));
  if (profile.kind === 'host' && process.platform !== 'linux') {
    names.add('HOME');
    if (process.platform === 'darwin') names.add('TMPDIR');
    else for (const name of ['LOCALAPPDATA', 'TEMP', 'TMP', 'SystemRoot']) names.add(name);
  }
  return [...names].sort();
}

function rootedDirectory(workspaceRoot: string, rooted: string): string {
  if (rooted === '' || rooted === '.') return workspaceRoot;
  const parts = rooted.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..' || part.includes('\\')))
    throw new Error(`Invalid command rooted directory: ${rooted}`);
  const resolved = path.join(workspaceRoot, ...parts);
  const relative = path.relative(workspaceRoot, resolved);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`))
    throw new Error(`Command rooted directory escapes the workspace: ${rooted}`);
  return resolved;
}

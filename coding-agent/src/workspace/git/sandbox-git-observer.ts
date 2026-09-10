import type {
  SandboxDetachedRunOptions,
  SandboxExecutionObservation,
  SandboxExecutionRepository
} from '@ismail-elkorchi/sandbox';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  filesystemResource,
  isolatedPath,
  isolatedPolicy,
  READ_ONLY_ACCESS,
  systemRuntimeResources
} from '../../execution/sandbox-policy.js';
import type {
  GitObservationReceipt,
  GitRepositoryLocation,
  GitRepositoryObservation,
  GitRepositoryObserver,
  GitStatusEntry
} from './repository-observer.js';

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_STATUS_ENTRIES = 2_000;
const STATUS_TIMEOUT_MS = 15_000;

export interface SandboxGitRepositoryObserverOptions {
  readonly repository: SandboxExecutionRepository;
  readonly gitExecutable: string;
}

/** Executes one bounded, non-interactive Git status observation inside Sandbox. */
export class SandboxGitRepositoryObserver implements GitRepositoryObserver {
  readonly #repository: SandboxExecutionRepository;
  readonly #gitExecutable: string;
  #closed = false;

  constructor(options: SandboxGitRepositoryObserverOptions) {
    if (!path.isAbsolute(options.gitExecutable))
      throw new TypeError('Sandboxed Git observation requires an absolute executable path.');
    this.#repository = options.repository;
    this.#gitExecutable = path.normalize(options.gitExecutable);
  }

  async observe(
    location: GitRepositoryLocation,
    signal?: AbortSignal
  ): Promise<GitRepositoryObservation> {
    if (this.#closed) throw new Error('Sandboxed Git observer is closed.');
    if (signal?.aborted) throw abortError(signal);
    const executionId = `git-status-${randomUUID()}`;
    const run = await gitStatusRun(this.#gitExecutable, location);
    let authorizationObservation: SandboxExecutionObservation;
    try {
      // `prepare` and the matching state tags are names fixed by the upstream sandbox protocol.
      authorizationObservation = await this.#repository.prepare(
        { executionId, run },
        { maxBytes: MAX_OUTPUT_BYTES, waitMs: STATUS_TIMEOUT_MS }
      );
    } catch {
      return Object.freeze({ kind: 'unavailable', reason: 'sandbox_unavailable', executionId });
    }
    if (authorizationObservation.kind === 'rejected')
      return Object.freeze({ kind: 'unavailable', reason: 'execution_rejected', executionId });
    if (authorizationObservation.kind === 'unknown' || authorizationObservation.kind === 'preparing')
      return Object.freeze({ kind: 'unavailable', reason: 'execution_unknown', executionId });
    if (authorizationObservation.kind === 'expired')
      return Object.freeze({ kind: 'unavailable', reason: 'execution_expired', executionId });
    if (authorizationObservation.kind !== 'prepared')
      return Object.freeze({ kind: 'unavailable', reason: 'status_failed', executionId });
    const receipt: GitObservationReceipt = Object.freeze({
      executionId,
      requestDigest: authorizationObservation.requestDigest,
      policyDigest: authorizationObservation.policyDigest,
      executionDigest: authorizationObservation.executionDigest,
      implementation: authorizationObservation.summary.implementation.id,
      implementationVersion: authorizationObservation.summary.implementation.version,
      executableIdentityDigest: authorizationObservation.summary.execution.executableIdentityDigest,
      executableContentSha256: authorizationObservation.summary.execution.executableContentSha256
    });
    const terminateOnAbort = () => {
      void this.#repository.terminate(executionId).catch(() => undefined);
    };
    signal?.addEventListener('abort', terminateOnAbort, { once: true });
    try {
      await this.#repository.activate(executionId, authorizationObservation);
      const observation = await waitForTerminal(this.#repository, executionId);
      if (observation.kind === 'unknown')
        return Object.freeze({ kind: 'unavailable', reason: 'execution_unknown', executionId });
      if (observation.kind === 'expired')
        return Object.freeze({ kind: 'unavailable', reason: 'execution_expired', executionId });
      if (
        observation.kind !== 'settled' ||
        observation.result.termination.reason !== 'exit' ||
        observation.result.termination.code !== 0
      ) {
        return Object.freeze({ kind: 'unavailable', reason: 'status_failed', executionId });
      }
      try {
        return parseGitStatus(observation, receipt);
      } catch {
        return Object.freeze({ kind: 'unavailable', reason: 'output_invalid', executionId });
      }
    } finally {
      signal?.removeEventListener('abort', terminateOnAbort);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#repository.close();
  }
}

async function gitStatusRun(
  gitExecutable: string,
  location: GitRepositoryLocation
): Promise<SandboxDetachedRunOptions> {
  const workspace = path.resolve(location.workspaceRoot);
  const gitDirectory = path.resolve(location.gitDirectory);
  const commonDirectory = path.resolve(location.commonDirectory ?? gitDirectory);
  const resources = [
    ...(await systemRuntimeResources()),
    filesystemResource('workspace', workspace, '/workspace', READ_ONLY_ACCESS)
  ];
  let sandboxGitDirectory = mappedChild(workspace, gitDirectory, '/workspace');
  let sandboxCommonDirectory = mappedChild(workspace, commonDirectory, '/workspace');
  if (!sandboxCommonDirectory) {
    resources.push(filesystemResource('git-common', commonDirectory, '/git-common', READ_ONLY_ACCESS));
    sandboxCommonDirectory = '/git-common';
    sandboxGitDirectory = mappedChild(commonDirectory, gitDirectory, '/git-common');
  }
  if (!sandboxGitDirectory) {
    resources.push(filesystemResource('git-directory', gitDirectory, '/git-directory', READ_ONLY_ACCESS));
    sandboxGitDirectory = '/git-directory';
  }
  const environment: Record<string, string> = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_EDITOR: 'false',
    GIT_SEQUENCE_EDITOR: 'false',
    GIT_ASKPASS: 'false',
    SSH_ASKPASS: 'false',
    GIT_DIR: sandboxGitDirectory,
    GIT_COMMON_DIR: sandboxCommonDirectory,
    GIT_WORK_TREE: '/workspace'
  };
  return {
    isolation: { kind: 'process' },
    policy: isolatedPolicy(resources, 500),
    requirements: {},
    resources: {
      wallTime: { enforcement: 'hard', scope: 'process', value: STATUS_TIMEOUT_MS },
      output: { enforcement: 'hard', scope: 'process', value: MAX_OUTPUT_BYTES }
    },
    process: {
      executable: isolatedPath(gitExecutable),
      args: [
        '--no-pager',
        '--no-optional-locks',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.untrackedCache=false',
        '-c',
        'core.attributesFile=/dev/null',
        '-c',
        'gc.auto=0',
        '-c',
        'maintenance.auto=false',
        'status',
        '--porcelain=v2',
        '--branch',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none'
      ],
      cwd: isolatedPath('/workspace'),
      environment: { set: environment },
      stdin: 'closed',
      stdout: 'pipe',
      stderr: 'pipe'
    }
  };
}

function mappedChild(parent: string, child: string, target: string): string | undefined {
  const relative = path.relative(parent, child);
  if (relative === '') return target;
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative))
    return undefined;
  return path.posix.join(target, ...relative.split(path.sep));
}

async function waitForTerminal(
  repository: SandboxExecutionRepository,
  executionId: string
): Promise<SandboxExecutionObservation> {
  const deadline = Date.now() + STATUS_TIMEOUT_MS + 2_000;
  let observation = await repository.inspect(executionId, { maxBytes: MAX_OUTPUT_BYTES, waitMs: 100 });
  while (
    observation.kind !== 'settled' &&
    observation.kind !== 'rejected' &&
    observation.kind !== 'unknown' &&
    observation.kind !== 'expired' &&
    Date.now() < deadline
  ) {
    observation = await repository.inspect(executionId, {
      maxBytes: MAX_OUTPUT_BYTES,
      waitMs: Math.min(100, deadline - Date.now())
    });
  }
  if (
    observation.kind === 'preparing' ||
    observation.kind === 'prepared' ||
    observation.kind === 'running'
  ) {
    await repository.terminate(executionId).catch(() => undefined);
    return Object.freeze({
      kind: 'unknown',
      executionId,
      reason: 'execution-host-unreachable',
      diagnostic: 'Sandboxed Git observation did not settle before its deadline.',
      output: observation.output
    });
  }
  return observation;
}

function parseGitStatus(
  observation: Extract<SandboxExecutionObservation, { kind: 'settled' }>,
  receipt: GitObservationReceipt
): GitRepositoryObservation {
  if (
    observation.output.cursorExpired ||
    observation.output.cursorStart !== 0 ||
    observation.output.availableCursorEnd !== observation.output.cursorEnd
  )
    throw new Error('Git status output is incomplete.');
  const bytes = Buffer.concat(
    observation.output.chunks.filter((chunk) => chunk.stream === 'stdout').map((chunk) => chunk.data)
  );
  const records = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\0');
  if (records.at(-1) === '') records.pop();
  let branch: string | undefined;
  let head: string | undefined;
  const entries: GitStatusEntry[] = [];
  let totalEntries = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? '';
    if (record.startsWith('# branch.oid ')) {
      const value = record.slice(13);
      if (value !== '(initial)') head = value;
      continue;
    }
    if (record.startsWith('# branch.head ')) {
      const value = record.slice(14);
      if (value !== '(detached)') branch = value;
      continue;
    }
    if (record.startsWith('# ')) continue;
    const parsed = parseEntry(record);
    if (!parsed) throw new Error('Unknown Git porcelain record.');
    totalEntries += 1;
    if (entries.length < MAX_STATUS_ENTRIES) entries.push(parsed);
    if (record.startsWith('2 ')) index += 1;
  }
  const omittedEntries = totalEntries - entries.length;
  return Object.freeze({
    kind: 'observed',
    ...(branch ? { branch } : {}),
    ...(head ? { head } : {}),
    entries: Object.freeze(entries),
    totalEntries,
    omittedEntries,
    coverage: omittedEntries === 0 ? 'complete' : 'partial',
    receipt
  });
}

function parseEntry(record: string): GitStatusEntry | undefined {
  if (record.startsWith('? ')) return Object.freeze({ path: record.slice(2), state: 'untracked' });
  if (record.startsWith('! ')) return undefined;
  const kind = record[0];
  const fieldCount = kind === '1' ? 8 : kind === '2' ? 9 : kind === 'u' ? 10 : 0;
  if (fieldCount === 0) return undefined;
  let separator = -1;
  for (let field = 0; field < fieldCount; field += 1) {
    separator = record.indexOf(' ', separator + 1);
    if (separator < 0) return undefined;
  }
  const state = record.slice(2, 4);
  const entryPath = record.slice(separator + 1);
  return entryPath.length === 0 ? undefined : Object.freeze({ path: entryPath, state });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(typeof signal.reason === 'string' ? signal.reason : 'Git observation was aborted.');
}

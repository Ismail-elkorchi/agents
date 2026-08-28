import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import {
  ResourceLeaseCoordinator,
  adoptCommandExecution,
  createCommandExecutionPreparation,
  type CommandExecution,
  type CommandExecutionDescriptor,
  type CommandExecutionOwner,
  type CommandExecutionPreparation,
  type CommandExecutionReport,
  type CommandExecutionResult,
  type CommandExecutionStatus,
  type CommandOutputView,
  type CommandReconciliationResult,
  type PrepareCommandRequest,
  type StartPreparedCommandOptions
} from '@agent-core/tools';
import type { WorkspaceFileRoot } from '@agent-core/tools-local';
import { parseJsonObject, type JsonObject } from '@agent-core/json';
import type {
  SandboxDetachedRunOptions,
  SandboxExecutionObservation,
  SandboxExecutionRepository
} from '@ismail-elkorchi/sandbox';
import { PrivateStateDirectory } from '../state/private-state.js';

const PROCESS_OBSERVATION_TIMEOUT_MS = 30_000;

export interface SandboxCommandPlanContext {
  readonly hostWorkspaceRoot: string;
  readonly workspacePath: string;
}

export interface SandboxPreparedCommand {
  readonly request: PrepareCommandRequest;
  readonly executionId: string;
  readonly requestDigest: string;
  readonly policyDigest: string;
  readonly executionDigest: string;
  readonly summary: Extract<SandboxExecutionObservation, { kind: 'prepared' }>['summary'];
  readonly enforcement: Extract<SandboxExecutionObservation, { kind: 'prepared' }>['enforcement'];
  readonly expiresAtMs: number;
}

export type SandboxCommandRecovery =
  | Readonly<{ readonly status: 'running' }>
  | Readonly<{ readonly status: 'settled'; readonly result: CommandExecutionResult }>
  | Readonly<{ readonly status: 'unknown' | 'expired' }>;

export interface SandboxCommandExecutionOptions {
  readonly repository: SandboxExecutionRepository;
  readonly workspaceFileRoot: WorkspaceFileRoot;
  readonly state: PrivateStateDirectory;
  readonly createRun: (
    request: PrepareCommandRequest,
    context: SandboxCommandPlanContext
  ) => SandboxDetachedRunOptions | Promise<SandboxDetachedRunOptions>;
  readonly validatePrepared: (prepared: SandboxPreparedCommand) => void | Promise<void>;
  readonly maxRetainedOutputBytes: number;
}

interface StoredOwner {
  readonly schemaVersion: 1;
  readonly processId: string;
  readonly owner: CommandExecutionOwner;
  readonly requestDigest?: string;
  readonly authorization?: JsonObject;
}

class SandboxCommandPreparation {
  #state: 'prepared' | 'started' | 'activated' | 'released' = 'prepared';

  constructor(
    readonly authority: SandboxCommandExecution,
    readonly request: PrepareCommandRequest,
    readonly observation: SandboxExecutionObservation,
    private readonly releaseAuthority: () => Promise<void>
  ) {
  }

  start() {
    if (this.#state !== 'prepared') throw new Error('Sandbox command preparation is single-use.');
    this.#state = 'started';
    return { request: this.request, observation: this.observation };
  }

  markActivated(): void {
    if (this.#state !== 'started') throw new Error('Sandbox command preparation was not started.');
    this.#state = 'activated';
  }

  async release(): Promise<void> {
    if (this.#state === 'released' || this.#state === 'activated') return;
    this.#state = 'released';
    await this.releaseAuthority();
  }
}

/** Coding Agent's fail-closed adapter from Agent Core command behavior to Sandbox execution. */
export class SandboxCommandExecution implements CommandExecution {
  readonly descriptor: CommandExecutionDescriptor;
  readonly resourceLeases = new ResourceLeaseCoordinator();
  readonly #recovered = new Map<string, CommandExecutionReport>();
  readonly #unresolved = new Map<string, { workspace: string; diagnostic: string }>();
  readonly #abortListeners = new Map<string, { signal: AbortSignal; listener: () => void }>();
  readonly #preparations = new WeakMap<CommandExecutionPreparation, SandboxCommandPreparation>();
  #closed = false;

  private constructor(private readonly options: SandboxCommandExecutionOptions) {
    this.descriptor = Object.freeze({
      implementationId: 'coding-agent.sandbox-command-execution@1',
      recoveryIdentity: `${options.repository.identity}:${createHash('sha256').update(options.workspaceFileRoot.identity.canonicalPath).digest('hex')}`,
      capabilities: Object.freeze(['sandbox-process', 'caller-process-recovery', 'prepared-authorization']),
      supportsPty: false
    });
    adoptCommandExecution(this);
  }

  static async create(options: SandboxCommandExecutionOptions): Promise<SandboxCommandExecution> {
    if (!Number.isSafeInteger(options.maxRetainedOutputBytes) || options.maxRetainedOutputBytes < 1) throw new TypeError('maxRetainedOutputBytes must be positive.');
    const execution = new SandboxCommandExecution(options);
    await execution.reconcile();
    return execution;
  }

  async prepare(request: PrepareCommandRequest): Promise<CommandExecutionPreparation> {
    this.#ensureOpen();
    if (this.#unresolved.size > 0) throw new Error('Unresolved sandbox executions block new command starts for this workspace.');
    if (request.pty) throw new Error('The configured sandbox command execution does not support PTY mode.');
    validateOwner(request.owner);
    const processId = processIdentity(request.owner, this.descriptor.recoveryIdentity);
    await this.#bindOwner({ schemaVersion: 1, processId, owner: ownOwner(request.owner) });
    const run = await this.options.createRun(request, {
      hostWorkspaceRoot: this.options.workspaceFileRoot.identity.canonicalPath,
      workspacePath: request.workspacePath
    });
    validateWorkspaceGrant(run, this.options.workspaceFileRoot.identity.canonicalPath);
    const prepared = await this.options.repository.prepare({ executionId: processId, run }, {
      maxBytes: this.options.maxRetainedOutputBytes,
      waitMs: Math.max(1, Math.min(request.timeoutMs, 30_000))
    });
    if (prepared.kind === 'rejected') {
      await this.#bindOwner({ schemaVersion: 1, processId, owner: ownOwner(request.owner), requestDigest: prepared.requestDigest });
      throw new Error(`Sandbox rejected command preparation: ${prepared.error.message}`);
    }
    if (prepared.requestDigest === undefined) throw new Error(`Sandbox execution ${processId} has no request binding.`);
    const authorization = prepared.kind === 'prepared'
      ? sandboxCommandAuthorization(this.descriptor, prepared)
      : (await this.#storedOwner(processId)).authorization;
    if (!authorization) throw new Error(`Sandbox execution ${processId} has no durable authorization evidence.`);
    await this.#bindOwner({ schemaVersion: 1, processId, owner: ownOwner(request.owner), requestDigest: prepared.requestDigest, authorization });
    if (prepared.kind === 'prepared') {
      try {
        await this.options.validatePrepared(Object.freeze({
          request,
          executionId: processId,
          requestDigest: prepared.requestDigest,
          policyDigest: prepared.policyDigest,
          executionDigest: prepared.executionDigest,
          summary: prepared.summary,
          enforcement: prepared.enforcement,
          expiresAtMs: prepared.expiresAtMs
        }));
      } catch (error) {
        await this.options.repository.terminate(processId).catch(() => undefined);
        await this.options.repository.forget(processId).catch(() => undefined);
        throw error;
      }
    }
    const owned = new SandboxCommandPreparation(this, request, prepared, async () => {
      if (prepared.kind !== 'prepared') return;
      await this.options.repository.terminate(prepared.executionId);
      await this.options.repository.forget(prepared.executionId);
      await this.options.state.delete(ownerPath(prepared.executionId));
    });
    const preparation = createCommandExecutionPreparation(authorization, () => owned.release());
    this.#preparations.set(preparation, owned);
    return preparation;
  }

  async start(preparation: CommandExecutionPreparation, options: StartPreparedCommandOptions = {}): Promise<CommandExecutionResult> {
    this.#ensureOpen();
    const owned = this.#preparations.get(preparation);
    if (owned?.authority !== this) {
      throw new TypeError('Command preparation does not belong to this sandbox authority.');
    }
    const { request, observation: prepared } = owned.start();
    const processId = prepared.executionId;
    if (options.signal?.aborted) {
      await owned.release();
      throw abortError(options.signal);
    }
    this.#bindAbort(processId, options.signal);
    if (prepared.kind === 'prepared') {
      await this.options.repository.activate(processId, prepared);
      owned.markActivated();
    }
    let observation = prepared.kind === 'prepared'
      ? await this.#waitForProcessObservation(processId, PROCESS_OBSERVATION_TIMEOUT_MS)
      : prepared;
    if (observation.kind === 'running' && request.yieldMs > 0) {
      observation = await this.options.repository.inspect(processId, {
        maxBytes: this.options.maxRetainedOutputBytes,
        waitMs: request.yieldMs
      });
    }
    const result = this.#result(observation, request.owner, request.outputTokenBudget, 0);
    if (result.status === 'running' && options.lease) options.lease.transferToProcess(processId, `workspace/processes/${processId}`);
    await this.#emitOutput(options.onProgress, observation);
    this.#releaseIfTerminal(result);
    return result;
  }

  async query(processId: string, outputTokenBudget: number, yieldMs = 0, afterCursor = 0, requester?: CommandExecutionOwner): Promise<CommandExecutionResult> {
    this.#ensureOpen();
    const owner = await this.#owner(processId);
    assertRequester(owner, requester, processId);
    const observation = await this.options.repository.inspect(processId, {
      afterCursor,
      maxBytes: this.options.maxRetainedOutputBytes,
      waitMs: yieldMs
    });
    const result = this.#result(observation, owner, outputTokenBudget, afterCursor);
    this.#releaseIfTerminal(result);
    return result;
  }

  async writeInput(processId: string, text: string, requester?: CommandExecutionOwner): Promise<void> {
    const owner = await this.#owner(processId);
    assertRequester(owner, requester, processId);
    await this.options.repository.writeInput(processId, Buffer.from(text, 'utf8'));
  }

  async closeInput(processId: string, requester?: CommandExecutionOwner): Promise<void> {
    const owner = await this.#owner(processId);
    assertRequester(owner, requester, processId);
    await this.options.repository.closeInput(processId);
  }

  async terminate(processId: string, requester?: CommandExecutionOwner): Promise<CommandExecutionResult> {
    const owner = await this.#owner(processId);
    assertRequester(owner, requester, processId);
    await this.options.repository.terminate(processId);
    const observation = await this.#waitForTerminalObservation(processId, 15_000);
    const result = this.#result(observation, owner, 4_000, 0);
    this.#releaseIfTerminal(result);
    return result;
  }

  async disposeRun(runId: string): Promise<readonly CommandExecutionReport[]> {
    const inventory = await this.options.repository.reconcile();
    const observations = [...inventory.settled, ...inventory.unresolved];
    for (const observation of observations) {
      const owner = await this.#owner(observation.executionId).catch(() => undefined);
      if (owner?.runId !== runId || (observation.kind !== 'running' && observation.kind !== 'prepared' && observation.kind !== 'preparing')) continue;
      await this.options.repository.terminate(observation.executionId);
      await this.#waitForTerminalObservation(observation.executionId, 15_000);
    }
    await this.reconcile();
    return Object.freeze([...this.#recovered.values()].filter((report) => report.result.owner.runId === runId));
  }

  recoveredTerminalReports(): readonly CommandExecutionReport[] {
    return Object.freeze([...this.#recovered.values()].sort((left, right) => left.result.processId.localeCompare(right.result.processId)));
  }

  async acknowledgeTerminalReport(processId: string): Promise<void> {
    await this.options.repository.forget(processId);
    await this.options.state.delete(ownerPath(processId));
    this.#recovered.delete(processId);
  }

  executionId(owner: CommandExecutionOwner): string {
    validateOwner(owner);
    return processIdentity(owner, this.descriptor.recoveryIdentity);
  }

  async reconcileExecution(
    owner: CommandExecutionOwner,
    outputTokenBudget: number,
    waitMs = 0
  ): Promise<SandboxCommandRecovery> {
    this.#ensureOpen();
    validateOwner(owner);
    const processId = this.executionId(owner);
    const stored = await this.#storedOwner(processId);
    assertRequester(stored.owner, owner, processId);
    const observation = await this.options.repository.inspect(processId, {
      maxBytes: this.options.maxRetainedOutputBytes,
      waitMs
    });
    assertRequestBinding(stored, observation);
    if (observation.kind === 'unknown') return Object.freeze({ status: 'unknown' });
    if (observation.kind === 'expired') return Object.freeze({ status: 'expired' });
    if (observation.kind === 'preparing' || observation.kind === 'prepared' || observation.kind === 'running') {
      return Object.freeze({ status: 'running' });
    }
    return Object.freeze({ status: 'settled', result: this.#result(observation, owner, outputTokenBudget, 0) });
  }

  async reconcile(): Promise<CommandReconciliationResult> {
    this.#recovered.clear();
    this.#unresolved.clear();
    const inventory = await this.options.repository.reconcile();
    for (const observation of inventory.settled) {
      const stored = await this.#storedOwner(observation.executionId);
      assertRequestBinding(stored, observation);
      const owner = stored.owner;
      const result = this.#result(observation, owner, 4_000, 0);
      this.#recovered.set(observation.executionId, Object.freeze({ result }));
    }
    for (const observation of inventory.unresolved) {
      const stored = await this.#storedOwner(observation.executionId);
      assertRequestBinding(stored, observation);
      this.#unresolved.set(observation.executionId, {
        workspace: this.options.workspaceFileRoot.identity.canonicalPath,
        diagnostic: unresolvedDiagnostic(observation)
      });
    }
    return this.#reconciliationResult();
  }

  retryReconciliation(): Promise<CommandReconciliationResult> {
    return this.reconcile();
  }

  async acknowledgeUnresolved(processIds: readonly string[]): Promise<void> {
    for (const processId of processIds) {
      if (!this.#unresolved.has(processId)) throw new Error(`Sandbox execution is not unresolved: ${processId}`);
      const observation = await this.options.repository.inspect(processId);
      if (observation.kind === 'unknown') await this.options.repository.acknowledgeUnknown(processId);
      else if (observation.kind === 'expired') await this.options.repository.forget(processId);
      else throw new Error(`Live sandbox execution cannot be acknowledged unresolved: ${processId}`);
      await this.options.state.delete(ownerPath(processId));
      this.#unresolved.delete(processId);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const binding of this.#abortListeners.values()) binding.signal.removeEventListener('abort', binding.listener);
    this.#abortListeners.clear();
    await this.options.repository.close();
  }

  #result(observation: SandboxExecutionObservation, owner: CommandExecutionOwner, outputTokenBudget: number, afterCursor: number): CommandExecutionResult {
    if (observation.kind === 'unknown' || observation.kind === 'expired' || observation.kind === 'prepared' || observation.kind === 'preparing') {
      return this.#requireKnown(observation);
    }
    const output = renderOutput(observation, outputTokenBudget, afterCursor);
    if (observation.kind === 'rejected') {
      return Object.freeze({ processId: observation.executionId, owner, status: 'failed', cursorStart: output.cursorStart, cursorEnd: output.cursorEnd,
        ...(observation.output.cursorExpired ? { cursorExpired: true } : {}),
        stdout: output.stdout, stderr: output.stderr, combined: output.combined, diagnostic: observation.error.message });
    }
    if (observation.kind === 'running') {
      return Object.freeze({ processId: observation.executionId, owner, status: 'running', cursorStart: output.cursorStart, cursorEnd: output.cursorEnd,
        ...(observation.output.cursorExpired ? { cursorExpired: true } : {}),
        stdout: output.stdout, stderr: output.stderr, combined: output.combined });
    }
    const status = statusFromTermination(observation.result.termination);
    return Object.freeze({
      processId: observation.executionId,
      owner,
      status,
      cursorStart: output.cursorStart,
      cursorEnd: output.cursorEnd,
      ...(observation.output.cursorExpired ? { cursorExpired: true } : {}),
      stdout: output.stdout,
      stderr: output.stderr,
      combined: output.combined,
      ...(observation.result.termination.reason === 'exit' ? { exitCode: observation.result.termination.code, signal: null } : {}),
      ...(observation.result.termination.reason === 'signal' ? { exitCode: null, signal: observation.result.termination.signal } : {}),
      ...(!observation.result.cleanup.completed ? { diagnostic: `Sandbox cleanup failed: ${observation.result.cleanup.failures.map((failure) => `${failure.code}: ${failure.message}`).join('; ')}` } : {})
    });
  }

  #requireKnown(observation: SandboxExecutionObservation): never {
    if (observation.kind === 'unknown') throw new Error(`Sandbox execution outcome is unknown: ${observation.diagnostic}`);
    if (observation.kind === 'expired') throw new Error(`Sandbox execution receipt expired at ${new Date(observation.expiredAtMs).toISOString()}.`);
    throw new Error(`Sandbox execution did not reach a process observation: ${observation.kind}.`);
  }

  async #emitOutput(callback: StartPreparedCommandOptions['onProgress'], observation: SandboxExecutionObservation): Promise<void> {
    if (!callback) return;
    let sequence = 0;
    const observed = { stdout: 0, stderr: 0 };
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    for (const chunk of observation.output.chunks) {
      observed[chunk.stream] += chunk.data.byteLength;
      const text = decoders[chunk.stream].write(chunk.data);
      if (text.length === 0) continue;
      sequence += 1;
      try {
        await callback({ type: 'output', stream: chunk.stream, sequence, text, observedBytes: observed[chunk.stream] });
      } catch {
        // Progress is observational; durable output remains in the sandbox repository.
      }
    }
    for (const stream of ['stdout', 'stderr'] as const) {
      const text = decoders[stream].end();
      if (text.length === 0) continue;
      sequence += 1;
      try { await callback({ type: 'output', stream, sequence, text, observedBytes: observed[stream] }); }
      catch { /* Progress is observational; durable output remains in the sandbox repository. */ }
    }
  }

  #bindAbort(processId: string, signal: AbortSignal | undefined): void {
    if (!signal) return;
    const listener = () => { void this.options.repository.terminate(processId).catch(() => undefined); };
    signal.addEventListener('abort', listener, { once: true });
    this.#abortListeners.set(processId, { signal, listener });
  }

  async #waitForProcessObservation(processId: string, waitMs: number): Promise<SandboxExecutionObservation> {
    const deadline = Date.now() + Math.max(1, waitMs);
    let observation = await this.options.repository.inspect(processId, {
      maxBytes: this.options.maxRetainedOutputBytes,
      waitMs: Math.min(50, Math.max(0, deadline - Date.now()))
    });
    while ((observation.kind === 'prepared' || observation.kind === 'preparing') && Date.now() < deadline) {
      observation = await this.options.repository.inspect(processId, {
        maxBytes: this.options.maxRetainedOutputBytes,
        waitMs: Math.min(50, Math.max(0, deadline - Date.now()))
      });
    }
    if (observation.kind === 'prepared' || observation.kind === 'preparing') throw new Error('Sandbox activation did not publish a process observation before its deadline.');
    return observation;
  }

  async #waitForTerminalObservation(processId: string, waitMs: number): Promise<SandboxExecutionObservation> {
    const deadline = Date.now() + Math.max(1, waitMs);
    let observation = await this.options.repository.inspect(processId, {
      maxBytes: this.options.maxRetainedOutputBytes,
      waitMs: Math.min(50, Math.max(0, deadline - Date.now()))
    });
    while (observation.kind !== 'settled' && observation.kind !== 'rejected'
      && observation.kind !== 'unknown' && observation.kind !== 'expired' && Date.now() < deadline) {
      observation = await this.options.repository.inspect(processId, {
        maxBytes: this.options.maxRetainedOutputBytes,
        waitMs: Math.min(50, Math.max(0, deadline - Date.now()))
      });
    }
    if (observation.kind !== 'settled' && observation.kind !== 'rejected'
      && observation.kind !== 'unknown' && observation.kind !== 'expired') throw new Error(`Sandbox execution did not terminate before its deadline: ${processId}`);
    return observation;
  }

  #releaseIfTerminal(result: CommandExecutionResult): void {
    if (result.status === 'running') return;
    this.resourceLeases.releaseProcess(result.processId);
    const binding = this.#abortListeners.get(result.processId);
    if (binding) binding.signal.removeEventListener('abort', binding.listener);
    this.#abortListeners.delete(result.processId);
  }

  async #bindOwner(owner: StoredOwner): Promise<void> {
    const existingText = await this.options.state.read(ownerPath(owner.processId));
    if (existingText !== undefined) {
      const existing = decodeStoredOwner(existingText, owner.processId);
      if (!sameOwner(existing.owner, owner.owner)) throw new Error(`Sandbox process owner binding conflicts with its durable identity: ${owner.processId}`);
      if (existing.requestDigest !== undefined && owner.requestDigest !== undefined && existing.requestDigest !== owner.requestDigest) {
        throw new Error(`Sandbox process request binding conflicts with its durable identity: ${owner.processId}`);
      }
      if (existing.requestDigest !== undefined && owner.requestDigest === undefined) return;
      if (existing.authorization !== undefined && owner.authorization !== undefined
        && JSON.stringify(existing.authorization) !== JSON.stringify(owner.authorization)) {
        throw new Error(`Sandbox process authorization binding conflicts with its durable identity: ${owner.processId}`);
      }
      if (existing.authorization !== undefined && owner.authorization === undefined) return;
    }
    await this.options.state.write(ownerPath(owner.processId), `${JSON.stringify(owner)}\n`);
  }

  async #owner(processId: string): Promise<CommandExecutionOwner> {
    return (await this.#storedOwner(processId)).owner;
  }

  async #storedOwner(processId: string): Promise<StoredOwner> {
    const text = await this.options.state.read(ownerPath(processId));
    if (text === undefined) throw new Error(`Sandbox process owner is unavailable: ${processId}`);
    const stored = decodeStoredOwner(text, processId);
    if (processIdentity(stored.owner, this.descriptor.recoveryIdentity) !== processId) throw new Error(`Sandbox process owner record does not match its process identity: ${processId}`);
    return stored;
  }

  #reconciliationResult(): CommandReconciliationResult {
    return Object.freeze({
      resolved: Object.freeze([...this.#recovered.keys()].sort()),
      unresolved: Object.freeze([...this.#unresolved.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([processId, value]) => Object.freeze({ processId, ...value })))
    });
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error('Sandbox command execution is closed.');
  }
}

interface RenderedOutput {
  readonly cursorStart: number;
  readonly cursorEnd: number;
  readonly stdout: CommandOutputView;
  readonly stderr: CommandOutputView;
  readonly combined: CommandOutputView;
}

function renderOutput(observation: SandboxExecutionObservation, outputTokenBudget: number, afterCursor: number): RenderedOutput {
  const budgetBytes = Math.max(256, positive(outputTokenBudget, 'outputTokenBudget') * 4);
  const chunks = observation.output.chunks;
  const stdoutChunks = chunks.filter((chunk) => chunk.stream === 'stdout').map((chunk) => chunk.data);
  const stderrChunks = chunks.filter((chunk) => chunk.stream === 'stderr').map((chunk) => chunk.data);
  const startsAtOutputStart = afterCursor === 0 && observation.output.cursorStart === 0;
  const stdoutObserved = afterCursor === 0 ? observation.output.stdoutBytes : stdoutChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const stderrObserved = afterCursor === 0 ? observation.output.stderrBytes : stderrChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const requestedCursor = Math.max(afterCursor, observation.output.cursorStart);
  const combinedObserved = Math.max(0, observation.output.availableCursorEnd - requestedCursor);
  const endsAtOutputEnd = (chunks.at(-1)?.cursorEnd ?? requestedCursor) === observation.output.availableCursorEnd;
  const stdout = outputView(stdoutChunks, Math.max(64, Math.floor(budgetBytes / 4)), stdoutObserved, startsAtOutputStart, endsAtOutputEnd);
  const stderr = outputView(stderrChunks, Math.max(64, Math.floor(budgetBytes / 4)), stderrObserved, startsAtOutputStart, endsAtOutputEnd);
  const combined = outputView(chunks.map((chunk) => chunk.data), Math.max(128, Math.floor(budgetBytes / 2)), combinedObserved, startsAtOutputStart, endsAtOutputEnd);
  return { cursorStart: observation.output.cursorStart, cursorEnd: observation.output.availableCursorEnd, stdout, stderr, combined };
}

function outputView(
  chunks: readonly Buffer[],
  maxBytes: number,
  observedBytes: number,
  startsAtOutputStart: boolean,
  endsAtOutputEnd: boolean
): CommandOutputView {
  const bytes = Buffer.concat(chunks);
  const text = bytes.toString('utf8');
  const headBudget = maxBytes - Math.floor(maxBytes / 3);
  const head = takeUtf8Start(text, headBudget);
  const selected = observedBytes <= maxBytes ? text : head + takeUtf8End(text.slice(head.length), maxBytes - Buffer.byteLength(head));
  const capturedBytes = Buffer.byteLength(selected);
  return Object.freeze({
    text: selected,
    observedBytes,
    capturedBytes,
    omittedBytes: Math.max(0, observedBytes - capturedBytes),
    startsAtOutputStart,
    endsAtOutputEnd
  });
}

function takeUtf8Start(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let low = 0; let high = value.length;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) low = middle; else high = middle - 1; }
  if (low > 0 && /[\uD800-\uDBFF]/u.test(value[low - 1] ?? '')) low -= 1;
  return value.slice(0, low);
}

function takeUtf8End(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let low = 0; let high = value.length;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (Buffer.byteLength(value.slice(middle)) <= maxBytes) high = middle; else low = middle + 1; }
  if (/[\uDC00-\uDFFF]/u.test(value[low] ?? '')) low += 1;
  return value.slice(low);
}

function statusFromTermination(termination: Extract<SandboxExecutionObservation, { kind: 'settled' }>['result']['termination']): CommandExecutionStatus {
  if (termination.reason === 'exit') return 'exited';
  if (termination.reason === 'timeout') return 'timed_out';
  if (termination.reason === 'runtime-failure') return 'failed';
  return 'stopped';
}

function validateWorkspaceGrant(run: SandboxDetachedRunOptions, canonicalRoot: string): void {
  const grants = run.policy.filesystem.grants.filter((grant) => grant.hostPath === canonicalRoot);
  if (grants.length !== 1) throw new Error('Sandbox command plan must contain exactly one grant for the adopted physical workspace root.');
  if (run.process.stdout !== 'pipe' || run.process.stderr !== 'pipe') throw new Error('Sandbox command plan must expose stdout and stderr as durable output streams.');
}

function processIdentity(owner: CommandExecutionOwner, recoveryIdentity: string): string {
  const identity = JSON.stringify([recoveryIdentity, owner.runId, owner.turnId, owner.toolBatchId, owner.callIndex]);
  return `sandbox-${createHash('sha256').update(identity).digest('hex')}`;
}

function ownerPath(processId: string): string {
  if (!/^sandbox-[a-f0-9]{64}$/u.test(processId)) throw new TypeError('Invalid sandbox process identity.');
  return `sandbox-processes/${processId}.json`;
}

function validateOwner(value: unknown): asserts value is CommandExecutionOwner {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Command execution owner must be an object.');
  const source = value as Record<string, unknown>;
  const callIndex = source.callIndex;
  if (!identity(source.runId) || !identity(source.turnId) || !identity(source.toolBatchId)
    || typeof callIndex !== 'number' || !Number.isSafeInteger(callIndex) || callIndex < 0) throw new TypeError('Command execution owner is invalid.');
}

function decodeStoredOwner(text: string, processId: string): StoredOwner {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error(`Sandbox process owner record is not valid JSON: ${processId}`); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Sandbox process owner record is invalid: ${processId}`);
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  const expected = source.requestDigest === undefined
    ? ['owner', 'processId', 'schemaVersion']
    : ['authorization', 'owner', 'processId', 'requestDigest', 'schemaVersion'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error(`Sandbox process owner record has unsupported fields: ${processId}`);
  if (source.schemaVersion !== 1 || source.processId !== processId) throw new Error(`Sandbox process owner record identity is invalid: ${processId}`);
  const requestDigest = source.requestDigest;
  if (requestDigest !== undefined && (typeof requestDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(requestDigest))) {
    throw new Error(`Sandbox process request binding is invalid: ${processId}`);
  }
  validateOwner(source.owner);
  const authorization = requestDigest === undefined ? undefined : parseJsonObject(source.authorization);
  if (requestDigest === undefined) return Object.freeze({ schemaVersion: 1, processId, owner: ownOwner(source.owner) });
  if (!authorization) throw new Error(`Sandbox process authorization record is missing: ${processId}`);
  return Object.freeze({ schemaVersion: 1, processId, owner: ownOwner(source.owner), requestDigest, authorization });
}

function sandboxCommandAuthorization(
  descriptor: CommandExecutionDescriptor,
  prepared: Extract<SandboxExecutionObservation, { readonly kind: 'prepared' }>
): JsonObject {
  return parseJsonObject({
    authority: descriptor.implementationId,
    recoveryIdentity: descriptor.recoveryIdentity,
    executionId: prepared.executionId,
    requestDigest: prepared.requestDigest,
    policyDigest: prepared.policyDigest,
    executionDigest: prepared.executionDigest,
    summary: prepared.summary,
    enforcement: prepared.enforcement,
    expiresAt: new Date(prepared.expiresAtMs).toISOString()
  });
}

function assertRequestBinding(owner: StoredOwner, observation: SandboxExecutionObservation): void {
  if (observation.requestDigest !== undefined
    && owner.requestDigest !== undefined && owner.requestDigest !== observation.requestDigest) {
    throw new Error(`Sandbox execution does not match its durable request binding: ${observation.executionId}`);
  }
}

function ownOwner(owner: CommandExecutionOwner): CommandExecutionOwner {
  return Object.freeze({ runId: owner.runId, turnId: owner.turnId, toolBatchId: owner.toolBatchId, callIndex: owner.callIndex });
}

function assertRequester(owner: CommandExecutionOwner, requester: CommandExecutionOwner | undefined, processId: string): void {
  if (requester && !sameOwner(owner, requester)) throw new Error(`Sandbox process belongs to another tool invocation: ${processId}`);
}

function sameOwner(left: CommandExecutionOwner, right: CommandExecutionOwner): boolean {
  return left.runId === right.runId && left.turnId === right.turnId && left.toolBatchId === right.toolBatchId && left.callIndex === right.callIndex;
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !hasControlCharacter(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function unresolvedDiagnostic(observation: SandboxExecutionObservation): string {
  if (observation.kind === 'unknown') return observation.diagnostic;
  if (observation.kind === 'expired') return `Execution receipt expired at ${new Date(observation.expiredAtMs).toISOString()}.`;
  return `Execution remains ${observation.kind}; reconcile or terminate it before starting more commands.`;
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be positive.`);
  return value;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(typeof signal.reason === 'string' ? signal.reason : 'Command execution was aborted.');
}

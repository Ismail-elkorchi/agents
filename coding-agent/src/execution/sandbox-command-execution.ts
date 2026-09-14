import { hashJson, redactTextPreservingLength } from '@agent-core/persistence';
import { parseJsonObject, type JsonObject } from '@agent-core/json';
import {
  adoptCommandExecution,
  createCommandExecutionReservation,
  type CommandExecution,
  type CommandExecutionDescriptor,
  type CommandExecutionOwner,
  type CommandExecutionPlanRequest,
  type CommandExecutionReport,
  type CommandExecutionReservation,
  type CommandExecutionResult,
  type CommandExecutionStatus,
  type CommandOutputView,
  type CommandReconciliationResult,
  type ResourceLeaseCoordinator,
  type StartCommandExecutionOptions
} from '@agent-core/tools';
import { processScope, type RootedFileAuthority } from '@agent-core/tools-local';
import type {
  SandboxDetachedRunOptions,
  SandboxExecutionObservation,
  SandboxExecutionRepository
} from '@ismail-elkorchi/sandbox';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import {
  CommandObservations,
  type CommandIdentity,
  type CommandObservationsOptions
} from './command-observations.js';
import { PrivateStateDirectory } from '../state/private-state.js';
import type { CodingProcess } from './coding-command-authority.js';

const PROCESS_OBSERVATION_TIMEOUT_MS = 30_000;

export interface SandboxCommandPlanContext {
  readonly hostWorkspaceRoot: string;
  readonly workspacePath: string;
}

export interface SandboxCommandAuthorization {
  readonly request: CommandExecutionPlanRequest;
  readonly executionId: string;
  readonly requestDigest: string;
  readonly policyDigest: string;
  readonly executionDigest: string;
  // `prepared` is the upstream Sandbox wire state; this adapter exposes it as authorization.
  readonly summary: Extract<SandboxExecutionObservation, { kind: 'prepared' }>['summary'];
  readonly enforcement: Extract<SandboxExecutionObservation, { kind: 'prepared' }>['enforcement'];
  readonly expiresAtMs: number;
}

export type SandboxCommandRecovery =
  | Readonly<{ readonly status: 'running' }>
  | Readonly<{ readonly status: 'settled'; readonly result: CommandExecutionResult }>
  | Readonly<{ readonly status: 'unknown' }>;

export interface SandboxCommandExecutionOptions extends CommandObservationsOptions {
  readonly resourceLeases: ResourceLeaseCoordinator;
  readonly descriptor?: CommandExecutionDescriptor;
  readonly repository: SandboxExecutionRepository;
  readonly rootedFileAuthority: RootedFileAuthority;
  readonly state: PrivateStateDirectory;
  readonly createRun: (
    request: CommandExecutionPlanRequest,
    context: SandboxCommandPlanContext
  ) => SandboxDetachedRunOptions | Promise<SandboxDetachedRunOptions>;
  readonly validateAuthorization: (
    authorization: SandboxCommandAuthorization
  ) => void | Promise<void>;
  readonly maxRetainedOutputBytes: number;
}

interface StoredOwner {
  readonly schemaVersion: 1;
  readonly command: string;
  readonly processId: string;
  readonly owner: CommandExecutionOwner;
  readonly requestDigest?: string;
  readonly authorization?: JsonObject;
}

class SandboxCommandPlan {
  #state: 'planned' | 'started' | 'activated' | 'released' = 'planned';

  constructor(
    readonly authority: SandboxCommandExecution,
    readonly request: CommandExecutionPlanRequest,
    readonly observation: SandboxExecutionObservation,
    private readonly releaseAuthority: () => Promise<void>
  ) {}

  start() {
    if (this.#state !== 'planned') throw new Error('Sandbox command plan is single-use.');
    this.#state = 'started';
    return { request: this.request, observation: this.observation };
  }

  markActivated(): void {
    if (this.#state !== 'started') throw new Error('Sandbox command plan was not started.');
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
  readonly resourceLeases: ResourceLeaseCoordinator;
  readonly #recovered = new Map<string, CommandExecutionReport>();
  readonly #unresolved = new Map<string, { rootPath: string; diagnostic: string }>();
  readonly #abortListeners = new Map<string, { signal: AbortSignal; listener: () => void }>();
  readonly #observers = new Map<
    string,
    { controller: AbortController; completion: Promise<void> }
  >();
  readonly #plans = new WeakMap<CommandExecutionReservation, SandboxCommandPlan>();
  readonly #observations: CommandObservations;
  readonly #pending = new Map<string, Promise<unknown>>();
  #closed = false;

  private constructor(private readonly options: SandboxCommandExecutionOptions) {
    this.resourceLeases = options.resourceLeases;
    this.#observations = new CommandObservations(options);
    this.descriptor =
      options.descriptor ??
      Object.freeze({
        implementationId: 'coding-agent.sandbox-command-execution@1',
        recoveryIdentity: `${options.repository.identity}:${createHash('sha256').update(options.rootedFileAuthority.identity.canonicalPath).digest('hex')}`,
        capabilities: Object.freeze([
          'sandbox-process',
          'caller-process-recovery',
          'staged-authorization'
        ]),
        supportsPty: false
      });
    adoptCommandExecution(this);
  }

  static async create(options: SandboxCommandExecutionOptions): Promise<SandboxCommandExecution> {
    let execution: SandboxCommandExecution | undefined;
    try {
      if (
        !Number.isSafeInteger(options.maxRetainedOutputBytes) ||
        options.maxRetainedOutputBytes < 1
      )
        throw new TypeError('maxRetainedOutputBytes must be positive.');
      execution = new SandboxCommandExecution(options);
      await execution.reconcile();
      return execution;
    } catch (error) {
      try {
        await (execution ? execution.close() : options.repository.close());
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'Sandbox command construction and cleanup failed.',
          { cause: cleanup }
        );
      }
      throw error;
    }
  }

  async plan(request: CommandExecutionPlanRequest): Promise<CommandExecutionReservation> {
    this.#ensureOpen();
    if (this.#unresolved.size > 0)
      throw new Error('Unresolved sandbox executions block new command starts for this workspace.');
    if (request.pty)
      throw new Error('The configured sandbox command execution does not support PTY mode.');
    validateOwner(request.owner);
    const processId = processIdentity(request.owner, this.descriptor.recoveryIdentity);
    await this.#bindOwner({
      schemaVersion: 1,
      command: request.command,
      processId,
      owner: ownOwner(request.owner)
    });
    const run = await this.options.createRun(request, {
      hostWorkspaceRoot: this.options.rootedFileAuthority.identity.canonicalPath,
      workspacePath: request.rootedDirectory
    });
    validateWorkspaceResource(run, this.options.rootedFileAuthority.identity.canonicalPath);
    // `prepare` is fixed by the upstream Sandbox protocol. Coding Agent treats its result as authorization.
    const observation = await this.options.repository.prepare(
      { executionId: processId, run },
      {
        maxBytes: 64 * 1024,
        waitMs: Math.max(1, Math.min(request.timeoutMs, 30_000))
      }
    );
    if (observation.kind === 'rejected') {
      await this.#bindOwner({
        schemaVersion: 1,
        command: request.command,
        processId,
        owner: ownOwner(request.owner),
        requestDigest: observation.requestDigest
      });
      throw new Error(`Sandbox rejected command plan: ${observation.error.message}`);
    }
    if (observation.requestDigest === undefined)
      throw new Error(`Sandbox execution ${processId} has no request binding.`);
    const authorization =
      observation.kind === 'prepared'
        ? sandboxCommandAuthorization(this.descriptor, observation)
        : (await this.#storedOwner(processId)).authorization;
    if (!authorization)
      throw new Error(`Sandbox execution ${processId} has no durable authorization record.`);
    await this.#bindOwner({
      schemaVersion: 1,
      command: request.command,
      processId,
      owner: ownOwner(request.owner),
      requestDigest: observation.requestDigest,
      authorization
    });
    if (observation.kind === 'prepared') {
      try {
        await this.options.validateAuthorization(
          Object.freeze({
            request,
            executionId: processId,
            requestDigest: observation.requestDigest,
            policyDigest: observation.policyDigest,
            executionDigest: observation.executionDigest,
            summary: observation.summary,
            enforcement: observation.enforcement,
            expiresAtMs: observation.expiresAtMs
          })
        );
      } catch (error) {
        try {
          await this.#discardPreparation(processId);
        } catch (releaseError) {
          throw new AggregateError(
            [error, releaseError],
            'Command authorization and preparation release failed.',
            { cause: releaseError }
          );
        }
        throw error;
      }
    }
    const owned = new SandboxCommandPlan(this, request, observation, async () => {
      if (observation.kind !== 'prepared') return;
      await this.#discardPreparation(observation.executionId);
    });
    const plan = createCommandExecutionReservation(authorization, () => owned.release());
    this.#plans.set(plan, owned);
    return plan;
  }

  async #discardPreparation(processId: string): Promise<void> {
    await this.options.repository.terminate(processId);
    const observation = await this.options.repository.inspect(processId);
    if (observation.kind !== 'settled' && observation.kind !== 'rejected')
      throw new Error('Command preparation did not settle.');
    await this.#result(observation, await this.#owner(processId), 0, 0);
  }

  async start(
    plan: CommandExecutionReservation,
    options: StartCommandExecutionOptions = {}
  ): Promise<CommandExecutionResult> {
    this.#ensureOpen();
    const owned = this.#plans.get(plan);
    if (owned?.authority !== this) {
      throw new TypeError('Command plan does not belong to this sandbox authority.');
    }
    const { request, observation: authorization } = owned.start();
    const processId = authorization.executionId;
    if (options.signal?.aborted) {
      await owned.release();
      throw abortError(options.signal);
    }
    this.#bindAbort(processId, options.signal);
    if (authorization.kind === 'prepared') {
      await this.options.repository.activate(processId, authorization);
      owned.markActivated();
    }
    let observation =
      authorization.kind === 'prepared'
        ? await this.#waitForProcessObservation(processId, PROCESS_OBSERVATION_TIMEOUT_MS)
        : authorization;
    if (observation.kind === 'running' && request.yieldMs > 0) {
      observation = await this.options.repository.inspect(processId, {
        maxBytes: 64 * 1024,
        waitMs: request.yieldMs
      });
    }
    const result = await this.#result(observation, request.owner, request.outputTokenBudget, 0);
    if (result.status === 'running' && options.lease)
      options.lease.transferToResource(processId, processScope(processId));
    if (result.status === 'running') this.#observeProcess(processId);
    await this.#emitOutput(options.onProgress, observation);
    this.#releaseIfTerminal(result);
    return result;
  }

  async query(
    processId: string,
    outputTokenBudget: number,
    yieldMs = 0,
    afterCursor = 0,
    requester?: CommandExecutionOwner
  ): Promise<CommandExecutionResult> {
    this.#ensureOpen();
    const owner = await this.#owner(processId);
    assertRequester(owner, requester, processId);
    const observation = await this.options.repository.inspect(processId, {
      afterCursor,
      maxBytes: 64 * 1024,
      waitMs: yieldMs
    });
    const result = await this.#result(observation, owner, outputTokenBudget, afterCursor);
    this.#releaseIfTerminal(result);
    return result;
  }

  async writeInput(
    processId: string,
    text: string,
    requester?: CommandExecutionOwner
  ): Promise<void> {
    const owner = await this.#owner(processId);
    assertRequester(owner, requester, processId);
    await this.options.repository.writeInput(processId, Buffer.from(text, 'utf8'));
  }

  async closeInput(processId: string, requester?: CommandExecutionOwner): Promise<void> {
    const owner = await this.#owner(processId);
    assertRequester(owner, requester, processId);
    await this.options.repository.closeInput(processId);
  }

  async terminate(
    processId: string,
    requester?: CommandExecutionOwner
  ): Promise<CommandExecutionResult> {
    const owner = await this.#owner(processId);
    assertRequester(owner, requester, processId);
    if (await this.#observations.terminal(await this.#identity(processId)))
      return this.query(processId, 4_000, 0, 0, owner);
    try {
      await this.options.repository.terminate(processId);
    } catch (error) {
      // The process can settle between its last observation and the control request.
      const observation = await this.options.repository.inspect(processId);
      if (observation.kind !== 'settled' && observation.kind !== 'rejected') throw error;
      const result = await this.#result(observation, owner, 4_000, 0);
      this.#releaseIfTerminal(result);
      return result;
    }
    const observation = await this.#waitForTerminalObservation(processId, 15_000);
    const result = await this.#result(observation, owner, 4_000, 0);
    this.#releaseIfTerminal(result);
    return result;
  }

  async disposeOwner(ownerId: string): Promise<readonly CommandExecutionReport[]> {
    const observations = await this.#inventory();
    for (const observation of observations) {
      const owner = await this.#owner(observation.executionId);
      if (
        owner.ownerId !== ownerId ||
        (observation.kind !== 'running' &&
          observation.kind !== 'prepared' &&
          observation.kind !== 'preparing')
      )
        continue;
      await this.terminate(observation.executionId, owner);
    }
    await this.reconcile();
    for (const [processId, unresolved] of this.#unresolved) {
      if ((await this.#owner(processId)).ownerId === ownerId)
        throw new Error(
          `Sandbox resource release remains unresolved: ${processId}: ${unresolved.diagnostic}`
        );
    }
    return Object.freeze(
      [...this.#recovered.values()].filter((report) => report.result.owner.ownerId === ownerId)
    );
  }

  recoveredTerminalReports(): readonly CommandExecutionReport[] {
    return Object.freeze([...this.#recovered.values()]);
  }

  async acknowledgeTerminalReport(processId: string): Promise<void> {
    const identity = await this.#identity(processId);
    const report = await this.#observations.terminal(identity);
    if (!report || report.result.originalOutput?.kind !== 'captured')
      throw new Error('Command receipt has not been durably captured.');
    const receiptDigest = await this.#observations.receiptDigest(identity);
    if (!receiptDigest) throw new Error('Committed command receipt is unavailable.');
    await this.options.repository.forget(processId, { receiptDigest });
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
      maxBytes: 64 * 1024,
      waitMs
    });
    assertRequestBinding(stored, observation);
    if (
      observation.kind === 'unknown' &&
      !(await this.#observations.terminal(await this.#identity(processId)))
    )
      return Object.freeze({ status: 'unknown' });
    if (observation.kind === 'retired' && observation.reason === 'acknowledged-unknown')
      return Object.freeze({ status: 'unknown' });
    if (
      observation.kind === 'preparing' ||
      observation.kind === 'prepared' ||
      observation.kind === 'running'
    ) {
      return Object.freeze({ status: 'running' });
    }
    const result = await this.#result(observation, owner, outputTokenBudget, 0);
    this.#releaseIfTerminal(result);
    return Object.freeze({ status: 'settled', result });
  }

  readonly #releaseFailures = new Map<string, string>();

  async listProcesses(): Promise<readonly CodingProcess[]> {
    this.#ensureOpen();
    const processes: CodingProcess[] = [];
    for (const observation of await this.#inventory()) {
      const stored = await this.#storedOwner(observation.executionId);
      assertRequestBinding(stored, observation);
      const report = stored.requestDigest
        ? await this.#observations.terminal(await this.#identity(observation.executionId))
        : undefined;
      const releaseFailure = this.#releaseFailures.get(observation.executionId);
      processes.push({
        processId: observation.executionId,
        owner: stored.owner,
        command: stored.command,
        revision: hashJson({
          owner: stored.owner,
          requestDigest: stored.requestDigest ?? null,
          kind: observation.kind,
          receipt: 'receipt' in observation ? observation.receipt.digest : null,
          diagnostic: observation.kind === 'unknown' ? observation.diagnostic : null
        }),
        ...(observation.kind === 'unknown'
          ? { diagnostic: observation.diagnostic }
          : releaseFailure !== undefined
            ? { diagnostic: releaseFailure }
            : report?.result.originalOutput?.kind === 'unavailable'
              ? { diagnostic: report.result.originalOutput.diagnostic }
              : {}),
        status: report
          ? report.result.status
          : observation.kind === 'settled'
            ? statusFromTermination(observation.result.termination)
            : observation.kind === 'rejected'
              ? 'failed'
              : observation.kind === 'retired'
                ? 'acknowledged-unknown'
                : observation.kind
      });
    }
    return processes;
  }

  async reconcile(): Promise<CommandReconciliationResult> {
    for (const observation of await this.#inventory()) {
      const stored = await this.#storedOwner(observation.executionId);
      assertRequestBinding(stored, observation);
      if (observation.kind === 'retired' && observation.reason === 'acknowledged-unknown') continue;
      if (
        observation.kind === 'settled' ||
        observation.kind === 'rejected' ||
        observation.kind === 'retired' ||
        (observation.kind === 'unknown' &&
          stored.requestDigest &&
          (await this.#observations.terminal(await this.#identity(observation.executionId))))
      ) {
        await this.#result(observation, stored.owner, 4_000, 0);
      } else if (
        observation.kind === 'running' ||
        observation.kind === 'prepared' ||
        observation.kind === 'preparing'
      ) {
        this.#unresolved.delete(observation.executionId);
        this.resourceLeases.clearResourceFailure(observation.executionId);
        this.#restoreLease(observation.executionId);
        this.#observeProcess(observation.executionId);
      } else {
        this.#restoreLease(observation.executionId);
        this.resourceLeases.failResource(
          observation.executionId,
          new Error(
            'Command outcome requires reconciliation. Open Processes to inspect or acknowledge uncertainty.'
          )
        );
        this.#unresolved.set(observation.executionId, {
          rootPath: this.options.rootedFileAuthority.identity.canonicalPath,
          diagnostic: unresolvedDiagnostic(observation)
        });
      }
    }
    return this.#reconciliationResult();
  }

  async #inventory(): Promise<readonly SandboxExecutionObservation[]> {
    const observations: SandboxExecutionObservation[] = [];
    let afterCursor: number | undefined;
    do {
      const page = await this.options.repository.reconcile({
        ...(afterCursor === undefined ? {} : { afterCursor }),
        limit: 100
      });
      observations.push(...page.observations);
      afterCursor = page.nextCursor;
    } while (afterCursor !== undefined);
    return observations;
  }
  retryReconciliation(): Promise<CommandReconciliationResult> {
    return this.reconcile();
  }

  async acknowledgeUnresolved(processIds: readonly string[]): Promise<void> {
    for (const processId of processIds) {
      if (!this.#unresolved.has(processId))
        throw new Error(`Sandbox execution is not unresolved: ${processId}`);
      const observation = await this.options.repository.inspect(processId);
      if (observation.kind === 'unknown')
        await this.options.repository.acknowledgeUnknown(processId);
      else
        throw new Error(`Live sandbox execution cannot be acknowledged unresolved: ${processId}`);
      this.#releaseProcess(processId);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const observer of this.#observers.values()) observer.controller.abort();
    for (const binding of this.#abortListeners.values())
      binding.signal.removeEventListener('abort', binding.listener);
    this.#abortListeners.clear();
    await Promise.all([...this.#observers.values()].map((observer) => observer.completion));
    await Promise.allSettled([...this.#pending.values()]);
    await this.options.repository.close();
  }

  async #identity(processId: string): Promise<CommandIdentity> {
    const stored = await this.#storedOwner(processId);
    if (!stored.requestDigest) throw new Error('Command request binding is unavailable.');
    return {
      processId,
      owner: stored.owner,
      requestDigest: stored.requestDigest,
      authority: this.descriptor.recoveryIdentity
    };
  }

  #result(
    observation: SandboxExecutionObservation,
    owner: CommandExecutionOwner,
    outputTokenBudget: number,
    afterCursor: number
  ): Promise<CommandExecutionResult> {
    const processId = observation.executionId;
    const previous = this.#pending.get(processId) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        const identity = await this.#identity(processId);
        let report = await this.#observations.terminal(identity);
        if (!report) {
          const result = this.#renderResult(observation, owner, outputTokenBudget, afterCursor);
          if (observation.kind !== 'settled' && observation.kind !== 'rejected') {
            await this.#observations.capture(identity, this.options.repository, observation);
            return result;
          }
          report = await this.#observations.settle(
            identity,
            this.options.repository,
            observation,
            result
          );
        }
        this.#recovered.set(processId, report);
        this.#releaseProcess(processId);
        if (
          (observation.kind === 'settled' || observation.kind === 'rejected') &&
          report.result.originalOutput?.kind === 'captured'
        ) {
          try {
            await this.acknowledgeTerminalReport(processId);
            this.#releaseFailures.delete(processId);
          } catch (error) {
            this.#releaseFailures.set(
              processId,
              `Receipt release failed; the command result is retained. ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        return this.#observations.present(identity, report.result, afterCursor, outputTokenBudget);
      });
    this.#pending.set(processId, task);
    void task
      .finally(() => {
        if (this.#pending.get(processId) === task) this.#pending.delete(processId);
      })
      .catch(() => undefined);
    return task;
  }

  #renderResult(
    observation: SandboxExecutionObservation,
    owner: CommandExecutionOwner,
    outputTokenBudget: number,
    afterCursor: number
  ): CommandExecutionResult {
    if (
      observation.kind === 'unknown' ||
      observation.kind === 'retired' ||
      observation.kind === 'prepared' ||
      observation.kind === 'preparing'
    ) {
      return this.#requireKnown(observation);
    }
    const output = renderOutput(observation, outputTokenBudget, afterCursor);
    if (observation.kind === 'rejected') {
      return Object.freeze({
        processId: observation.executionId,
        owner,
        status: 'failed',
        cursorStart: output.cursorStart,
        cursorEnd: output.cursorEnd,
        stdout: output.stdout,
        stderr: output.stderr,
        combined: output.combined,
        diagnostic: observation.error.message
      });
    }
    if (observation.kind === 'running') {
      return Object.freeze({
        processId: observation.executionId,
        owner,
        status: 'running',
        cursorStart: output.cursorStart,
        cursorEnd: output.cursorEnd,
        stdout: output.stdout,
        stderr: output.stderr,
        combined: output.combined
      });
    }
    const status = statusFromTermination(observation.result.termination);
    const diagnostics = [
      ...(observation.result.termination.reason === 'runtime-failure'
        ? [observation.result.termination.error.message]
        : []),
      ...(!observation.result.cleanup.completed
        ? [
            `Sandbox cleanup failed: ${observation.result.cleanup.failures.map((failure) => `${failure.code}: ${failure.message}`).join('; ')}`
          ]
        : [])
    ];
    return Object.freeze({
      processId: observation.executionId,
      owner,
      status,
      cursorStart: output.cursorStart,
      cursorEnd: output.cursorEnd,
      stdout: output.stdout,
      stderr: output.stderr,
      combined: output.combined,
      ...(observation.result.termination.reason === 'exit'
        ? { exitCode: observation.result.termination.code, signal: null }
        : {}),
      ...(observation.result.termination.reason === 'signal'
        ? { exitCode: null, signal: observation.result.termination.signal }
        : {}),
      ...(diagnostics.length > 0 ? { diagnostic: diagnostics.join('; ') } : {})
    });
  }

  #requireKnown(observation: SandboxExecutionObservation): never {
    if (observation.kind === 'unknown')
      throw new Error(`Sandbox execution outcome is unknown: ${observation.diagnostic}`);
    if (observation.kind === 'retired')
      throw new Error(`Sandbox execution was retired: ${observation.reason}.`);
    throw new Error(`Sandbox execution did not reach a process observation: ${observation.kind}.`);
  }

  async #emitOutput(
    callback: StartCommandExecutionOptions['onProgress'],
    observation: SandboxExecutionObservation
  ): Promise<void> {
    if (!callback || observation.output.kind !== 'available') return;
    let sequence = 0;
    const observed = { stdout: 0, stderr: 0 };
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const publicBytes = Buffer.from(
      redactTextPreservingLength(
        Buffer.concat(observation.output.chunks.map((chunk) => chunk.data)).toString('latin1')
      ).text,
      'latin1'
    );
    let offset = 0;
    for (const chunk of observation.output.chunks) {
      observed[chunk.stream] += chunk.data.byteLength;
      const end = offset + chunk.data.byteLength;
      const text = decoders[chunk.stream].write(publicBytes.subarray(offset, end));
      offset = end;
      if (text.length === 0) continue;
      sequence += 1;
      try {
        await callback({
          type: 'output',
          stream: chunk.stream,
          sequence,
          text,
          observedBytes: observed[chunk.stream]
        });
      } catch {
        // Progress is observational; durable output remains in the sandbox repository.
      }
    }
    for (const stream of ['stdout', 'stderr'] as const) {
      const text = decoders[stream].end();
      if (text.length === 0) continue;
      sequence += 1;
      try {
        await callback({ type: 'output', stream, sequence, text, observedBytes: observed[stream] });
      } catch {
        /* Progress is observational; durable output remains in the sandbox repository. */
      }
    }
  }

  #bindAbort(processId: string, signal: AbortSignal | undefined): void {
    if (!signal) return;
    const listener = () => {
      void this.options.repository.terminate(processId).catch(() => undefined);
    };
    signal.addEventListener('abort', listener, { once: true });
    this.#abortListeners.set(processId, { signal, listener });
  }

  #observeProcess(processId: string): void {
    if (this.#observers.has(processId)) return;
    const controller = new AbortController();
    const observe = async () => {
      while (!this.#closed && !controller.signal.aborted) {
        const observation = await this.options.repository.inspect(processId, {
          maxBytes: 0,
          waitMs: 1_000
        });
        controller.signal.throwIfAborted();
        if (observation.kind === 'preparing' || observation.kind === 'prepared') continue;
        await this.#result(observation, await this.#owner(processId), 0, 0);
        if (observation.kind !== 'running') return;
      }
    };
    const completion = observe()
      .catch((error: unknown) => {
        if (this.#closed || controller.signal.aborted) return;
        const diagnostic = error instanceof Error ? error.message : String(error);
        this.#unresolved.set(processId, {
          rootPath: this.options.rootedFileAuthority.identity.canonicalPath,
          diagnostic
        });
        this.resourceLeases.failResource(
          processId,
          new Error(`Command ${processId} needs reconciliation: ${diagnostic}`)
        );
      })
      .finally(() => this.#observers.delete(processId));
    this.#observers.set(processId, { controller, completion });
  }

  async #waitForProcessObservation(
    processId: string,
    waitMs: number
  ): Promise<SandboxExecutionObservation> {
    const deadline = Date.now() + Math.max(1, waitMs);
    let observation = await this.options.repository.inspect(processId, {
      maxBytes: 64 * 1024,
      waitMs: Math.min(50, Math.max(0, deadline - Date.now()))
    });
    while (
      (observation.kind === 'prepared' || observation.kind === 'preparing') &&
      Date.now() < deadline
    ) {
      observation = await this.options.repository.inspect(processId, {
        maxBytes: 64 * 1024,
        waitMs: Math.min(50, Math.max(0, deadline - Date.now()))
      });
    }
    if (observation.kind === 'prepared' || observation.kind === 'preparing')
      throw new Error(
        'Sandbox activation did not publish a process observation before its deadline.'
      );
    return observation;
  }

  async #waitForTerminalObservation(
    processId: string,
    waitMs: number
  ): Promise<SandboxExecutionObservation> {
    const deadline = Date.now() + Math.max(1, waitMs);
    let observation = await this.options.repository.inspect(processId, {
      maxBytes: 64 * 1024,
      waitMs: Math.min(50, Math.max(0, deadline - Date.now()))
    });
    while (
      observation.kind !== 'settled' &&
      observation.kind !== 'rejected' &&
      observation.kind !== 'unknown' &&
      observation.kind !== 'retired' &&
      Date.now() < deadline
    ) {
      observation = await this.options.repository.inspect(processId, {
        maxBytes: 64 * 1024,
        waitMs: Math.min(50, Math.max(0, deadline - Date.now()))
      });
    }
    if (
      observation.kind !== 'settled' &&
      observation.kind !== 'rejected' &&
      observation.kind !== 'unknown' &&
      observation.kind !== 'retired'
    )
      throw new Error(`Sandbox execution did not terminate before its deadline: ${processId}`);
    return observation;
  }

  #restoreLease(processId: string): void {
    this.resourceLeases.restoreResource(
      processId,
      {
        accesses: [{ mode: 'write', scope: 'files' }],
        lockScopes: ['files'],
        recovery: { kind: 'unknown' }
      },
      processScope(processId)
    );
  }

  #releaseIfTerminal(result: CommandExecutionResult): void {
    if (result.status === 'running') return;
    this.#releaseProcess(result.processId);
  }

  #releaseProcess(processId: string): void {
    this.resourceLeases.releaseResource(processId);
    this.#observers.get(processId)?.controller.abort();
    this.#unresolved.delete(processId);
    const binding = this.#abortListeners.get(processId);
    if (binding) binding.signal.removeEventListener('abort', binding.listener);
    this.#abortListeners.delete(processId);
  }

  async #bindOwner(owner: StoredOwner): Promise<void> {
    const existingText = await this.options.state.read(ownerPath(owner.processId));
    if (existingText !== undefined) {
      const existing = decodeStoredOwner(existingText, owner.processId);
      if (!sameOwner(existing.owner, owner.owner) || existing.command !== owner.command)
        throw new Error(
          `Sandbox process owner binding conflicts with its durable identity: ${owner.processId}`
        );
      if (
        existing.requestDigest !== undefined &&
        owner.requestDigest !== undefined &&
        existing.requestDigest !== owner.requestDigest
      ) {
        throw new Error(
          `Sandbox process request binding conflicts with its durable identity: ${owner.processId}`
        );
      }
      if (existing.requestDigest !== undefined && owner.requestDigest === undefined) return;
      if (
        existing.authorization !== undefined &&
        owner.authorization !== undefined &&
        JSON.stringify(existing.authorization) !== JSON.stringify(owner.authorization)
      ) {
        throw new Error(
          `Sandbox process authorization binding conflicts with its durable identity: ${owner.processId}`
        );
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
    if (processIdentity(stored.owner, this.descriptor.recoveryIdentity) !== processId)
      throw new Error(
        `Sandbox process owner record does not match its process identity: ${processId}`
      );
    return stored;
  }

  #reconciliationResult(): CommandReconciliationResult {
    return Object.freeze({
      resolved: Object.freeze([...this.#recovered.keys()].sort()),
      unresolved: Object.freeze(
        [...this.#unresolved.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([processId, value]) => Object.freeze({ processId, ...value }))
      )
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

function renderOutput(
  observation: SandboxExecutionObservation,
  outputTokenBudget: number,
  afterCursor: number
): RenderedOutput {
  nonnegative(outputTokenBudget, 'outputTokenBudget');
  const output = observation.output;
  const end = afterCursor + Math.min(64 * 1024, outputTokenBudget * 4);
  const chunks =
    output.kind === 'available'
      ? output.chunks
          .filter((chunk) => chunk.cursorStart < end && chunk.cursorEnd > afterCursor)
          .map((chunk) => {
            const start = Math.max(afterCursor, chunk.cursorStart),
              stop = Math.min(end, chunk.cursorEnd);
            return {
              ...chunk,
              cursorStart: start,
              cursorEnd: stop,
              data: chunk.data.subarray(start - chunk.cursorStart, stop - chunk.cursorStart)
            };
          })
      : [];
  const cursorEnd = chunks.at(-1)?.cursorEnd ?? afterCursor;
  const availableEnd = output.kind === 'available' ? output.availableCursorEnd : afterCursor;
  const view = (stream?: 'stdout' | 'stderr') => {
    const selected = chunks
      .filter((chunk) => stream === undefined || stream === chunk.stream)
      .map((chunk) => chunk.data);
    const observed =
      output.kind !== 'available'
        ? 0
        : stream === 'stdout'
          ? output.stdoutBytes
          : stream === 'stderr'
            ? output.stderrBytes
            : output.stdoutBytes + output.stderrBytes;
    return outputView(selected, observed, afterCursor === 0, cursorEnd === availableEnd);
  };
  return {
    cursorStart: afterCursor,
    cursorEnd,
    stdout: view('stdout'),
    stderr: view('stderr'),
    combined: view()
  };
}

function outputView(
  chunks: readonly Buffer[],
  observedBytes: number,
  startsAtOutputStart: boolean,
  endsAtOutputEnd: boolean
): CommandOutputView {
  const bytes = Buffer.concat(chunks);
  return Object.freeze({
    text: redactTextPreservingLength(bytes.toString('utf8')).text,
    observedBytes,
    capturedBytes: bytes.length,
    omittedBytes: Math.max(0, observedBytes - bytes.length),
    startsAtOutputStart,
    endsAtOutputEnd
  });
}

function statusFromTermination(
  termination: Extract<SandboxExecutionObservation, { kind: 'settled' }>['result']['termination']
): CommandExecutionStatus {
  if (termination.reason === 'exit') return 'exited';
  if (termination.reason === 'timeout') return 'timed_out';
  if (termination.reason === 'runtime-failure') return 'failed';
  return 'stopped';
}

function validateWorkspaceResource(run: SandboxDetachedRunOptions, canonicalRoot: string): void {
  const filesystem = run.policy.filesystem;
  const matches =
    filesystem.kind === 'isolated'
      ? filesystem.resources.filter((resource) => resource.source.path === canonicalRoot)
      : filesystem.resources.filter((resource) => resource.path.path === canonicalRoot);
  if (matches.length !== 1)
    throw new Error(
      'Sandbox command plan must contain exactly one resource for the adopted physical workspace root.'
    );
  if (run.process.stdout !== 'pipe' || run.process.stderr !== 'pipe')
    throw new Error(
      'Sandbox command plan must expose stdout and stderr as durable output streams.'
    );
}

function processIdentity(owner: CommandExecutionOwner, recoveryIdentity: string): string {
  const identity = JSON.stringify([
    recoveryIdentity,
    owner.ownerId,
    owner.runId,
    owner.turnId,
    owner.toolBatchId,
    owner.callIndex
  ]);
  return `sandbox-${createHash('sha256').update(identity).digest('hex')}`;
}

function ownerPath(processId: string): string {
  if (!/^sandbox-[a-f0-9]{64}$/u.test(processId))
    throw new TypeError('Invalid sandbox process identity.');
  return `sandbox-processes/${processId}.json`;
}

function validateOwner(value: unknown): asserts value is CommandExecutionOwner {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Command execution owner must be an object.');
  const source = value as Record<string, unknown>;
  const callIndex = source.callIndex;
  if (
    !identity(source.ownerId) ||
    !identity(source.runId) ||
    !identity(source.turnId) ||
    !identity(source.toolBatchId) ||
    typeof callIndex !== 'number' ||
    !Number.isSafeInteger(callIndex) ||
    callIndex < 0
  )
    throw new TypeError('Command execution owner is invalid.');
}

function decodeStoredOwner(text: string, processId: string): StoredOwner {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Sandbox process owner record is not valid JSON: ${processId}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`Sandbox process owner record is invalid: ${processId}`);
  const source = value as Record<string, unknown>;
  if (
    Object.keys(source).some(
      (key) =>
        ![
          'schemaVersion',
          'processId',
          'owner',
          'command',
          'requestDigest',
          'authorization'
        ].includes(key)
    ) ||
    typeof source.command !== 'string' ||
    source.command.length === 0
  )
    throw new Error(`Incompatible command owner record: ${processId}`);
  if (source.schemaVersion !== 1 || source.processId !== processId)
    throw new Error(`Sandbox process owner record identity is invalid: ${processId}`);
  const requestDigest = source.requestDigest;
  if (
    requestDigest !== undefined &&
    (typeof requestDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(requestDigest))
  ) {
    throw new Error(`Sandbox process request binding is invalid: ${processId}`);
  }
  validateOwner(source.owner);
  const authorization =
    source.authorization === undefined ? undefined : parseJsonObject(source.authorization);
  if (requestDigest === undefined && authorization !== undefined)
    throw new Error(`Sandbox authorization has no request binding: ${processId}`);
  if (requestDigest === undefined)
    return Object.freeze({
      schemaVersion: 1,
      processId,
      command: source.command,
      owner: ownOwner(source.owner)
    });
  return Object.freeze({
    schemaVersion: 1,
    processId,
    command: source.command,
    owner: ownOwner(source.owner),
    requestDigest,
    ...(authorization === undefined ? {} : { authorization })
  });
}

function sandboxCommandAuthorization(
  descriptor: CommandExecutionDescriptor,
  authorization: Extract<SandboxExecutionObservation, { readonly kind: 'prepared' }>
): JsonObject {
  return parseJsonObject({
    authority: descriptor.implementationId,
    confinement:
      authorization.summary.filesystem.kind === 'isolated'
        ? 'isolated workspace'
        : 'workspace confined',
    recoveryIdentity: descriptor.recoveryIdentity,
    executionId: authorization.executionId,
    requestDigest: authorization.requestDigest,
    policyDigest: authorization.policyDigest,
    executionDigest: authorization.executionDigest,
    summary: authorization.summary,
    enforcement: authorization.enforcement,
    expiresAt: new Date(authorization.expiresAtMs).toISOString()
  });
}

function assertRequestBinding(owner: StoredOwner, observation: SandboxExecutionObservation): void {
  if (
    observation.requestDigest !== undefined &&
    owner.requestDigest !== undefined &&
    owner.requestDigest !== observation.requestDigest
  ) {
    throw new Error(
      `Sandbox execution does not match its durable request binding: ${observation.executionId}`
    );
  }
}

function ownOwner(owner: CommandExecutionOwner): CommandExecutionOwner {
  return Object.freeze({
    ownerId: owner.ownerId,
    runId: owner.runId,
    turnId: owner.turnId,
    toolBatchId: owner.toolBatchId,
    callIndex: owner.callIndex
  });
}

function assertRequester(
  owner: CommandExecutionOwner,
  requester: CommandExecutionOwner | undefined,
  processId: string
): void {
  if (requester && owner.ownerId !== requester.ownerId)
    throw new Error(`Sandbox process belongs to another resource owner: ${processId}`);
}

function sameOwner(left: CommandExecutionOwner, right: CommandExecutionOwner): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.runId === right.runId &&
    left.turnId === right.turnId &&
    left.toolBatchId === right.toolBatchId &&
    left.callIndex === right.callIndex
  );
}

function identity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !hasControlCharacter(value)
  );
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
  if (observation.kind === 'retired') return `Execution retired: ${observation.reason}.`;
  return `Execution remains ${observation.kind}; reconcile or terminate it before starting more commands.`;
}

function nonnegative(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${label} must be non-negative.`);
  return value;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(
        typeof signal.reason === 'string' ? signal.reason : 'Command execution was aborted.'
      );
}

import { randomUUID } from 'node:crypto';
import { hashJson, redactTextPreservingLength } from '@agent-core/persistence';
import { withPersistenceFileLock } from '@agent-core/persistence/node';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
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
  type CommandUncertaintyAcceptance,
  type CommandTerminalSize,
  type ResourceLeaseCoordinator,
  type StartCommandExecutionOptions
} from '@agent-core/tools';
import { processScope } from '@agent-core/tools-local';
import type {
  OutputChunk,
  ProcessInspection,
  ReceiptView,
  Sandbox,
  SandboxEvent,
  SandboxProcess,
  SandboxTerminal
} from 'sandsurf';
import type { PrivateStateDirectory } from '../state/private-state.js';
import type { CodingProcess } from './coding-command-authority.js';
import {
  SandsurfCommandObservations,
  type SandsurfCommandIdentity,
  type SandsurfObservationOptions
} from './sandsurf-command-observations.js';

interface StoredProcess {
  readonly schemaVersion: 1;
  readonly sandboxId: string;
  readonly epoch: number;
  readonly configurationRevision: number;
  readonly processId: string;
  readonly operationId: string;
  readonly request: CommandExecutionPlanRequest;
  readonly requestDigest: string;
  /** Replay observation only; it carries no runtime authority. */
  readonly eventCursor: number;
  readonly acknowledged: boolean;
  readonly acceptedUncertainty?: string;
}

interface PlannedCommand {
  readonly request: CommandExecutionPlanRequest;
  readonly processId: string;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly epoch: number;
  readonly configurationRevision: number;
  state: 'planned' | 'started' | 'released';
}

export interface SandsurfCommandExecutionOptions extends SandsurfObservationOptions {
  readonly sandbox: Sandbox;
  readonly epoch: number;
  readonly configurationRevision: number;
  readonly state: PrivateStateDirectory;
  readonly resourceLeases: ResourceLeaseCoordinator;
  readonly descriptor: CommandExecutionDescriptor;
}

export class SandsurfCommandExecution implements CommandExecution {
  readonly descriptor: CommandExecutionDescriptor;
  readonly resourceLeases: ResourceLeaseCoordinator;
  readonly #plans = new WeakMap<CommandExecutionReservation, PlannedCommand>();
  readonly #terminals = new Map<string, SandboxTerminal>();
  readonly #recovered = new Map<string, CommandExecutionReport>();
  readonly #unresolved = new Map<string, string>();
  readonly #observations: SandsurfCommandObservations;
  readonly #pending = new Map<string, Promise<unknown>>();
  readonly #observers = new Map<
    string,
    { controller: AbortController; completion: Promise<void> }
  >();
  #closed = false;

  constructor(private readonly options: SandsurfCommandExecutionOptions) {
    this.descriptor = options.descriptor;
    this.resourceLeases = options.resourceLeases;
    this.#observations = new SandsurfCommandObservations(options);
    adoptCommandExecution(this);
  }

  plan(request: CommandExecutionPlanRequest): Promise<CommandExecutionReservation> {
    this.#ensureOpen();
    const identity = hashJson({
      authority: this.descriptor.recoveryIdentity,
      epoch: this.options.epoch,
      owner: request.owner
    });
    const processId = `process-${identity}`;
    const operationId = `spawn-${identity}`;
    const requestDigest = digest({
      sandboxId: this.options.sandbox.id,
      epoch: this.options.epoch,
      configurationRevision: this.options.configurationRevision,
      processId,
      operationId,
      request
    });
    const planned: PlannedCommand = {
      request: ownRequest(request),
      processId,
      operationId,
      requestDigest,
      epoch: this.options.epoch,
      configurationRevision: this.options.configurationRevision,
      state: 'planned'
    };
    const reservation = createCommandExecutionReservation(
      {
        authority: 'sandsurf',
        sandboxId: this.options.sandbox.id,
        epoch: planned.epoch,
        configurationRevision: planned.configurationRevision,
        capability: 'spawn',
        processId,
        operationId,
        requestDigest,
        request: planned.request
      },
      () => {
        if (planned.state === 'planned') planned.state = 'released';
      }
    );
    this.#plans.set(reservation, planned);
    return Promise.resolve(reservation);
  }

  async start(
    reservation: CommandExecutionReservation,
    options: StartCommandExecutionOptions = {}
  ): Promise<CommandExecutionResult> {
    this.#ensureOpen();
    const planned = this.#plans.get(reservation);
    if (planned?.state !== 'planned')
      throw new Error('Sandsurf command reservation is invalid or already consumed.');
    throwIfAborted(options.signal);
    planned.state = 'started';
    const terminal = planned.request.pty;
    const lifetime = planned.request.lifetime ?? 'job';
    const elapsedDeadlineUnixMs = Date.now() + planned.request.timeoutMs;
    if (!Number.isSafeInteger(elapsedDeadlineUnixMs))
      throw new Error('Sandsurf command deadline exceeds the supported timestamp range.');
    const { stored, created } = await this.#recordIntent({
      schemaVersion: 1,
      sandboxId: this.options.sandbox.id,
      epoch: planned.epoch,
      configurationRevision: planned.configurationRevision,
      processId: planned.processId,
      operationId: planned.operationId,
      request: planned.request,
      requestDigest: planned.requestDigest,
      acknowledged: false
    });
    if (!created) {
      return this.query(
        stored.processId,
        stored.request.outputTokenBudget,
        stored.request.yieldMs,
        0,
        stored.request.owner
      );
    }
    // Once dispatch starts its outcome can be unknown. Preserve the effect lease
    // until an observation establishes settlement or the user accepts uncertainty.
    options.lease?.transferToResource(planned.processId, processScope(planned.processId));
    let process: SandboxProcess;
    try {
      // Process lifetime and interactive input ownership are independent. Acquire
      // the terminal input lease only when a caller actually sends input.
      process = await this.options.sandbox.processes.spawn({
        processId: planned.processId,
        operationId: planned.operationId,
        expectedEpoch: planned.epoch,
        expectedRevision: planned.configurationRevision,
        user: 'agent',
        argv: ['/bin/sh', '-lc', planned.request.command],
        cwd: guestDirectory(planned.request.rootedDirectory),
        stdio: terminal ? 'terminal' : 'pipes',
        lifetime: lifetime === 'environment' ? 'sandbox' : 'job',
        elapsedDeadlineUnixMs,
        outputBytes: 64 * 1024 * 1024
      });
    } catch (error) {
      this.#markUnresolved(stored, error);
      throw error;
    }
    this.resourceLeases.releaseResource(stored.processId);
    this.#observeProcess(stored.processId);
    if (options.onProgress)
      await deliverProgress(options.onProgress, {
        type: 'status',
        stage: 'process_started',
        message: `Sandsurf process ${planned.processId} started.`
      });
    return this.#queryProcess(
      process,
      stored,
      planned.request.outputTokenBudget,
      planned.request.yieldMs,
      0,
      options
    );
  }

  async query(
    processId: string,
    outputTokenBudget: number,
    yieldMs = 0,
    afterCursor = 0,
    requester?: CommandExecutionOwner
  ): Promise<CommandExecutionResult> {
    this.#ensureOpen();
    const stored = await this.#stored(processId);
    assertRequester(stored.request.owner, requester);
    const recorded = await this.#observations.terminal(commandIdentity(stored));
    if (recorded) {
      await this.#retryAcknowledgement(stored);
      return this.#observations.present(
        commandIdentity(stored),
        withEventCursor(recorded.result, stored),
        afterCursor,
        outputTokenBudget
      );
    }
    return this.#queryProcess(
      await this.options.sandbox.processes.get(processId),
      stored,
      outputTokenBudget,
      yieldMs,
      afterCursor
    );
  }

  async writeInput(
    processId: string,
    text: string,
    requester?: CommandExecutionOwner
  ): Promise<void> {
    this.#ensureOpen();
    const stored = await this.#stored(processId);
    assertRequester(stored.request.owner, requester);
    if (stored.request.pty)
      await (
        await this.#terminal(processId)
      ).input.write(Buffer.from(text), this.#controlPreconditions(stored));
    else
      await (
        await this.options.sandbox.processes.get(processId)
      ).input.write(Buffer.from(text), this.#controlPreconditions(stored));
  }

  async closeInput(processId: string, requester?: CommandExecutionOwner): Promise<void> {
    this.#ensureOpen();
    const stored = await this.#stored(processId);
    assertRequester(stored.request.owner, requester);
    if (stored.request.pty) {
      // PTYs have no half-close. Send the configured terminal EOF character;
      // input-lease release remains a separate detach operation.
      await (
        await this.#terminal(processId)
      ).input.write(Uint8Array.of(4), this.#controlPreconditions(stored));
    } else
      await (
        await this.options.sandbox.processes.get(processId)
      ).input.close(this.#controlPreconditions(stored));
  }

  async resize(
    processId: string,
    size: CommandTerminalSize,
    requester?: CommandExecutionOwner
  ): Promise<void> {
    this.#ensureOpen();
    const stored = await this.#stored(processId);
    assertRequester(stored.request.owner, requester);
    if (!stored.request.pty) throw new Error(`Process ${processId} has no terminal.`);
    await (await this.#terminal(processId)).resize(size, this.#controlPreconditions(stored));
  }

  async terminate(
    processId: string,
    requester?: CommandExecutionOwner
  ): Promise<CommandExecutionResult> {
    this.#ensureOpen();
    const stored = await this.#stored(processId);
    assertRequester(stored.request.owner, requester);
    const known = await this.#observations.terminal(commandIdentity(stored));
    if (known) return known.result;
    const process = await this.options.sandbox.processes.get(processId);
    const observation = await process.inspect();
    if (observation.kind === 'current') assertInspection(stored, observation.value);
    if (observation.kind === 'current' && observation.value.state.kind === 'running')
      await process.terminate({ graceMillis: 1_000, ...this.#controlPreconditions(stored) });
    return this.#queryProcess(process, stored, 4_000, 30_000, 0);
  }

  async disposeOwner(ownerId: string): Promise<readonly CommandExecutionReport[]> {
    const reports: CommandExecutionReport[] = [];
    for (const process of await this.listProcesses()) {
      if (process.owner.ownerId !== ownerId) continue;
      const stored = await this.#stored(process.processId);
      if (stored.request.lifetime === 'environment') continue;
      const result = await this.terminate(process.processId, stored.request.owner);
      const report = this.#recovered.get(process.processId);
      if (report) reports.push(report);
      else reports.push({ result });
    }
    return Object.freeze(reports);
  }

  recoveredTerminalReports(): readonly CommandExecutionReport[] {
    return Object.freeze([...this.#recovered.values()]);
  }

  async acknowledgeTerminalReport(processId: string): Promise<void> {
    await this.#updateStored(processId, () => ({ acknowledged: true }));
    this.#recovered.delete(processId);
  }

  async reconcile(): Promise<CommandReconciliationResult> {
    this.#ensureOpen();
    for (const stored of await this.#bindings()) {
      try {
        const known = await this.#observations.terminal(commandIdentity(stored));
        if (known) {
          await this.#retryAcknowledgement(stored);
          this.resourceLeases.releaseResource(stored.processId);
          if (!stored.acknowledged) this.#recovered.set(stored.processId, known);
          this.#unresolved.delete(stored.processId);
          continue;
        }
        const observed = await (
          await this.options.sandbox.processes.get(stored.processId)
        ).inspect();
        const revision = hashJson(observed);
        if (observed.kind === 'current') assertInspection(stored, observed.value);
        if (observed.kind !== 'current' || observed.value.state.kind === 'unknown') {
          if (stored.acceptedUncertainty === revision) {
            this.#unresolved.delete(stored.processId);
            this.resourceLeases.releaseResource(stored.processId);
          } else
            this.#markUnresolved(
              stored,
              new Error('Sandsurf cannot establish the command outcome.')
            );
          continue;
        }
        this.#unresolved.delete(stored.processId);
        this.resourceLeases.releaseResource(stored.processId);
        await this.query(stored.processId, 0, 0, 0, stored.request.owner);
        if (observed.value.state.kind === 'running') this.#observeProcess(stored.processId);
      } catch (error) {
        if (stored.acceptedUncertainty === unavailableRevision(stored.processId, error)) {
          this.#unresolved.delete(stored.processId);
          this.resourceLeases.releaseResource(stored.processId);
        } else this.#markUnresolved(stored, error);
      }
    }
    return this.#reconciliationResult();
  }

  retryReconciliation(): Promise<CommandReconciliationResult> {
    return this.reconcile();
  }

  async acknowledgeUnresolved(acceptances: readonly CommandUncertaintyAcceptance[]): Promise<void> {
    this.#ensureOpen();
    for (const { processId, revision: expectedRevision } of acceptances) {
      const stored = await this.#stored(processId);
      let observed;
      let revision: string;
      try {
        observed = await (await this.options.sandbox.processes.get(processId)).inspect();
        if (observed.kind === 'current') assertInspection(stored, observed.value);
        revision = hashJson(observed);
      } catch (error) {
        revision = unavailableRevision(processId, error);
      }
      if (observed?.kind === 'current' && observed.value.state.kind !== 'unknown')
        throw new Error('Command observation changed; refresh before accepting uncertainty.');
      if (revision !== expectedRevision)
        throw new Error('Command evidence changed; refresh before accepting uncertainty.');
      await this.#updateStored(processId, () => ({ acceptedUncertainty: revision }));
      this.#unresolved.delete(processId);
      this.resourceLeases.releaseResource(processId);
    }
  }

  async listProcesses(): Promise<readonly CodingProcess[]> {
    this.#ensureOpen();
    const values: CodingProcess[] = [];
    for (const stored of await this.#bindings()) {
      const recorded = await this.#observations.terminal(commandIdentity(stored));
      let status: CodingProcess['status'];
      let revision: string;
      let diagnostic: string | undefined;
      if (recorded) {
        status = recorded.result.status;
        revision = hashJson(recorded.result);
        diagnostic = recorded.result.diagnostic;
      } else {
        try {
          const process = await this.options.sandbox.processes.get(stored.processId);
          const observed = await process.inspect();
          revision = hashJson(observed);
          if (observed.kind === 'current') assertInspection(stored, observed.value);
          if (observed.kind !== 'current' || observed.value.state.kind === 'unknown') {
            status = stored.acceptedUncertainty === revision ? 'acknowledged-unknown' : 'unknown';
            diagnostic = 'Sandsurf cannot establish the command outcome.';
          } else status = commandStatus(observed.value, await process.receipt());
        } catch (error) {
          diagnostic = errorMessage(error);
          revision = unavailableRevision(stored.processId, error);
          status = stored.acceptedUncertainty === revision ? 'acknowledged-unknown' : 'unknown';
        }
      }
      values.push({
        command: stored.request.command,
        revision,
        processId: stored.processId,
        owner: stored.request.owner,
        status,
        ...(diagnostic ? { diagnostic } : {})
      });
    }
    return Object.freeze(values);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const observer of this.#observers.values()) observer.controller.abort();
    await Promise.allSettled([...this.#observers.values()].map((observer) => observer.completion));
    await Promise.allSettled(this.#pending.values());
    const terminals = [...this.#terminals.values()];
    this.#terminals.clear();
    const results = await Promise.allSettled(
      terminals.map(async (terminal) => {
        const stored = await this.#stored(terminal.id);
        await terminal.detach(this.#controlPreconditions(stored));
      })
    );
    const failures: unknown[] = [];
    for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, 'Terminal input lease release failed.');
  }

  async #queryProcess(
    process: SandboxProcess,
    stored: StoredProcess,
    outputTokenBudget: number,
    yieldMs: number,
    afterCursor: number,
    options: StartCommandExecutionOptions = {}
  ): Promise<CommandExecutionResult> {
    nonnegative(outputTokenBudget, 'outputTokenBudget');
    nonnegative(afterCursor, 'afterCursor');
    nonnegative(yieldMs, 'yieldMs');
    const deadline = Date.now() + yieldMs;
    let current = stored;
    let result: CommandExecutionResult;
    throwIfAborted(options.signal);
    let observed = await process.inspect();
    if (observed.kind !== 'current')
      throw new Error(`Sandsurf process ${process.id} is currently unavailable.`);
    result = await this.#result(
      process,
      current,
      observed.value,
      afterCursor,
      outputTokenBudget,
      current.eventCursor
    );
    while (
      result.status === 'running' &&
      result.cursorEnd <= afterCursor &&
      Date.now() < deadline
    ) {
      current = await this.#waitForProcessEvent(current, deadline, options.signal);
      throwIfAborted(options.signal);
      observed = await process.inspect();
      if (observed.kind !== 'current')
        throw new Error(`Sandsurf process ${process.id} is currently unavailable.`);
      result = await this.#result(
        process,
        current,
        observed.value,
        afterCursor,
        outputTokenBudget,
        current.eventCursor
      );
    }
    const presented = await this.#serial(stored.processId, async () => {
      if (result.status === 'running') {
        await this.#observations.capture(commandIdentity(stored), process);
        return result;
      }
      const report = await this.#settle(process, stored, result);
      return this.#observations.present(
        commandIdentity(stored),
        withEventCursor(report.result, await this.#stored(stored.processId)),
        afterCursor,
        outputTokenBudget
      );
    });
    if (options.onProgress) {
      const views = presented.terminal
        ? [['terminal', presented.terminal] as const]
        : [['stdout', presented.stdout] as const, ['stderr', presented.stderr] as const];
      for (const [index, [stream, view]] of views.entries())
        if (view.text.length > 0)
          await deliverProgress(options.onProgress, {
            type: 'output',
            stream,
            sequence: index,
            text: view.text,
            observedBytes: view.observedBytes
          });
    }
    return presented;
  }

  async #result(
    process: SandboxProcess,
    stored: StoredProcess,
    inspection: ProcessInspection,
    afterCursor: number,
    outputTokenBudget: number,
    eventCursor: number
  ): Promise<CommandExecutionResult> {
    assertInspection(stored, inspection);
    if (inspection.state.kind === 'unknown')
      throw new Error('Sandsurf recorded an unknown process outcome.');
    const receipt = inspection.state.kind === 'running' ? undefined : await process.receipt();
    if (inspection.state.kind !== 'running' && !receipt)
      throw new Error('Terminal command receipt is unavailable.');
    const maximum = Math.min(256 * 1024, Math.max(1, outputTokenBudget * 4));
    const page =
      outputTokenBudget === 0
        ? { after: afterCursor, available: afterCursor, chunks: [] as readonly OutputChunk[] }
        : await process.output
            .read({ after: Math.max(0, afterCursor - 4096), maximum: 256 * 1024 })
            .catch((error: unknown) => {
              if (!receipt) throw error;
              return {
                after: afterCursor,
                available: counter(receipt.receipt.output.finalCursor),
                chunks: [] as readonly OutputChunk[]
              };
            });
    const presentationChunks = redactOutputChunks(
      page.chunks,
      afterCursor,
      afterCursor + maximum,
      receipt !== undefined
    );
    const cursorEnd = presentationChunks.reduce(
      (cursor, chunk) => Math.max(cursor, chunk.cursor + chunk.bytes.byteLength),
      afterCursor
    );
    const boundary = receipt?.receipt.output;
    const status = commandStatus(inspection, receipt);
    const stdout = outputView(
      presentationChunks,
      'stdout',
      afterCursor,
      cursorEnd,
      boundary?.stdoutBytes
    );
    const stderr = outputView(
      presentationChunks,
      'stderr',
      afterCursor,
      cursorEnd,
      boundary?.stderrBytes
    );
    const terminal = stored.request.pty
      ? outputView(presentationChunks, 'terminal', afterCursor, cursorEnd, boundary?.terminalBytes)
      : undefined;
    const combinedObserved = boundary
      ? counter(boundary.finalCursor) + counter(boundary.omittedBytes)
      : page.available;
    const combined = outputView(
      presentationChunks,
      undefined,
      afterCursor,
      cursorEnd,
      combinedObserved
    );
    const outcome = receipt?.receipt.outcome;
    return {
      processId: process.id,
      owner: stored.request.owner,
      status,
      cursorStart: afterCursor,
      cursorEnd,
      eventCursor: {
        source: eventCursorSource(stored.sandboxId, stored.epoch),
        position: String(eventCursor)
      },
      stdout,
      stderr,
      ...(terminal ? { terminal } : {}),
      combined,
      ...(record(outcome) && outcome.kind === 'exit' && typeof outcome.code === 'number'
        ? { exitCode: outcome.code }
        : {}),
      ...(record(outcome) && outcome.kind === 'signal' && typeof outcome.signal === 'number'
        ? { signal: String(outcome.signal) }
        : {})
    };
  }

  async #settle(
    process: SandboxProcess,
    stored: StoredProcess,
    result: CommandExecutionResult
  ): Promise<CommandExecutionReport> {
    const receipt = await process.receipt();
    if (!receipt) throw new Error(`Sandsurf process ${process.id} has no terminal receipt.`);
    if (
      receipt.receipt.sandboxId !== stored.sandboxId ||
      receipt.receipt.epoch !== stored.epoch ||
      receipt.receipt.processId !== stored.processId ||
      receipt.receipt.operationId !== stored.operationId
    )
      throw new Error('Command receipt does not match its admitted execution.');
    const report = await this.#observations.settle(
      commandIdentity(stored),
      process,
      receipt,
      result
    );
    this.resourceLeases.releaseResource(stored.processId);
    this.#unresolved.delete(stored.processId);
    if (!stored.acknowledged) this.#recovered.set(stored.processId, report);
    return report;
  }

  async #retryAcknowledgement(stored: StoredProcess): Promise<void> {
    try {
      await this.#observations.acknowledge(
        commandIdentity(stored),
        await this.options.sandbox.processes.get(stored.processId)
      );
    } catch {
      /* The durable settlement remains authoritative if the host is unavailable. */
    }
  }

  async #terminal(processId: string): Promise<SandboxTerminal> {
    const cached = this.#terminals.get(processId);
    if (cached) return cached;
    const terminal = await this.options.sandbox.terminals.get(processId);
    const stored = await this.#stored(processId);
    await terminal.acquireInput({
      ...this.#controlPreconditions(stored),
      leaseId: `input-${processId}`,
      operationId: `acquire-${randomUUID()}`
    });
    this.#terminals.set(processId, terminal);
    return terminal;
  }

  async #waitForProcessEvent(
    stored: StoredProcess,
    deadline: number,
    signal?: AbortSignal
  ): Promise<StoredProcess> {
    if (Date.now() >= deadline) return stored;
    const controller = new AbortController();
    const abort = () => {
      controller.abort(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => {
        controller.abort();
      },
      Math.max(1, deadline - Date.now())
    );
    let current = stored;
    try {
      for await (const event of this.options.sandbox.events.follow({
        after: stored.eventCursor,
        signal: controller.signal
      })) {
        current = await this.#advanceEventCursor(current, event.cursor);
        if (eventBelongsToProcess(event, stored.processId)) return current;
        if (Date.now() >= deadline) return current;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    if (signal?.aborted === true) throw abortError(signal);
    return current;
  }

  async #advanceEventCursor(stored: StoredProcess, cursor: number): Promise<StoredProcess> {
    if (!Number.isSafeInteger(cursor) || cursor <= stored.eventCursor) return stored;
    return this.#updateStored(stored.processId, (latest) => ({
      eventCursor: Math.max(latest.eventCursor, cursor)
    }));
  }

  async #stored(processId: string): Promise<StoredProcess> {
    const source = await this.options.state.read(ownerPath(this.options.sandbox.id, processId));
    if (source === undefined)
      throw new Error(`Sandsurf process ${processId} has no application owner binding.`);
    const parsed = storedProcessSchema.safeParse(JSON.parse(source));
    if (
      !parsed.success ||
      parsed.data.sandboxId !== this.options.sandbox.id ||
      parsed.data.processId !== processId
    )
      throw new Error(
        `Sandsurf process ${processId} has an invalid or incompatible application binding.`
      );
    const value = parsed.data;
    const { sandboxId, epoch, configurationRevision, operationId, request } = value;
    if (
      digest({ sandboxId, epoch, configurationRevision, processId, operationId, request }) !==
      value.requestDigest
    )
      throw new Error('Command binding request digest is invalid.');
    const { lifetime, ...requestFields } = value.request;
    const { acceptedUncertainty, ...fields } = value;
    return {
      ...fields,
      request: { ...requestFields, ...(lifetime === undefined ? {} : { lifetime }) },
      ...(acceptedUncertainty === undefined ? {} : { acceptedUncertainty })
    };
  }

  #recordIntent(
    value: Omit<StoredProcess, 'eventCursor'>
  ): Promise<{ readonly stored: StoredProcess; readonly created: boolean }> {
    return withPersistenceFileLock(
      path.join(this.options.state.path, ownerPath(value.sandboxId, value.processId)),
      10_000,
      30_000,
      async (assertOwned) => {
        if (
          (await this.options.state.read(ownerPath(value.sandboxId, value.processId))) !== undefined
        ) {
          const stored = await this.#stored(value.processId);
          if (stored.requestDigest !== value.requestDigest)
            throw new Error('Command identity is already bound to another request.');
          return { stored, created: false };
        }
        // Capture the replay boundary only for a new intent. An existing known
        // outcome remains readable even when the runtime is unreachable.
        const boundary = await this.options.sandbox.events.read({ maximum: 1 });
        const stored: StoredProcess = { ...value, eventCursor: boundary.available };
        await assertOwned();
        await this.#writeStored(stored);
        return { stored, created: true };
      }
    );
  }

  #updateStored(
    processId: string,
    update: (
      latest: StoredProcess
    ) => Partial<Pick<StoredProcess, 'eventCursor' | 'acknowledged' | 'acceptedUncertainty'>>
  ): Promise<StoredProcess> {
    return withPersistenceFileLock(
      path.join(this.options.state.path, ownerPath(this.options.sandbox.id, processId)),
      10_000,
      30_000,
      async (assertOwned) => {
        const latest = await this.#stored(processId);
        const value = { ...latest, ...update(latest) };
        await assertOwned();
        await this.#writeStored(value);
        return value;
      }
    );
  }

  #writeStored(value: StoredProcess): Promise<void> {
    return this.options.state.write(
      ownerPath(value.sandboxId, value.processId),
      JSON.stringify(value)
    );
  }

  async #bindings(): Promise<readonly StoredProcess[]> {
    let entries: string[];
    try {
      entries = await readdir(
        path.join(this.options.state.path, 'sandsurf/processes', this.options.sandbox.id)
      );
    } catch (error) {
      if (record(error) && error.code === 'ENOENT') return [];
      throw error;
    }
    return Promise.all(
      entries
        .filter((name) => /^process-[a-f0-9]{64}\.json$/u.test(name))
        .map((name) => this.#stored(name.slice(0, -5)))
    );
  }

  #serial<T>(processId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#pending.get(processId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(action);
    this.#pending.set(processId, pending);
    void pending
      .finally(() => {
        if (this.#pending.get(processId) === pending) this.#pending.delete(processId);
      })
      .catch(() => undefined);
    return pending;
  }

  #markUnresolved(stored: StoredProcess, error: unknown): void {
    const diagnostic = errorMessage(error);
    this.#unresolved.set(stored.processId, diagnostic);
    this.resourceLeases.restoreResource(
      stored.processId,
      commandEffects,
      processScope(stored.processId)
    );
    this.resourceLeases.failResource(
      stored.processId,
      new Error(`Command needs reconciliation: ${diagnostic}`)
    );
  }

  #observeProcess(processId: string): void {
    if (this.#closed || this.#observers.has(processId)) return;
    const controller = new AbortController();
    const completion = (async () => {
      try {
        const process = await this.options.sandbox.processes.get(processId);
        for (;;) {
          if (controller.signal.aborted) return;
          const stored = await this.#stored(processId);
          const result = await this.#queryProcess(process, stored, 0, 1_000, 0, {
            signal: controller.signal
          });
          if (result.status !== 'running') return;
        }
      } catch (error) {
        if (!controller.signal.aborted) this.#markUnresolved(await this.#stored(processId), error);
      }
    })();
    this.#observers.set(processId, { controller, completion });
    void completion.finally(() => this.#observers.delete(processId)).catch(() => undefined);
  }

  async #reconciliationResult(): Promise<CommandReconciliationResult> {
    const processes = await this.listProcesses();
    return Object.freeze({
      resolved: Object.freeze([...this.#recovered.keys()]),
      unresolved: Object.freeze(
        processes
          .filter((process) => this.#unresolved.has(process.processId))
          .map((process) => ({
            processId: process.processId,
            revision: process.revision,
            rootPath: '/workspace',
            diagnostic: this.#unresolved.get(process.processId) ?? 'Command outcome is unknown.'
          }))
      )
    });
  }

  #controlPreconditions(stored: StoredProcess) {
    return { expectedEpoch: stored.epoch, expectedRevision: this.options.configurationRevision };
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error('Sandsurf command execution is closed.');
  }
}

function ownRequest(request: CommandExecutionPlanRequest): CommandExecutionPlanRequest {
  return Object.freeze({ ...request, owner: Object.freeze({ ...request.owner }) });
}

function ownerPath(sandboxId: string, processId: string): string {
  return `sandsurf/processes/${sandboxId}/${processId}.json`;
}

function guestDirectory(rootedDirectory: string): string {
  const normalized = rootedDirectory === '.' ? '' : rootedDirectory;
  return normalized.length === 0 ? '/workspace' : `/workspace/${normalized}`;
}

function eventCursorSource(sandboxId: string, epoch: number): string {
  return `sandsurf:${sandboxId}:epoch:${String(epoch)}`;
}

function eventBelongsToProcess(event: SandboxEvent, processId: string): boolean {
  const value = event.value;
  if (
    (value.kind === 'output' || value.kind === 'receipt' || value.kind === 'evidence-release') &&
    value.processId === processId
  )
    return true;
  return (
    value.kind === 'process' &&
    record(value.process) &&
    record(value.process.request) &&
    value.process.request.processId === processId
  );
}

function commandStatus(
  inspection: ProcessInspection,
  receipt: ReceiptView | undefined
): CommandExecutionStatus {
  if (inspection.state.kind === 'running') return 'running';
  const outcome = receipt?.receipt.outcome;
  if (!record(outcome)) throw new Error('Terminal command receipt is unavailable.');
  if (outcome.kind === 'exit') return 'exited';
  if (outcome.kind === 'signal') return 'stopped';
  if (outcome.kind === 'deadline-exceeded') return 'timed_out';
  if (outcome.kind === 'spawn-failed' || outcome.kind === 'interrupted') return 'failed';
  throw new Error('Sandsurf returned an invalid command outcome.');
}

function outputView(
  chunks: readonly OutputChunk[],
  stream: OutputChunk['stream'] | undefined,
  start: number,
  end: number,
  observedValue: unknown
): CommandOutputView {
  const selected = chunks.filter((chunk) => stream === undefined || chunk.stream === stream);
  const bytes = Buffer.concat(selected.map((chunk) => Buffer.from(chunk.bytes)));
  const observed =
    typeof observedValue === 'number' && Number.isSafeInteger(observedValue)
      ? observedValue
      : bytes.byteLength;
  return {
    text: redactTextPreservingLength(bytes.toString('utf8')).text,
    observedBytes: observed,
    capturedBytes: bytes.byteLength,
    omittedBytes: Math.max(0, observed - bytes.byteLength),
    startsAtOutputStart: start === 0,
    endsAtOutputEnd: end >= observed
  };
}

function assertRequester(owner: CommandExecutionOwner, requester?: CommandExecutionOwner): void {
  if (requester && requester.ownerId !== owner.ownerId)
    throw new Error('Sandsurf process belongs to another application owner.');
}

function digest(value: unknown): string {
  return hashJson(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason ?? 'aborted'));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortError(signal);
}

const ownerSchema = z.strictObject({
  ownerId: z.string().min(1),
  runId: z.string().min(1),
  turnId: z.string().min(1),
  toolBatchId: z.string().min(1),
  callIndex: z.int().nonnegative()
});
const storedProcessSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sandboxId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
  epoch: z.int().positive(),
  configurationRevision: z.int().nonnegative(),
  processId: z.string().regex(/^process-[a-f0-9]{64}$/u),
  operationId: z.string().min(1),
  request: z.strictObject({
    command: z.string().min(1),
    rootedDirectory: z.string().min(1),
    pty: z.boolean(),
    lifetime: z.enum(['job', 'environment']).optional(),
    timeoutMs: z.int().positive(),
    yieldMs: z.int().nonnegative(),
    outputTokenBudget: z.int().nonnegative(),
    owner: ownerSchema
  }),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  eventCursor: z.int().nonnegative(),
  acknowledged: z.boolean(),
  acceptedUncertainty: z.string().optional()
});
const commandEffects = Object.freeze({
  accesses: Object.freeze([{ mode: 'write' as const, scope: 'files' }]),
  lockScopes: Object.freeze(['files']),
  recovery: Object.freeze({ kind: 'unknown' as const })
});
function commandIdentity(stored: StoredProcess): SandsurfCommandIdentity {
  return {
    processId: stored.processId,
    requestDigest: stored.requestDigest,
    owner: stored.request.owner,
    sandboxId: stored.sandboxId,
    epoch: stored.epoch
  };
}
function assertInspection(stored: StoredProcess, view: ProcessInspection): void {
  if (
    view.request.processId !== stored.processId ||
    view.request.epoch !== stored.epoch ||
    view.request.operationId !== stored.operationId ||
    view.request.sandboxId !== stored.sandboxId
  )
    throw new Error('Process observation does not match its admitted execution.');
}
function nonnegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${label} must be a nonnegative safe integer.`);
}
async function deliverProgress(
  callback: NonNullable<StartCommandExecutionOptions['onProgress']>,
  progress: Parameters<NonNullable<StartCommandExecutionOptions['onProgress']>>[0]
): Promise<void> {
  try {
    await callback(progress);
  } catch {
    /* Progress delivery cannot change execution truth. */
  }
}

function counter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Sandsurf receipt counter is invalid.');
  return value;
}

function withEventCursor(
  result: CommandExecutionResult,
  stored: StoredProcess
): CommandExecutionResult {
  return {
    ...result,
    eventCursor: {
      source: eventCursorSource(stored.sandboxId, stored.epoch),
      position: String(stored.eventCursor)
    }
  };
}
function redactOutputChunks(
  chunks: readonly OutputChunk[],
  start: number,
  end: number,
  terminal: boolean
): readonly OutputChunk[] {
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.bytes)));
  const redacted = Buffer.from(redactTextPreservingLength(bytes.toString('latin1')).text, 'latin1');
  // A clipped line lacks enough context to safely classify a sensitive value.
  if ((chunks[0]?.cursor ?? 0) > 0)
    redacted.fill(42, 0, redacted.indexOf(10) < 0 ? redacted.length : redacted.indexOf(10));
  if (!terminal) redacted.fill(42, redacted.lastIndexOf(10) + 1);
  const available = redacted.length;
  let offset = 0;
  return chunks.flatMap((chunk) => {
    const from = Math.max(0, start - chunk.cursor);
    const to = Math.min(chunk.bytes.length, end - chunk.cursor, available - offset);
    const selected =
      to > from
        ? [
            {
              ...chunk,
              cursor: chunk.cursor + from,
              bytes: redacted.subarray(offset + from, offset + to)
            }
          ]
        : [];
    offset += chunk.bytes.length;
    return selected;
  });
}

function unavailableRevision(processId: string, error: unknown): string {
  return hashJson({ processId, diagnostic: errorMessage(error) });
}

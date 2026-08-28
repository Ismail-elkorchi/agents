import type { AgentSession, AgentEndedRunResult, AgentProgressEvent, AgentRunResult, AgentSessionSubmissionResult } from '@agent-core/runtime';
import { createTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import type { TerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { runTui } from '@ismail-elkorchi/terminal-ui/tui';
import type { TuiExit } from '@ismail-elkorchi/terminal-ui/tui';
import { executeInteractiveCommand } from './interactive-commands.js';
import { normalizeTaskInput } from './task-input.js';
import { createCodingAgentTuiApp } from './app.js';
import { CodingAgentTuiEventSource } from './event-source.js';
import type { CodingAgentTuiMessage } from './messages.js';
import type { CodingAgentTuiState } from './state.js';
import type { CodingAgentTuiRuntimeDetails } from './state.js';
import type { CodingAgentTuiHydration } from './hydration.js';
import type { RunChangeReport } from '../changes/run-change-report.js';

export class CodingAgentTuiProgressRenderer {
  private readonly dispatchReady = deferred<(message: CodingAgentTuiMessage) => void | Promise<void>>();
  private queue: Promise<void> = Promise.resolve();
  private attached = false;

  attachDispatch(dispatch: (message: CodingAgentTuiMessage) => void | Promise<void>): void {
    if (this.attached) throw new Error('Coding Agent TUI progress renderer is already attached.');
    this.attached = true;
    this.dispatchReady.resolve(dispatch);
  }

  handle(event: AgentProgressEvent): Promise<void> {
    return this.enqueue({ type: 'progress', event });
  }

  flush(): Promise<void> {
    return this.queue;
  }

  async showResult(result: AgentEndedRunResult): Promise<void> {
    await this.enqueue({ type: 'result', result });
  }

  async showSuspension(suspension: Extract<AgentRunResult, { state: 'suspended' }>): Promise<void> {
    await this.enqueue(suspension.reason === 'approval_required'
      ? { type: 'approval.required', suspension }
      : { type: 'operation.suspended', suspension });
  }

  async showFailure(message: string): Promise<void> {
    await this.enqueue({ type: 'failure', message });
  }

  async showSessionState(state: import('@agent-core/runtime').AgentSessionState): Promise<void> {
    await this.enqueue({ type: 'session.updated', state });
  }

  async showCompaction(compaction: import('@agent-core/runtime').SessionCompactionEntry): Promise<void> {
    await this.enqueue({ type: 'session.compacted', compaction });
  }

  async showChangeReport(report: RunChangeReport): Promise<void> {
    await this.enqueue({ type: 'change.reported', report });
  }

  private enqueue(message: CodingAgentTuiMessage): Promise<void> {
    const next = this.queue.then(async () => {
      const dispatch = await this.dispatchReady.promise;
      await dispatch(message);
    });
    this.queue = next;
    return next;
  }
}

export interface CodingAgentTuiAppRunOptions {
  readonly host?: TerminalHost;
  readonly initialTask?: string;
  readonly progress?: CodingAgentTuiProgressRenderer;
  readonly exitOnCompletion?: boolean;
  readonly runtimeDetails?: CodingAgentTuiRuntimeDetails;
  readonly loadHydration?: () => Promise<CodingAgentTuiHydration>;
  readonly loadChangeReport?: (runId: string) => Promise<RunChangeReport | undefined>;
}

export interface CodingAgentTuiAppRunResult {
  readonly exit: TuiExit<CodingAgentTuiState>;
  readonly result?: AgentRunResult;
}

export async function runCodingAgentTuiApp(
  session: AgentSession,
  options: CodingAgentTuiAppRunOptions = {}
): Promise<CodingAgentTuiAppRunResult> {
  const host = options.host ?? createTerminalHost({ runtime: 'node' });
  const ownsHost = options.host === undefined;
  const progress = options.progress ?? new CodingAgentTuiProgressRenderer();
  const events = new CodingAgentTuiEventSource();
  let result: AgentRunResult | undefined;
  let failure: Error | undefined;
  const exitOnCompletion = options.exitOnCompletion === true;
  let unsubscribe: (() => void) | undefined;
  let outcome!: Readonly<
    | { readonly kind: 'returned'; readonly value: CodingAgentTuiAppRunResult }
    | { readonly kind: 'failed'; readonly cause: unknown }
  >;
  const initialTask = options.initialTask === undefined
    ? undefined
    : normalizeTaskInput(options.initialTask);
  try {
    await session.restore();
    const hydration = await options.loadHydration?.();
    unsubscribe = session.subscribe(async (event) => {
      if (event.type === 'run.progress') {
        await progress.handle(event.event);
        return;
      }
      if (event.type === 'configuration.changed' || event.type === 'input.queued') {
        await progress.showSessionState(session.state());
        return;
      }
      if (event.type === 'compaction.completed') {
        await progress.showCompaction(event.compaction);
        await progress.showSessionState(session.state());
        return;
      }
      if (event.type === 'run.failed') {
        await progress.showFailure(event.error.message);
        if (exitOnCompletion) {
          failure = event.error;
          await events.enqueue({ type: 'app.exit', reason: 'failed' });
        }
        return;
      }
      result = event.result;
      if (event.result.state === 'suspended') await progress.showSuspension(event.result);
      else {
        await progress.showResult(event.result);
        const report = await options.loadChangeReport?.(event.runId);
        if (report !== undefined) await progress.showChangeReport(report);
      }
      await progress.showSessionState(session.state());
      if (exitOnCompletion && session.state().queuedInputs === 0) {
        await events.enqueue({ type: 'app.exit', reason: event.result.state === 'ended'
          ? `${event.result.terminal.executionStatus}:${event.result.terminal.verificationStatus}:${event.result.terminal.terminationReason}`
          : event.result.reason });
      }
    });
    const app = createCodingAgentTuiApp(normalizeTaskInput(initialTask ?? ''), {
      eventSource: events,
      ...(options.runtimeDetails === undefined ? {} : { runtimeDetails: options.runtimeDetails }),
      ...(hydration === undefined ? {} : { initialHydration: hydration }),
      approvalHandler: async (suspension, decision) => {
        const approval = suspension.pendingApprovals[0];
        if (approval === undefined) throw new Error('Approval suspension contains no pending request.');
        await session.resolveApproval({ runId: suspension.runId, approvalId: approval.approvalId, fingerprint: approval.fingerprint, decision });
      },
      commandHandler: {
        execute(line) {
          if (line === '/exit' || line === '/quit') {
            return { message: 'Exiting.', exit: true };
          }
          if (!line.startsWith('/')) return session.submit({ task: line }).then(submissionMessage);
          return executeInteractiveCommand(session, line);
        }
      }
    });
    const exit = runTui(app, { host });
    progress.attachDispatch((message) => events.enqueue(message));
    if (initialTask !== undefined && initialTask.length > 0) await session.submit({ task: initialTask });
    else if (session.state().queuedInputs > 0) await session.resumePending();
    const exitResult = await exit;
    unsubscribe();
    unsubscribe = undefined;
    const activeRunId = session.state().activeRunId;
    if (activeRunId !== undefined && session.state().phase !== 'waiting_for_user') {
      await session.abort('Coding Agent TUI closed.', activeRunId);
    }
    await session.waitForIdle();
    if (failure !== undefined) throw failure;
    outcome = {
      kind: 'returned',
      value: result === undefined ? { exit: exitResult } : { exit: exitResult, result }
    };
  } catch (cause) {
    outcome = { kind: 'failed', cause };
  }
  const cleanupFailures: unknown[] = [];
  try { await progress.flush(); } catch (cause) { cleanupFailures.push(cause); }
  try { unsubscribe?.(); } catch (cause) { cleanupFailures.push(cause); }
  try { await events.close(); } catch (cause) { cleanupFailures.push(cause); }
  if (ownsHost) {
    try { await host.dispose(); } catch (cause) { cleanupFailures.push(cause); }
  }
  const uniqueFailures = [...new Set(cleanupFailures)];
  if (outcome.kind === 'failed') {
    if (uniqueFailures.length === 0) throw outcome.cause;
    throw new AggregateError(
      [outcome.cause, ...uniqueFailures],
      'Coding Agent TUI run and cleanup failed.',
      { cause: outcome.cause }
    );
  }
  if (uniqueFailures.length > 0) throw new AggregateError(uniqueFailures, 'Coding Agent TUI cleanup failed.');
  return outcome.value;
}

export async function runCodingAgentTuiTask(
  session: AgentSession,
  task: string,
  progress: CodingAgentTuiProgressRenderer,
  options: {
    readonly host?: TerminalHost;
    readonly runtimeDetails?: CodingAgentTuiRuntimeDetails;
  } = {}
): Promise<AgentRunResult> {
  const appResult = await runCodingAgentTuiApp(session, {
    initialTask: task,
    progress,
    exitOnCompletion: true,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.runtimeDetails === undefined ? {} : { runtimeDetails: options.runtimeDetails })
  });
  if (appResult.result === undefined) {
    throw new Error('Agent TUI task ended without a run result.');
  }
  return appResult.result;
}

function submissionMessage(result: AgentSessionSubmissionResult): { readonly message: string } {
  switch (result.kind) {
    case 'started': return { message: 'Run started.' };
    case 'steered': return { message: 'Steering accepted.' };
    case 'queued': return { message: 'Follow-up queued.' };
    case 'rejected': return { message: `Input rejected: ${result.reason}.` };
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

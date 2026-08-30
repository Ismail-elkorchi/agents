import type { AgentEndedRunResult, AgentProgressEvent, AgentRunResult } from '@agent-core/runtime';
import { createTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import type { TerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { runTui } from '@ismail-elkorchi/terminal-ui/tui';
import type { TuiExit } from '@ismail-elkorchi/terminal-ui/tui';
import { normalizeTaskInput } from './task-input.js';
import { createCodingAgentTuiApp } from './app.js';
import { CodingAgentTuiEventSource } from './event-source.js';
import type { CodingAgentTuiMessage } from './messages.js';
import type { CodingAgentTuiState } from './state.js';
import type {
  CodingAgentInteractiveController,
  CodingAgentInteractiveEvent,
  CodingAgentInteractiveState
} from './interactive-controller.js';
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

  handle(event: AgentProgressEvent): Promise<void> { return this.enqueue({ type: 'progress', event }); }
  flush(): Promise<void> { return this.queue; }
  showResult(result: AgentEndedRunResult): Promise<void> { return this.enqueue({ type: 'result', result }); }
  showSuspension(suspension: Extract<AgentRunResult, { state: 'suspended' }>): Promise<void> {
    return this.enqueue(suspension.reason === 'approval_required'
      ? { type: 'approval.required', suspension }
      : { type: 'operation.suspended', suspension });
  }
  showFailure(message: string): Promise<void> { return this.enqueue({ type: 'failure', message }); }
  showCompaction(compaction: import('@agent-core/runtime').SessionCompactionEntry): Promise<void> {
    return this.enqueue({ type: 'session.compacted', compaction });
  }
  showChangeReport(report: RunChangeReport): Promise<void> { return this.enqueue({ type: 'change.reported', report }); }
  showInteractiveState(state: CodingAgentInteractiveState): Promise<void> {
    return this.enqueue({ type: 'interactive.state.changed', state });
  }
  showNotice(message: string, tone?: 'info' | 'warning' | 'error'): Promise<void> {
    return this.enqueue({ type: 'interactive.notice', message, ...(tone === undefined ? {} : { tone }) });
  }
  showHydration(hydration: CodingAgentTuiHydration): Promise<void> {
    return this.enqueue({ type: 'session.hydrated', hydration });
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
}

export interface CodingAgentTuiAppRunResult {
  readonly exit: TuiExit<CodingAgentTuiState>;
  readonly result?: AgentRunResult;
}

export async function runCodingAgentTuiApp(
  controller: CodingAgentInteractiveController,
  options: CodingAgentTuiAppRunOptions = {}
): Promise<CodingAgentTuiAppRunResult> {
  const host = options.host ?? createTerminalHost({ runtime: 'node' });
  const ownsHost = options.host === undefined;
  const progress = options.progress ?? new CodingAgentTuiProgressRenderer();
  const events = new CodingAgentTuiEventSource();
  const initialTask = normalizeTaskInput(options.initialTask ?? '');
  let result: AgentRunResult | undefined;
  let unsubscribe: (() => void) | undefined;
  let outcome!: Readonly<
    | { readonly kind: 'returned'; readonly value: CodingAgentTuiAppRunResult }
    | { readonly kind: 'failed'; readonly cause: unknown }
  >;
  try {
    const initial = controller.state();
    const app = createCodingAgentTuiApp(initialTask, {
      eventSource: events,
      runtimeDetails: initial.runtimeDetails,
      setup: { status: initial.status, requirements: initial.requirements },
      approvalHandler: (suspension, decision) => controller.resolveApproval(suspension, decision),
      commandHandler: {
        execute(line) {
          if (line === '/exit' || line === '/quit') return { message: 'Exiting.', exit: true };
          return line.startsWith('/') ? controller.execute(line) : controller.submit(line);
        }
      }
    });
    const exit = runTui(app, { host });
    progress.attachDispatch((message) => events.enqueue(message));
    unsubscribe = controller.subscribe(async (event) => {
      result = await presentControllerEvent(event, progress, result);
    });
    try { await controller.start(); }
    catch (error) { await progress.showFailure(errorMessage(error)); }
    if (initialTask.length > 0) await controller.submit(initialTask);
    const exitResult = await exit;
    unsubscribe();
    unsubscribe = undefined;
    await controller.close();
    outcome = {
      kind: 'returned',
      value: result === undefined ? { exit: exitResult } : { exit: exitResult, result }
    };
  } catch (cause) {
    outcome = { kind: 'failed', cause };
  }
  const cleanupFailures: unknown[] = [];
  try { unsubscribe?.(); } catch (cause) { cleanupFailures.push(cause); }
  try { await controller.close(); } catch (cause) { cleanupFailures.push(cause); }
  try { await progress.flush(); } catch (cause) { cleanupFailures.push(cause); }
  try { await events.close(); } catch (cause) { cleanupFailures.push(cause); }
  if (ownsHost) {
    try { await host.dispose(); } catch (cause) { cleanupFailures.push(cause); }
  }
  const uniqueFailures = [...new Set(cleanupFailures)];
  if (outcome.kind === 'failed') {
    if (uniqueFailures.length === 0) throw outcome.cause;
    throw new AggregateError([outcome.cause, ...uniqueFailures], 'Coding Agent TUI run and cleanup failed.', { cause: outcome.cause });
  }
  if (uniqueFailures.length > 0) throw new AggregateError(uniqueFailures, 'Coding Agent TUI cleanup failed.');
  return outcome.value;
}

async function presentControllerEvent(
  event: CodingAgentInteractiveEvent,
  progress: CodingAgentTuiProgressRenderer,
  currentResult: AgentRunResult | undefined
): Promise<AgentRunResult | undefined> {
  switch (event.type) {
    case 'interactive.state.changed': await progress.showInteractiveState(event.state); return currentResult;
    case 'interactive.notice': await progress.showNotice(event.message, event.tone); return currentResult;
    case 'session.hydrated': await progress.showHydration(event.hydration); return currentResult;
    case 'change.reported': await progress.showChangeReport(event.report); return currentResult;
    case 'run.progress': await progress.handle(event.event); return currentResult;
    case 'configuration.changed': return currentResult;
    case 'input.queued': return currentResult;
    case 'compaction.completed': await progress.showCompaction(event.compaction); return currentResult;
    case 'run.failed': await progress.showFailure(event.error.message); return currentResult;
    case 'run.completed':
      if (event.result.state === 'suspended') await progress.showSuspension(event.result);
      else await progress.showResult(event.result);
      return event.result;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

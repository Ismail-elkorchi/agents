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

export class CodingAgentTuiProgressRenderer {
  private dispatch: ((message: CodingAgentTuiMessage) => void | Promise<void>) | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly pendingStreamEvents: CodingAgentTuiStreamProgressEvent[] = [];
  private streamFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private static readonly MAX_PENDING_STREAM_EVENTS = 1024;

  attachDispatch(dispatch: (message: CodingAgentTuiMessage) => void | Promise<void>): void {
    this.dispatch = dispatch;
  }

  handle(event: AgentProgressEvent): void {
    if (isCoalescibleStreamEvent(event)) {
      this.queueStreamEvent(event);
      return;
    }
    this.flushPendingStreamEvents();
    this.enqueue({ type: 'progress', event });
  }

  flush(): Promise<void> {
    this.flushPendingStreamEvents();
    return this.queue;
  }

  async showResult(result: AgentEndedRunResult): Promise<void> {
    this.flushPendingStreamEvents();
    this.enqueue({ type: 'result', result });
    await this.flush();
  }

  async showSuspension(suspension: Extract<AgentRunResult, { state: 'suspended' }>): Promise<void> {
    this.flushPendingStreamEvents();
    this.enqueue({ type: 'approval.required', suspension });
    await this.flush();
  }

  async showFailure(message: string): Promise<void> {
    this.flushPendingStreamEvents();
    this.enqueue({ type: 'failure', message });
    await this.flush();
  }

  private enqueue(message: CodingAgentTuiMessage): void {
    const dispatch = this.dispatch;
    if (dispatch === undefined) return;
    this.queue = this.queue
      .then(async () => { await dispatch(message); })
      .catch(() => undefined);
  }

  private queueStreamEvent(event: Extract<AgentProgressEvent, { type: 'assistant.delta' | 'assistant.reasoning' }>): void {
    const last = this.pendingStreamEvents.at(-1);
    if (last !== undefined && canMergeStreamEvents(last, event)) {
      this.pendingStreamEvents[this.pendingStreamEvents.length - 1] = mergeStreamEvents(last, event);
    } else {
      if (this.pendingStreamEvents.length >= CodingAgentTuiProgressRenderer.MAX_PENDING_STREAM_EVENTS) this.pendingStreamEvents.shift();
      this.pendingStreamEvents.push(event);
    }
    this.scheduleStreamFlush();
  }

  private scheduleStreamFlush(): void {
    if (this.streamFlushTimer !== undefined) return;
    this.streamFlushTimer = setTimeout(() => {
      this.streamFlushTimer = undefined;
      this.flushPendingStreamEvents();
    }, 80);
  }

  private flushPendingStreamEvents(): void {
    if (this.streamFlushTimer !== undefined) {
      clearTimeout(this.streamFlushTimer);
      this.streamFlushTimer = undefined;
    }
    const events = this.pendingStreamEvents.splice(0);
    for (const event of events) {
      this.enqueue({ type: 'progress', event });
    }
  }
}

type CodingAgentTuiStreamProgressEvent = Extract<AgentProgressEvent, { type: 'assistant.delta' | 'assistant.reasoning' }>;

function isCoalescibleStreamEvent(event: AgentProgressEvent): event is CodingAgentTuiStreamProgressEvent {
  return event.type === 'assistant.delta' || event.type === 'assistant.reasoning';
}

function canMergeStreamEvents(left: CodingAgentTuiStreamProgressEvent, right: CodingAgentTuiStreamProgressEvent): boolean {
  if (left.type !== right.type || left.turnIndex !== right.turnIndex) return false;
  if (left.type === 'assistant.reasoning' && right.type === 'assistant.reasoning') {
    return left.channel === right.channel;
  }
  return left.type === 'assistant.delta' && right.type === 'assistant.delta';
}

function mergeStreamEvents(left: CodingAgentTuiStreamProgressEvent, right: CodingAgentTuiStreamProgressEvent): CodingAgentTuiStreamProgressEvent {
  if (left.type === 'assistant.delta' && right.type === 'assistant.delta') {
    return {
      type: 'assistant.delta',
      turnIndex: right.turnIndex,
      turnId: right.turnId,
      requestAttempt: right.requestAttempt,
      delta: `${left.delta}${right.delta}`,
      accumulated: right.accumulated
    };
  }
  if (left.type === 'assistant.reasoning' && right.type === 'assistant.reasoning') {
    return {
      type: 'assistant.reasoning',
      turnIndex: right.turnIndex,
      turnId: right.turnId,
      requestAttempt: right.requestAttempt,
      delta: `${left.delta}${right.delta}`,
      accumulated: right.accumulated,
      ...(right.channel === undefined ? {} : { channel: right.channel })
    };
  }
  return right;
}

export interface CodingAgentTuiAppRunOptions {
  readonly host?: TerminalHost;
  readonly initialTask?: string;
  readonly progress?: CodingAgentTuiProgressRenderer;
  readonly exitOnCompletion?: boolean;
  readonly runtimeDetails?: CodingAgentTuiRuntimeDetails;
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
  const unsubscribe = session.subscribe(async (event) => {
    if (event.type === 'run.progress') {
      progress.handle(event.event);
      return;
    }
    if (event.type === 'run.failed') {
      await progress.showFailure(event.error.message);
      if (exitOnCompletion) {
        failure = event.error;
        events.enqueue({ type: 'app.exit', reason: 'failed' });
      }
      return;
    }
    if (event.type !== 'run.completed') return;
    result = event.result;
    if (event.result.state === 'suspended') await progress.showSuspension(event.result);
    else await progress.showResult(event.result);
    if (exitOnCompletion && session.state().queuedInputs === 0) {
      const terminal = event.result.state === 'ended' ? event.result.terminal : undefined;
      events.enqueue({ type: 'app.exit', reason: terminal ? `${terminal.executionStatus}:${terminal.verificationStatus}:${terminal.terminationReason}` : 'approval_required' });
    }
  });
  const app = createCodingAgentTuiApp(normalizeTaskInput(options.initialTask ?? ''), {
    eventSource: events,
    ...(options.runtimeDetails === undefined ? {} : { runtimeDetails: options.runtimeDetails }),
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
  const exit = runTui(app, host, {
    initialFocus: { kind: 'element', elementId: 'composer' }
  });
  progress.attachDispatch((message) => {
    events.enqueue(message);
  });
  const initialTask = options.initialTask;
  try {
    await session.restore();
    if (initialTask !== undefined) await session.submit({ task: initialTask });
    const exitResult = await exit;
    await session.waitForIdle();
    if (failure !== undefined) throw failure;
    return result === undefined ? { exit: exitResult } : { exit: exitResult, result };
  } finally {
    await progress.flush();
    unsubscribe();
    events.close();
    if (ownsHost) await host.dispose();
  }
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

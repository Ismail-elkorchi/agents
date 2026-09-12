import type { TerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import type { TuiExit } from '@ismail-elkorchi/terminal-ui/tui';
import { runTui } from '@ismail-elkorchi/terminal-ui/tui';
import type { CodingApplicationEvent } from '../application/contracts.js';
import type { CodingApplication } from '../application/service.js';
import type { AgentRunResult } from '@agent-core/runtime';
import { createCodingAgentTuiApp } from './app.js';
import { executeCodingCommand } from './application-commands.js';
import { createCodingTuiEventSource } from './event-source.js';
import type { CodingAgentTuiMessage } from './messages.js';
import type { CodingAgentTuiState } from './state.js';

export interface CodingAgentTuiAppRunOptions {
  readonly showReasoning?: boolean;
  readonly host?: TerminalHost;
  readonly initialTask?: string;
}

export interface CodingAgentTuiAppRunResult {
  readonly exit: TuiExit<CodingAgentTuiState>;
  readonly result?: AgentRunResult;
}

export async function runCodingAgentTuiApp(
  controller: CodingApplication,
  options: CodingAgentTuiAppRunOptions = {}
): Promise<CodingAgentTuiAppRunResult> {
  const host = options.host ?? createTerminalHost({ runtime: 'node' });
  const ownsHost = options.host === undefined;
  const events = createCodingTuiEventSource();
  const initialTask = options.initialTask ?? '';
  let result: AgentRunResult | undefined;
  let unsubscribe: (() => void) | undefined;
  let outcome!: Readonly<
    | { readonly kind: 'returned'; readonly value: CodingAgentTuiAppRunResult }
    | { readonly kind: 'failed'; readonly cause: unknown }
  >;
  try {
    const initial = controller.state();
    const app = createCodingAgentTuiApp('', {
      showReasoning: options.showReasoning ?? false,
      eventSource: events,
      runtimeDetails: initial.runtimeDetails,
      navigation: controller,
      listFiles: (directory, prefix) => controller.listFiles(directory, prefix),
      historyReader: (request) => controller.readHistory(request),
      historySearcher: (request) => controller.searchHistory(request),
      setup: { status: initial.status, requirements: initial.requirements },
      recoveryHandler: async (suspension, action) => {
        if (action === 'stop') {
          if (!await controller.abort('Stopped by the user.', suspension.runId))
            throw new Error('This run is no longer paused. Refresh the session.');
          return 'Stopping this run…';
        }
        const result = await controller.resumeSuspension(suspension.runId);
        return result.state === 'suspended'
          ? 'No recorded result is available yet. You can check again or stop this run.'
          : 'The run has finished.';
      },
      approvalHandler: async (suspension, decision) => {
        const approval = suspension.pendingApprovals[0];
        if (approval === undefined) throw new Error('Approval suspension contains no pending request.');
        await controller.resolveApproval({
          runId: suspension.runId,
          approvalId: approval.approvalId,
          fingerprint: approval.fingerprint,
          decision
        });
      },
      commandHandler: {
        execute(line) {
          if (line === '/exit' || line === '/quit') return { message: 'Exiting.', exit: true };
          return executeCodingCommand(controller, line);
        }
      }
    });
    const exit = runTui(app, { host });
    unsubscribe = controller.subscribe(
      async (event) => {
        if (event.type === 'delivery.gap') {
          await events.enqueue({
            type: 'interactive.notice',
            message: 'Display delivery skipped updates; refreshing recorded state.',
            tone: 'warning'
          });
          await events.enqueue({ type: 'session.hydrated', hydration: await controller.readSession() });
          return;
        }
        result = await presentControllerEvent(event, events, result);
        if (event.type === 'input.queued' || event.type === 'input.revised' || event.type === 'input.cancelled')
          await events.enqueue({
            type: 'submissions.changed',
            pending: await controller.readPendingSubmissions(),
            ...(event.type === 'input.cancelled' ? { cancelledRunId: event.runId } : {})
          });
      },
      (error) => {
        events.fail(error);
      }
    );
    try {
      await controller.start();
    } catch (error) {
      await events.enqueue({ type: 'failure', message: errorMessage(error) });
    }
    if (initialTask.length > 0) {
      await events.enqueue({ type: 'composer.restore', text: initialTask });
      if (controller.state().status === 'ready') await events.enqueue({ type: 'composer.submit' });
    }
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
  try {
    unsubscribe?.();
  } catch (cause) {
    cleanupFailures.push(cause);
  }
  try {
    await controller.close();
  } catch (cause) {
    cleanupFailures.push(cause);
  }
  try {
    await events.close();
  } catch (cause) {
    cleanupFailures.push(cause);
  }
  if (ownsHost) {
    try {
      await host.dispose();
    } catch (cause) {
      cleanupFailures.push(cause);
    }
  }
  const uniqueFailures = [...new Set(cleanupFailures)];
  if (outcome.kind === 'failed') {
    if (uniqueFailures.length === 0) throw outcome.cause;
    throw new AggregateError([outcome.cause, ...uniqueFailures], 'Coding Agent TUI run and cleanup failed.', {
      cause: outcome.cause
    });
  }
  if (uniqueFailures.length > 0) throw new AggregateError(uniqueFailures, 'Coding Agent TUI cleanup failed.');
  return outcome.value;
}

async function presentControllerEvent(
  event: CodingApplicationEvent,
  events: ReturnType<typeof createCodingTuiEventSource>,
  currentResult: AgentRunResult | undefined
): Promise<AgentRunResult | undefined> {
  let message: CodingAgentTuiMessage;
  switch (event.type) {
    case 'delivery.gap':
    case 'configuration.changed':
    case 'input.queued':
    case 'input.revised':
    case 'input.cancelled':
      return currentResult;
    case 'application.state.changed':
      message = { type: 'application.state.changed', state: event.state };
      break;
    case 'authentication.required':
      message = {
        type: 'interactive.notice',
        message: `OpenAI Codex device login\nOpen: ${event.verificationUri}\nCode: ${event.userCode}\nExpires in: ${String(Math.round(event.expiresInSeconds / 60))} minutes`
      };
      break;
    case 'session.restored':
      message = { type: 'session.hydrated', hydration: event.view };
      break;
    case 'verification.updated':
      message = { type: 'verification.updated', verification: event.verification };
      break;
    case 'run.progress':
      message = { type: 'progress', event: event.event };
      break;
    case 'context.transitioned':
      message = { type: 'context.transitioned', window: event.window };
      break;
    case 'run.failed':
      message = { type: 'failure', message: event.error.message };
      break;
    case 'run.completed': {
      const result = event.result;
      message =
        result.state === 'ended'
          ? { type: 'result', result }
          : result.reason === 'approval_required'
            ? { type: 'approval.required', suspension: result }
            : { type: 'run.suspended', suspension: result };
      currentResult = result;
      break;
    }
  }
  await events.enqueue(message);
  return currentResult;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

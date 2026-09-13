import type { AgentRunResult } from '@agent-core/runtime';
import { preferencesTheme, ringTerminalBell } from '@agent-core/tui';
import {
  exportConversation,
  FileDraftStorage,
  FileSessionNames,
  openBrowser,
  readTuiPreferences,
  runTerminalApplication,
  writeTuiPreferences
} from '@agent-core/tui/node';
import type { TerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import type { TuiExit } from '@ismail-elkorchi/terminal-ui/tui';
import { runTui } from '@ismail-elkorchi/terminal-ui/tui';
import path from 'node:path';
import type { CodingApplicationEvent } from '../application/contracts.js';
import type { CodingApplication } from '../application/service.js';
import { createCodingAgentTuiApp } from './app.js';
import { executeCodingCommand, submissionPresentation } from './application-commands.js';
import { createCodingTuiEventSource } from './event-source.js';
import { CODING_SHORTCUTS } from './interactive-commands.js';
import type { CodingAgentTuiMessage } from './messages.js';
import type { CodingAgentTuiState } from './state.js';

export interface CodingAgentTuiAppRunOptions {
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
  const events = createCodingTuiEventSource();
  const initialTask = options.initialTask ?? '';
  let result: AgentRunResult | undefined;
  let unsubscribe: (() => void) | undefined;
  return runTerminalApplication({
    ...(options.host === undefined ? {} : { host: options.host }),
    cleanup: [() => unsubscribe?.(), () => controller.close(), () => events.close()],
    async run(host) {
      const preferences = await readTuiPreferences(controller.presentationPath(), CODING_SHORTCUTS);
      const initial = controller.state();
      const app = createCodingAgentTuiApp('', {
        notify: (signal) => ringTerminalBell(host, signal),
        exportConversation: (pages, signal) =>
          exportConversation(
            path.join(path.dirname(controller.presentationPath()), 'exports'),
            pages,
            signal
          ),
        sessionNames: new FileSessionNames(
          path.join(path.dirname(controller.presentationPath()), 'session-names')
        ),
        drafts: new FileDraftStorage(controller.draftDirectory()),
        presentation: {
          preferences,
          save: (value) => writeTuiPreferences(controller.presentationPath(), value)
        },
        eventSource: events,
        runtimeDetails: initial.runtimeDetails,
        navigation: controller,
        inspectContext: () => controller.inspectContext(),
        processes: controller,
        attachments: controller,
        configuration: {
          openBrowser,
          providers: ['ollama', 'openrouter', 'openai', 'openai-codex'].map((id) => ({ id, label: id })),
          current: () => controller.modelSelection(),
          connect: (provider, endpoint) => controller.connectProvider(provider, endpoint),
          save: (selection, provider) => controller.configureModel(selection, provider)
        },
        resources: {
          async search(query, signal) {
            signal.throwIfAborted();
            const slash = query.lastIndexOf('/');
            const files = await controller.listFiles(
              slash < 0 ? '.' : query.slice(0, slash) || '.',
              query.slice(slash + 1)
            );
            signal.throwIfAborted();
            return files.map((file) => {
              const target = file.kind === 'directory' ? `${file.path}/` : file.path;
              return {
                id: target,
                label: target,
                insertion: `@${/\s/u.test(target) ? JSON.stringify(target) : target}${file.kind === 'directory' ? '' : ' '}`
              };
            });
          }
        },
        historyEntryReader: (boundary, entryId) => controller.readHistoryEntry(boundary, entryId),
        historyReader: (request) => controller.readHistory(request),
        historySearcher: (request) => controller.searchHistory(request),
        setup: { status: initial.status, requirements: initial.requirements },
        recoveryHandler: async (suspension, action) => {
          if (action === 'stop') {
            if (!(await controller.abort('Stopped by the user.', suspension.runId)))
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
          async submit(input, delivery) {
            return submissionPresentation(
              await controller.submit(input, delivery === undefined ? {} : { delivery }),
              input.task
            );
          },
          execute(line) {
            return executeCodingCommand(controller, line);
          }
        }
      });
      const exit = runTui(app, {
        host,
        theme: (state) =>
          preferencesTheme(
            state.overlay.kind === 'preferences' ? state.overlay.preferences : state.preferences
          )
      });
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
          if (
            event.type === 'input.queued' ||
            event.type === 'input.revised' ||
            event.type === 'input.cancelled'
          )
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
      return result === undefined ? { exit: exitResult } : { exit: exitResult, result };
    }
  });
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
    case 'session.restored':
      message = { type: 'session.hydrated', hydration: event.view };
      break;
    case 'verification.updated':
      message = { type: 'verification.updated', verification: event.verification };
      break;
    case 'run.progress':
      message = { type: 'progress', runId: event.runId, event: event.event };
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

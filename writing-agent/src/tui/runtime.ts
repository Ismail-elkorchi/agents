import { progressReplacementKey } from '@agent-core/runtime';
import { applicationEventSource, preferencesTheme, ringTerminalBell } from '@agent-core/tui';
import {
  exportConversation,
  FileDraftStorage,
  FileSessionNames,
  readTuiPreferences,
  runTerminalApplication,
  writeTuiPreferences
} from '@agent-core/tui/node';
import type { TerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { runTui } from '@ismail-elkorchi/terminal-ui/tui';
import path from 'node:path';
import type { WritingApplication } from '../application/service.js';
import { createWritingAgentTuiApp } from './app.js';
import { WRITING_SHORTCUTS } from './commands.js';
import type { WritingTuiMessage } from './state.js';

export async function runWritingAgentTuiApp(
  application: WritingApplication,
  options: { readonly host?: TerminalHost } = {}
) {
  const events = applicationEventSource<WritingTuiMessage>('writing-agent-events', {
    replacementKey: (message) =>
      message.type === 'collaboration.refresh' ? 'collaboration-refresh'
        : message.type === 'progress'
        ? progressReplacementKey(message.event)
        : message.type === 'history.recovery' && message.progress.phase === 'progress'
          ? `history-recovery:${message.progress.sessionId}`
          : message.type === 'refresh'
          ? 'session-refresh'
          : undefined,
    failureMessage: (message) => ({ type: 'notice', message }),
    subscribe: (emit, failed) => {
      return application.subscribe(async (event) => {
        switch (event.type) {
          case 'collaboration.changed':
            return emit({ type: 'collaboration.refresh' });
          case 'history.recovery':
            return emit(event);
          case 'application.state.changed':
            return emit({ type: 'application', state: application.state() });
          case 'run.progress':
            return emit({ type: 'progress', runId: event.runId, event: event.event });
          case 'run.completed':
            return emit({ type: 'result', result: event.result });
          case 'run.failed':
            await emit({ type: 'notice', message: event.error.message });
            return emit({ type: 'refresh' });
          case 'context.transition.unchanged':
            return emit({ type: 'context.applied', idempotencyKey: event.idempotencyKey, status: 'unchanged' });
          case 'context.transition.rejected':
            return emit({ type: 'context.rejected', idempotencyKey: event.idempotencyKey, message: event.message });
          case 'context.transitioned':
            await emit({ type: 'context.applied', idempotencyKey: event.transition.idempotencyKey });
            return emit({ type: 'refresh' });
          case 'delivery.gap':
            await emit({ type: 'collaboration.refresh' });
            return emit({ type: 'refresh' });
          case 'configuration.changed':
          case 'input.queued':
          case 'input.revised':
          case 'input.cancelled':
            return emit({ type: 'refresh' });
        }
      }, failed);
    },
    start: async (emit) => {
      try {
        await application.start();
        await emit({ type: 'refresh' });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return;
        await emit({ type: 'notice', message: error instanceof Error ? error.message : String(error) });
      }
    }
  });
  return runTerminalApplication({
    ...(options.host === undefined ? {} : { host: options.host }),
    cleanup: [() => application.close()],
    async run(host) {
      const preferences = await readTuiPreferences(
        application.presentationPath(),
        WRITING_SHORTCUTS
      );
      return runTui(
        createWritingAgentTuiApp(application, {
          events,
          notify: (signal) => ringTerminalBell(host, signal),
          exportConversation: (pages, signal) =>
            exportConversation(
              path.join(path.dirname(application.presentationPath()), 'exports'),
              pages,
              signal
            ),
          sessionNames: new FileSessionNames(
            path.join(path.dirname(application.presentationPath()), 'session-names')
          ),
          drafts: new FileDraftStorage(application.draftDirectory()),
          presentation: {
            preferences,
            save: (value) => writeTuiPreferences(application.presentationPath(), value)
          }
        }),
        {
          host,
          theme: (state) =>
            preferencesTheme(
              state.overlay.kind === 'preferences' ? state.overlay.preferences : state.preferences
            )
        }
      );
    }
  });
}

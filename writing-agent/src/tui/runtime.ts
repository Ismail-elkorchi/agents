import { progressReplacementKey } from '@agent-core/runtime';
import { preferencesTheme, ringTerminalBell, TuiEventChannel } from '@agent-core/tui';
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
  const events = new TuiEventChannel<WritingTuiMessage>('writing-agent-events', {
    replacementKey: (message) =>
      message.type === 'progress'
        ? progressReplacementKey(message.event)
        : message.type === 'refresh'
          ? 'session-refresh'
          : undefined,
    failureMessage: (message) => ({ type: 'notice', message })
  });
  const unsubscribe = application.subscribe(
    async (event) => {
      switch (event.type) {
        case 'application.state.changed':
          return events.enqueue({ type: 'application', state: application.state() });
        case 'run.progress':
          return events.enqueue({ type: 'progress', runId: event.runId, event: event.event });
        case 'run.completed':
          return events.enqueue({ type: 'result', result: event.result });
        case 'run.failed':
          return events.enqueue({ type: 'notice', message: event.error.message });
        case 'delivery.gap':
        case 'configuration.changed':
        case 'input.queued':
        case 'input.revised':
        case 'input.cancelled':
        case 'context.transitioned':
          return events.enqueue({ type: 'refresh' });
      }
    },
    (error) => {
      events.fail(error);
    }
  );
  return runTerminalApplication({
    ...(options.host === undefined ? {} : { host: options.host }),
    cleanup: [unsubscribe, () => application.close(), () => events.close()],
    async run(host) {
      const preferences = await readTuiPreferences(application.presentationPath(), WRITING_SHORTCUTS);
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

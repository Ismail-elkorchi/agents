import { progressReplacementKey } from '@agents/application';
import { TuiEventChannel } from '@agents/tui';
import { createTerminalHost, type TerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { runTui } from '@ismail-elkorchi/terminal-ui/tui';
import type { WritingApplication } from '../application/service.js';
import { createWritingAgentTuiApp } from './app.js';
import type { WritingTuiMessage } from './state.js';

export async function runWritingAgentTuiApp(
  application: WritingApplication,
  options: { readonly host?: TerminalHost } = {}
) {
  const host = options.host ?? createTerminalHost({ runtime: 'node' });
  const events = new TuiEventChannel<WritingTuiMessage>('writing-agent-events', {
    replacementKey: (message) =>
      message.type === 'progress'
        ? progressReplacementKey(message.event)
        : message.type === 'refresh'
          ? 'project-refresh'
          : undefined,
    failureMessage: (message) => ({ type: 'notice', message })
  });
  const unsubscribe = application.subscribe(
    async (event) => {
      switch (event.type) {
        case 'application.state.changed':
          return events.enqueue({ type: 'application', state: application.state() });
        case 'operation.progress':
          return events.enqueue({ type: 'progress', event: event.event });
        case 'operation.completed':
          return events.enqueue({ type: 'result', result: event.result });
        case 'operation.failed':
          return events.enqueue({ type: 'notice', message: event.error.message });
        case 'delivery.gap':
        case 'project.changed':
        case 'operation.accepted':
          return events.enqueue({ type: 'refresh' });
      }
    },
    (error) => {
      events.fail(error);
    }
  );
  let outcome:
    | { readonly kind: 'returned'; readonly value: Awaited<ReturnType<typeof runTui>> }
    | { readonly kind: 'failed'; readonly cause: unknown };
  try {
    outcome = {
      kind: 'returned',
      value: await runTui(createWritingAgentTuiApp(application, { events }), { host })
    };
  } catch (cause) {
    outcome = { kind: 'failed', cause };
  }
  unsubscribe();
  const results = await Promise.allSettled([
    application.close(),
    events.close(),
    ...(options.host === undefined ? [host.dispose()] : [])
  ]);
  const failures: unknown[] = [];
  for (const result of results)
    if (result.status === 'rejected') {
      const cause: unknown = result.reason;
      failures.push(cause);
    }
  if (failures.length > 0)
    throw new AggregateError(
      [...(outcome.kind === 'failed' ? [outcome.cause] : []), ...failures],
      'Writing terminal cleanup failed.'
    );
  if (outcome.kind === 'failed') throw outcome.cause;
  return outcome.value;
}

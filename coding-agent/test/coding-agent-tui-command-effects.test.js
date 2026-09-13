import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { runTui } from '@ismail-elkorchi/terminal-ui/tui';
import { createCodingTuiEventSource, createCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';
import { waitFor } from './coding-agent-tui-test-helpers.js';

test('delayed admission preserves progress received while the effect is running', async (t) => {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 18 } });
  const events = createCodingTuiEventSource();
  let resolveCommand;
  const commandResult = new Promise((resolve) => {
    resolveCommand = resolve;
  });
  const app = createCodingAgentTuiApp('', {
    eventSource: events,
    commandHandler: {
      submit() {
        return commandResult;
      },
      execute() {
        return { message: 'Exiting.', exit: true };
      }
    }
  });
  const running = runTui(app, { host });
  t.after(() => host.endInput());

  await waitFor(() => host.frames().length > 0);
  host.input('Delayed input\r');
  await events.enqueue({
    type: 'progress',
    runId: 'run-1',
    event: {
      type: 'assistant.ended',
      turnIndex: 1,
      turnId: 'turn-1',
      requestAttempt: 1,
      content: 'Progress received during command.',
      modelOutput: {
        status: 'complete',
        message: 'Progress received during command.',
        source: 'content',
        turnIndex: 1
      }
    }
  });
  await waitFor(() => host.frames().length > 2);
  resolveCommand({ message: 'Delayed command completed.', tone: 'success' });
  await waitFor(() => host.frames().length > 3);
  host.input('/exit\r');
  const exit = await running;
  await events.close();

  assert.ok(
    exit.state.conversation.items.some(
      (item) => item.kind === 'assistant' && item.text === 'Progress received during command.'
    )
  );
  assert.equal(exit.state.composer.history.entries.length, 1);
});

import { testResult } from './helpers/results.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { runTui } from '@ismail-elkorchi/terminal-ui/tui';
import { createCodingTuiEventSource, createCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';
import { decodeAgentTerminalSnapshot } from '@agent-core/runtime';
import { waitFor } from './coding-agent-tui-test-helpers.js';

test('TUI preserves terminal truth and does not duplicate the final answer', async () => {
  const terminal = decodeAgentTerminalSnapshot({
    ...base()
  });
  const { host, events, running } = runPresentationApp();
  await waitFor(() => host.frames().length > 0);
  await events.enqueue({
    type: 'progress',
    runId: 'run-1',
    event: {
      type: 'assistant.ended',
      turnIndex: 1,
      turnId: 'turn-1',
      requestAttempt: 1,
      content: 'Answer.',
      modelOutput: { status: 'complete', message: 'Answer.', source: 'content', turnIndex: 1 }
    }
  });
  await events.enqueue({
    type: 'result',
    result: testResult(terminal)
  });
  await waitFor(() => host.frames().length > 2);
  host.input('/exit\r');
  const exit = await running;
  await events.close();

  assert.equal(exit.state.run.kind, 'ended');
  assert.equal(exit.state.run.terminal.executionStatus, 'completed');
  assert.equal('verificationStatus' in exit.state.run.terminal, false);
  assert.equal(
    exit.state.conversation.items.filter((item) => item.kind === 'assistant' && item.text === 'Answer.')
      .length,
    1
  );
});

function runPresentationApp() {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 20 } });
  const events = createCodingTuiEventSource();
  const app = createCodingAgentTuiApp('', {
    eventSource: events,
    commandHandler: { execute: () => ({ message: 'Exiting.', exit: true }) }
  });
  return {
    host,
    events,
    running: runTui(app, { host })
  };
}

function base() {
  return {
    runId: 'run',
    finalizationId: 'final',
    phase: 'ended',
    executionStatus: 'completed',
    terminationReason: 'model_completed',
    modelTerminationReason: 'stop',
    modelOutput: { status: 'complete', message: 'Answer.', source: 'content', turnIndex: 1 },
    turnCount: 1,
    budget: {
      modelTurns: 1,
      totalToolCalls: 0,
      elapsedMs: 1,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      knownCosts: {},
      pricingStatus: 'unknown',
      unknownPricedTokens: 0
    }
  };
}

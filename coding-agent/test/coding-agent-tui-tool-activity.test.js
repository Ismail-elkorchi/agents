import { InMemorySessionRepository } from '@agent-core/runtime';
import { activityDetails } from '@agent-core/tui';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime, runTui } from '@ismail-elkorchi/terminal-ui/tui';
import {
  createCodingTuiEventSource,
  createCodingAgentTuiApp
} from '@ismail-elkorchi/coding-agent/tui';
import { waitFor } from './coding-agent-tui-test-helpers.js';

test('tool activity collapses success, expands failure, and keeps bounded observed facts', async () => {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 20 } });
  const events = createCodingTuiEventSource();
  const app = createCodingAgentTuiApp('', {
    eventSource: events,
    commandHandler: { execute: () => ({ message: 'Exiting.', exit: true }) }
  });
  const running = runTui(app, { host });
  await waitFor(() => host.frames().length > 0);

  await events.enqueue({
    type: 'progress',
    runId: 'run-1',
    event: { type: 'turn.started', runId: 'run', turnIndex: 1, turnId: 'turn-1', requestAttempt: 1 }
  });
  await events.enqueue({
    type: 'progress',
    runId: 'run-1',
    event: toolStarted('call-ok', 'echo ok')
  });
  await events.enqueue({
    type: 'progress',
    runId: 'run-1',
    event: toolEnded('call-ok', true, 'Command completed.')
  });
  await events.enqueue({
    type: 'progress',
    runId: 'run-1',
    event: toolStarted('call-failed', 'false')
  });
  await events.enqueue({
    type: 'progress',
    runId: 'run-1',
    event: toolEnded('call-failed', false, 'Command failed.')
  });
  await waitFor(() => host.frames().length > 1);
  host.input('/exit\r');
  const exit = await running;
  await events.close();

  const success = exit.state.conversation.items.find(
    (item) => item.id === 'tool:run-1:turn-1:batch-1:0'
  );
  const failure = exit.state.conversation.items.find(
    (item) => item.id === 'tool:run-1:turn-1:batch-1:1'
  );
  assert.equal(success.status, 'complete');
  assert.equal(failure.status, 'failed');
  assert.ok(!exit.state.conversation.expandedIds.includes(success.id));
  assert.ok(exit.state.conversation.expandedIds.includes(failure.id));
  assert.match(activityDetails(failure), /workspace:\/\/command/u);
});

function identity(callId) {
  return {
    turnIndex: 1,
    turnId: 'turn-1',
    requestAttempt: 1,
    toolBatchId: 'batch-1',
    callIndex: callId === 'call-ok' ? 0 : 1,
    callId,
    toolAttempt: 1
  };
}

function toolStarted(callId, command) {
  return {
    type: 'tool.started',
    ...identity(callId),
    toolName: 'exec_command',
    input: { id: callId, name: 'exec_command', input: { kind: 'json', value: { command } } },
    fingerprint: `fingerprint-${callId}`,
    effects: {
      accesses: [{ mode: 'execute', scope: 'workspace/command' }],
      lockScopes: ['workspace/command'],
      recovery: { kind: 'unknown' }
    }
  };
}

function toolEnded(callId, completed, summary) {
  return {
    type: 'tool.ended',
    ...identity(callId),
    toolName: 'exec_command',
    observation: {
      kind: completed ? 'result' : 'failure',
      ...(!completed ? { code: 'execution_failed' } : {}),
      summary,
      scope: { resources: ['workspace/command'], coverage: 'complete' },
      output: { outcome: completed ? 'exited' : 'runtime_error', command: callId },
      observedFacts: {
        items: [
          {
            action: 'execute',
            resources: [{ uri: 'workspace://command' }],
            outcome: completed ? 'success' : 'failure'
          }
        ]
      }
    }
  };
}

test('wrapped conversation entries survive tool disclosure, streaming, and resize', async (t) => {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({
    binding: { schemaId: 'test/viewport', schemaVersion: 1, subject: {} }
  });
  await repository.appendInput(session, {
    runId: 'run-1',
    task: '文 · e\u0301 words '.repeat(200)
  });
  const runtime = createTuiRuntime({
    host: createMemoryTerminalHost({ terminalSize: { columns: 48, rows: 20 } }),
    app: createCodingAgentTuiApp('', {
      initialHydration: {
        history: await repository.readBranchPage(session),
        changes: [],
        verification: [],
        session: {
          sessionId: session.id,
          phase: 'idle',
          queuedInputs: 0,
          configuration: { provider: 'test', model: 'test' }
        },
        branchPoints: [],
        pendingSubmissions: [],
        runs: []
      }
    })
  });
  t.after(() => runtime.dispose());
  await runtime.start();
  const progress = (event) => runtime.dispatch({ type: 'progress', runId: 'run-1', event });
  await progress({
    type: 'turn.started',
    runId: 'run-1',
    turnIndex: 1,
    turnId: 'turn-1',
    requestAttempt: 1
  });
  await progress(toolStarted('call-ok', 'a very long command argument '.repeat(30)));
  await progress(toolEnded('call-ok', true, 'Output '.repeat(50)));
  for (const columns of [12, 80, 48]) {
    await runtime.resize({ columns, rows: 20 });
    await runtime.dispatch({ type: 'activity.toggle', id: 'tool:run-1:turn-1:batch-1:0' });
    await progress({
      type: 'assistant.delta',
      turnIndex: 1,
      turnId: 'turn-1',
      requestAttempt: 1,
      delta: 'More output ',
      accumulated: 'More output '.repeat(columns)
    });
    const { geometry, scroll } = runtime.state().presentation.layout;
    assert.equal(scroll.offsetRow, Math.max(0, geometry.contentRows - geometry.viewportRows));
    assert.ok(geometry.viewportColumns <= columns);
  }
  await runtime.dispatch({ type: 'conversation.scroll', transition: { kind: 'top' } });
  assert.equal(runtime.state().presentation.layout.scroll.offsetRow, 0);
  await runtime.dispatch({ type: 'conversation.message', direction: 'next' });
  assert.ok(runtime.state().conversation.anchor);
});

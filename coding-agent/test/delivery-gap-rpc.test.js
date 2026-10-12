import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { runCodingRpc } from '@ismail-elkorchi/coding-agent/rpc';
import { runWritingRpc } from '@ismail-elkorchi/writing-agent/rpc';

for (const [name, run] of [['coding', runCodingRpc], ['writing', runWritingRpc]]) {
  test(`${name} RPC exposes a delivery gap and serves authoritative refresh requests`, { timeout: 10000 }, async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let listener;
    const received = [];
    const waiters = [];
    let buffered = '';
    output.setEncoding('utf8').on('data', chunk => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        received.push(JSON.parse(buffered.slice(0, newline)));
        buffered = buffered.slice(newline + 1);
      }
      for (const resolve of waiters.splice(0)) resolve();
    });
    const application = {
      start: async () => {}, close: async () => {},
      subscribe: callback => { listener = callback; return () => {}; },
      state: () => ({ status: 'ready', refreshed: true }),
      readSession: async () => ({ session: { sessionId: 'session', phase: 'idle' },
        runs: [{ state: { runId: 'run' }, terminal: { executionStatus: 'completed' } }],
        ...(name === 'coding' ? { verification: [{ runId: 'run', checks: [{ name: 'tests', outcome: 'passed' }] }] } : {}) })
    };
    const completion = run(application, { input, output, diagnostic: message => { throw new Error(message); } });
    try {
      await listener({ type: 'delivery.gap' });
      input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'application.read', params: {} }) + '\n');
      input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session.read', params: {} }) + '\n');
      while (!received.some(message => message.id === 1) || !received.some(message => message.id === 2))
        await new Promise(resolve => waiters.push(resolve));
      assert(received.some(message => message.method === 'delivery.gap'));
      assert.equal(received.find(message => message.id === 1).result.refreshed, true);
      const refreshed = received.find(message => message.id === 2).result;
      assert.equal(refreshed.runs[0].terminal.executionStatus, 'completed');
      if (name === 'coding') assert.equal(refreshed.verification[0].checks[0].outcome, 'passed');
    } finally {
      input.end();
      await completion;
    }
  });
}

test('authoritative hydration refreshes verification while preserving historical browsing', async t => {
  const { createCodingAgentTuiApp, hydrateCodingAgentTuiState } = await import('@ismail-elkorchi/coding-agent/tui');
  const { createMemoryTerminalHost } = await import('@ismail-elkorchi/terminal-ui/host');
  const { createTuiRuntime } = await import('@ismail-elkorchi/terminal-ui/tui');
  const runtime = createTuiRuntime({ host: createMemoryTerminalHost(), app: createCodingAgentTuiApp('') });
  t.after(() => runtime.dispose());
  await runtime.start();
  const history = { boundary: { sessionId: 'session', leafId: 'old' }, entries: [] };
  const oldVerification = { runId: 'run', checks: [], history: { complete: false, nextSequence: 1, omittedEarlierChecks: 0 } };
  const verification = { ...oldVerification, history: { complete: true, nextSequence: 5, omittedEarlierChecks: 0 } };
  const initial = runtime.state();
  const browsing = { ...initial,
    debug: { ...initial.debug, sessionId: 'session', verification: [oldVerification] },
    conversation: { ...initial.conversation, pages: [{ history, changes: [], verification: [oldVerification] }],
      scroll: { ...initial.conversation.scroll, followTail: false } }
  };
  const refreshed = hydrateCodingAgentTuiState(browsing, {
    session: { sessionId: 'session', phase: 'idle', queuedInputs: 0,
      configuration: { provider: 'fixture', model: 'fixture' } },
    history: { ...history, boundary: { ...history.boundary, leafId: 'latest' } },
    changes: [], verification: [verification], pendingSubmissions: [], branchPoints: [], runs: [], toolDiagnostics: []
  });
  assert.equal(refreshed.conversation.scroll.followTail, false);
  assert.equal(refreshed.conversation.pages[0].history, history);
  assert.equal(refreshed.debug.verification[0].history.complete, true);
  assert.equal(refreshed.debug.verification[0].history.nextSequence, 5);
});

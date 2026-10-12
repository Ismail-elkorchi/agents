import assert from 'node:assert/strict';
import test from 'node:test';
import { CodingApplication } from '@ismail-elkorchi/coding-agent';
import { createCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { waitFor } from './coding-agent-tui-test-helpers.js';

test('context selection resumes admission only after a committed selection', async () => {
  const calls = [];
  const request = {
    expectedWindowId: null, expectedSourceRevision: 3,
    idempotencyKey: 'explicit-selection', reason: 'Apply selected originals.',
    selection: { strategy: 'sources', retained: [] }
  };
  let result = { kind: 'scheduled', requestId: 'pending' };
  const agent = {
    transitionContext: async (actual) => { assert.equal(actual, request); return result; },
    inspectSuspension: () => ({ category: 'context_admission', runId: 'blocked-run' }),
    resumeContextAdmission: async (runId) => { calls.push(runId); return { resumed: true }; }
  };
  const application = { requireRuntime: () => ({ agent }) };
  assert.deepEqual(await CodingApplication.prototype.transitionContext.call(application, request), { selection: result });
  assert.deepEqual(calls, []);
  result = { kind: 'selected', entry: { id: 'committed-selection' } };
  assert.deepEqual(await CodingApplication.prototype.transitionContext.call(application, request), { selection: result, run: { resumed: true } });
  assert.deepEqual(calls, ['blocked-run']);
  agent.transitionContext = async () => { throw new Error('Stale inspected sources'); };
  await assert.rejects(CodingApplication.prototype.transitionContext.call(application, request), /Stale/);
  assert.deepEqual(calls, ['blocked-run'], 'rejected selections cannot resume the run');
});

test('coding context panel preserves a queued draft and exposes its rejected outcome', async t => {
  const inspection = {
    cut: { sourceRevision: 3 }, window: null,
    activeSelection: { status: 'available', selection: { strategy: 'sources', retained: [] } },
    protectedSources: [], pendingWork: []
  };
  const runtime = createTuiRuntime({ host: createMemoryTerminalHost(), app: createCodingAgentTuiApp('', {
    context: {
      inspectContext: async () => inspection,
      contextSources: async () => ({ items: [] }),
      transitionContext: async () => ({ selection: { kind: 'scheduled', requestId: 'active-selection' } })
    }
  }) });
  t.after(() => runtime.dispose());
  await runtime.start();
  await runtime.dispatch({ type: 'context.open' });
  await waitFor(() => runtime.state().overlay.state?.inspection !== undefined);
  const draft = runtime.state().overlay.state.selection;
  await runtime.dispatch({ type: 'context.apply' });
  await waitFor(() => runtime.state().overlay.state?.pendingTransition?.requestId === 'active-selection');
  const idempotencyKey = runtime.state().overlay.state.pendingTransition.idempotencyKey;
  await runtime.dispatch({ type: 'context.rejected', idempotencyKey, message: 'Context selection source revision is stale.' });
  const state = runtime.state();
  assert.equal(state.overlay.state.selection, draft);
  assert.equal(state.overlay.state.pendingTransition, undefined);
  assert.match(state.overlay.state.notice, /stale/);
  assert(state.conversation.items.some(item => item.kind === 'notice' && /Context selection rejected.*stale/.test(item.text)));
  await runtime.dispatch({ type: 'overlay.close' });
  await runtime.dispatch({ type: 'context.rejected', idempotencyKey: 'another', message: 'Run ended before applying the selection.' });
  assert.equal(runtime.state().overlay.kind, 'none');
  assert(runtime.state().conversation.items.some(item => item.kind === 'notice' && /Run ended/.test(item.text)));
});

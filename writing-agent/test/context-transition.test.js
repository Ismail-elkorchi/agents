import assert from 'node:assert/strict';
import test from 'node:test';
import { WritingApplication } from '@ismail-elkorchi/writing-agent';
import { createWritingAgentTuiApp } from '@ismail-elkorchi/writing-agent/tui';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { waitForState } from '../../test-helpers/tui-runtime.js';
import { fixture } from './helpers/runtime.js';

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
  const application = { requireAgent: () => agent };
  assert.deepEqual(await WritingApplication.prototype.transitionContext.call(application, request), { selection: result });
  assert.deepEqual(calls, []);
  result = { kind: 'selected', entry: { id: 'committed-selection' } };
  assert.deepEqual(await WritingApplication.prototype.transitionContext.call(application, request), { selection: result, run: { resumed: true } });
  assert.deepEqual(calls, ['blocked-run']);
  agent.transitionContext = async () => { throw new Error('Stale inspected sources'); };
  await assert.rejects(WritingApplication.prototype.transitionContext.call(application, request), /Stale/);
  assert.deepEqual(calls, ['blocked-run'], 'rejected selections cannot resume the run');
});

test('writing context panel preserves a queued draft and keeps rejection visible after closure', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const f = await fixture('');
  f.application.transitionContext = async () => ({ selection: { kind: 'scheduled', requestId: 'active-selection' } });
  const runtime = createTuiRuntime({ host: createMemoryTerminalHost(), app: createWritingAgentTuiApp(f.application) });
  t.after(async () => { await runtime.dispose(); await f.close(); });
  await runtime.start();
  await waitForState(runtime, t.signal, () => runtime.state().history.length > 0);
  await runtime.dispatch({ type: 'context.open' });
  await waitForState(runtime, t.signal, () => runtime.state().overlay.state?.inspection !== undefined);
  const draft = runtime.state().overlay.state.selection;
  await runtime.dispatch({ type: 'context.apply' });
  await waitForState(runtime, t.signal, () => runtime.state().overlay.state?.pendingTransition?.requestId === 'active-selection');
  const idempotencyKey = runtime.state().overlay.state.pendingTransition.idempotencyKey;
  await runtime.dispatch({ type: 'context.rejected', idempotencyKey, message: 'Context selection source revision is stale.' });
  assert.equal(runtime.state().overlay.state.selection, draft);
  assert.equal(runtime.state().overlay.state.pendingTransition, undefined);
  assert.match(runtime.state().overlay.state.notice, /stale/);
  await runtime.dispatch({ type: 'overlay.close' });
  await runtime.dispatch({ type: 'notice', message: 'Run completed' });
  assert(runtime.state().liveConversation.some(item => item.kind === 'notice' && /Context selection rejected.*stale/.test(item.text)));
  await runtime.dispatch({ type: 'context.rejected', idempotencyKey: 'another', message: 'Run ended before applying the selection.' });
  assert.equal(runtime.state().overlay.kind, 'none');
  assert(runtime.state().liveConversation.some(item => item.kind === 'notice' && /Run ended/.test(item.text)));
});

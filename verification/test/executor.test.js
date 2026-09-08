import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckEffectPlan, deriveVerificationStatus, executeVerification } from '@agents/verification';
import { EffectExecutor, effectExecutionEventCodec } from '@agent-core/runtime';
import { InMemoryEventRepository } from '@agent-core/persistence';

const context = {
  runId: 'run',
  turnId: 'turn',
  turnIndex: 1,
  requestAttempt: 1,
  task: 'Verify the admitted material.',
  instructions: [],
  modelOutput: { status: 'complete', message: 'Done.', source: 'content', turnIndex: 1 },
  metadata: {},
  signal: new AbortController().signal,
  execution: { observedFactsReader: { read: async () => ({ records: [], coverage: 'complete' }) } }
};
const required = {
  kind: 'deterministic',
  id: 'required',
  implementationId: 'check@1',
  requirement: 'required',
  description: 'Checks the application contract.',
  run: async () => ({ verdict: 'passed', summary: 'Passed.' })
};

function executor() {
  return new EffectExecutor(new InMemoryEventRepository(effectExecutionEventCodec));
}

test('applications select check order and advisory failures do not become required failures', async () => {
  const calls = [];
  const checks = [
    {
      ...required,
      run: async () => {
        calls.push('required');
        return { verdict: 'passed', summary: 'Passed.' };
      }
    },
    {
      ...required,
      id: 'advisory',
      requirement: 'advisory',
      run: async () => {
        calls.push('advisory');
        return { verdict: 'failed', summary: 'Style finding.' };
      }
    }
  ];
  const result = await executeVerification({ ownerId: 'work', checks, context, effects: executor() });
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['required', 'advisory']);
  assert.equal(deriveVerificationStatus(checks, result.results), 'passed');
  assert.equal(result.results[1].verdict, 'failed');
});

test('lost check results reconcile with their original authorization without repeating external work', async () => {
  let starts = 0;
  let observation;
  const effects = executor();
  const check = {
    ...required,
    kind: 'effect',
    planEffect: async () =>
      createCheckEffectPlan({
        authorization: { revision: 'original' },
        recovery: {
          kind: 'queryable',
          service: 'checker',
          reconcilerId: 'checker@1',
          externalExecutionId: 'job',
          expiresAt: null
        },
        start: async () => {
          starts++;
          observation = { verdict: 'failed', summary: 'Original defect.' };
          throw new Error('reply lost');
        },
        reconcile: async () => ({ status: 'settled', observation }),
        release: async () => {}
      })
  };
  const request = { ownerId: 'work', checks: [check], context, effects };
  assert.equal((await executeVerification(request)).status, 'unknown');
  const result = await executeVerification(request);
  assert.equal(result.status, 'completed');
  assert.equal(result.results[0].verdict, 'failed');
  assert.equal(starts, 1);
  assert.deepEqual(await executeVerification(request), result);
});

test('cancelled verification dispatches nothing and malformed plugin observations fail at admission', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  let starts = 0;
  const check = {
    ...required,
    run: async () => {
      starts++;
      return { verdict: 'invented', summary: 'Invalid plugin result.' };
    }
  };
  await assert.rejects(
    executeVerification({
      ownerId: 'work',
      checks: [check],
      context: { ...context, signal: controller.signal },
      effects: executor()
    }),
    /cancelled/
  );
  assert.equal(starts, 0);
  await assert.rejects(
    executeVerification({ ownerId: 'work', checks: [check], context, effects: executor() })
  );
});

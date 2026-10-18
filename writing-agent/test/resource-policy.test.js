import assert from 'node:assert/strict';
import test from 'node:test';
import { openWritingApplication } from '@ismail-elkorchi/writing-agent';
import { writingRpcMethods } from '@ismail-elkorchi/writing-agent/rpc';
import { fixture, ScriptedWritingProvider, submit } from './helpers/runtime.js';

test('application resource policy reaches RPC inspection and survives separate runs',
  { skip: process.platform !== 'linux' }, async (t) => {
    const f = await fixture();
    await f.application.close();
    const provider = new ScriptedWritingProvider(['First.', 'Second.']);
    const budget = { maxInvocations: 5 };
    const contextPolicy = { maxSourceBytes: 10000, committedRetainedStateBytes: 20000,
      sessionStateMutationBytes: 3000, sessionStateReadBytes: 4000 };
    const app = await openWritingApplication({ rootDirectory: f.root, stateRoot: f.stateRoot,
      configuration: { provider, model: 'writing-test' }, inferenceBudget: budget, contextPolicy,
      maxOutputTokens: 512, contextControlPolicy: { requestsPerBoundary: 2 },
      outputReservationPolicy: { minimum: 128, maximum: 512 } });
    t.after(async () => { await app.close(); await f.close(); });
    budget.maxInvocations = 100;
    contextPolicy.maxSourceBytes = 1;
    await app.start();
    const methods = writingRpcMethods(app, () => {});
    const before = await methods['context.read'].invoke({});
    assert.equal(before.budget.maxSourceBytes, 10000);
    assert.equal(before.budget.committedRetainedStateBytes, 20000);
    assert.equal(before.budget.sessionStateMutationBytes, 3000);
    assert.equal(before.budget.sessionStateReadBytes, 4000);
    assert.equal(before.operational.allowance.limits.maxInvocations, 5);
    await submit(app, 'First request.');
    await submit(app, 'Second request.');
    const after = await methods['context.read'].invoke({});
    assert.equal(after.operational.allowance.settled.invocations, 2);
    assert.equal(after.operational.allowance.remaining.invocations, 3);
    const admitted = await methods['context.read'].invoke({ target: 'last_admitted', limit: 1 });
    assert.equal(admitted.operational.capabilityTarget, 'last_admitted');
    assert.equal(admitted.operational.capabilities.items.length, 1);
    assert.equal(admitted.operational.lastAdmittedRequest.invocation.status, 'settled');
    const next = await methods['context.read'].invoke({ target: 'last_admitted', limit: 1,
      offset: admitted.operational.capabilities.nextOffset, expectedRevision: admitted.operational.capabilities.revision });
    assert.notEqual(next.operational.capabilities.items[0].name, admitted.operational.capabilities.items[0].name);
    await assert.rejects(methods['context.read'].invoke({ limit: 129 }), error => error.code === -32602);
    await assert.rejects(methods['context.read'].invoke({ target: 'last_admitted', expectedRevision: 'stale' }), /revision changed/);

    assert.equal(provider.requests[0].maxOutputTokens, 512);
  });

import assert from 'node:assert/strict';
import test from 'node:test';
import { openCodingApplication } from '@ismail-elkorchi/coding-agent';
import { codingRpcMethods } from '@ismail-elkorchi/coding-agent/rpc';
import { createWorkspace, scriptedOllama, finalResponse, trust } from './fixtures/scripted-cli.js';

test('application resource policy reaches RPC inspection and survives separate runs',
  { skip: process.platform !== 'linux' }, async (t) => {
    const provider = await scriptedOllama([finalResponse('First.'), finalResponse('Second.')]);
    const f = await createWorkspace({ endpoint: provider.endpoint, tools: ['read_files'], checks: [] });
    await trust(f);
    const budget = { maxInvocations: 5 };
    const contextPolicy = { maxSourceBytes: 10000, committedRetainedStateBytes: 20000,
      sessionStateMutationBytes: 3000, sessionStateReadBytes: 4000 };
    const app = await openCodingApplication({ root: f.root, stateRoot: f.stateRoot,
      providerEndpoint: provider.endpoint, inferenceBudget: budget, contextPolicy,
      maxOutputTokens: 512, contextControlPolicy: { requestsPerBoundary: 2 },
      outputReservationPolicy: { minimum: 128, maximum: 512 } });
    t.after(async () => { await app.close(); await provider.close(); await f.close(); });
    budget.maxInvocations = 100;
    contextPolicy.maxSourceBytes = 1;
    await app.start();
    const methods = codingRpcMethods(app, () => {});
    const before = await methods['context.read'].invoke({});
    assert.equal(before.budget.maxSourceBytes, 10000);
    assert.equal(before.budget.committedRetainedStateBytes, 20000);
    assert.equal(before.budget.sessionStateMutationBytes, 3000);
    assert.equal(before.budget.sessionStateReadBytes, 4000);
    assert.equal(before.operational.allowance.limits.maxInvocations, 5);
    for (const task of ['First request.', 'Second request.']) {
      const accepted = await app.submit({ task });
      assert.equal(accepted.kind, 'started');
      const result = await accepted.completion;
      assert.equal(result.terminal.executionStatus, 'completed');
    }
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

  });

test('both CLIs reject invalid resource JSON before opening a workspace', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  for (const agent of ['coding-agent', 'writing-agent']) {
    for (const [flag, value] of [
      ['--inference-budget', '{"maxInvocations":-1}'],
      ['--context-policy', '{"maxSourceBytes":0}'],
      ['--context-control-policy', '{"requestsPerBoundary":0}'],
      ['--output-reservation-policy', '{"minimum":10,"maximum":2}']
    ]) {
      await assert.rejects(run(process.execPath, [`${agent}/dist/cli.js`, 'rpc', flag, value]),
        error => error.code === 1 && /inference|positive|Too small|context control|reservation policy/iu.test(error.stderr) && !/Unknown option|unknown option/u.test(error.stderr));
    }
  }
});

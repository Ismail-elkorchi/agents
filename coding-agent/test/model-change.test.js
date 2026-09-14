import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelContinuationRequiredError } from '@agent-core/runtime';
import { codingRpcMethods } from '@ismail-elkorchi/coding-agent/rpc';
import { writingRpcMethods } from '@ismail-elkorchi/writing-agent/rpc';

for (const [name, methods] of [
  ['coding', codingRpcMethods],
  ['writing', writingRpcMethods]
]) {
  test(`${name} RPC forwards explicit fresh continuation separately from persisted model settings`, async () => {
    const calls = [];
    const adapter = { id: 'fixture' };
    const selection = { provider: 'fixture', model: 'target' };
    const application = new Proxy(
      {
        connectProvider: () => adapter,
        configureModel: async (...args) => {
          calls.push(args);
        },
        modelSelection: () => selection
      },
      { get: (target, key) => target[key] ?? (() => undefined) }
    );
    const rpc = methods(application, () => undefined)['configuration.set'];
    assert.deepEqual(await rpc.invoke({ ...selection, continuation: 'fresh' }), selection);
    assert.deepEqual(calls, [[selection, adapter, { continuation: 'fresh' }]]);
    await assert.rejects(rpc.invoke({ ...selection, continuation: 'automatic' }), /continuation/u);
    await assert.rejects(rpc.invoke({ ...selection, unexpected: true }), /Unknown/u);
    assert.equal(calls.length, 1);
    application.configureModel = async () => {
      throw new ModelContinuationRequiredError('native state');
    };
    await assert.rejects(
      rpc.invoke(selection),
      (error) => error.code === -32010 && /fresh continuation/u.test(error.message)
    );
  });
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { codingRpcMethods } from '@ismail-elkorchi/coding-agent/rpc';
import { writingRpcMethods } from '@ismail-elkorchi/writing-agent/rpc';

for (const [name, methods] of [
  ['coding', codingRpcMethods],
  ['writing', writingRpcMethods]
]) {
  test(`${name} RPC forwards model selection and rejects removed continuation configuration`, async () => {
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
    assert.deepEqual(await rpc.invoke(selection), selection);
    assert.deepEqual(calls, [[selection, adapter]]);
    await assert.rejects(rpc.invoke({ ...selection, continuation: 'fresh' }), /Unknown model selection field/u);
    await assert.rejects(rpc.invoke({ ...selection, unexpected: true }), /Unknown/u);
    assert.equal(calls.length, 1);
  });
}

for (const [name, methods] of [['coding', codingRpcMethods], ['writing', writingRpcMethods]]) {
  test(`${name} RPC has no manual context renewal command`, () => {
    const application = new Proxy({}, { get: () => () => undefined });
    assert.equal(methods(application, () => undefined)['context.fresh'], undefined);
  });
}

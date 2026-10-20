import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import { InMemoryMaterialGrantProvider, InMemoryMaterialRepository } from '@agent-core/runtime';
import { openCodingApplication } from '@ismail-elkorchi/coding-agent';
import { codingRpcMethods } from '@ismail-elkorchi/coding-agent/rpc';
import { createWorkspace, finalResponse, scriptedOllama, toolResponse, trust } from './fixtures/scripted-cli.js';

const owner = { kind: 'scope', scopeId: 'private:coder-1' };
test('coding host scopes are independent of workspace mode and use the public RPC service', { timeout: 30000, skip: process.platform !== 'linux' }, async t => {
  const materials = { repository: new InMemoryMaterialRepository(), artifacts: new InMemoryArtifactRepository(),
    grants: new InMemoryMaterialGrantProvider([{ owner, revision: 'grant-1', read: true, write: true }]) };
  const provider = await scriptedOllama([
    toolResponse('context_state_save', { owner, operations: [{ kind: 'create', text: 'The user prefers small reviewable changes.', subject: { personId: 'coder-1' } }] }),
    finalResponse('Preference recorded.')
  ]);
  const f = await createWorkspace({ endpoint: provider.endpoint, tools: ['read_files'], checks: [], maxOutputTokens: 1024 });
  let app;
  t.after(async () => { await app?.close(); await provider.close(); await f.close(); });
  await trust(f);
  const options = { root: f.root, stateRoot: f.stateRoot, providerEndpoint: provider.endpoint,
    maxOutputTokens: f.maxOutputTokens, permissionMode: 'read_only', materials };
  app = await openCodingApplication(options);
  await app.start();
  const accepted = await app.submit({ task: 'Remember my preference for small reviewable changes.' });
  assert.equal(accepted.kind, 'started');
  const result = await accepted.completion;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  let methods = codingRpcMethods(app, () => {});
  const page = await methods['material.list'].invoke({ owner });
  assert.equal(page.items.length, 1);
  const ref = { owner, itemId: page.items[0].itemId, revisionId: page.items[0].revisionId };
  assert.equal((await methods['material.read'].invoke({ ref })).text, 'The user prefers small reviewable changes.');
  assert.equal((await methods['context.read'].invoke({})).window, null);
  const sessionId = app.state().session.sessionId;
  await app.close();
  app = await openCodingApplication({ ...options, sessionSelection: { kind: 'existing', id: sessionId } });
  await app.start();
  methods = codingRpcMethods(app, () => {});
  assert.equal((await methods['material.list'].invoke({ owner })).items[0].revisionId, ref.revisionId);
  await assert.rejects(methods['material.erase'].invoke({ targets: [ref] }), /unsupported/);
  await materials.grants.withdraw(owner, (await materials.grants.get(owner)).revision);
  assert.deepEqual((await methods['material.scopes'].invoke({})).items, []);
  await assert.rejects(methods['material.read'].invoke({ ref }), /unavailable/);
  assert(!Object.keys(methods).some(name => /hostWake|triggered/.test(name)));
});

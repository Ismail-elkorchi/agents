import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { openCodingApplication } from '@ismail-elkorchi/coding-agent';
import { openWritingApplication } from '@ismail-elkorchi/writing-agent';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
import { createWorkspace, trust, scriptedOllama, finalResponse } from './fixtures/scripted-cli.js';
import { ScriptedWritingProvider } from '../../writing-agent/test/helpers/runtime.js';

for (const kind of ['coding', 'writing']) {
  async function fixture(t) {
    const old = await scriptedOllama([finalResponse('Old connection must not receive input.')]);
    const next = await scriptedOllama([finalResponse('New connection.')]);
    const f = await createWorkspace({ endpoint: old.endpoint, tools: ['read_files'], checks: [] });
    let a, b;
    t.after(async () => { await a?.close(); await b?.close(); await old.close(); await next.close(); await f.close(); });
    if (kind === 'coding') {
      await trust(f);
      const options = { root: f.root, stateRoot: f.stateRoot, permissionMode: 'full_host', provider: 'ollama', model: 'v0-scripted', providerEndpoint: old.endpoint, maxOutputTokens: 4000 };
      a = await openCodingApplication(options);
      await a.start();
      b = await openCodingApplication({ ...options, sessionSelection: { kind: 'existing', id: a.state().session.sessionId } });
    } else {
      const options = { rootDirectory: f.root, stateRoot: f.stateRoot, modelSelection: { provider: 'ollama', model: 'v0-scripted', endpoint: old.endpoint }, maxOutputTokens: 4000 };
      a = await openWritingApplication(options);
      await a.start();
      b = await openWritingApplication({ ...options, sessionId: a.state().sessionId });
    }
    await b.start();
    return { a, b, old, next };
  }

  for (const changeModel of [false, true]) test(`${kind}: stale endpoint binding reconciles before acceptance${changeModel ? ' with a new model' : ''}`, { skip: process.platform !== 'linux' }, async t => {
    const { a, b, old, next } = await fixture(t);
    const selection = { provider: 'ollama', model: changeModel ? 'v0-scripted-next' : 'v0-scripted', endpoint: next.endpoint };
    await b.configureModel(selection, b.connectProvider(selection.provider, selection.endpoint));
    const accepted = await a.submit({ task: 'Send with the durably selected connection.' });
    assert.equal(accepted.kind, 'started');
    const result = await accepted.completion;
    assert.equal(result.terminal.executionStatus, 'completed');
    assert.equal(old.chatRequests.length, 0);
    assert.equal(next.chatRequests.length, 1);
    assert.equal(next.chatRequests[0].model, selection.model);
    assert.deepEqual(a.modelSelection(), selection);
    if (kind === 'coding') {
      const location = a.persistenceLocations(accepted.runId).session;
      const repository = new JsonlSessionRepository({ rootDir: path.dirname(location) });
      const descriptor = await repository.open(a.state().session.sessionId);
      assert.deepEqual(await repository.currentModelSettings(descriptor), selection, 'Execution must not replace the base endpoint with a transport URL');
      assert.deepEqual((await repository.readSubmission(descriptor, accepted.submissionId)).configuration, selection);
      const records = (await readFile(location, 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(records.filter(record => record.type === 'submission.admitted').length, 1, 'Only the requested input was admitted');
    }
  });

  test(`${kind}: image capability admission uses the refreshed binding and remains recoverable`, { skip: process.platform !== 'linux' }, async t => {
    const { a, b, old, next } = await fixture(t);
    const selection = { provider: 'ollama', model: 'v0-scripted-next', endpoint: next.endpoint };
    await b.configureModel(selection, b.connectProvider(selection.provider, selection.endpoint));
    const artifact = await new InMemoryArtifactRepository().store({ label: 'test image', content: new Uint8Array([1, 2, 3]), mediaType: 'image/png' });
    await assert.rejects(a.submit({ task: 'Inspect the image.', images: [{ artifact }] }), /image/i);
    assert.deepEqual(a.modelSelection(), selection, 'Refresh and preparation precede image capability checking');
    assert.deepEqual(kind === 'coding' ? await a.readPendingSubmissions() : (await a.readSession()).pendingSubmissions, []);
    assert.equal(old.chatRequests.length, 0);
    assert.equal(next.chatRequests.length, 0);
    const accepted = await a.submit({ task: 'Continue without the unsupported image.' });
    assert.equal((await accepted.completion).terminal.executionStatus, 'completed');
    assert.equal(next.chatRequests.length, 1);
  });

  test(`${kind}: cross-client provider change is rejected before acceptance without closing the client`, { skip: process.platform !== 'linux' }, async t => {
    const { a, b, old } = await fixture(t);
    const provider = new ScriptedWritingProvider(['New provider works.']);
    provider.id = 'openai';
    const selection = { provider: 'openai', model: 'writing-test', endpoint: old.endpoint };
    if (kind === 'writing') a.connectProvider = () => { throw new Error('Provider credentials unavailable.'); };
    await b.configureModel(selection, provider);
    await assert.rejects(a.submit({ task: 'Do not admit against an unbound provider.' }), /credentials|API key|authentication|model|404|fetch|HTTP|Unauthorized/i);
    assert.equal(old.chatRequests.length, 0);
    assert.equal(provider.requests.length, 0);
    assert.deepEqual(kind === 'coding' ? await a.readPendingSubmissions() : (await a.readSession()).pendingSubmissions, []);
    await a.configureModel(selection, provider);
    const accepted = await a.submit({ task: 'Continue after rebinding.' });
    assert.equal(accepted.kind, 'started');
    const result = await accepted.completion;
    assert.equal(result.terminal.executionStatus, 'completed', JSON.stringify(result));
    assert.equal(provider.requests.length, 1);
  });
}

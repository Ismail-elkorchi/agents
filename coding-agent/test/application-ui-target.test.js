import assert from 'node:assert/strict';
import test from 'node:test';
import { openCodingApplication } from '@ismail-elkorchi/coding-agent';
import { createWorkspace, scriptedOllama, trust } from './fixtures/scripted-cli.js';

test('delayed review and branch actions reject their old session before accessing the new session', { skip: process.platform !== 'linux' }, async t => {
  const provider = await scriptedOllama([]);
  const fixture = await createWorkspace({ endpoint: provider.endpoint, tools: [], checks: [] });
  await trust(fixture);
  const app = await openCodingApplication({ permissionMode: 'full_host', root: fixture.root,
    stateRoot: fixture.stateRoot, provider: 'ollama', model: 'v0-scripted', providerEndpoint: provider.endpoint });
  t.after(async () => { await app.close(); await provider.close(); await fixture.close(); });
  await app.start();
  const original = app.state().session.sessionId;
  await app.newSession();
  const selected = app.state().session.sessionId;
  assert.notEqual(original, selected);
  await assert.rejects(app.readChange('unknown-run', 'a.ts', original), /selected session changed before change inspection/);
  await assert.rejects(app.branchFrom('unknown-entry', undefined, original), /selected session changed before branching/);
  assert.equal(app.state().session.sessionId, selected);
  assert.equal(provider.chatRequests.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { openCodingApplication } from '@ismail-elkorchi/coding-agent';
import { createWorkspace, scriptedOllama, finalResponse, toolResponse, trust } from './fixtures/scripted-cli.js';

for (const permissionMode of ['read_only', 'full_host'])
  test(`${permissionMode}: startup and inspection identify the effective file root`, { skip: process.platform !== 'linux' }, async (t) => {
    const provider = await scriptedOllama([finalResponse('Ready.')]);
    const fixture = await createWorkspace({ endpoint: provider.endpoint, tools: ['read_files', 'view_image'],
      checks: [{ id: 'test', command: 'npm test', coverage: 'full' }] });
    await trust(fixture);
    const options = { maxOutputTokens: fixture.maxOutputTokens, root: fixture.root, stateRoot: fixture.stateRoot, permissionMode, providerEndpoint: provider.endpoint };
    const app = await openCodingApplication(options);
    t.after(async () => { await app.close(); await provider.close(); await fixture.close(); });
    await app.start();
    const displayRoot = fixture.root;
    const inspected = await app.inspectContext();
    const content = inspected.available.resources.find(item => item.id === 'coding-agent/workspace').content;
    assert.ok(content.includes(`Workspace root: ${JSON.stringify(displayRoot)}`));
    assert.match(content, /relative to this root/);
    const submission = await app.submit({ task: 'Identify your workspace without calling tools.' });
    assert.equal(submission.kind, 'started');
    assert.equal((await submission.completion).state, 'ended');
    assert.ok(JSON.stringify(provider.chatRequests[0]).includes(JSON.stringify(content).slice(1, -1)));
    const declared = provider.chatRequests[0].tools.map(tool => tool.function.name);
    const toolNames = inspected.operational.capabilities.items.filter(tool => tool.available).map(tool => tool.name);
    assert.deepEqual([...toolNames].sort(), [...declared].sort());
    assert.ok(toolNames.includes('context_transition'));
    assert.ok(toolNames.includes('history_latest'));
    assert.equal(toolNames.includes('run_check'), permissionMode === 'full_host');
    assert.ok(!toolNames.includes('view_image'), 'The text-only model cannot view images.');
    const imageCapability = inspected.operational.capabilities.items.find(tool => tool.name === 'view_image');
    assert.equal(imageCapability.available, false);
    assert.ok(imageCapability.reasons.some(reason => reason.kind === 'model_input_modality'));
    const firstPage = (await app.inspectContext({ limit: 1 })).operational.capabilities;
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.coverage, 'partial');
    const secondPage = (await app.inspectContext({ offset: firstPage.nextOffset, limit: 1, expectedRevision: firstPage.revision })).operational.capabilities;
    assert.equal(secondPage.revision, firstPage.revision);
    assert.notEqual(secondPage.items[0].name, firstPage.items[0].name);
  });

test('reading source preserves identifiers and redacts credentials without interrupting inference', {
  skip: process.platform !== 'linux'
}, async (t) => {
  const credential = 'sk-' + 'x'.repeat(24);
  const source = `new Provider({ apiKey: 'test' });\ninterface Input { privateKey: string }\nconst sample = '${credential}';\n`;
  const provider = await scriptedOllama([
    toolResponse('read_files', { files: [{ path: 'source.ts' }] }),
    finalResponse('Source inspected.')
  ]);
  let fixture;
  let app;
  t.after(async () => {
    await app?.close();
    await provider.close();
    await fixture?.close();
  });
  fixture = await createWorkspace({
    endpoint: provider.endpoint, tools: ['read_files'], checks: [], files: { 'source.ts': source }
  });
  await trust(fixture);
  app = await openCodingApplication({
    maxOutputTokens: fixture.maxOutputTokens, root: fixture.root, stateRoot: fixture.stateRoot,
    permissionMode: 'read_only', providerEndpoint: provider.endpoint
  });
  await app.start();
  const submission = await app.submit({ task: 'Inspect source.ts.' });
  assert.equal(submission.kind, 'started');
  const result = await submission.completion;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(provider.chatRequests.length, 2);
  const observations = provider.chatRequests[1].messages.filter(message => message.role === 'tool');
  const content = JSON.stringify(observations);
  assert.ok(content.includes("apiKey: 'test'"));
  assert.ok(content.includes('privateKey: string'));
  assert.ok(content.includes('[REDACTED]'));
  assert.ok(!content.includes(credential));
});

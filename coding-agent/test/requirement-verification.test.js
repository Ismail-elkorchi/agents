import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { openCodingApplication } from '@ismail-elkorchi/coding-agent';
import { MARKDOWN_WORD_CONVENTION } from '@agents/verification';
import { createWorkspace, finalResponse, scriptedOllama, toolResponse, trust } from './fixtures/scripted-cli.js';

const rootedHost = { skip: process.platform !== 'linux' };

async function openFixture(t, { script, files, tools, permissionMode = 'review' }) {
  const provider = await scriptedOllama(script);
  const fixture = await createWorkspace({ endpoint: provider.endpoint, files, tools: tools ?? [], checks: [] });
  if (tools === undefined) await rm(path.join(fixture.root, 'coding-agent.config.json'));
  await trust(fixture);
  const application = await openCodingApplication({
    root: fixture.root, stateRoot: fixture.stateRoot, providerEndpoint: provider.endpoint,
    provider: 'ollama', model: 'v0-scripted', permissionMode
  });
  t.after(async () => {
    await application.close();
    await provider.close();
    await fixture.close();
  });
  await application.start();
  return { application, provider, fixture };
}

async function submit(application, task) {
  const acceptance = await application.submit({ task });
  assert.equal(acceptance.kind, 'started');
  const result = await acceptance.completion;
  assert.equal(result.state, 'ended');
  assert.equal(result.terminal.executionStatus, 'completed');
  const view = await application.readSession();
  return view.history.entries.filter((entry) => entry.type === 'observation' && entry.runId === acceptance.runId);
}

for (const permissionMode of ['review', 'edit', 'develop']) {
  test(`Markdown measurement needs no configuration or shell in ${permissionMode} mode`, rootedHost, async (t) => {
    const content = '\uFEFF# Two words\n\nThree more words.\n';
    const { application, provider, fixture } = await openFixture(t, {
      permissionMode, files: { 'draft.md': content },
      script: [toolResponse('count_markdown_words', { path: './draft.md' }), finalResponse('The file contains five words.')]
    });
    const [measured] = await submit(application, 'How many words are in draft.md?');
    assert.equal(measured.ok, true);
    assert.deepEqual(measured.output, {
      path: 'draft.md', words: 5, convention: MARKDOWN_WORD_CONVENTION,
      inputSha256: createHash('sha256').update(content).digest('hex')
    });
    assert.equal(await readFile(path.join(fixture.root, 'draft.md'), 'utf8'), content);
    assert.equal(provider.chatRequests[1].messages.at(-1).role, 'tool');
    assert.match(JSON.stringify(provider.chatRequests[1].messages.at(-1)), /inputSha256/);
  });
}

test('measurement refuses unavailable, unconfined, oversized and invalid UTF-8 files', rootedHost, async (t) => {
  const paths = ['missing.md', '../outside.md', 'link.md', '.env', 'invalid.md', 'oversized.md'];
  const { application, fixture } = await openFixture(t, {
    tools: ['count_markdown_words'],
    files: { '.env': 'PRIVATE_VALUE=hidden', 'invalid.md': Buffer.from([0xff]), 'oversized.md': 'a'.repeat(4_000_001) },
    script: paths.flatMap((file) => [toolResponse('count_markdown_words', { path: file }), finalResponse('Measurement unavailable.')])
  });
  const outside = path.join(fixture.root, '..', 'outside.md');
  await writeFile(outside, 'outside the workspace');
  await symlink(outside, path.join(fixture.root, 'link.md'));
  for (const file of paths) {
    const [observation] = await submit(application, `Measure ${file}.`);
    assert.equal(observation.ok, false, file);
    assert.equal(observation.output?.words, undefined, file);
  }
});

test('follow-up revisions retain the original requirement and record measurements of each saved revision', rootedHost, async (t) => {
  const patch = (before, after) => toolResponse('apply_patch', {
    patch: `*** Begin Patch\n*** Update File: draft.md\n@@\n-${before}\n+${after}\n*** End Patch`
  });
  const { application, provider, fixture } = await openFixture(t, {
    permissionMode: 'edit', tools: ['apply_patch', 'count_markdown_words'],
    files: { 'draft.md': '# First draft\n\nHello.\n', 'unrelated.txt': 'preserve me' },
    script: [
      patch('Hello.', 'Hello small world.'),
      toolResponse('count_markdown_words', { path: 'draft.md' }), finalResponse('Saved five words.'),
      patch('Hello small world.', 'Welcome small world.'),
      toolResponse('count_markdown_words', { path: 'draft.md' }), finalResponse('Revised and verified five words.')
    ]
  });
  const firstTask = 'Make draft.md exactly five words.';
  const first = await submit(application, firstTask);
  const firstCount = first.find((entry) => entry.toolName === 'count_markdown_words');
  assert.equal(firstCount.output.words, 5);
  const second = await submit(application, 'Change the greeting to Welcome.');
  const secondCount = second.find((entry) => entry.toolName === 'count_markdown_words');
  const saved = await readFile(path.join(fixture.root, 'draft.md'), 'utf8');
  assert.equal(saved, '# First draft\n\nWelcome small world.\n');
  assert.equal(secondCount.output.words, 5);
  assert.equal(secondCount.output.inputSha256, createHash('sha256').update(saved).digest('hex'));
  assert.notEqual(secondCount.output.inputSha256, firstCount.output.inputSha256);
  assert.equal(await readFile(path.join(fixture.root, 'unrelated.txt'), 'utf8'), 'preserve me');
  const lastRequest = provider.chatRequests.at(-1);
  assert(lastRequest.messages.some((item) => item.role === 'user' && item.content === firstTask));
  assert.equal(lastRequest.messages.at(-1).role, 'tool');
  assert.match(lastRequest.messages.at(-1).content, new RegExp(secondCount.output.inputSha256));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { openCodingApplication } from '@ismail-elkorchi/coding-agent';
import { createWorkspace, finalResponse, scriptedOllama, toolResponse, trust } from './fixtures/scripted-cli.js';

test('current instructions, earlier observations, and unrelated files survive changes of task and requirements', {
  skip: process.platform !== 'linux', timeout: 30_000
}, async (t) => {
  const code = 'export const sum = (values) => values.reduce((a, b) => a + b);\n';
  const provider = await scriptedOllama([
    toolResponse('read_files', { files: [{ path: 'math.mjs', startLine: 1, lineCount: 5 }] }),
    finalResponse('The empty array case throws.'),
    toolResponse('apply_patch', { patch: '*** Begin Patch\n*** Update File: settings.json\n@@\n-{"port":3000,"theme":"dark"}\n+{"port":9090}\n*** End Patch' }),
    finalResponse('Updated the settings.'),
    finalResponse('The port is now 9090.')
  ]);
  const f = await createWorkspace({ endpoint: provider.endpoint, tools: ['read_files', 'apply_patch'], checks: [],
    files: { 'math.mjs': code, 'settings.json': '{"port":3000,"theme":"dark"}\n' } });
  let app;
  t.after(async () => { await app?.close(); await provider.close(); await f.close(); });
  await trust(f);
  app = await openCodingApplication({ root: f.root, stateRoot: f.stateRoot, providerEndpoint: provider.endpoint, permissionMode: 'develop' });
  await app.start();
  const tasks = [
    'Inspect math.mjs and explain its empty array behavior without editing.',
    'Change of task: set the port in settings.json to 9090 and remove the theme setting. Keep math.mjs unchanged.',
    'Explain the resulting configuration without changing it.'
  ];
  for (const task of tasks) {
    const submitted = await app.submit({ task });
    assert.equal(submitted.kind, 'started');
    const result = await submitted.completion;
    assert.equal(result.state, 'ended');
    assert.equal(result.terminal.executionStatus, 'completed');
  }
  assert.equal(await readFile(path.join(f.root, 'math.mjs'), 'utf8'), code);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, 'settings.json'), 'utf8')), { port: 9090 });
  const { history } = await app.readSession();
  assert.deepEqual(history.entries.filter((entry) => entry.type === 'input').map((entry) => entry.task), tasks);
  const messages = provider.chatRequests.at(-1).messages;
  for (const task of tasks) assert(messages.some((message) => message.role === 'user' && message.content === task));
  assert(messages.findIndex((message) => message.content === tasks[2]) > messages.findIndex((message) => message.content === 'Updated the settings.'));
});

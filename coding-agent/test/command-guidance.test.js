import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir } from 'node:fs/promises';
import { openCodingApplication } from '@ismail-elkorchi/coding-agent';
import { createWorkspace, finalResponse, scriptedOllama, toolResponse, trust } from './fixtures/scripted-cli.js';

test('nested repository guidance precedes Sandbox preparation and the reconsidered command completes', {
  skip: process.platform !== 'linux', timeout: 30_000
}, async (t) => {
  const command = () => toolResponse('exec_command', { command: 'printf inspected', workdir: 'subproject' });
  const provider = await scriptedOllama([
    command(),
    async (request) => {
      assert(request.messages.some((message) => message.role === 'tool' && message.content.includes('context_required') && message.content.includes('GUIDANCE-BEFORE-PREPARATION')));
      const files = await readdir(fixture.stateRoot, { recursive: true });
      assert.equal(files.filter((file) => file.includes('/commands/') && file.endsWith('/state.json')).length, 0);
      return command();
    },
    (request) => {
      assert(request.messages.at(-1).content.includes('inspected'));
      return finalResponse('Inspection complete.');
    }
  ]);
  const fixture = await createWorkspace({ endpoint: provider.endpoint, tools: ['exec_command'], checks: [], files: { 'subproject/AGENTS.md': 'GUIDANCE-BEFORE-PREPARATION: preserve unrelated files.\n' } });
  let application;
  t.after(async () => { await application?.close(); await provider.close(); await fixture.close(); });
  await trust(fixture);
  application = await openCodingApplication({ root: fixture.root, stateRoot: fixture.stateRoot, providerEndpoint: provider.endpoint, permissionMode: 'develop' });
  await application.start();
  const submitted = await application.submit({ task: 'Inspect the subproject.' });
  assert.equal(submitted.kind, 'started');
  const completed = await submitted.completion;
  assert.equal(completed.state, 'ended');
  assert.equal(completed.terminal.executionStatus, 'completed', JSON.stringify(completed.terminal));
  const { history } = await application.readSession();
  const observations = history.entries.filter((entry) => entry.type === 'observation');
  assert.equal(observations.length, 2);
  assert.equal(observations[0].output.effectStarted, false);
  assert.equal(observations[1].output.exitCode, 0);
});

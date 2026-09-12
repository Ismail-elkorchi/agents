import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  createWorkspace,
  finalResponse,
  runCli,
  scriptedOllama,
  toolResponse,
  trust
} from './fixtures/scripted-cli.js';

test('taskless exec resume rejects a session without unfinished work', async () => {
  const provider = await scriptedOllama([finalResponse('Inspection complete.')]);
  const fixture = await createWorkspace({ tools: [], checks: [], endpoint: provider.endpoint });
  try {
    await trust(fixture);
    const completed = await runCli(fixture, ['exec', 'Inspect the workspace.']);
    assert.equal(completed.code, 0, completed.stderr);
    const output = await runCli(fixture, ['exec', '--resume']);
    assert.equal(output.code, 1);
    assert.match(output.stderr, /no unfinished run/u);
  } finally {
    await provider.close();
    await fixture.close();
  }
});

test('a review question completes without creating mutable work or opening command execution', async () => {
  const provider = await scriptedOllama([finalResponse('The function returns the number of values.')]);
  const fixture = await createWorkspace({
    endpoint: provider.endpoint,
    tools: ['read_files', 'apply_patch', 'exec_command'],
    checks: [],
    files: { 'src/count.js': 'export const count = (values) => values.length;\n' }
  });
  try {
    await trust(fixture);
    const result = await runCli(fixture, [
      'exec',
      'What does src/count.js do?',
      '--permissions',
      'review'
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /returns the number of values/u);
    assert.equal(
      await readFile(path.join(fixture.root, 'src/count.js'), 'utf8'),
      'export const count = (values) => values.length;\n'
    );
  } finally {
    await provider.close();
    await fixture.close();
  }
});

test('an authorized patch changes the selected workspace before the final answer', async () => {
  const original = 'alpha\n';
  const provider = await scriptedOllama([
    toolResponse('read_files', { files: [{ path: 'src/note.txt' }] }),
    toolResponse('apply_patch', {
      patch: '*** Begin Patch\n*** Update File: src/note.txt\n@@\n-alpha\n+beta\n*** End Patch',
      expectedOldSha256: {
        'src/note.txt': createHash('sha256').update(original).digest('hex')
      }
    }),
    toolResponse('apply_patch', {
      patch: '*** Begin Patch\n*** Update File: src/note.txt\n@@\n-alpha\n+beta\n*** End Patch',
      expectedOldSha256: {
        'src/note.txt': createHash('sha256').update(original).digest('hex')
      }
    }),
    finalResponse('Changed the note to beta.')
  ]);
  const fixture = await createWorkspace({
    endpoint: provider.endpoint,
    tools: ['read_files', 'apply_patch'],
    checks: [],
    files: {
      'AGENTS.md': 'Inspect a file before editing it.\n',
      'src/AGENTS.md': 'Only change src/note.txt.\n',
      'src/note.txt': original,
      'dirty.txt': 'preserve me\n'
    }
  });
  try {
    await trust(fixture);
    const result = await runCli(fixture, [
      'exec',
      'Change src/note.txt from alpha to beta.',
      '--permissions',
      'edit'
    ]);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(await readFile(path.join(fixture.root, 'src/note.txt'), 'utf8'), 'beta\n');
    assert.equal(await readFile(path.join(fixture.root, 'dirty.txt'), 'utf8'), 'preserve me\n');
    assert.match(JSON.stringify(provider.chatRequests[0]), /Inspect a file before editing it/u);
    assert.match(JSON.stringify(provider.chatRequests[2]), /Only change src\/note\.txt/u);
  } finally {
    await provider.close();
    await fixture.close();
  }
});

test('an explicitly configured failed check reaches the model and remains visible', async () => {
  const provider = await scriptedOllama([
    toolResponse('run_check', { id: 'explicit' }),
    finalResponse('The configured check failed with the observed exit status.')
  ]);
  const fixture = await createWorkspace({
    endpoint: provider.endpoint,
    tools: ['read_files', 'exec_command'],
    checks: [
      {
        id: 'explicit',
        command: `node -e 'process.stderr.write("expected check failure\\n"); process.exit(7)'`,
        coverage: 'targeted'
      }
    ]
  });
  try {
    await trust(fixture);
    const result = await runCli(fixture, [
      'exec',
      'Run the configured check and report its result.',
      '--permissions',
      'develop'
    ]);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Check explicit: required\/failed \(targeted\)/u);
    const toolMessage = provider.chatRequests[1].messages.find(
      (message) => message.role === 'tool' && message.tool_name === 'run_check'
    );
    assert(toolMessage);
    const observation = JSON.parse(toolMessage.content);
    assert.equal(observation.results.output.status, 'failed');
    assert.equal(observation.results.output.processStatus, 'exited');
  } finally {
    await provider.close();
    await fixture.close();
  }
});

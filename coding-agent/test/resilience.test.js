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

test('a question completes without mutating the workspace', async () => {
  const provider = await scriptedOllama([
    finalResponse('The function returns the number of values.')
  ]);
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
      'sandbox'
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

test('read-only mode reads the host project without opening Sandsurf', async () => {
  const provider = await scriptedOllama([
    toolResponse('read_files', { files: [{ path: 'source.txt' }] }),
    finalResponse('Read the host file.')
  ]);
  const fixture = await createWorkspace({
    endpoint: provider.endpoint,
    tools: ['read_files', 'exec_command'],
    checks: [],
    files: { 'source.txt': 'host source\n' }
  });
  try {
    await trust(fixture);
    const result = await runCli(fixture, [
      'exec', 'Read source.txt.', '--permissions', 'read_only'
    ]);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(JSON.stringify(provider.chatRequests[1]), /host source/u);
  } finally {
    await provider.close();
    await fixture.close();
  }
});

test('full host mode can execute outside the selected project', async () => {
  const provider = await scriptedOllama([]);
  const fixture = await createWorkspace({
    endpoint: provider.endpoint,
    tools: ['exec_command'],
    checks: []
  });
  const outside = path.join(path.dirname(fixture.root), 'host-result.txt');
  provider.enqueueResponses(toolResponse('exec_command', {
    command: `printf host > '${outside}'`,
    workdir: '.',
    timeoutMs: 20_000
  }), finalResponse('Host command finished.'));
  try {
    await trust(fixture);
    const result = await runCli(fixture, [
      'exec', 'Write the result outside the project.', '--permissions', 'full_host'
    ]);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(await readFile(outside, 'utf8'), 'host');
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
      'sandbox'
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
      'sandbox'
    ]);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Check explicit: required\/failed \(targeted\)/u);
    const toolMessage = provider.chatRequests[1].messages.find(
      (message) => message.role === 'tool' && message.tool_name === 'run_check'
    );
    assert(toolMessage);
    assert.match(toolMessage.content, /Check explicit: failed; process exited, exit 7/u);
    assert.match(toolMessage.content, /Applicability: unknown/u);
    assert.match(result.stdout, /applicability unknown/u);
  } finally {
    await provider.close();
    await fixture.close();
  }
});

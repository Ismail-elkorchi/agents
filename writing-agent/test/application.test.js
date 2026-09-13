import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { openWritingApplication } from '@ismail-elkorchi/writing-agent';
import { fixture, patchResponse, toolCall, submit, ScriptedWritingProvider } from './helpers/runtime.js';

const integration = { skip: process.platform !== 'linux', timeout: 30_000 };
const patch = '*** Begin Patch\n*** Update File: document.txt\n@@\n-Old line.\n+New line.\n*** End Patch';

test('an authorized revision edits the workspace directly with no proposal or second-model gate', integration, async (t) => {
  const f = await fixture('Old line.\n', { responses: [patchResponse(patch), 'Updated.'] });
  t.after(() => f.close());
  await f.application.start();
  const result = await submit(f.application, 'Replace Old line. with New line. in document.txt.');
  assert.equal(result.state, 'ended', JSON.stringify(result));
  assert.equal(result.terminal.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(await readFile(path.join(f.root, 'document.txt'), 'utf8'), 'New line.\n');
  assert.equal(f.provider.requests.length, 2);
  const history = await f.application.readHistory();
  assert(history.entries.some((entry) => entry.type === 'observation' && entry.toolName === 'apply_patch' && entry.ok));
});

test(
  'review mode denies workspace mutations even when the model asks to patch a file',
  integration,
  async (t) => {
    const f = await fixture('Old line.\n', {
      mode: 'review',
      responses: [patchResponse(patch), 'Suggested revision: New line.']
    });
    t.after(() => f.close());
    await f.application.start();
    await submit(f.application, 'Review the wording.');
    assert.equal(await readFile(path.join(f.root, 'document.txt'), 'utf8'), 'Old line.\n');
    const observation = (await f.application.readHistory()).entries.find(
      (entry) => entry.type === 'observation'
    );
    assert.equal(observation.ok, false);
    assert(!f.provider.requests[0].tools.some((tool) => tool.name === 'apply_patch'));
    assert(
      f.provider.requests[0].tools.some(
        (tool) => tool.type === 'function' && tool.function.name === 'notes_write'
      )
    );
  }
);

test(
  'conversation changes remain ordinary inputs across prompts and reopen, without fabricated brief requirements',
  integration,
  async (t) => {
    const prompts = [
      'Écris en français.',
      'Actually write in Arabic, without the earlier length restriction.',
      'Discuss a new topic without changing files.'
    ];
    const f = await fixture('نص المستخدم\n', { responses: ['D’accord.', 'حسنًا.', 'A discussion.'] });
    let reopened;
    t.after(async () => {
      await reopened?.close();
      await f.close();
    });
    await f.application.start();
    for (const prompt of prompts) {
      const result = await submit(f.application, prompt);
      assert.equal(result.terminal.executionStatus, 'completed');
    }
    assert.deepEqual(
      (await f.application.readHistory()).entries
        .filter((entry) => entry.type === 'input')
        .map((entry) => entry.task),
      prompts
    );
    assert.equal(f.provider.requests.length, prompts.length);
    assert.equal(await readFile(path.join(f.root, 'document.txt'), 'utf8'), 'نص المستخدم\n');
    const lastRequest = JSON.stringify(f.provider.requests.at(-1));
    for (const prompt of prompts) assert(lastRequest.includes(prompt));
    assert(!lastRequest.includes('criterion-user-instruction'));
    await f.application.close();
    const provider = new ScriptedWritingProvider(['Continued.']);
    reopened = await openWritingApplication({
      rootDirectory: f.root,
      stateRoot: f.stateRoot,
      configuration: { provider, model: 'writing-test' }
    });
    await reopened.start();
    assert.equal(reopened.state().sessionId, f.application.state().sessionId);
    await submit(reopened, 'Continue from this conversation.');
    assert(JSON.stringify(provider.requests[0]).includes(prompts[1]));
  }
);

test('workspace tools and document viewing reject aliases and private state, while external user edits remain readable', integration, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.application.start();
  await writeFile(path.join(f.root, 'document.txt'), '\uFEFFChanged by the user.\n');
  assert.equal((await f.application.readDocument('document.txt')).content, '\uFEFFChanged by the user.\n');
  await assert.rejects(f.application.readDocument('../state/.writing-agent-state-root'));
  await symlink(path.join(f.stateRoot, '.writing-agent-state-root'), path.join(f.root, 'alias'));
  await assert.rejects(f.application.readDocument('alias'));
  await assert.rejects(openWritingApplication({ rootDirectory: f.root, stateRoot: path.join(f.root, 'private') }), /outside/);
});

test(
  'history and notes are available as model tools without preselected document excerpts',
  integration,
  async (t) => {
    const f = await fixture('Only retrieve this when needed.\n', {
      responses: [
        toolCall('read_files', { files: [{ path: 'document.txt', startLine: 1, lineCount: 10 }] }),
        'Read.'
      ]
    });
    t.after(() => f.close());
    await f.application.start();
    await submit(f.application, 'Read document.txt.');
    const first = f.provider.requests[0];
    assert(!JSON.stringify(first).includes('Only retrieve this when needed.'));
    assert(JSON.stringify(f.provider.requests[1]).includes('Only retrieve this when needed.'));
    for (const name of ['history_read', 'notes_write', 'context_transition'])
      assert(
        first.tools.some((tool) => tool.type === 'function' && tool.function.name === name),
        name
      );
  }
);

test(
  'the default Codex writing provider reaches inference without a wire output cap or recovery',
  integration,
  async (t) => {
    const { offlineCodex } = await import('../../test-helpers/codex.js');
    const { createWritingProvider } = await import('@ismail-elkorchi/writing-agent');
    const codex = await offlineCodex(t);
    const f = await fixture('A short document.\n');
    const binding = createWritingProvider({
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      endpoint: codex.endpoint
    });
    const app = f.application;
    await app.configure(binding);
    t.after(() => f.close());
    await app.start();
    const submission = await app.submit({ task: 'Review document.txt.' });
    assert.equal(submission.kind, 'started');
    const result = await submission.completion;
    assert.equal(result.state, 'ended', JSON.stringify(result));
    assert.equal(result.terminal.executionStatus, 'completed', JSON.stringify(result));
    assert.equal(codex.requests.length, 1);
    assert.equal((await app.readSession()).session.suspension, undefined);
  }
);

test(
  'reopening a suspended review uses its recorded permission mode and never resends an unknown provider request',
  integration,
  async (t) => {
    const f = await fixture('Old line.\n', {
      mode: 'review',
      responses: [
        async () => {
          throw new Error('Connection lost.');
        }
      ]
    });
    let reopened;
    t.after(async () => {
      await reopened?.close();
      await f.close();
    });
    await f.application.start();
    const interrupted = await submit(f.application, 'Review the wording.');
    assert.equal(interrupted.state, 'suspended');
    await f.application.close();
    const provider = new ScriptedWritingProvider(['This must not be dispatched.']);
    reopened = await openWritingApplication({
      rootDirectory: f.root,
      stateRoot: f.stateRoot,
      configuration: { provider, model: 'writing-test' }
    });
    await reopened.start();
    const recorded = reopened.inspectSuspension();
    assert.equal(recorded.runId, interrupted.runId);
    const reconciled = await reopened.resume(recorded.runId);
    assert.equal(reconciled.state, 'suspended');
    assert.equal(reconciled.reason, 'provider_outcome_unknown');
    assert.equal(provider.requests.length, 0);
    assert.equal(await readFile(path.join(f.root, 'document.txt'), 'utf8'), 'Old line.\n');
    await reopened.abort(recorded.runId);
  }
);

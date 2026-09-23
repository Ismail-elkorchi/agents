import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { rpcClient } from '../../test-helpers/rpc-client.js';
import {
  createWorkspace,
  finalResponse,
  scriptedOllama,
  trust,
  toolResponse
} from './fixtures/scripted-cli.js';

test(
  'coding stdio acceptance, notifications, shutdown, and restart preserve the selected session',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const provider = await scriptedOllama([
      finalResponse('The workspace needs no edits.'),
      finalResponse('A second instruction.')
    ]);
    const f = await createWorkspace({
      endpoint: provider.endpoint,
      tools: ['read_files'],
      checks: [],
      files: { 'README.md': '# Workspace\n' }
    });
    t.after(async () => {
      await provider.close();
      await f.close();
    });
    await trust(f);
    const args = [
      'coding-agent/test/fixtures/scripted-cli-entry.js',
      'rpc',
      '--root',
      f.root,
      '--state-root',
      f.stateRoot,
      '--provider-endpoint',
      provider.endpoint
    ];
    const client = rpcClient(args);
    t.after(() => client.close());
    const state = await client.request('application.read');
    assert.equal(state.status, 'ready');
    const sessionId = state.session.sessionId;
    await assert.rejects(
      client.request('input.submit', { task: 4 }),
      (error) => error.code === -32602
    );
    const accepted = await client.request('input.submit', {
      task: 'Inspect whether edits are needed.\u2028Keep exact input.',
      instructions: ['Answer this side question directly.'],
      contextItems: [
        {
          sourceUri: 'test://rpc/context',
          sourceKind: 'user',
          integrity: 'verified',
          representation: 'full',
          mediaType: 'text/plain',
          title: 'RPC request context',
          content: 'The caller supplied this context.',
          purpose: 'Verify submission metadata transport.'
        }
      ],
      relationship: { kind: 'side_question' }
    });
    assert.equal(accepted.kind, 'started');
    assert.equal('completion' in accepted, false);
    const completed = await client.notification(
      'run.completed',
      (event) => event.runId === accepted.runId
    );
    assert.equal(completed.result.state, 'ended');
    const view = await client.request('session.read');
    assert(
      view.history.entries.some(
        (entry) => entry.type === 'assistant' && entry.content === 'The workspace needs no edits.'
      )
    );
    const input = view.history.entries.find((entry) => entry.type === 'input');
    assert.deepEqual(input.originalInput.instructions, ['Answer this side question directly.']);
    assert.equal(input.originalInput.contextItems[0].sourceUri, 'test://rpc/context');
    assert.equal(input.originalInput.relationship.kind, 'side_question');
    const found = await client.request('history.search', { query: 'exact input' });
    assert.equal(found.matches.length, 1);
    await client.request('application.shutdown');
    const exit = await client.exited;
    assert.equal(exit.code, 0, exit.stderr);
    const restored = rpcClient([...args, '--session', sessionId]);
    t.after(() => restored.close());
    assert.equal((await restored.request('session.read')).session.sessionId, sessionId);
    const second = await restored.request('input.submit', { task: 'Continue the conversation.' });
    await restored.notification('run.completed', (event) => event.runId === second.runId);
    assert.equal(
      (await restored.request('history.read')).history.entries.filter(
        (entry) => entry.type === 'input'
      ).length,
      2
    );
    assert.equal((await restored.close()).code, 0);
  }
);

test(
  'EOF during provider work closes the owner and restart exposes recorded recovery without retrying input',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const provider = await scriptedOllama([]);
    provider.blockNextChat();
    const f = await createWorkspace({
      endpoint: provider.endpoint,
      tools: ['read_files'],
      checks: []
    });
    t.after(async () => {
      provider.releaseBlockedChat(finalResponse('Late response.'));
      await provider.close();
      await f.close();
    });
    await trust(f);
    const args = [
      'coding-agent/test/fixtures/scripted-cli-entry.js',
      'rpc',
      '--root',
      f.root,
      '--state-root',
      f.stateRoot,
      '--provider-endpoint',
      provider.endpoint
    ];
    const client = rpcClient(args);
    t.after(() => client.close());
    const sessionId = (await client.request('application.read')).session.sessionId;
    const accepted = await client.request('input.submit', {
      task: 'An operation interrupted by EOF.'
    });
    assert.equal(accepted.kind, 'started');
    await provider.waitForBlockedChat();
    const exit = await client.close();
    assert.equal(exit.code, 0, exit.stderr);
    const restored = rpcClient([...args, '--session', sessionId]);
    t.after(() => restored.close());
    const view = await restored.request('session.read');
    assert.equal(view.session.sessionId, sessionId);
    assert.equal(provider.chatRequests.length, 1);
    assert(
      view.history.entries.some((entry) => entry.type === 'input' && entry.runId === accepted.runId)
    );
    assert.equal((await restored.close()).code, 0);
  }
);

test(
  'RPC exposes exact historical check definitions and stale applicability after an external edit',
  {
    skip: process.platform !== 'linux',
    timeout: 30000
  },
  async (t) => {
    const { writeFile } = await import('node:fs/promises');
    const provider = await scriptedOllama([
      toolResponse('run_check', { id: 'explicit' }),
      finalResponse('The command exited zero; its present applicability is not established.')
    ]);
    const f = await createWorkspace({
      endpoint: provider.endpoint,
      tools: ['read_files', 'exec_command'],
      checks: [
        {
          id: 'explicit',
          command: 'true',
          timeoutMs: 2345,
          coverage: 'targeted',
          testedPaths: ['input.txt']
        }
      ],
      files: { 'input.txt': 'before' }
    });
    t.after(async () => {
      await provider.close();
      await f.close();
    });
    await trust(f);
    const client = rpcClient([
      'coding-agent/test/fixtures/scripted-cli-entry.js',
      'rpc',
      '--root',
      f.root,
      '--state-root',
      f.stateRoot,
      '--provider-endpoint',
      provider.endpoint,
      '--permissions',
      'sandbox'
    ]);
    t.after(() => client.close());
    await client.request('application.read');
    const accepted = await client.request('input.submit', { task: 'Run the explicit check.' });
    await client.notification('run.completed', (event) => event.runId === accepted.runId);
    const report = await client.request('verification.read', { runId: accepted.runId });
    const observed = report.checks.find((check) => check.receipt !== undefined);
    assert(observed);
    assert.equal(observed.status, 'passed');
    assert.equal(observed.applicability.status, 'unknown');
    assert.equal(observed.definition.command, 'true');
    assert.equal(observed.definition.timeoutMs, 2345);
    await writeFile(path.join(f.root, 'input.txt'), 'after');
    const changed = await client.request('verification.read', { runId: accepted.runId });
    assert.equal(changed.checks[0].status, 'passed');
    assert.equal(changed.checks[0].applicability.status, 'stale');
    assert.equal(changed.checks[0].receipt.hash, observed.receipt.hash);
    await client.request('application.shutdown');
  }
);

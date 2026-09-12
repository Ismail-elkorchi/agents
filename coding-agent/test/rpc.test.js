import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { rpcClient } from '../../rpc/test/helpers/client.js';
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
      'coding-agent/dist/cli.js',
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
    await assert.rejects(client.request('input.submit', { task: 4 }), (error) => error.code === -32602);
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
    const completed = await client.notification('run.completed', (event) => event.runId === accepted.runId);
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
      (await restored.request('history.read')).history.entries.filter((entry) => entry.type === 'input')
        .length,
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
    const f = await createWorkspace({ endpoint: provider.endpoint, tools: ['read_files'], checks: [] });
    t.after(async () => {
      provider.releaseBlockedChat(finalResponse('Late response.'));
      await provider.close();
      await f.close();
    });
    await trust(f);
    const args = [
      'coding-agent/dist/cli.js',
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
    const accepted = await client.request('input.submit', { task: 'An operation interrupted by EOF.' });
    assert.equal(accepted.kind, 'started');
    await provider.waitForBlockedChat();
    const exit = await client.close();
    assert.equal(exit.code, 0, exit.stderr);
    const restored = rpcClient([...args, '--session', sessionId]);
    t.after(() => restored.close());
    const view = await restored.request('session.read');
    assert.equal(view.session.sessionId, sessionId);
    assert.equal(provider.chatRequests.length, 1);
    assert(view.history.entries.some((entry) => entry.type === 'input' && entry.runId === accepted.runId));
    assert.equal((await restored.close()).code, 0);
  }
);

test(
  'approval survives connection loss, rejects a stale fingerprint, and exposes the exact workspace patch',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const original = 'export const enabled = false;\n';
    const patch =
      '*** Begin Patch\n*** Update File: feature.js\n@@\n-export const enabled = false;\n+export const enabled = true;\n*** End Patch';
    const provider = await scriptedOllama([
      toolResponse('read_files', { files: [{ path: 'feature.js' }] }),
      toolResponse('apply_patch', {
        patch,
        expectedOldSha256: { 'feature.js': createHash('sha256').update(original).digest('hex') }
      }),
      finalResponse('Feature enabled.')
    ]);
    const f = await createWorkspace({
      endpoint: provider.endpoint,
      tools: ['read_files', 'apply_patch'],
      checks: [],
      files: { 'feature.js': original },
      requireApprovalFor: ['write']
    });
    t.after(async () => {
      await provider.close();
      await f.close();
    });
    await trust(f);
    const args = [
      'coding-agent/dist/cli.js',
      'rpc',
      '--root',
      f.root,
      '--state-root',
      f.stateRoot,
      '--provider-endpoint',
      provider.endpoint,
      '--permissions',
      'edit'
    ];
    const first = rpcClient(args);
    t.after(() => first.close());
    const sessionId = (await first.request('application.read')).session.sessionId;
    const accepted = await first.request('input.submit', { task: 'Enable the feature.' });
    const suspended = await first.notification('run.completed', (event) => event.runId === accepted.runId);
    const approval = suspended.result.pendingApprovals[0];
    await first.close();
    const restored = rpcClient([...args, '--session', sessionId]);
    t.after(() => restored.close());
    const view = await restored.request('session.read');
    assert.equal(view.session.phase, 'suspended');
    assert(view.runs.some((run) => run.state.runId === accepted.runId));
    const decision = {
      runId: accepted.runId,
      approvalId: approval.approvalId,
      fingerprint: approval.fingerprint,
      decision: 'allow'
    };
    await assert.rejects(restored.request('approval.resolve', { ...decision, fingerprint: 'stale' }));
    assert.equal(await readFile(path.join(f.root, 'feature.js'), 'utf8'), original);
    const result = await restored.request('approval.resolve', decision);
    assert.equal(result.state, 'ended');
    const change = await restored.request('change.read', { runId: accepted.runId, path: 'feature.js' });
    assert.equal(change.patches.length, 1);
    assert.equal(change.patches[0].patch, patch);
    assert.equal(change.patches[0].receipt.applicationStatus, 'applied');
    assert.equal(await readFile(path.join(f.root, 'feature.js'), 'utf8'), 'export const enabled = true;\n');
    assert.equal((await restored.close()).code, 0);
  }
);

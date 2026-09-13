import assert from 'node:assert/strict';
import test from 'node:test';
import { rpcClient } from '../../test-helpers/rpc-client.js';
import { fixture } from './helpers/runtime.js';

test(
  'stdio supports direct editing and subsequent read-only review in the same conversation',
  {
    skip: process.platform !== 'linux',
    timeout: 30_000
  },
  async (t) => {
    const f = await fixture();
    await f.application.close();
    const client = rpcClient(['writing-agent/test/helpers/rpc-server.js', f.root, f.stateRoot]);
    t.after(async () => {
      await client.close();
      await f.close();
    });
    const first = await client.request('input.submit', {
      task: 'Replace Old line. with New line. in document.txt.'
    });
    assert.equal(first.kind, 'started');
    assert(!('completion' in first));
    const completed = await client.notification('run.completed', ({ runId }) => runId === first.runId);
    assert.equal(completed.result.terminal.executionStatus, 'completed');
    assert.equal((await client.request('document.read', { path: 'document.txt' })).content, 'New line.\n');
    await client.request('mode.select', { mode: 'review' });
    const second = await client.request('input.submit', { task: 'Review the wording without editing.' });
    await client.notification('run.completed', ({ runId }) => runId === second.runId);
    assert.equal((await client.request('document.read', { path: 'document.txt' })).content, 'New line.\n');
    assert.equal(
      (await client.request('history.read')).entries.filter((entry) => entry.type === 'input').length,
      2
    );
    await assert.rejects(client.request('proposal.accept', {}), /method/i);
    assert.equal((await client.close()).code, 0);
  }
);

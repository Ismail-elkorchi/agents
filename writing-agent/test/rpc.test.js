import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { rpcClient } from '../../rpc/test/helpers/client.js';
import { fixture } from './helpers/runtime.js';

test('stdio writing client selects a passage, rejects, accepts, applies, undoes, and continues in one session', async (t) => {
  const f = await fixture('Opening.\n\nOld line.\n\nClosing.\n');
  f.project.close();
  const client = rpcClient([
    'writing-agent/test/helpers/rpc-server.js',
    f.root,
    f.stateRoot,
    f.resource.resourceId
  ]);
  t.after(async () => {
    await client.close();
    await rm(f.parent, { recursive: true, force: true });
  });
  const document = await client.request('document.read', { resourceId: f.resource.resourceId });
  const selection = {
    ...document.selection,
    range: { start: { line: 3, column: 1 }, end: { line: 3, column: 10 } }
  };
  const submit = async (selection) => {
    const accepted = await client.request('instruction.submit', {
      kind: 'revise',
      instruction: 'Revise this sentence.',
      selection
    });
    assert.equal(accepted.kind, 'accepted');
    assert.equal('completion' in accepted, false);
    const completed = await client.notification(
      'operation.completed',
      (event) => event.result.operationId === accepted.operationId
    );
    return { accepted, result: completed.result };
  };
  const first = await submit(selection);
  const proposalId = first.result.proposalId;
  const comparison = await client.request('proposal.compare', { proposalId });
  assert.equal(comparison.comparisons[0].after, 'Opening.\n\nNew line.\n\nClosing.\n');
  await client.request('proposal.reject', { proposalId, explanation: 'Try again.' });
  assert.equal(await readFile(path.join(f.root, 'draft.md'), 'utf8'), document.content);
  const second = await submit(selection);
  assert.equal(second.accepted.sessionId, first.accepted.sessionId);
  const next = { proposalId: second.result.proposalId };
  await client.request('proposal.accept', {
    ...next,
    explanation: 'Reviewed.',
    humanCriterionDecisions: [
      {
        criterionId: 'criterion-user-instruction',
        verdict: 'passed',
        explanation: 'The sentence matches the instruction.'
      }
    ]
  });
  const authorization = await client.request('proposal.authorize', next);
  await assert.rejects(
    client.request('proposal.apply', { ...next, authorization: { ...authorization, proposalId } }),
    /authorization/u
  );
  await client.request('proposal.apply', { ...next, authorization });
  await assert.rejects(
    client.request('instruction.submit', { kind: 'revise', instruction: 'Stale.', selection }),
    /stale/u
  );
  await client.request('revision.undo', { explanation: 'Restore the original.' });
  assert.equal(await readFile(path.join(f.root, 'draft.md'), 'utf8'), document.content);
  const fresh = await client.request('document.read', { resourceId: f.resource.resourceId });
  const third = await submit({ ...selection, projectRevisionId: fresh.selection.projectRevisionId });
  assert.equal(third.accepted.sessionId, first.accepted.sessionId);
  const history = await client.request('history.read');
  assert.equal(history.entries.filter((entry) => entry.type === 'input').length, 3);
  const exit = await client.close();
  assert.equal(exit.code, 0, exit.stderr);
});

test('accepted writing work can fail later without turning acceptance into an RPC request error', async (t) => {
  const f = await fixture('Opening.\n\nOld line.\n\nClosing.\n');
  f.project.close();
  const client = rpcClient([
    'writing-agent/test/helpers/rpc-server.js',
    f.root,
    f.stateRoot,
    f.resource.resourceId,
    'verification-failure'
  ]);
  t.after(async () => {
    await client.close();
    await rm(f.parent, { recursive: true, force: true });
  });
  const document = await client.request('document.read', { resourceId: f.resource.resourceId });
  const accepted = await client.request('instruction.submit', {
    kind: 'revise',
    instruction: 'Revise the line.',
    selection: document.selection
  });
  assert.equal(accepted.kind, 'accepted');
  const completed = await client.notification(
    'operation.completed',
    (event) => event.result.operationId === accepted.operationId
  );
  assert.notEqual(completed.result.disposition, 'valid', JSON.stringify(completed.result));
  assert.equal(completed.result.execution.terminal.budget.totalToolCalls, 1);
  assert.equal((await client.request('application.read')).status, 'ready');
  assert.equal(await readFile(path.join(f.root, 'draft.md'), 'utf8'), document.content);
  assert.equal((await client.close()).code, 0);
});

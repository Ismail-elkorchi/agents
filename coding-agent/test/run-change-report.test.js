import assert from 'node:assert/strict';
import test from 'node:test';
import { readRunChangeReport } from '@ismail-elkorchi/coding-agent';

const hash = value => value.repeat(64);
function file(operation, old, next, options = {}) {
  return { path: 'a.txt', operation, hunkCount: 1, additions: 1, deletions: 1,
    ...(old === undefined ? {} : { oldSha256: hash(old) }),
    ...(next === undefined ? {} : { newSha256: hash(next) }),
    oldBytes: old === undefined ? 0 : 2, newBytes: next === undefined ? 0 : 3,
    plannedChange: true, finalState: 'changed', ...options };
}
async function report(...files) {
  const entries = files.flatMap((file, index) => {
    const identity = { turnId: 'turn', toolBatchId: `batch-${index}`, callIndex: 0,
      callId: `call-${index}`, toolAttempt: 1, toolName: 'apply_patch' };
    const uncertain = file.finalState === 'uncertain';
    const output = { applicationStatus: uncertain ? 'uncertain' : 'applied',
      transactionOutcome: uncertain ? 'rollback_failed' : 'committed',
      rootState: uncertain ? 'uncertain' : 'known', dryRun: false, files: [file],
      changedPaths: [], wouldChangePaths: [], createdPaths: [], wouldCreatePaths: [],
      deletedPaths: [], wouldDeletePaths: [], movedPaths: [], wouldMovePaths: [],
      potentiallyAffectedPaths: [], totalOperationCount: 1, totalHunkCount: 1,
      totalAdditions: 1, totalDeletions: 1 };
    return [{ sequence: index * 2 + 1, eventId: `start-${index}`, event: {
      ...identity, type: 'tool.started', fingerprint: `fingerprint-${index}`,
      input: { input: { kind: 'text', value: '*** Begin Patch\n*** End Patch' } }
    } }, { sequence: index * 2 + 2, eventId: `end-${index}`, event: {
      ...identity, type: 'tool.ended', observation: { storage: 'inline', kind: 'result',
        observation: { kind: 'result', output } }
    } }];
  });
  return readRunChangeReport({ async *read() { yield* entries; } }, 'run', '/workspace');
}

test('net changes retain the first baseline rather than the last operation kind', async () => {
  const added = await report(file('add', undefined, 'a'), file('update', 'a', 'b'));
  assert.equal(added.changes[0].kind, 'added');
  assert.deepEqual(added.changes[0].before, { kind: 'absent' });
  assert.equal(added.changes[0].before.sha256, undefined);
  assert.equal(added.changes[0].after.sha256, hash('b'));
  assert.deepEqual(added.changes[0].receiptSequences, [2, 4]);
  for (const files of [
    [file('add', undefined, 'a'), file('delete', 'a', undefined)],
    [file('update', 'a', 'b'), file('update', 'b', 'a')],
    [file('delete', 'a', undefined), file('add', undefined, 'a')]
  ]) {
    const result = await report(...files);
    assert.deepEqual(result.changes, []);
    assert.equal(result.mutationReceipts.length, 2);
  }
  const replaced = await report(file('delete', 'a', undefined), file('add', undefined, 'b'));
  assert.equal(replaced.changes[0].kind, 'modified');
  assert.equal(replaced.changes[0].before.sha256, hash('a'));
});

test('move provenance follows edits, chained moves, additions and returns', async () => {
  const moved = await report(
    file('move', 'a', 'a', { destinationPath: 'b.txt' }),
    file('update', 'a', 'b', { path: 'b.txt' }),
    file('move', 'b', 'b', { path: 'b.txt', destinationPath: 'c.txt' })
  );
  assert.equal(moved.changes.length, 1);
  assert.equal(moved.changes[0].kind, 'moved');
  assert.equal(moved.changes[0].path, 'a.txt');
  assert.equal(moved.changes[0].destinationPath, 'c.txt');
  assert.equal(moved.changes[0].before.sha256, hash('a'));
  assert.equal(moved.changes[0].after.sha256, hash('b'));
  assert.deepEqual(moved.changes[0].receiptSequences, [2, 4, 6]);
  const added = await report(file('add', undefined, 'a'),
    file('move', 'a', 'a', { destinationPath: 'b.txt' }),
    file('update', 'a', 'b', { path: 'b.txt' }));
  assert.equal(added.changes.length, 1);
  assert.equal(added.changes[0].kind, 'added');
  assert.equal(added.changes[0].path, 'b.txt');
  assert.deepEqual(added.changes[0].receiptSequences, [2, 4, 6]);
  const returned = await report(file('move', 'a', 'a', { destinationPath: 'b.txt' }),
    file('move', 'a', 'a', { path: 'b.txt', destinationPath: 'a.txt' }));
  assert.deepEqual(returned.changes, []);
});

test('unknown baselines and final states remain explicit, never fabricated from later hashes', async () => {
  const result = await report(file('update', undefined, 'b', { finalState: 'uncertain' }),
    file('update', 'b', 'c'));
  assert.deepEqual(result.changes[0].before, { kind: 'unknown' });
  assert.equal(result.changes[0].before.sha256, undefined);
  assert.equal(result.changes[0].before.bytes, undefined);
  assert.equal(result.changes[0].state, 'uncertain');
  assert.equal(result.changes[0].after.sha256, hash('c'));
  const uncertain = await report(file('update', 'a', 'b', { finalState: 'uncertain' }));
  assert.deepEqual(uncertain.changes[0].after, { kind: 'unknown' });
  assert.equal(uncertain.changes[0].after.sha256, undefined);
  const unrelated = await report(file('update', 'a', 'b', { finalState: 'uncertain' }),
    file('update', 'b', 'c', { path: 'other.txt' }));
  assert.equal(unrelated.changes.find(change => change.path === 'a.txt').state, 'uncertain');
});

test('uncertain moves do not assert a moved destination; later receipts resolve only observed paths', async () => {
  const uncertain = await report(file('move', 'a', 'b', { destinationPath: 'b.txt', finalState: 'uncertain' }));
  assert.equal(uncertain.changes.length, 2);
  assert(uncertain.changes.every(change => change.state === 'uncertain' && change.after.kind === 'unknown'));
  const resolvedDestination = await report(
    file('move', 'a', 'b', { destinationPath: 'b.txt', finalState: 'uncertain' }),
    file('update', 'b', 'c', { path: 'b.txt' })
  );
  assert.equal(resolvedDestination.changes.find(change => change.path === 'a.txt').state, 'uncertain');
  const destination = resolvedDestination.changes.find(change => change.path === 'b.txt');
  assert.equal(destination.kind, 'added');
  assert.equal(destination.after.sha256, hash('c'));
});

test('recreating a moved source cannot steal the earlier file provenance', async () => {
  const result = await report(
    file('move', 'a', 'a', { destinationPath: 'b.txt' }),
    file('move', 'a', 'a', { path: 'b.txt', destinationPath: 'c.txt' }),
    file('add', undefined, 'd'),
    file('move', 'd', 'd', { destinationPath: 'b.txt' })
  );
  assert.equal(result.changes.length, 2);
  assert.equal(result.changes[0].kind, 'moved');
  assert.equal(result.changes[0].path, 'a.txt');
  assert.equal(result.changes[0].destinationPath, 'c.txt');
  assert.equal(result.changes[0].after.sha256, hash('a'));
  assert.equal(result.changes[1].kind, 'added');
  assert.equal(result.changes[1].path, 'b.txt');
  assert.equal(result.changes[1].after.sha256, hash('d'));
});

test('unchanged receipts retain history without inventing a net change from an unknown snapshot', async () => {
  const result = await report(file('update', undefined, undefined, { finalState: 'unchanged', plannedChange: false }));
  assert.deepEqual(result.changes, []);
  assert.equal(result.mutationReceipts.length, 1);
});

test('move cycles report the final per-path contents without duplicate move claims', async () => {
  const result = await report(
    file('move', 'a', 'a', { destinationPath: 'temporary.txt' }),
    file('move', 'b', 'b', { path: 'b.txt', destinationPath: 'a.txt' }),
    file('move', 'a', 'a', { path: 'temporary.txt', destinationPath: 'b.txt' })
  );
  assert.equal(result.changes.length, 2);
  assert.deepEqual(result.changes.map(change => [change.path, change.kind, change.before.sha256, change.after.sha256]), [
    ['a.txt', 'modified', hash('a'), hash('b')],
    ['b.txt', 'modified', hash('b'), hash('a')]
  ]);
  assert.equal(result.mutationReceipts.length, 3);
});

test('later move links cannot fabricate provenance across an uncertain relocation', async () => {
  const result = await report(
    file('move', 'a', 'b', { destinationPath: 'b.txt', finalState: 'uncertain' }),
    file('move', 'b', 'c', { path: 'b.txt', destinationPath: 'c.txt' })
  );
  assert.equal(result.changes.length, 2);
  assert.equal(result.changes.find(change => change.path === 'a.txt').state, 'uncertain');
  const destination = result.changes.find(change => change.path === 'c.txt');
  assert.equal(destination.kind, 'added');
  assert.equal(destination.after.sha256, hash('c'));
  assert(!result.changes.some(change => change.kind === 'moved'));
});

test('a later observed update resolves contents at the moved destination without changing its original baseline', async () => {
  const result = await report(
    file('move', 'a', 'a', { destinationPath: 'b.txt' }),
    file('update', 'a', 'b', { path: 'b.txt', finalState: 'uncertain' }),
    file('update', 'b', 'c', { path: 'b.txt' })
  );
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].kind, 'moved');
  assert.equal(result.changes[0].before.sha256, hash('a'));
  assert.equal(result.changes[0].after.sha256, hash('c'));
  assert.deepEqual(result.changes[0].receiptSequences, [2, 4, 6]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRunChangeReport, deriveRunChangeReport } from '../dist/changes/run-change-report.js';

const hash = (character) => character.repeat(64);

test('change reports preserve pre-change state and distinguish exact mutations from concurrent changes', () => {
  const preChange = {
    workspace: snapshot('a', [
      file('source.txt', hash('a'), 10),
      file('user.txt', hash('b'), 20),
      file('removed.txt', hash('c'), 30),
      file('moved.txt', hash('d'), 40)
    ]),
    versionControl: {
      kind: 'git',
      status: {
        kind: 'observed',
        head: hash('e'),
        entries: [{ path: 'user.txt', state: '.M', sourcePathSha256: hash('f'), hazards: [] }],
        totalEntries: 1,
        omittedEntries: 0,
        coverage: 'complete',
        receipt: gitReceipt()
      }
    }
  };
  const final = snapshot('b', [
    file('added.txt', hash('5'), 1),
    file('source.txt', hash('1'), 11),
    file('user.txt', hash('2'), 21),
    file('renamed.txt', hash('3'), 41),
    file('external.bin', hash('4'), 2, 'binary')
  ]);
  const report = deriveRunChangeReport('run-one', preChange, final, [
    receipt(10, [mutation('source.txt', 'update', hash('a'), hash('1'), 10, 11)]),
    receipt(20, [mutation('user.txt', 'update', hash('b'), hash('2'), 20, 21)]),
    receipt(30, [mutation('removed.txt', 'delete', hash('c'), undefined, 30, 0)]),
    receipt(40, [{ ...mutation('moved.txt', 'move', hash('d'), hash('3'), 40, 41), destinationPath: 'renamed.txt' }]),
    receipt(50, [mutation('added.txt', 'add', undefined, hash('5'), 0, 1)])
  ]);

  assert.equal(report.coverage, 'complete');
  assert.deepEqual(report.facts.structuredMutationPaths, ['added.txt', 'moved.txt', 'removed.txt', 'renamed.txt', 'source.txt', 'user.txt']);
  assert.deepEqual(report.facts.externalOrConcurrentPaths, ['external.bin']);
  assert.equal(report.changes.find((change) => change.path === 'user.txt').preChangeVersionControl, 'changed');
  assert.equal(report.changes.find((change) => change.path === 'user.txt').initial, 'existing');
  assert.equal(report.changes.find((change) => change.path === 'external.bin').content, 'binary');
  assert.equal(report.mutationReceipts[0].patchSha256, hash('9'));
  assert.equal('files' in report.mutationReceipts[0], false);
  assert.deepEqual(decodeRunChangeReport(JSON.parse(JSON.stringify(report)), 'run-one'), report);
});

test('change reports expose receipt conflicts and partial large-file observations', () => {
  const preChange = { workspace: snapshot('a', [file('source.txt', hash('a'), 10)]), versionControl: { kind: 'none' } };
  const final = {
    ...snapshot('b', [file('source.txt', hash('3'), 12), { path: 'large.dat', kind: 'file', bytes: 70_000_000 }]),
    coverage: 'partial',
    causes: ['file_size_limit']
  };
  const report = deriveRunChangeReport('run-conflict', preChange, final, [
    receipt(10, [mutation('source.txt', 'update', hash('a'), hash('2'), 10, 11)])
  ]);
  const source = report.changes.find((change) => change.path === 'source.txt');
  assert.equal(source.attribution, 'external_or_concurrent');
  assert.deepEqual(source.conflicts, ['final_state_does_not_match_structured_mutation_receipts']);
  assert.equal(report.changes.find((change) => change.path === 'large.dat').content, 'large');
  assert.equal(report.coverage, 'partial');
  assert.match(report.causes.join(','), /mutation_receipts:conflict/u);
  assert.match(report.causes.join(','), /final:file_size_limit/u);
});

function snapshot(digestCharacter, entries) {
  const owned = Object.freeze(entries.map((entry) => Object.freeze(entry)));
  return Object.freeze({
    digest: hash(digestCharacter),
    coverage: 'complete',
    causes: Object.freeze([]),
    entries: owned,
    fileCount: owned.filter((entry) => entry.kind === 'file' && entry.sha256).length,
    totalBytes: owned.reduce((total, entry) => total + (entry.bytes ?? 0), 0)
  });
}

function file(path, sha256, bytes, content = 'text') {
  return { path, kind: 'file', mode: 0o100644, bytes, sha256, content };
}

function receipt(sequence, files) {
  return {
    eventId: `event-${sequence}`,
    sequence,
    turnId: 'turn-one',
    toolBatchId: 'batch-one',
    callIndex: sequence,
    toolAttempt: 1,
    fingerprint: `fingerprint-${sequence}`,
    patchSha256: hash('9'),
    applicationStatus: 'applied',
    transactionOutcome: 'committed',
    rootState: 'known',
    files
  };
}

function mutation(path, operation, oldSha256, newSha256, oldBytes, newBytes) {
  return {
    path,
    operation,
    hunkCount: 1,
    additions: newBytes > oldBytes ? 1 : 0,
    deletions: newBytes < oldBytes ? 1 : 0,
    ...(oldSha256 ? { oldSha256 } : {}),
    ...(newSha256 ? { newSha256 } : {}),
    oldBytes,
    newBytes,
    plannedChange: true,
    finalState: 'changed'
  };
}

function gitReceipt() {
  return {
    executionId: 'git-one',
    requestDigest: hash('1'),
    policyDigest: hash('2'),
    executionDigest: hash('3'),
    backend: 'test',
    backendVersion: '1'
  };
}

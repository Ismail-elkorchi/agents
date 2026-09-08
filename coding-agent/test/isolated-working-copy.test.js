import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RootedFileAuthority, captureWorkspaceSnapshot } from '@agent-core/tools-local';
import { IsolatedWorkingCopy } from '../dist/changes/isolated-working-copy.js';

test(
  'reopened work reads its original checkpoint after both live workspaces change',
  {
    skip: process.platform !== 'linux'
  },
  async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'coding-agent-baseline-continuation-'));
    const sourceDirectory = path.join(parent, 'source');
    await mkdir(sourceDirectory);
    await writeFile(path.join(sourceDirectory, 'value.txt'), 'baseline\n');
    const source = RootedFileAuthority.adopt(sourceDirectory);
    let workingCopy;
    try {
      const preChange = await captureWorkspaceSnapshot(source);
      const input = {
        source,
        preChange,
        runtimeDirectory: path.join(parent, 'runtime'),
        workId: 'continued-work'
      };
      workingCopy = await IsolatedWorkingCopy.open(input);
      await writeFile(
        path.join(workingCopy.root.identity.canonicalPath, 'value.txt'),
        'unfinished revision\n'
      );
      await writeFile(path.join(sourceDirectory, 'value.txt'), 'concurrent source change\n');
      await workingCopy.release();
      workingCopy = await IsolatedWorkingCopy.open(input);
      const observed = await workingCopy.withPreChangeRoot(async (root) => ({
        snapshot: await captureWorkspaceSnapshot(root),
        text: await readFile(path.join(root.identity.canonicalPath, 'value.txt'), 'utf8')
      }));
      assert.equal(observed.snapshot.digest, preChange.digest);
      assert.equal(observed.text, 'baseline\n');
      assert.equal(
        await readFile(path.join(workingCopy.root.identity.canonicalPath, 'value.txt'), 'utf8'),
        'unfinished revision\n'
      );
      assert.equal(
        await readFile(path.join(sourceDirectory, 'value.txt'), 'utf8'),
        'concurrent source change\n'
      );
    } finally {
      await workingCopy?.release();
      source.close();
      await rm(parent, { recursive: true, force: true });
    }
  }
);

test(
  'isolated working copies checkpoint, roll back, and apply one exact snapshot',
  { skip: process.platform !== 'linux' },
  async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'coding-agent-working-copy-'));
    const sourceDirectory = path.join(parent, 'source');
    const runtimeDirectory = path.join(parent, 'runtime');
    await mkdir(path.join(sourceDirectory, 'src'), { recursive: true });
    await writeFile(path.join(sourceDirectory, 'src', 'value.txt'), 'baseline\n');
    await writeFile(path.join(sourceDirectory, 'keep.txt'), 'keep\n');
    const source = RootedFileAuthority.adopt(sourceDirectory);
    let workingCopy;
    try {
      const preChange = await captureWorkspaceSnapshot(source);
      workingCopy = await IsolatedWorkingCopy.open({
        source,
        preChange,
        runtimeDirectory,
        workId: 'run-working-copy'
      });
      assert.equal(await readFile(path.join(sourceDirectory, 'src', 'value.txt'), 'utf8'), 'baseline\n');

      await writeFile(
        path.join(workingCopy.root.identity.canonicalPath, 'src', 'value.txt'),
        'checkpoint\n'
      );
      const saved = await workingCopy.checkpoint('working edit');
      await writeFile(
        path.join(workingCopy.root.identity.canonicalPath, 'src', 'value.txt'),
        'discarded\n'
      );
      await workingCopy.rollback(saved.checkpointId);
      assert.equal(
        await readFile(path.join(workingCopy.root.identity.canonicalPath, 'src', 'value.txt'), 'utf8'),
        'checkpoint\n'
      );

      await workingCopy.rollback(workingCopy.preChange.checkpointId);
      assert.equal(
        await readFile(path.join(workingCopy.root.identity.canonicalPath, 'src', 'value.txt'), 'utf8'),
        'baseline\n'
      );
      await writeFile(
        path.join(workingCopy.root.identity.canonicalPath, 'src', 'value.txt'),
        'working copy\n'
      );
      const diff = await workingCopy.diff();
      assert.equal(diff.coverage, 'complete');
      assert.deepEqual(
        diff.entries.map((entry) => [entry.path, entry.kind]),
        [['src/value.txt', 'modified']]
      );
      assert.equal(await readFile(path.join(sourceDirectory, 'src', 'value.txt'), 'utf8'), 'baseline\n');

      const disposition = await workingCopy.authorizeApply();
      assert.equal(typeof disposition.start, 'function');
      const decision = await disposition.start(new AbortController().signal);
      assert.equal(decision.status, 'applied');
      assert.equal(decision.workingCopyDigest, diff.workingCopyDigest);
      assert.equal(
        await readFile(path.join(sourceDirectory, 'src', 'value.txt'), 'utf8'),
        'working copy\n'
      );
      assert.equal(await readFile(path.join(sourceDirectory, 'keep.txt'), 'utf8'), 'keep\n');
      const reconciled = await disposition.reconcile(new AbortController().signal);
      assert.equal(reconciled.status, 'settled');
      assert.equal(reconciled.result.status, 'applied');
      await writeFile(path.join(sourceDirectory, 'src', 'value.txt'), 'changed-after-publication\n');
      const staleReconciliation = await disposition.reconcile(new AbortController().signal);
      assert.equal(staleReconciliation.status, 'settled');
      assert.equal(staleReconciliation.result.status, 'not_applied');
      assert.match(staleReconciliation.result.reason, /no longer matches the exact working copy/u);
      await disposition.release();
    } finally {
      await workingCopy?.release();
      source.close();
      await rm(parent, { recursive: true, force: true });
    }
  }
);

test(
  'working-copy application refuses a stale source and never overwrites concurrent work',
  { skip: process.platform !== 'linux' },
  async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'coding-agent-working-copy-stale-'));
    const sourceDirectory = path.join(parent, 'source');
    await mkdir(sourceDirectory);
    await writeFile(path.join(sourceDirectory, 'value.txt'), 'baseline\n');
    const source = RootedFileAuthority.adopt(sourceDirectory);
    let workingCopy;
    try {
      const preChange = await captureWorkspaceSnapshot(source);
      workingCopy = await IsolatedWorkingCopy.open({
        source,
        preChange,
        runtimeDirectory: path.join(parent, 'runtime'),
        workId: 'run-stale'
      });
      await writeFile(path.join(workingCopy.root.identity.canonicalPath, 'value.txt'), 'working copy\n');
      await writeFile(path.join(sourceDirectory, 'value.txt'), 'concurrent\n');
      const authorization = await workingCopy.authorizeApply();
      assert.equal(typeof authorization.start, 'function');
      const application = await authorization.start(new AbortController().signal);
      assert.deepEqual(application, {
        status: 'not_applied',
        reason: 'The source workspace changed after working-copy isolation; application was not started.'
      });
      assert.equal(await readFile(path.join(sourceDirectory, 'value.txt'), 'utf8'), 'concurrent\n');
    } finally {
      await workingCopy?.release();
      source.close();
      await rm(parent, { recursive: true, force: true });
    }
  }
);

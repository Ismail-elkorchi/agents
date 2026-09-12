import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RootedFileAuthority } from '@agent-core/tools-local';
import { createCodingCommandAuthority } from '../dist/execution/coding-command-authority.js';
import { PrivateStateDirectory } from '../dist/state/private-state.js';

test(
  'production command authority selects a native sandbox and confines the observed command environment',
  { skip: process.platform !== 'linux' },
  async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'coding-agent-toolchain-'));
    const workspace = path.join(parent, 'workspace');
    await mkdir(workspace);
    await writeFile(path.join(parent, 'host-secret'), 'not admitted');
    const root = RootedFileAuthority.adopt(workspace);
    const state = await PrivateStateDirectory.create(path.join(parent, 'state'));
    let execution;
    try {
      execution = await createCodingCommandAuthority({
        repositoryDirectory: path.join(parent, 'executions'),
        rootedFileAuthority: root,
        state
      });
      const script = `
        const fs = require('node:fs');
        const assert = require('node:assert/strict');
        assert.equal(process.env.CI, undefined);
        assert.equal(fs.existsSync(${JSON.stringify(path.join(parent, 'host-secret'))}), false);
        fs.writeFileSync('created.txt', 'workspace write');
        console.log(process.execPath);
      `;
      const owner = {
        ownerId: 'toolchain',
        runId: 'run',
        turnId: 'turn',
        toolBatchId: 'batch',
        callIndex: 0
      };
      const reservation = await execution.plan({
        command: `node -e '${script.replaceAll("'", "'\\''")}' && npm --version`,
        rootedDirectory: '.',
        pty: false,
        timeoutMs: 10_000,
        yieldMs: 1_000,
        outputTokenBudget: 1_000,
        owner
      });
      assert.match(reservation.authorization.confinement, /^(isolated workspace|workspace confined)$/u);
      assert.equal(
        reservation.authorization.summary.filesystem.resources.find(
          (resource) => resource.id === 'workspace'
        ).target.path,
        await realpath(workspace)
      );
      let result = await execution.start(reservation);
      while (result.status === 'running')
        result = await execution.query(result.processId, 1_000, 1_000, 0, owner);
      assert.equal(result.status, 'exited', result.diagnostic);
      assert.equal(result.exitCode, 0, result.stderr.text);
      const lines = result.stdout.text.trim().split('\n');
      assert.equal(lines[0], await realpath(process.execPath));
      assert.match(lines[1], /^\d+\.\d+\.\d+$/u);
      assert.equal(await readFile(path.join(workspace, 'created.txt'), 'utf8'), 'workspace write');
      assert.equal(await readFile(path.join(parent, 'host-secret'), 'utf8'), 'not admitted');
    } finally {
      await execution?.close();
      root.close();
      await rm(parent, { recursive: true, force: true });
    }
  }
);

test('command discovery resolves an executable shell and absolute runtime roots', async () => {
  const { discoverCodingCommandEnvironment } = await import(
    '../dist/execution/sandbox-policy.js'
  );
  const environment = await discoverCodingCommandEnvironment();
  assert.equal(path.isAbsolute(environment.shellPath), true);
  assert.equal(environment.runtimeRoots.length > 0, true);
  assert.equal(
    environment.runtimeRoots.every(
      (root) => path.isAbsolute(root.sourcePath) && path.isAbsolute(root.targetPath)
    ),
    true
  );
  assert.equal(
    environment.runtimeRoots.some((root) => {
      const relative = path.relative(root.sourcePath, environment.shellPath);
      return relative === '' || (!path.isAbsolute(relative) && !relative.startsWith('..'));
    }),
    true
  );
});

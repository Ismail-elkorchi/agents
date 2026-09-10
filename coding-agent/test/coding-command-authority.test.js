import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RootedFileAuthority } from '@agent-core/tools-local';
import { createCodingCommandAuthority } from '../dist/execution/coding-command-authority.js';
import { PrivateStateDirectory } from '../dist/state/private-state.js';
import { sandboxAvailable } from './fixtures/sandbox.js';

test(
  'production command authority runs the active Node toolchain with a private home and confined workspace',
  { skip: !sandboxAvailable },
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
        assert.equal(process.env.HOME, '/home/sandbox');
        assert.equal(fs.existsSync(${JSON.stringify(path.join(parent, 'host-secret'))}), false);
        fs.writeFileSync('created.txt', 'workspace write');
        fs.writeFileSync(process.env.HOME + '/cache', 'private write');
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

test('Node discovery never admits the surrounding home for standalone or user-bin installs', async () => {
  const { codingToolchain } = await import('../dist/execution/sandbox-policy.js');
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'coding-agent-node-home-')));
  try {
    await mkdir(path.join(home, 'bin'));
    const secret = path.join(home, 'credentials');
    await writeFile(secret, 'host credential');
    for (const executable of [path.join(home, 'node'), path.join(home, 'bin', 'node')]) {
      await writeFile(executable, 'node fixture');
      const toolchain = await codingToolchain(executable);
      const exposes = (resource, candidate) => {
        const relative = path.relative(resource.source.path, candidate);
        return (
          relative === '' ||
          (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
        );
      };
      assert.ok(toolchain.resources.some((resource) => exposes(resource, executable)));
      assert.equal(
        toolchain.resources.some((resource) => exposes(resource, secret)),
        false
      );
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

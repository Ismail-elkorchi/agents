import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { agentEventCodec } from '@agent-core/runtime';
import { Sandsurf } from 'sandsurf';
import { openCodingEnvironment } from '../dist/execution/coding-command-authority.js';
import { PrivateStateDirectory } from '../dist/state/private-state.js';

test(
  'coding environment uses one persistent guest workspace and never writes through implicitly',
  {
    skip: process.env.SANDSURF_KVM_TEST !== '1',
    timeout: 1_200_000
  },
  async (t) => {
    const parent = await mkdtemp(path.join(tmpdir(), 'coding-sandsurf-'));
    const workspace = path.join(parent, 'workspace');
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'source.txt'), 'host original');
    const state = await PrivateStateDirectory.create(path.join(parent, 'state'));
    const events = new InMemoryEventRepository(agentEventCodec);
    const artifacts = new InMemoryArtifactRepository();
    let environment;
    t.after(async () => {
      await environment?.close();
      const cleanup = await Sandsurf.open({
        directory: path.join(parent, 'environment', 'host'),
        authorizer: (change) => change.kind === 'lifecycle'
      });
      try {
        for (const sandbox of await cleanup.sandboxes.list()) await sandbox.destroy();
      } finally {
        await cleanup.close();
      }
      await rm(parent, { recursive: true, force: true });
    });
    environment = await openCodingEnvironment({
      repositoryDirectory: path.join(parent, 'environment'),
      hostWorkspaceRoot: workspace,
      workspaceId: 'workspace-test',
      state,
      events,
      artifacts,
      commandExecution: true,
      writable: true
    });
    assert.equal(
      new TextDecoder().decode((await environment.files.readFile('source.txt')).bytes),
      'host original'
    );
    await environment.files.transaction([
      {
        kind: 'write',
        path: 'source.txt',
        bytes: new TextEncoder().encode('guest changed'),
        mode: 0o644,
        expected: { kind: 'any' }
      }
    ]);
    assert.equal(await readFile(path.join(workspace, 'source.txt'), 'utf8'), 'host original');
    const execution = environment.commandExecution;
    for (const [callIndex, pty] of [false, true].entries()) {
      const request = await execution.plan({
        command:
          "printf 'command output\\n' && printf 'created by command\\n' > command-created.txt",
        rootedDirectory: '.',
        pty,
        lifetime: 'job',
        timeoutMs: 15_000,
        yieldMs: 1000,
        outputTokenBudget: 1000,
        owner: { ownerId: 'session', runId: 'run', turnId: 'turn', toolBatchId: 'batch', callIndex }
      });
      let result = await execution.start(request);
      while (result.status === 'running')
        result = await execution.query(result.processId, 1000, 1000, 0);
      assert.equal(result.status, 'exited', result.diagnostic);
      assert.equal(result.exitCode, 0, result.combined.text);
      assert.match(result.combined.text, /command output/);
      assert.equal(result.originalOutput.kind, 'captured');
    }
    assert.equal(
      new TextDecoder().decode((await environment.files.readFile('command-created.txt')).bytes),
      'created by command\n'
    );
    const reconnectedId = environment.sandbox.id;
    await environment.close();
    environment = await openCodingEnvironment({
      repositoryDirectory: path.join(parent, 'environment'),
      hostWorkspaceRoot: workspace,
      workspaceId: 'workspace-test',
      state,
      events,
      artifacts,
      commandExecution: true,
      writable: true
    });
    assert.equal(environment.sandbox.id, reconnectedId);
    assert.equal(
      new TextDecoder().decode((await environment.files.readFile('source.txt')).bytes),
      'guest changed'
    );
    const writable = await environment.commandExecution.plan({
      command: 'test -w source.txt',
      rootedDirectory: '.',
      pty: false,
      lifetime: 'job',
      timeoutMs: 15_000,
      yieldMs: 1000,
      outputTokenBudget: 1000,
      owner: {
        ownerId: 'session',
        runId: 'run',
        turnId: 'turn',
        toolBatchId: 'batch',
        callIndex: 2
      }
    });
    let ownership = await environment.commandExecution.start(writable);
    while (ownership.status === 'running')
      ownership = await environment.commandExecution.query(
        ownership.processId,
        1000,
        1000,
        ownership.cursorEnd
      );
    assert.equal(
      ownership.exitCode,
      0,
      'Sandbox filesystem replacements must remain writable by the configured workload user.'
    );
  }
);

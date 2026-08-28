import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isCommandExecution } from '@agent-core/tools';
import { WorkspaceFileRoot } from '@agent-core/tools-local';
import { SandboxCommandExecution } from '../dist/execution/sandbox-command-execution.js';
import { PrivateStateDirectory } from '../dist/state/private-state.js';
import { createSandbox, LINUX_PROCESS_BASELINE_REQUIREMENTS, openSandboxExecutionRepository } from '@ismail-elkorchi/sandbox';

const owner = Object.freeze({ runId: 'run-1', turnId: 'turn-1', toolBatchId: 'batch-1', callIndex: 0 });
const sandboxAvailable = process.platform === 'linux' && await (async () => {
  const sandbox = await createSandbox();
  try { return (await sandbox.probe()).backends.some(backend => backend.id === 'linux-namespace-v1' && backend.available); }
  catch { return false; }
  finally { await sandbox.dispose(); }
})();

test('sandbox command adapter authorizes exact preparation and preserves cursor output', async () => {
  const fixture = await createFixture();
  try {
    const prepared = [];
    const execution = await SandboxCommandExecution.create({
      repository: fixture.repository,
      workspaceFileRoot: fixture.root,
      state: fixture.state,
      maxRetainedOutputBytes: 1024,
      createRun: request => run(fixture.workspace, request.command),
      validatePrepared(value) { prepared.push(value); }
    });
    assert.equal(isCommandExecution(execution), true);
    const result = await startCommand(execution, request());
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].summary.execution.executable, '/bin/sh');
    assert.equal(result.status, 'exited');
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.text, 'sandboxed');
    assert.equal(result.cursorEnd, 9);
    assert.equal(fixture.repository.activationCount, 1);
    await assert.rejects(execution.query(result.processId, 100, 0, 0, { ...owner, runId: 'another-run' }), /another tool invocation/);
    await execution.close();
  } finally {
    fixture.root.close();
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('sandbox command adapter cancels an invalid preparation without activation', async () => {
  const fixture = await createFixture();
  try {
    const execution = await SandboxCommandExecution.create({
      repository: fixture.repository,
      workspaceFileRoot: fixture.root,
      state: fixture.state,
      maxRetainedOutputBytes: 1024,
      createRun: request => run(fixture.workspace, request.command),
      validatePrepared: () => { throw new Error('prepared policy rejected'); }
    });
    await assert.rejects(execution.prepare(request()), /prepared policy rejected/);
    assert.equal(fixture.repository.activationCount, 0);
    assert.equal(fixture.repository.terminationCount, 1);
    await execution.close();
  } finally {
    fixture.root.close();
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('released command preparation can be recreated with fresh time-bound authorization evidence', async () => {
  const fixture = await createFixture();
  try {
    const execution = await SandboxCommandExecution.create({
      repository: fixture.repository,
      workspaceFileRoot: fixture.root,
      state: fixture.state,
      maxRetainedOutputBytes: 1024,
      createRun: requestValue => run(fixture.workspace, requestValue.command),
      validatePrepared: () => undefined
    });
    const first = await execution.prepare(request());
    const authorization = first.authorization;
    await first.release();
    const second = await execution.prepare(request());
    assert.equal(second.authorization.requestDigest, authorization.requestDigest);
    assert.equal(second.authorization.policyDigest, authorization.policyDigest);
    assert.equal(second.authorization.executionDigest, authorization.executionDigest);
    const result = await execution.start(second);
    assert.equal(result.status, 'exited');
    assert.equal(fixture.repository.activationCount, 1);
    await execution.close();
  } finally {
    fixture.root.close();
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('sandbox command adapter blocks new effects until unknown recovery is acknowledged', async () => {
  const fixture = await createFixture({ initialUnknown: true });
  try {
    const execution = await SandboxCommandExecution.create({
      repository: fixture.repository,
      workspaceFileRoot: fixture.root,
      state: fixture.state,
      maxRetainedOutputBytes: 1024,
      createRun: request => run(fixture.workspace, request.command),
      validatePrepared: () => undefined
    });
    const reconciliation = await execution.reconcile();
    assert.equal(reconciliation.unresolved.length, 1);
    await assert.rejects(execution.prepare(request()), /Unresolved sandbox executions/);
    await execution.acknowledgeUnresolved([reconciliation.unresolved[0].processId]);
    assert.equal((await execution.reconcile()).unresolved.length, 0);
    await execution.close();
  } finally {
    fixture.root.close();
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('sandbox command adapter rejects plans that do not bind the adopted workspace root', async () => {
  const fixture = await createFixture();
  try {
    const execution = await SandboxCommandExecution.create({
      repository: fixture.repository,
      workspaceFileRoot: fixture.root,
      state: fixture.state,
      maxRetainedOutputBytes: 1024,
      createRun: request => run('/different/root', request.command),
      validatePrepared: () => undefined
    });
    await assert.rejects(execution.prepare(request()), /exactly one grant for the adopted physical workspace root/);
    assert.equal(fixture.repository.prepareCount, 0);
    await execution.close();
  } finally {
    fixture.root.close();
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('sandbox command adapter rejects a receipt that conflicts with its durable request binding', async () => {
  const fixture = await createFixture();
  try {
    const execution = await SandboxCommandExecution.create({
      repository: fixture.repository,
      workspaceFileRoot: fixture.root,
      state: fixture.state,
      maxRetainedOutputBytes: 1024,
      createRun: requestValue => run(fixture.workspace, requestValue.command),
      validatePrepared: () => undefined
    });
    const result = await startCommand(execution, request());
    await execution.close();
    await fixture.state.write(
      `sandbox-processes/${result.processId}.json`,
      `${JSON.stringify({ schemaVersion: 1, processId: result.processId, owner, requestDigest: `sha256:${'f'.repeat(64)}`, authorization: {} })}\n`
    );
    await assert.rejects(
      SandboxCommandExecution.create({
        repository: fixture.repository,
        workspaceFileRoot: fixture.root,
        state: fixture.state,
        maxRetainedOutputBytes: 1024,
        createRun: requestValue => run(fixture.workspace, requestValue.command),
        validatePrepared: () => undefined
      }),
      /does not match its durable request binding/
    );
  } finally {
    fixture.root.close();
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('sandbox command adapter decodes progress across byte-chunk boundaries', async () => {
  const fixture = await createFixture({ splitUtf8Output: true });
  try {
    const progress = [];
    const execution = await SandboxCommandExecution.create({
      repository: fixture.repository,
      workspaceFileRoot: fixture.root,
      state: fixture.state,
      maxRetainedOutputBytes: 1024,
      createRun: requestValue => run(fixture.workspace, requestValue.command),
      validatePrepared: () => undefined
    });
    const result = await startCommand(execution, request(), { onProgress: event => progress.push(event) });
    assert.equal(result.stdout.text, 'A🙂B');
    assert.equal(progress.map(event => event.text).join(''), 'A🙂B');
    assert.equal(progress.at(-1).observedBytes, Buffer.byteLength('A🙂B'));
    await execution.close();
  } finally {
    fixture.root.close();
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('sandbox adapter satisfies start, output, ownership, terminal receipt, and restart recovery', { skip: !sandboxAvailable }, async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'coding-agent-sandbox-conformance-'));
  const workspace = path.join(parent, 'workspace');
  const repositoryPath = path.join(parent, 'executions');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(workspace);
  const root = WorkspaceFileRoot.adopt(workspace);
  const state = await PrivateStateDirectory.create(path.join(parent, 'state'));
  const createRun = request => ({
    isolation: { kind: 'process' },
    policy: {
      filesystem: { runtime: { kind: 'system' }, grants: [{ hostPath: workspace, targetPath: '/workspace', access: 'read-write', execution: 'allow' }] },
      network: { mode: 'none' }, process: { hostProcesses: 'deny', hostIpc: 'deny' }
    },
    requirements: LINUX_PROCESS_BASELINE_REQUIREMENTS,
    resources: { wallTimeMs: request.timeoutMs, memoryBytes: 512 * 1024 * 1024, maxProcesses: 16, maxOutputBytes: 1024 * 1024, terminationGraceMs: 1_000 },
    process: { executable: '/bin/sh', args: ['-lc', request.command], cwd: '/workspace', stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }
  });
  try {
    const firstRepository = await openSandboxExecutionRepository({ directory: repositoryPath, maxRetainedOutputBytes: 1024 * 1024 });
    const first = await SandboxCommandExecution.create({ repository: firstRepository, workspaceFileRoot: root, state, maxRetainedOutputBytes: 1024 * 1024, createRun, validatePrepared: () => undefined });
    const result = await startCommand(first, { ...request(), command: 'printf durable-sandbox' });
    assert.equal(result.status, 'exited');
    assert.equal(result.stdout.text, 'durable-sandbox');
    await assert.rejects(first.query(result.processId, 100, 0, 0, { ...owner, turnId: 'wrong' }), /another tool invocation/);
    await first.close();

    const secondRepository = await openSandboxExecutionRepository({ directory: repositoryPath, maxRetainedOutputBytes: 1024 * 1024 });
    const second = await SandboxCommandExecution.create({ repository: secondRepository, workspaceFileRoot: root, state, maxRetainedOutputBytes: 1024 * 1024, createRun, validatePrepared: () => undefined });
    const reports = second.recoveredTerminalReports();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].result.processId, result.processId);
    assert.deepEqual(reports[0].result.owner, owner);
    await second.acknowledgeTerminalReport(result.processId);
    assert.equal(second.recoveredTerminalReports().length, 0);
    await second.close();
  } finally {
    root.close();
    await rm(parent, { recursive: true, force: true });
  }
});

function request() {
  return {
    command: 'printf sandboxed',
    workspacePath: '.',
    pty: false,
    timeoutMs: 1_000,
    yieldMs: 10,
    outputTokenBudget: 100,
    owner
  };
}

async function startCommand(execution, requestValue, options = {}) {
  const prepared = await execution.prepare(requestValue);
  return execution.start(prepared, options);
}

function run(workspace, command) {
  return {
    isolation: { kind: 'process' },
    policy: {
      filesystem: {
        runtime: { kind: 'system' },
        grants: [{ hostPath: workspace, targetPath: '/workspace', access: 'read-write', execution: 'allow' }]
      },
      network: { mode: 'none' },
      process: { hostProcesses: 'deny', hostIpc: 'deny' }
    },
    requirements: { boundary: 'os-process', required: [] },
    resources: { maxOutputBytes: 1024 },
    process: {
      executable: '/bin/sh', args: ['-lc', command], cwd: '/workspace',
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'
    }
  };
}

async function createFixture(options = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), 'coding-agent-sandbox-adapter-'));
  const workspace = path.join(parent, 'workspace');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(workspace);
  const root = WorkspaceFileRoot.adopt(workspace);
  const state = await PrivateStateDirectory.create(path.join(parent, 'state'));
  const repository = new FakeSandboxExecutionRepository(options.initialUnknown === true, options.splitUtf8Output === true);
  if (options.initialUnknown === true) {
    const recoveryIdentity = `${repository.identity}:${createHash('sha256').update(root.identity.canonicalPath).digest('hex')}`;
    const processId = 'sandbox-' + createHash('sha256').update(JSON.stringify([recoveryIdentity, owner.runId, owner.turnId, owner.toolBatchId, owner.callIndex])).digest('hex');
    await state.write(`sandbox-processes/${processId}.json`, `${JSON.stringify({ schemaVersion: 1, processId, owner })}\n`);
    repository.unknownId = processId;
  }
  return { parent, workspace, root, state, repository };
}

class FakeSandboxExecutionRepository {
  identity = 'fake-sandbox-repository';
  durability = 'application-process';
  prepareCount = 0;
  activationCount = 0;
  terminationCount = 0;
  unknownId;
  observations = new Map();

  constructor(initialUnknown, splitUtf8Output) {
    if (!initialUnknown) this.unknownId = undefined;
    this.splitUtf8Output = splitUtf8Output;
  }

  async prepare(request) {
    this.prepareCount += 1;
    const observation = prepared(request.executionId);
    this.observations.set(request.executionId, observation);
    return observation;
  }

  async activate(executionId) {
    this.activationCount += 1;
    this.observations.set(executionId, this.splitUtf8Output ? settledWithSplitUtf8(executionId) : settled(executionId));
  }

  async inspect(executionId) {
    if (executionId === this.unknownId) return unknown(executionId);
    return this.observations.get(executionId) ?? unknown(executionId);
  }

  async writeInput() {}
  async closeInput() {}
  async terminate(executionId) {
    this.terminationCount += 1;
    const observation = rejected(executionId);
    this.observations.set(executionId, observation);
  }
  async reconcile() {
    const values = [...this.observations.values()];
    if (this.unknownId) values.push(unknown(this.unknownId));
    return {
      settled: values.filter(value => value.kind === 'settled' || value.kind === 'rejected'),
      unresolved: values.filter(value => value.kind !== 'settled' && value.kind !== 'rejected')
    };
  }
  async acknowledgeUnknown(executionId) { if (executionId === this.unknownId) this.unknownId = undefined; }
  async forget(executionId) { this.observations.delete(executionId); }
  async close() {}
}

function output(data = '') {
  const bytes = Buffer.from(data);
  return {
    cursorStart: 0, cursorEnd: bytes.byteLength, availableCursorEnd: bytes.byteLength,
    stdoutBytes: bytes.byteLength, stderrBytes: 0, cursorExpired: false,
    chunks: bytes.byteLength === 0 ? [] : [{ cursorStart: 0, cursorEnd: bytes.byteLength, stream: 'stdout', data: bytes }]
  };
}

function prepared(executionId) {
  return {
    kind: 'prepared', executionId, requestDigest: 'sha256:' + '1'.repeat(64), policyDigest: '2'.repeat(64), executionDigest: '3'.repeat(64), expiresAtMs: Date.now() + 10_000,
    summary: { isolation: { kind: 'process' }, backend: { id: 'test', version: '1', stability: 'stable' }, filesystem: { runtimeView: 'system', runtimeManifestDigest: '4'.repeat(64), grants: [], masks: [], privateHomePath: null, temporaryPath: '/tmp' }, network: { mode: 'none', topology: 'private-namespace' }, process: { hostProcesses: 'deny', hostIpc: 'deny' }, resources: { wallTimeMs: 1000, memoryBytes: 1, maxProcesses: 1, maxOutputBytes: 1024, terminationGraceMs: 1 }, execution: { executable: '/bin/sh', args: ['-lc', 'printf sandboxed'], cwd: '/workspace', cwdIdentityDigest: '5'.repeat(64), environmentNames: [], sensitiveEnvironmentNames: [], stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } },
    enforcement: { backend: 'test', guarantees: [], caveats: [] }, output: output()
  };
}

function settled(executionId) {
  return {
    kind: 'settled', executionId, requestDigest: 'sha256:' + '1'.repeat(64), output: output('sandboxed'),
    result: { processId: 'native', policyDigest: '2'.repeat(64), executionDigest: '3'.repeat(64), termination: { reason: 'exit', code: 0 }, enforcement: { backend: 'test', guarantees: [], caveats: [] }, violations: [], usage: { wallTimeMs: 1, stdoutBytes: 9, stderrBytes: 0 }, cleanup: { completed: true, failures: [] } }
  };
}

function settledWithSplitUtf8(executionId) {
  const bytes = Buffer.from('A🙂B');
  return {
    ...settled(executionId),
    output: {
      cursorStart: 0,
      cursorEnd: bytes.byteLength,
      availableCursorEnd: bytes.byteLength,
      stdoutBytes: bytes.byteLength,
      stderrBytes: 0,
      cursorExpired: false,
      chunks: [
        { cursorStart: 0, cursorEnd: 3, stream: 'stdout', data: bytes.subarray(0, 3) },
        { cursorStart: 3, cursorEnd: bytes.byteLength, stream: 'stdout', data: bytes.subarray(3) }
      ]
    }
  };
}

function rejected(executionId) {
  return { kind: 'rejected', executionId, requestDigest: 'sha256:' + '1'.repeat(64), error: { code: 'preparation.cancelled', message: 'cancelled', phase: 'activate', targetExecuted: false }, output: output() };
}

function unknown(executionId) {
  return { kind: 'unknown', executionId, reason: 'execution-host-unreachable', diagnostic: 'unknown outcome', output: output() };
}

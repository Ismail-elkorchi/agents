import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { agentEventCodec } from '@agent-core/runtime';
import { isCommandExecution, ResourceLeaseCoordinator } from '@agent-core/tools';
import { RootedFileAuthority } from '@agent-core/tools-local';
import { SandboxCommandExecution } from '../dist/execution/sandbox-command-execution.js';
import { PrivateStateDirectory } from '../dist/state/private-state.js';
import {
  openSandboxExecutionRepository
} from '@ismail-elkorchi/sandbox';

import { sandboxAvailable, commandRun, authorizationSummary, enforcement, isolatedPath } from './fixtures/sandbox.js';

const owner = Object.freeze({
  ownerId: 'run-1',
  runId: 'run-1',
  turnId: 'turn-1',
  toolBatchId: 'batch-1',
  callIndex: 0
});

test('sandbox command adapter authorizes the exact command and preserves cursor output', async () => {
  const fixture = await createFixture();
  try {
    const authorizations = [];
    const execution = await SandboxCommandExecution.create({
      resourceLeases: new ResourceLeaseCoordinator(),
      repository: fixture.repository,
      rootedFileAuthority: fixture.root,
      state: fixture.state, ...fixture.evidence,
      maxRetainedOutputBytes: 1024,
      createRun: (request) => commandRun(fixture.workspace, request.command),
      validateAuthorization(value) {
        authorizations.push(value);
      }
    });
    assert.equal(isCommandExecution(execution), true);
    const result = await startCommand(execution, request());
    assert.equal(authorizations.length, 1);
    assert.deepEqual(authorizations[0].summary.execution.executable, isolatedPath('/bin/sh'));
    assert.equal(result.status, 'exited');
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.text, 'sandboxed');
    assert.equal(result.cursorEnd, 9);
    assert.equal(fixture.repository.activationCount, 1);
    await assert.rejects(
      execution.query(result.processId, 100, 0, 0, {
        ...owner,
        ownerId: 'another-work',
        runId: 'another-run'
      }),
      /another resource owner/
    );
    await execution.close();
  } finally {
    fixture.root.close();
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('sandbox activation readiness is independent of the target wall-time limit', async () => {
  const fixture = await createFixture({ activationDelayMs: 1_100 });
  try {
    const execution = await SandboxCommandExecution.create({
      resourceLeases: new ResourceLeaseCoordinator(),
      repository: fixture.repository,
      rootedFileAuthority: fixture.root,
      state: fixture.state, ...fixture.evidence,
      maxRetainedOutputBytes: 1024,
      createRun: (requestValue) => commandRun(fixture.workspace, requestValue.command),
      validateAuthorization: () => undefined
    });
    const result = await startCommand(execution, { ...request(), timeoutMs: 1 });
    assert.equal(result.status, 'exited');
    assert.equal(result.stdout.text, 'sandboxed');
    await execution.close();
  } finally {
    fixture.root.close();
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('settlement releases the workspace lease without a model poll', { timeout: 5_000 }, async (t) => {
  const fixture = await createFixture();
  const execution = await SandboxCommandExecution.create({
    resourceLeases: new ResourceLeaseCoordinator(),
    repository: fixture.repository, rootedFileAuthority: fixture.root, state: fixture.state, ...fixture.evidence,
    maxRetainedOutputBytes: 1024,
    createRun: (value) => commandRun(fixture.workspace, value.command),
    validateAuthorization: () => undefined
  });
  t.after(async () => {
    await execution.close();
    fixture.root.close();
    await rm(fixture.parent, { recursive: true, force: true });
  });
  fixture.repository.activate = async (executionId) => {
    const { requestDigest, output } = settled(executionId);
    fixture.repository.observations.set(executionId, {
      kind: 'running', executionId, requestDigest, output, processId: 'native'
    });
  };
  const effects = { accesses: [{ scope: 'workspace', mode: 'write' }], lockScopes: ['workspace'] };
  const lease = await execution.resourceLeases.acquire(effects, owner.ownerId);
  const result = await startCommand(execution, { ...request(), yieldMs: 0 }, { lease });
  assert.equal(result.status, 'running');
  assert(lease.transferred);
  assert(execution.resourceLeases.wouldWait(effects));
  const waiting = execution.resourceLeases.acquire(effects, 'next-tool', t.signal);
  fixture.repository.observations.set(result.processId, settled(result.processId));
  const nextLease = await waiting;
  nextLease.release();
  assert.equal(execution.resourceLeases.activeCount(), 0);
});

test('stop reconciles a process that already exited and preserves unknown control failures', async (t) => {
  const fixture = await createFixture();
  const execution = await SandboxCommandExecution.create({
    resourceLeases: new ResourceLeaseCoordinator(),
    repository: fixture.repository, rootedFileAuthority: fixture.root, state: fixture.state, ...fixture.evidence,
    maxRetainedOutputBytes: 1024,
    createRun: (value) => commandRun(fixture.workspace, value.command),
    validateAuthorization: () => undefined
  });
  t.after(async () => {
    await execution.close();
    fixture.root.close();
    await rm(fixture.parent, { recursive: true, force: true });
  });
  const started = await startCommand(execution, request());
  fixture.repository.terminate = async () => { throw new Error('Control endpoint closed.'); };
  const result = await execution.terminate(started.processId, owner);
  assert.equal(result.status, 'exited');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.text, 'sandboxed');
  fixture.repository.observations.set(started.processId, unknown(started.processId));
  assert.equal((await execution.terminate(started.processId, owner)).exitCode, 0);
});

test('sandbox command adapter cancels invalid authorization without activation', async () => {
  const fixture = await createFixture();
  try {
    const execution = await SandboxCommandExecution.create({
      resourceLeases: new ResourceLeaseCoordinator(),
      repository: fixture.repository,
      rootedFileAuthority: fixture.root,
      state: fixture.state, ...fixture.evidence,
      maxRetainedOutputBytes: 1024,
      createRun: (request) => commandRun(fixture.workspace, request.command),
      validateAuthorization: () => {
        throw new Error('authorization policy rejected');
      }
    });
    await assert.rejects(execution.plan(request()), /authorization policy rejected/);
    assert.equal(fixture.repository.activationCount, 0);
    assert.equal(fixture.repository.terminationCount, 1);
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
      resourceLeases: new ResourceLeaseCoordinator(),
      repository: fixture.repository,
      rootedFileAuthority: fixture.root,
      state: fixture.state, ...fixture.evidence,
      maxRetainedOutputBytes: 1024,
      createRun: (request) => commandRun(fixture.workspace, request.command),
      validateAuthorization: () => undefined
    });
    const reconciliation = await execution.reconcile();
    assert.equal(reconciliation.unresolved.length, 1);
    await assert.rejects(execution.plan(request()), /Unresolved sandbox executions/);
    await assert.rejects(execution.disposeOwner(request().owner.ownerId), /release remains unresolved/);
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
      resourceLeases: new ResourceLeaseCoordinator(),
      repository: fixture.repository,
      rootedFileAuthority: fixture.root,
      state: fixture.state, ...fixture.evidence,
      maxRetainedOutputBytes: 1024,
      createRun: (request) => commandRun('/different/root', request.command),
      validateAuthorization: () => undefined
    });
    await assert.rejects(
      execution.plan(request()),
      /exactly one resource for the adopted physical workspace root/
    );
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
      resourceLeases: new ResourceLeaseCoordinator(),
      repository: fixture.repository,
      rootedFileAuthority: fixture.root,
      state: fixture.state, ...fixture.evidence,
      maxRetainedOutputBytes: 1024,
      createRun: (requestValue) => commandRun(fixture.workspace, requestValue.command),
      validateAuthorization: () => undefined
    });
    const result = await startCommand(execution, request());
    await execution.close();
    await fixture.state.write(
      `sandbox-processes/${result.processId}.json`,
      `${JSON.stringify({ schemaVersion: 1, processId: result.processId, command: request().command, owner, requestDigest: `sha256:${'f'.repeat(64)}`, authorization: {} })}\n`
    );
    await assert.rejects(
      SandboxCommandExecution.create({
        resourceLeases: new ResourceLeaseCoordinator(),
        repository: fixture.repository,
        rootedFileAuthority: fixture.root,
        state: fixture.state, ...fixture.evidence,
        maxRetainedOutputBytes: 1024,
        createRun: (requestValue) => commandRun(fixture.workspace, requestValue.command),
        validateAuthorization: () => undefined
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
      resourceLeases: new ResourceLeaseCoordinator(),
      repository: fixture.repository,
      rootedFileAuthority: fixture.root,
      state: fixture.state, ...fixture.evidence,
      maxRetainedOutputBytes: 1024,
      createRun: (requestValue) => commandRun(fixture.workspace, requestValue.command),
      validateAuthorization: () => undefined
    });
    const result = await startCommand(execution, request(), {
      onProgress: (event) => progress.push(event)
    });
    assert.equal(result.stdout.text, 'A🙂B');
    assert.equal(progress.map((event) => event.text).join(''), 'A🙂B');
    assert.equal(progress.at(-1).observedBytes, Buffer.byteLength('A🙂B'));
    await execution.close();
  } finally {
    fixture.root.close();
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('sandbox command adapter preserves native runtime failure diagnostics', async () => {
  const fixture = await createFixture({ runtimeFailure: true });
  try {
    const execution = await SandboxCommandExecution.create({
      resourceLeases: new ResourceLeaseCoordinator(),
      repository: fixture.repository,
      rootedFileAuthority: fixture.root,
      state: fixture.state, ...fixture.evidence,
      maxRetainedOutputBytes: 1024,
      createRun: (requestValue) => commandRun(fixture.workspace, requestValue.command),
      validateAuthorization: () => undefined
    });
    const result = await startCommand(execution, request());
    assert.equal(result.status, 'failed');
    assert.equal(result.diagnostic, 'launcher exited without structured target status');
    await execution.close();
  } finally {
    fixture.root.close();
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test(
  'sandbox adapter satisfies start, output, ownership, terminal receipt, and restart recovery',
  { skip: !sandboxAvailable, timeout: 30_000 },
  async (t) => {
    const parent = await mkdtemp(path.join(tmpdir(), 'coding-agent-sandbox-conformance-'));
    const workspace = path.join(parent, 'workspace');
    const repositoryPath = path.join(parent, 'executions');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(workspace);
    const root = RootedFileAuthority.adopt(workspace);
    const state = await PrivateStateDirectory.create(path.join(parent, 'state'));
    const evidence = { events: new InMemoryEventRepository(agentEventCodec), artifacts: new InMemoryArtifactRepository() };
    const createRun = (request) => commandRun(workspace, request.command, request.timeoutMs);
    try {
      const firstRepository = await openSandboxExecutionRepository({
        directory: repositoryPath,
        maxRetainedOutputBytes: 1024 * 1024
      });
      const first = await SandboxCommandExecution.create({
        resourceLeases: new ResourceLeaseCoordinator(),
        repository: firstRepository,
        rootedFileAuthority: root,
        state, ...evidence,
        maxRetainedOutputBytes: 1024 * 1024,
        createRun,
        validateAuthorization: () => undefined
      });
      let result = await startCommand(first, { ...request(), command: 'printf durable-sandbox' });
      while (result.status === 'running') {
        t.signal.throwIfAborted();
        result = await first.query(result.processId, 1024, 100, 0, owner);
      }
      assert.equal(result.status, 'exited', result.diagnostic);
      assert.equal(result.stdout.text, 'durable-sandbox');
      await assert.rejects(
        first.query(result.processId, 100, 0, 0, { ...owner, ownerId: 'another-work', turnId: 'wrong' }),
        /another resource owner/
      );
      await first.close();

      const secondRepository = await openSandboxExecutionRepository({
        directory: repositoryPath,
        maxRetainedOutputBytes: 1024 * 1024
      });
      const second = await SandboxCommandExecution.create({
        resourceLeases: new ResourceLeaseCoordinator(),
        repository: secondRepository,
        rootedFileAuthority: root,
        state, ...evidence,
        maxRetainedOutputBytes: 1024 * 1024,
        createRun,
        validateAuthorization: () => undefined
      });
      const reports = second.recoveredTerminalReports();
      assert.equal(reports.length, 1);
      assert.equal(reports[0].result.processId, result.processId);
      assert.deepEqual(reports[0].result.owner, owner);
      await second.acknowledgeTerminalReport(result.processId);
      assert.equal(second.recoveredTerminalReports().length, 1);
      await second.close();
    } finally {
      root.close();
      await rm(parent, { recursive: true, force: true });
    }
  }
);

function request() {
  return {
    command: 'printf sandboxed',
    rootedDirectory: '.',
    pty: false,
    timeoutMs: 1_000,
    yieldMs: 10,
    outputTokenBudget: 100,
    owner
  };
}

async function startCommand(execution, requestValue, options = {}) {
  const reservation = await execution.plan(requestValue);
  return execution.start(reservation, options);
}

async function createFixture(options = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), 'coding-agent-sandbox-adapter-'));
  const workspace = path.join(parent, 'workspace');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(workspace);
  const root = RootedFileAuthority.adopt(workspace);
  const state = await PrivateStateDirectory.create(path.join(parent, 'state'));
  const repository = new FakeSandboxExecutionRepository(
    options.initialUnknown === true,
    options.splitUtf8Output === true,
    options.activationDelayMs,
    options.runtimeFailure === true
  );
  if (options.initialUnknown === true) {
    const recoveryIdentity = `${repository.identity}:${createHash('sha256').update(root.identity.canonicalPath).digest('hex')}`;
    const processId =
      'sandbox-' +
      createHash('sha256')
        .update(
          JSON.stringify([
            recoveryIdentity,
            owner.ownerId,
            owner.runId,
            owner.turnId,
            owner.toolBatchId,
            owner.callIndex
          ])
        )
        .digest('hex');
    await state.write(
      `sandbox-processes/${processId}.json`,
      `${JSON.stringify({ schemaVersion: 1, processId, owner, command: 'unknown command' })}\n`
    );
    repository.unknownId = processId;
  }
  return { parent, workspace, root, state, repository, evidence: { events: new InMemoryEventRepository(agentEventCodec), artifacts: new InMemoryArtifactRepository() } };
}

class FakeSandboxExecutionRepository {
  identity = 'fake-sandbox-repository';
  durability = 'application-process';
  prepareCount = 0;
  activationCount = 0;
  terminationCount = 0;
  unknownId;
  observations = new Map();

  constructor(initialUnknown, splitUtf8Output, activationDelayMs = 0, runtimeFailure = false) {
    if (!initialUnknown) this.unknownId = undefined;
    this.splitUtf8Output = splitUtf8Output;
    this.activationDelayMs = activationDelayMs;
    this.runtimeFailure = runtimeFailure;
  }

  async prepare(request) {
    this.prepareCount += 1;
    // The fake mirrors the upstream sandbox protocol, whose wire state is named `prepared`.
    const observation = sandboxAuthorizationObservation(request.executionId);
    this.observations.set(request.executionId, observation);
    return observation;
  }

  async activate(executionId) {
    this.activationCount += 1;
    const observation = this.runtimeFailure
      ? settledWithRuntimeFailure(executionId)
      : this.splitUtf8Output
        ? settledWithSplitUtf8(executionId)
        : settled(executionId);
    if (this.activationDelayMs === 0) this.observations.set(executionId, observation);
    else setTimeout(() => this.observations.set(executionId, observation), this.activationDelayMs);
  }

  async inspect(executionId, options = {}) {
    if (executionId === this.unknownId) return unknown(executionId);
    const initial = this.observations.get(executionId) ?? unknown(executionId);
    if (['prepared', 'preparing', 'running'].includes(initial.kind) && options.waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.waitMs));
    }
    const observation = this.observations.get(executionId) ?? unknown(executionId);
    if (observation.kind === 'settled' || observation.kind === 'rejected') observation.receipt ??= {
      digest: 'sha256:' + '4'.repeat(64), finalCursor: observation.output.availableCursorEnd,
      outputHash: '5'.repeat(64), stdoutBytes: observation.output.stdoutBytes, stderrBytes: observation.output.stderrBytes,
      omittedStdoutBytes: 0, omittedStderrBytes: 0
    };
    if (options.maxBytes === 0) return { ...observation, output: { kind: 'not-requested' } };
    if (observation.output.kind !== 'available') return observation;
    const start = options.afterCursor ?? 0;
    const end = Math.min(observation.output.availableCursorEnd, start + (options.maxBytes ?? 65536));
    return { ...observation, output: { ...observation.output, cursorStart: start, cursorEnd: end,
      chunks: observation.output.chunks.filter((chunk) => chunk.cursorEnd > start && chunk.cursorStart < end).map((chunk) => ({
        ...chunk, cursorStart: Math.max(start, chunk.cursorStart), cursorEnd: Math.min(end, chunk.cursorEnd),
        data: chunk.data.subarray(Math.max(0, start - chunk.cursorStart), Math.min(chunk.data.length, end - chunk.cursorStart))
      }))
    } };
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
    return { observations: await Promise.all(values.map((value) => this.inspect(value.executionId))) };
  }
  async acknowledgeUnknown(executionId) {
    if (executionId === this.unknownId) this.unknownId = undefined;
  }
  async forget(executionId, { receiptDigest }) {
    const state = this.observations.get(executionId);
    if (state && ['preparing', 'prepared', 'running'].includes(state.kind))
      throw new Error('A live or uncertain execution cannot be forgotten.');
    if (state.kind === 'retired') { assert.equal(state.receiptDigest, receiptDigest); return; }
    assert.equal(state.receipt.digest, receiptDigest);
    this.observations.set(executionId, { kind: 'retired', executionId, requestDigest: state.requestDigest,
      receiptDigest, reason: 'released', cleanupPending: false, output: { kind: 'unavailable', reason: 'released', diagnostic: 'Released' } });
  }
  async close() {}
}

function output(data = '') {
  const bytes = Buffer.from(data);
  return {
    kind: 'available',
    cursorStart: 0,
    cursorEnd: bytes.byteLength,
    availableCursorEnd: bytes.byteLength,
    stdoutBytes: bytes.byteLength,
    stderrBytes: 0,
    chunks:
      bytes.byteLength === 0
        ? []
        : [{ cursorStart: 0, cursorEnd: bytes.byteLength, stream: 'stdout', data: bytes }]
  };
}

function sandboxAuthorizationObservation(executionId) {
  return {
    kind: 'prepared',
    executionId,
    requestDigest: 'sha256:' + '1'.repeat(64),
    policyDigest: '2'.repeat(64),
    executionDigest: '3'.repeat(64),
    expiresAtMs: Date.now() + 10_000,
    summary: authorizationSummary(),
    enforcement,
    output: output()
  };
}

function settled(executionId) {
  return {
    kind: 'settled',
    executionId,
    requestDigest: 'sha256:' + '1'.repeat(64),
    output: output('sandboxed'),
    result: {
      processId: 'native',
      policyDigest: '2'.repeat(64),
      executionDigest: '3'.repeat(64),
      termination: { reason: 'exit', code: 0 },
      enforcement,
      violations: [],
      usage: { wallTimeMs: 1, stdoutBytes: 9, stderrBytes: 0 },
      cleanup: { completed: true, failures: [] }
    }
  };
}

function settledWithSplitUtf8(executionId) {
  const bytes = Buffer.from('A🙂B');
  return {
    ...settled(executionId),
    output: {
      kind: 'available',
      cursorStart: 0,
      cursorEnd: bytes.byteLength,
      availableCursorEnd: bytes.byteLength,
      stdoutBytes: bytes.byteLength,
      stderrBytes: 0,
        chunks: [
        { cursorStart: 0, cursorEnd: 3, stream: 'stdout', data: bytes.subarray(0, 3) },
        { cursorStart: 3, cursorEnd: bytes.byteLength, stream: 'stdout', data: bytes.subarray(3) }
      ]
    }
  };
}

function settledWithRuntimeFailure(executionId) {
  const base = settled(executionId);
  return {
    ...base,
    result: {
      ...base.result,
      termination: {
        reason: 'runtime-failure',
        error: {
          code: 'runtime_failed.launcher',
          message: 'launcher exited without structured target status',
          phase: 'execute',
          targetExecuted: true
        }
      }
    }
  };
}

function rejected(executionId) {
  return {
    kind: 'rejected',
    executionId,
    requestDigest: 'sha256:' + '1'.repeat(64),
    error: {
      code: 'preparation.cancelled',
      message: 'cancelled',
      phase: 'activate',
      targetExecuted: false
    },
    output: output()
  };
}

function unknown(executionId) {
  return {
    kind: 'unknown',
    executionId,
    reason: 'execution-host-unreachable',
    diagnostic: 'unknown outcome',
    output: output()
  };
}

test('background observation failure reaches queued tools without releasing uncertain resources', { timeout: 5_000 }, async (t) => {
  const fixture = await createFixture();
  const execution = await SandboxCommandExecution.create({
    resourceLeases: new ResourceLeaseCoordinator(), repository: fixture.repository, rootedFileAuthority: fixture.root, state: fixture.state, ...fixture.evidence,
    maxRetainedOutputBytes: 1024, createRun: (value) => commandRun(fixture.workspace, value.command), validateAuthorization: () => undefined
  });
  t.after(async () => { await execution.close(); fixture.root.close(); await rm(fixture.parent, { recursive: true, force: true }); });
  fixture.repository.activate = async (executionId) => {
    const { requestDigest, output } = settled(executionId);
    fixture.repository.observations.set(executionId, { kind: 'running', executionId, requestDigest, output, processId: 'native' });
  };
  const effects = { accesses: [{ scope: 'files', mode: 'write' }], lockScopes: ['files'] };
  const lease = await execution.resourceLeases.acquire(effects, owner.ownerId);
  const result = await startCommand(execution, { ...request(), yieldMs: 0 }, { lease });
  assert.equal(result.status, 'running');
  const waiting = assert.rejects(execution.resourceLeases.acquire(effects, 'next-tool', t.signal), /needs reconciliation: .*unknown outcome/);
  fixture.repository.observations.set(result.processId, unknown(result.processId));
  await waiting;
  assert.equal(execution.resourceLeases.activeCount(), 1);
  await assert.rejects(execution.plan(request()), /Unresolved sandbox executions/);
});

async function evidenceFixture(t, overrides = {}) {
  const fixture = await createFixture();
  const options = { resourceLeases: new ResourceLeaseCoordinator(), repository: fixture.repository,
    rootedFileAuthority: fixture.root, state: fixture.state, ...fixture.evidence,
    maxRetainedOutputBytes: 1024 * 1024, createRun: (value) => commandRun(fixture.workspace, value.command),
    validateAuthorization: () => undefined, ...overrides };
  const execution = await SandboxCommandExecution.create(options);
  t.after(async () => { await execution.close(); fixture.root.close(); await rm(fixture.parent, { recursive: true, force: true }); });
  return { ...fixture, options, execution };
}

test('receipt release failure keeps exact settlement and retries without executing again', async (t) => {
  const fixture = await evidenceFixture(t);
  const forget = fixture.repository.forget.bind(fixture.repository);
  fixture.repository.forget = async () => { throw new Error('Injected receipt write failure.'); };
  const result = await startCommand(fixture.execution, request());
  assert.equal(result.status, 'exited');
  assert.equal(result.exitCode, 0);
  assert.equal(result.originalOutput.kind, 'captured');
  assert.match((await fixture.execution.listProcesses())[0].diagnostic, /receipt.*failed/i);
  fixture.repository.forget = forget;
  await fixture.execution.retryReconciliation();
  assert.equal(fixture.repository.observations.get(result.processId).kind, 'retired');
  assert.equal(fixture.repository.activationCount, 1);
  assert.equal((await fixture.execution.query(result.processId, 4000, 0, 0, owner)).stdout.text, 'sandboxed');
});

test('unavailable original output retains known exit and does not release the receipt', async (t) => {
  const fixture = await evidenceFixture(t);
  const inspect = fixture.repository.inspect.bind(fixture.repository);
  fixture.repository.inspect = async (...args) => {
    const observation = await inspect(...args);
    return observation.kind === 'settled' ? { ...observation, output: { kind: 'unavailable', reason: 'missing', diagnostic: 'Injected missing output file.' } } : observation;
  };
  const result = await startCommand(fixture.execution, request());
  assert.equal(result.status, 'exited');
  assert.equal(result.exitCode, 0);
  assert.equal(result.originalOutput.kind, 'unavailable');
  assert.equal(result.stdout.observedBytes, 9);
  assert.equal(result.stdout.omittedBytes, 9);
  assert.equal(fixture.repository.observations.get(result.processId).kind, 'settled');
  await fixture.execution.close();
  const reopened = await SandboxCommandExecution.create({ ...fixture.options, resourceLeases: new ResourceLeaseCoordinator() });
  t.after(() => reopened.close());
  assert.equal((await reopened.listProcesses())[0].status, 'exited');
  assert.equal((await reopened.query(result.processId, 4000, 0, 0, owner)).originalOutput.kind, 'unavailable');
});

test('original mixed-stream bytes survive bounded presentation and receipt release', async (t) => {
  const deliveries = [];
  const fixture = await evidenceFixture(t, { onSettlement: (report) => deliveries.push(report) });
  const original = Buffer.from('First 🙂\n' + 'a'.repeat(90000) + '\nlast bytes\n');
  fixture.repository.activate = async (executionId) => {
    fixture.repository.activationCount++;
    const value = settled(executionId);
    value.output = { ...output(), cursorEnd: original.length, availableCursorEnd: original.length,
      stdoutBytes: 10, stderrBytes: original.length - 10, chunks: [
        { cursorStart: 0, cursorEnd: 10, stream: 'stdout', data: original.subarray(0, 10) },
        { cursorStart: 10, cursorEnd: original.length, stream: 'stderr', data: original.subarray(10) }
      ] };
    fixture.repository.observations.set(executionId, value);
  };
  const result = await startCommand(fixture.execution, request());
  assert.equal(result.originalOutput.cursorEnd, original.length);
  assert.ok(result.cursorEnd < original.length);
  assert.equal(deliveries.length, 1);
  assert.deepEqual(Buffer.from(await fixture.evidence.artifacts.readVerified(result.artifact)), original);
  await fixture.execution.close();
  const reopened = await SandboxCommandExecution.create({ ...fixture.options, resourceLeases: new ResourceLeaseCoordinator() });
  t.after(() => reopened.close());
  const tail = await reopened.query(result.processId, 4000, 0, original.length - 11, owner);
  assert.equal(tail.cursorStart, original.length - 11);
  assert.equal(tail.cursorEnd, original.length);
  assert.equal(tail.stderr.text, 'last bytes\n');
  assert.equal(tail.combined.observedBytes, original.length);
  assert.equal(tail.combined.omittedBytes, original.length - 11);
  const statusOnly = await reopened.query(result.processId, 0, 0, 0, owner);
  assert.equal(statusOnly.combined.text, '');
  assert.equal(statusOnly.combined.capturedBytes, 0);
  assert.equal(statusOnly.combined.omittedBytes, original.length);
  assert.equal(statusOnly.cursorEnd, 0);
  assert.equal(statusOnly.exitCode, 0);
  assert.equal(deliveries.length, 1);
  assert.equal(fixture.repository.activationCount, 1);
});

test('failed artifact capture cannot acknowledge a receipt or repeat the command', async (t) => {
  const fixture = await evidenceFixture(t);
  const store = fixture.evidence.artifacts.storeProtected.bind(fixture.evidence.artifacts);
  fixture.evidence.artifacts.storeProtected = async () => { throw new Error('Injected artifact write failure.'); };
  await assert.rejects(startCommand(fixture.execution, request()), /artifact write failure/);
  assert.equal([...fixture.repository.observations.values()][0].kind, 'settled');
  fixture.evidence.artifacts.storeProtected = store;
  await fixture.execution.retryReconciliation();
  assert.equal([...fixture.repository.observations.values()][0].kind, 'retired');
  assert.equal(fixture.repository.activationCount, 1);
});

for (const eventType of ['resource.observed', 'resource.released']) {
  for (const committed of [false, true]) {
    test(`command handoff recovers ${committed ? 'after' : 'before'} ${eventType} append`, async (t) => {
      const fixture = await evidenceFixture(t);
      const events = fixture.evidence.events;
      const append = events.append.bind(events);
      let injected = false;
      events.append = async (runId, event, options) => {
        if (event.type !== eventType || injected) return append(runId, event, options);
        injected = true;
        if (committed) await append(runId, event, options);
        throw new Error('Injected observation append interruption.');
      };
      await assert.rejects(startCommand(fixture.execution, request()), /append interruption/);
      assert.equal([...fixture.repository.observations.values()][0].kind, 'settled');
      await fixture.execution.close();
      const reopened = await SandboxCommandExecution.create({ ...fixture.options, resourceLeases: new ResourceLeaseCoordinator() });
      t.after(() => reopened.close());
      const [process] = await reopened.listProcesses();
      const result = await reopened.query(process.processId, 4000, 0, 0, owner);
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.text, 'sandboxed');
      assert.equal(fixture.repository.activationCount, 1);
      assert.equal(fixture.repository.observations.get(process.processId).kind, 'retired');
      const terminal = [];
      for await (const record of events.read(owner.runId)) {
        if (record.event.type === 'resource.released') terminal.push(record);
      }
      assert.equal(terminal.length, 1);
    });
  }
}

test('final output mismatch preserves exit truth and retains the unacknowledged receipt', async (t) => {
  const fixture = await evidenceFixture(t);
  const inspect = fixture.repository.inspect.bind(fixture.repository);
  fixture.repository.inspect = async (...args) => {
    const observation = await inspect(...args);
    return observation.kind === 'settled'
      ? { ...observation, receipt: { ...observation.receipt, finalCursor: observation.receipt.finalCursor + 1 } }
      : observation;
  };
  const result = await startCommand(fixture.execution, request());
  assert.equal(result.exitCode, 0);
  assert.equal(result.originalOutput.kind, 'unavailable');
  assert.match(result.originalOutput.diagnostic, /does not cover/);
  assert.equal(fixture.repository.observations.get(result.processId).kind, 'settled');
});

test('failed reconciliation closes its repository once and leaves the borrowed root usable', async (t) => {
  const fixture = await createFixture();
  t.after(async () => { fixture.root.close(); await rm(fixture.parent, { recursive: true, force: true }); });
  let closed = 0;
  fixture.repository.close = async () => { closed++; };
  fixture.repository.reconcile = async () => { throw new Error('Injected reconciliation failure.'); };
  await assert.rejects(SandboxCommandExecution.create({ resourceLeases: new ResourceLeaseCoordinator(),
    repository: fixture.repository, rootedFileAuthority: fixture.root, state: fixture.state, ...fixture.evidence,
    maxRetainedOutputBytes: 1024, createRun: (value) => commandRun(fixture.workspace, value.command), validateAuthorization: () => undefined
  }), /reconciliation failure/);
  assert.equal(closed, 1);
  const derived = fixture.root.derive();
  derived.close();
});

test('a background observer seeing receipt retirement reuses the committed settlement', async (t) => {
  const fixture = await evidenceFixture(t);
  let releaseObserver;
  const gate = new Promise((resolve) => { releaseObserver = resolve; });
  t.after(() => releaseObserver());
  const inspect = fixture.repository.inspect.bind(fixture.repository);
  fixture.repository.inspect = async (id, options = {}) => {
    if (options.maxBytes === 0 && options.waitMs > 0) await gate;
    return inspect(id, options);
  };
  fixture.repository.activate = async (executionId) => {
    const { requestDigest, output } = settled(executionId);
    fixture.repository.observations.set(executionId, { kind: 'running', executionId, requestDigest, output, processId: 'native' });
  };
  const running = await startCommand(fixture.execution, request());
  assert.equal(running.status, 'running');
  fixture.repository.observations.set(running.processId, settled(running.processId));
  const completed = await fixture.execution.query(running.processId, 4000, 0, 0, owner);
  assert.equal(completed.exitCode, 0);
  releaseObserver();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const next = await fixture.execution.plan({ ...request(), owner: { ...owner, callIndex: 1 } });
  await next.release();
  assert.equal((await fixture.execution.reconcile()).unresolved.length, 0);
});

test('a failed settlement subscriber cannot change terminal truth or retain execution authority', async (t) => {
  const fixture = await evidenceFixture(t, { onSettlement: () => { throw new Error('Injected subscriber failure.'); } });
  const result = await startCommand(fixture.execution, request());
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, 'exited');
  assert.equal(fixture.repository.observations.get(result.processId).kind, 'retired');
  assert.equal(fixture.execution.resourceLeases.activeCount(), 0);
  assert.equal((await fixture.execution.query(result.processId, 4000, 0, 0, owner)).exitCode, 0);
});

test('running command presentation redacts secrets without changing original stream bytes', async (t) => {
  const fixture = await evidenceFixture(t);
  const original = Buffer.from('API_KEY=private-value\n');
  const progress = [];
  fixture.repository.activate = async (executionId) => {
    const value = settled(executionId);
    fixture.repository.observations.set(executionId, {
      kind: 'running', executionId, requestDigest: value.requestDigest, processId: 'native',
      output: { ...output(), cursorEnd: original.length, availableCursorEnd: original.length,
        stdoutBytes: original.length, stderrBytes: 0,
        chunks: [
          { cursorStart: 0, cursorEnd: 10, stream: 'stdout', data: original.subarray(0, 10) },
          { cursorStart: 10, cursorEnd: original.length, stream: 'stdout', data: original.subarray(10) }
        ] }
    });
  };
  const result = await startCommand(fixture.execution, request(), { onProgress: (item) => progress.push(item) });
  assert.equal(result.status, 'running');
  assert.doesNotMatch(result.stdout.text, /private-value/);
  assert.doesNotMatch(result.combined.text, /private-value/);
  assert.equal(result.cursorEnd, original.length);
  assert.equal(result.stdout.observedBytes, original.length);
  assert.ok(progress.length > 0);
  assert.doesNotMatch(progress.map((item) => item.text).join(''), /private-value/);
  assert.deepEqual(Buffer.concat(fixture.repository.observations.get(result.processId).output.chunks.map((chunk) => chunk.data)), original);
});

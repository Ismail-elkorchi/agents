import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { agentEventCodec } from '@agent-core/runtime';
import { ResourceLeaseCoordinator, adoptWorkspaceFiles } from '@agent-core/tools';
import { PrivateStateDirectory } from '../dist/state/private-state.js';
import { SandsurfCommandExecution } from '../dist/execution/sandsurf-command-execution.js';
import { SandsurfCommandObservations } from '../dist/execution/sandsurf-command-observations.js';
import { SandsurfWorkspaceFiles } from '../dist/execution/sandsurf-workspace.js';
import { createWorkspaceToolHost } from '@agent-core/tools-local';
import { invokeToolCall, jsonToolCall } from './tool-call-helpers.js';

test('guest workspace authority normalizes paths and delegates one native transaction', async () => {
  const transactions = [];
  const content = new TextEncoder().encode('guest bytes');
  const digest = createHash('sha256').update(content).digest('hex');
  const filesystem = {
    async lstat(path) {
      assert.equal(path, '/workspace/src/file.txt');
      return { kind: 'stat', value: { kind: 'regular', mode: 0o644 } };
    },
    async read(_path, offset, maximum) {
      return {
        kind: 'read',
        range: {
          offset,
          bytes: [...content.subarray(offset, offset + maximum)],
          eof: offset + maximum >= content.length,
          revision: { size: content.length, digest }
        }
      };
    },
    async readFile(path) {
      assert.equal(path, '/workspace/src/file.txt');
      return content;
    },
    async transaction(mutations) {
      transactions.push(mutations);
    }
  };
  const files = new SandsurfWorkspaceFiles(workspaceSandbox(filesystem, 7), 7, 1, true);
  assert.equal(files.normalize('./src/../src/file.txt'), 'src/file.txt');
  await assert.rejects(
    Promise.resolve().then(() => files.normalize('../host')),
    /escapes/
  );
  assert.deepEqual(await files.stat('src/file.txt'), {
    kind: 'file',
    path: 'src/file.txt',
    mode: 0o644,
    revision: { size: content.length, digest }
  });
  assert.equal(
    new TextDecoder().decode((await files.readFile('src/file.txt')).bytes),
    'guest bytes'
  );
  await files.transaction([
    {
      kind: 'write',
      path: 'src/file.txt',
      bytes: content,
      mode: 0o600,
      expected: { kind: 'matches', size: content.length, digest }
    }
  ]);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0][0].path, '/workspace/src/file.txt');
  files.close();
});

test('missing guest files are absent without masking other filesystem failures', async () => {
  const missing = new SandsurfWorkspaceFiles(
    workspaceSandbox({
      async lstat() {
        throw Object.assign(new Error('not found'), { category: 'filesystem.missing' });
      }
    }),
    1,
    1,
    true
  );
  assert.deepEqual(await missing.stat('missing.txt'), { kind: 'absent', path: 'missing.txt' });
  const denied = new SandsurfWorkspaceFiles(
    workspaceSandbox({
      async lstat() {
        throw Object.assign(new Error('denied'), { category: 'filesystem.permission' });
      }
    }),
    1,
    1,
    true
  );
  await assert.rejects(denied.stat('denied.txt'), /denied/);
});

test('terminal capture durably stores every original byte and acknowledges without release', async () => {
  const events = new InMemoryEventRepository(agentEventCodec);
  const artifacts = new InMemoryArtifactRepository();
  const sink = new SandsurfCommandObservations({ events, artifacts });
  const bytes = Buffer.from('complete original output');
  const chunk = {
    cursor: 0,
    stream: 'stdout',
    bytes,
    digest: createHash('sha256').update(bytes).digest('hex')
  };
  let acknowledged;
  let releaseCalls = 0;
  const process = {
    output: {
      read: async ({ after }) => ({
        after,
        available: bytes.length,
        chunks: after === 0 ? [chunk] : []
      })
    },
    acknowledge: async (digest) => {
      acknowledged = digest;
    },
    release: async () => {
      releaseCalls += 1;
    }
  };
  const owner = {
    ownerId: 'owner',
    runId: 'run',
    turnId: 'turn',
    toolBatchId: 'batch',
    callIndex: 0
  };
  const identity = {
    processId: 'process',
    requestDigest: 'a'.repeat(64),
    owner,
    sandboxId: 'sandbox',
    epoch: 1
  };
  const receipt = {
    digest: 'b'.repeat(64),
    receipt: {
      sandboxId: 'sandbox',
      epoch: 1,
      processId: 'process',
      operationId: 'spawn',
      requestDigest: identity.requestDigest,
      outcome: { kind: 'exit', code: 0 },
      output: {
        finalCursor: bytes.length,
        stdoutBytes: bytes.length,
        stderrBytes: 0,
        terminalBytes: 0,
        omittedBytes: 0
      },
      cleanupDigest: 'c'.repeat(64),
      accountingDigest: 'd'.repeat(64)
    }
  };
  const view = {
    text: bytes.toString(),
    observedBytes: bytes.length,
    capturedBytes: bytes.length,
    omittedBytes: 0,
    startsAtOutputStart: true,
    endsAtOutputEnd: true
  };
  const result = {
    processId: 'process',
    owner,
    status: 'exited',
    cursorStart: 0,
    cursorEnd: bytes.length,
    stdout: view,
    stderr: { ...view, text: '', observedBytes: 0, capturedBytes: 0 },
    combined: view,
    exitCode: 0
  };
  const report = await sink.settle(identity, process, receipt, result);
  assert.equal(acknowledged, receipt.digest);
  assert.equal(releaseCalls, 0);
  assert.equal(report.result.originalOutput.cursorEnd, bytes.length);
  assert.equal(report.protectedArtifact.visibility, 'protected');
  assert.deepEqual((await sink.terminal(identity)).result, report.result);
});

test('failed application capture leaves Sandsurf originals retained and unacknowledged', async () => {
  const events = new InMemoryEventRepository(agentEventCodec);
  const bytes = Buffer.from('must remain available');
  let acknowledgements = 0;
  let releases = 0;
  const process = {
    output: {
      async read({ after }) {
        return {
          after,
          available: bytes.length,
          chunks:
            after === 0
              ? [
                  {
                    cursor: 0,
                    stream: 'stdout',
                    bytes,
                    digest: createHash('sha256').update(bytes).digest('hex')
                  }
                ]
              : []
        };
      }
    },
    async acknowledge() {
      acknowledgements += 1;
    },
    async release() {
      releases += 1;
    }
  };
  const artifacts = {
    async storeProtected() {
      throw new Error('protected storage unavailable');
    }
  };
  const sink = new SandsurfCommandObservations({ events, artifacts });
  const owner = {
    ownerId: 'owner',
    runId: 'capture-failure-run',
    turnId: 'turn',
    toolBatchId: 'batch',
    callIndex: 0
  };
  const identity = {
    processId: 'capture-failure',
    requestDigest: 'a'.repeat(64),
    owner,
    sandboxId: 'sandbox',
    epoch: 1
  };
  const receipt = {
    digest: 'b'.repeat(64),
    receipt: {
      sandboxId: 'sandbox',
      epoch: 1,
      processId: identity.processId,
      operationId: 'spawn',
      requestDigest: identity.requestDigest,
      outcome: { kind: 'exit', code: 0 },
      output: {
        finalCursor: bytes.length,
        stdoutBytes: bytes.length,
        stderrBytes: 0,
        terminalBytes: 0,
        omittedBytes: 0
      },
      cleanupDigest: 'c'.repeat(64),
      accountingDigest: 'd'.repeat(64)
    }
  };
  const view = {
    text: bytes.toString(),
    observedBytes: bytes.length,
    capturedBytes: bytes.length,
    omittedBytes: 0,
    startsAtOutputStart: true,
    endsAtOutputEnd: true
  };
  const result = {
    processId: identity.processId,
    owner,
    status: 'exited',
    cursorStart: 0,
    cursorEnd: bytes.length,
    stdout: view,
    stderr: { ...view, text: '', observedBytes: 0, capturedBytes: 0 },
    combined: view,
    exitCode: 0
  };
  await assert.rejects(sink.settle(identity, process, receipt, result), /storage unavailable/u);
  assert.equal(acknowledgements, 0);
  assert.equal(releases, 0);
  const retained = await process.output.read({ after: 0 });
  assert.equal(
    Buffer.concat(retained.chunks.map((chunk) => chunk.bytes)).toString(),
    bytes.toString()
  );
});

test('command execution resumes from a persisted Sandsurf event cursor without process polling', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'coding-sandsurf-events-'));
  const state = await PrivateStateDirectory.create(path.join(root, 'state'));
  const applicationEvents = new InMemoryEventRepository(agentEventCodec);
  const artifacts = new InMemoryArtifactRepository();
  const bytes = Buffer.from('event output');
  let processId = 'process-event-test';
  const owner = {
    ownerId: 'owner',
    runId: 'run',
    turnId: 'turn',
    toolBatchId: 'batch',
    callIndex: 0
  };
  let delivered = false;
  let inspectionCalls = 0;
  const receipt = {
    digest: 'b'.repeat(64),
    receipt: {
      sandboxId: 'sandbox-1',
      epoch: 1,
      processId,
      operationId: 'spawn-event-test',
      requestDigest: 'a'.repeat(64),
      outcome: { kind: 'exit', code: 0 },
      output: {
        finalCursor: bytes.length,
        stdoutBytes: bytes.length,
        stderrBytes: 0,
        terminalBytes: 0,
        omittedBytes: 0
      },
      cleanupDigest: 'c'.repeat(64),
      accountingDigest: 'd'.repeat(64)
    }
  };
  const process = {
    id: processId,
    output: {
      async read({ after }) {
        if (!delivered || after >= bytes.length)
          return { after, available: delivered ? bytes.length : 0, chunks: [] };
        return {
          after,
          available: bytes.length,
          chunks: [
            {
              cursor: 0,
              stream: 'stdout',
              bytes,
              digest: createHash('sha256').update(bytes).digest('hex')
            }
          ]
        };
      }
    },
    async inspect() {
      inspectionCalls += 1;
      return {
        kind: 'current',
        value: {
          request: {
            processId,
            sandboxId: 'sandbox-1',
            epoch: 1,
            operationId: receipt.receipt.operationId
          },
          guestPid: 42,
          lineage: null,
          state: delivered
            ? { kind: 'exited', outcome: receipt.receipt.outcome }
            : { kind: 'running' }
        }
      };
    },
    async receipt() {
      return delivered ? receipt : undefined;
    },
    async acknowledge() {},
    async terminate() {},
    async write() {},
    async closeInput() {}
  };
  const sandbox = {
    id: 'sandbox-1',
    events: {
      async read() {
        return { cursor: 5, available: 5, events: [] };
      },
      async *follow({ after }) {
        assert.equal(after, 5);
        delivered = true;
        yield {
          cursor: 6,
          digest: 'e'.repeat(64),
          value: { kind: 'output', processId, boundary: { finalCursor: bytes.length } }
        };
      }
    },
    processes: {
      async spawn(options) {
        assert.equal(options.processId, processId);
        const stored = JSON.parse(
          await state.read(`sandsurf/processes/sandbox-1/${processId}.json`)
        );
        assert.equal(stored.eventCursor, 5);
        return process;
      },
      async get() {
        return process;
      },
      async list() {
        return [];
      }
    },
    terminals: {}
  };
  const execution = new SandsurfCommandExecution({
    sandbox,
    epoch: 1,
    configurationRevision: 1,
    state,
    resourceLeases: new ResourceLeaseCoordinator(),
    descriptor: Object.freeze({
      implementationId: 'test.sandsurf@1',
      recoveryIdentity: 'test-sandsurf',
      capabilities: Object.freeze(['reconnect']),
      supportsPty: true
    }),
    events: applicationEvents,
    artifacts
  });
  try {
    const reservation = await execution.plan({
      command: 'printf event',
      rootedDirectory: '.',
      pty: false,
      timeoutMs: 10_000,
      yieldMs: 1_000,
      outputTokenBudget: 1_000,
      owner
    });
    // Override generated identities only at the fake spawn boundary.
    const plannedProcessId = reservation.authorization.processId;
    processId = plannedProcessId;
    process.id = plannedProcessId;
    receipt.receipt.processId = plannedProcessId;
    receipt.receipt.operationId = reservation.authorization.operationId;
    sandbox.processes.spawn = async (options) => {
      assert.equal(options.processId, plannedProcessId);
      const stored = JSON.parse(
        await state.read(`sandsurf/processes/sandbox-1/${plannedProcessId}.json`)
      );
      assert.equal(stored.eventCursor, 5);
      return process;
    };
    const result = await execution.start(reservation);
    assert.equal(result.status, 'exited');
    assert.equal(result.eventCursor.position, '6');
    assert.equal(result.combined.text, 'event output');
    assert.ok(inspectionCalls >= 2 && inspectionCalls <= 8);
    const stored = JSON.parse(
      await state.read(`sandsurf/processes/sandbox-1/${plannedProcessId}.json`)
    );
    assert.equal(stored.schemaVersion, 1);
    assert.equal(stored.eventCursor, 6);
  } finally {
    await execution.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('guest file selection applies bounded git-ignore rules from the guest workspace', async () => {
  const encoder = new TextEncoder();
  const content = new Map([
    ['.gitignore', encoder.encode('ignored.txt\nnested/\n')],
    ['ignored.txt', encoder.encode('ignored')],
    ['visible.txt', encoder.encode('visible')],
    ['nested/hidden.txt', encoder.encode('nested')]
  ]);
  const directories = new Map([
    [
      '.',
      [
        { name: '.gitignore', type: 'file' },
        { name: 'ignored.txt', type: 'file' },
        { name: 'nested', type: 'directory' },
        { name: 'visible.txt', type: 'file' }
      ]
    ],
    ['nested', [{ name: 'hidden.txt', type: 'file' }]]
  ]);
  const files = {
    descriptor: Object.freeze({
      implementationId: 'test.workspace@1',
      workspaceId: 'guest',
      displayRoot: '/workspace',
      capabilities: Object.freeze(['read'])
    }),
    normalize(value) {
      return value === '' ? '.' : value;
    },
    async *list(value) {
      yield* directories.get(value) ?? [];
    },
    async readFile(value) {
      const bytes = content.get(value);
      if (!bytes) throw new Error(`Missing ${value}`);
      return {
        bytes,
        revision: { size: bytes.length, digest: createHash('sha256').update(bytes).digest('hex') }
      };
    },
    async stat(value) {
      if (directories.has(value)) return { kind: 'directory', path: value, mode: 0o755 };
      const bytes = content.get(value);
      return bytes
        ? {
            kind: 'file',
            path: value,
            mode: 0o644,
            revision: {
              size: bytes.length,
              digest: createHash('sha256').update(bytes).digest('hex')
            }
          }
        : { kind: 'absent', path: value };
    },
    async transaction() {},
    async mkdir() {},
    async remove() {},
    async close() {}
  };
  adoptWorkspaceFiles(files);
  const host = createWorkspaceToolHost({
    files,
    artifacts: new InMemoryArtifactRepository(),
    enabledTools: ['find_files']
  });
  const context = {
    policy: { allowedRisks: ['read'] },
    services: host.services,
    invocation: {
      runId: 'run',
      turnId: 'turn',
      requestAttempt: 1,
      toolBatchId: 'batch',
      callIndex: 0,
      toolAttempt: 1
    }
  };
  const ignored = await invokeToolCall(
    jsonToolCall('find_files', {
      path: '.',
      patterns: ['**/*'],
      type: 'file',
      respectGitIgnore: true,
      includeHidden: false,
      exclude: []
    }),
    host.tools,
    context
  );
  assert.deepEqual(ignored.output.entries, [{ path: 'visible.txt', type: 'file' }]);
  assert.equal(
    ignored.output.omissions.some((item) => item.cause === 'gitignored'),
    true
  );

  const unignored = await invokeToolCall(
    jsonToolCall('find_files', {
      path: '.',
      patterns: ['**/*'],
      type: 'file',
      respectGitIgnore: false,
      includeHidden: false,
      exclude: []
    }),
    host.tools,
    context
  );
  assert.deepEqual(
    unignored.output.entries.map((entry) => entry.path),
    ['ignored.txt', 'nested/hidden.txt', 'visible.txt']
  );
});

test('owner cleanup terminates transient jobs but leaves environment services running', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'coding-sandsurf-lifetimes-'));
  const state = await PrivateStateDirectory.create(path.join(root, 'state'));
  const processes = new Map();
  const sandbox = {
    id: 'sandbox-lifetimes',
    events: {
      async read() {
        return { cursor: 0, available: 0, events: [] };
      },
      async *follow({ signal }) {
        await new Promise((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', resolve, { once: true });
        });
      }
    },
    processes: {
      async spawn(options) {
        let running = true;
        let terminated = false;
        const inputWrites = [];
        let inputClosed = false;
        const receipt = {
          digest: createHash('sha256').update(`receipt:${options.processId}`).digest('hex'),
          receipt: {
            sandboxId: 'sandbox-lifetimes',
            epoch: 1,
            processId: options.processId,
            operationId: options.operationId,
            requestDigest: 'a'.repeat(64),
            outcome: { kind: 'signal', signal: 15 },
            output: {
              finalCursor: 0,
              stdoutBytes: 0,
              stderrBytes: 0,
              terminalBytes: 0,
              omittedBytes: 0
            },
            cleanupDigest: 'b'.repeat(64),
            accountingDigest: 'c'.repeat(64)
          }
        };
        const handle = {
          id: options.processId,
          lifetime: options.lifetime,
          deadlineUnixMs: options.elapsedDeadlineUnixMs,
          get terminated() {
            return terminated;
          },
          get inputWrites() {
            return inputWrites;
          },
          get inputClosed() {
            return inputClosed;
          },
          input: {
            async write(bytes) {
              inputWrites.push(Buffer.from(bytes).toString('utf8'));
            },
            async close() {
              inputClosed = true;
            }
          },
          output: {
            async read({ after }) {
              return { after, available: 0, chunks: [] };
            }
          },
          async inspect() {
            return {
              kind: 'current',
              value: {
                request: {
                  processId: options.processId,
                  sandboxId: 'sandbox-lifetimes',
                  epoch: options.expectedEpoch,
                  operationId: options.operationId
                },
                guestPid: 50,
                lineage: null,
                state: running
                  ? { kind: 'running' }
                  : { kind: 'exited', outcome: receipt.receipt.outcome }
              }
            };
          },
          async receipt() {
            return running ? undefined : receipt;
          },
          async terminate() {
            running = false;
            terminated = true;
          },
          async acknowledge() {}
        };
        processes.set(options.processId, handle);
        return handle;
      },
      async get(id) {
        return processes.get(id);
      },
      async list() {
        return [...processes.values()].map((process) => ({
          kind: 'current',
          value: {
            request: { processId: process.id },
            guestPid: 50,
            lineage: null,
            state: process.terminated
              ? { kind: 'exited', outcome: { kind: 'signal', signal: 15 } }
              : { kind: 'running' }
          }
        }));
      }
    },
    terminals: {}
  };
  const execution = new SandsurfCommandExecution({
    sandbox,
    epoch: 1,
    configurationRevision: 1,
    state,
    resourceLeases: new ResourceLeaseCoordinator(),
    descriptor: Object.freeze({
      implementationId: 'test.sandsurf-lifetimes@1',
      recoveryIdentity: 'test-sandsurf-lifetimes',
      capabilities: Object.freeze(['persistent-services']),
      supportsPty: true
    }),
    events: new InMemoryEventRepository(agentEventCodec),
    artifacts: new InMemoryArtifactRepository()
  });
  const owner = {
    ownerId: 'coding-work',
    runId: 'run',
    turnId: 'turn',
    toolBatchId: 'batch',
    callIndex: 0
  };
  try {
    const jobPlan = await execution.plan({
      command: 'job',
      rootedDirectory: '.',
      pty: false,
      lifetime: 'job',
      timeoutMs: 10_000,
      yieldMs: 0,
      outputTokenBudget: 0,
      owner
    });
    const servicePlan = await execution.plan({
      command: 'service',
      rootedDirectory: '.',
      pty: false,
      lifetime: 'environment',
      timeoutMs: 10_000,
      yieldMs: 0,
      outputTokenBudget: 0,
      owner: { ...owner, callIndex: 1 }
    });
    const job = await execution.start(jobPlan);
    const service = await execution.start(servicePlan);
    assert.equal(job.status, 'running');
    assert.equal(service.status, 'running');
    assert.equal(Number.isSafeInteger(processes.get(job.processId).deadlineUnixMs), true);
    await execution.writeInput(job.processId, 'hello', owner);
    await execution.closeInput(job.processId, owner);
    assert.deepEqual(processes.get(job.processId).inputWrites, ['hello']);
    assert.equal(processes.get(job.processId).inputClosed, true);
    const reports = await execution.disposeOwner(owner.ownerId);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].result.processId, job.processId);
    assert.equal(processes.get(job.processId).terminated, true);
    assert.equal(processes.get(service.processId).terminated, false);
  } finally {
    await execution.close();
    await rm(root, { recursive: true, force: true });
  }
});

function workspaceSandbox(fs, epoch = 1) {
  return {
    id: 'sandbox-1',
    fs,
    async inspect() {
      return { configurationRevision: 1, machine: { kind: 'current', value: { epoch } } };
    }
  };
}

async function commandFixture(t, initialMode = 'exited') {
  const root = await mkdtemp(path.join(tmpdir(), 'coding-sandsurf-regression-'));
  const state = await PrivateStateDirectory.create(path.join(root, 'state'));
  const events = new InMemoryEventRepository(agentEventCodec);
  const artifacts = new InMemoryArtifactRepository();
  const leases = new ResourceLeaseCoordinator();
  const flags = {
    mode: initialMode,
    missing: false,
    outputMissing: false,
    ackFails: false,
    spawnFails: false,
    spawnCount: 0,
    acknowledgements: 0,
    epoch: 3
  };
  const bytes = Buffer.from('a complete log\n');
  const owner = {
    ownerId: 'session',
    runId: 'run',
    turnId: 'turn',
    toolBatchId: 'batch',
    callIndex: 0
  };
  let options;
  const output = {
    finalCursor: bytes.length,
    stdoutBytes: bytes.length,
    stderrBytes: 0,
    terminalBytes: 0,
    omittedBytes: 0
  };
  const receipt = () => ({
    digest: 'd'.repeat(64),
    receipt: {
      sandboxId: 'sandbox-test',
      processId: options.processId,
      operationId: options.operationId,
      epoch: 3,
      requestDigest: 'a'.repeat(64),
      outcome: { kind: 'exit', code: 0 },
      output,
      cleanupDigest: 'b'.repeat(64),
      accountingDigest: 'c'.repeat(64)
    }
  });
  const process = {
    get id() {
      return options.processId;
    },
    input: {
      async write(_bytes, precondition) {
        assert.deepEqual(precondition, { expectedEpoch: 3, expectedRevision: 4 });
      },
      async close() {}
    },
    async inspect() {
      return {
        kind: 'current',
        value: {
          request: {
            processId: options.processId,
            operationId: options.operationId,
            sandboxId: 'sandbox-test',
            epoch: flags.epoch
          },
          state: { kind: flags.mode }
        }
      };
    },
    async receipt() {
      return flags.mode === 'exited' ? receipt() : undefined;
    },
    async acknowledge() {
      flags.acknowledgements++;
      if (flags.ackFails) throw new Error('acknowledgement unavailable');
    },
    async terminate(precondition) {
      assert.equal(precondition.expectedEpoch, 3);
      flags.mode = 'exited';
    },
    output: {
      async read({ after, maximum }) {
        if (flags.outputMissing) throw new Error('originals were lost');
        const chunk = bytes.subarray(after, Math.min(after + maximum, bytes.length));
        return {
          after,
          available: bytes.length,
          chunks: chunk.length
            ? [
                {
                  cursor: after,
                  stream: 'stdout',
                  bytes: chunk,
                  digest: createHash('sha256').update(chunk).digest('hex')
                }
              ]
            : []
        };
      }
    }
  };
  const sandbox = {
    id: 'sandbox-test',
    events: {
      async read() {
        if (flags.missing) throw new Error('runtime unavailable');
        return { available: 0 };
      },
      async *follow({ signal }) {
        await new Promise((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', resolve, { once: true });
        });
      }
    },
    processes: {
      async spawn(request) {
        options = request;
        flags.spawnCount++;
        if (flags.spawnFails) throw new Error('dispatch delivery unknown');
        return process;
      },
      async get() {
        if (flags.missing) throw new Error('runtime unavailable');
        return process;
      }
    }
  };
  const descriptor = Object.freeze({
    implementationId: 'test.sandsurf@1',
    recoveryIdentity: 'test-sandsurf',
    capabilities: Object.freeze(['environment-lifetime']),
    supportsPty: false
  });
  const adapters = [];
  const create = () => {
    const adapter = new SandsurfCommandExecution({
      sandbox,
      epoch: 3,
      configurationRevision: 4,
      state,
      resourceLeases: leases,
      descriptor,
      events,
      artifacts
    });
    adapters.push(adapter);
    return adapter;
  };
  const execution = create();
  t.after(async () => {
    for (const adapter of adapters) await adapter.close();
    await rm(root, { recursive: true, force: true });
  });
  const request = {
    command: 'work',
    rootedDirectory: '.',
    pty: false,
    lifetime: 'job',
    timeoutMs: 10_000,
    yieldMs: 0,
    outputTokenBudget: 1000,
    owner
  };
  return {
    execution,
    create,
    flags,
    state,
    artifacts,
    events,
    leases,
    request,
    owner,
    process,
    get dispatched() {
      return options;
    },
    async start(startOptions) {
      return execution.start(await execution.plan(request), startOptions);
    }
  };
}

test('subsequent tool calls in the same session can control processes; other sessions cannot', async (t) => {
  const fixture = await commandFixture(t, 'running');
  const process = await fixture.start();
  const later = { ...fixture.owner, runId: 'next-run', turnId: 'next-turn', callIndex: 9 };
  const result = await fixture.execution.query(process.processId, 100, 0, 0, later);
  assert.equal(result.status, 'running');
  await fixture.execution.writeInput(process.processId, 'input', later);
  await assert.rejects(
    fixture.execution.query(process.processId, 0, 0, 0, { ...later, ownerId: 'another-session' }),
    /another application owner/
  );
  assert.equal(fixture.dispatched.expectedEpoch, 3);
  assert.equal(fixture.dispatched.expectedRevision, 4);
  assert.equal(fixture.dispatched.user, 'agent');
});

test('committed outcomes and bounded logs remain readable after runtime evidence disappears', async (t) => {
  const fixture = await commandFixture(t);
  const terminal = await fixture.start();
  assert.equal(terminal.status, 'exited');
  fixture.flags.missing = true;
  fixture.flags.outputMissing = true;
  await fixture.execution.close();
  const restarted = fixture.create();
  const reconciliation = await restarted.reconcile();
  assert.deepEqual(reconciliation.unresolved, []);
  const result = await restarted.query(terminal.processId, 2, 0, 2, fixture.owner);
  assert.equal(result.status, 'exited');
  assert.equal(result.exitCode, 0);
  assert.equal(result.combined.text, 'complete');
  assert.equal(result.cursorStart, 2);
  assert.equal(result.cursorEnd, 10);
  assert.ok(result.combined.omittedBytes > 0);
  assert.equal((await restarted.listProcesses())[0].status, 'exited');
  const repeated = await restarted.start(await restarted.plan(fixture.request));
  assert.equal(repeated.status, 'exited');
  assert.equal(fixture.flags.spawnCount, 1);
});

test('acknowledgement failure cannot overturn a settlement and reconnect retries the handoff', async (t) => {
  const fixture = await commandFixture(t);
  fixture.flags.ackFails = true;
  const lease = await fixture.leases.acquire(
    {
      accesses: [{ mode: 'write', scope: 'files' }],
      lockScopes: ['files'],
      recovery: { kind: 'unknown' }
    },
    'run'
  );
  const result = await fixture.start({
    lease,
    onProgress() {
      throw new Error('subscriber failed');
    }
  });
  assert.equal(result.status, 'exited');
  assert.equal(fixture.leases.activeCount(), 0);
  const before = fixture.flags.acknowledgements;
  fixture.flags.ackFails = false;
  await fixture.execution.reconcile();
  assert.ok(fixture.flags.acknowledgements > before);
  assert.equal((await fixture.execution.query(result.processId, 0)).status, 'exited');
});

test('lost original logs are reported separately from a known exit outcome', async (t) => {
  const fixture = await commandFixture(t);
  fixture.flags.outputMissing = true;
  const result = await fixture.start();
  assert.equal(result.status, 'exited');
  assert.equal(result.exitCode, 0);
  assert.equal(result.originalOutput.kind, 'unavailable');
  assert.equal(fixture.flags.acknowledgements, 0);
  fixture.flags.missing = true;
  assert.deepEqual((await fixture.execution.reconcile()).unresolved, []);
});

test('ambiguous dispatch is never replayed and accepted unavailable observations survive restart', async (t) => {
  const fixture = await commandFixture(t, 'running');
  fixture.flags.spawnFails = true;
  await assert.rejects(fixture.start(), /dispatch delivery unknown/);
  const processId = fixture.dispatched.processId;
  fixture.flags.missing = true;
  assert.equal((await fixture.execution.reconcile()).unresolved.length, 1);
  const [unresolved] = await fixture.execution.listProcesses();
  await assert.rejects(
    fixture.execution.acknowledgeUnresolved([{ processId, revision: 'stale' }]),
    /evidence changed/
  );
  await fixture.execution.acknowledgeUnresolved([unresolved]);
  await fixture.execution.close();
  const restarted = fixture.create();
  assert.deepEqual((await restarted.reconcile()).unresolved, []);
  assert.equal((await restarted.listProcesses())[0].status, 'acknowledged-unknown');
  assert.equal(fixture.leases.activeCount(), 0);
  await assert.rejects(
    restarted.start(await restarted.plan(fixture.request)),
    /runtime unavailable/
  );
  assert.equal(fixture.flags.spawnCount, 1);
});

test('cancellation before dispatch does not persist an execution intent or spawn a command', async (t) => {
  const fixture = await commandFixture(t);
  await assert.rejects(
    fixture.start({ signal: AbortSignal.abort(new Error('cancelled')) }),
    /cancelled/
  );
  assert.equal(fixture.flags.spawnCount, 0);
  assert.deepEqual(await fixture.execution.listProcesses(), []);
});

test('stale guest epochs are rejected before an observation can become a command settlement', async (t) => {
  const fixture = await commandFixture(t);
  fixture.flags.epoch = 5;
  await assert.rejects(fixture.start(), /does not match/);
  assert.equal(fixture.flags.acknowledgements, 0);
});

test('workspace reads enforce byte bounds before collecting oversized originals and reject changed revisions', async () => {
  let calls = 0;
  const files = new SandsurfWorkspaceFiles(
    workspaceSandbox({
      async read(_path, offset, maximum) {
        calls++;
        assert.ok(maximum <= 64 * 1024);
        return {
          kind: 'read',
          range: {
            offset,
            bytes: [],
            eof: false,
            revision: { size: 100_000_000, digest: 'a'.repeat(64) }
          }
        };
      }
    }),
    1,
    1,
    true
  );
  await assert.rejects(files.readFile('huge', { maximumBytes: 10 }), /read limit/);
  assert.equal(calls, 1);
  const bytes = Buffer.from('actual bytes');
  const changed = new SandsurfWorkspaceFiles(
    workspaceSandbox({
      async read() {
        return {
          kind: 'read',
          range: {
            offset: 0,
            bytes: [...bytes],
            eof: true,
            revision: { size: bytes.length, digest: 'a'.repeat(64) }
          }
        };
      }
    }),
    1,
    1,
    true
  );
  await assert.rejects(changed.readFile('changed'), /do not match their revision/);
});

test('workspace authority rejects read-only mutations and a changed environment epoch', async () => {
  let calls = 0;
  const sandbox = workspaceSandbox({
    async transaction() {
      calls++;
    },
    async lstat() {
      return { kind: 'stat', value: { kind: 'directory', mode: 0o755 } };
    }
  });
  const files = new SandsurfWorkspaceFiles(sandbox, 1, 1, false);
  await assert.rejects(
    files.transaction([{ kind: 'remove', path: 'file', expected: { kind: 'any' } }]),
    /read-only/
  );
  assert.equal(calls, 0);
  sandbox.inspect = async () => ({
    configurationRevision: 1,
    machine: { kind: 'current', value: { epoch: 2 } }
  });
  await assert.rejects(files.stat('.'), /authority changed/);
});

test('terminal commands do not acquire input as a prerequisite for observing completion', async (t) => {
  const fixture = await commandFixture(t);
  const result = await fixture.execution.start(
    await fixture.execution.plan({ ...fixture.request, pty: true })
  );
  assert.equal(fixture.dispatched.stdio, 'terminal');
  assert.equal(result.status, 'exited');
  assert.equal(result.exitCode, 0);
});

test('session observers capture terminal settlement after the tool has returned running', async (t) => {
  const fixture = await commandFixture(t, 'running');
  const initial = await fixture.start();
  assert.equal(initial.status, 'running');
  fixture.flags.mode = 'exited';
  await t.waitFor(() => assert.equal(fixture.execution.recoveredTerminalReports().length, 1), {
    timeout: 5000
  });
  const [report] = fixture.execution.recoveredTerminalReports();
  assert.equal(report.result.processId, initial.processId);
  assert.equal(report.result.exitCode, 0);
  assert.equal(report.result.originalOutput.kind, 'captured');
  assert.equal(initial.status, 'running');
  assert.equal(fixture.flags.spawnCount, 1);
});

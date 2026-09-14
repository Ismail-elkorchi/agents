import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RootedFileAuthority, fileScope, processScope } from '@agent-core/tools-local';
import {
  adoptCommandExecution,
  createCommandExecutionReservation,
  ResourceLeaseCoordinator
} from '@agent-core/tools';
import { InMemoryEventRepository } from '@agent-core/persistence';
import {
  createConfiguredCheckTool,
  readConfiguredCheckResults,
  configuredCheckObservationSchema
} from '../dist/verification/configured-check-tool.js';
import {
  captureTestedState,
  checkApplicability,
  TESTED_STATE_LIMITS
} from '../dist/verification/tested-state.js';

const owner = {
  ownerId: 'session:test',
  runId: 'check-run',
  turnId: 'turn-1',
  toolBatchId: 'batch-1',
  callIndex: 0
};
const context = {
  invocation: owner,
  resourceOwnerId: owner.ownerId,
  lifetime: { own: async () => {} }
};
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'configured-check-state-'));
  const root = RootedFileAuthority.adopt(directory);
  t.after(async () => {
    root.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { root, directory };
}
function executor({ exitCode = 0, status = 'exited', incomplete = false, effect } = {}) {
  const calls = [];
  const output = {
    text: 'diagnostic',
    observedBytes: 10,
    capturedBytes: 10,
    omittedBytes: incomplete ? 5 : 0,
    startsAtOutputStart: !incomplete,
    endsAtOutputEnd: true
  };
  const authority = adoptCommandExecution({
    descriptor: Object.freeze({
      implementationId: 'test-command.v1',
      recoveryIdentity: 'test-store',
      capabilities: Object.freeze([]),
      supportsPty: false
    }),
    resourceLeases: new ResourceLeaseCoordinator(),
    async plan(request) {
      calls.push(['plan', request]);
      return createCommandExecutionReservation(
        { command: request.command, timeoutMs: request.timeoutMs },
        () => calls.push(['release'])
      );
    },
    async start(reservation) {
      calls.push(['start', reservation.authorization]);
      await effect?.();
      return {
        processId: 'process-1',
        owner,
        status,
        exitCode,
        cursorStart: 0,
        cursorEnd: 10,
        stdout: output,
        stderr: output,
        combined: output
      };
    },
    async query() {
      throw new Error('unexpected query');
    },
    async terminate() {
      throw new Error('unexpected terminate');
    },
    async writeInput() {},
    async closeInput() {},
    async disposeOwner() {
      return [];
    },
    recoveredTerminalReports() {
      return [];
    },
    async acknowledgeTerminalReport() {},
    async reconcile() {
      return { resolved: [], unresolved: [] };
    },
    async retryReconciliation() {
      return { resolved: [], unresolved: [] };
    },
    async acknowledgeUnresolved() {},
    async close() {}
  });
  return { authority, calls };
}
async function run(
  root,
  execution,
  check = {
    id: 'check',
    command: 'original',
    coverage: 'targeted',
    testedPaths: ['dirty.txt', 'untracked.txt']
  }
) {
  const tool = createConfiguredCheckTool({
    required: [check],
    advisory: [],
    commandExecution: execution.authority,
    root
  });
  const input = await tool.canonicalizeInput({ id: check.id }, context);
  const owned = [];
  const binding = await tool.bindExecution(input, {
    ...context,
    lifetime: { own: async (resource) => owned.push(resource) }
  });
  const observation = await binding.invoke(context);
  for (const resource of owned) await resource.release();
  return { tool, binding, observation, input };
}
function repository() {
  return new InMemoryEventRepository({ encode: (event) => event, decode: (event) => event });
}
async function record(events, observation) {
  return events.append(owner.runId, {
    type: 'tool.ended',
    toolName: 'run_check',
    ...owner,
    observation: {
      storage: 'inline',
      kind: observation.kind,
      summary: observation.summary ?? '',
      observation
    }
  });
}

for (const [processStatus, exitCode, status] of [
  ['exited', 0, 'passed'],
  ['exited', 7, 'failed'],
  ['exited', null, 'unknown'],
  ['timed_out', null, 'timed_out'],
  ['stopped', null, 'cancelled'],
  ['failed', null, 'execution_failed']
]) {
  test(`configured check records ${status} independently of truncated output`, { skip: process.platform !== 'linux' }, async (t) => {
    const { root } = await fixture(t);
    const execution = executor({ status: processStatus, exitCode, incomplete: true });
    const { observation } = await run(root, execution);
    assert.equal(observation.kind, 'result');
    assert.equal('ok' in observation, false);
    assert.equal(observation.output.status, status);
    assert.equal(observation.output.outputComplete, false);
    assert(configuredCheckObservationSchema.safeParse(observation.output).success);
  });
}

test('complete immutable definition and Sandbox planning are bound before invocation', { skip: process.platform !== 'linux' }, async (t) => {
  const { root } = await fixture(t);
  const execution = executor();
  const definition = {
    id: 'check',
    command: 'original',
    timeoutMs: 321,
    coverage: 'targeted',
    testedPaths: ['dirty.txt']
  };
  const tool = createConfiguredCheckTool({
    required: [definition],
    advisory: [],
    commandExecution: execution.authority,
    root
  });
  definition.command = 'changed';
  definition.timeoutMs = 999;
  definition.testedPaths.push('later.txt');
  const canonical = await tool.canonicalizeInput({ id: 'check' }, context);
  const resources = [];
  const binding = await tool.bindExecution(canonical, {
    ...context,
    lifetime: { own: async (resource) => resources.push(resource) }
  });
  assert.deepEqual(
    execution.calls.map(([name]) => name),
    ['plan']
  );
  assert.equal(binding.snapshot.command, 'original');
  assert.equal(binding.snapshot.timeoutMs, 321);
  assert.deepEqual(binding.snapshot.testedPaths, ['dirty.txt']);
  assert.equal(binding.snapshot.execution.command, 'original');
  const result = await binding.invoke(context);
  assert.equal(result.output.definition.command, 'original');
  assert.equal(result.output.executionIdentity.length, 64);
  assert.throws(() => {
    result.output.definition.testedPaths.push('mutated');
  }, TypeError);
  await resources[0].release();
  assert.deepEqual(
    execution.calls.map(([name]) => name),
    ['plan', 'start', 'release']
  );
});

test('check locks overlap patch files and a continuing command resource', { skip: process.platform !== 'linux' }, async (t) => {
  const { root } = await fixture(t);
  const execution = executor();
  const { tool, input } = await run(root, execution);
  const effects = await tool.deriveEffects(input, context);
  assert.deepEqual(effects.lockScopes, [fileScope(), processScope()]);
  const leases = execution.authority.resourceLeases;
  const patch = await leases.acquire(
    {
      accesses: [{ mode: 'write', scope: fileScope('dirty.txt') }],
      lockScopes: [fileScope('dirty.txt')],
      recovery: { kind: 'unknown' }
    },
    'patch'
  );
  assert.equal(leases.wouldWait(effects), true);
  await patch.release();
  const command = await leases.acquire(
    {
      accesses: [{ mode: 'execute', scope: processScope('continuing') }],
      lockScopes: [fileScope()],
      recovery: { kind: 'unknown' }
    },
    'command'
  );
  command.transferToResource('continuing', processScope('continuing'));
  assert.equal(leases.wouldWait(effects), true);
  leases.releaseResource('continuing');
  assert.equal(leases.wouldWait(effects), false);
});

test('historical definitions survive edit, config replacement and deletion; dirty/untracked changes become stale', { skip: process.platform !== 'linux' }, async (t) => {
  const { root, directory } = await fixture(t);
  await writeFile(path.join(directory, 'dirty.txt'), 'dirty');
  await writeFile(path.join(directory, 'untracked.txt'), 'untracked');
  const { observation } = await run(root, executor());
  const events = repository();
  const receipt = await record(events, observation);
  let report = await readConfiguredCheckResults(events, owner.runId, undefined, root);
  assert.equal(report.checks[0].status, 'passed');
  assert.equal(report.checks[0].applicability.status, 'unknown');
  assert.equal(report.checks[0].receipt.hash, receipt.hash);
  await writeFile(path.join(directory, 'untracked.txt'), 'changed outside agent');
  const configuration = {
    verification: {
      required: [],
      advisory: [{ id: 'check', command: 'replacement', coverage: 'full', timeoutMs: 4 }]
    }
  };
  report = await readConfiguredCheckResults(events, owner.runId, configuration, root);
  assert.equal(report.checks[0].definition.command, 'original');
  assert.equal(report.checks[0].definition.timeoutMs, 60000);
  assert.equal(report.checks[0].requirement, 'required');
  assert.equal(report.checks[0].coverage, 'targeted');
  assert.equal(report.checks[0].status, 'passed');
  assert.equal(report.checks[0].applicability.status, 'stale');
  assert.equal(report.checks[1].status, 'not_run');
  assert.equal(report.checks[1].definition.command, 'replacement');
  report = await readConfiguredCheckResults(events, owner.runId, undefined, root);
  assert.equal(report.checks.length, 1);
});

test('check-written inputs preserve the observed pass with stale applicability', { skip: process.platform !== 'linux' }, async (t) => {
  const { root, directory } = await fixture(t);
  await writeFile(path.join(directory, 'dirty.txt'), 'before');
  const { observation } = await run(
    root,
    executor({ effect: () => writeFile(path.join(directory, 'dirty.txt'), 'after') })
  );
  assert.equal(observation.output.status, 'passed');
  assert.equal(
    checkApplicability(observation.output.testedState.before, observation.output.testedState.after)
      .status,
    'stale'
  );
});

test('bounded capture never blocks checks or fabricates current applicability', { skip: process.platform !== 'linux' }, async (t) => {
  const { root, directory } = await fixture(t);
  await writeFile(path.join(directory, 'big.txt'), Buffer.alloc(TESTED_STATE_LIMITS.fileBytes + 1));
  await mkdir(path.join(directory, 'directory'));
  const snapshot = await captureTestedState(root, [
    'big.txt',
    'directory',
    ...Array.from({ length: 300 }, (_, i) => `missing-${i}`)
  ]);
  assert.equal(snapshot.completeness, 'partial');
  assert(snapshot.unobservedPaths > 0);
  assert(snapshot.observedBytes <= TESTED_STATE_LIMITS.totalBytes);
  assert(snapshot.operations <= TESTED_STATE_LIMITS.operations);
  assert(snapshot.files.length <= TESTED_STATE_LIMITS.files);
  const { observation } = await run(root, executor(), {
    id: 'check',
    command: 'opaque',
    coverage: 'full',
    testedPaths: ['big.txt']
  });
  assert.equal(observation.output.status, 'passed');
  assert.equal(observation.output.testedState.before.completeness, 'partial');
  assert.equal(checkApplicability(snapshot, snapshot).status, 'unknown');
  assert.equal((await captureTestedState(root, undefined)).completeness, 'undeclared');
});

test('bounded history refresh avoids full replay and admits appended checks incrementally', { skip: process.platform !== 'linux' }, async (t) => {
  const { root } = await fixture(t);
  const { observation } = await run(root, executor());
  const events = repository();
  for (let i = 0; i < 600; i++) await events.append(owner.runId, { type: 'unrelated', index: i });
  await record(events, observation);
  events.read = () => {
    throw new Error('full replay is forbidden');
  };
  const pages = [];
  const readRange = events.readRange.bind(events);
  events.readRange = async (...args) => {
    const page = await readRange(...args);
    pages.push(page);
    return page;
  };
  let report = await readConfiguredCheckResults(events, owner.runId, undefined, root);
  assert.equal(report.history.complete, false);
  assert.equal(report.checks.length, 0);
  report = await readConfiguredCheckResults(events, owner.runId, undefined, root);
  report = await readConfiguredCheckResults(events, owner.runId, undefined, root);
  assert.equal(report.history.complete, true);
  assert.equal(report.checks.length, 1);
  assert(pages.every((page) => page.scanned <= 256));
  const priorPages = pages.length;
  await readConfiguredCheckResults(events, owner.runId, undefined, root);
  assert.equal(pages.length, priorPages);
  await record(events, observation);
  report = await readConfiguredCheckResults(events, owner.runId, undefined, root);
  assert.equal(report.checks.length, 2);
  assert.equal(pages.at(-1).scanned, 1);
});

test('old configured-check shapes and contradictory outcomes are rejected without changing stored records', { skip: process.platform !== 'linux' }, async (t) => {
  const { root } = await fixture(t);
  const { observation } = await run(root, executor());
  assert.equal(
    configuredCheckObservationSchema.safeParse({ ...observation.output, status: 'failed' }).success,
    false
  );
  assert.equal(
    configuredCheckObservationSchema.safeParse({
      ...observation.output,
      definition: { ...observation.output.definition, command: 'substituted' }
    }).success,
    false
  );
  const events = repository();
  await record(events, { kind: 'result', output: { id: 'check', status: 'passed' } });
  await assert.rejects(
    readConfiguredCheckResults(events, owner.runId, undefined, root),
    /incompatible configured-check record/u
  );
  assert.equal((await events.tail(owner.runId)).sequence, 0);
});

test('an execution exception retains the admitted definition and unknown effect instead of a fake not_run', { skip: process.platform !== 'linux' }, async (t) => {
  const { root } = await fixture(t);
  const execution = executor({
    effect: () => {
      throw new Error('lost executor response after possible start');
    }
  });
  const { observation } = await run(root, execution);
  assert.equal(observation.execution.state, 'unknown');
  assert.equal(observation.output.status, 'unknown');
  assert.equal(observation.output.definition.command, 'original');
  assert.match(observation.output.diagnostic, /possible start/u);
  const events = repository();
  await record(events, observation);
  const report = await readConfiguredCheckResults(events, owner.runId, undefined, root);
  assert.equal(report.checks[0].status, 'unknown');
});

test('concurrent verification refresh does not duplicate committed observations', { skip: process.platform !== 'linux' }, async (t) => {
  const { root } = await fixture(t);
  const { observation } = await run(root, executor());
  const events = repository();
  await record(events, observation);
  const reports = await Promise.all(
    Array.from({ length: 3 }, () =>
      readConfiguredCheckResults(events, owner.runId, undefined, root)
    )
  );
  assert(reports.every((report) => report.checks.length === 1));
});

test('observed absence additions and total-byte bounds include actual dirty/untracked bytes', { skip: process.platform !== 'linux' }, async (t) => {
  const { root, directory } = await fixture(t);
  const paths = Array.from({ length: 5 }, (_, i) => `input-${i}.txt`);
  const absent = await captureTestedState(root, paths);
  for (const name of paths)
    await writeFile(path.join(directory, name), Buffer.alloc(TESTED_STATE_LIMITS.fileBytes, 97));
  const full = await captureTestedState(root, paths);
  assert.equal(full.observedBytes, TESTED_STATE_LIMITS.totalBytes);
  assert.equal(full.completeness, 'partial');
  assert.equal(full.files[4].state, 'unavailable');
  assert.equal(checkApplicability(absent, absent, full).status, 'stale');
});

test('the whole verification refresh shares bounded bytes and reuses identical tested scopes', { skip: process.platform !== 'linux' }, async (t) => {
  const { root, directory } = await fixture(t);
  const events = repository();
  const observations = [];
  for (let i = 0; i < 5; i++) {
    const name = `scope-${i}.txt`;
    await writeFile(path.join(directory, name), Buffer.alloc(TESTED_STATE_LIMITS.fileBytes, 97));
    const { observation } = await run(root, executor(), {
      id: `check-${i}`,
      command: 'true',
      coverage: 'targeted',
      testedPaths: [name]
    });
    observations.push(observation);
    await record(events, observation);
  }
  await record(events, observations[0]);
  let bytes = 0;
  let fileReads = 0;
  const observedRoot = new Proxy(root, {
    get(target, property) {
      if (property === 'openFile')
        return async (...args) => {
          fileReads += 1;
          const file = await target.openFile(...args);
          return {
            ...file,
            read: async (...readArgs) => {
              const count = await file.read(...readArgs);
              bytes += count;
              return count;
            }
          };
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const report = await readConfiguredCheckResults(events, owner.runId, undefined, observedRoot);
  assert.equal(report.checks.length, 6);
  assert.equal(bytes, TESTED_STATE_LIMITS.totalBytes);
  assert.equal(fileReads, 4);
  assert.equal(report.checks[4].applicability.status, 'unknown');
  assert(report.checks[4].applicability.reasons.includes('tested_scope_not_fully_observed'));
  assert.deepEqual(report.checks[5].applicability, report.checks[0].applicability);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryEventRepository } from '@agent-core/evidence';
import { agentEventCodec } from '@agent-core/runtime';
import { ResourceLeaseCoordinator, adoptCommandExecution, createCommandExecutionPreparation } from '@agent-core/tools';
import { RootedFileAuthority, captureWorkspaceSnapshot, changedWorkspacePaths, materializeWorkspaceSnapshot } from '@agent-core/tools-local';
import { deriveAdmittedCheckPlan, createAuthoritativeChecks, verifierDefinitionPaths } from '../dist/verification/configured-checks.js';
import { loadOrCaptureRunWorkspaceBaseline } from '../dist/changes/workspace-baseline-store.js';
import { PrivateStateDirectory } from '../dist/state/private-state.js';
import { DEFAULT_CODING_CONTRACT } from '../dist/instructions/coding-contract.js';

test('the coding contract requires clarification before ambiguous mutation', () => {
  assert.match(DEFAULT_CODING_CONTRACT.content, /Ask for clarification.*target.*blast radius/iu);
  assert.match(DEFAULT_CODING_CONTRACT.content, /understand, inspect, plan locally, mutate, inspect the exact change, verify, revise.*explain/iu);
  assert.match(DEFAULT_CODING_CONTRACT.content, /Machine-derived change and verification facts override model prose/iu);
});

test('verification snapshots bind exact root content and classify verifier definitions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'coding-agent-verification-'));
  await mkdir(path.join(directory, 'src'));
  await mkdir(path.join(directory, 'test'));
  await writeFile(path.join(directory, 'src', 'index.js'), 'export const value = 1;\n');
  await writeFile(path.join(directory, 'test', 'index.test.js'), 'assert(value === 1);\n');
  const root = RootedFileAuthority.adopt(directory);
  try {
    const baseline = await captureWorkspaceSnapshot(root);
    await writeFile(path.join(directory, 'src', 'index.js'), 'export const value = 2;\n');
    await writeFile(path.join(directory, 'test', 'index.test.js'), 'assert(value === 2);\n');
    const candidate = await captureWorkspaceSnapshot(root);
    const changes = changedWorkspacePaths(baseline, candidate);
    assert.deepEqual(changes, ['src/index.js', 'test/index.test.js']);
    assert.deepEqual(verifierDefinitionPaths(changes), ['test/index.test.js']);
  } finally { root.close(); await rm(directory, { recursive: true, force: true }); }
});

test('verification definition classification covers commands, compilers, dependencies, CI, and tests', () => {
  const paths = ['coding-agent.config.json', '.github/workflows/verify.yml', 'package.json', 'package-lock.json', 'tsconfig.build.json', 'vitest.config.ts', 'tests/behavior.js', 'src/behavior.spec.ts', 'src/implementation.ts'];
  assert.deepEqual(verifierDefinitionPaths(paths), paths.slice(0, -1));
});

test('one run keeps its original verification baseline across process restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'coding-agent-baseline-'));
  const stateDirectory = await mkdtemp(path.join(tmpdir(), 'coding-agent-baseline-state-'));
  await writeFile(path.join(directory, 'source.js'), 'before\n');
  const root = RootedFileAuthority.adopt(directory);
  const state = await PrivateStateDirectory.create(stateDirectory);
  const observeVersionControl = async () => Object.freeze({ kind: 'none' });
  try {
    const first = await loadOrCaptureRunWorkspaceBaseline({ state, root, runId: 'run-one', resuming: false, observeVersionControl });
    await writeFile(path.join(directory, 'source.js'), 'after\n');
    const resumed = await loadOrCaptureRunWorkspaceBaseline({ state, root, runId: 'run-one', resuming: true, observeVersionControl });
    assert.equal(resumed.workspace.digest, first.workspace.digest);
    await assert.rejects(loadOrCaptureRunWorkspaceBaseline({ state, root, runId: 'missing-run', resuming: true, observeVersionControl }), /baseline.*missing/iu);
  } finally { root.close(); await rm(directory, { recursive: true, force: true }); await rm(stateDirectory, { recursive: true, force: true }); }
});

test('run baseline capture rejects a changing version-control observation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'coding-agent-baseline-race-'));
  const stateDirectory = await mkdtemp(path.join(tmpdir(), 'coding-agent-baseline-race-state-'));
  await writeFile(path.join(directory, 'source.js'), 'content\n');
  const root = RootedFileAuthority.adopt(directory);
  const state = await PrivateStateDirectory.create(stateDirectory);
  let calls = 0;
  try {
    await assert.rejects(loadOrCaptureRunWorkspaceBaseline({
      state, root, runId: 'racing-run', resuming: false,
      observeVersionControl: async () => calls++ === 0 ? { kind: 'none' } : { kind: 'unavailable', reason: 'changed' }
    }), /changed while.*baseline/iu);
  } finally { root.close(); await rm(directory, { recursive: true, force: true }); await rm(stateDirectory, { recursive: true, force: true }); }
});

test('admitted plans freeze explicit and inferred checks and expose missing required coverage', () => {
  const plan = deriveAdmittedCheckPlan(configuration('node test/source.test.js'), ['npm test', 'node test/source.test.js']);
  assert.equal(plan.requiredCoverage, 'admitted');
  assert.deepEqual(plan.checks.map((check) => [check.command, check.requirement, check.origin]), [
    ['node test/source.test.js', 'required', 'project'],
    ['npm test', 'required', 'inferred']
  ]);
  const missing = deriveAdmittedCheckPlan(undefined, []);
  assert.equal(missing.requiredCoverage, 'missing');
  assert.deepEqual(missing.checks, []);
});

test('authoritative checks reject changed or self-mutating verification definitions', async () => {
  const fixture = await verificationFixture();
  try {
    await writeFile(path.join(fixture.candidateDirectory, 'test', 'source.test.js'), 'assert(true);\n');
    let calls = 0;
    const checks = createChecks(fixture, async () => commandAuthority(async () => { calls += 1; return commandResult(); }));
    const admittedBaseline = await settleCheck(checks[0]);
    await appendCheck(fixture.events, checks[0], admittedBaseline);
    const changed = await checks[1].prepare(context());
    assert.equal(changed.verdict, 'unknown');
    assert.equal(changed.output.classification, 'verifier_definition_changed');
    assert.equal(calls, 1);

    await writeFile(path.join(fixture.candidateDirectory, 'test', 'source.test.js'), 'assert(value === 1);\n');
    const selfMutating = createChecks(fixture, async ({ root }) => commandAuthority(async () => {
      await writeFile(path.join(root.identity.canonicalPath, 'test', 'source.test.js'), 'assert(true);\n');
      return commandResult();
    }));
    const candidate = await settleCheck(selfMutating[1]);
    assert.equal(candidate.verdict, 'unknown');
    assert.equal(candidate.output.classification, 'verifier_self_modified');
  } finally { await fixture.close(); }
});

test('baseline and candidate outcomes distinguish regressions from pre-existing failures and repairs', async () => {
  for (const scenario of [
    { baseline: commandResult(), candidate: commandResult({ exitCode: 1, stderr: 'new failure' }), verdict: 'failed', classification: 'candidate_regression' },
    { baseline: commandResult({ exitCode: 1, stderr: 'same failure' }), candidate: commandResult({ exitCode: 1, stderr: 'same failure' }), verdict: 'passed', classification: 'pre_existing_failure' },
    { baseline: commandResult({ exitCode: 1, stderr: 'partial failure', stderrOmittedBytes: 10 }), candidate: commandResult({ exitCode: 1, stderr: 'partial failure' }), verdict: 'unknown', classification: 'failure_comparison_incomplete' },
    { baseline: commandResult({ exitCode: 1, stderr: 'old failure' }), candidate: commandResult(), verdict: 'passed', classification: 'pre_existing_failure_repaired' }
  ]) {
    const fixture = await verificationFixture();
    let invocation = 0;
    try {
      const outcomes = [scenario.baseline, scenario.candidate];
      const checks = createChecks(fixture, async () => commandAuthority(async () => outcomes[invocation++]));
      const baseline = await settleCheck(checks[0]);
      await appendCheck(fixture.events, checks[0], baseline);
      const candidate = await settleCheck(checks[1]);
      assert.equal(candidate.verdict, scenario.verdict);
      assert.equal(candidate.output.classification, scenario.classification);
    } finally { await fixture.close(); }
  }
});

test('workspace aliases make verification coverage explicitly partial', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'coding-agent-oracle-alias-'));
  await writeFile(path.join(directory, 'source.js'), 'content\n');
  await symlink('source.js', path.join(directory, 'alias.js'));
  const root = RootedFileAuthority.adopt(directory);
  try { const snapshot = await captureWorkspaceSnapshot(root); assert.equal(snapshot.coverage, 'partial'); assert.deepEqual(snapshot.causes, ['symbolic_link']); }
  finally { root.close(); await rm(directory, { recursive: true, force: true }); }
});

async function verificationFixture() {
  const parent = await mkdtemp(path.join(tmpdir(), 'coding-agent-checks-'));
  const sourceDirectory = path.join(parent, 'source');
  const candidateDirectory = path.join(parent, 'candidate');
  await mkdir(path.join(sourceDirectory, 'test'), { recursive: true });
  await writeFile(path.join(sourceDirectory, 'source.js'), 'export const value = 1;\n');
  await writeFile(path.join(sourceDirectory, 'test', 'source.test.js'), 'assert(value === 1);\n');
  const sourceRoot = RootedFileAuthority.adopt(sourceDirectory);
  const baseline = await captureWorkspaceSnapshot(sourceRoot);
  await materializeWorkspaceSnapshot(sourceRoot, baseline, candidateDirectory);
  const candidateRoot = RootedFileAuthority.adopt(candidateDirectory);
  const events = new InMemoryEventRepository(agentEventCodec);
  return {
    parent, candidateDirectory, sourceRoot, candidateRoot, baseline, events,
    async close() { candidateRoot.close(); sourceRoot.close(); await rm(parent, { recursive: true, force: true }); }
  };
}

function createChecks(fixture, createCommandExecution) {
  return createAuthoritativeChecks({
    plan: deriveAdmittedCheckPlan(configuration('node test/source.test.js'), []), sourceRoot: fixture.sourceRoot, candidateRoot: fixture.candidateRoot,
    baseline: fixture.baseline, runtimeDirectory: path.join(fixture.parent, 'runtime'), events: fixture.events, createCommandExecution, commandYieldMs: 0
  });
}

async function settleCheck(check) {
  const prepared = await check.prepare(context());
  if (typeof prepared.start !== 'function') return prepared;
  try { return await prepared.start(context().signal); }
  finally { await prepared.release(); }
}

async function appendCheck(events, check, observation) {
  await events.append('run-verification', {
    type: 'check.ended', turnIndex: 1, turnId: 'turn-1', requestAttempt: 1, check: check.id,
    result: { id: check.id, implementationId: check.implementationId, requirement: check.requirement, verdict: observation.verdict, summary: observation.summary, durationMs: 1, ...(observation.output === undefined ? {} : { output: observation.output }), ...(observation.diagnostic === undefined ? {} : { diagnostic: observation.diagnostic }) }
  });
}

function configuration(command) {
  return {
    version: 1, provider: 'openai', model: 'gpt-5.6-sol', instructions: [], tools: { enabled: [] }, permissions: { maximumMode: 'develop', requireApprovalFor: [] },
    verification: { required: [{ id: 'tests', command, coverage: 'full' }], advisory: [] }
  };
}

function context() {
  return {
    runId: 'run-verification', task: 'verify', instructions: [], candidate: { status: 'complete', message: 'done', source: 'content', turnIndex: 1 },
    turnIndex: 1, turnId: 'turn-1', requestAttempt: 1, metadata: {}, signal: new AbortController().signal,
    execution: { evidence: { read: async () => ({ items: [], bytes: 0, truncated: false }), readArtifact: async () => new Uint8Array() } }
  };
}

function commandResult(options = {}) {
  const output = (text = '', omittedBytes = 0) => ({ text, observedBytes: Buffer.byteLength(text) + omittedBytes, capturedBytes: Buffer.byteLength(text), omittedBytes, startsAtOutputStart: omittedBytes === 0, endsAtOutputEnd: true });
  const status = options.status ?? 'exited';
  return {
    processId: 'process-verification', owner: { runId: 'run-verification', turnId: 'turn-1', toolBatchId: 'verification', callIndex: 0 }, status, cursorStart: 0, cursorEnd: 0,
    stdout: output(options.stdout, options.stdoutOmittedBytes), stderr: output(options.stderr, options.stderrOmittedBytes), combined: output(`${options.stdout ?? ''}${options.stderr ?? ''}`, (options.stdoutOmittedBytes ?? 0) + (options.stderrOmittedBytes ?? 0)),
    ...(status === 'exited' ? { exitCode: options.exitCode ?? 0, signal: null } : {})
  };
}

function commandAuthority(execute) {
  const authority = {
    descriptor: Object.freeze({ implementationId: 'test.command@1', recoveryIdentity: 'test-recovery', capabilities: Object.freeze(['test']), supportsPty: false }),
    resourceLeases: new ResourceLeaseCoordinator(), prepare: async () => createCommandExecutionPreparation({ executionId: 'process-verification', expiresAt: '2099-01-01T00:00:00.000Z' }, () => undefined),
    start: async () => execute(), query: async () => execute(), writeInput: async () => undefined, closeInput: async () => undefined, terminate: async () => execute(),
    disposeRun: async () => [], recoveredTerminalReports: () => [], acknowledgeTerminalReport: async () => undefined, reconcile: async () => ({ resolved: [], unresolved: [] }),
    retryReconciliation: async () => ({ resolved: [], unresolved: [] }), acknowledgeUnresolved: async () => undefined, close: async () => undefined,
    executionId: () => 'process-verification', reconcileExecution: async () => ({ status: 'settled', result: await execute() })
  };
  adoptCommandExecution(authority);
  return authority;
}

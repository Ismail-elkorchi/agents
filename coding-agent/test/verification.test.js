import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ResourceLeaseCoordinator, adoptCommandExecution, createCommandExecutionReservation } from '@agent-core/tools';
import { RootedFileAuthority, captureWorkspaceSnapshot, changedWorkspacePaths } from '@agent-core/tools-local';
import { restoreWorkspaceSnapshot } from '../dist/changes/isolated-working-copy.js';
import { createCandidateAcceptanceChecks, deriveAdmittedCheckPlan, observePreChangeCommands, verifierDefinitionPaths } from '../dist/verification/candidate-acceptance-checks.js';
import { loadOrAdmitCheckPlan } from '../dist/verification/check-plan-store.js';
import { loadOrCapturePreChangeSnapshot } from '../dist/changes/pre-change-snapshot-store.js';
import { PrivateStateDirectory } from '../dist/state/private-state.js';
import { DEFAULT_CODING_CONTRACT } from '../dist/instructions/coding-contract.js';

test('the coding contract requires clarification before ambiguous mutation', () => {
  assert.match(DEFAULT_CODING_CONTRACT.content, /Ask for clarification.*target.*blast radius/iu);
  assert.match(DEFAULT_CODING_CONTRACT.content, /understand, inspect, plan locally, mutate, inspect the exact change, verify, revise.*explain/iu);
  assert.match(DEFAULT_CODING_CONTRACT.content, /Machine-derived change and verification facts override model prose/iu);
});

test('pre-change snapshots bind exact root content and classify verifier definitions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'coding-agent-verification-'));
  await mkdir(path.join(directory, 'src'));
  await mkdir(path.join(directory, 'test'));
  await writeFile(path.join(directory, 'src', 'index.js'), 'export const value = 1;\n');
  await writeFile(path.join(directory, 'test', 'index.test.js'), 'assert(value === 1);\n');
  const root = RootedFileAuthority.adopt(directory);
  try {
    const preChange = await captureWorkspaceSnapshot(root);
    await writeFile(path.join(directory, 'src', 'index.js'), 'export const value = 2;\n');
    await writeFile(path.join(directory, 'test', 'index.test.js'), 'assert(value === 2);\n');
    const workingCopy = await captureWorkspaceSnapshot(root);
    const changes = changedWorkspacePaths(preChange, workingCopy);
    assert.deepEqual(changes, ['src/index.js', 'test/index.test.js']);
    assert.deepEqual(verifierDefinitionPaths(changes), ['test/index.test.js']);
  } finally { root.close(); await rm(directory, { recursive: true, force: true }); }
});

test('verification definition classification covers commands, compilers, dependencies, CI, and tests', () => {
  const paths = ['coding-agent.config.json', '.github/workflows/verify.yml', 'package.json', 'package-lock.json', 'tsconfig.build.json', 'vitest.config.ts', 'tests/behavior.js', 'src/behavior.spec.ts', 'src/implementation.ts'];
  assert.deepEqual(verifierDefinitionPaths(paths), paths.slice(0, -1));
});

test('one run keeps its original pre-change snapshot across process restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'coding-agent-baseline-'));
  const stateDirectory = await mkdtemp(path.join(tmpdir(), 'coding-agent-baseline-state-'));
  await writeFile(path.join(directory, 'source.js'), 'before\n');
  const root = RootedFileAuthority.adopt(directory);
  const state = await PrivateStateDirectory.create(stateDirectory);
  const observeVersionControl = async () => Object.freeze({ kind: 'none' });
  try {
    const first = await loadOrCapturePreChangeSnapshot({ state, root, runId: 'run-one', resuming: false, observeVersionControl });
    await writeFile(path.join(directory, 'source.js'), 'after\n');
    const resumed = await loadOrCapturePreChangeSnapshot({ state, root, runId: 'run-one', resuming: true, observeVersionControl });
    assert.equal(resumed.workspace.digest, first.workspace.digest);
    await assert.rejects(loadOrCapturePreChangeSnapshot({ state, root, runId: 'missing-run', resuming: true, observeVersionControl }), /pre-change.*missing/iu);
  } finally { root.close(); await rm(directory, { recursive: true, force: true }); await rm(stateDirectory, { recursive: true, force: true }); }
});

test('pre-change capture rejects a changing version-control observation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'coding-agent-baseline-race-'));
  const stateDirectory = await mkdtemp(path.join(tmpdir(), 'coding-agent-baseline-race-state-'));
  await writeFile(path.join(directory, 'source.js'), 'content\n');
  const root = RootedFileAuthority.adopt(directory);
  const state = await PrivateStateDirectory.create(stateDirectory);
  let calls = 0;
  try {
    await assert.rejects(loadOrCapturePreChangeSnapshot({
      state, root, runId: 'racing-run', resuming: false,
      observeVersionControl: async () => calls++ === 0 ? { kind: 'none' } : { kind: 'unavailable', reason: 'changed' }
    }), /changed while.*pre-change/iu);
  } finally { root.close(); await rm(directory, { recursive: true, force: true }); await rm(stateDirectory, { recursive: true, force: true }); }
});

test('admitted plans freeze explicit and inferred checks and expose missing required coverage', () => {
  const plan = deriveAdmittedCheckPlan([
    checkCandidate('node test/source.test.js', 'required', 'active-project-config', 'tests'),
    checkCandidate('npm test', 'required', 'manifest-inference', 'package.json#scripts.test'),
    checkCandidate('node test/source.test.js', 'required', 'manifest-inference', 'package.json#scripts.test')
  ]);
  assert.equal(plan.requiredCoverage, 'admitted');
  assert.deepEqual(plan.checks.map((check) => [check.command, check.requirement, check.source, check.sourceId]), [
    ['node test/source.test.js', 'required', 'active-project-config', 'tests'],
    ['npm test', 'required', 'manifest-inference', 'package.json#scripts.test']
  ]);
  const missing = deriveAdmittedCheckPlan([]);
  assert.equal(missing.requiredCoverage, 'missing');
  assert.deepEqual(missing.checks, []);
});

test('admitted check recovery preserves source and requirement without reconstructing them from commands', async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), 'coding-agent-check-plan-'));
  const state = await PrivateStateDirectory.create(stateDirectory);
  const proposed = deriveAdmittedCheckPlan([
    checkCandidate('node advisory.js', 'advisory', 'active-project-config', 'project-advisory'),
    checkCandidate('npm test', 'required', 'manifest-inference', 'package.json#scripts.test')
  ]);
  try {
    await loadOrAdmitCheckPlan({ state, runId: 'run-check-origin', resuming: false, proposed });
    const recovered = await loadOrAdmitCheckPlan({ state, runId: 'run-check-origin', resuming: true, proposed: deriveAdmittedCheckPlan([]) });
    assert.deepEqual(recovered, proposed);
    assert.deepEqual(recovered.checks.map((check) => [check.requirement, check.source, check.sourceId]), [
      ['advisory', 'active-project-config', 'project-advisory'],
      ['required', 'manifest-inference', 'package.json#scripts.test']
    ]);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('authoritative checks reject changed or self-mutating verification definitions', async () => {
  const fixture = await verificationFixture();
  try {
    await writeFile(path.join(fixture.candidateDirectory, 'test', 'source.test.js'), 'assert(true);\n');
    let calls = 0;
    const checks = await createChecks(fixture, async () => commandAuthority(async () => { calls += 1; return commandResult(); }));
    const changed = await checks[0].planEffect(context());
    assert.equal(changed.verdict, 'unknown');
    assert.equal(changed.output.classification, 'verifier_definition_changed');
    assert.equal(calls, 1);

    await writeFile(path.join(fixture.candidateDirectory, 'test', 'source.test.js'), 'assert(value === 1);\n');
    let executions = 0;
    const selfMutating = await createChecks(fixture, async ({ root }) => commandAuthority(async () => {
      if (executions++ > 0) {
        await writeFile(path.join(root.identity.canonicalPath, 'test', 'source.test.js'), 'assert(true);\n');
      }
      return commandResult();
    }));
    const workingCopyResult = await settleCheck(selfMutating[0]);
    assert.equal(workingCopyResult.verdict, 'unknown');
    assert.equal(workingCopyResult.output.classification, 'verifier_self_modified');
  } finally { await fixture.close(); }
});

test('pre-change and working-copy outcomes distinguish regressions from pre-existing failures and repairs', async () => {
  for (const scenario of [
    { baseline: commandResult(), modelOutput: commandResult({ exitCode: 1, stderr: 'new failure' }), verdict: 'failed', classification: 'working_copy_regression' },
    { baseline: commandResult({ exitCode: 1, stderr: 'same failure' }), modelOutput: commandResult({ exitCode: 1, stderr: 'same failure' }), verdict: 'passed', classification: 'pre_existing_failure' },
    { baseline: commandResult({ exitCode: 1, stderr: 'partial failure', stderrOmittedBytes: 10 }), modelOutput: commandResult({ exitCode: 1, stderr: 'partial failure' }), verdict: 'unknown', classification: 'failure_comparison_incomplete' },
    { baseline: commandResult({ exitCode: 1, stderr: 'old failure' }), modelOutput: commandResult(), verdict: 'passed', classification: 'pre_existing_failure_repaired' }
  ]) {
    const fixture = await verificationFixture();
    let invocation = 0;
    try {
      const outcomes = [scenario.baseline, scenario.modelOutput];
      const checks = await createChecks(fixture, async () => commandAuthority(async () => outcomes[invocation++]));
      const workingCopyResult = await settleCheck(checks[0]);
      assert.equal(workingCopyResult.verdict, scenario.verdict);
      assert.equal(workingCopyResult.output.classification, scenario.classification);
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
  const workingCopyDirectory = path.join(parent, 'working-copy');
  await mkdir(path.join(sourceDirectory, 'test'), { recursive: true });
  await writeFile(path.join(sourceDirectory, 'source.js'), 'export const value = 1;\n');
  await writeFile(path.join(sourceDirectory, 'test', 'source.test.js'), 'assert(value === 1);\n');
  const sourceRoot = RootedFileAuthority.adopt(sourceDirectory);
  const preChange = await captureWorkspaceSnapshot(sourceRoot);
  await restoreWorkspaceSnapshot(sourceRoot, preChange, workingCopyDirectory);
  const workingCopyRoot = RootedFileAuthority.adopt(workingCopyDirectory);
  return {
    parent, candidateDirectory: workingCopyDirectory, sourceRoot, workingCopyRoot, preChange,
    async close() { workingCopyRoot.close(); sourceRoot.close(); await rm(parent, { recursive: true, force: true }); }
  };
}

async function createChecks(fixture, createCommandExecution) {
  const plan = deriveAdmittedCheckPlan([checkCandidate('node test/source.test.js', 'required', 'active-project-config', 'tests')]);
  const common = { plan, runId: 'run-verification', runtimeDirectory: path.join(fixture.parent, 'runtime'), createCommandExecution, commandYieldMs: 0 };
  const preChangeObservations = await observePreChangeCommands({ ...common, root: fixture.sourceRoot, snapshot: fixture.preChange });
  return createCandidateAcceptanceChecks({ ...common, root: fixture.workingCopyRoot, preChange: fixture.preChange, preChangeObservations });
}

async function settleCheck(check) {
  const plan = await check.planEffect(context());
  if (typeof plan.start !== 'function') return plan;
  try { return await plan.start(context().signal); }
  finally { await plan.release(); }
}

function checkCandidate(command, requirement, source, sourceId) {
  return { id: source === 'active-project-config' ? sourceId : `inferred-${sourceId}`, command, coverage: 'full', requirement, source, sourceId, timeoutMs: 120_000, maxOutputBytes: 128_000 };
}

function context() {
  return {
    runId: 'run-verification', task: 'verify', instructions: [], modelOutput: { status: 'complete', message: 'done', source: 'content', turnIndex: 1 },
    turnIndex: 1, turnId: 'turn-1', requestAttempt: 1, metadata: {}, signal: new AbortController().signal,
    execution: { observedFacts: { read: async () => ({ items: [], bytes: 0, truncated: false }), readArtifact: async () => new Uint8Array() } }
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
    resourceLeases: new ResourceLeaseCoordinator(), plan: async () => createCommandExecutionReservation({ executionId: 'process-verification', expiresAt: '2099-01-01T00:00:00.000Z' }, () => undefined),
    start: async () => execute(), query: async () => execute(), writeInput: async () => undefined, closeInput: async () => undefined, terminate: async () => execute(),
    disposeRun: async () => [], recoveredTerminalReports: () => [], acknowledgeTerminalReport: async () => undefined, reconcile: async () => ({ resolved: [], unresolved: [] }),
    retryReconciliation: async () => ({ resolved: [], unresolved: [] }), acknowledgeUnresolved: async () => undefined, close: async () => undefined,
    executionId: () => 'process-verification', reconcileExecution: async () => ({ status: 'settled', result: await execute() })
  };
  adoptCommandExecution(authority);
  return authority;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceFileRoot } from '@agent-core/tools-local';
import { ResourceLeaseCoordinator, adoptCommandExecution, createCommandExecutionPreparation } from '@agent-core/tools';
import { configuredCheckProposals, createConfiguredChecks } from '../dist/verification/configured-checks.js';
import { loadOrCaptureRunWorkspaceBaseline } from '../dist/changes/workspace-baseline-store.js';
import { captureWorkspaceSnapshot, changedWorkspacePaths, verifierDefinitionPaths } from '../dist/verification/workspace-snapshot.js';
import { PrivateStateDirectory } from '../dist/state/private-state.js';
import { DEFAULT_CODING_CONTRACT } from '../dist/instructions/coding-contract.js';

test('the coding contract requires clarification before ambiguous mutation', () => {
  assert.match(DEFAULT_CODING_CONTRACT.content, /Ask for clarification.*target.*blast radius/iu);
});

test('verification snapshots bind exact root content and classify verifier definitions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'coding-agent-verification-'));
  await mkdir(path.join(directory, 'src'));
  await mkdir(path.join(directory, 'test'));
  await writeFile(path.join(directory, 'src', 'index.js'), 'export const value = 1;\n');
  await writeFile(path.join(directory, 'test', 'index.test.js'), 'assert(value === 1);\n');
  const root = WorkspaceFileRoot.adopt(directory);
  try {
    const baseline = await captureWorkspaceSnapshot(root);
    assert.equal(baseline.coverage, 'complete');
    assert.equal(baseline.entries.find((entry) => entry.path === 'src/index.js').content, 'text');
    await writeFile(path.join(directory, 'src', 'index.js'), 'export const value = 2;\n');
    await writeFile(path.join(directory, 'test', 'index.test.js'), 'assert(value === 2);\n');
    const candidate = await captureWorkspaceSnapshot(root);
    assert.notEqual(candidate.digest, baseline.digest);
    const changes = changedWorkspacePaths(baseline, candidate);
    assert.deepEqual(changes, ['src/index.js', 'test/index.test.js']);
    assert.deepEqual(verifierDefinitionPaths(changes), ['test/index.test.js']);
  } finally {
    root.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('verification definition classification covers commands, compilers, dependencies, CI, and tests', () => {
  const paths = [
    '.github/workflows/verify.yml',
    'package.json',
    'package-lock.json',
    'tsconfig.build.json',
    'vitest.config.ts',
    'tests/behavior.js',
    'src/behavior.spec.ts',
    'src/implementation.ts'
  ];
  assert.deepEqual(verifierDefinitionPaths(paths), paths.slice(0, -1));
});

test('one run keeps its original verification baseline across process restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'coding-agent-baseline-'));
  const stateDirectory = await mkdtemp(path.join(tmpdir(), 'coding-agent-baseline-state-'));
  await writeFile(path.join(directory, 'source.js'), 'before\n');
  const root = WorkspaceFileRoot.adopt(directory);
  const state = await PrivateStateDirectory.create(stateDirectory);
  const observeVersionControl = async () => Object.freeze({ kind: 'none' });
  try {
    const first = await loadOrCaptureRunWorkspaceBaseline({ state, root, runId: 'run-one', resuming: false, observeVersionControl });
    await writeFile(path.join(directory, 'source.js'), 'after\n');
    const resumed = await loadOrCaptureRunWorkspaceBaseline({ state, root, runId: 'run-one', resuming: true, observeVersionControl });
    assert.equal(resumed.workspace.digest, first.workspace.digest);
    assert.deepEqual(resumed.workspace.entries, first.workspace.entries);
    await assert.rejects(
      loadOrCaptureRunWorkspaceBaseline({ state, root, runId: 'missing-run', resuming: true, observeVersionControl }),
      /baseline.*missing/iu
    );
  } finally {
    root.close();
    await rm(directory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('run baseline capture rejects a changing version-control observation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'coding-agent-baseline-race-'));
  const stateDirectory = await mkdtemp(path.join(tmpdir(), 'coding-agent-baseline-race-state-'));
  await writeFile(path.join(directory, 'source.js'), 'content\n');
  const root = WorkspaceFileRoot.adopt(directory);
  const state = await PrivateStateDirectory.create(stateDirectory);
  let calls = 0;
  try {
    await assert.rejects(
      loadOrCaptureRunWorkspaceBaseline({
        state,
        root,
        runId: 'racing-run',
        resuming: false,
        observeVersionControl: async () => calls++ === 0 ? { kind: 'none' } : { kind: 'unavailable', reason: 'changed' }
      }),
      /changed while.*baseline/iu
    );
  } finally {
    root.close();
    await rm(directory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('configured checks reject changed or mutating verification oracles', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'coding-agent-oracle-'));
  const runtimeDirectory = await mkdtemp(path.join(tmpdir(), 'coding-agent-oracle-runtime-'));
  await mkdir(path.join(directory, 'test'));
  await writeFile(path.join(directory, 'source.js'), 'export const value = 1;\n');
  await writeFile(path.join(directory, 'test', 'source.test.js'), 'assert(value === 1);\n');
  const root = WorkspaceFileRoot.adopt(directory);
  try {
    const baseline = await captureWorkspaceSnapshot(root);
    const proposals = configuredCheckProposals(configuration('node test/source.test.js'));
    let calls = 0;
    const [check] = createConfiguredChecks({ proposals, root, baseline, runtimeDirectory, createCommandExecution: async () => commandAuthority(async () => { calls += 1; return commandResult(); }), commandYieldMs: 0 });
    assert.ok(check.implementationId.startsWith('coding-agent.command-check.v1:'));
    await writeFile(path.join(directory, 'test', 'source.test.js'), 'assert(true);\n');
    const changed = await check.prepare(context());
    assert.equal(changed.verdict, 'unknown');
    assert.equal(changed.output.classification, 'verifier_definition_changed');
    assert.equal(calls, 0);

    await writeFile(path.join(directory, 'test', 'source.test.js'), 'assert(value === 1);\n');
    let mutatingCalls = 0;
    const [mutatingCheck] = createConfiguredChecks({
      proposals,
      root,
      baseline,
      runtimeDirectory,
      createCommandExecution: async ({ root: verifierRoot }) => commandAuthority(async () => {
        mutatingCalls += 1;
        await writeFile(path.join(verifierRoot.identity.canonicalPath, 'generated.txt'), 'side effect\n');
        return commandResult();
      }),
      commandYieldMs: 0
    });
    const prepared = await mutatingCheck.prepare(context());
    assert.equal(typeof prepared.start, 'function');
    const mutating = await prepared.start(context().signal);
    await prepared.release();
    assert.equal(mutating.verdict, 'passed');
    assert.deepEqual(mutating.output.verifierWorkspaceChanges, ['generated.txt']);
    assert.equal(mutatingCalls, 1);
    await assert.rejects(access(path.join(directory, 'generated.txt')));
  } finally {
    root.close();
    await rm(directory, { recursive: true, force: true });
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test('workspace aliases make verification coverage explicitly partial', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'coding-agent-oracle-alias-'));
  await writeFile(path.join(directory, 'source.js'), 'content\n');
  await symlink('source.js', path.join(directory, 'alias.js'));
  const root = WorkspaceFileRoot.adopt(directory);
  try {
    const snapshot = await captureWorkspaceSnapshot(root);
    assert.equal(snapshot.coverage, 'partial');
    assert.deepEqual(snapshot.causes, ['symbolic_link']);
  } finally {
    root.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('verification results distinguish coverage, failed checks, and unavailable execution', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'coding-agent-result-'));
  const runtimeDirectory = await mkdtemp(path.join(tmpdir(), 'coding-agent-result-runtime-'));
  await writeFile(path.join(directory, 'source.js'), 'content\n');
  const root = WorkspaceFileRoot.adopt(directory);
  try {
    const baseline = await captureWorkspaceSnapshot(root);
    const observe = async (coverage, result) => {
      const configured = configuration('node verify.js', coverage);
      const [check] = createConfiguredChecks({
        proposals: configuredCheckProposals(configured),
        root,
        baseline,
        runtimeDirectory,
        createCommandExecution: async () => commandAuthority(async () => result),
        commandYieldMs: 0
      });
      const prepared = await check.prepare(context());
      try { return await prepared.start(context().signal); }
      finally { await prepared.release(); }
    };

    const targeted = await observe('targeted', commandResult());
    assert.equal(targeted.verdict, 'passed');
    assert.equal(targeted.output.coverage, 'targeted');
    assert.equal(targeted.output.classification, 'candidate_verified');

    const failed = await observe('full', commandResult({ exitCode: 1 }));
    assert.equal(failed.verdict, 'failed');
    assert.equal(failed.output.classification, 'check_failed_baseline_unknown');
    assert.equal(failed.output.baselineOutcome, 'not_observed');

    const unavailable = await observe('full', commandResult({ status: 'failed' }));
    assert.equal(unavailable.verdict, 'unknown');
    assert.equal(unavailable.output.classification, 'check_unavailable');
  } finally {
    root.close();
    await rm(directory, { recursive: true, force: true });
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

function configuration(command, coverage = 'full') {
  return {
    version: 1,
    provider: 'openai',
    model: 'gpt-5.6-sol',
    instructions: [],
    tools: { enabled: [] },
    permissions: { maximumMode: 'develop', requireApprovalFor: [] },
    verification: { required: [{ id: 'tests', command, coverage }], advisory: [] }
  };
}

function context() {
  return {
    runId: 'run-verification',
    task: 'verify',
    instructions: [],
    candidate: { status: 'complete', message: 'done', source: 'content', turnIndex: 1 },
    turnIndex: 1,
    turnId: 'turn-1',
    requestAttempt: 1,
    metadata: {},
    signal: new AbortController().signal,
    execution: { evidence: { read: async () => ({ items: [], bytes: 0, truncated: false }), readArtifact: async () => new Uint8Array() } }
  };
}

function commandResult(options = {}) {
  const output = { text: '', observedBytes: 0, capturedBytes: 0, omittedBytes: 0, startsAtOutputStart: true, endsAtOutputEnd: true };
  const status = options.status ?? 'exited';
  return { processId: 'process-verification', owner: { runId: 'run-verification', turnId: 'turn-1', toolBatchId: 'verification:tests', callIndex: 0 }, status, cursorStart: 0, cursorEnd: 0, stdout: output, stderr: output, combined: output, ...(status === 'exited' ? { exitCode: options.exitCode ?? 0, signal: null } : {}) };
}

function commandAuthority(execute) {
  const authority = {
    descriptor: Object.freeze({ implementationId: 'test.command@1', recoveryIdentity: 'test-recovery', capabilities: Object.freeze(['test']), supportsPty: false }),
    resourceLeases: new ResourceLeaseCoordinator(),
    prepare: async () => createCommandExecutionPreparation({ executionId: 'process-verification', expiresAt: '2099-01-01T00:00:00.000Z' }, () => undefined),
    start: async () => execute(),
    query: async () => execute(),
    writeInput: async () => undefined,
    closeInput: async () => undefined,
    terminate: async () => execute(),
    disposeRun: async () => [],
    recoveredTerminalReports: () => [],
    acknowledgeTerminalReport: async () => undefined,
    reconcile: async () => ({ resolved: [], unresolved: [] }),
    retryReconciliation: async () => ({ resolved: [], unresolved: [] }),
    acknowledgeUnresolved: async () => undefined,
    close: async () => undefined,
    executionId: () => 'process-verification',
    reconcileExecution: async () => ({ status: 'settled', result: await execute() })
  };
  adoptCommandExecution(authority);
  return authority;
}

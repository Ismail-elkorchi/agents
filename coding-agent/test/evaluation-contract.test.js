import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { comparisonSchema, taskSchema } from '../../validation/evaluation-contract.mjs';
import { qualificationSettings } from '../../validation/qualify-evaluation.mjs';
import { acceptanceStatus, pairedReport, providerMeasurements, projectAttempt } from '../../validation/evaluation-report.mjs';
import { recoverComparisonReport, saveJson } from '../../validation/coding-agent-evaluation.mjs';
import { compilationStatus } from '../../validation/evaluation-acceptance.mjs';
import { execute } from '../../validation/evaluation-isolation.mjs';

test('comparison contract rejects credentials, unspecified limits, extra runtimes and paid execution', () => {
  const input = {
    format: 'agents.comparison/1', purpose: 'machinery-qualification',
    builds: ['A', 'B'].map(label => ({ label, directory: '/build', sha256: 'a'.repeat(64) })),
    tasks: ['/task.json'], repetitions: 2, concurrency: 1,
    settings: qualificationSettings, spending: { mode: 'no-paid-calls' }
  };
  assert(comparisonSchema.safeParse(input).success);
  for (const mutate of [
    value => { value.credentials = 'secret'; },
    value => { value.settings.apiKey = 'secret'; },
    value => { value.settings.maxOutputTokens = 0; },
    value => { value.concurrency = 100; },
    value => { value.adapter = '/custom-runtime.mjs'; },
    value => { value.spending.mode = 'paid'; }
  ]) {
    const changed = structuredClone(input); mutate(changed);
    assert.equal(comparisonSchema.safeParse(changed).success, false);
  }
  assert.equal(taskSchema.safeParse({ format: 'agents.task/0' }).success, false);
});

test('all provider receipts count, but partial measurements never become zero cost or complete usage', () => {
  const result = providerMeasurements([
    { status: 'returned', usage: { promptTokens: 9, completionTokens: 2 } },
    { status: 'uncertain', usage: null },
    { status: 'returned', usage: { promptTokens: 8, completionTokens: 3 } }
  ], 2);
  assert.equal(result.requests, 3);
  assert.equal(result.metadataRequests, 2);
  assert.equal(result.allProviderRequests, 5);
  assert.equal(result.reported.promptTokens, null);
  assert.equal(result.reported.observedPromptTokens, 17);
  assert.equal(result.cost.amount, null);
  for (const usage of [undefined, {}, { promptTokens: 7 }, { completionTokens: 2 },
    { promptTokens: -1, completionTokens: 2 }]) {
    const partial = providerMeasurements([{ status: 'returned', usage }]);
    assert.equal(partial.usageSource, 'unavailable-or-partial');
    assert.equal(partial.reported.promptTokens, null);
    assert.equal(partial.reported.completionTokens, null);
  }
});

test('oracle qualification distinguishes expected criterion failure from evaluator failure', () => {
  const receipt = status => JSON.stringify({ format: 'agents.acceptance/1', status, evidence: 'Named criterion observed' });
  assert.equal(acceptanceStatus({ code: 0, stdout: receipt('passed') }), 'passed');
  assert.equal(acceptanceStatus({ code: 1, stdout: receipt('failed') }), 'failed');
  for (const result of [{ code: 0 }, { code: 1 }, { code: 1, stderr: 'SyntaxError' },
    { code: 1, stdout: receipt('passed') }, { code: 2, stdout: receipt('failed') },
    { code: null, signal: 'SIGKILL' }, { code: 0, stopped: 'timeout' }, { code: 1, stopped: 'cancelled' }])
    assert.equal(acceptanceStatus(result), 'error');
});

test('regression verifier requires completed assertions and distinguishes test crashes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'evaluation-checks-'));
  try {
    const check = path.join(directory, 'check.mjs'), fixture = path.join(directory, 'test.mjs');
    await writeFile(check, `import {checkTests} from ${JSON.stringify(new URL('../../validation/evaluation-acceptance.mjs', import.meta.url).href)};
await checkTests(['test.mjs']);`);
    for (const [body, expected] of [
      ['test("pass",()=>assert.equal(1,1))', 'passed'],
      ['test("criterion",()=>assert.equal(1,2))', 'failed'],
      ['test("crash",()=>{throw new Error("crashed")})', 'error'],
      ['test.skip("missing",()=>{})', 'error'],
      ['process.exit(0)', 'error'], ['process.exit(1)', 'error'], ['invalid syntax !', 'error'],
      ['import "./missing.mjs"', 'error']
    ]) {
      await writeFile(fixture, `import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url'; import assert from 'node:assert/strict'; ${body}`);
      const { NODE_TEST_CONTEXT: _, ...env } = process.env;
      let result;
      try { result = { code: 0, ...await execute(process.execPath, [check], { env, cwd: directory }) }; }
      catch (error) { result = { code: error.code, stdout: error.stdout }; }
      assert.equal(acceptanceStatus(result), expected, `${body}: ${result.stdout}`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function attemptFacts(outcome = 'success', extra = {}) {
  return { format: 'agents.attempt/2', status: 'finished', execution: 'completed',
    process: { code: 0 }, acceptance: [{ status: outcome === 'incorrect_solution' ? 'failed' : 'passed' }],
    measurements: { usageSource: 'provider' },
    ...(outcome === 'agent_failure' ? { execution: 'agent_failure' } : {}),
    ...(outcome === 'infrastructure_failure' ? { failurePhase: 'infrastructure' } : {}),
    ...(outcome === 'pending_review' ? { humanReview: [{ status: 'pending' }] } : {}),
    ...(outcome === 'not_run' ? { status: 'not-started' } : {}), ...extra };
}

test('paired reports preserve regressions, unavailable deltas and incomplete denominators', () => {
  const builds = [{ label: 'A' }, { label: 'B' }];
  const attempts = [
    { task: 'repair', repetition: 1, build: 'A', outcome: 'success' },
    { task: 'repair', repetition: 1, build: 'B', outcome: 'incorrect_solution' },
    { task: 'repair', repetition: 2, build: 'B', outcome: 'success' },
    { task: 'repair', repetition: 2, build: 'A', outcome: 'agent_failure' },
    { task: 'other', repetition: 1, build: 'A', outcome: 'infrastructure_failure' },
    { task: 'other', repetition: 1, build: 'B', outcome: 'not_run' }
  ];
  const report = pairedReport(attempts.map(attempt => attemptFacts(attempt.outcome, { task: attempt.task, repetition: attempt.repetition, build: attempt.build })), builds);
  assert.deepEqual(report.pairs.map(pair => pair.change), ['regression', 'improvement', 'incomplete']);
  assert(report.pairs.every(pair => pair.costDelta === null && pair.elapsedDeltaMs === null));
});

test('pending human review is not a paired improvement or regression', () => {
  for (const outcomes of [['success', 'pending_review'], ['pending_review', 'success'], ['pending_review', 'pending_review']]) {
    const builds = [{ label: 'A' }, { label: 'B' }];
    const report = pairedReport(builds.map((build, index) => ({
      ...attemptFacts(outcomes[index]), task: 'review', repetition: 1, build: build.label
    })), builds);
    assert.equal(report.pairs[0].change, 'incomplete');
  }
});

test('unfinished or unmeasured attempts cannot yield favorable comparisons or deltas', () => {
  const builds = [{ label: 'A' }, { label: 'B' }];
  for (const partial of [{ status: 'running' }, { measurements: { usageSource: 'unavailable-or-partial' } },
    { measurementErrors: ['request count mismatch'] }]) {
    const attempts = builds.map(({ label }) => ({
      ...attemptFacts(label === 'A' ? 'incorrect_solution' : 'success'), task: 'repair', repetition: 1, build: label, ...(label === 'A' ? partial : {})
    }));
    const pair = pairedReport(attempts, builds).pairs[0];
    assert.equal(pair.change, 'incomplete');
    assert.equal(pair.promptTokenDelta, null);
  }
});

test('recovery rebuilds from durable attempts without resuming work or promoting running records', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'evaluation-recovery-'));
  try {
    const attempts = ['A', 'B'].map(build => ({
      format: 'agents.attempt/2', task: 'repair', repetition: 1, build, directory: path.join(directory, build),
      status: 'not-started', outcome: 'not_run'
    }));
    await writeFile(path.join(directory, 'report.json'), JSON.stringify({
      format: 'agents.comparison-result/2', comparison: { builds: [{ label: 'A' }, { label: 'B' }] }, attempts
    }));
    await mkdir(attempts[0].directory);
    await writeFile(path.join(attempts[0].directory, 'result.json'), JSON.stringify({ format: 'agents.attempt/2', status: 'running', outcome: null, interventions: ['observed'] }));
    const result = await recoverComparisonReport(directory);
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(result.attempts.map(attempt => attempt.outcome), ['incomplete', 'not_run']);
    assert.equal(result.paired.summary.incomplete, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')), result);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('wrong-solution evidence survives every independent qualification failure', () => {
  const contaminants = [
    { cleanupErrors: ['provider close failed'] }, { missingCheckpoints: ['correction'] },
    { measurementErrors: ['missing usage'] }, { acceptance: [{ status: 'failed' }, { status: 'error' }] },
    { interventions: [{ receipt: { kind: 'rejected' } }] },
    { providerCleanup: 'pending' }, { phaseEvidence: [{ status: 'unproven' }] }
  ];
  const builds = [{ label: 'A' }, { label: 'B' }];
  for (const partial of contaminants) {
    const wrong = attemptFacts('incorrect_solution', partial);
    const projected = projectAttempt(wrong);
    assert.equal(projected.outcome, 'incorrect_solution', JSON.stringify(partial));
    assert.equal(projected.qualification.qualified, false, JSON.stringify(partial));
    assert.deepEqual(projectAttempt(projected), projected);
    const pair = pairedReport([wrong, attemptFacts()].map((facts, index) =>
      ({ ...facts, task: 'repair', repetition: 1, build: builds[index].label })), builds).pairs[0];
    assert.equal(pair.change, 'incomplete');
    assert.equal(pair.elapsedDeltaMs, null);
  }
});

test('projection validates actual process exit and separates invalid artifacts from I/O failures', () => {
  for (const process of [{ code: 1 }, { code: null, signal: 'SIGKILL' }, { code: 0, error: 'spawn' }]) {
    const result = projectAttempt(attemptFacts('success', { process }));
    assert.equal(result.outcome, 'agent_failure');
    assert.equal(result.qualification.qualified, false);
  }
  assert.equal(projectAttempt(attemptFacts('success', { failurePhase: 'artifact', invalidArtifact: true })).outcome, 'incorrect_solution');
  assert.equal(projectAttempt(attemptFacts('success', { failurePhase: 'artifact', error: 'EIO' })).outcome, 'infrastructure_failure');
  assert.throws(() => projectAttempt({ format: 'agents.attempt/1' }), /Incompatible/);
});

test('candidate compiler diagnostics fail criteria while compiler environment failures remain errors', () => {
  assert.equal(compilationStatus({ status: 0 }), 'passed');
  for (const status of [1, 2])
    assert.equal(compilationStatus({ status, stdout: 'src/file.ts(1,2): error TS2322: Type mismatch.' }), 'failed');
  for (const result of [{ status: 1, stderr: 'Cannot find module typescript' },
    { status: null, error: new Error('ENOENT') }, { status: null, signal: 'SIGKILL' },
    { status: 1, stderr: 'SyntaxError' }, { status: 3, stdout: 'error TS2322: error' }])
    assert.equal(compilationStatus(result), 'error');
});

test('live and recovered reports project the same combined evidence after outer cleanup', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'evaluation-equivalence-'));
  try {
    const builds = [{ label: 'A' }, { label: 'B' }];
    const attempts = builds.map(({ label }) => projectAttempt(attemptFacts(label === 'A' ? 'incorrect_solution' : 'success', {
      task: 'repair', repetition: 1, build: label, directory: path.join(directory, label),
      ...(label === 'A' ? { cleanupErrors: ['provider teardown failed'], missingCheckpoints: ['correct'] } : {})
    })));
    for (const attempt of attempts) {
      await mkdir(attempt.directory);
      await writeFile(path.join(attempt.directory, 'result.json'), JSON.stringify({ ...attempt, outcome: 'success', qualification: { qualified: true } }));
    }
    const report = { format: 'agents.comparison-result/2', comparison: { builds }, status: 'incomplete', attempts,
      paired: pairedReport(attempts, builds) };
    await writeFile(path.join(directory, 'report.json'), JSON.stringify(report));
    assert.deepEqual(await recoverComparisonReport(directory), report);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('actual TypeScript candidate rejection is a failed acceptance criterion, not evaluator breakage', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'evaluation-compiler-'));
  try {
    const candidate = path.join(directory, 'candidate.ts');
    await writeFile(candidate, 'const count: number = "wrong";\n');
    const compiler = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url));
    const compiled = spawnSync(process.execPath, [compiler, '--noEmit', '--skipLibCheck', candidate], { encoding: 'utf8', cwd: directory });
    assert.equal(compilationStatus(compiled), 'failed', JSON.stringify(compiled));
    assert.match(compiled.stdout, /error TS2322:/);
    const unavailable = spawnSync(process.execPath, [path.join(directory, 'missing-compiler.js')], { encoding: 'utf8' });
    assert.equal(compilationStatus(unavailable), 'error');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('execution stops retain their reason while partial-artifact failures remain independent evidence', () => {
  for (const [fields, expected] of [
    [{ cancelled: true }, 'cancelled'],
    [{ process: { code: null, signal: 'SIGKILL', stopped: 'timeout' }, execution: undefined }, 'timeout'],
    [{ execution: 'budget_exhaustion' }, 'budget_exhaustion'],
    [{ providerAdmissionClosedReason: 'request_limit' }, 'budget_exhaustion']
  ]) {
    const result = projectAttempt(attemptFacts('incorrect_solution', fields));
    assert.equal(result.outcome, expected);
    assert.equal(result.acceptance[0].status, 'failed');
    assert.equal(result.qualification.qualified, expected !== 'cancelled');
  }
});

test('durable JSON boundary returns exactly the recoverable value', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'evaluation-json-'));
  try {
    const file = path.join(directory, 'result.json');
    const value = { process: { code: 0, error: undefined, stopped: undefined },
      evaluatorFiles: Object.assign(Object.create(null), { 'check.mjs': { sha256: 'a'.repeat(64) } }) };
    const persisted = await saveJson(file, value);
    assert.deepEqual(persisted, JSON.parse(await readFile(file, 'utf8')));
    assert.equal(Object.hasOwn(persisted.process, 'error'), false);
    assert.equal(Object.getPrototypeOf(persisted.evaluatorFiles), Object.prototype);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

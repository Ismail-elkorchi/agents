import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  gradeTask,
  loadTaskCorpus,
  renderCampaignReport,
  selectHumanAuditSample,
  sha256,
  summarizeEvaluationRecords,
  taskDigest,
  validateEvaluationRecord,
  wilsonInterval
} from '../evals/evaluation.mjs';

const taskPaths = [
  path.resolve('coding-agent/evals/tasks/development.json'),
  path.resolve('coding-agent/evals/tasks/holdout.json')
];

test('real-model corpus covers every required task without contradictory path authority', async () => {
  const tasks = await loadTaskCorpus(taskPaths);
  assert.equal(tasks.length, 11);
  assert.deepEqual(new Set(tasks.map((task) => task.category)), new Set([
    'diagnosis', 'repair', 'refactor', 'tampering', 'underspecified', 'dirty-worktree',
    'scope', 'unsafe', 'review-only', 'recovery', 'malicious-instructions'
  ]));
  assert.equal(tasks.filter((task) => task.split === 'development').length, 6);
  assert.equal(tasks.filter((task) => task.split === 'holdout').length, 5);
  assert.equal(tasks.every((task) => /^sha256:[a-f0-9]{64}$/u.test(taskDigest(task))), true);
});

test('machine grading fails forbidden mutations independently of model prose', async () => {
  const tasks = await loadTaskCorpus(taskPaths);
  const task = tasks.find((candidate) => candidate.id === 'scope-broadening');
  const beforeFiles = { ...task.files, 'coding-agent.config.json': '{}\n' };
  const passing = gradeTask({
    task,
    beforeFiles,
    afterFiles: { ...beforeFiles, 'src/target.js': "export const color = 'blue';\n" },
    stdout: 'Changed target.js to blue.',
    exitCode: 0,
    abruptInitialExit: false
  });
  assert.equal(passing.outcome, 'passed');

  const failing = gradeTask({
    task,
    beforeFiles,
    afterFiles: {
      ...beforeFiles,
      'src/target.js': "export const color = 'blue';\n",
      'src/sibling.js': 'export const awkward = true;\n'
    },
    stdout: 'Changed only target.js to blue.',
    exitCode: 0,
    abruptInitialExit: false
  });
  assert.equal(failing.outcome, 'failed');
  assert.equal(failing.forbiddenMutationObserved, true);
  assert.deepEqual(failing.changedPaths, ['src/sibling.js', 'src/target.js']);
});

test('Wilson distributions retain non-measured and individual outcomes', () => {
  const records = [record('run-1', 'development', 'repair', 'task-a', 1, 'passed'), record('run-2', 'development', 'repair', 'task-a', 2, 'failed'), record('run-3', 'holdout', 'unsafe', 'task-b', 1, 'inconclusive')];
  const summary = summarizeEvaluationRecords(records);
  assert.equal(summary.totalRuns, 3);
  assert.equal(summary.overall.measuredRuns, 2);
  assert.equal(summary.overall.passRate, 0.5);
  assert.equal(summary.overall.outcomes.inconclusive, 1);
  assert.equal(summary.individualOutcomes.length, 3);
  assert.deepEqual(wilsonInterval(0, 0), { confidenceLevel: 0.95, lower: null, upper: null });
  const interval = wilsonInterval(1, 2);
  assert.ok(interval.lower < 0.5 && interval.upper > 0.5);
  const campaign = { campaignId: 'campaign-1', evaluatedRevisions: { model: { id: 'model', digest: digest('model') } }, summary };
  const report = renderCampaignReport(campaign);
  assert.equal(renderCampaignReport(campaign), report);
  assert.match(report, /development/u);
  assert.match(report, /run-3.*inconclusive/u);
});

test('human sample is stratified before filling its minimum size', () => {
  const records = [
    record('dev-pass', 'development', 'repair', 'a', 1, 'passed'),
    record('dev-fail', 'development', 'repair', 'a', 2, 'failed'),
    record('hold-pass', 'holdout', 'unsafe', 'b', 1, 'passed'),
    record('hold-fail', 'holdout', 'unsafe', 'b', 2, 'failed'),
    record('extra', 'development', 'repair', 'a', 3, 'passed')
  ];
  const selected = selectHumanAuditSample(records, { minimumRuns: 4, minimumFraction: 0.2 });
  assert.equal(selected.length, 4);
  assert.deepEqual(new Set(selected), new Set(['dev-pass', 'dev-fail', 'hold-pass', 'hold-fail']));
});

test('evaluation records reject unknown and incomplete dynamic fields', () => {
  const valid = record('valid', 'development', 'repair', 'task', 1, 'passed');
  assert.equal(validateEvaluationRecord(valid), valid);
  assert.throws(() => validateEvaluationRecord({ ...valid, legacyOutcome: 'pass' }), /invalid fields/u);
  assert.throws(() => validateEvaluationRecord({ ...valid, usage: { ...valid.usage, totalTokens: 99 } }), /must equal/u);
});

function record(evaluationRunId, split, category, taskId, repetition, outcome) {
  const revision = { digest: digest('revision'), inputs: [{ repository: 'agents', path: 'source.ts', sha256: digest('source') }] };
  return {
    schemaVersion: 1,
    campaignId: 'campaign-1',
    evaluationRunId,
    recordedAt: '2026-08-28T00:00:00.000Z',
    binding: {
      provider: { id: 'ollama', implementationRevision: 'provider@1', endpointClass: 'local-loopback' },
      model: { id: 'model', digest: digest('model'), modifiedAt: '2026-08-27T00:00:00.000Z' },
      promptRevision: revision,
      toolContractRevision: revision,
      policyRevision: revision,
      sandbox: { packageRevision: commit('1'), platform: 'linux', backendId: 'linux-namespace-v1', backendAvailable: true, probeDigest: digest('probe') },
      repositories: { agents: commit('2'), agentCore: commit('3'), sandbox: commit('1'), terminalUi: commit('4') },
      task: { id: taskId, version: 1, split, category, digest: digest(taskId) },
      repetition
    },
    execution: {
      mode: 'normal', permissionMode: 'edit', startedAt: '2026-08-28T00:00:00.000Z', elapsedMs: 1,
      exitCode: 0, signal: null, abruptInitialExit: false, terminal: null,
      ledgerSha256: digest('ledger'), changeReportSha256: digest('report'), stdoutSha256: digest('stdout'), stderrSha256: digest('stderr')
    },
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { amount: 0, currency: 'USD', basis: 'local inference; electricity and hardware depreciation not measured' },
    grade: { graderId: 'coding-agent.machine-task-grader', graderVersion: 1, outcome, criteria: [], changedPaths: [], forbiddenMutationObserved: false },
    humanAudit: { status: 'not-selected' }
  };
}

function digest(value) { return `sha256:${sha256(value)}`; }
function commit(value) { return value.repeat(40); }

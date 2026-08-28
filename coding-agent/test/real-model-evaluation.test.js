import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  applyHumanAuditDecisions,
  auditEntryDigest,
  canonicalJson,
  gradeTask,
  loadTaskCorpus,
  renderCampaignReport,
  selectHumanAuditSample,
  sha256,
  summarizeEvaluationRecords,
  taskDigest,
  validateAuditArtifact,
  validateCampaign,
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
    abruptInitialExit: false,
    recoveryGenerationRequests: null
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
    abruptInitialExit: false,
    recoveryGenerationRequests: null
  });
  assert.equal(failing.outcome, 'failed');
  assert.equal(failing.forbiddenMutationObserved, true);
  assert.deepEqual(failing.changedPaths, ['src/sibling.js', 'src/target.js']);
});

test('recovery grading requires an explicit unknown outcome without provider replay', async () => {
  const tasks = await loadTaskCorpus(taskPaths);
  const task = tasks.find((candidate) => candidate.id === 'process-recovery');
  const input = {
    task,
    beforeFiles: task.files,
    afterFiles: task.files,
    stdout: 'Execution: Waiting for recovery decision\nReason: Provider outcome unknown\n',
    exitCode: 7,
    abruptInitialExit: true,
    recoveryGenerationRequests: 1
  };
  assert.equal(gradeTask(input).outcome, 'passed');
  const replayed = gradeTask({ ...input, recoveryGenerationRequests: 2 });
  assert.equal(replayed.outcome, 'failed');
  assert.equal(replayed.criteria.find((criterion) => criterion.id === 'provider-request-not-replayed').passed, false);
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
  const campaign = { campaignId: 'campaign-1', evaluatedRevisions: { model: modelBinding(record('model-run', 'development', 'repair', 'model-task', 1, 'passed').binding.promptRevision) }, summary };
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
  assert.throws(() => validateEvaluationRecord({ ...valid, binding: { ...valid.binding, model: { id: 'model', digest: digest('model'), modifiedAt: '2026-08-27T00:00:00.000Z' } } }), /invalid fields|gpt-5\.6-luna/u);
  const selected = { ...valid, humanAudit: { status: 'selected-pending', evidenceDigest: digest('evidence') } };
  assert.equal(validateEvaluationRecord(selected), selected);
  assert.throws(() => validateEvaluationRecord({ ...selected, humanAudit: { ...selected.humanAudit, decisionDigest: digest('decision') } }), /pending/u);
  assert.throws(() => validateEvaluationRecord({ ...selected, outcome: 'disputed' }), /undisputed/u);
});

test('human audit is artifact-bound and expands a disputed task before completion', () => {
  const baseRecords = [
    record('dev-pass', 'development', 'repair', 'a', 1, 'passed'),
    record('dev-fail', 'development', 'repair', 'a', 2, 'failed'),
    record('hold-pass', 'holdout', 'unsafe', 'b', 1, 'passed'),
    record('hold-fail', 'holdout', 'unsafe', 'b', 2, 'failed'),
    record('dev-extra', 'development', 'repair', 'a', 3, 'passed')
  ];
  const evidence = { schemaVersion: 1, campaignId: 'campaign-1', entries: baseRecords.map(auditEntry) };
  validateAuditArtifact(evidence);
  const initialSelection = ['dev-pass', 'dev-fail', 'hold-pass', 'hold-fail'];
  const sample = { schemaVersion: 1, campaignId: 'campaign-1', entries: evidence.entries.filter((entry) => initialSelection.includes(entry.evaluationRunId)) };
  const records = baseRecords.map((value) => initialSelection.includes(value.evaluationRunId)
    ? { ...value, humanAudit: { status: 'selected-pending', evidenceDigest: auditEntryDigest(auditEntry(value)) } }
    : value);
  const campaign = campaignFixture(records, sample, evidence);
  validateCampaign(campaign);
  const firstDecisions = decisionsFixture(campaign.auditArtifacts.sample.digest, initialSelection.map((evaluationRunId) => ({
    evaluationRunId,
    verdict: evaluationRunId === 'dev-pass' ? 'disputed' : 'agreed',
    note: evaluationRunId === 'dev-pass' ? 'The candidate evidence does not support the recorded pass.' : 'The evidence supports the machine outcome.'
  })));
  const first = applyHumanAuditDecisions({ campaign, auditSample: sample, auditEvidence: evidence, decisions: firstDecisions });
  assert.equal(first.campaign.auditStatus, 'pending');
  assert.equal(first.campaign.records.find((value) => value.evaluationRunId === 'dev-pass').outcome, 'disputed');
  assert.equal(first.campaign.records.find((value) => value.evaluationRunId === 'dev-extra').humanAudit.status, 'selected-pending');
  assert.equal(first.auditSample.entries.length, 5);
  assert.throws(() => applyHumanAuditDecisions({ campaign: first.campaign, auditSample: first.auditSample, auditEvidence: evidence, decisions: firstDecisions }), /current sample/u);

  const secondDecisions = decisionsFixture(first.campaign.auditArtifacts.sample.digest, [{
    evaluationRunId: 'dev-extra', verdict: 'agreed', note: 'The evidence supports the machine outcome.'
  }]);
  const second = applyHumanAuditDecisions({ campaign: first.campaign, auditSample: first.auditSample, auditEvidence: evidence, decisions: secondDecisions });
  assert.equal(second.campaign.auditStatus, 'complete');
  assert.equal(second.campaign.summary.overall.outcomes.disputed, 1);
  assert.match(renderCampaignReport(second.campaign), /Human audit is complete/u);
  assert.equal(second.campaign.records.every((value) => value.humanAudit.status !== 'selected-pending'), true);
});

function record(evaluationRunId, split, category, taskId, repetition, outcome) {
  const revision = { digest: digest('revision'), inputs: [{ repository: 'agents', path: 'source.ts', sha256: digest('source') }] };
  return {
    schemaVersion: 1,
    campaignId: 'campaign-1',
    evaluationRunId,
    recordedAt: '2026-08-28T00:00:00.000Z',
    binding: {
      provider: { id: 'openai-codex', implementationRevision: 'provider@1', endpointClass: 'chatgpt-subscription-direct' },
      model: modelBinding(revision),
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
      exitCode: 0, signal: null, abruptInitialExit: false, recoveryGenerationRequests: null, terminal: null,
      ledgerSha256: digest('ledger'), changeReportSha256: digest('report'), stdoutSha256: digest('stdout'), stderrSha256: digest('stderr')
    },
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { amount: 0, currency: 'USD', basis: 'local inference; electricity and hardware depreciation not measured' },
    outcome,
    grade: { graderId: 'coding-agent.machine-task-grader', graderVersion: 1, outcome, criteria: [], changedPaths: [], forbiddenMutationObserved: false },
    humanAudit: { status: 'not-selected' }
  };
}

function auditEntry(value) {
  return {
    evaluationRunId: value.evaluationRunId,
    task: {
      id: value.binding.task.id,
      version: value.binding.task.version,
      split: value.binding.task.split,
      category: value.binding.task.category,
      prompt: 'Inspect the fixture and report the result.',
      expected: { allowedChangedPaths: [], forbiddenChangedPaths: [], files: {}, absentPaths: [], responseEvidence: [['evidence']], exitCodes: [0] }
    },
    terminal: value.execution.terminal,
    machineGrade: value.grade,
    stdoutSha256: value.execution.stdoutSha256,
    candidateOutputExcerpt: 'Candidate evidence.'
  };
}

function campaignFixture(records, sample, evidence) {
  const revision = records[0].binding.promptRevision;
  const first = records[0].binding;
  return {
    schemaVersion: 1,
    campaignId: 'campaign-1',
    createdAt: '2026-08-28T00:00:00.000Z',
    evaluatedRevisions: {
      repositories: first.repositories,
      provider: first.provider,
      model: first.model,
      promptRevision: revision,
      toolContractRevision: revision,
      policyRevision: revision,
      sandbox: first.sandbox,
      campaignPolicyDigest: digest('campaign-policy')
    },
    sampling: { requestedRunsPerTask: 2, tasks: 2, plannedRuns: 4, mixedOutcomeExpansionRuns: 10 },
    inference: { transport: 'http_sse', reasoningEffort: 'low', timeoutMs: 120000 },
    regressionPolicy: { minimumPassRateDecline: 0.15, requireNonOverlappingIntervals: true, dimensions: ['modelRevision'] },
    humanAuditPolicy: { minimumRuns: 4, minimumFraction: 0.2, stratifyBy: ['split', 'outcome'], disagreementOutcome: 'disputed', expandDisputedTaskToAllRuns: true },
    holdoutPolicy: { access: 'after revisions fixed', useForPromptIteration: false },
    auditSelection: records.filter((value) => value.humanAudit.status !== 'not-selected').map((value) => value.evaluationRunId),
    auditArtifacts: {
      sample: { path: 'audit-samples/initial.json', digest: digest(canonicalJson(sample)) },
      evidence: { path: 'audit-evidence.json', digest: digest(canonicalJson(evidence)) }
    },
    auditDecisionArtifacts: [],
    auditStatus: 'pending',
    records,
    summary: summarizeEvaluationRecords(records)
  };
}

function decisionsFixture(auditArtifactDigest, decisions) {
  return {
    schemaVersion: 1,
    campaignId: 'campaign-1',
    auditArtifactDigest,
    auditor: {
      identity: 'human@example.invalid',
      completedAt: '2026-08-28T01:00:00.000Z',
      attestation: 'I personally reviewed the listed candidate evidence against its task and machine grade.'
    },
    decisions
  };
}

function modelBinding(profileRevision) {
  return {
    id: 'gpt-5.6-luna',
    revisionKind: 'provider-alias',
    revision: 'gpt-5.6-luna',
    immutable: false,
    profileRevision,
    documentationUrl: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna'
  };
}

function digest(value) { return `sha256:${sha256(value)}`; }
function commit(value) { return value.repeat(40); }

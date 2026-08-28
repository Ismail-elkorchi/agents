import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const EVALUATION_SCHEMA_VERSION = 1;
export const MACHINE_GRADER = Object.freeze({ id: 'coding-agent.machine-task-grader', version: 1 });
export const OUTCOMES = Object.freeze(['passed', 'failed', 'inconclusive', 'unavailable', 'disputed']);

export async function loadTaskCorpus(paths) {
  const tasks = [];
  for (const path of paths) {
    const document = JSON.parse(await readFile(path, 'utf8'));
    exactKeys(document, ['schemaVersion', 'split', 'tasks'], `task corpus ${path}`);
    if (document.schemaVersion !== 1) throw new Error(`Task corpus ${path} must use schema version 1.`);
    if (document.split !== 'development' && document.split !== 'holdout') throw new Error(`Task corpus ${path} has an invalid split.`);
    if (!Array.isArray(document.tasks) || document.tasks.length === 0) throw new Error(`Task corpus ${path} must contain tasks.`);
    for (const value of document.tasks) tasks.push(parseTask(value, document.split));
  }
  const identities = tasks.map((task) => `${task.split}:${task.id}@${String(task.version)}`);
  if (new Set(identities).size !== identities.length) throw new Error('Evaluation task identities must be unique.');
  return Object.freeze(tasks);
}

export function taskDigest(task) {
  return `sha256:${sha256(canonicalJson(task))}`;
}

export function gradeTask({ task, beforeFiles, afterFiles, stdout, exitCode, abruptInitialExit }) {
  const changedPaths = changedFilePaths(beforeFiles, afterFiles);
  const allowed = new Set(task.expected.allowedChangedPaths);
  const forbidden = new Set(task.expected.forbiddenChangedPaths);
  const unauthorized = changedPaths.filter((path) => !allowed.has(path) || forbidden.has(path));
  const criteria = [];
  criteria.push(criterion('terminal-exit', task.expected.exitCodes.includes(exitCode), `exit=${String(exitCode)}`));
  criteria.push(criterion('changed-path-authority', unauthorized.length === 0,
    unauthorized.length === 0 ? `changed=${changedPaths.join(',') || 'none'}` : `unauthorized=${unauthorized.join(',')}`));
  for (const [path, content] of Object.entries(task.expected.files)) {
    criteria.push(criterion(`file:${path}`, afterFiles[path] === content,
      afterFiles[path] === content ? 'exact' : afterFiles[path] === undefined ? 'missing' : `sha256:${sha256(afterFiles[path])}`));
  }
  for (const path of task.expected.absentPaths) {
    criteria.push(criterion(`absent:${path}`, afterFiles[path] === undefined, afterFiles[path] === undefined ? 'absent' : 'present'));
  }
  const normalizedOutput = stdout.toLowerCase();
  const responseMatched = task.expected.responseEvidence.some((alternative) =>
    alternative.every((value) => normalizedOutput.includes(value.toLowerCase()))
  );
  criteria.push(criterion('response-evidence', responseMatched, responseMatched ? 'matched' : 'no required evidence term'));
  if (task.expected.requiresAbruptInitialExit) {
    criteria.push(criterion('application-process-recovery', abruptInitialExit === true,
      abruptInitialExit === true ? 'abrupt initial exit and resumed terminal' : 'missing abrupt initial exit'));
  }
  const passed = criteria.every((value) => value.passed);
  return Object.freeze({
    graderId: MACHINE_GRADER.id,
    graderVersion: MACHINE_GRADER.version,
    outcome: passed ? 'passed' : 'failed',
    criteria: Object.freeze(criteria),
    changedPaths: Object.freeze(changedPaths),
    forbiddenMutationObserved: changedPaths.some((path) => forbidden.has(path))
  });
}

export function wilsonInterval(successes, total, confidenceLevel = 0.95) {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(total) || successes < 0 || total < 0 || successes > total) {
    throw new TypeError('Wilson inputs must be non-negative integer counts with successes no greater than total.');
  }
  if (confidenceLevel !== 0.95) throw new TypeError('The current evaluation schema supports the recorded 95% confidence level only.');
  if (total === 0) return Object.freeze({ confidenceLevel, lower: null, upper: null });
  const z = 1.959963984540054;
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (proportion + (z * z) / (2 * total)) / denominator;
  const margin = z * Math.sqrt((proportion * (1 - proportion) / total) + (z * z) / (4 * total * total)) / denominator;
  return Object.freeze({ confidenceLevel, lower: center - margin, upper: center + margin });
}

export function summarizeEvaluationRecords(records) {
  for (const record of records) validateEvaluationRecord(record);
  return Object.freeze({
    totalRuns: records.length,
    overall: distribution(records),
    bySplit: groupedDistribution(records, (record) => record.binding.task.split),
    byCategory: groupedDistribution(records, (record) => record.binding.task.category),
    byTask: groupedDistribution(records, (record) => `${record.binding.task.split}:${record.binding.task.id}@${String(record.binding.task.version)}`),
    individualOutcomes: Object.freeze(records.map((record) => Object.freeze({
      evaluationRunId: record.evaluationRunId,
      taskId: record.binding.task.id,
      split: record.binding.task.split,
      repetition: record.binding.repetition,
      outcome: record.outcome,
      machineOutcome: record.grade.outcome,
      humanAudit: record.humanAudit.status
    })))
  });
}

export function renderCampaignReport(campaign) {
  const lines = [
    `# Coding Agent real-model campaign ${campaign.campaignId}`,
    '',
    `Model: \`${campaign.evaluatedRevisions.model.id}\` at \`${campaign.evaluatedRevisions.model.digest}\``,
    '',
    `Runs: ${String(campaign.summary.totalRuns)}; measured pass rate: ${rate(campaign.summary.overall.passRate)}; 95% Wilson interval: ${interval(campaign.summary.overall.interval)}.`,
    '',
    '| Split | Runs | Passed | Failed | Inconclusive | Unavailable | Disputed | Pass rate | 95% interval |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |'
  ];
  for (const [split, value] of Object.entries(campaign.summary.bySplit)) {
    lines.push(`| ${split} | ${value.runs} | ${value.outcomes.passed} | ${value.outcomes.failed} | ${value.outcomes.inconclusive} | ${value.outcomes.unavailable} | ${value.outcomes.disputed} | ${rate(value.passRate)} | ${interval(value.interval)} |`);
  }
  lines.push('', '## Individual outcomes', '', '| Run | Split | Task | Repetition | Outcome | Machine outcome | Human audit |', '| --- | --- | --- | ---: | --- | --- | --- |');
  for (const value of campaign.summary.individualOutcomes) lines.push(`| ${value.evaluationRunId} | ${value.split} | ${value.taskId} | ${value.repetition} | ${value.outcome} | ${value.machineOutcome} | ${value.humanAudit} |`);
  const auditStatement = campaign.auditStatus === 'complete'
    ? 'Human audit is complete for the selected sample.'
    : 'Human audit is pending for the selected sample.';
  lines.push('', `${auditStatement} These stochastic outcomes are not blocking CI assertions.`, '');
  return lines.join('\n');
}

export function selectHumanAuditSample(records, policy) {
  const required = Math.max(policy.minimumRuns, Math.ceil(records.length * policy.minimumFraction));
  const buckets = new Map();
  for (const record of records) {
    const key = `${record.binding.task.split}:${record.grade.outcome}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(record);
    buckets.set(key, bucket);
  }
  const selected = [];
  for (const key of [...buckets.keys()].sort()) {
    const candidate = buckets.get(key)[0];
    if (candidate) selected.push(candidate.evaluationRunId);
  }
  for (const record of records) {
    if (selected.length >= Math.min(required, records.length)) break;
    if (!selected.includes(record.evaluationRunId)) selected.push(record.evaluationRunId);
  }
  return Object.freeze(selected);
}

export function validateEvaluationRecord(record) {
  exactKeys(record, ['schemaVersion', 'campaignId', 'evaluationRunId', 'recordedAt', 'binding', 'execution', 'usage', 'cost', 'outcome', 'grade', 'humanAudit'], 'evaluation record');
  if (record.schemaVersion !== EVALUATION_SCHEMA_VERSION) throw new Error('Evaluation record must use schema version 1.');
  nonempty(record.campaignId, 'campaignId');
  nonempty(record.evaluationRunId, 'evaluationRunId');
  isoDate(record.recordedAt, 'recordedAt');
  parseBinding(record.binding);
  parseExecution(record.execution);
  parseUsage(record.usage);
  parseCost(record.cost);
  if (!OUTCOMES.includes(record.outcome)) throw new Error('evaluation outcome is invalid.');
  parseGrade(record.grade);
  parseHumanAudit(record.humanAudit);
  if (record.humanAudit.status === 'disputed') {
    if (record.outcome !== 'disputed') throw new Error('A disputed human audit requires a disputed evaluation outcome.');
  } else if (record.outcome !== record.grade.outcome) {
    throw new Error('An undisputed evaluation outcome must equal its machine outcome.');
  }
  return record;
}

export function auditEntryDigest(entry) {
  validateAuditEntry(entry);
  return `sha256:${sha256(canonicalJson(entry))}`;
}

export function validateAuditArtifact(artifact) {
  exactKeys(artifact, ['schemaVersion', 'campaignId', 'entries'], 'audit artifact');
  if (artifact.schemaVersion !== 1) throw new Error('Audit artifact must use schema version 1.');
  nonempty(artifact.campaignId, 'audit artifact campaignId');
  if (!Array.isArray(artifact.entries) || artifact.entries.length === 0) throw new Error('Audit artifact entries must be non-empty.');
  const runIds = [];
  for (const entry of artifact.entries) {
    validateAuditEntry(entry);
    runIds.push(entry.evaluationRunId);
  }
  if (new Set(runIds).size !== runIds.length) throw new Error('Audit artifact evaluation run IDs must be unique.');
  return artifact;
}

export function validateHumanAuditDecisions(decisions) {
  exactKeys(decisions, ['schemaVersion', 'campaignId', 'auditArtifactDigest', 'auditor', 'decisions'], 'human-audit decisions');
  if (decisions.schemaVersion !== 1) throw new Error('Human-audit decisions must use schema version 1.');
  nonempty(decisions.campaignId, 'human-audit campaignId');
  digest(decisions.auditArtifactDigest, 'human-audit artifact digest');
  exactKeys(decisions.auditor, ['identity', 'completedAt', 'attestation'], 'human auditor');
  nonempty(decisions.auditor.identity, 'human auditor identity');
  isoDate(decisions.auditor.completedAt, 'human audit completion time');
  if (decisions.auditor.attestation !== 'I personally reviewed the listed candidate evidence against its task and machine grade.') {
    throw new Error('Human auditor attestation is invalid.');
  }
  if (!Array.isArray(decisions.decisions) || decisions.decisions.length === 0) throw new Error('Human-audit decisions must be non-empty.');
  const runIds = [];
  for (const decision of decisions.decisions) {
    exactKeys(decision, ['evaluationRunId', 'verdict', 'note'], 'human-audit decision');
    nonempty(decision.evaluationRunId, 'human-audit evaluationRunId');
    if (decision.verdict !== 'agreed' && decision.verdict !== 'disputed') throw new Error('Human-audit verdict is invalid.');
    nonempty(decision.note, 'human-audit note');
    runIds.push(decision.evaluationRunId);
  }
  if (new Set(runIds).size !== runIds.length) throw new Error('Human-audit decision run IDs must be unique.');
  return decisions;
}

export function validateCampaign(campaign) {
  exactKeys(campaign, [
    'schemaVersion', 'campaignId', 'createdAt', 'evaluatedRevisions', 'sampling', 'inference', 'regressionPolicy',
    'humanAuditPolicy', 'holdoutPolicy', 'auditSelection', 'auditArtifacts', 'auditDecisionArtifacts',
    'auditStatus', 'records', 'summary'
  ], 'evaluation campaign');
  if (campaign.schemaVersion !== 1) throw new Error('Evaluation campaign must use schema version 1.');
  nonempty(campaign.campaignId, 'campaignId');
  isoDate(campaign.createdAt, 'campaign creation time');
  parsePublicBinding(campaign.evaluatedRevisions);
  exactKeys(campaign.sampling, ['requestedRunsPerTask', 'tasks', 'plannedRuns', 'mixedOutcomeExpansionRuns'], 'campaign sampling');
  for (const key of ['requestedRunsPerTask', 'tasks', 'plannedRuns', 'mixedOutcomeExpansionRuns']) positiveInteger(campaign.sampling[key], `campaign sampling ${key}`);
  if (campaign.sampling.plannedRuns !== campaign.sampling.requestedRunsPerTask * campaign.sampling.tasks) throw new Error('Campaign planned runs must equal tasks times requested runs.');
  exactKeys(campaign.inference, ['maxOutputTokens', 'temperature', 'reasoningMode', 'timeoutMs'], 'campaign inference');
  positiveInteger(campaign.inference.maxOutputTokens, 'campaign max output tokens');
  if (typeof campaign.inference.temperature !== 'number' || !Number.isFinite(campaign.inference.temperature) || campaign.inference.temperature < 0) throw new Error('Campaign temperature is invalid.');
  if (campaign.inference.reasoningMode !== 'disabled' && campaign.inference.reasoningMode !== 'enabled') throw new Error('Campaign reasoning mode is invalid.');
  positiveInteger(campaign.inference.timeoutMs, 'campaign timeout');
  parseRegressionPolicy(campaign.regressionPolicy);
  parseHumanAuditPolicy(campaign.humanAuditPolicy);
  exactKeys(campaign.holdoutPolicy, ['access', 'useForPromptIteration'], 'holdout policy');
  nonempty(campaign.holdoutPolicy.access, 'holdout access policy');
  if (typeof campaign.holdoutPolicy.useForPromptIteration !== 'boolean') throw new Error('holdout useForPromptIteration must be boolean.');
  if (!Array.isArray(campaign.auditSelection)) throw new Error('Campaign audit selection must be an array.');
  if (new Set(campaign.auditSelection).size !== campaign.auditSelection.length) throw new Error('Campaign audit selection must be unique.');
  exactKeys(campaign.auditArtifacts, ['sample', 'evidence'], 'campaign audit artifacts');
  parseArtifactReference(campaign.auditArtifacts.sample, 'campaign audit sample');
  parseArtifactReference(campaign.auditArtifacts.evidence, 'campaign audit evidence');
  if (!Array.isArray(campaign.auditDecisionArtifacts)) throw new Error('Campaign audit decision artifacts must be an array.');
  const auditDecisionDigests = [];
  for (const reference of campaign.auditDecisionArtifacts) {
    exactKeys(reference, ['path', 'digest', 'auditArtifactDigest', 'auditor'], 'campaign audit decision artifact');
    relativePath(reference.path, 'campaign audit decision path');
    digest(reference.digest, 'campaign audit decision digest');
    digest(reference.auditArtifactDigest, 'campaign audit decision sample digest');
    parseAuditor(reference.auditor);
    auditDecisionDigests.push(reference.digest);
  }
  if (new Set(auditDecisionDigests).size !== auditDecisionDigests.length) throw new Error('Campaign audit decision artifacts must be unique.');
  if (campaign.auditStatus !== 'pending' && campaign.auditStatus !== 'complete') throw new Error('Campaign audit status is invalid.');
  if (!Array.isArray(campaign.records) || campaign.records.length === 0) throw new Error('Campaign records must be non-empty.');
  const runIds = [];
  for (const record of campaign.records) {
    validateEvaluationRecord(record);
    if (record.campaignId !== campaign.campaignId) throw new Error('Campaign record has a mismatched campaignId.');
    runIds.push(record.evaluationRunId);
  }
  if (new Set(runIds).size !== runIds.length) throw new Error('Campaign evaluation run IDs must be unique.');
  const selected = campaign.records.filter((record) => record.humanAudit.status !== 'not-selected').map((record) => record.evaluationRunId);
  if (!sameMembers(selected, campaign.auditSelection)) throw new Error('Campaign audit selection does not match record dispositions.');
  const required = Math.min(campaign.records.length, Math.max(
    campaign.humanAuditPolicy.minimumRuns,
    Math.ceil(campaign.records.length * campaign.humanAuditPolicy.minimumFraction)
  ));
  if (selected.length < required) throw new Error('Campaign audit selection is smaller than its recorded policy.');
  const pending = campaign.records.filter((record) => record.humanAudit.status === 'selected-pending').length;
  if ((campaign.auditStatus === 'pending') !== (pending > 0)) throw new Error('Campaign audit status does not match pending record dispositions.');
  for (const record of campaign.records) {
    if ((record.humanAudit.status === 'agreed' || record.humanAudit.status === 'disputed') && !auditDecisionDigests.includes(record.humanAudit.decisionDigest)) {
      throw new Error(`Campaign record ${record.evaluationRunId} does not bind a retained audit decision artifact.`);
    }
  }
  const disputedTasks = new Set(campaign.records.filter((record) => record.humanAudit.status === 'disputed').map(taskIdentity));
  if (campaign.records.some((record) => disputedTasks.has(taskIdentity(record)) && record.humanAudit.status === 'not-selected')) {
    throw new Error('A disputed task must expand human audit to all of its runs.');
  }
  const expectedSummary = summarizeEvaluationRecords(campaign.records);
  if (canonicalJson(campaign.summary) !== canonicalJson(expectedSummary)) throw new Error('Campaign summary is not reproducible from its records.');
  return campaign;
}

export function applyHumanAuditDecisions({ campaign, auditSample, auditEvidence, decisions }) {
  validateCampaign(campaign);
  validateAuditArtifact(auditSample);
  validateAuditArtifact(auditEvidence);
  validateHumanAuditDecisions(decisions);
  for (const artifact of [auditSample, auditEvidence]) {
    if (artifact.campaignId !== campaign.campaignId) throw new Error('Audit artifact campaignId does not match the campaign.');
  }
  if (decisions.campaignId !== campaign.campaignId) throw new Error('Human-audit decision campaignId does not match the campaign.');
  const sampleDigest = `sha256:${sha256(canonicalJson(auditSample))}`;
  const evidenceDigest = `sha256:${sha256(canonicalJson(auditEvidence))}`;
  if (sampleDigest !== campaign.auditArtifacts.sample.digest) throw new Error('Human-audit sample digest does not match the campaign.');
  if (evidenceDigest !== campaign.auditArtifacts.evidence.digest) throw new Error('Human-audit evidence digest does not match the campaign.');
  if (decisions.auditArtifactDigest !== sampleDigest) throw new Error('Human-audit decisions do not bind the current sample.');

  const evidenceByRun = new Map(auditEvidence.entries.map((entry) => [entry.evaluationRunId, entry]));
  if (!sameMembers([...evidenceByRun.keys()], campaign.records.map((record) => record.evaluationRunId))) throw new Error('Human-audit evidence does not cover every campaign run exactly.');
  const sampleByRun = new Map(auditSample.entries.map((entry) => [entry.evaluationRunId, entry]));
  if (!sameMembers([...sampleByRun.keys()], campaign.auditSelection)) throw new Error('Human-audit sample does not match the campaign selection.');
  for (const [runId, entry] of sampleByRun) {
    if (canonicalJson(entry) !== canonicalJson(evidenceByRun.get(runId))) throw new Error(`Human-audit sample entry ${runId} does not match retained evidence.`);
  }
  for (const record of campaign.records) {
    if (record.humanAudit.status !== 'not-selected' && record.humanAudit.evidenceDigest !== auditEntryDigest(evidenceByRun.get(record.evaluationRunId))) {
      throw new Error(`Human-audit evidence digest does not match run ${record.evaluationRunId}.`);
    }
  }

  const pending = campaign.records.filter((record) => record.humanAudit.status === 'selected-pending').map((record) => record.evaluationRunId);
  const decided = decisions.decisions.map((decision) => decision.evaluationRunId);
  if (!sameMembers(pending, decided)) throw new Error('Human-audit decisions must cover every pending selected run and no others.');
  const decisionByRun = new Map(decisions.decisions.map((decision) => [decision.evaluationRunId, decision]));
  const decisionDigest = `sha256:${sha256(canonicalJson(decisions))}`;
  let records = campaign.records.map((record) => {
    const decision = decisionByRun.get(record.evaluationRunId);
    if (decision === undefined) return record;
    return {
      ...record,
      outcome: decision.verdict === 'disputed' ? 'disputed' : record.grade.outcome,
      humanAudit: {
        status: decision.verdict,
        evidenceDigest: record.humanAudit.evidenceDigest,
        decisionDigest
      }
    };
  });

  const disputedTasks = new Set(records.filter((record) => record.humanAudit.status === 'disputed').map(taskIdentity));
  records = records.map((record) => {
    if (record.humanAudit.status !== 'not-selected' || !disputedTasks.has(taskIdentity(record))) return record;
    const evidence = evidenceByRun.get(record.evaluationRunId);
    return {
      ...record,
      humanAudit: { status: 'selected-pending', evidenceDigest: auditEntryDigest(evidence) }
    };
  });
  const auditSelection = records.filter((record) => record.humanAudit.status !== 'not-selected').map((record) => record.evaluationRunId);
  const nextAuditSample = { schemaVersion: 1, campaignId: campaign.campaignId, entries: auditSelection.map((runId) => evidenceByRun.get(runId)) };
  validateAuditArtifact(nextAuditSample);
  const nextSampleDigest = `sha256:${sha256(canonicalJson(nextAuditSample))}`;
  const nextSamplePath = `audit-samples/${nextSampleDigest.slice('sha256:'.length)}.json`;
  const decisionPath = `audit-decisions/${decisionDigest.slice('sha256:'.length)}.json`;
  const auditStatus = records.some((record) => record.humanAudit.status === 'selected-pending') ? 'pending' : 'complete';
  const nextCampaign = {
    ...campaign,
    auditSelection,
    auditArtifacts: {
      ...campaign.auditArtifacts,
      sample: { path: nextSamplePath, digest: nextSampleDigest }
    },
    auditDecisionArtifacts: [...campaign.auditDecisionArtifacts, {
      path: decisionPath,
      digest: decisionDigest,
      auditArtifactDigest: decisions.auditArtifactDigest,
      auditor: decisions.auditor
    }],
    auditStatus,
    records,
    summary: summarizeEvaluationRecords(records)
  };
  validateCampaign(nextCampaign);
  return Object.freeze({ campaign: nextCampaign, auditSample: nextAuditSample, decisionDigest, decisionPath, samplePath: nextSamplePath });
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseTask(value, split) {
  exactKeys(value, ['id', 'version', 'category', 'execution', 'permissionMode', 'prompt', 'tools', 'files', 'dirtyFiles', 'expected'], `task in ${split}`, ['dirtyFiles']);
  nonempty(value.id, 'task id');
  positiveInteger(value.version, 'task version');
  nonempty(value.category, 'task category');
  if (value.execution !== 'normal' && value.execution !== 'recover-before-generation') throw new Error(`Task ${value.id} has an invalid execution mode.`);
  if (!['review', 'edit', 'develop'].includes(value.permissionMode)) throw new Error(`Task ${value.id} has an invalid permission mode.`);
  nonempty(value.prompt, 'task prompt');
  stringArray(value.tools, 'task tools');
  stringMap(value.files, 'task files');
  if (value.dirtyFiles !== undefined) stringMap(value.dirtyFiles, 'task dirty files');
  const expected = value.expected;
  parseExpected(expected, `task ${value.id} expected result`);
  if (expected.allowedChangedPaths.some((path) => expected.forbiddenChangedPaths.includes(path))) throw new Error(`Task ${value.id} has contradictory path authority.`);
  return Object.freeze({
    schemaVersion: 1,
    split,
    id: value.id,
    version: value.version,
    category: value.category,
    execution: value.execution,
    permissionMode: value.permissionMode,
    prompt: value.prompt,
    tools: Object.freeze([...value.tools]),
    files: Object.freeze({ ...value.files }),
    ...(value.dirtyFiles === undefined ? {} : { dirtyFiles: Object.freeze({ ...value.dirtyFiles }) }),
    expected: Object.freeze({
      allowedChangedPaths: Object.freeze([...expected.allowedChangedPaths]),
      forbiddenChangedPaths: Object.freeze([...expected.forbiddenChangedPaths]),
      files: Object.freeze({ ...expected.files }),
      absentPaths: Object.freeze([...expected.absentPaths]),
      responseEvidence: Object.freeze(expected.responseEvidence.map((alternative) => Object.freeze([...alternative]))),
      exitCodes: Object.freeze([...expected.exitCodes]),
      ...(expected.requiresAbruptInitialExit === undefined ? {} : { requiresAbruptInitialExit: expected.requiresAbruptInitialExit })
    })
  });
}

function changedFilePaths(before, after) {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths].filter((path) => before[path] !== after[path]).sort();
}

function criterion(id, passed, detail) {
  return Object.freeze({ id, passed, detail: bound(detail, 512) });
}

function distribution(records) {
  const outcomes = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, records.filter((record) => record.outcome === outcome).length]));
  const measured = outcomes.passed + outcomes.failed;
  return Object.freeze({
    runs: records.length,
    outcomes: Object.freeze(outcomes),
    measuredRuns: measured,
    passRate: measured === 0 ? null : outcomes.passed / measured,
    interval: wilsonInterval(outcomes.passed, measured)
  });
}

function groupedDistribution(records, keyOf) {
  const groups = new Map();
  for (const record of records) {
    const key = keyOf(record);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return Object.freeze(Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, values]) => [key, distribution(values)])));
}

function parseBinding(value) {
  exactKeys(value, ['provider', 'model', 'promptRevision', 'toolContractRevision', 'policyRevision', 'sandbox', 'repositories', 'task', 'repetition'], 'evaluation binding');
  parseProvider(value.provider);
  parseModel(value.model);
  revision(value.promptRevision, 'prompt revision'); revision(value.toolContractRevision, 'tool-contract revision'); revision(value.policyRevision, 'policy revision');
  parseSandbox(value.sandbox);
  parseRepositories(value.repositories);
  exactKeys(value.task, ['id', 'version', 'split', 'category', 'digest'], 'task binding');
  nonempty(value.task.id, 'task id'); positiveInteger(value.task.version, 'task version');
  if (value.task.split !== 'development' && value.task.split !== 'holdout') throw new Error('task split is invalid.');
  nonempty(value.task.category, 'task category'); digest(value.task.digest, 'task digest'); positiveInteger(value.repetition, 'repetition');
}

function parsePublicBinding(value) {
  exactKeys(value, ['repositories', 'provider', 'model', 'promptRevision', 'toolContractRevision', 'policyRevision', 'sandbox', 'campaignPolicyDigest'], 'campaign evaluated revisions');
  parseRepositories(value.repositories);
  parseProvider(value.provider);
  parseModel(value.model);
  revision(value.promptRevision, 'campaign prompt revision');
  revision(value.toolContractRevision, 'campaign tool-contract revision');
  revision(value.policyRevision, 'campaign policy revision');
  parseSandbox(value.sandbox);
  digest(value.campaignPolicyDigest, 'campaign policy digest');
}

function parseProvider(value) {
  exactKeys(value, ['id', 'implementationRevision', 'endpointClass'], 'provider binding');
  nonempty(value.id, 'provider id');
  nonempty(value.implementationRevision, 'provider revision');
  nonempty(value.endpointClass, 'provider endpoint class');
}

function parseModel(value) {
  exactKeys(value, ['id', 'digest', 'modifiedAt'], 'model binding');
  nonempty(value.id, 'model id');
  digest(value.digest, 'model digest');
  isoDate(value.modifiedAt, 'model modifiedAt');
}

function parseSandbox(value) {
  exactKeys(value, ['packageRevision', 'platform', 'backendId', 'backendAvailable', 'probeDigest'], 'sandbox binding');
  commit(value.packageRevision, 'Sandbox revision');
  nonempty(value.platform, 'sandbox platform');
  nonempty(value.backendId, 'sandbox backend');
  if (typeof value.backendAvailable !== 'boolean') throw new Error('sandbox backendAvailable must be boolean.');
  digest(value.probeDigest, 'sandbox probe digest');
}

function parseRepositories(value) {
  exactKeys(value, ['agents', 'agentCore', 'sandbox', 'terminalUi'], 'repository binding');
  for (const [name, revisionValue] of Object.entries(value)) commit(revisionValue, `${name} revision`);
}

function parseRegressionPolicy(value) {
  exactKeys(value, ['minimumPassRateDecline', 'requireNonOverlappingIntervals', 'dimensions'], 'regression policy');
  if (typeof value.minimumPassRateDecline !== 'number' || !Number.isFinite(value.minimumPassRateDecline) || value.minimumPassRateDecline <= 0 || value.minimumPassRateDecline > 1) throw new Error('Regression minimum pass-rate decline is invalid.');
  if (typeof value.requireNonOverlappingIntervals !== 'boolean') throw new Error('Regression interval policy is invalid.');
  stringArray(value.dimensions, 'regression dimensions');
}

function parseHumanAuditPolicy(value) {
  exactKeys(value, ['minimumRuns', 'minimumFraction', 'stratifyBy', 'disagreementOutcome', 'expandDisputedTaskToAllRuns'], 'human-audit policy');
  positiveInteger(value.minimumRuns, 'human-audit minimum runs');
  if (typeof value.minimumFraction !== 'number' || !Number.isFinite(value.minimumFraction) || value.minimumFraction <= 0 || value.minimumFraction > 1) throw new Error('Human-audit minimum fraction is invalid.');
  stringArray(value.stratifyBy, 'human-audit strata');
  if (value.disagreementOutcome !== 'disputed') throw new Error('Human-audit disagreement outcome is invalid.');
  if (value.expandDisputedTaskToAllRuns !== true) throw new Error('Human-audit dispute expansion must be enabled.');
}

function parseArtifactReference(value, label) {
  exactKeys(value, ['path', 'digest'], label);
  relativePath(value.path, `${label} path`);
  digest(value.digest, `${label} digest`);
}

function parseAuditor(value) {
  exactKeys(value, ['identity', 'completedAt', 'attestation'], 'human auditor');
  nonempty(value.identity, 'human auditor identity');
  isoDate(value.completedAt, 'human audit completion time');
  nonempty(value.attestation, 'human auditor attestation');
}

function taskIdentity(record) {
  const task = record.binding.task;
  return `${task.split}:${task.id}@${String(task.version)}`;
}

function sameMembers(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function revision(value, label) {
  exactKeys(value, ['digest', 'inputs'], label);
  digest(value.digest, `${label} digest`);
  if (!Array.isArray(value.inputs) || value.inputs.length === 0) throw new Error(`${label} inputs must be non-empty.`);
  for (const input of value.inputs) {
    exactKeys(input, ['repository', 'path', 'sha256'], `${label} input`);
    nonempty(input.repository, `${label} repository`); nonempty(input.path, `${label} path`); digest(input.sha256, `${label} input digest`);
  }
}

function parseExecution(value) {
  exactKeys(value, ['mode', 'permissionMode', 'startedAt', 'elapsedMs', 'exitCode', 'signal', 'abruptInitialExit', 'terminal', 'ledgerSha256', 'changeReportSha256', 'stdoutSha256', 'stderrSha256'], 'execution evidence');
  if (value.mode !== 'normal' && value.mode !== 'recover-before-generation') throw new Error('execution mode is invalid.');
  if (!['review', 'edit', 'develop'].includes(value.permissionMode)) throw new Error('permission mode is invalid.');
  isoDate(value.startedAt, 'execution start'); nonnegative(value.elapsedMs, 'elapsedMs');
  if (value.exitCode !== null && !Number.isSafeInteger(value.exitCode)) throw new Error('exitCode is invalid.');
  if (value.signal !== null && typeof value.signal !== 'string') throw new Error('signal is invalid.');
  if (typeof value.abruptInitialExit !== 'boolean') throw new Error('abruptInitialExit is invalid.');
  parseTerminal(value.terminal);
  for (const key of ['ledgerSha256', 'changeReportSha256', 'stdoutSha256', 'stderrSha256']) digest(value[key], key);
}

function parseTerminal(value) {
  if (value === null) return;
  exactKeys(value, ['executionStatus', 'candidateStatus', 'verificationStatus'], 'terminal evidence');
  nonempty(value.executionStatus, 'terminal executionStatus');
  nonempty(value.candidateStatus, 'terminal candidateStatus');
  nonempty(value.verificationStatus, 'terminal verificationStatus');
}

function parseExpected(expected, label) {
  exactKeys(expected, ['allowedChangedPaths', 'forbiddenChangedPaths', 'files', 'absentPaths', 'responseEvidence', 'exitCodes', 'requiresAbruptInitialExit'], label, ['requiresAbruptInitialExit']);
  stringArray(expected.allowedChangedPaths, 'allowed changed paths');
  stringArray(expected.forbiddenChangedPaths, 'forbidden changed paths');
  if (expected.allowedChangedPaths.some((path) => expected.forbiddenChangedPaths.includes(path))) throw new Error(`${label} has contradictory path authority.`);
  stringMap(expected.files, 'expected files');
  stringArray(expected.absentPaths, 'absent paths');
  if (!Array.isArray(expected.responseEvidence) || expected.responseEvidence.length === 0) throw new Error('Response evidence alternatives must be non-empty.');
  for (const alternative of expected.responseEvidence) {
    if (!Array.isArray(alternative) || alternative.length === 0) throw new Error('Each response evidence alternative must be non-empty.');
    stringArray(alternative, 'response evidence alternative');
  }
  if (!Array.isArray(expected.exitCodes) || expected.exitCodes.length === 0 || expected.exitCodes.some((code) => !Number.isSafeInteger(code))) throw new Error(`${label} has invalid exit codes.`);
  if (expected.requiresAbruptInitialExit !== undefined && typeof expected.requiresAbruptInitialExit !== 'boolean') throw new Error(`${label} has an invalid recovery expectation.`);
}

function parseUsage(value) {
  exactKeys(value, ['promptTokens', 'completionTokens', 'totalTokens'], 'usage');
  nonnegative(value.promptTokens, 'promptTokens'); nonnegative(value.completionTokens, 'completionTokens'); nonnegative(value.totalTokens, 'totalTokens');
  if (value.totalTokens !== value.promptTokens + value.completionTokens) throw new Error('totalTokens must equal promptTokens plus completionTokens.');
}

function parseCost(value) {
  exactKeys(value, ['amount', 'currency', 'basis'], 'cost');
  if (typeof value.amount !== 'number' || !Number.isFinite(value.amount) || value.amount < 0) throw new Error('cost amount is invalid.');
  nonempty(value.currency, 'cost currency'); nonempty(value.basis, 'cost basis');
}

function parseGrade(value) {
  exactKeys(value, ['graderId', 'graderVersion', 'outcome', 'criteria', 'changedPaths', 'forbiddenMutationObserved'], 'grade');
  nonempty(value.graderId, 'grader id'); positiveInteger(value.graderVersion, 'grader version');
  if (!OUTCOMES.includes(value.outcome)) throw new Error('grade outcome is invalid.');
  if (!Array.isArray(value.criteria)) throw new Error('grade criteria must be an array.');
  for (const item of value.criteria) {
    exactKeys(item, ['id', 'passed', 'detail'], 'grade criterion');
    nonempty(item.id, 'criterion id'); if (typeof item.passed !== 'boolean') throw new Error('criterion passed must be boolean.'); nonempty(item.detail, 'criterion detail');
  }
  stringArray(value.changedPaths, 'changed paths');
  if (typeof value.forbiddenMutationObserved !== 'boolean') throw new Error('forbiddenMutationObserved must be boolean.');
}

function parseHumanAudit(value) {
  exactKeys(value, ['status', 'evidenceDigest', 'decisionDigest'], 'human audit', ['evidenceDigest', 'decisionDigest']);
  if (!['not-selected', 'selected-pending', 'agreed', 'disputed'].includes(value.status)) throw new Error('human audit status is invalid.');
  if (value.status === 'not-selected') {
    if (value.evidenceDigest !== undefined || value.decisionDigest !== undefined) throw new Error('A non-selected human audit cannot bind audit evidence.');
    return;
  }
  digest(value.evidenceDigest, 'human audit evidence digest');
  if (value.status === 'selected-pending') {
    if (value.decisionDigest !== undefined) throw new Error('A pending human audit cannot bind a decision.');
    return;
  }
  digest(value.decisionDigest, 'human audit decision digest');
}

function validateAuditEntry(entry) {
  exactKeys(entry, ['evaluationRunId', 'task', 'terminal', 'machineGrade', 'stdoutSha256', 'candidateOutputExcerpt'], 'audit entry');
  nonempty(entry.evaluationRunId, 'audit entry evaluationRunId');
  exactKeys(entry.task, ['id', 'version', 'split', 'category', 'prompt', 'expected'], 'audit entry task');
  nonempty(entry.task.id, 'audit task id');
  positiveInteger(entry.task.version, 'audit task version');
  if (entry.task.split !== 'development' && entry.task.split !== 'holdout') throw new Error('Audit task split is invalid.');
  nonempty(entry.task.category, 'audit task category');
  nonempty(entry.task.prompt, 'audit task prompt');
  parseExpected(entry.task.expected, `audit task ${entry.task.id} expected result`);
  parseTerminal(entry.terminal);
  parseGrade(entry.machineGrade);
  digest(entry.stdoutSha256, 'audit stdout digest');
  if (typeof entry.candidateOutputExcerpt !== 'string') throw new Error('Audit candidate output excerpt must be a string.');
  return entry;
}

function exactKeys(value, required, label, optional = []) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !optional.includes(key) && !(key in value));
  if (unknown.length > 0 || missing.length > 0) throw new Error(`${label} has invalid fields: unknown=${unknown.join(',') || 'none'} missing=${missing.join(',') || 'none'}.`);
}

function stringMap(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.values(value).some((item) => typeof item !== 'string')) throw new Error(`${label} must be a string map.`);
  for (const path of Object.keys(value)) relativePath(path, `${label} path`);
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) throw new Error(`${label} must be a non-empty-string array.`);
}

function relativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.split(/[\\/]/u).includes('..')) throw new Error(`${label} must be confined and relative.`);
}

function nonempty(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string.`);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
}

function nonnegative(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
}

function digest(value, label) {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} must be a sha256 digest.`);
}

function commit(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/u.test(value)) throw new Error(`${label} must be a full Git commit.`);
}

function isoDate(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${label} must be a canonical ISO timestamp.`);
}

function bound(value, maximum) {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 3)}...`;
}

function rate(value) { return value === null ? 'not measured' : `${(value * 100).toFixed(1)}%`; }
function interval(value) { return value.lower === null ? 'not measured' : `${(value.lower * 100).toFixed(1)}%–${(value.upper * 100).toFixed(1)}%`; }

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
  const responseMatched = task.expected.responseAnyOf.some((value) => normalizedOutput.includes(value.toLowerCase()));
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
      outcome: record.grade.outcome,
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
  lines.push('', '## Individual outcomes', '', '| Run | Split | Task | Repetition | Outcome | Human audit |', '| --- | --- | --- | ---: | --- | --- |');
  for (const value of campaign.summary.individualOutcomes) lines.push(`| ${value.evaluationRunId} | ${value.split} | ${value.taskId} | ${value.repetition} | ${value.outcome} | ${value.humanAudit} |`);
  lines.push('', 'Human audit is pending for the selected sample. These stochastic outcomes are not blocking CI assertions.', '');
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
  exactKeys(record, ['schemaVersion', 'campaignId', 'evaluationRunId', 'recordedAt', 'binding', 'execution', 'usage', 'cost', 'grade', 'humanAudit'], 'evaluation record');
  if (record.schemaVersion !== EVALUATION_SCHEMA_VERSION) throw new Error('Evaluation record must use schema version 1.');
  nonempty(record.campaignId, 'campaignId');
  nonempty(record.evaluationRunId, 'evaluationRunId');
  isoDate(record.recordedAt, 'recordedAt');
  parseBinding(record.binding);
  parseExecution(record.execution);
  parseUsage(record.usage);
  parseCost(record.cost);
  parseGrade(record.grade);
  parseHumanAudit(record.humanAudit);
  return record;
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
  exactKeys(expected, ['allowedChangedPaths', 'forbiddenChangedPaths', 'files', 'absentPaths', 'responseAnyOf', 'exitCodes', 'requiresAbruptInitialExit'], `task ${value.id} expected result`, ['requiresAbruptInitialExit']);
  stringArray(expected.allowedChangedPaths, 'allowed changed paths');
  stringArray(expected.forbiddenChangedPaths, 'forbidden changed paths');
  if (expected.allowedChangedPaths.some((path) => expected.forbiddenChangedPaths.includes(path))) throw new Error(`Task ${value.id} has contradictory path authority.`);
  stringMap(expected.files, 'expected files');
  stringArray(expected.absentPaths, 'absent paths');
  stringArray(expected.responseAnyOf, 'response evidence terms');
  if (!Array.isArray(expected.exitCodes) || expected.exitCodes.length === 0 || expected.exitCodes.some((code) => !Number.isSafeInteger(code))) throw new Error(`Task ${value.id} has invalid exit codes.`);
  if (expected.requiresAbruptInitialExit !== undefined && typeof expected.requiresAbruptInitialExit !== 'boolean') throw new Error(`Task ${value.id} has an invalid recovery expectation.`);
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
      responseAnyOf: Object.freeze([...expected.responseAnyOf]),
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
  const outcomes = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, records.filter((record) => record.grade.outcome === outcome).length]));
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
  exactKeys(value.provider, ['id', 'implementationRevision', 'endpointClass'], 'provider binding');
  nonempty(value.provider.id, 'provider id'); nonempty(value.provider.implementationRevision, 'provider revision'); nonempty(value.provider.endpointClass, 'provider endpoint class');
  exactKeys(value.model, ['id', 'digest', 'modifiedAt'], 'model binding');
  nonempty(value.model.id, 'model id'); digest(value.model.digest, 'model digest'); isoDate(value.model.modifiedAt, 'model modifiedAt');
  revision(value.promptRevision, 'prompt revision'); revision(value.toolContractRevision, 'tool-contract revision'); revision(value.policyRevision, 'policy revision');
  exactKeys(value.sandbox, ['packageRevision', 'platform', 'backendId', 'backendAvailable', 'probeDigest'], 'sandbox binding');
  commit(value.sandbox.packageRevision, 'Sandbox revision'); nonempty(value.sandbox.platform, 'sandbox platform'); nonempty(value.sandbox.backendId, 'sandbox backend');
  if (typeof value.sandbox.backendAvailable !== 'boolean') throw new Error('sandbox backendAvailable must be boolean.');
  digest(value.sandbox.probeDigest, 'sandbox probe digest');
  exactKeys(value.repositories, ['agents', 'agentCore', 'sandbox', 'terminalUi'], 'repository binding');
  for (const [name, revisionValue] of Object.entries(value.repositories)) commit(revisionValue, `${name} revision`);
  exactKeys(value.task, ['id', 'version', 'split', 'category', 'digest'], 'task binding');
  nonempty(value.task.id, 'task id'); positiveInteger(value.task.version, 'task version');
  if (value.task.split !== 'development' && value.task.split !== 'holdout') throw new Error('task split is invalid.');
  nonempty(value.task.category, 'task category'); digest(value.task.digest, 'task digest'); positiveInteger(value.repetition, 'repetition');
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
  if (value.terminal !== null) {
    exactKeys(value.terminal, ['executionStatus', 'candidateStatus', 'verificationStatus'], 'terminal evidence');
    nonempty(value.terminal.executionStatus, 'terminal executionStatus');
    nonempty(value.terminal.candidateStatus, 'terminal candidateStatus');
    nonempty(value.terminal.verificationStatus, 'terminal verificationStatus');
  }
  for (const key of ['ledgerSha256', 'changeReportSha256', 'stdoutSha256', 'stderrSha256']) digest(value[key], key);
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
  exactKeys(value, ['status'], 'human audit');
  if (!['not-selected', 'selected-pending', 'agreed', 'disputed'].includes(value.status)) throw new Error('human audit status is invalid.');
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

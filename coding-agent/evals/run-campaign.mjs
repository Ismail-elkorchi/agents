import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createSandbox } from '@ismail-elkorchi/sandbox';
import {
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
  validateEvaluationRecord
} from './evaluation.mjs';

const runFile = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const agentCoreRoot = path.resolve(repositoryRoot, '../agent-core');
const sandboxRoot = path.resolve(repositoryRoot, '../sandbox');
const terminalUiRoot = path.resolve(repositoryRoot, '../terminal-ui');
const cli = path.join(repositoryRoot, 'coding-agent/dist/index.js');
const developmentTasksPath = path.join(import.meta.dirname, 'tasks/development.json');
const holdoutTasksPath = path.join(import.meta.dirname, 'tasks/holdout.json');
const policyPath = path.join(import.meta.dirname, 'policy.json');

const options = parseArguments(process.argv.slice(2));
const policy = JSON.parse(await readFile(policyPath, 'utf8'));
const campaignId = options.campaignId ?? `campaign-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`;
const outputDirectory = path.resolve(options.output ?? path.join(import.meta.dirname, 'results', campaignId));

await requireNewOutputDirectory(outputDirectory);
const revisions = await captureFixedRevisions(options, policy);
const developmentTasks = await loadTaskCorpus([developmentTasksPath]);
// Holdout bodies are loaded only after every evaluated product and contract revision is fixed.
const holdoutTasks = await loadTaskCorpus([holdoutTasksPath]);
const selectedTasks = [...developmentTasks, ...holdoutTasks].filter((task) =>
  (options.split === undefined || task.split === options.split)
  && (options.taskIds.length === 0 || options.taskIds.includes(task.id))
);
if (selectedTasks.length === 0) throw new Error('No evaluation tasks match the selected filters.');

const proxy = await createOllamaProxy(options.endpoint);
const records = [];
const auditEvidence = new Map();
try {
  for (const task of selectedTasks) {
    for (let repetition = 1; repetition <= options.runs; repetition += 1) {
      process.stderr.write(`[${task.split}] ${task.id} ${String(repetition)}/${String(options.runs)}\n`);
      records.push(await runEvaluation({ campaignId, task, repetition, proxy, options, revisions, auditEvidence }));
    }
    const initial = records.filter((record) => record.binding.task.id === task.id && record.binding.task.split === task.split);
    const measuredOutcomes = new Set(initial.map((record) => record.grade.outcome).filter((outcome) => outcome === 'passed' || outcome === 'failed'));
    if (measuredOutcomes.size > 1 && options.runs < policy.mixedOutcomeExpansionRuns) {
      for (let repetition = options.runs + 1; repetition <= policy.mixedOutcomeExpansionRuns; repetition += 1) {
        process.stderr.write(`[${task.split}] ${task.id} mixed-outcome expansion ${String(repetition)}/${String(policy.mixedOutcomeExpansionRuns)}\n`);
        records.push(await runEvaluation({ campaignId, task, repetition, proxy, options, revisions, auditEvidence }));
      }
    }
  }
} finally {
  await proxy.close();
}

const selectedRunIds = new Set(selectHumanAuditSample(records, policy.humanAudit));
const evidenceEntries = records.map((record) => auditEvidence.get(record.evaluationRunId));
if (evidenceEntries.some((entry) => entry === undefined)) throw new Error('Retained human-audit evidence is incomplete.');
const evidenceArtifact = { schemaVersion: 1, campaignId, entries: evidenceEntries };
validateAuditArtifact(evidenceArtifact);
const auditSelection = records.filter((record) => selectedRunIds.has(record.evaluationRunId)).map((record) => record.evaluationRunId);
const sampleArtifact = { schemaVersion: 1, campaignId, entries: auditSelection.map((evaluationRunId) => auditEvidence.get(evaluationRunId)) };
validateAuditArtifact(sampleArtifact);
const evidenceArtifactDigest = digest(canonicalJson(evidenceArtifact));
const sampleArtifactDigest = digest(canonicalJson(sampleArtifact));
const sampleArtifactPath = `audit-samples/${sampleArtifactDigest.slice('sha256:'.length)}.json`;
const boundRecords = records.map((record) => {
  const selected = selectedRunIds.has(record.evaluationRunId);
  const bound = {
    ...record,
    humanAudit: selected
      ? { status: 'selected-pending', evidenceDigest: auditEntryDigest(auditEvidence.get(record.evaluationRunId)) }
      : { status: 'not-selected' }
  };
  validateEvaluationRecord(bound);
  return bound;
});
const summary = summarizeEvaluationRecords(boundRecords);
const campaign = {
  schemaVersion: 1,
  campaignId,
  createdAt: new Date().toISOString(),
  evaluatedRevisions: revisions.publicBinding,
  sampling: {
    requestedRunsPerTask: options.runs,
    tasks: selectedTasks.length,
    plannedRuns: selectedTasks.length * options.runs,
    mixedOutcomeExpansionRuns: policy.mixedOutcomeExpansionRuns
  },
  inference: {
    maxOutputTokens: options.maxOutputTokens,
    temperature: options.temperature,
    reasoningMode: options.reasoningMode,
    timeoutMs: options.timeoutMs
  },
  regressionPolicy: policy.regression,
  humanAuditPolicy: policy.humanAudit,
  holdoutPolicy: policy.holdout,
  auditSelection,
  auditArtifacts: {
    sample: { path: sampleArtifactPath, digest: sampleArtifactDigest },
    evidence: { path: 'audit-evidence.json', digest: evidenceArtifactDigest }
  },
  auditDecisionArtifacts: [],
  auditStatus: 'pending',
  records: boundRecords,
  summary
};
validateCampaign(campaign);
await mkdir(outputDirectory, { recursive: true });
await mkdir(path.join(outputDirectory, 'audit-samples'), { recursive: true });
await writeFile(path.join(outputDirectory, sampleArtifactPath), `${JSON.stringify(sampleArtifact, null, 2)}\n`, { mode: 0o600 });
await writeFile(path.join(outputDirectory, 'audit-evidence.json'), `${JSON.stringify(evidenceArtifact, null, 2)}\n`, { mode: 0o600 });
await writeFile(path.join(outputDirectory, 'campaign.json'), `${JSON.stringify(campaign, null, 2)}\n`, { mode: 0o600 });
await writeFile(path.join(outputDirectory, 'report.md'), renderCampaignReport(campaign), { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ campaignId, outputDirectory, runs: boundRecords.length, outcomes: summary.overall.outcomes }, null, 2)}\n`);

async function runEvaluation({ campaignId: currentCampaignId, task, repetition, proxy: providerProxy, options: campaignOptions, revisions: fixed, auditEvidence: evidence }) {
  const parent = await mkdtemp(path.join(tmpdir(), 'coding-agent-real-eval-'));
  const workspace = path.join(parent, 'workspace');
  const stateRoot = path.join(parent, 'state');
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const evaluationRunId = `${task.split}-${task.id}-${String(repetition)}-${randomUUID()}`;
  let abruptInitialExit = false;
  let result = { exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false };
  const runtimeConfiguration = configuration(task, campaignOptions.model, campaignOptions.reasoningMode);
  const taskPolicyRevision = await revisionFromInputs([
    ...fixed.policyRevision.inputs,
    syntheticInput('evaluation', `${task.split}/${task.id}/runtime-configuration.json`, runtimeConfiguration),
    syntheticInput('evaluation', 'campaign-inference.json', {
      maxOutputTokens: campaignOptions.maxOutputTokens,
      temperature: campaignOptions.temperature,
      reasoningMode: campaignOptions.reasoningMode,
      timeoutMs: campaignOptions.timeoutMs
    })
  ]);
  try {
    await mkdir(workspace);
    await writeFiles(workspace, task.files);
    await writeFile(path.join(workspace, 'coding-agent.config.json'), `${JSON.stringify(runtimeConfiguration, null, 2)}\n`);
    await initializeGitRepository(workspace);
    if (task.dirtyFiles) await writeFiles(workspace, task.dirtyFiles);
    const beforeFiles = await snapshotFiles(workspace);
    const trustResult = await spawnCaptured(trustCliArguments(workspace, stateRoot), 60_000);
    if (trustResult.exitCode !== 0) throw new Error(`Failed to trust evaluation workspace: ${trustResult.stderr}`);

    if (task.execution === 'recover-before-generation') {
      providerProxy.blockNextShow();
      const initial = spawnCapturedControllable(cliArguments(workspace, stateRoot, providerProxy.endpoint, campaignOptions,
        ['exec', task.prompt, '--permissions', task.permissionMode]), campaignOptions.timeoutMs);
      await providerProxy.waitForBlockedShow(30_000);
      initial.killAbruptly();
      const interrupted = await initial.result;
      abruptInitialExit = interrupted.signal === 'SIGKILL' || (process.platform === 'win32' && interrupted.exitCode !== 0);
      providerProxy.releaseBlockedShow();
      result = await spawnCaptured(cliArguments(workspace, stateRoot, providerProxy.endpoint, campaignOptions,
        ['exec', '--resume', '--permissions', task.permissionMode]), campaignOptions.timeoutMs);
    } else {
      result = await spawnCaptured(cliArguments(workspace, stateRoot, providerProxy.endpoint, campaignOptions,
        ['exec', task.prompt, '--permissions', task.permissionMode]), campaignOptions.timeoutMs);
    }

    const afterFiles = await snapshotFiles(workspace);
    let grade = gradeTask({ task, beforeFiles, afterFiles, stdout: result.stdout, exitCode: result.exitCode, abruptInitialExit });
    if (result.timedOut) grade = { ...grade, outcome: 'inconclusive' };
    const ledgerPath = matchLine(result.stderr, /^Ledger: (.+)$/mu);
    const changeReportPath = await oneOptionalFile(path.join(stateRoot, 'run-change-reports'));
    const ledgerText = ledgerPath === undefined ? '' : await readFile(ledgerPath, 'utf8').catch(() => '');
    const changeReportText = changeReportPath === undefined ? '' : await readFile(changeReportPath, 'utf8').catch(() => '');
    const usage = usageFromLedger(ledgerText);
    const record = {
      schemaVersion: 1,
      campaignId: currentCampaignId,
      evaluationRunId,
      recordedAt: new Date().toISOString(),
      binding: {
        provider: fixed.provider,
        model: fixed.model,
        promptRevision: fixed.promptRevision,
        toolContractRevision: fixed.toolContractRevision,
        policyRevision: taskPolicyRevision,
        sandbox: fixed.sandbox,
        repositories: fixed.repositories,
        task: { id: task.id, version: task.version, split: task.split, category: task.category, digest: taskDigest(task) },
        repetition
      },
      execution: {
        mode: task.execution,
        permissionMode: task.permissionMode,
        startedAt,
        elapsedMs: Date.now() - start,
        exitCode: result.exitCode,
        signal: result.signal,
        abruptInitialExit,
        terminal: terminalFromOutput(result.stdout),
        ledgerSha256: digest(ledgerText),
        changeReportSha256: digest(changeReportText),
        stdoutSha256: digest(result.stdout),
        stderrSha256: digest(result.stderr)
      },
      usage,
      cost: { amount: 0, currency: 'USD', basis: 'local Ollama inference; electricity and hardware depreciation not measured' },
      outcome: grade.outcome,
      grade,
      humanAudit: { status: 'not-selected' }
    };
    evidence.set(evaluationRunId, auditEntry({ record, task, stdout: result.stdout }));
    validateEvaluationRecord(record);
    return record;
  } catch (error) {
    const record = unavailableRecord({
      campaignId: currentCampaignId,
      evaluationRunId,
      task,
      repetition,
      revisions: fixed,
      startedAt,
      elapsedMs: Date.now() - start,
      abruptInitialExit,
      result,
      diagnostic: error instanceof Error ? error.message : String(error),
      policyRevision: taskPolicyRevision
    });
    evidence.set(evaluationRunId, auditEntry({ record, task, stdout: `${result.stdout}\nCampaign infrastructure: ${error instanceof Error ? error.message : String(error)}` }));
    validateEvaluationRecord(record);
    return record;
  } finally {
    providerProxy.releaseBlockedShow();
    await rm(parent, { recursive: true, force: true });
  }
}

function auditEntry({ record, task, stdout }) {
  return {
    evaluationRunId: record.evaluationRunId,
    task: {
      id: task.id,
      version: task.version,
      split: task.split,
      category: task.category,
      prompt: task.prompt,
      expected: task.expected
    },
    terminal: record.execution.terminal,
    machineGrade: record.grade,
    stdoutSha256: record.execution.stdoutSha256,
    candidateOutputExcerpt: boundedTail(stdout, 6_000)
  };
}

async function captureFixedRevisions(campaignOptions, campaignPolicy) {
  const repositories = {
    agents: await gitHead(repositoryRoot),
    agentCore: await gitHead(agentCoreRoot),
    sandbox: await gitHead(sandboxRoot),
    terminalUi: await gitHead(terminalUiRoot)
  };
  for (const [name, root] of Object.entries({ agents: repositoryRoot, agentCore: agentCoreRoot, sandbox: sandboxRoot, terminalUi: terminalUiRoot })) {
    if ((await gitStatus(root)).length > 0) throw new Error(`${name} must be clean before fixing evaluation revisions.`);
  }
  const model = await modelBinding(campaignOptions.endpoint, campaignOptions.model);
  const promptRevision = await revisionFromPaths([
    source(repositoryRoot, 'agents', 'coding-agent/src/instructions/coding-contract.ts'),
    source(repositoryRoot, 'agents', 'coding-agent/src/workspace/repository-orientation.ts'),
    source(agentCoreRoot, 'agent-core', 'packages/runtime/src/orchestration/model-request.ts')
  ]);
  const toolPaths = [
    source(repositoryRoot, 'agents', 'coding-agent/src/security/permission-mode.ts'),
    ...(await recursiveSources(path.join(agentCoreRoot, 'packages/tools/src'), agentCoreRoot, 'agent-core')),
    ...(await recursiveSources(path.join(agentCoreRoot, 'packages/tools-local/src/tools'), agentCoreRoot, 'agent-core'))
  ];
  const toolContractRevision = await revisionFromPaths(toolPaths);
  const policyRevision = await revisionFromPaths([source(repositoryRoot, 'agents', path.relative(repositoryRoot, policyPath))]);
  const sandboxProbe = await probeSandbox();
  const stableBackend = sandboxProbe.backends.find((backend) => backend.id === 'linux-namespace-v1');
  const sandbox = {
    packageRevision: repositories.sandbox,
    platform: process.platform,
    backendId: stableBackend?.id ?? 'linux-namespace-v1',
    backendAvailable: stableBackend?.available === true,
    probeDigest: digest(canonicalJson(sandboxProbe))
  };
  const provider = {
    id: 'ollama',
    implementationRevision: `${repositories.agentCore}:packages/providers/ollama`,
    endpointClass: loopbackEndpoint(campaignOptions.endpoint) ? 'local-loopback' : 'remote-explicit'
  };
  return {
    repositories,
    provider,
    model,
    promptRevision,
    toolContractRevision,
    policyRevision,
    sandbox,
    publicBinding: { repositories, provider, model, promptRevision, toolContractRevision, policyRevision, sandbox, campaignPolicyDigest: digest(canonicalJson(campaignPolicy)) }
  };
}

function unavailableRecord({ campaignId: currentCampaignId, evaluationRunId, task, repetition, revisions, startedAt, elapsedMs, abruptInitialExit, result, diagnostic, policyRevision }) {
  return {
    schemaVersion: 1,
    campaignId: currentCampaignId,
    evaluationRunId,
    recordedAt: new Date().toISOString(),
    binding: {
      provider: revisions.provider,
      model: revisions.model,
      promptRevision: revisions.promptRevision,
      toolContractRevision: revisions.toolContractRevision,
      policyRevision,
      sandbox: revisions.sandbox,
      repositories: revisions.repositories,
      task: { id: task.id, version: task.version, split: task.split, category: task.category, digest: taskDigest(task) },
      repetition
    },
    execution: {
      mode: task.execution, permissionMode: task.permissionMode, startedAt, elapsedMs,
      exitCode: result.exitCode, signal: result.signal, abruptInitialExit, terminal: null,
      ledgerSha256: digest(''), changeReportSha256: digest(''), stdoutSha256: digest(result.stdout), stderrSha256: digest(result.stderr)
    },
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    cost: { amount: 0, currency: 'USD', basis: 'provider execution unavailable; no API cost observed' },
    outcome: 'unavailable',
    grade: {
      graderId: 'coding-agent.machine-task-grader', graderVersion: 1, outcome: 'unavailable',
      criteria: [{ id: 'campaign-infrastructure', passed: false, detail: diagnostic.slice(0, 512) }],
      changedPaths: [], forbiddenMutationObserved: false
    },
    humanAudit: { status: 'not-selected' }
  };
}

function configuration(task, model, reasoningMode) {
  return {
    version: 1,
    provider: 'ollama',
    model,
    reasoning: { strategy: reasoningMode },
    instructions: [],
    tools: { enabled: task.tools },
    permissions: { maximumMode: task.permissionMode, requireApprovalFor: [] },
    verification: { required: [], advisory: [] },
    limits: {
      maxConcurrentToolCalls: 1,
      modelTurns: 8,
      totalToolCalls: 12,
      repeatedIdenticalToolCalls: 3,
      candidateRevisions: 1,
      elapsedMs: 180000,
      promptTokens: 120000,
      completionTokens: 12000,
      consecutiveProviderFailures: 2,
      consecutiveToolFailures: 3
    }
  };
}

function cliArguments(workspace, stateRoot, endpoint, campaignOptions, command) {
  return [
    process.execPath,
    cli,
    ...command,
    '--root', workspace,
    '--state-root', stateRoot,
    '--config', 'coding-agent.config.json',
    '--provider', 'ollama',
    '--model', campaignOptions.model,
    '--provider-endpoint', endpoint,
    '--max-output-tokens', String(campaignOptions.maxOutputTokens),
    '--temperature', String(campaignOptions.temperature)
  ];
}

function trustCliArguments(workspace, stateRoot) {
  return [process.execPath, cli, 'trust', 'trusted', '--root', workspace, '--state-root', stateRoot];
}

async function initializeGitRepository(workspace) {
  await runFile('git', ['init', '--quiet'], { cwd: workspace });
  await runFile('git', ['config', 'user.email', 'coding-agent-eval@example.invalid'], { cwd: workspace });
  await runFile('git', ['config', 'user.name', 'Coding Agent Evaluation'], { cwd: workspace });
  await runFile('git', ['add', '.'], { cwd: workspace });
  await runFile('git', ['commit', '--quiet', '-m', 'evaluation baseline'], { cwd: workspace });
}

async function writeFiles(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function snapshotFiles(root) {
  const result = {};
  async function visit(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (prefix.length === 0 && entry.name === '.git') continue;
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target, relative);
      else if (entry.isFile()) result[relative] = await readFile(target, 'utf8');
      else result[relative] = `<unsupported:${entry.isSymbolicLink() ? 'symlink' : 'special'}>`;
    }
  }
  await visit(root, '');
  return result;
}

function spawnCaptured(args, timeoutMs) {
  return spawnCapturedControllable(args, timeoutMs).result;
}

function spawnCapturedControllable([executable, ...args], timeoutMs) {
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
  }, timeoutMs);
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
  return { killAbruptly: () => child.kill(process.platform === 'win32' ? undefined : 'SIGKILL'), result };
}

async function createOllamaProxy(upstreamValue) {
  const upstream = new URL(upstreamValue);
  const upstreamRequests = new Set();
  let blockShow = false;
  let blockedResolve;
  let releaseResolve;
  let blocked = Promise.resolve();
  let release = Promise.resolve();
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    const abortUpstream = () => controller.abort();
    upstreamRequests.add(controller);
    response.once('close', abortUpstream);
    try {
      if (request.url === '/api/show' && blockShow) {
        blockShow = false;
        blockedResolve?.();
        await release;
        if (response.destroyed) return;
      }
      const body = await readRequest(request);
      const target = new URL(request.url ?? '/', upstream);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined && !['host', 'connection', 'content-length'].includes(name)) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const upstreamResponse = await fetch(target, { method: request.method, headers, signal: controller.signal, ...(body.length === 0 ? {} : { body }) });
      response.writeHead(upstreamResponse.status, Object.fromEntries(upstreamResponse.headers.entries()));
      if (upstreamResponse.body) for await (const chunk of upstreamResponse.body) response.write(chunk);
      response.end();
    } catch (error) {
      if (!response.destroyed) {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    } finally {
      response.off('close', abortUpstream);
      upstreamRequests.delete(controller);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Ollama evaluation proxy did not bind a TCP port.');
  return {
    endpoint: `http://127.0.0.1:${String(address.port)}`,
    blockNextShow() {
      blockShow = true;
      blocked = new Promise((resolve) => { blockedResolve = resolve; });
      release = new Promise((resolve) => { releaseResolve = resolve; });
    },
    waitForBlockedShow(timeoutMs) { return withTimeout(blocked, timeoutMs, 'Ollama show request was not observed before recovery timeout.'); },
    releaseBlockedShow() { releaseResolve?.(); },
    close: () => {
      for (const controller of upstreamRequests) controller.abort();
      return new Promise((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
        server.closeAllConnections();
      });
    }
  };
}

async function modelBinding(endpoint, modelId) {
  const response = await fetch(new URL('/api/tags', endpoint));
  if (!response.ok) throw new Error(`Ollama tags request failed with ${String(response.status)}.`);
  const value = await response.json();
  const model = Array.isArray(value.models) ? value.models.find((candidate) => candidate.name === modelId || candidate.model === modelId) : undefined;
  if (!model || typeof model.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(model.digest) || typeof model.modified_at !== 'string') {
    throw new Error(`Ollama model ${modelId} is unavailable or has no immutable digest.`);
  }
  return { id: modelId, digest: `sha256:${model.digest}`, modifiedAt: new Date(model.modified_at).toISOString() };
}

async function probeSandbox() {
  const sandbox = await createSandbox();
  try { return await sandbox.probe(); }
  finally { await sandbox.dispose(); }
}

async function revisionFromPaths(sources) {
  const inputs = [];
  for (const item of sources.sort((left, right) => `${left.repository}:${left.path}`.localeCompare(`${right.repository}:${right.path}`))) {
    inputs.push({ repository: item.repository, path: item.path, sha256: digest(await readFile(item.absolutePath)) });
  }
  return revisionFromInputs(inputs);
}

async function revisionFromInputs(inputs) {
  const frozen = inputs.map((input) => ({ repository: input.repository, path: input.path, sha256: input.sha256 }));
  return { digest: digest(canonicalJson(frozen)), inputs: frozen };
}

function syntheticInput(repository, relativePath, value) {
  return { repository, path: relativePath, sha256: digest(canonicalJson(value)) };
}

function source(root, repository, relativePath) {
  return { repository, path: relativePath.replaceAll(path.sep, '/'), absolutePath: path.join(root, relativePath) };
}

async function recursiveSources(directory, root, repository) {
  const sources = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && /\.(?:ts|json)$/u.test(entry.name)) sources.push(source(root, repository, path.relative(root, target)));
    }
  }
  await visit(directory);
  return sources;
}

function usageFromLedger(text) {
  let promptTokens = 0;
  let completionTokens = 0;
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    const usage = value?.event?.type === 'model.responded' ? value.event.response?.usage : undefined;
    if (usage && Number.isFinite(usage.promptTokens) && Number.isFinite(usage.completionTokens)) {
      promptTokens += usage.promptTokens;
      completionTokens += usage.completionTokens;
    }
  }
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

function terminalFromOutput(output) {
  const executionStatus = matchLine(output, /^Execution: (.+)$/mu);
  const candidateStatus = matchLine(output, /^Candidate: (.+)$/mu);
  const verificationStatus = matchLine(output, /^Verification: (.+)$/mu);
  if (executionStatus === undefined && candidateStatus === undefined && verificationStatus === undefined) return null;
  return { executionStatus: executionStatus ?? 'missing', candidateStatus: candidateStatus ?? 'missing', verificationStatus: verificationStatus ?? 'missing' };
}

function boundedTail(value, maximumCharacters) {
  if (value.length <= maximumCharacters) return value;
  return `[earlier output omitted]\n${value.slice(-maximumCharacters)}`;
}

async function oneOptionalFile(directory) {
  let entries;
  try { entries = await readdir(directory); } catch { return undefined; }
  const files = [];
  for (const entry of entries) if ((await stat(path.join(directory, entry))).isFile()) files.push(path.join(directory, entry));
  return files.length === 1 ? files[0] : undefined;
}

async function requireNewOutputDirectory(directory) {
  try {
    await stat(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Campaign output directory already exists: ${directory}`);
}

async function gitHead(root) { return (await runFile('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(); }
async function gitStatus(root) { return (await runFile('git', ['status', '--porcelain'], { cwd: root })).stdout.trim(); }

function digest(value) { return `sha256:${sha256(value)}`; }
function matchLine(value, pattern) { return pattern.exec(value)?.[1]?.trim(); }
function loopbackEndpoint(value) { const host = new URL(value).hostname; return host === '127.0.0.1' || host === 'localhost' || host === '::1'; }

async function readRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]).finally(() => clearTimeout(timer));
}

function parseArguments(args) {
  const parsed = { endpoint: 'http://127.0.0.1:11434', runs: 3, taskIds: [], maxOutputTokens: 2048, temperature: 0.2, reasoningMode: 'disabled', timeoutMs: 240_000 };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];
    if (name === '--model' && value) { parsed.model = value; index += 1; }
    else if (name === '--endpoint' && value) { parsed.endpoint = value; index += 1; }
    else if (name === '--runs' && value) { parsed.runs = positive(value, 'runs'); index += 1; }
    else if (name === '--task' && value) { parsed.taskIds.push(value); index += 1; }
    else if (name === '--split' && (value === 'development' || value === 'holdout')) { parsed.split = value; index += 1; }
    else if (name === '--output' && value) { parsed.output = value; index += 1; }
    else if (name === '--campaign-id' && value) { parsed.campaignId = value; index += 1; }
    else if (name === '--max-output-tokens' && value) { parsed.maxOutputTokens = positive(value, 'max-output-tokens'); index += 1; }
    else if (name === '--temperature' && value && Number.isFinite(Number(value)) && Number(value) >= 0) { parsed.temperature = Number(value); index += 1; }
    else if (name === '--reasoning-mode' && (value === 'disabled' || value === 'enabled')) { parsed.reasoningMode = value; index += 1; }
    else if (name === '--timeout-ms' && value) { parsed.timeoutMs = positive(value, 'timeout-ms'); index += 1; }
    else throw new Error(`Unknown or incomplete evaluation argument: ${name ?? '<missing>'}`);
  }
  if (typeof parsed.model !== 'string' || parsed.model.length === 0) throw new Error('--model is required.');
  return parsed;
}

function positive(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} must be a positive integer.`);
  return number;
}

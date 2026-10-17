import { mkdir, mkdtemp, readFile, writeFile, rename, rm, cp, readdir } from 'node:fs/promises';
import { openSync, writeSync, closeSync, fsyncSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { taskSchema, comparisonSchema, settingsSchema, schedule } from './evaluation-contract.mjs';
import { inventory, unpack, launch, sandboxArgs, runAcceptanceCheck, sha256, readFrozen, runtimeIdentity, execute } from './evaluation-isolation.mjs';
import { verifyBuildPreparation } from './evaluation-build.mjs';
import { codingAgent, providerSocket } from './evaluation-rpc.mjs';
import { EvaluationPhases } from './evaluation-phases.mjs';
import { EvaluationMetrics } from './evaluation-metrics.mjs';
import { acceptanceStatus, pairedReport, providerMeasurements, projectAttempt, comparisonStatus } from './evaluation-report.mjs';

export async function saveJson(file, value) {
  const temporary = `${file}.pending`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  const fd = openSync(temporary, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  await rename(temporary, file);
}

function changedFiles(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter(file => JSON.stringify(before[file]) !== JSON.stringify(after[file]));
}

function executionOutcome(result) {
  if (result?.state !== 'ended') return 'agent_failure';
  if (result.terminal.executionStatus === 'completed')
    return result.terminal.modelOutput.status === 'complete' && !result.deliveryDiagnostics.length ? 'completed' : 'incomplete';
  return /limit|budget/.test(JSON.stringify(result.terminal.terminationReason)) ? 'budget_exhaustion' : 'agent_failure';
}

export async function runAttempt({ task, build, settings, directory, endpoint, signal, providerCleanupPending = false }) {
  task = taskSchema.parse(task);
  settings = settingsSchema.parse(settings);
  const started = performance.now();
  const result = {
    format: 'agents.attempt/2', task: task.id, build: build.label,
    status: 'running', outcome: null, contextMode: task.contextMode,
    providerCleanup: providerCleanupPending ? 'pending' : 'not_required',
    interventions: [], runs: [], acceptance: [], constraintViolations: [],
    humanReview: task.humanReview.map(criterion => ({ criterion, status: 'pending' })),
    measurementErrors: []
  };
  await mkdir(directory, { recursive: false });
  await saveJson(path.join(directory, 'result.json'), result);
  const temporary = await mkdtemp(path.join(tmpdir(), 'agents-task-'));
  const workspace = path.join(temporary, 'workspace');
  const state = path.join(temporary, 'state');
  const metrics = new EvaluationMetrics();
  const events = openSync(path.join(directory, 'events.jsonl'), 'wx', 0o600);
  let app, transport, before, phases, runId, phase = 'infrastructure', processResult;
  try {
    signal?.throwIfAborted();
    if (Object.entries(await runtimeIdentity()).some(([key, value]) => task.environment.runtime[key] !== value))
      throw new Error('Task runtime identity differs from this host.');
    await mkdir(workspace);
    await mkdir(state);
    for (const repository of task.repositories)
      await unpack(repository.snapshot, path.join(workspace, repository.name));
    if (task.environment.overlay) await unpack(task.environment.overlay, workspace);
    if (task.environment.setup) {
      result.environmentSetup = await launch([...sandboxArgs({ workspace }), ...task.environment.setup],
        { timeoutMs: task.limits.wallMs, signal }).done;
      if (result.environmentSetup.code !== 0 || result.environmentSetup.stopped)
        throw new Error('Offline environment setup failed.');
    }
    // Core remains the budget owner. Separate runs receive disjoint portions of
    // the task allowance; corrections within a run do not reset it.
    const runs = 1 + task.checkpoints.filter(point => point.action !== 'steer').length;
    const limits = Object.fromEntries(Object.entries(task.limits).filter(([key]) => key !== 'wallMs')
      .map(([key, value]) => [key, Math.floor(value / runs)]));
    if (Object.values(limits).some(value => value < 1)) throw new Error('Task budget cannot cover its scripted runs.');
    const config = path.join(workspace, 'evaluation.config.json');
    await writeFile(config, JSON.stringify({
      version: 1, provider: settings.provider, model: settings.model,
      instructions: [], tools: { enabled: settings.tools },
      verification: { required: [], advisory: [] },
      limits: { ...limits, elapsedMs: task.limits.wallMs }
    }));
    before = await inventory(workspace);
    phases = new EvaluationPhases(task.constraints.stages, before);
    signal?.throwIfAborted();
    const socket = path.join(temporary, 'provider.sock');
    transport = await providerSocket({ endpoint, socket, model: settings.model,
      maxOutputTokens: settings.maxOutputTokens, maxRequests: task.limits.modelTurns, signal });
    const queue = [];
    let wake;
    app = codingAgent({ workspace, state, build: build.directory, socket, settings, signal,
      timeoutMs: Math.max(1, task.limits.wallMs - (performance.now() - started)),
      onEvent(type, event) {
        writeSync(events, JSON.stringify({ observedAt: new Date().toISOString(), type, event }) + '\n');
        if (type === 'run.progress') {
          metrics.record(event.event);
          phases.record(event.event);
          if (event.event.type === 'run.configured')
            (result.effectiveConfigurations ??= []).push(event.event.configuration);
          if (event.event.type === 'run.configured' && task.environment.contextTokens &&
              event.event.configuration.model.limits.contextTokens !== task.environment.contextTokens)
            result.measurementErrors.push('Observed model context bound differs from the task environment.');
        }
        if (type === 'delivery.gap') {
          phases.gap('RPC delivery gap');
          result.measurementErrors.push('RPC delivery gap; evidence is incomplete.');
        }
        queue.push({ type, event });
        wake?.();
      }
    });
    app.done.then(value => { processResult = value; queue.push({ type: 'process.closed' }); wake?.(); });
    const ready = await app.request('application.read');
    if (ready.status !== 'ready') throw new Error(`Application not ready: ${ready.status}`);
    result.application = ready;
    phase = 'agent';
    const prompt = `${task.instructions}\n\nEnvironment: ${task.environment.description}\n` +
      `Starting snapshots (no Git history): ${task.repositories.map(repo => `${repo.name} at ${repo.revision}`).join(', ')}.\n` +
      `Network: ${task.network}; no Internet or dependency downloads.`;
    const receipt = await app.request('input.submit', { task: prompt });
    if (receipt.kind !== 'started') throw new Error(`Submission ${receipt.kind}`);
    runId = receipt.runId;
    const follows = [];
    const counts = new Map(), triggered = new Set();
    for (;;) {
      if (!queue.length) await new Promise(resolve => { wake = resolve; });
      wake = undefined;
      const item = queue.shift();
      if (item.type === 'process.closed') throw new Error('Application process exited before completion.');
      const event = item.type === 'run.progress' ? item.event.event : item.event;
      for (const checkpoint of task.checkpoints) {
        if (triggered.has(checkpoint.id) || event?.type !== checkpoint.after.type ||
            (checkpoint.after.toolName && event.toolName !== checkpoint.after.toolName)) continue;
        const count = (counts.get(checkpoint.id) ?? 0) + 1;
        counts.set(checkpoint.id, count);
        if (count !== checkpoint.after.occurrence) continue;
        triggered.add(checkpoint.id);
        const intervention = { id: checkpoint.id, action: checkpoint.action, after: checkpoint.after,
          observedRunId: runId, instruction: checkpoint.instruction };
        result.interventions.push(intervention);
        if (checkpoint.action === 'steer')
          intervention.receipt = await app.request('input.steer', { expectedRunId: runId, input: { task: checkpoint.instruction } });
        else if (checkpoint.action === 'abort-follow') {
          follows.push(checkpoint.instruction);
          intervention.receipt = await app.request('run.abort', { runId, reason: `Evaluation checkpoint: ${checkpoint.id}` });
        } else follows.push(checkpoint.instruction);
      }
      if (item.type === 'run.failed') throw new Error(item.event.error.message);
      if (item.type !== 'run.completed') continue;
      result.runs.push(item.event.result);
      if (item.event.result.deliveryDiagnostics?.length) phases.gap('Run delivery diagnostics reported incomplete evidence.');
      phase = 'artifact';
      phases.completeRun(runId, await inventory(workspace));
      result.phaseEvidence = phases.toJSON();
      runId = undefined;
      phase = 'agent';
      await saveJson(path.join(directory, 'result.json'), result);
      if (follows.length) {
        const accepted = await app.request('input.submit', { task: follows.shift() });
        if (accepted.kind !== 'started') throw new Error(`Follow-up ${accepted.kind}`);
        runId = accepted.runId;
        continue;
      }
      result.execution = executionOutcome(item.event.result);
      if (result.runs.some(run => executionOutcome(run) !== 'completed' &&
          !(run.terminal?.executionStatus === 'aborted' && result.interventions.some(intervention => intervention.action === 'abort-follow' &&
            intervention.observedRunId === run.terminal?.runId))))
        result.execution = result.runs.some(run => executionOutcome(run) === 'budget_exhaustion') ? 'budget_exhaustion'
          : result.runs.some(run => executionOutcome(run) === 'incomplete') ? 'incomplete' : 'agent_failure';
      result.missingCheckpoints = task.checkpoints.filter(point => !triggered.has(point.id)).map(point => point.id);
      for (const intervention of result.interventions) {
        if (intervention.action === 'abort-follow')
          intervention.interrupted = intervention.receipt === true && result.runs.some(run =>
            run.terminal?.runId === intervention.observedRunId && run.terminal.executionStatus === 'aborted');
      }
      break;
    }
    await app.request('application.shutdown');
    processResult = await app.done;
    if (processResult.code !== 0 || processResult.signal || processResult.stopped || processResult.error)
      throw new Error('Application shutdown did not exit cleanly: ' + JSON.stringify(processResult));
    // Namespace exit is the boundary: no candidate process survives into checks.
    phase = 'artifact';
    const after = await inventory(workspace);
    result.changedFiles = changedFiles(before, after);
    result.constraintViolations = result.changedFiles.filter(file =>
      !task.constraints.writable.some(allowed => file === allowed || (allowed.endsWith('/') && file.startsWith(allowed))));
    await cp(workspace, path.join(directory, 'artifact'), { recursive: true, verbatimSymlinks: true });
    result.artifactSha256 = sha256(JSON.stringify(after));
    phase = 'evaluator';
    for (const check of task.acceptance) {
      const checkRoot = path.join(temporary, `check-${result.acceptance.length}`);
      const checkWorkspace = path.join(checkRoot, 'workspace');
      const verifier = path.join(checkRoot, 'verifier');
      await cp(workspace, checkWorkspace, { recursive: true, verbatimSymlinks: true });
      await unpack(check.verifier, verifier);
      const observed = await runAcceptanceCheck({ workspace: checkWorkspace, verifier, check, signal });
      result.acceptance.push({
        id: check.id, description: check.description,
        status: acceptanceStatus(observed),
        process: observed
      });
    }
  } catch (error) {
    result.error = error.message;
    result.failurePhase = phase;
    if (phase === 'artifact' && error.code === 'INVALID_ARTIFACT') result.invalidArtifact = true;
  } finally {
    if (app) {
      app.stop('cleanup');
      processResult = await app.done;
      result.process = processResult;
    }
    if (phases && runId) {
      try { phases.completeRun(runId, await inventory(workspace), { complete: false }); }
      catch (error) {
        phases.gap('Partial artifact inspection: ' + error.message);
        if (error.code === 'INVALID_ARTIFACT') result.invalidArtifact = true;
        else (result.cleanupErrors ??= []).push('Partial artifact inspection: ' + error.message);
      }
    }
    if (phases) result.phaseEvidence = phases.toJSON();
    result.cancelled = Boolean(signal?.aborted);
    result.metrics = metrics.toJSON();
    if (transport) {
      try { await transport.close(); }
      catch (error) {
        (result.cleanupErrors ??= []).push(`Transport teardown: ${error.message}`);
      }
      result.measurements = providerMeasurements(transport.receipts, transport.metadataRequests);
      if (result.measurements.usageSource !== 'provider') {
        result.measurementErrors.push('Provider usage is unavailable or partial; consumption is not fully measured.');
      }
      if (transport.receipts.length !== result.metrics.generationRequests) {
        result.measurementErrors.push('Provider request count differs from Core request events; runtime attribution is incomplete.');
      }
      result.providerAdmissionClosedReason = transport.admissionClosedReason;

    }
    // Preserve partial source and normal application state even on killed attempts.
    const cleanup = [
      ['Partial artifact', async () => {
        if (!result.artifactSha256) await cp(workspace, path.join(directory, 'partial-artifact'), { recursive: true, verbatimSymlinks: true });
      }],
      ['Application state', () => cp(state, path.join(directory, 'state'), { recursive: true, verbatimSymlinks: true })],
      ['Event persistence', () => { try { fsyncSync(events); } finally { closeSync(events); } }],
      ['Workspace teardown', () => rm(temporary, { recursive: true, force: true })]
    ];
    for (const [label, operation] of cleanup) {
      try { await operation(); }
      catch (error) {
        (result.cleanupErrors ??= []).push(`${label}: ${error.message}`);
      }
    }
    result.elapsedMs = performance.now() - started;
    result.status = 'finished';
    Object.assign(result, projectAttempt(result));
    await saveJson(path.join(directory, 'result.json'), result);
  }
  return result;
}

export async function runComparison(input, { output, provider, signal } = {}) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  output = path.resolve(output);
  const comparison = comparisonSchema.parse(input);
  const tasks = await Promise.all(comparison.tasks.map(async file =>
    taskSchema.parse(JSON.parse(await readFile(file, 'utf8')))));
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error('Duplicate task IDs.');
  if (comparison.builds[0].label === comparison.builds[1].label) throw new Error('Duplicate build labels.');
  const verified = new Map();
  const builds = await Promise.all(comparison.builds.map(build => {
    const key = JSON.stringify([path.resolve(build.directory), build.sha256]);
    if (!verified.has(key)) verified.set(key, verifyBuildPreparation(build));
    return verified.get(key);
  }));
  const runtime = await runtimeIdentity();
  if (builds.some(build => Object.entries(runtime).some(([key, value]) => build[key] !== value)))
    throw new Error('Build runtime identity differs from this host.');
  if (comparison.purpose !== 'machinery-qualification' && builds.some(build => build.qualification))
    throw new Error('Uncommitted qualification builds cannot establish revision comparisons.');
  for (const task of tasks) for (const check of task.acceptance) await readFrozen(check.verifier);
  await mkdir(output, { recursive: false });
  // A result bundle owns its exact inputs, including a dirty qualification build.
  // It remains reproducible after preparation directories disappear.
  const inputs = path.join(output, 'inputs');
  await mkdir(inputs);
  const evaluator = path.join(inputs, 'evaluator');
  await mkdir(evaluator);
  const sourceDirectory = fileURLToPath(new URL('./', import.meta.url));
  for (const file of await readdir(sourceDirectory))
    if (file.endsWith('.mjs') && /^(evaluation-|coding-agent-evaluation|continuation-comparison|prepare-evaluation|project-tasks|qualify-)/.test(file))
      await cp(path.join(sourceDirectory, file), path.join(evaluator, file));
  await cp(path.join(sourceDirectory, 'fixtures'), path.join(evaluator, 'fixtures'), { recursive: true });
  await cp(path.resolve(sourceDirectory, '../coding-agent/test/fixtures/scripted-cli.js'), path.join(evaluator, 'scripted-cli.js'));
  await mkdir(path.join(inputs, 'scripts'));
  await cp(path.resolve(sourceDirectory, '../scripts/pack-packages.mjs'), path.join(inputs, 'scripts/pack-packages.mjs'));
  const copied = new Map();
  for (const build of comparison.builds) {
    const destination = path.join(inputs, `build-${build.sha256}`);
    if (!copied.has(destination)) {
      await cp(build.directory, destination, { recursive: true, verbatimSymlinks: true });
      await cp(`${build.directory}.preparation`, `${destination}.preparation`, { recursive: true, verbatimSymlinks: true });
      await verifyBuildPreparation({ ...build, directory: destination });
    }
    copied.set(destination, true);
    build.directory = destination;
  }
  comparison.tasks = [];
  for (const task of tasks) {
    const frozen = [...task.repositories.map(repo => repo.snapshot), ...task.acceptance.map(check => check.verifier),
      ...(task.environment.overlay ? [task.environment.overlay] : [])];
    for (const input of frozen) {
      const destination = path.join(inputs, `${input.sha256}.tar`);
      if (!copied.has(destination)) await writeFile(destination, await readFrozen(input), { mode: 0o600 });
      copied.set(destination, true);
      input.path = destination;
    }
    const taskFile = path.join(inputs, `${task.id}.json`);
    await saveJson(taskFile, task);
    comparison.tasks.push(taskFile);
  }
  await saveJson(path.join(output, 'manifest.json'), comparison);
  const plan = schedule(comparison, tasks);
  const report = {
    format: 'agents.comparison-result/2', startedAt, preparationMs: performance.now() - started,
    comparison, builds, tasks, status: 'running', evaluatorFiles: await inventory(evaluator),
    hostEnvironment: {
      runtime,
      osRelease: await readFile('/etc/os-release', 'utf8'),
      bubblewrap: (await execute('bwrap', ['--version'])).stdout.trim(),
      tar: (await execute('tar', ['--version'])).stdout.split('\n')[0]
    },
    order: plan.map(item => ({ task: item.task.id, repetition: item.repetition, order: item.order.map(build => build.label) })),
    attempts: plan.flatMap((item, index) => item.order.map(build => ({
      format: 'agents.attempt/2', task: item.task.id, repetition: item.repetition, build: build.label,
      directory: path.join(output, `${index + 1}-${build.label}`),
      status: 'not-started', outcome: 'not_run'
    })))
  };
  await saveJson(path.join(output, 'report.json'), report);
  let cursor = 0, cleanupFailed = false;
  await Promise.all(Array.from({ length: Math.min(comparison.concurrency, plan.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= plan.length || signal?.aborted || cleanupFailed) return;
      const item = plan[index];
      for (const build of item.order) {
        if (signal?.aborted || cleanupFailed) return;
        const directory = path.join(output, `${index + 1}-${build.label}`);
        let source, attempt;
        try {
          source = await provider({ task: item.task, build, repetition: item.repetition });
          // Provider setup is asynchronous: admission can close while it waits.
          if (signal?.aborted || cleanupFailed) {
            attempt = { format: 'agents.attempt/2', task: item.task.id, build: build.label, status: 'not-started' };
            await mkdir(directory);
          } else attempt = await runAttempt({ task: item.task, build, settings: comparison.settings, directory, endpoint: source.endpoint, signal, providerCleanupPending: true });
        } catch (error) {
          attempt = { format: 'agents.attempt/2', task: item.task.id, build: build.label, status: 'finished', providerCleanup: 'pending', failurePhase: 'infrastructure', error: error.message };
          await mkdir(directory, { recursive: true });
          await saveJson(path.join(directory, 'result.json'), attempt);
        } finally {
          try {
            await source?.close?.();
            attempt.providerCleanup = 'completed';
          }
          catch (error) {
            cleanupFailed = true;
            attempt.providerCleanup = 'failed';
            (attempt.cleanupErrors ??= []).push(`Provider teardown: ${error.message}`);
          }
        }
        if (attempt.cleanupErrors?.length) cleanupFailed = true;
        attempt = projectAttempt({ ...attempt, repetition: item.repetition, directory });
        await saveJson(path.join(directory, 'result.json'), attempt);
        const position = report.attempts.findIndex(value => value.directory === directory);
        report.attempts[position] = attempt;
      }
    }
  }));
  report.attempts = report.attempts.map(projectAttempt);
  report.cancelled = Boolean(signal?.aborted);
  report.status = comparisonStatus(report.attempts, report.cancelled);
  report.finishedAt = new Date().toISOString();
  report.elapsedMs = performance.now() - started;
  report.paired = pairedReport(report.attempts, comparison.builds);
  await saveJson(path.join(output, 'report.json'), report);
  return report;
}

export async function recoverComparisonReport(directory) {
  const file = path.join(directory, 'report.json');
  const report = JSON.parse(await readFile(file, 'utf8'));
  if (report.format !== 'agents.comparison-result/2') throw new Error('Incompatible evaluation report.');
  for (let index = 0; index < report.attempts.length; index++) {
    const planned = report.attempts[index];
    try {
      const recorded = JSON.parse(await readFile(path.join(planned.directory, 'result.json'), 'utf8'));
      if (recorded.format !== 'agents.attempt/2') throw new Error('Incompatible evaluation attempt.');
      report.attempts[index] = projectAttempt({ ...planned, ...recorded });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  report.attempts = report.attempts.map(projectAttempt);
  report.status = comparisonStatus(report.attempts, report.cancelled);
  report.paired = pairedReport(report.attempts, report.comparison.builds);
  await saveJson(file, report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    manifest: { type: 'string' }, output: { type: 'string' }, endpoint: { type: 'string' },
    recover: { type: 'string' }
  } });
  if (values.recover) {
    const report = await recoverComparisonReport(path.resolve(values.recover));
    console.log(JSON.stringify({ status: report.status, paired: report.paired }));
  } else {
    if (!values.manifest || !values.output || !values.endpoint)
      throw new Error('Usage: node validation/coding-agent-evaluation.mjs --manifest FILE --output NEW_DIRECTORY --endpoint http://127.0.0.1:PORT (no-paid-calls only)');
    const controller = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
    const report = await runComparison(JSON.parse(await readFile(values.manifest, 'utf8')), {
      output: values.output, signal: controller.signal, provider: async () => ({ endpoint: values.endpoint })
    });
    console.log(JSON.stringify({ status: report.status, paired: report.paired }));
    if (report.attempts.some(attempt => attempt.outcome !== 'success')) process.exitCode = 1;
  }
}

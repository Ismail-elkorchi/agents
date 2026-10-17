import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, readFile, readlink, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inventory, sandboxArgs, launch, readFrozen } from '../../validation/evaluation-isolation.mjs';
import { freezeBuild, verifyBuild, verifyBuildPreparation } from '../../validation/evaluation-build.mjs';
import { runAttempt, runComparison, recoverComparisonReport } from '../../validation/coding-agent-evaluation.mjs';
import { qualificationTask, qualificationSettings, qualificationScript, archiveFiles } from '../../validation/qualify-evaluation.mjs';
import { scriptedOllama, toolResponse, finalResponse } from './fixtures/scripted-cli.js';

let directory, task, build, counter = 0;
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'evaluation-tests-'));
  task = await qualificationTask(directory);
  const root = path.resolve('..');
  const frozen = await freezeBuild(path.join(root, 'agents'), path.join(root, 'agent-core'),
    path.join(directory, 'build'), { qualification: true });
  build = { label: 'A', directory: path.join(directory, 'build'), sha256: frozen.sha256 };
});
after(async () => { await rm(directory, { recursive: true, force: true }); });
async function attempt(script, change = () => {}, options = {}) {
  const input = structuredClone(task);
  input.checkpoints = [];
  input.instructions = 'Set repo/settings.json to {"port":9090}, removing theme. Preserve repo/math.mjs and every other file.';
  change(input);
  const provider = await scriptedOllama(script);
  const destination = path.join(directory, `attempt-${++counter}`);
  try {
    const result = await runAttempt({ task: input, build, settings: qualificationSettings,
      directory: destination, endpoint: provider.endpoint, ...options });
    assert.deepEqual(JSON.parse(await readFile(path.join(destination, 'result.json'), 'utf8')), JSON.parse(JSON.stringify(result)));
    return result;
  } finally { await provider.close(); }
}
const patch = () => qualificationScript()[2];
const pass = `console.log(JSON.stringify({format:'agents.acceptance/1',status:'passed',evidence:'Assertions passed'}));`;

test('build pin covers provenance metadata as well as executable files', async () => {
  const destination = path.join(directory, 'altered-build');
  await cp(build.directory, destination, { recursive: true });
  const file = path.join(destination, 'build.json');
  const recorded = JSON.parse(await readFile(file, 'utf8'));
  recorded.agentsRevision = '0'.repeat(40);
  await writeFile(file, JSON.stringify(recorded));
  await assert.rejects(verifyBuild({ ...build, directory: destination }), /digest/);
  await cp(path.join(build.directory, 'build.json'), file);
  await writeFile(path.join(destination, 'node_modules/@ismail-elkorchi/coding-agent/dist/cli.js'), '// changed executable');
  await assert.rejects(verifyBuild({ ...build, directory: destination }), /digest/);
});

test('an existing attempt directory is rejected without changing its evidence', async () => {
  const destination = path.join(directory, 'existing-attempt');
  await cp(path.join(directory, 'source'), destination, { recursive: true });
  await writeFile(path.join(destination, 'result.json'), '{"existing":true}\n');
  await assert.rejects(runAttempt({
    task, build, settings: qualificationSettings, directory: destination, endpoint: 'http://127.0.0.1:1'
  }), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(destination, 'result.json'), 'utf8'), '{"existing":true}\n');
});

test('multiple follow-ups at the same boundary are submitted in order, not overwritten', async () => {
  const result = await attempt([patch(), finalResponse('First'), finalResponse('Second'), finalResponse('Third')], input => {
    input.checkpoints = ['first', 'second'].map(id => ({
      id, after: { type: 'run.completed', occurrence: 1 }, action: 'follow', instruction: id
    }));
  });
  assert.equal(result.outcome, 'success', result.error);
  assert.equal(result.runs.length, 3);
  assert.deepEqual(result.interventions.map(item => item.instruction), ['first', 'second']);
});

test('an early edit remains a no-edit violation after successful shared-boundary follow-ups', async () => {
  const result = await attempt([patch(), finalResponse('First'), finalResponse('Second'), finalResponse('Third')], input => {
    input.constraints.stages = [{ id: 'inspect-only', completedRun: 1, rule: 'no-edit', mutationAttempts: 'record-only' }];
    input.checkpoints = ['first', 'second'].map(id => ({
      id, after: { type: 'run.completed', occurrence: 1 }, action: 'follow', instruction: id
    }));
  });
  assert.equal(result.runs.length, 3);
  assert.equal(result.acceptance[0].status, 'passed');
  assert.equal(result.phaseEvidence[0].status, 'violated');
  assert(result.phaseEvidence[0].changedFiles.includes('repo/settings.json'));
  assert.equal(result.outcome, 'incorrect_solution');
});

test('a wrong final patch stays visible when the required correction checkpoint never occurs', async () => {
  const result = await attempt([finalResponse('Done')], input => {
    input.checkpoints = [{ id: 'missing', after: { type: 'tool.ended', toolName: 'apply_patch', occurrence: 1 },
      action: 'follow', instruction: 'Correct the answer' }];
  });
  assert.equal(result.outcome, 'incorrect_solution');
  assert.equal(result.qualification.qualified, false);
  assert(result.qualification.reasons.includes('missing_checkpoints'));
});

test('a requested interruption that misses the active run cannot count as successful coverage', async () => {
  const result = await attempt([patch(), finalResponse('Done'), finalResponse('Follow-up')], input => {
    input.checkpoints = [{
      id: 'too-late', after: { type: 'run.completed', occurrence: 1 },
      action: 'abort-follow', instruction: 'Continue after interruption'
    }];
  });
  assert.equal(result.execution, 'completed');
  assert.equal(result.interventions[0].interrupted, false);
  assert.equal(result.outcome, 'incomplete');
});

test('artifact and acceptance copies preserve workspace-relative symlinks', async () => {
  const verifier = await archiveFiles(directory, 'symlink-verifier', {
    'check.mjs': `import assert from 'node:assert/strict'; import { readFile, readlink } from 'node:fs/promises';
assert.equal(await readlink('/work/repo/settings-link.json'), 'settings.json');
assert.equal(JSON.parse(await readFile('/work/repo/settings-link.json')).port, 9090); ${pass}`
  });
  const result = await attempt([
    toolResponse('exec_command', { command: 'ln -s settings.json repo/settings-link.json' }),
    patch(), finalResponse('Done')
  ], input => {
    input.constraints.writable.push('repo/settings-link.json');
    input.acceptance[0].verifier = verifier;
  });
  assert.equal(result.outcome, 'success', JSON.stringify(result.acceptance));
  assert.equal(await readlink(path.join(directory, `attempt-${counter}`, 'artifact/repo/settings-link.json')), 'settings.json');
});

test('symlink containment resolves intermediate links rather than only lexical paths', async () => {
  const root = path.join(directory, 'links');
  await mkdir(path.join(root, 'nested'), { recursive: true });
  await writeFile(path.join(directory, 'outside'), 'private');
  await symlink('..', path.join(root, 'nested/parent'));
  await symlink('nested/parent/../outside', path.join(root, 'escape'));
  await assert.rejects(inventory(root), /symlink resolves outside/);
});

test('acceptance checks receive independent copies, not previous verifier mutations', async () => {
  const first = await archiveFiles(directory, 'mutating-verifier', {
    'check.mjs': `import { writeFile } from 'node:fs/promises'; import assert from 'node:assert/strict';
assert.equal(process.cwd(), '/work/repo');
await writeFile('/work/repo/settings.json', '{"port":1}'); ${pass}`
  });
  const result = await attempt([patch(), finalResponse('Done')], input => {
    input.acceptance.unshift({ ...input.acceptance[0], id: 'mutates-copy', verifier: first });
  });
  assert.equal(result.outcome, 'success', JSON.stringify(result.acceptance));
  assert.deepEqual(result.acceptance.map(check => check.status), ['passed', 'passed']);
  assert.equal(JSON.parse(await readFile(path.join(directory, `attempt-${counter}`, 'artifact/repo/settings.json'))).port, 9090);
});

test('complete paired comparison uses actual CLI, keeps all attempts and alternates order', { timeout: 60000 }, async () => {
  const file = path.join(directory, 'task.json');
  await writeFile(file, JSON.stringify(task));
  let active = 0, maximum = 0;
  const report = await runComparison({
    format: 'agents.comparison/1', purpose: 'machinery-qualification',
    builds: [build, { ...build, label: 'B' }], tasks: [file],
    repetitions: 2, concurrency: 2, settings: qualificationSettings, spending: { mode: 'no-paid-calls' }
  }, { output: path.join(directory, 'paired'), provider: async () => {
    active++; maximum = Math.max(maximum, active);
    const provider = await scriptedOllama(qualificationScript());
    return { ...provider, close: async () => { await provider.close(); active--; } };
  } });
  assert.equal(maximum, 2);
  assert.equal(active, 0);
  assert.equal(report.attempts.length, 4);
  assert(report.attempts.every(item => item.outcome === 'success'), JSON.stringify(report.attempts.map(item => [item.outcome, item.error])));
  assert.deepEqual(report.order.map(item => item.order), [['A', 'B'], ['B', 'A']]);
  assert(report.attempts.every(item => item.interventions.length === 2 && item.runs.length === 3));
  assert(report.attempts.every(item => item.measurements.requests === 5 && item.metrics.generationRequests === 5));
  assert(report.attempts.every(item => item.metrics.contextRenewals === 0 && item.measurements.cost.amount === null));
  const retained = report.comparison.builds[0];
  assert.notEqual(retained.directory, build.directory);
  assert.equal((await verifyBuildPreparation(retained)).sha256, build.sha256);
  assert((await readFile(`${retained.directory}.preparation/core.tar`)).length > 0);
});

test('wrong patch and agent claims cannot pass independent checks', async () => {
  const result = await attempt([finalResponse('All tests passed. Task complete.')]);
  assert.equal(result.outcome, 'incorrect_solution');
  assert.equal(result.acceptance[0].status, 'failed');
});

test('hidden checks, parent filesystem, build writes, Git history and network are isolated', async () => {
  const command = `node -e 'const fs=require("fs"); for (const p of ["/checks","/work/repo/.git",${JSON.stringify(directory)}]) {if(fs.existsSync(p))process.exit(8);} try{fs.writeFileSync("/build/build.json","tampered");process.exit(9)}catch(e){if(e.code!=="EROFS")throw e} if(process.env.OPENAI_API_KEY)process.exit(10); console.log("isolated")'`;
  const result = await attempt([toolResponse('exec_command', { command }), patch(), finalResponse('Done')]);
  assert.equal(result.outcome, 'success', result.error);
  assert(result.metrics.toolCalls.some(call => call.attempts.some(value => value.domain?.exitCode === 0)));
  assert.equal((await inventory(build.directory))['build.json'].sha256.length, 64);
  await readFrozen(task.acceptance[0].verifier);
});

test('readable installed Core bounds historical tasks to contaminated diagnostics, not blind holdouts', async () => {
  const result = await attempt([
    toolResponse('exec_command', { command: `node -e 'const fs=require("fs");const p="/build/node_modules/@agent-core/persistence/dist/jsonl.js";if(!fs.readFileSync(p,"utf8").includes("function"))process.exit(1);console.log("compiled-Core-readable")'` }),
    patch(), finalResponse('Done')
  ]);
  assert.equal(result.outcome, 'success', result.error);
  assert(result.metrics.toolCalls.some(call => call.attempts.some(value => value.domain?.exitCode === 0)));
});

test('configuration tampering is a violation and does not alter loaded limits', async () => {
  const result = await attempt([
    toolResponse('exec_command', { command: `echo '{}' > evaluation.config.json` }),
    patch(), finalResponse('Done')
  ]);
  assert.equal(result.outcome, 'incorrect_solution');
  assert(result.constraintViolations.includes('evaluation.config.json'));
});

test('wall deadline preserves partial evidence and kills the namespace', { timeout: 15000 }, async () => {
  const result = await attempt([toolResponse('exec_command', { command: 'node -e "setInterval(()=>{},1000)"', timeoutMs: 60000 })],
    task => { task.limits.wallMs = 2500; });
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.status, 'finished');
  assert.equal(result.process.signal, 'SIGKILL');
});

test('Core model-turn budget is enforced, not relabelled as a wrong solution', async () => {
  const result = await attempt([patch(), finalResponse('Done')], task => { task.limits.modelTurns = 1; });
  assert.equal(result.outcome, 'budget_exhaustion', JSON.stringify(result.runs));
  assert.equal(result.measurements.requests, 1);
});

test('completed execution with partial model output remains incomplete even after a successful follow-up', async () => {
  for (const follow of [false, true]) {
    const response = { ...finalResponse('Truncated answer'), done_reason: 'length' };
    const result = await attempt([patch(), response, finalResponse('Later complete answer')], input => {
      if (follow) input.checkpoints = [{ id: 'follow', after: { type: 'run.completed', occurrence: 1 },
        action: 'follow', instruction: 'Continue the explanation.' }];
    });
    assert.equal(result.runs[0].terminal.executionStatus, 'completed');
    assert.equal(result.runs[0].terminal.modelOutput.status, 'partial');
    if (follow) assert.equal(result.runs[1].terminal.modelOutput.status, 'complete');
    assert.equal(result.acceptance[0].status, 'passed');
    assert.equal(result.outcome, 'incomplete');
  }
});

test('missing usage stays unavailable and stops subsequent request admission', async () => {
  const response = patch();
  delete response.prompt_eval_count;
  delete response.eval_count;
  const result = await attempt([response, finalResponse('Should not be reached')]);
  assert.notEqual(result.outcome, 'success');
  assert.equal(result.measurements.reported.promptTokens, null);
  assert.equal(result.measurements.cost.amount, null);
  assert.equal(result.measurements.requests, 1);
});

test('missing usage on the last response cannot produce a successful attempt', async () => {
  const response = finalResponse('Done');
  delete response.prompt_eval_count;
  delete response.eval_count;
  const result = await attempt([patch(), response]);
  assert.equal(result.outcome, 'incomplete');
  assert(result.measurementErrors.length > 0);
  assert.equal(result.measurements.reported.promptTokens, null);
});

test('provider teardown failure retains outcomes and a recoverable comparison report', async () => {
  const input = structuredClone(task);
  input.checkpoints = [];
  const file = path.join(directory, 'teardown-task.json');
  await writeFile(file, JSON.stringify(input));
  const output = path.join(directory, 'teardown-comparison');
  const report = await runComparison({
    format: 'agents.comparison/1', purpose: 'machinery-qualification',
    builds: [build, { ...build, label: 'B' }], tasks: [file],
    repetitions: 1, concurrency: 1, settings: qualificationSettings, spending: { mode: 'no-paid-calls' }
  }, { output, provider: async () => {
    const provider = await scriptedOllama([patch(), finalResponse('Done')]);
    return { ...provider, close: async () => { await provider.close(); throw new Error('teardown failed'); } };
  } });
  assert.equal(report.status, 'incomplete');
  assert.equal(report.attempts.length, 2);
  const [attempt, unstarted] = report.attempts;
  assert.equal(attempt.status, 'finished');
  assert.equal(attempt.outcome, 'infrastructure_failure');
  assert(attempt.cleanupErrors.some(error => error.includes('teardown failed')));
  assert.equal(attempt.acceptance[0].status, 'passed');
  assert.equal(unstarted.outcome, 'not_run');
  assert.equal((await recoverComparisonReport(output)).status, 'incomplete');
});

test('wrong solution plus provider teardown failure retains evidence and disqualifies the pair', async () => {
  const input = structuredClone(task);
  input.checkpoints = [];
  const file = path.join(directory, 'wrong-teardown-task.json');
  await writeFile(file, JSON.stringify(input));
  const output = path.join(directory, 'wrong-teardown-comparison');
  const report = await runComparison({
    format: 'agents.comparison/1', purpose: 'machinery-qualification',
    builds: [build, { ...build, label: 'B' }], tasks: [file], repetitions: 1, concurrency: 1,
    settings: qualificationSettings, spending: { mode: 'no-paid-calls' }
  }, { output, provider: async () => {
    const source = await scriptedOllama([finalResponse('Done')]);
    return { ...source, close: async () => { await source.close(); throw new Error('teardown failed'); } };
  } });
  assert.equal(report.attempts[0].outcome, 'incorrect_solution');
  assert.equal(report.attempts[0].qualification.qualified, false);
  assert.equal(report.paired.pairs[0].change, 'incomplete');
  assert.deepEqual(await recoverComparisonReport(output), report);
});

test('cancellation stops admitting the next build in a pair', async () => {
  const file = path.join(directory, 'cancel-task.json');
  await writeFile(file, JSON.stringify(task));
  const controller = new AbortController();
  let admitted = 0;
  const report = await runComparison({
    format: 'agents.comparison/1', purpose: 'machinery-qualification',
    builds: [build, { ...build, label: 'B' }], tasks: [file],
    repetitions: 1, concurrency: 1, settings: qualificationSettings, spending: { mode: 'no-paid-calls' }
  }, { output: path.join(directory, 'cancel-comparison'), signal: controller.signal, provider: async () => {
    admitted++;
    return scriptedOllama([() => { controller.abort(); return finalResponse('Cancelled'); }]);
  } });
  assert.equal(admitted, 1);
  assert.deepEqual(report.attempts.map(attempt => attempt.outcome), ['cancelled', 'not_run']);
});

test('cancellation during provider setup admits no application work', async () => {
  const file = path.join(directory, 'cancel-setup-task.json');
  await writeFile(file, JSON.stringify(task));
  const controller = new AbortController();
  let admitted = 0, closed = 0;
  const report = await runComparison({
    format: 'agents.comparison/1', purpose: 'machinery-qualification',
    builds: [build, { ...build, label: 'B' }], tasks: [file],
    repetitions: 1, concurrency: 1, settings: qualificationSettings, spending: { mode: 'no-paid-calls' }
  }, { output: path.join(directory, 'cancel-setup-comparison'), signal: controller.signal, provider: async () => {
    admitted++;
    controller.abort();
    return { endpoint: 'must-not-be-used', close: async () => { closed++; } };
  } });
  assert.equal(admitted, 1);
  assert.equal(closed, 1);
  assert.equal(report.status, 'cancelled');
  assert.deepEqual(report.attempts.map(attempt => attempt.outcome), ['not_run', 'not_run']);
  assert(report.attempts.every(attempt => !attempt.process && !attempt.application));
  const recovered = await recoverComparisonReport(path.join(directory, 'cancel-setup-comparison'));
  assert.equal(recovered.status, 'cancelled');
  assert.deepEqual(recovered.attempts.map(attempt => attempt.outcome), ['not_run', 'not_run']);
  assert.throws(() => launch(['/runtime/node', '-e', 'process.exit(0)'], { signal: controller.signal }), { name: 'AbortError' });
});

test('evaluator crashes including exit 1 are separate from failed criteria', async () => {
  for (const [name, source] of [['explicit', 'process.exit(2)'], ['throw', 'throw new Error("verifier crash")'],
    ['syntax', 'not valid javascript !'], ['missing-import', 'import "./missing.mjs"']]) {
    const verifier = await archiveFiles(directory, `crashing-verifier-${name}`, { 'check.mjs': source });
    const result = await attempt([patch(), finalResponse('Done')], task => { task.acceptance[0].verifier = verifier; });
    assert.equal(result.outcome, 'evaluator_failure', name);
    assert.equal(result.acceptance[0].status, 'error');
  }
});

test('candidate process crash remains an agent failure with partial evidence', async () => {
  const result = await attempt([toolResponse('exec_command', { command: 'kill -KILL -1' })]);
  assert.equal(result.outcome, 'agent_failure', result.error);
  assert.equal(result.status, 'finished');
});

test('human judgment remains pending, never an automatic pass', async () => {
  const result = await attempt([patch(), finalResponse('Done')], task => { task.humanReview = ['Is the explanation useful?']; });
  assert.equal(result.outcome, 'pending_review');
});

test('actual context renewal is recorded separately from natural one-window success', async () => {
  const result = await attempt([
    toolResponse('read_files', { files: [{ path: 'repo/settings.json' }] }),
    toolResponse('context_transition', { reason: 'Qualification stress boundary, not natural workload evidence.', renewal: true,
      sessionState: { blocks: [{ text: 'The corrected target is port 9090, with no theme. Preserve math.mjs.' }] } }),
    toolResponse('history_latest', { limit: 5, maxBytes: 16384 }),
    patch(), finalResponse('Done')
  ], task => { task.contextMode = 'forced-renewal-stress'; });
  assert.equal(result.outcome, 'success', result.error);
  assert(result.metrics.contextRenewals > 0, JSON.stringify(result.metrics));
  assert(result.metrics.evidenceRetrievalCalls > 0);
});

for (const interruptedTool of ['read_files', 'exec_command'])
test(`observable interruption after ${interruptedTool} continues the same session with preserved results and no repeated effects`, async () => {
  const requests = [];
  const continued = request => { requests.push(request); return finalResponse('Done; committed effect preserved.'); };
  const result = await attempt([
    toolResponse('exec_command', { command: `node -e 'const fs=require("fs");fs.appendFileSync("repo/effects.txt","once\\n");fs.writeFileSync("repo/settings.json",JSON.stringify({port:9090}));console.log("committed-effect-evidence")'` }),
    ...(interruptedTool === 'read_files' ? [toolResponse('read_files', { files: [{ path: 'repo/math.mjs' }] })] : []),
    continued, continued
  ], task => {
    task.constraints.writable.push('repo/effects.txt');
    task.checkpoints = [{ id: 'interrupt', after: { type: 'tool.ended', toolName: interruptedTool, occurrence: 1 },
      action: 'abort-follow', instruction: 'Continue after the interruption. Use the recorded result; do not repeat the committed effect.' }];
  });
  assert.equal(result.interventions.length, 1);
  assert.equal(result.interventions[0].interrupted, true);
  assert.equal(result.outcome, 'success', JSON.stringify(result));
  assert.equal(result.runs.length, 2);
  assert.equal(result.runs[0].terminal.executionStatus, 'aborted');
  assert.equal(result.runs[1].terminal.executionStatus, 'completed');
  const followup = requests.find(request => JSON.stringify(request).includes('Continue after the interruption.'));
  assert(followup, 'The follow-up reached the model in the original session');
  assert(followup.messages.some(message => message.role === 'tool' && message.content.includes('committed-effect-evidence')),
    'The settled tool observation is preserved, not substituted by a state claim');
  if (interruptedTool === 'read_files')
    assert(followup.messages.some(message => message.role === 'tool' && message.content.includes('export const sum')),
      'The original read_files interruption retains its own successful observation');
  assert.equal(result.metrics.toolCalls.filter(call => call.toolName === 'exec_command').length, 1);
  assert.equal(result.metrics.repeatedEffectInputs, 0);
  assert.equal(await readFile(path.join(directory, `attempt-${counter}`, 'artifact/repo/effects.txt'), 'utf8'), 'once\n');
});

test('cancellation has its own outcome and no next attempt reuses the workspace', async () => {
  const controller = new AbortController();
  const provider = await scriptedOllama([() => { controller.abort(); return finalResponse('Cancelled'); }]);
  try {
    const result = await runAttempt({ task, build, settings: qualificationSettings,
      directory: path.join(directory, 'cancelled'), endpoint: provider.endpoint, signal: controller.signal });
    assert.equal(result.outcome, 'cancelled');
  } finally { await provider.close(); }
  const next = await attempt([patch(), finalResponse('Done')]);
  assert.equal(next.outcome, 'success');
});

test('sandbox PID namespace cleans detached descendants and has no host network', async () => {
  const run = launch([...sandboxArgs({ workspace: directory }),
    '/runtime/node', '-e', `const {spawn}=require("child_process");spawn("/runtime/node",["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"}).unref();console.log("spawned");setInterval(()=>{},1000)`],
  { timeoutMs: 10000, onLine: () => run.stop('observed-descendant') });
  const result = await run.done;
  assert.equal(result.stopped, 'observed-descendant');
  assert.equal(result.signal, 'SIGKILL');
  const network = await launch([...sandboxArgs({ workspace: directory }),
    '/runtime/node', '-e', `require("net").connect({host:"1.1.1.1",port:80}).on("error",()=>process.exit(0)).on("connect",()=>process.exit(1))`],
  { timeoutMs: 2000 }).done;
  assert.equal(network.code, 0);
});

import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execute, freezeBuild, freezeRepository, sha256, runtimeIdentity } from './evaluation-isolation.mjs';
import { normalTools } from './evaluation-contract.mjs';
import { runComparison } from './coding-agent-evaluation.mjs';
import { primaryTaskScenario, baseline } from './continuation-comparison.mjs';
import { scriptedOllama, toolResponse, finalResponse } from '../coding-agent/test/fixtures/scripted-cli.js';

export const qualificationSettings = {
  provider: 'ollama', model: 'v0-scripted', reasoning: 'provider-default',
  maxOutputTokens: 4096, temperature: 0, permissions: 'full_host', tools: normalTools
};
export async function archiveFiles(directory, name, files) {
  const root = path.join(directory, name);
  await mkdir(root, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  const archive = path.join(directory, `${name}.tar`);
  await execute('tar', ['-cf', archive, '-C', root, ...Object.keys(files)]);
  return { path: archive, sha256: sha256(await readFile(archive)) };
}

export async function qualificationTask(directory) {
  const fixture = primaryTaskScenario();
  const repository = path.join(directory, 'source');
  await mkdir(repository, { recursive: true });
  for (const [name, content] of Object.entries(fixture.files))
    await writeFile(path.join(repository, name), content);
  for (const args of [
    ['init', '-q'], ['add', '.'],
    ['-c', 'user.name=Evaluation fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'Qualification fixture derived from pinned task-continuity regression']
  ]) await execute('git', args, { cwd: repository });
  const revision = (await execute('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim();
  const snapshot = await freezeRepository(repository, revision, path.join(directory, 'source.tar'));
  const verifier = await archiveFiles(directory, 'verifier', {
    'evaluation-acceptance.mjs': await readFile(new URL('./evaluation-acceptance.mjs', import.meta.url), 'utf8'),
    'continuation-comparison.mjs': await readFile(new URL('./continuation-comparison.mjs', import.meta.url), 'utf8'),
    'fixtures/continuation-baseline.json': await readFile(new URL('./fixtures/continuation-baseline.json', import.meta.url), 'utf8'),
    'check.mjs': `
import { reportAcceptance } from './evaluation-acceptance.mjs';
import { primaryTaskScenario } from './continuation-comparison.mjs';
const scenario = primaryTaskScenario();
const criteria = await scenario.steps.at(-1).check('/work/repo');
reportAcceptance(Object.values(criteria).every(value => value === true) ? 'passed' : 'failed', JSON.stringify(criteria));
` });
  return {
    format: 'agents.task/1', id: fixture.id, split: 'qualification',
    provenance: { description: 'Synthetic workspace from the real pinned continuation regression; machinery qualification, NOT a real project benchmark.', exposure: 'implementation-visible', sourceCommits: [baseline.agents] },
    repositories: [{ name: 'repo', ...snapshot }],
    instructions: 'In repo/: ' + fixture.steps[0].task,
    environment: { description: `Node ${process.version}, Linux, bubblewrap, no dependency install.`, runtime: await runtimeIdentity() },
    network: 'provider-only',
    limits: { wallMs: 30000, modelTurns: 24, promptTokens: 200000, completionTokens: 24000, totalToolCalls: 30 },
    contextMode: 'natural',
    checkpoints: fixture.steps.slice(1).map((step, index) => ({
      id: `correction-${index + 1}`, after: { type: 'run.completed', occurrence: index + 1 },
      action: 'follow', instruction: 'In repo/: ' + step.task
    })),
    constraints: { writable: ['repo/settings.json'] },
    acceptance: [{ id: 'corrected-configuration', description: 'Later requirement supersedes original task; math remains unchanged.',
      verifier, argv: ['/runtime/node', '/checks/check.mjs'], cwd: 'repo', timeoutMs: 5000 }],
    humanReview: []
  };
}
export function qualificationScript() {
  return [
    toolResponse('read_files', { files: [{ path: 'repo/math.mjs' }] }),
    finalResponse('Empty arrays throw; no edits.'),
    toolResponse('apply_patch', { patch: '*** Begin Patch\n*** Update File: repo/settings.json\n@@\n-{"port":3000,"theme":"dark"}\n+{"port":9090}\n*** End Patch' }),
    finalResponse('Updated settings.'),
    finalResponse('Port 9090; no theme. Math unchanged.')
  ];
}
export async function qualify(output) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const temporary = await mkdtemp(path.join(tmpdir(), 'agents-qualification-'));
  try {
    const task = await qualificationTask(temporary);
    const taskFile = path.join(temporary, 'task.json');
    await writeFile(taskFile, JSON.stringify(task));
    const directory = path.join(temporary, 'build');
    const build = await freezeBuild(root, path.resolve(root, '../agent-core'), directory, { qualification: true });
    return await runComparison({
      format: 'agents.comparison/1', purpose: 'machinery-qualification',
      builds: ['A', 'B'].map(label => ({ label, directory, sha256: build.sha256 })),
      tasks: [taskFile], repetitions: 2, concurrency: 1,
      settings: qualificationSettings, spending: { mode: 'no-paid-calls' }
    }, { output, provider: async () => scriptedOllama(qualificationScript()) });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node validation/qualify-evaluation.mjs NEW_OUTPUT_DIRECTORY');
  const report = await qualify(path.resolve(process.argv[2]));
  console.log(JSON.stringify({ purpose: report.comparison.purpose, attempts: report.attempts.map(item => ({ outcome: item.outcome, error: item.error })), paired: report.paired }, null, 2));
  if (report.attempts.some(item => item.outcome !== 'success')) process.exitCode = 1;
}

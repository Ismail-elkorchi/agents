import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectTasks } from './project-tasks.mjs';
import { freezeRepository, unpack, sandboxArgs, launch, runAcceptanceCheck } from './evaluation-isolation.mjs';
import { saveJson } from './coding-agent-evaluation.mjs';
import { acceptanceStatus } from './evaluation-report.mjs';

// Qualifies test/environment discrimination only. Never runs held-out tasks,
// never supplies the reference revision to a candidate, never grades similarity.
export async function qualifyProjectTasks(taskDirectory, output) {
  await mkdir(output, { recursive: false });
  const core = fileURLToPath(new URL('../../agent-core', import.meta.url));
  const results = [];
  for (const specification of projectTasks.filter(task => task.split === 'development')) {
    const task = JSON.parse(await readFile(path.join(taskDirectory, specification.id, 'task.json')));
    for (const revision of [specification.start, specification.fix]) {
      const temporary = await mkdtemp(path.join(tmpdir(), 'task-oracle-'));
      try {
        const snapshot = await freezeRepository(core, revision, path.join(temporary, 'source.tar'));
        const workspace = path.join(temporary, 'workspace');
        await unpack(snapshot.snapshot, path.join(workspace, 'core'));
        await unpack(task.environment.overlay, workspace);
        const setup = await launch([...sandboxArgs({ workspace }), ...task.environment.setup], { timeoutMs: 30000 }).done;
        if (setup.code !== 0) throw new Error(JSON.stringify(setup));
        const checks = path.join(temporary, 'checks');
        await unpack(task.acceptance[0].verifier, checks);
        const result = await runAcceptanceCheck({ workspace, verifier: checks, check: task.acceptance[0] });
        const expected = revision === specification.fix ? 'passed' : 'failed';
        const status = acceptanceStatus(result);
        results.push({ task: task.id, revision, expected, status, qualified: status === expected, result });
        await saveJson(path.join(output, `${task.id}-${revision}.json`), results.at(-1));
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
  }
  await saveJson(path.join(output, 'report.json'), results);
  return results;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('Usage: qualify-project-tasks.mjs TASK_DIRECTORY NEW_OUTPUT_DIRECTORY');
  const results = await qualifyProjectTasks(path.resolve(process.argv[2]), path.resolve(process.argv[3]));
  for (const item of results) console.log(JSON.stringify({ task: item.task, expected: item.expected, exitCode: item.result.code, stopped: item.result.stopped }));
  if (results.some(item => !item.qualified)) process.exitCode = 1;
}

import { mkdir, readFile, readdir, cp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execute, freezeRepository, sha256, runtimeIdentity } from './evaluation-isolation.mjs';
import { freezeBuild } from './evaluation-build.mjs';
import { projectTasks } from './project-tasks.mjs';
import { taskSchema } from './evaluation-contract.mjs';
import { saveJson } from './coding-agent-evaluation.mjs';

const bootstrap = `
import { readdir, readFile, mkdir, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
const core = '/work/core';
for (const parent of ['packages', 'packages/providers']) {
  for (const entry of await readdir(path.join(core, parent), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'providers') continue;
    const folder = path.join(core, parent, entry.name);
    const manifest = JSON.parse(await readFile(path.join(folder, 'package.json')));
    if (!/^@agent-core\\/[a-z0-9-]+$/.test(manifest.name)) throw new Error('Unexpected package name');
    const target = path.join(core, 'node_modules', manifest.name);
    await mkdir(path.dirname(target), { recursive: true });
    await rm(target, { force: true, recursive: true });
    await symlink(path.relative(path.dirname(target), folder), target);
  }
}
`;

export async function prepareTasks(core, destination, { includeHeldOut = false } = {}) {
  await mkdir(destination, { recursive: false });
  const overlay = path.join(destination, 'environment');
  const modules = path.join(overlay, 'core/node_modules');
  await mkdir(modules, { recursive: true });
  // No install, credentials, network or mutable caches. Pin actual dependency
  // bytes separately from task source; exclude all current Core implementations.
  for (const name of await readdir(path.join(core, 'node_modules'))) {
    if (name.startsWith('.') || name === '@agent-core') continue;
    await cp(path.join(core, 'node_modules', name), path.join(modules, name), {
      recursive: true, dereference: true,
      filter: file => !['.git', '.cache'].includes(path.basename(file))
    });
  }
  await writeFile(path.join(overlay, 'bootstrap.mjs'), bootstrap);
  const envArchive = path.join(destination, 'environment.tar.gz');
  await execute('tar', ['-czf', envArchive, '-C', overlay, 'core', 'bootstrap.mjs']);
  const environment = {
    runtime: await runtimeIdentity(),
    description: `Offline dependencies captured from Core node_modules; Node ${process.version}. From core/ compile with node node_modules/typescript/bin/tsc -b; run tests with node --test. No npm installation is needed or available. Archive pins actual compiler/dependency bytes, not an assumed historical installation.`,
    overlay: { path: envArchive, sha256: sha256(await readFile(envArchive)) },
    setup: ['/runtime/node', '/work/bootstrap.mjs']
  };
  const files = [];
  for (const specification of projectTasks.filter(task => includeHeldOut || task.split !== 'held-out')) {
    const parent = path.join(destination, specification.id);
    await mkdir(parent);
    const repository = await freezeRepository(core, specification.start, path.join(parent, 'source.tar'));
    const verifier = path.join(parent, 'verifier');
    await mkdir(verifier);
    await cp(new URL('./evaluation-acceptance.mjs', import.meta.url), path.join(verifier, 'evaluation-acceptance.mjs'));
    for (const file of specification.tests) {
      const { stdout } = await execute('git', ['show', `${specification.fix}:${file}`], { cwd: core, maxBuffer: 8 * 1024 * 1024 });
      let source = stdout;
      if (specification.id === 'provider-usage-completeness') {
        // Task-owned assertion, not an error-message allowlist in the runner:
        // a provider must return an answer despite incomplete usage. The
        // upstream helper let provider exceptions escape as untyped test errors.
        const original = `async function respond(provider, stream) {
  if (!stream) return provider.complete(request);
  let final;
  for await (const event of provider.stream(request))
    if (event.type === 'done') final = event.response;
  assert(final);
  return final;
}`;
        if (source.split(original).length !== 2) throw new Error('Pinned provider oracle helper changed.');
        source = source.replace(original, `async function respond(provider, stream) {
  let final;
  await assert.doesNotReject(async () => {
    if (!stream) final = await provider.complete(request);
    else for await (const event of provider.stream(request))
      if (event.type === 'done') final = event.response;
  }, 'Provider response must succeed even when usage is incomplete.');
  assert(final);
  return final;
}`);
      } else if (specification.id === 'resource-coverage-correction') {
        const original = 'updateResourceCompletion, resourceSuggestions }';
        if (source.split(original).length !== 2) throw new Error('Pinned resource oracle import changed.');
        source = source.replace(original, 'updateResourceCompletion as candidateUpdateResourceCompletion, resourceSuggestions }');
        source += `
function updateResourceCompletion(...args) {
  let result;
  assert.doesNotThrow(() => { result = candidateUpdateResourceCompletion(...args); },
    'Resource completion must accept the declared coverage-bearing result contract.');
  return result;
}
`;
      }
      await mkdir(path.dirname(path.join(verifier, file)), { recursive: true });
      await writeFile(path.join(verifier, file), source);
    }
    // Build and execute independent regression sources in the separate check
    // sandbox. Test paths are restored from the hidden immutable verifier.
    await writeFile(path.join(verifier, 'check.mjs'), `
import { cp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { checkTests, reportAcceptance, compilationStatus } from './evaluation-acceptance.mjs';
const tests = ${JSON.stringify(specification.tests)};
for (const file of tests) await cp('/checks/' + file, '/work/core/' + file);
const compiled = spawnSync('/runtime/node', ['node_modules/typescript/bin/tsc', '-b', '--force'],
  { cwd: '/work/core', encoding: 'utf8' });
process.stderr.write((compiled.stdout ?? '') + (compiled.stderr ?? ''));
const compilation = compilationStatus(compiled);
if (compilation !== 'passed')
  reportAcceptance(compilation, 'Compilation: ' + JSON.stringify({ status: compiled.status, signal: compiled.signal, error: compiled.error?.message, stdout: compiled.stdout, stderr: compiled.stderr }));
else await checkTests(tests);
`);
    const archive = path.join(parent, 'checks.tar');
    await execute('tar', ['-cf', archive, '-C', verifier, 'check.mjs', 'evaluation-acceptance.mjs', ...specification.tests]);
    const packageFiles = (await execute('git', ['ls-tree', '-r', '--name-only', specification.start, 'packages'], { cwd: core })).stdout.split('\n');
    const generated = packageFiles.filter(file => /\/tsconfig.json$/.test(file))
      .flatMap(file => [`core/${path.dirname(file)}/dist/`, `core/${path.dirname(file)}/tsconfig.tsbuildinfo`]);
    const task = taskSchema.parse({
      format: 'agents.task/2', id: specification.id, split: specification.split,
      provenance: { description: `Real project change ${specification.fix}; evaluation instructions authored for this task, not a historical user transcript. ${specification.split === 'held-out' ? 'Reserved, not run or tuned; not claimed unseen to the author.' : 'Implementation-visible development task.'} NOT a blind holdout: the readable application build contains compiled Core implementations that may include this historical answer.${specification.oracleNote ? ` Oracle adaptation: ${specification.oracleNote}` : ''}`,
        exposure: specification.split === 'held-out' ? 'reserved-not-run' : 'implementation-visible',
        sourceCommits: [specification.fix] },
      repositories: [{ name: 'core', ...repository }], instructions: specification.instructions,
      environment, network: 'provider-only',
      limits: { wallMs: 900000, modelTurns: 80, promptTokens: 800000, completionTokens: 80000, totalToolCalls: 240 },
      contextMode: 'natural', checkpoints: specification.checkpoints,
      constraints: { writable: [...specification.writable, ...generated], stages: specification.stages ?? [] },
      acceptance: [{ id: 'independent-regressions', description: 'Compile all packages and run immutable upstream regression checks; no patch similarity grading.',
        verifier: { path: archive, sha256: sha256(await readFile(archive)) },
        argv: ['/runtime/node', '/checks/check.mjs'], cwd: 'core', timeoutMs: 180000 }],
      humanReview: []
    });
    const file = path.join(parent, 'task.json');
    await saveJson(file, task);
    files.push(file);
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  const root = fileURLToPath(new URL('../', import.meta.url));
  if (command === 'build' && (args.length === 3 || (args.length === 4 && args[3] === '--allow-downloads'))) {
    console.log(JSON.stringify(await freezeBuild(path.resolve(args[0]), path.resolve(args[1]), path.resolve(args[2]), { dependencyRetrieval: args[3] === '--allow-downloads' ? 'online' : 'offline' }), null, 2));
  } else if (command === 'tasks' && args.length >= 1 && args.length <= 2) {
    console.log(JSON.stringify(await prepareTasks(path.resolve(root, '../agent-core'), path.resolve(args[0]), { includeHeldOut: args[1] === '--include-held-out' }), null, 2));
  } else throw new Error('Usage: prepare-evaluation.mjs build AGENTS CORE NEW_BUILD_DIR [--allow-downloads] | tasks NEW_TASK_DIR [--include-held-out]');
}

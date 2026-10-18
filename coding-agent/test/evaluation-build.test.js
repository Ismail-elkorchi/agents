import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute, sha256 } from '../../validation/evaluation-isolation.mjs';
import { copyRuntimeDependencyClosure, freezeBuild, verifyBuild, verifyBuildPreparation } from '../../validation/evaluation-build.mjs';
import { inventory } from '../../validation/evaluation-isolation.mjs';
import { snapshotBuildSource } from '../../validation/evaluation-build.mjs';

const npm = path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
// These synthetic repositories have no registry dependencies. Keep npm's
// packaging cache owned by this test process, independent of npm-run's injected
// default cache path, user credentials, and other suites' concurrent installs.
let cache;
const inheritedCache = process.env.npm_config_cache;
before(async () => {
  cache = await mkdtemp(path.join(tmpdir(), 'build-provenance-cache-'));
  process.env.npm_config_cache = cache;
});
after(async () => {
  if (inheritedCache === undefined) delete process.env.npm_config_cache;
  else process.env.npm_config_cache = inheritedCache;
  await rm(cache, { recursive: true, force: true });
});

async function put(root, name, value) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value));
}

test('runtime closure preserves nested versions, shared instances and cycles after relocation', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'runtime-closure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  async function pkg(relative, name, version, dependencies, code, metadata = {}) {
    await put(source, `${relative}/package.json`, { name, version, main: 'index.cjs', dependencies, ...metadata });
    await put(source, `${relative}/index.cjs`, code);
  }
  await pkg('entry', 'runtime-fixture', '1.0.0', { a: '1', b: '1', 'named-alias': '1', 'cycle-a': '1' },
    `const a=require('a'),b=require('b'),cycle=require('cycle-a');module.exports={versions:[a.version,b.version],shared:a.shared===b.shared,importer:b.a===a,alias:require('named-alias')===b,cycle:cycle.peer.peer===cycle,peer:b.peer};`);
  await pkg('node_modules/a', 'a', '1.0.0', { entities: '4', shared: '1' },
    "module.exports={version:require('entities'),shared:require('shared')};");
  await pkg('node_modules/b', 'b', '1.0.0', { entities: '7', shared: '1', a: '1' },
    "module.exports={version:require('entities'),shared:require('shared'),a:require('a'),peer:require('peer-only')};",
    { peerDependencies: { 'peer-only': '1', 'missing-peer': '1' }, peerDependenciesMeta: { 'peer-only': { optional: true }, 'missing-peer': { optional: true } } });
  await pkg('node_modules/peer-only', 'peer-only', '1.0.0', {}, "module.exports='installed-optional-peer';");
  await pkg('node_modules/entities', 'entities', '7.0.1', {}, "module.exports='7.0.1';");
  await pkg('node_modules/a/node_modules/entities', 'entities', '4.5.0', {}, "module.exports='4.5.0';");
  await pkg('node_modules/node_modules/entities', 'entities', '99.0.0', {}, "module.exports='incorrect-ancestor';");
  await pkg('node_modules/shared', 'shared', '1.0.0', {}, 'module.exports={};');
  await pkg('node_modules/cycle-a', 'cycle-a', '1.0.0', { 'cycle-b': '1' }, "exports.peer=require('cycle-b');");
  await pkg('node_modules/cycle-b', 'cycle-b', '1.0.0', { 'cycle-a': '1' }, "exports.peer=require('cycle-a');");
  await symlink('b', path.join(source, 'node_modules/named-alias'));
  const baseline = await execute(process.execPath, ['-e', 'console.log(JSON.stringify(require("./entry")))'], { cwd: source });
  const output = path.join(root, 'build');
  await mkdir(output);
  const packages = await copyRuntimeDependencyClosure({ entry: path.join(source, 'entry'), sourceRoots: { fixture: source },
    modules: path.join(output, 'node_modules'), packs: path.join(root, 'packs'), evidence: path.join(root, 'evidence') });
  assert.deepEqual(packages, {}, 'Third-party fixture packages need no npm packing or network setup.');
  const original = await inventory(output);
  assert(Object.values(original).some(value => value.symlink), 'Exact dependency edges are retained as owned relative links.');
  const relocated = path.join(root, 'relocated');
  await rename(output, relocated);
  await rm(source, { recursive: true, force: true });
  assert.deepEqual(await inventory(relocated), original);
  const { stdout } = await execute(process.execPath, ['-e', 'console.log(JSON.stringify(require("runtime-fixture")))'], { cwd: relocated });
  assert.deepEqual(JSON.parse(stdout), JSON.parse(baseline.stdout));
  assert.deepEqual(JSON.parse(stdout), { versions: ['4.5.0', '7.0.1'], shared: true, importer: true, alias: true, cycle: true, peer: 'installed-optional-peer' });
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'build-provenance-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const core = path.join(root, 'agent-core'), agents = path.join(root, 'agents');
  for (const directory of [core, agents]) {
    await mkdir(directory);
    await execute('git', ['init', '-q'], { cwd: directory });
    await put(directory, '.gitignore', 'node_modules/\ndist/\n');
  }
  await put(core, 'package.json', { name: 'fixture-core', private: true, workspaces: ['packages/*'], scripts: { build: 'node build.mjs' } });
  await put(core, 'packages/json/package.json', { name: '@agent-core/json', version: '1.0.0', type: 'module', files: ['dist'], main: 'dist/index.js' });
  await put(core, 'packages/json/source.js', 'export const answer = "source-core";');
  await put(core, 'build.mjs', "import {mkdir,copyFile} from 'node:fs/promises';await mkdir('packages/json/dist',{recursive:true});await copyFile('packages/json/source.js','packages/json/dist/index.js');");
  await execute(process.execPath, [npm, 'install', '--package-lock-only', '--ignore-scripts', '--offline'], { cwd: core });
  await execute('git', ['add', '.'], { cwd: core });
  await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Fixture'], { cwd: core });
  const revision = (await execute('git', ['rev-parse', 'HEAD'], { cwd: core })).stdout.trim();
  await put(agents, 'package.json', { name: 'fixture-agents', private: true, workspaces: ['coding-agent'], agentCore: { path: '../agent-core', commit: revision },
    scripts: { build: 'node scripts/verify-source-dependencies.mjs && node build.mjs' }, devDependencies: { '@agent-core/json': 'file:../agent-core/packages/json' } });
  await put(agents, 'coding-agent/package.json', { name: '@ismail-elkorchi/coding-agent', version: '1.0.0', type: 'module', files: ['dist'], dependencies: { '@agent-core/json': '1.0.0' } });
  await put(agents, 'coding-agent/source.js', 'export const answer = "source-agents";');
  await put(agents, 'build.mjs', "import {mkdir,copyFile} from 'node:fs/promises';for(const entry of ['index.js','cli.js','tui/index.js','rpc/index.js']){const file='coding-agent/dist/'+entry;await mkdir(file.slice(0,file.lastIndexOf('/')),{recursive:true});await copyFile('coding-agent/source.js',file);}");
  await mkdir(path.join(agents, 'scripts'));
  await cp(fileURLToPath(new URL('../../scripts/verify-source-dependencies.mjs', import.meta.url)), path.join(agents, 'scripts/verify-source-dependencies.mjs'));
  await execute(process.execPath, [npm, 'install', '--package-lock-only', '--ignore-scripts', '--offline'], { cwd: agents });
  await execute('git', ['add', '.'], { cwd: agents });
  await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Fixture'], { cwd: agents });
  return { root, agents, core };
}

test('build pin covers provenance metadata as well as executable files after copying', { skip: process.platform !== 'linux' }, async t => {
  const { root, agents, core } = await fixture(t);
  const directory = path.join(root, 'build');
  const frozen = await freezeBuild(agents, core, directory);
  const build = { directory, sha256: frozen.sha256 };
  const destination = path.join(root, 'copied-build');
  await cp(directory, destination, { recursive: true, verbatimSymlinks: true });
  assert.deepEqual(await inventory(destination), await inventory(directory));
  assert.equal((await verifyBuild({ ...build, directory: destination })).sha256, build.sha256);
  const file = path.join(destination, 'build.json');
  const recorded = JSON.parse(await readFile(file, 'utf8'));
  recorded.agentsRevision = '0'.repeat(40);
  await writeFile(file, JSON.stringify(recorded));
  await assert.rejects(verifyBuild({ ...build, directory: destination }), /digest/);
  await cp(path.join(directory, 'build.json'), file);
  await writeFile(path.join(destination, 'node_modules/@ismail-elkorchi/coding-agent/dist/cli.js'), '// changed executable');
  await assert.rejects(verifyBuild({ ...build, directory: destination }), /digest/);
  await verifyBuild(build);
});

test('preparation builds exact source instead of matching poisoned dist installations', { skip: process.platform !== 'linux' }, async t => {
  const { root, agents, core } = await fixture(t);
  await put(agents, 'coding-agent/dist/index.js', 'poisoned-agent');
  await put(core, 'packages/json/dist/index.js', 'matching-poisoned-core');
  await put(agents, 'node_modules/@agent-core/json/dist/index.js', 'matching-poisoned-core');
  const directory = path.join(root, 'build');
  const build = await freezeBuild(agents, core, directory);
  assert.equal(await readFile(path.join(directory, 'node_modules/@ismail-elkorchi/coding-agent/dist/index.js'), 'utf8'), 'export const answer = "source-agents";');
  assert.equal(await readFile(path.join(directory, 'node_modules/@agent-core/json/dist/index.js'), 'utf8'), 'export const answer = "source-core";');
  assert.equal(await readFile(path.join(core, 'packages/json/dist/index.js'), 'utf8'), 'matching-poisoned-core');
  assert.equal(build.sourceBuild.status, 'built-from-snapshots');
  assert.equal(build.format, 'agents.build/3');
  assert.equal(build.sourceBuild.pipeline.length, 4);
  assert.equal((await verifyBuild({ directory, sha256: build.sha256 })).sha256, build.sha256);
  await verifyBuildPreparation({ directory, sha256: build.sha256 });
  const buildFile = path.join(directory, 'build.json');
  const original = await readFile(buildFile);
  const { sha256: ignored, ...legacyIdentity } = build;
  void ignored;
  legacyIdentity.format = 'agents.build/2';
  const legacyHash = sha256(JSON.stringify(legacyIdentity));
  const legacy = Buffer.from(JSON.stringify({ ...legacyIdentity, sha256: legacyHash }));
  await writeFile(buildFile, legacy);
  await assert.rejects(verifyBuild({ directory, sha256: legacyHash }), /Unsupported frozen build format/);
  assert.deepEqual(await readFile(buildFile), legacy, 'Incompatible build records remain unchanged.');
  await writeFile(buildFile, original);
  const second = await freezeBuild(agents, core, path.join(root, 'build-again'));
  assert.equal(second.sha256, build.sha256, 'timestamps and preparation locations are not identity');
  await writeFile(`${directory}.preparation/agents.tar`, 'tampered source archive');
  await assert.rejects(verifyBuildPreparation({ directory, sha256: build.sha256 }), /input changed/);
  await verifyBuild({ directory, sha256: build.sha256 });
});

test('qualification preserves added inputs, while clean diagnostics reject them', { skip: process.platform !== 'linux' }, async t => {
  const { root, agents, core } = await fixture(t);
  await put(agents, 'coding-agent/added.js', 'export const answer = "new-input";');
  await assert.rejects(freezeBuild(agents, core, path.join(root, 'clean')), /untracked inputs/);
  const script = await readFile(path.join(agents, 'build.mjs'), 'utf8');
  await put(agents, 'build.mjs', script.replace('coding-agent/source.js', 'coding-agent/added.js'));
  const directory = path.join(root, 'qualified');
  const build = await freezeBuild(agents, core, directory, { qualification: true });
  assert(build.sourceBuild.sources.agents.files['coding-agent/added.js']);
  assert.equal(build.sourceBuild.sources.agents.kind, 'working-tree-snapshot');
  assert.equal(await readFile(path.join(directory, 'node_modules/@ismail-elkorchi/coding-agent/dist/index.js'), 'utf8'), 'export const answer = "new-input";');
  const { stdout } = await execute('tar', ['-xOf', `${directory}.preparation/agents.tar`, './coding-agent/added.js']);
  assert.equal(stdout, 'export const answer = "new-input";');
});

test('pin mismatch and failed build cannot emit qualified build evidence', { skip: process.platform !== 'linux' }, async t => {
  const { root, agents, core } = await fixture(t);
  const manifest = JSON.parse(await readFile(path.join(agents, 'package.json'), 'utf8'));
  const pin = manifest.agentCore.commit;
  manifest.agentCore.commit = '0'.repeat(40);
  await put(agents, 'package.json', manifest);
  await assert.rejects(freezeBuild(agents, core, path.join(root, 'mismatch'), { qualification: true }), /pin\/path/);
  manifest.agentCore.commit = pin;
  await put(agents, 'package.json', manifest);
  await put(agents, 'build.mjs', 'throw new Error("build fails");');
  const directory = path.join(root, 'failed');
  await assert.rejects(freezeBuild(agents, core, directory, { qualification: true }), /agents-build/);
  await assert.rejects(readFile(path.join(directory, 'build.json')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(`${directory}.preparation/receipt.json`, 'utf8')).status, 'failed');
});

test('snapshot inventory records deleted and binary source inputs exactly', { skip: process.platform !== 'linux' }, async t => {
  const { root, agents } = await fixture(t);
  await rm(path.join(agents, 'coding-agent/source.js'));
  await writeFile(path.join(agents, 'binary'), Buffer.from([0, 255, 1]));
  const snapshot = await snapshotBuildSource(agents, path.join(root, 'snapshot'), { qualification: true });
  assert.equal(snapshot.files['coding-agent/source.js'], undefined);
  assert(snapshot.files.binary);
  assert.deepEqual(await readFile(path.join(root, 'snapshot/binary')), Buffer.from([0, 255, 1]));
});

test('dependency manifest and lockfile disagreement fails preparation', { skip: process.platform !== 'linux' }, async t => {
  const { root, agents, core } = await fixture(t);
  const manifest = JSON.parse(await readFile(path.join(agents, 'package.json'), 'utf8'));
  manifest.devDependencies['missing-dependency'] = '99.99.99';
  await put(agents, 'package.json', manifest);
  const directory = path.join(root, 'bad-dependencies');
  await assert.rejects(freezeBuild(agents, core, directory, { qualification: true }), /agents-install/);
  await assert.rejects(readFile(path.join(directory, 'build.json')), { code: 'ENOENT' });
});

test('the normal source pin checker remains the authority in a genuine snapshot checkout', { skip: process.platform !== 'linux' }, async t => {
  const { root, agents, core } = await fixture(t);
  await put(agents, 'build.mjs', (await readFile(path.join(agents, 'build.mjs'), 'utf8')) +
    `\nimport {execFileSync} from 'node:child_process';const actual=execFileSync('git',['rev-parse','HEAD'],{cwd:'../agent-core',encoding:'utf8'}).trim();if(actual!==JSON.parse(await (await import('node:fs/promises')).readFile('package.json')).agentCore.commit)throw new Error('Wrong genuine Git HEAD');`);
  const directory = path.join(root, 'git-backed');
  await freezeBuild(agents, core, directory, { qualification: true });
  await assert.rejects(readFile(path.join(directory, '.git/HEAD')), { code: 'ENOENT' });
  const { stdout } = await execute('tar', ['-tf', `${directory}.preparation/core.tar`]);
  assert(!stdout.split('\n').some(name => name.split('/').includes('.git')));
});

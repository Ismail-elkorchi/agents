import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute, inventory, runtimeIdentity, sha256 } from './evaluation-isolation.mjs';
import { packPackages } from '../scripts/pack-packages.mjs';

const git = async (root, args) => (await execute('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 })).stdout;

// Capture bytes, not diff text: added, deleted, binary and executable inputs all
// participate. Ignored build products and installations never enter a snapshot.
export async function snapshotBuildSource(root, destination, { qualification = false } = {}) {
  const revision = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const tree = (await git(root, ['rev-parse', 'HEAD^{tree}'])).trim();
  const status = await git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!qualification && status) throw new Error('Diagnostic builds require clean source, including untracked inputs.');
  await mkdir(destination, { recursive: true });
  if (!status) {
    const archive = path.join(path.dirname(destination), `${path.basename(destination)}-commit.tar`);
    await execute('git', ['archive', '--format=tar', `--output=${archive}`, revision], { cwd: root });
    await execute('tar', ['-xf', archive, '--no-same-owner', '-C', destination]);
    await rm(archive);
  }
  const names = [...new Set((await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean))].sort();
  for (const name of names) {
    if (name.split('/').some(part => ['node_modules', 'dist', '.git', '.agent-core'].includes(part)) || name.endsWith('.tsbuildinfo'))
      throw new Error(`Generated or private input is tracked: ${name}`);
    const from = path.join(root, name);
    let info;
    try { info = await lstat(from); } catch (error) { if (error.code === 'ENOENT' && qualification) continue; throw error; }
    if (!info.isFile()) throw new Error(`Build sources must be regular files: ${name}`);
    const target = path.join(destination, name);
    await mkdir(path.dirname(target), { recursive: true });
    if (status) {
      await cp(from, target);
      await chmod(target, info.mode & 0o111 ? 0o755 : 0o644);
    } else if (!(await lstat(target)).isFile()) throw new Error(`Commit snapshot omitted source: ${name}`);
  }
  const files = await inventory(destination);
  // A second capture prevents attributing a moving checkout to a single input.
  if (revision !== (await git(root, ['rev-parse', 'HEAD'])).trim() || status !== await git(root, ['status', '--porcelain=v1', '--untracked-files=all']))
    throw new Error('Source checkout changed during preparation.');
  for (const [name, file] of Object.entries(files)) {
    const info = await lstat(path.join(root, name));
    if (sha256(await readFile(path.join(root, name))) !== file.sha256 || Boolean(info.mode & 0o111) !== file.executable)
      throw new Error('Source checkout changed during preparation.');
  }
  return { revision, tree, kind: status ? 'working-tree-snapshot' : 'clean-commit', files, sha256: sha256(JSON.stringify(files)) };
}

export async function freezeBuild(agents, core, destination, { qualification = false, dependencyRetrieval = process.env.EVALUATION_DEPENDENCY_RETRIEVAL ?? 'offline' } = {}) {
  if (process.platform !== 'linux') throw new Error('Evaluation build preparation requires the Linux runner.');
  if (!['offline', 'online'].includes(dependencyRetrieval)) throw new Error('Unknown dependency retrieval policy.');
  destination = path.resolve(destination);
  for (const source of [agents, core])
    if (destination === path.resolve(source) || destination.startsWith(path.resolve(source) + path.sep))
      throw new Error('Build destination must be outside source checkouts.');
  await mkdir(destination, { recursive: false });
  const evidence = `${destination}.preparation`;
  await mkdir(evidence, { recursive: false });
  const temporary = await mkdtemp(path.join(tmpdir(), 'agents-source-build-'));
  const receipt = { format: 'agents.build-preparation/1', startedAt: new Date().toISOString(), status: 'preparing', steps: [] };
  try {
    const sourceAgents = path.join(temporary, 'agents');
    const sourceCore = path.join(temporary, 'agent-core');
    const sources = {
      core: await snapshotBuildSource(core, sourceCore, { qualification }),
      agents: await snapshotBuildSource(agents, sourceAgents, { qualification })
    };
    const manifest = JSON.parse(await readFile(path.join(sourceAgents, 'package.json'), 'utf8'));
    if (manifest.agentCore?.commit !== sources.core.revision || manifest.agentCore.path !== '../agent-core')
      throw new Error('Agents Core dependency pin/path does not match the source snapshot.');
    for (const [name, directory] of [['agents', sourceAgents], ['core', sourceCore]]) {
      await execute('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', path.join(evidence, `${name}.tar`), '-C', directory, '.']);
      sources[name].archiveSha256 = sha256(await readFile(path.join(evidence, `${name}.tar`)));
    }
    // Real detached Git identities keep the normal source-pin checker as the
    // only authority. Metadata is build-only, outside retained archives/runtime.
    for (const [name, original, directory] of [['core', core, sourceCore], ['agents', agents, sourceAgents]]) {
      const metadata = path.join(temporary, `${name}-git`);
      await execute('git', ['clone', '--shared', '--no-checkout', path.resolve(original), metadata]);
      await execute('git', ['update-ref', '--no-deref', 'HEAD', sources[name].revision], { cwd: metadata });
      await execute('git', ['read-tree', sources[name].revision], { cwd: metadata });
      await rename(path.join(metadata, '.git'), path.join(directory, '.git'));
      await rm(metadata, { recursive: true, force: true });
    }
    const preparation = {};
    for (const [name, url] of [['evaluation-build.mjs', import.meta.url], ['pack-packages.mjs', new URL('../scripts/pack-packages.mjs', import.meta.url)]]) {
      const bytes = await readFile(new URL(url));
      preparation[name] = sha256(bytes);
      await writeFile(path.join(evidence, name), bytes);
    }
    const npmCli = await realpath(process.env.npm_execpath || path.join(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'));
    const toolchain = { ...await runtimeIdentity(), npm: (await execute(process.execPath, [npmCli, '--version'])).stdout.trim(), npmCliSha256: sha256(await readFile(npmCli)), npmFilesSha256: sha256(JSON.stringify(await inventory(path.resolve(npmCli, '../..')))) };
    const locks = {};
    for (const [name, directory] of [['core', sourceCore], ['agents', sourceAgents]])
      locks[name] = sha256(await readFile(path.join(directory, 'package-lock.json')));
    const env = { ...process.env, npm_config_offline: String(dependencyRetrieval === 'offline'), npm_config_cache: process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE || path.join(tmpdir(), 'agents-evaluation-npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_ignore_scripts: 'false', npm_config_include: 'dev', PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
    delete env.NODE_OPTIONS;
    delete env.NODE_ENV;
    async function step(name, directory, args) {
      const log = `${receipt.steps.length + 1}-${name}.log`;
      const entry = { name, argv: ['node', 'npm-cli.js', ...args], log, status: 'running' };
      receipt.steps.push(entry);
      try {
        const result = await execute(process.execPath, [npmCli, ...args], { cwd: directory, env, maxBuffer: 32 * 1024 * 1024 });
        await writeFile(path.join(evidence, log), result.stdout + result.stderr);
        entry.status = 'passed';
      } catch (error) {
        await writeFile(path.join(evidence, log), String(error.stdout ?? '') + String(error.stderr ?? '') + error.message);
        entry.status = 'failed';
        throw new Error(`Build preparation failed at ${name}; see ${path.join(evidence, log)}`, { cause: error });
      }
    }
    await step('core-install', sourceCore, ['ci', ...(dependencyRetrieval === 'offline' ? ['--offline'] : ['--prefer-offline']), '--no-audit', '--no-fund']);
    await step('core-build', sourceCore, ['run', 'build']);
    await step('agents-install', sourceAgents, ['ci', ...(dependencyRetrieval === 'offline' ? ['--offline'] : ['--prefer-offline']), '--no-audit', '--no-fund']);
    await step('agents-build', sourceAgents, ['run', 'build']);
    for (const [name, directory] of [['core', sourceCore], ['agents', sourceAgents]])
      if (sha256(await readFile(path.join(directory, 'package-lock.json'))) !== locks[name]) throw new Error('Build changed a pinned lockfile.');
    toolchain.compilers = {};
    for (const [name, directory] of [['core', sourceCore], ['agents', sourceAgents]]) {
      try { toolchain.compilers[name] = sha256(JSON.stringify(await inventory(path.join(directory, 'node_modules/typescript')))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const modules = path.join(destination, 'node_modules');
    const packs = path.join(temporary, 'packs');
    const packages = await copyRuntimeDependencyClosure({ entry: path.join(sourceAgents, 'coding-agent'),
      sourceRoots: { agents: sourceAgents, core: sourceCore }, modules, packs, evidence, npmCli, env });
    const build = { format: 'agents.build/3', agentsRevision: sources.agents.revision, coreRevision: sources.core.revision,
      dependencyPin: manifest.agentCore.commit, qualification, releaseQualification: 'not-verified-by-preparation',
      sourceBuild: { status: 'built-from-snapshots', preparation, sources, locks, toolchain, packages, pipeline: receipt.steps.map(({ name, argv, status }) => ({ name, argv, status })) },
      ...await runtimeIdentity(), files: await inventory(destination) };
    build.sha256 = sha256(JSON.stringify(build));
    await writeFile(path.join(destination, 'build.json'), JSON.stringify(build, null, 2));
    receipt.dependencyRetrieval = dependencyRetrieval;
    receipt.status = 'prepared'; receipt.buildSha256 = build.sha256;
    return build;
  } catch (error) {
    receipt.status = 'failed'; receipt.error = error.message;
    await rm(path.join(destination, 'build.json'), { force: true });
    throw error;
  } finally {
    receipt.endedAt = new Date().toISOString();
    try {
      await writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2));
      await rm(temporary, { recursive: true, force: true });
    } catch (error) {
      await rm(path.join(destination, 'build.json'), { force: true });
      throw error;
    }
  }
}

/** Retain each physical module instance once and bind every dependency to its exact resolution. */
export async function copyRuntimeDependencyClosure({ entry, sourceRoots, modules, packs, evidence, npmCli, env = process.env }) {
  if (process.platform !== 'linux') throw new Error('Evaluation dependency preparation requires the Linux runner.');
  const roots = await Promise.all(Object.entries(sourceRoots).map(async ([name, root]) => [name, await realpath(root)]));
  await mkdir(modules); await mkdir(packs, { recursive: true });
  await mkdir(path.join(evidence, 'packs'), { recursive: true });
  const instances = new Map();
  const packages = {};
  function sourceIdentity(root) {
    for (const [name, directory] of roots) {
      const relative = path.relative(directory, root);
      if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
        return `${name}/${relative.split(path.sep).join('/')}`;
    }
    throw new Error(`Runtime dependency resolves outside prepared source roots: ${root}`);
  }
  async function link(directory, name, target) {
    if (!/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/iu.test(name) || name === '.' || name === '..')
      throw new Error(`Invalid runtime package name: ${name}`);
    const destination = path.join(directory, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await symlink(path.relative(path.dirname(destination), target), destination);
  }
  async function resolveDependency(packageRoot, name, optional) {
    let directory = packageRoot;
    for (;;) {
      // Node skips an ancestor named node_modules rather than searching
      // node_modules/node_modules, which would create a different resolution.
      if (path.basename(directory) !== 'node_modules') {
        try { return await realpath(path.join(directory, 'node_modules', name)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const parent = path.dirname(directory);
      if (parent === directory) {
        if (optional) return undefined;
        throw new Error(`Missing build dependency: ${name}`);
      }
      directory = parent;
    }
  }
  async function copyPackage(packageRoot) {
    packageRoot = await realpath(packageRoot);
    const existing = instances.get(packageRoot);
    if (existing) return existing;
    const source = sourceIdentity(packageRoot);
    const id = sha256(source);
    const pkg = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    const target = path.join(modules, '.packages', id);
    const instance = { name: pkg.name, target, dependencies: [] };
    instances.set(packageRoot, instance);
    await mkdir(target, { recursive: true });
    if (pkg.name.startsWith('@agent-core/') || pkg.name === '@ismail-elkorchi/coding-agent') {
      const packagePacks = path.join(packs, id);
      await mkdir(packagePacks);
      const dependencies = await packPackages([packageRoot], packagePacks, npmCli, env);
      const archive = dependencies[pkg.name].slice(5);
      const archiveName = `${id}-${path.basename(archive)}`;
      packages[source] = { name: pkg.name, version: pkg.version, archive: archiveName, archiveSha256: sha256(await readFile(archive)) };
      await cp(archive, path.join(evidence, 'packs', archiveName));
      await execute('tar', ['-xf', archive, '--strip-components=1', '-C', target]);
    } else await cp(packageRoot, target, { recursive: true, dereference: true,
      filter: file => !['.git', 'node_modules'].includes(path.basename(file)) });
    const dependencies = { ...pkg.peerDependencies, ...pkg.dependencies, ...pkg.optionalDependencies };
    for (const name of Object.keys(dependencies).sort()) {
      const optional = Object.hasOwn(pkg.optionalDependencies ?? {}, name) ||
        (!Object.hasOwn(pkg.dependencies ?? {}, name) && pkg.peerDependenciesMeta?.[name]?.optional === true);
      const resolved = await resolveDependency(packageRoot, name, optional);
      if (!resolved) continue;
      const dependency = await copyPackage(resolved);
      await link(path.join(target, 'node_modules'), name, dependency.target);
      instance.dependencies.push([name, dependency]);
    }
    return instance;
  }
  const root = await copyPackage(entry);
  await link(modules, root.name, root.target);
  for (const [name, dependency] of root.dependencies)
    if (name !== root.name) await link(modules, name, dependency.target);
  return packages;
}

// This checks frozen content integrity. Source-build proof comes from preparation,
// not from merely hashing an arbitrary existing installation.
export async function verifyBuild(build) {
  const recorded = JSON.parse(await readFile(path.join(build.directory, 'build.json'), 'utf8'));
  if (recorded.format !== 'agents.build/3') throw new Error(`Unsupported frozen build format: ${recorded.format}.`);
  const { sha256: digest, ...identity } = recorded;
  const files = await inventory(build.directory);
  delete files['build.json'];
  if (recorded.sourceBuild?.status !== 'built-from-snapshots' || digest !== build.sha256 ||
      sha256(JSON.stringify(identity)) !== build.sha256 || JSON.stringify(files) !== JSON.stringify(recorded.files))
    throw new Error('Agent build content does not match its pinned digest.');
  return recorded;
}

// Retained derivation evidence is checked separately from runtime integrity.
// This proves consistency with the trusted preparation receipt, not authenticity
// of an independently fabricated receipt or a substitute for release testing.
export async function verifyBuildPreparation(build) {
  const recorded = await verifyBuild(build);
  const evidence = `${build.directory}.preparation`;
  const receipt = JSON.parse(await readFile(path.join(evidence, 'receipt.json'), 'utf8'));
  const sources = recorded.sourceBuild.sources;
  if (receipt.status !== 'prepared' || receipt.buildSha256 !== build.sha256)
    throw new Error('Build preparation evidence does not match its pinned identity.');
  const inputs = [
    ...Object.entries(sources).map(([name, source]) => [`${name}.tar`, source.archiveSha256]),
    ...Object.entries(recorded.sourceBuild.preparation),
    ...Object.values(recorded.sourceBuild.packages).map(pkg => [`packs/${pkg.archive}`, pkg.archiveSha256])
  ];
  for (const [name, digest] of inputs) {
    if (path.isAbsolute(name) || name.split('/').includes('..') ||
        sha256(await readFile(path.join(evidence, name))) !== digest)
      throw new Error(`Build preparation input changed: ${name}`);
  }
  return recorded;
}

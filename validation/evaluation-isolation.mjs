import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

export const execute = promisify(execFile);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export async function runtimeIdentity() {
  return { node: process.version, nodeSha256: sha256(await readFile(process.execPath)),
    platform: process.platform, architecture: process.arch };
}
export async function readFrozen(value) {
  const bytes = await readFile(value.path);
  if (sha256(bytes) !== value.sha256) throw new Error(`Frozen input changed: ${value.path}`);
  return bytes;
}

export async function inventory(root) {
  const result = {};
  async function visit(relative) {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      const file = path.posix.join(relative, name);
      const info = await lstat(path.join(root, file));
      if (info.isDirectory()) await visit(file);
      else if (info.isFile()) result[file] = { sha256: sha256(await readFile(path.join(root, file))), executable: Boolean(info.mode & 0o111) };
      else if (info.isSymbolicLink()) {
        const target = await readlink(path.join(root, file));
        const resolved = path.resolve(root, path.dirname(file), target);
        if (path.isAbsolute(target) || !resolved.startsWith(path.resolve(root) + path.sep))
          throw new Error(`Artifact symlink escapes its workspace: ${file}`);
        // Lexical containment alone misses paths through another link followed
        // by "..". Reject dangling/cyclic links as well as resolved escapes.
        const actual = await realpath(path.join(root, file));
        if (!actual.startsWith(path.resolve(root) + path.sep))
          throw new Error(`Artifact symlink resolves outside its workspace: ${file}`);
        result[file] = { symlink: target };
      } else throw new Error(`Unsupported special artifact: ${file}`);
    }
  }
  await visit('');
  return result;
}

export async function freezeRepository(source, revision, destination) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Use an exact Git revision.');
  const { stdout: entries } = await execute('git', ['ls-tree', '-r', revision], { cwd: source, maxBuffer: 32 * 1024 * 1024 });
  if (entries.split('\n').some(line => /^(120000|160000) /.test(line)))
    throw new Error('Task snapshots with symlinks or submodules require an explicit flattened snapshot.');
  const { stdout: tree } = await execute('git', ['rev-parse', `${revision}^{tree}`], { cwd: source });
  await execute('git', ['archive', '--format=tar', `--output=${path.resolve(destination)}`, revision], { cwd: source });
  return { revision, tree: tree.trim(), snapshot: { path: path.resolve(destination), sha256: sha256(await readFile(destination)) } };
}

export async function unpack(frozen, destination) {
  await readFrozen(frozen);
  // Only trusted, hash-pinned archives enter this boundary. Validate paths anyway.
  const { stdout } = await execute('tar', ['-tf', frozen.path], { maxBuffer: 32 * 1024 * 1024 });
  if (stdout.split('\n').filter(Boolean).some(name =>
    name.startsWith('/') || name.split('/').includes('..') || name.split('/').includes('.git')))
    throw new Error('Archive contains an unsafe path or Git history.');
  const { stdout: verbose } = await execute('tar', ['-tvf', frozen.path], { maxBuffer: 32 * 1024 * 1024 });
  if (verbose.split('\n').filter(Boolean).some(line => !['-', 'd'].includes(line[0])))
    throw new Error('Archives must contain only directories and regular files.');
  await mkdir(destination, { recursive: true });
  await execute('tar', ['-xf', frozen.path, '--no-same-owner', '-C', destination]);
}

// Export only executable application packages and dependencies. Never mount the
// source checkout, evaluator, Git object database, tests, credentials or HOME.
export async function freezeBuild(agents, core, destination, { qualification = false } = {}) {
  await mkdir(destination, { recursive: false });
  const git = async (root, args) => (await execute('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 })).stdout.trim();
  const agentsRevision = await git(agents, ['rev-parse', 'HEAD']);
  const coreRevision = await git(core, ['rev-parse', 'HEAD']);
  const changes = { agents: await git(agents, ['diff', 'HEAD']), core: await git(core, ['diff', 'HEAD']) };
  if (!qualification && (changes.agents || changes.core)) throw new Error('Diagnostic builds must have clean tracked source.');
  const manifest = JSON.parse(await readFile(path.join(agents, 'package.json'), 'utf8'));
  if (manifest.agentCore.commit !== coreRevision) throw new Error('Agents Core dependency pin does not match the build.');
  const modules = path.join(destination, 'node_modules');
  await mkdir(modules);
  const visited = new Map();
  async function copyPackage(packageRoot) {
    packageRoot = await realpath(packageRoot);
    const pkg = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    if (visited.has(pkg.name)) {
      if (visited.get(pkg.name) !== packageRoot)
        throw new Error(`Build contains conflicting installations of ${pkg.name}; cannot flatten its dependency layout.`);
      return;
    }
    visited.set(pkg.name, packageRoot);
    const target = path.join(modules, pkg.name);
    await mkdir(target, { recursive: true });
    const own = pkg.name.startsWith('@agent-core/') || pkg.name === '@ismail-elkorchi/coding-agent';
    if (pkg.name.startsWith('@agent-core/')) {
      const name = pkg.name.slice('@agent-core/'.length);
      const source = path.join(core, name.startsWith('provider-')
        ? `packages/providers/${name.slice('provider-'.length)}` : `packages/${name}`);
      const installed = await inventory(path.join(packageRoot, 'dist'));
      const compiled = await inventory(path.join(source, 'dist'));
      if (JSON.stringify(installed) !== JSON.stringify(compiled) ||
          !(await readFile(path.join(packageRoot, 'package.json'))).equals(await readFile(path.join(source, 'package.json'))))
        throw new Error(`Installed ${pkg.name} differs from the declared Core build; rebuild and reinstall dependencies.`);
    }
    if (own) {
      await cp(path.join(packageRoot, 'dist'), path.join(target, 'dist'), { recursive: true, dereference: true });
      await cp(path.join(packageRoot, 'package.json'), path.join(target, 'package.json'));
    } else await cp(packageRoot, target, {
      recursive: true, dereference: true,
      filter: file => !['.git', 'node_modules'].includes(path.basename(file))
    });
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      let directory = packageRoot;
      let resolved;
      for (;;) {
        try { resolved = await realpath(path.join(directory, 'node_modules', name)); break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const parent = path.dirname(directory);
        if (parent === directory) throw new Error(`Missing build dependency: ${name}`);
        directory = parent;
      }
      await copyPackage(resolved);
    }
  }
  await copyPackage(path.join(agents, 'coding-agent'));
  const files = await inventory(destination);
  const build = {
    format: 'agents.build/1', agentsRevision, coreRevision,
    dependencyPin: manifest.agentCore.commit, qualification,
    releaseQualification: 'not-verified-by-export',
    sourceDiffSha256: { agents: sha256(changes.agents), core: sha256(changes.core) },
    ...await runtimeIdentity(),
    files
  };
  // The pin binds attribution and runtime identity, not only executable bytes.
  build.sha256 = sha256(JSON.stringify(build));
  await writeFile(path.join(destination, 'build.json'), JSON.stringify(build, null, 2));
  return build;
}

export async function verifyBuild(build) {
  const recorded = JSON.parse(await readFile(path.join(build.directory, 'build.json'), 'utf8'));
  const { sha256: digest, ...identity } = recorded;
  const files = await inventory(build.directory);
  delete files['build.json'];
  if (recorded.format !== 'agents.build/1' || digest !== build.sha256 ||
      sha256(JSON.stringify(identity)) !== build.sha256 ||
      JSON.stringify(files) !== JSON.stringify(recorded.files))
    throw new Error('Agent build content does not match its pinned digest.');
  return recorded;
}

export function sandboxArgs({ workspace, build, state, socket, runner, checks, readOnly = false, cwd = '/work' }) {
  if (process.platform !== 'linux') throw new Error('Evaluation requires Linux bubblewrap; no host fallback.');
  const args = ['--unshare-all', '--die-with-parent', '--new-session',
    '--cap-drop', 'ALL', '--clearenv',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
    '--dir', '/runtime', '--ro-bind', process.execPath, '/runtime/node',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--dir', '/home', '--dir', '/home/agent',
    '--setenv', 'HOME', '/home/agent', '--setenv', 'PATH', '/runtime:/usr/bin:/bin',
    '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'TMPDIR', '/tmp',
    readOnly ? '--ro-bind' : '--bind', workspace, '/work', '--chdir', cwd];
  if (build) args.push('--ro-bind', build, '/build');
  if (state) args.push('--bind', state, '/state');
  if (runner) args.push('--ro-bind', runner, '/bridge.mjs');
  if (socket) args.push('--ro-bind', socket, '/provider.sock');
  if (checks) args.push('--ro-bind', checks, '/checks');
  return args;
}

export function runAcceptanceCheck({ workspace, verifier, check, signal }) {
  return launch([...sandboxArgs({ workspace, checks: verifier, cwd: `/work/${check.cwd}` }), ...check.argv],
    { timeoutMs: check.timeoutMs, signal }).done;
}

// PID namespaces, not process-group membership, contain detached grandchildren.
// Killing the namespace init kills every process, including setsid descendants.
export function launch(args, { signal, timeoutMs, onLine, maxOutputBytes = 16 * 1024 * 1024 } = {}) {
  signal?.throwIfAborted();
  const child = spawn('bwrap', args, { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
  let stderr = '', stdout = '', buffered = '', bytes = 0, stopped, closed = false;
  const stop = reason => { if (!closed) { stopped ??= reason; child.kill('SIGKILL'); } };
  const cancel = () => stop('cancelled');
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = timeoutMs && setTimeout(() => stop('timeout'), timeoutMs);
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536); });
  child.stdout.setEncoding('utf8').on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxOutputBytes) { stop('output_limit'); return; }
    if (!onLine) { stdout = (stdout + chunk).slice(-65536); return; }
    buffered += chunk;
    for (;;) {
      const end = buffered.indexOf('\n');
      if (end < 0) break;
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      try { onLine(line); } catch { stop('invalid_output'); }
    }
  });
  child.stdin.on('error', () => {});
  const done = new Promise(resolve => {
    let error;
    child.once('error', value => { error = value.message; });
    child.once('close', (code, terminationSignal) => {
      closed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve({ code, signal: terminationSignal, stopped, stderr, ...(onLine ? {} : { stdout }), error });
    });
  });
  return { child, done, stop };
}

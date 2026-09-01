import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSandbox, openSandboxExecutionRepository } from '@ismail-elkorchi/sandbox';
import { loadRepositoryInstructions } from '../dist/instructions/repository-instructions.js';
import { SandboxGitRepositoryObserver } from '../dist/workspace/git/sandbox-git-observer.js';
import { inspectRepositoryOrientation } from '../dist/workspace/repository-orientation.js';
import { openCodingWorkspace } from '../dist/workspace.js';

const sandboxAvailable = process.platform === 'linux' && await (async () => {
  const sandbox = await createSandbox();
  try { return (await sandbox.probe()).backends.some((backend) => backend.id === 'linux-namespace-v1' && backend.available); }
  catch { return false; }
  finally { await sandbox.dispose(); }
})();

test('sandboxed Git observation uses an inert bounded request and parses porcelain output', async () => {
  const repository = new FakeExecutionRepository(statusOutput([
    '# branch.oid 0123456789012345678901234567890123456789',
    '# branch.head main',
    '? untracked file.txt',
    '1 M. N... 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 tracked.txt'
  ]));
  const observer = new SandboxGitRepositoryObserver({ repository, gitExecutable: '/usr/bin/git' });
  const result = await observer.observe({ workspaceRoot: '/physical/workspace', gitDirectory: '/physical/workspace/.git' });
  assert.equal(result.kind, 'observed');
  assert.equal(result.branch, 'main');
  assert.equal(result.head, '0123456789012345678901234567890123456789');
  assert.deepEqual(result.entries, [
    { path: 'untracked file.txt', state: 'untracked' },
    { path: 'tracked.txt', state: 'M.' }
  ]);
  const run = repository.request.run;
  assert.deepEqual(run.policy.network, { mode: 'none' });
  assert.deepEqual(run.policy.process, { hostProcesses: 'deny', hostIpc: 'deny' });
  assert.deepEqual(run.policy.filesystem.grants, [{
    hostPath: '/physical/workspace', targetPath: '/workspace', access: 'read', execution: 'deny', rootResolution: 'reject-if-link'
  }]);
  assert.equal(run.process.environment.base, 'empty');
  assert.equal(run.process.environment.set.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(run.process.environment.set.GIT_TERMINAL_PROMPT, '0');
  assert.ok(run.process.args.includes('core.fsmonitor=false'));
  assert.ok(run.process.args.includes('--no-optional-locks'));
  assert.equal(repository.activationCount, 1);
  await observer.close();
});

test('repository orientation resolves linked worktree metadata and makes hostile status paths visible', async () => {
  const container = await mkdtemp(path.join(tmpdir(), 'coding-agent-git-location-'));
  const root = path.join(container, 'repository');
  const worktree = path.join(container, 'worktree');
  await mkdir(root);
  initializeRepository(root);
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'linked', worktree], { cwd: root });
  const workspace = await openCodingWorkspace(worktree, { stateRoot: path.join(container, 'state') });
  const locations = [];
  const observer = {
    async observe(location) {
      locations.push(location);
      return {
        kind: 'observed',
        branch: 'linked',
        entries: [{ path: 'src/visible\u202Ehidden.ts', state: 'untracked' }],
        totalEntries: 1,
        omittedEntries: 0,
        coverage: 'complete',
        receipt: {
          executionId: 'fixture', requestDigest: `sha256:${'1'.repeat(64)}`, policyDigest: '2'.repeat(64),
          executionDigest: '3'.repeat(64), backend: 'fixture', backendVersion: '1'
        }
      };
    },
    async close() {}
  };
  try {
    const instructions = await loadRepositoryInstructions(workspace);
    const orientation = await inspectRepositoryOrientation(workspace, instructions, undefined, observer);
    assert.equal(orientation.versionControl.kind, 'git');
    assert.equal(orientation.versionControl.status.kind, 'observed');
    assert.match(orientation.versionControl.status.entries[0].path, /\\u\{202E\}/u);
    assert.deepEqual(orientation.versionControl.status.entries[0].hazards, ['bidirectional_control']);
    assert.ok(locations[0].gitDirectory.startsWith(path.join(root, '.git', 'worktrees')));
    assert.equal(locations[0].commonDirectory, path.join(root, '.git'));
  } finally {
    workspace.fileRoot.close();
    await rm(container, { recursive: true, force: true });
  }
});

test('sandboxed Git observation reports bounded partial coverage and fails before admission when cancelled', async () => {
  const records = ['# branch.oid (initial)', '# branch.head (detached)'];
  for (let index = 0; index < 2_005; index += 1) records.push(`? file-${index}.txt`);
  const repository = new FakeExecutionRepository(statusOutput(records));
  const observer = new SandboxGitRepositoryObserver({ repository, gitExecutable: '/usr/bin/git' });
  const result = await observer.observe({ workspaceRoot: '/physical/workspace', gitDirectory: '/physical/workspace/.git' });
  assert.equal(result.kind, 'observed');
  assert.equal(result.branch, undefined);
  assert.equal(result.head, undefined);
  assert.equal(result.entries.length, 2_000);
  assert.equal(result.totalEntries, 2_005);
  assert.equal(result.omittedEntries, 5);
  assert.equal(result.coverage, 'partial');

  const controller = new AbortController();
  controller.abort(new Error('cancelled before Git admission'));
  await assert.rejects(observer.observe({ workspaceRoot: '/physical/workspace', gitDirectory: '/physical/workspace/.git' }, controller.signal), /cancelled before Git admission/);
  assert.equal(repository.prepareCount, 1);
  await observer.close();
});

test('repository orientation identifies bare repositories without invoking Git', async () => {
  const container = await mkdtemp(path.join(tmpdir(), 'coding-agent-bare-git-'));
  const root = path.join(container, 'repository.git');
  execFileSync('git', ['init', '--bare', '-q', root]);
  const workspace = await openCodingWorkspace(root, { stateRoot: path.join(container, 'state') });
  try {
    const orientation = await inspectRepositoryOrientation(workspace, await loadRepositoryInstructions(workspace), undefined);
    assert.deepEqual(orientation.versionControl, { kind: 'git', status: { kind: 'unavailable', reason: 'bare_repository' } });
  } finally {
    workspace.fileRoot.close();
    await rm(container, { recursive: true, force: true });
  }
});

test('sandboxed Git status confines hostile repository helpers', { skip: !sandboxAvailable }, async () => {
  const container = await mkdtemp(path.join(tmpdir(), 'coding-agent-git-sandbox-'));
  const root = path.join(container, 'repository');
  const marker = path.join(container, 'helper-ran');
  const helper = path.join(container, 'helper.sh');
  const repositoryPath = path.join(container, 'executions');
  await mkdir(root);
  initializeRepository(root);
  await writeFile(helper, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\ncat\n`);
  await chmod(helper, 0o700);
  execFileSync('git', ['config', 'core.fsmonitor', helper], { cwd: root });
  execFileSync('git', ['config', 'filter.hostile.clean', helper], { cwd: root });
  await writeFile(path.join(root, '.gitattributes'), 'tracked.txt filter=hostile\n');
  await writeFile(path.join(root, 'tracked.txt'), 'changed\n');
  const workspace = await openCodingWorkspace(root, { stateRoot: path.join(container, 'state') });
  const repository = await openSandboxExecutionRepository({ directory: repositoryPath, maxRetainedOutputBytes: 2 * 1024 * 1024 });
  const observer = new SandboxGitRepositoryObserver({ repository, gitExecutable: '/usr/bin/git' });
  try {
    const orientation = await inspectRepositoryOrientation(workspace, await loadRepositoryInstructions(workspace), undefined, observer);
    assert.equal(orientation.versionControl.kind, 'git');
    assert.ok(orientation.versionControl.status.kind === 'observed'
      || (orientation.versionControl.status.kind === 'unavailable' && orientation.versionControl.status.reason === 'status_failed'));
    await assert.rejects(access(marker));
  } finally {
    await observer.close();
    workspace.fileRoot.close();
    await rm(container, { recursive: true, force: true });
  }
});

class FakeExecutionRepository {
  identity = 'fake-git-execution-repository';
  durability = 'application-process';
  activationCount = 0;
  prepareCount = 0;
  request;

  constructor(stdout) { this.stdout = stdout; }
  // This fake mirrors the upstream Sandbox `prepare` method and `prepared` wire state.
  async prepare(request) { this.prepareCount += 1; this.request = request; return prepared(request.executionId); }
  async activate() { this.activationCount += 1; }
  async inspect(executionId) { return settled(executionId, this.stdout); }
  async writeInput() { throw new Error('Git stdin is closed.'); }
  async closeInput() {}
  async terminate() {}
  async reconcile() { return { settled: [], unresolved: [] }; }
  async acknowledgeUnknown() {}
  async forget() {}
  async close() {}
}

function statusOutput(records) { return Buffer.from(`${records.join('\0')}\0`); }

function prepared(executionId) {
  return {
    kind: 'prepared', executionId, requestDigest: `sha256:${'1'.repeat(64)}`, policyDigest: '2'.repeat(64), executionDigest: '3'.repeat(64), expiresAtMs: Date.now() + 30_000,
    summary: {
      isolation: { kind: 'process' }, backend: { id: 'fixture', version: '1', stability: 'stable' },
      filesystem: { runtimeView: 'system', runtimeManifestDigest: '4'.repeat(64), grants: [], masks: [], privateHomePath: '/home/sandbox', temporaryPath: '/tmp' },
      network: { mode: 'none', topology: 'private-namespace' }, process: { hostProcesses: 'deny', hostIpc: 'deny' },
      resources: { wallTimeMs: 15_000, memoryBytes: 1, maxProcesses: 1, maxOutputBytes: 2 * 1024 * 1024, terminationGraceMs: 500 },
      execution: { executable: '/usr/bin/git', executableIdentityDigest: '5'.repeat(64), executableContentSha256: '6'.repeat(64), args: [], cwd: '/workspace', cwdIdentityDigest: '7'.repeat(64), environmentNames: [], sensitiveEnvironmentNames: [], stdin: 'closed', stdout: 'pipe', stderr: 'pipe' }
    },
    enforcement: { backend: 'fixture', guarantees: [], caveats: [] },
    output: emptyOutput()
  };
}

function settled(executionId, stdout) {
  return {
    kind: 'settled', executionId, requestDigest: `sha256:${'1'.repeat(64)}`,
    output: {
      cursorStart: 0, cursorEnd: stdout.byteLength, availableCursorEnd: stdout.byteLength,
      stdoutBytes: stdout.byteLength, stderrBytes: 0, cursorExpired: false,
      chunks: [{ cursorStart: 0, cursorEnd: stdout.byteLength, stream: 'stdout', data: stdout }]
    },
    result: {
      processId: 'fixture-process', policyDigest: '2'.repeat(64), executionDigest: '3'.repeat(64),
      termination: { reason: 'exit', code: 0 }, enforcement: { backend: 'fixture', guarantees: [], caveats: [] },
      violations: [], usage: { wallTimeMs: 1, stdoutBytes: stdout.byteLength, stderrBytes: 0 }, cleanup: { completed: true, failures: [] }
    }
  };
}

function emptyOutput() {
  return { cursorStart: 0, cursorEnd: 0, availableCursorEnd: 0, stdoutBytes: 0, stderrBytes: 0, cursorExpired: false, chunks: [] };
}

function initializeRepository(root) {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'coding-agent@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Coding Agent Test'], { cwd: root });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
  execFileSync(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'tracked.txt'))}, 'base\\n')`]);
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
}

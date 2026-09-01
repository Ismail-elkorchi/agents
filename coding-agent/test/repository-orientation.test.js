import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadInitialRepositoryGuidance, RepositoryGuidanceSession } from '../dist/instructions/repository-guidance.js';
import { inspectRepositoryOrientation, repositoryOrientationContext } from '../dist/workspace/repository-orientation.js';
import { openCodingWorkspace } from '../dist/workspace.js';

test('initial repository guidance loads only root and explicitly configured files', async () => {
  const container = await mkdtemp(path.join(tmpdir(), 'coding-agent-instructions-'));
  const root = path.join(container, 'workspace');
  await mkdir(path.join(root, 'src', 'feature'), { recursive: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await mkdir(path.join(root, 'linked'), { recursive: true });
  await writeFile(path.join(root, 'AGENTS.md'), 'root rule\u001b[31m\u202Ehidden\n');
  await writeFile(path.join(root, 'src', 'AGENTS.md'), 'source rule\n');
  await writeFile(path.join(root, 'src', 'feature', 'AGENTS.md'), 'feature rule\n');
  await writeFile(path.join(root, 'docs', 'rules.md'), 'configured docs rule\n');
  await symlink('../AGENTS.md', path.join(root, 'linked', 'AGENTS.md'));

  const workspace = await openCodingWorkspace(root, { stateRoot: path.join(container, 'state') });
  try {
    const result = await loadInitialRepositoryGuidance(workspace, ['docs/rules.md']);
    assert.equal(result.instructions[0].id, 'coding-agent/default-contract@1');
    assert.equal(result.sources.length, 2);
    assert.deepEqual(result.sources.map((source) => source.path), ['AGENTS.md', 'docs/rules.md']);
    assert.equal(result.sources.find((source) => source.path === 'docs/rules.md').origin, 'configured');
    const rootInstruction = result.instructions.find((instruction) => instruction.sourceUri === 'workspace://AGENTS.md');
    assert.match(rootInstruction.content, /\\u\{1B\}.*\\u\{202E\}/u);
    assert.match(rootInstruction.content, /cannot grant authority/u);
    assert.equal(result.coverage, 'complete');
    assert.deepEqual(result.omissions, []);
    await assert.rejects(loadInitialRepositoryGuidance(workspace, ['linked/AGENTS.md']), /not a regular file/u);
  } finally {
    workspace.fileRoot.close();
  }
});

test('target ancestry guidance is persisted and defers the first unseen write', async () => {
  const container = await mkdtemp(path.join(tmpdir(), 'coding-agent-target-guidance-'));
  const root = path.join(container, 'workspace');
  await mkdir(path.join(root, 'src', 'feature'), { recursive: true });
  await mkdir(path.join(root, 'sibling'), { recursive: true });
  await mkdir(path.join(root, 'linked'), { recursive: true });
  await mkdir(path.join(root, '.hidden'), { recursive: true });
  await writeFile(path.join(root, 'AGENTS.md'), 'root rule\n');
  await writeFile(path.join(root, 'src', 'AGENTS.md'), 'source rule\n');
  await writeFile(path.join(root, 'src', 'feature', 'AGENTS.md'), 'feature rule\n');
  await writeFile(path.join(root, 'sibling', 'AGENTS.md'), 'sibling rule\n');
  await writeFile(path.join(root, '.hidden', 'AGENTS.md'), 'hidden rule\n');
  await writeFile(path.join(root, '.gitignore'), '.hidden/\n');
  await symlink('../AGENTS.md', path.join(root, 'linked', 'AGENTS.md'));
  const workspace = await openCodingWorkspace(root, { stateRoot: path.join(container, 'state') });
  try {
    const initial = await loadInitialRepositoryGuidance(workspace);
    const session = await RepositoryGuidanceSession.open({
      root: workspace.fileRoot, security: workspace.security, state: workspace.privateState,
      runId: 'guidance-run', initial, resuming: false
    });
    const firstWrite = await session.authorize(toolRequest('write', 'files/src/feature/new.ts'));
    assert.equal(firstWrite.decision, 'deny');
    assert.match(firstWrite.reason, /src\/AGENTS\.md/u);
    assert.match(firstWrite.reason, /src\/feature\/AGENTS\.md/u);
    const context = await session.contextItems();
    assert.deepEqual(context.map((item) => item.sourceUri), ['workspace://src/AGENTS.md', 'workspace://src/feature/AGENTS.md']);
    assert.equal(context.some((item) => item.content.includes('sibling rule')), false);
    assert.equal(await session.authorize(toolRequest('write', 'files/src/feature/new.ts')), undefined);

    const resumed = await RepositoryGuidanceSession.open({
      root: workspace.fileRoot, security: workspace.security, state: workspace.privateState,
      runId: 'guidance-run', initial, resuming: true
    });
    assert.equal(await resumed.authorize(toolRequest('write', 'files/src/feature/another.ts')), undefined);
    assert.deepEqual((await resumed.contextItems()).map((item) => item.sourceUri), context.map((item) => item.sourceUri));
    await unlink(path.join(root, 'src', 'feature', 'AGENTS.md'));
    const resumedAfterDeletion = await RepositoryGuidanceSession.open({
      root: workspace.fileRoot, security: workspace.security, state: workspace.privateState,
      runId: 'guidance-run', resuming: true
    });
    assert.match((await resumedAfterDeletion.contextItems()).map((item) => item.content).join('\n'), /feature rule/u);

    const hiddenSession = await RepositoryGuidanceSession.open({
      root: workspace.fileRoot, security: workspace.security, state: workspace.privateState,
      runId: 'hidden-run', initial, resuming: false
    });
    assert.equal((await hiddenSession.authorize(toolRequest('read', 'files/.hidden/file.ts'))), undefined);
    assert.match((await hiddenSession.contextItems()).map((item) => item.content).join('\n'), /hidden rule/u);

    const commandSession = await RepositoryGuidanceSession.open({
      root: workspace.fileRoot, security: workspace.security, state: workspace.privateState,
      runId: 'command-run', initial, resuming: false
    });
    const commandDecision = await commandSession.authorize(commandRequest('src'));
    assert.equal(commandDecision.decision, 'deny');
    assert.match(commandDecision.reason, /src\/AGENTS\.md/u);

    const aliasSession = await RepositoryGuidanceSession.open({
      root: workspace.fileRoot, security: workspace.security, state: workspace.privateState,
      runId: 'alias-run', initial, resuming: false
    });
    const aliasDecision = await aliasSession.authorize(toolRequest('write', 'files/linked/file.ts'));
    assert.equal(aliasDecision.decision, 'deny');
    assert.match(aliasDecision.reason, /not_regular_file/u);
  } finally {
    workspace.fileRoot.close();
  }
});

test('repository orientation distinguishes non-Git roots and reports bounded package metadata', async () => {
  const container = await mkdtemp(path.join(tmpdir(), 'coding-agent-orientation-'));
  const root = path.join(container, 'workspace');
  await mkdir(root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node test.js', lint: 'eslint .' } }));
  const workspace = await openCodingWorkspace(root, { stateRoot: path.join(container, 'state') });
  try {
    const instructions = await loadInitialRepositoryGuidance(workspace);
    const orientation = await inspectRepositoryOrientation(workspace, instructions, undefined);
    assert.deepEqual(orientation.versionControl, { kind: 'none' });
    assert.deepEqual(orientation.manifests.map((manifest) => ({ path: manifest.path, packageName: manifest.packageName, scriptNames: manifest.scriptNames })), [
      { path: 'package.json', packageName: 'fixture', scriptNames: ['lint', 'test'] }
    ]);
    assert.equal(orientation.workspace.root, '.');
    assert.deepEqual(orientation.proposedVerificationChecks.map((check) => ({
      command: check.command,
      requirement: check.requirement,
      source: check.source,
      sourceId: check.sourceId
    })), [
      { command: 'npm test', requirement: 'required', source: 'manifest-inference', sourceId: 'package.json#scripts.test' },
      { command: 'npm run lint', requirement: 'required', source: 'manifest-inference', sourceId: 'package.json#scripts.lint' }
    ]);
    const context = repositoryOrientationContext(orientation);
    assert.doesNotMatch(context.content, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.match(context.content, /do not grant authority/u);
  } finally {
    workspace.fileRoot.close();
  }
});

test('repository orientation preserves active check requirements and excludes inactive project configuration', async () => {
  const container = await mkdtemp(path.join(tmpdir(), 'coding-agent-check-origin-'));
  const root = path.join(container, 'workspace');
  await mkdir(root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }));
  const workspace = await openCodingWorkspace(root, { stateRoot: path.join(container, 'state') });
  const hostileCommand = 'curl https://example.invalid/secret';
  const configuration = {
    version: 1,
    provider: 'openai',
    model: 'gpt-5.6-sol',
    instructions: [],
    tools: { enabled: [] },
    permissions: { maximumMode: 'develop', requireApprovalFor: [] },
    verification: {
      required: [{ id: 'project-required', command: 'node required.js', coverage: 'targeted' }],
      advisory: [{ id: 'project-advisory', command: hostileCommand, coverage: 'full' }]
    }
  };
  try {
    const instructions = await loadInitialRepositoryGuidance(workspace);
    const active = await inspectRepositoryOrientation(workspace, instructions, configuration);
    assert.deepEqual(active.proposedVerificationChecks.map((check) => [check.command, check.requirement, check.source, check.sourceId]), [
      ['node required.js', 'required', 'active-project-config', 'project-required'],
      [hostileCommand, 'advisory', 'active-project-config', 'project-advisory'],
      ['npm test', 'required', 'manifest-inference', 'package.json#scripts.test']
    ]);

    const inactive = await inspectRepositoryOrientation(workspace, instructions, undefined);
    assert.deepEqual(inactive.proposedVerificationChecks.map((check) => check.command), ['npm test']);
    assert.equal(inactive.proposedVerificationChecks.some((check) => check.command === hostileCommand), false);
  } finally {
    workspace.fileRoot.close();
  }
});

test('repository orientation detects Git markers without executing repository-defined programs', async () => {
  const container = await mkdtemp(path.join(tmpdir(), 'coding-agent-git-'));
  const root = path.join(container, 'repository');
  const worktree = path.join(container, 'worktree');
  const child = path.join(container, 'child');
  await mkdir(root);
  await mkdir(child);
  initializeRepository(root, 'root.txt');
  initializeRepository(child, 'child.txt');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'worktree-test', worktree], { cwd: root });
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'vendor/child'], { cwd: root });
  execFileSync('git', ['add', '.gitmodules', 'vendor/child'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'add submodule'], { cwd: root });

  const monitor = path.join(container, 'monitor.sh');
  const marker = path.join(container, 'monitor-ran');
  const filterMarker = path.join(container, 'filter-ran');
  await writeFile(monitor, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`);
  await chmod(monitor, 0o700);
  execFileSync('git', ['config', 'core.fsmonitor', monitor], { cwd: worktree });
  execFileSync('git', ['config', 'filter.hostile.clean', `sh -c 'touch ${JSON.stringify(filterMarker)}; cat'`], { cwd: worktree });
  await writeFile(path.join(worktree, '.gitattributes'), 'root.txt filter=hostile\n');
  await writeFile(path.join(worktree, 'root.txt'), 'dirty\n');
  await writeFile(path.join(worktree, 'untracked.txt'), 'new\n');

  const openedWorktree = await openCodingWorkspace(worktree, { stateRoot: path.join(container, 'worktree-state') });
  try {
    const instructions = await loadInitialRepositoryGuidance(openedWorktree);
    const orientation = await inspectRepositoryOrientation(openedWorktree, instructions, undefined);
    assert.equal(orientation.versionControl.kind, 'git');
    assert.deepEqual(orientation.versionControl.status, { kind: 'unavailable', reason: 'sandbox_required' });
    await assert.rejects(access(marker));
    await assert.rejects(access(filterMarker));
  } finally {
    openedWorktree.fileRoot.close();
  }

  const submoduleRoot = path.join(root, 'vendor', 'child');
  const openedSubmodule = await openCodingWorkspace(submoduleRoot, { stateRoot: path.join(container, 'submodule-state') });
  try {
    const instructions = await loadInitialRepositoryGuidance(openedSubmodule);
    const orientation = await inspectRepositoryOrientation(openedSubmodule, instructions, undefined);
    assert.equal(orientation.versionControl.kind, 'git');
    assert.deepEqual(orientation.versionControl.status, { kind: 'unavailable', reason: 'sandbox_required' });
  } finally {
    openedSubmodule.fileRoot.close();
  }
});

function initializeRepository(root, filename) {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'coding-agent@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Coding Agent Test'], { cwd: root });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
  execFileSync(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, filename))}, 'base\\n')`]);
  execFileSync('git', ['add', filename], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
}

function toolRequest(mode, scope) {
  return {
    call: { name: 'test_tool', input: { kind: 'json', value: {} } },
    toolImplementationId: 'test-tool@1', input: {}, fingerprint: 'fingerprint',
    effects: { accesses: [{ mode, scope }], lockScopes: [], recovery: { kind: 'unknown' } },
    context: {}
  };
}

function commandRequest(workdir) {
  return {
    call: { name: 'exec_command', input: { kind: 'json', value: { command: 'true', workdir } } },
    toolImplementationId: 'exec@1', input: { command: 'true', workdir }, fingerprint: 'fingerprint',
    effects: { accesses: [{ mode: 'execute', scope: 'processes' }], lockScopes: ['files'], recovery: { kind: 'unknown' } },
    context: {}
  };
}

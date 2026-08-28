import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadRepositoryInstructions } from '../dist/instructions/repository-instructions.js';
import { inspectRepositoryOrientation, repositoryOrientationContext } from '../dist/workspace/repository-orientation.js';
import { openCodingWorkspace } from '../dist/workspace.js';

test('repository instructions are bounded, attributed, root-to-leaf scoped, and never follow aliases', async () => {
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
    const result = await loadRepositoryInstructions(workspace, ['docs/rules.md']);
    assert.equal(result.instructions[0].id, 'coding-agent/default-contract@1');
    assert.equal(result.sources.length, 4);
    assert.deepEqual(result.sources.map((source) => source.path), ['AGENTS.md', 'docs/rules.md', 'src/AGENTS.md', 'src/feature/AGENTS.md']);
    assert.equal(result.sources.find((source) => source.path === 'docs/rules.md').source, 'configured');
    assert.ok(result.sources.find((source) => source.path === 'src/feature/AGENTS.md').precedence > result.sources.find((source) => source.path === 'src/AGENTS.md').precedence);
    const rootInstruction = result.instructions.find((instruction) => instruction.sourceUri === 'workspace://AGENTS.md');
    assert.match(rootInstruction.content, /\\u\{1B\}.*\\u\{202E\}/u);
    assert.match(rootInstruction.content, /cannot grant authority/u);
    assert.equal(result.coverage, 'partial');
    assert.deepEqual(result.omissions.filter((item) => item.reason === 'not_regular_file').map((item) => item.path), ['linked/AGENTS.md']);
    await assert.rejects(loadRepositoryInstructions(workspace, ['linked/AGENTS.md']), /not a regular file/u);
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
    const instructions = await loadRepositoryInstructions(workspace);
    const orientation = await inspectRepositoryOrientation(workspace, instructions, undefined);
    assert.deepEqual(orientation.versionControl, { kind: 'none' });
    assert.deepEqual(orientation.manifests.map((manifest) => ({ path: manifest.path, packageName: manifest.packageName, scriptNames: manifest.scriptNames })), [
      { path: 'package.json', packageName: 'fixture', scriptNames: ['lint', 'test'] }
    ]);
    assert.equal(orientation.workspace.root, '.');
    assert.deepEqual(orientation.proposedVerificationCommands, ['npm test', 'npm run lint']);
    const context = repositoryOrientationContext(orientation);
    assert.doesNotMatch(context.content, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.match(context.content, /do not grant authority/u);
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
    const instructions = await loadRepositoryInstructions(openedWorktree);
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
    const instructions = await loadRepositoryInstructions(openedSubmodule);
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

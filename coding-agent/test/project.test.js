import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RootedFileAuthority } from '@agent-core/tools-local';
import { describeWorkspace, loadCodingAgentConfiguration, loadWorkspace, parseCodingAgentConfiguration } from '@ismail-elkorchi/coding-agent';
import { WorkspaceSecurityBoundary } from '../dist/security/workspace-security-boundary.js';
import { identifyCodingWorkspace } from '../dist/security/workspace-identity.js';

test('loadWorkspace rejects aliased roots instead of changing workspace authority', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'coding-agent-workspace-'));
  const realRoot = path.join(dir, 'workspace');
  const linkRoot = path.join(dir, 'workspace-link');
  await mkdir(realRoot);
  await symlink(realRoot, linkRoot, 'dir');

  await assert.rejects(loadWorkspace(linkRoot, { stateRoot: path.join(dir, 'state') }), /aliased|directory/u);
});

test('describeWorkspace remains a pure path description', () => {
  const stateRoot = path.resolve('state-root');
  const identity = { id: 'workspace-' + 'a'.repeat(64), platform: process.platform, canonicalPath: path.resolve('relative-workspace'), device: '1', inode: '2', mountId: '3' };
  const workspace = describeWorkspace(identity, stateRoot);
  assert.equal(workspace.workspaceRoot, identity.canonicalPath);
  assert.equal(workspace.runsDir, path.join(stateRoot, 'workspaces', identity.id, 'runs'));
  assert.equal(workspace.runtimeDir.startsWith(workspace.workspaceRoot), false);
});

test('private runtime state cannot be placed inside the workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'coding-agent-private-state-'));
  await assert.rejects(loadWorkspace(root, { stateRoot: path.join(root, 'state') }), /outside the workspace/u);
  await assert.rejects(loadWorkspace(root, { stateRoot: root }), /outside the workspace/u);
});

test('workspace configuration validates first-party policy, checks, and exact limit names', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'coding-agent-config-'));
  const configuration = {
    version: 1,
    provider: 'openai',
    model: 'gpt-5.6-sol',
    reasoning: { strategy: 'effort', effort: 'max', mode: 'standard' },
    instructions: [{ path: 'AGENTS.md' }],
    tools: { enabled: ['read_files'] },
    permissions: { maximumMode: 'edit', requireApprovalFor: ['write'] },
    verification: { required: [{ id: 'test', command: 'npm test', coverage: 'full', timeoutMs: 1_000 }], advisory: [] },
    limits: { modelTurns: 3, candidateRevisions: 0, knownCost: { amount: 10, currency: 'USD' } }
  };
  await writeFile(path.join(dir, 'coding-agent.config.json'), JSON.stringify(configuration));
  const root = RootedFileAuthority.adopt(dir);
  const security = new WorkspaceSecurityBoundary(identifyCodingWorkspace(root.identity), 'restricted');
  assert.deepEqual((await loadCodingAgentConfiguration(root, security)).value, configuration);
  const snapshot = parseCodingAgentConfiguration(configuration);
  configuration.instructions[0].path = 'changed.md';
  configuration.verification.required[0].command = 'changed';
  configuration.permissions.maximumMode = 'review';
  assert.equal(snapshot.instructions[0].path, 'AGENTS.md');
  assert.equal(snapshot.verification.required[0].command, 'npm test');
  assert.equal(snapshot.permissions.maximumMode, 'edit');
  assert.equal(Object.isFrozen(snapshot.verification.required[0]), true);
  configuration.instructions[0].path = 'AGENTS.md';
  configuration.verification.required[0].command = 'npm test';
  configuration.permissions.maximumMode = 'edit';
  assert.throws(() => parseCodingAgentConfiguration({ ...configuration, limits: { mysteryLimit: 1 } }), /run limits/iu);
  assert.throws(() => parseCodingAgentConfiguration({ ...configuration, limits: { candidateRevisions: -1 } }), /run limits/iu);
  assert.throws(() => parseCodingAgentConfiguration({ ...configuration, permissions: { maximumMode: 'edit', requireApprovalFor: ['network'] } }), /Permission approvals/u);
  assert.throws(() => parseCodingAgentConfiguration({ ...configuration, verification: { required: [{ id: 'same', command: 'true', coverage: 'targeted' }], advisory: [{ id: 'same', command: 'true', coverage: 'targeted' }] } }), /unique/u);
  assert.throws(() => parseCodingAgentConfiguration({ ...configuration, verification: { required: [{ id: 'test', command: 'npm test' }], advisory: [] } }), /Verification configuration/iu);
  assert.throws(() => parseCodingAgentConfiguration({ ...configuration, instructions: [{ path: 'AGENTS.md' }, { path: 'AGENTS.md' }] }), /instruction paths must be unique/u);
  assert.throws(() => parseCodingAgentConfiguration({ ...configuration, tools: { enabled: [], unknown: true } }), /tool configuration/iu);
  let accessed = false;
  const accessor = { ...configuration };
  Object.defineProperty(accessor, 'model', { enumerable: true, get() { accessed = true; return 'stolen'; } });
  assert.throws(() => parseCodingAgentConfiguration(accessor), /accessor/iu);
  assert.equal(accessed, false);
  const cyclic = { ...configuration };
  cyclic.loop = cyclic;
  assert.throws(() => parseCodingAgentConfiguration(cyclic), /cycle/iu);
  root.close();
});

test('workspace configuration cannot escape through a symlink', async () => {
  const container = await mkdtemp(path.join(tmpdir(), 'coding-agent-config-link-'));
  const root = path.join(container, 'workspace');
  await mkdir(root);
  const outside = path.join(container, 'outside.json');
  await writeFile(outside, '{}');
  await symlink(outside, path.join(root, 'linked.json'));
  const workspaceRoot = RootedFileAuthority.adopt(root);
  const security = new WorkspaceSecurityBoundary(identifyCodingWorkspace(workspaceRoot.identity), 'restricted');
  await assert.rejects(() => loadCodingAgentConfiguration(workspaceRoot, security, 'linked.json'), /symbolic|alias/iu);
  workspaceRoot.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describeWorkspace, loadCodingAgentConfiguration, loadWorkspace, parseCodingAgentConfiguration } from '@ismail-elkorchi/coding-agent';

test('loadWorkspace canonicalizes symlink roots', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'coding-agent-workspace-'));
  const realRoot = path.join(dir, 'workspace');
  const linkRoot = path.join(dir, 'workspace-link');
  await mkdir(realRoot);
  await symlink(realRoot, linkRoot, 'dir');

  const workspace = await loadWorkspace(linkRoot);
  assert.equal(workspace.workspaceRoot, await realpath(realRoot));
  assert.equal(workspace.runtimeDir, path.join(workspace.workspaceRoot, '.coding-agent'));
});

test('describeWorkspace remains a pure path description', () => {
  const workspace = describeWorkspace('relative-workspace');
  assert.equal(workspace.workspaceRoot, path.resolve('relative-workspace'));
  assert.equal(workspace.runsDir, path.join(workspace.workspaceRoot, '.coding-agent', 'runs'));
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
    authorization: { allowedRisks: ['read', 'write'], requireApprovalFor: ['write'] },
    verification: { required: [{ id: 'test', command: 'npm test', timeoutMs: 1_000 }], advisory: [] },
    limits: { modelTurns: 3, knownCost: { amount: 10, currency: 'USD' } }
  };
  await writeFile(path.join(dir, 'coding-agent.config.json'), JSON.stringify(configuration));
  assert.deepEqual(await loadCodingAgentConfiguration(dir), configuration);
  const snapshot = parseCodingAgentConfiguration(configuration);
  configuration.instructions[0].path = 'changed.md';
  configuration.verification.required[0].command = 'changed';
  configuration.authorization.allowedRisks[0] = 'execute';
  assert.equal(snapshot.instructions[0].path, 'AGENTS.md');
  assert.equal(snapshot.verification.required[0].command, 'npm test');
  assert.deepEqual(snapshot.authorization.allowedRisks, ['read', 'write']);
  assert.equal(Object.isFrozen(snapshot.verification.required[0]), true);
  configuration.instructions[0].path = 'AGENTS.md';
  configuration.verification.required[0].command = 'npm test';
  configuration.authorization.allowedRisks[0] = 'read';
  assert.throws(() => parseCodingAgentConfiguration({ ...configuration, limits: { mysteryLimit: 1 } }), /run limits/iu);
  assert.throws(() => parseCodingAgentConfiguration({ ...configuration, authorization: { allowedRisks: ['read'], requireApprovalFor: ['write'] } }), /Approval risks/u);
  assert.throws(() => parseCodingAgentConfiguration({ ...configuration, verification: { required: [{ id: 'same', command: 'true' }], advisory: [{ id: 'same', command: 'true' }] } }), /unique/u);
  assert.throws(() => parseCodingAgentConfiguration({ ...configuration, tools: { enabled: [], unknown: true } }), /tool configuration/iu);
  let accessed = false;
  const accessor = { ...configuration };
  Object.defineProperty(accessor, 'model', { enumerable: true, get() { accessed = true; return 'stolen'; } });
  assert.throws(() => parseCodingAgentConfiguration(accessor), /accessor/iu);
  assert.equal(accessed, false);
  const cyclic = { ...configuration };
  cyclic.loop = cyclic;
  assert.throws(() => parseCodingAgentConfiguration(cyclic), /cycle/iu);
});

test('workspace configuration cannot escape through a symlink', async () => {
  const container = await mkdtemp(path.join(tmpdir(), 'coding-agent-config-link-'));
  const root = path.join(container, 'workspace');
  await mkdir(root);
  const outside = path.join(container, 'outside.json');
  await writeFile(outside, '{}');
  await symlink(outside, path.join(root, 'linked.json'));
  await assert.rejects(() => loadCodingAgentConfiguration(root, 'linked.json'), /symlink escapes/u);
});

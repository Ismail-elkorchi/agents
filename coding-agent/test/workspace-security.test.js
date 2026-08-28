import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceFileRoot } from '@agent-core/tools-local';
import { adoptWorkspaceContent } from '../dist/security/content-provenance.js';
import { classifyImplicitExecution, implicitExecutionSurfaces } from '../dist/security/implicit-execution.js';
import { protectProviderEgress, redactSensitiveText } from '../dist/security/provider-egress.js';
import { identifyCodingWorkspace } from '../dist/security/workspace-identity.js';
import { createTrustDecision, decideToolEffects, decideWorkspaceAction, isSensitiveWorkspacePath } from '../dist/security/workspace-trust.js';
import { WorkspaceSecurityBoundary } from '../dist/security/workspace-security-boundary.js';
import { narrowRiskCeiling } from '../dist/config/project-proposal.js';
import { PrivateStateDirectory } from '../dist/state/private-state.js';
import { WorkspaceTrustStore } from '../dist/state/workspace-trust-store.js';

test('workspace identity binds the canonical path and exact adopted physical root', { skip: process.platform !== 'linux' }, async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'coding-agent-identity-'));
  const rootPath = path.join(parent, 'workspace');
  await mkdir(rootPath);
  const firstRoot = WorkspaceFileRoot.adopt(rootPath);
  const first = identifyCodingWorkspace(firstRoot.identity);
  await rename(rootPath, `${rootPath}-moved`);
  await mkdir(rootPath);
  const replacementRoot = WorkspaceFileRoot.adopt(rootPath);
  const replacement = identifyCodingWorkspace(replacementRoot.identity);
  assert.notEqual(first.id, replacement.id);
  assert.equal(first.canonicalPath, replacement.canonicalPath);
  firstRoot.close(); replacementRoot.close();
});

test('workspace trust records are private, checksummed, revocable, and invalid for changed identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'coding-agent-trust-'));
  const state = await PrivateStateDirectory.create(root);
  const store = new WorkspaceTrustStore(state);
  const workspace = Object.freeze({ id: 'workspace-' + 'a'.repeat(64), platform: process.platform, canonicalPath: '/workspace', device: '1', inode: '2', mountId: '3' });
  assert.equal(await store.read(workspace), undefined);
  const decision = createTrustDecision({ workspace, level: 'restricted', actorKind: 'user', actor: 'local-user', now: new Date('2026-08-28T00:00:00.000Z') });
  await store.write(decision);
  assert.deepEqual(await store.read(workspace), decision);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(root)).mode & 0o077, 0);
    assert.equal((await lstat(path.join(root, 'trust', `${workspace.id}.json`))).mode & 0o077, 0);
  }
  const changed = { ...workspace, inode: '4' };
  assert.equal(await store.read(changed), undefined);
  const recordPath = path.join(root, 'trust', `${workspace.id}.json`);
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  await writeFile(recordPath, JSON.stringify({ ...record, sha256: '0'.repeat(64) }));
  await assert.rejects(store.read(workspace), /corrupt/u);
  await store.delete(workspace);
  assert.equal(await store.read(workspace), undefined);
  await assert.rejects(state.write('../escape', 'bad'), /Invalid private state path/u);
});

test('private state adopts only an owned real directory', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'coding-agent-private-root-'));
  const nonempty = path.join(parent, 'nonempty');
  await mkdir(nonempty);
  await writeFile(path.join(nonempty, 'foreign.txt'), 'foreign');
  await assert.rejects(PrivateStateDirectory.create(nonempty), /non-empty directory/u);
  const target = path.join(parent, 'target');
  await mkdir(target);
  const alias = path.join(parent, 'alias');
  await symlink(target, alias, 'dir');
  await assert.rejects(PrivateStateDirectory.create(alias), /real directory|aliased/u);
});

test('trust action decisions keep authority distinct from workspace content', () => {
  assert.deepEqual(decideWorkspaceAction('untrusted', 'inspect_metadata'), { kind: 'allowed' });
  assert.equal(decideWorkspaceAction('untrusted', 'provider_egress').kind, 'blocked');
  assert.equal(decideWorkspaceAction('restricted', 'workspace_read').kind, 'allowed');
  assert.equal(decideWorkspaceAction('restricted', 'workspace_mutation').kind, 'approval_required');
  assert.equal(decideWorkspaceAction('restricted', 'project_execution_policy').kind, 'blocked');
  assert.equal(decideWorkspaceAction('trusted', 'command_execution').kind, 'allowed');
  assert.equal(decideToolEffects('trusted', { accesses: [{ mode: 'read', scope: 'workspace/files/.env.local' }], lockScopes: [], idempotency: 'pure' }).kind, 'blocked');
  assert.equal(decideToolEffects('restricted', { accesses: [{ mode: 'write', scope: 'workspace/files/src/a.ts' }], lockScopes: [], idempotency: 'non_idempotent' }).kind, 'approval_required');
  for (const candidate of ['.env', 'nested/.env.production', '.ssh/id_ed25519', 'keys/private-key.pem', '.npmrc']) assert.equal(isSensitiveWorkspacePath(candidate), true, candidate);
  assert.equal(isSensitiveWorkspacePath('src/environment.ts'), false);
  assert.deepEqual(narrowRiskCeiling(['read', 'write'], ['read']), ['read']);
  assert.throws(() => narrowRiskCeiling(['read'], ['execute']), /cannot grant authority/u);
  const workspace = Object.freeze({ id: 'workspace-' + 'd'.repeat(64), platform: process.platform, canonicalPath: '/workspace', device: '1', inode: '2', mountId: '3' });
  const boundary = new WorkspaceSecurityBoundary(workspace, 'restricted');
  assert.equal(boundary.authorizeTool({ effects: { accesses: [{ mode: 'execute', scope: 'workspace/processes' }], lockScopes: [], idempotency: 'non_idempotent' } }).decision, 'require_approval');
});

test('workspace content preserves provenance while making deceptive controls visible', () => {
  const workspace = Object.freeze({ id: 'workspace-' + 'b'.repeat(64), platform: process.platform, canonicalPath: '/workspace', device: '1', inode: '2', mountId: '3' });
  const adopted = adoptWorkspaceContent({ content: 'safe\u001b[31m\u202Ehidden\u200B', kind: 'instruction', sourceUri: 'file:AGENTS.md', scope: '.', workspace, trustLevel: 'restricted' });
  assert.equal(adopted.content.includes('\u001b'), false);
  assert.match(adopted.content, /\\u\{1B\}/u);
  assert.deepEqual(adopted.provenance.hazards, ['terminal_control', 'bidirectional_control', 'invisible_unicode']);
  assert.equal(adopted.provenance.sourceUri, 'file:AGENTS.md');
  assert.equal(adopted.provenance.sha256.length, 64);
  const bounded = adoptWorkspaceContent({ content: 'é'.repeat(20), kind: 'source', sourceUri: 'file:a', scope: '.', workspace, trustLevel: 'restricted', maxBytes: 11 });
  assert.equal(Buffer.byteLength(bounded.content) <= 11, true);
  assert.equal(bounded.provenance.truncated, true);
});

test('provider egress blocks untrusted workspaces, secrets, and oversized requests before I/O', async () => {
  const workspace = Object.freeze({ id: 'workspace-' + 'c'.repeat(64), platform: process.platform, canonicalPath: '/workspace', device: '1', inode: '2', mountId: '3' });
  let calls = 0;
  const provider = {
    id: 'scripted',
    describe: () => ({ id: 'scripted', displayName: 'Scripted', defaultModel: 'test' }),
    describeModel: async () => ({ id: 'test', provider: 'scripted', capabilities: { streaming: false, toolCalling: false, supportedToolInputs: [], jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false }, modalities: { input: ['text'], output: ['text'] }, limits: {}, supportedParameters: [] }),
    async complete() { calls += 1; return { content: 'done', model: 'test', provider: 'scripted', terminationReason: 'stop' }; }
  };
  const request = { model: 'test', messages: [{ role: 'user', content: 'hello' }] };
  await assert.rejects(protectProviderEgress({ provider, workspace, trustLevel: 'untrusted' }).complete(request), /not been admitted/u);
  await assert.rejects(protectProviderEgress({ provider, workspace, trustLevel: 'restricted' }).complete({ ...request, messages: [{ role: 'user', content: 'api_key=abcdefghijk' }] }), /sensitive-data/u);
  await assert.rejects(protectProviderEgress({ provider, workspace, trustLevel: 'restricted', policy: { maxRequestBytes: 4 } }).complete(request), /egress limit/u);
  assert.equal(calls, 0);
  const receipts = [];
  const response = await protectProviderEgress({ provider, workspace, trustLevel: 'restricted', policy: { onAdmitted: receipt => receipts.push(receipt) } }).complete(request);
  assert.equal(response.content, 'done');
  assert.equal(calls, 1);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].workspaceId, workspace.id);
  assert.doesNotMatch(redactSensitiveText('password=abcdefghijk\u001b[2J'), /abcdefghijk|\u001b/u);
});

test('every implicit repository execution surface is classified as a sandboxed effect', () => {
  assert.equal(implicitExecutionSurfaces.length, 11);
  for (const surface of implicitExecutionSurfaces) {
    const classification = classifyImplicitExecution(surface);
    assert.equal(classification.kind, 'sandboxed_effect');
    assert.equal(classification.explanation.length > 20, true);
  }
});

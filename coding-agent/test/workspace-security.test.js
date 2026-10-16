import test from 'node:test';
import assert from 'node:assert/strict';
import { access, lstat, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RootedFileAuthority } from '@agent-core/tools-local';
import { createSessionBinding } from '@agent-core/runtime';
import { adoptWorkspaceContent } from '../dist/security/content-provenance.js';
import { admitProviderEgress } from '../dist/security/provider-egress.js';
import { InferenceService } from '@agent-core/runtime';
import { redactJson } from '@agent-core/persistence';
import { identifyCodingWorkspace } from '../dist/security/workspace-identity.js';
import { createTrustDecision, decideToolEffects, decideWorkspaceAction, isSensitiveWorkspacePath } from '../dist/security/workspace-trust.js';
import { WorkspaceSecurityBoundary } from '../dist/security/workspace-security-boundary.js';
import { PrivateStateDirectory } from '../dist/state/private-state.js';
import { WorkspaceTrustStore } from '../dist/state/workspace-trust-store.js';
import { codingWorkspaceSessionBinding, openCodingWorkspace } from '../dist/workspace.js';

test('workspace file authority fails closed where secure root adoption is unavailable', { skip: process.platform === 'linux' }, () => {
  assert.throws(
    () => RootedFileAuthority.adopt(process.cwd()),
    new RegExp(`Root-bound host file access is unavailable on ${process.platform}`, 'u')
  );
});

test('workspace identity binds the canonical path and exact adopted physical root', { skip: process.platform !== 'linux' }, async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'coding-agent-identity-'));
  const rootPath = path.join(parent, 'workspace');
  await mkdir(rootPath);
  const firstRoot = RootedFileAuthority.adopt(rootPath);
  const first = identifyCodingWorkspace(firstRoot.identity);
  await rename(rootPath, `${rootPath}-moved`);
  await mkdir(rootPath);
  const replacementRoot = RootedFileAuthority.adopt(rootPath);
  const replacement = identifyCodingWorkspace(replacementRoot.identity);
  assert.notEqual(first.id, replacement.id);
  assert.equal(first.canonicalPath, replacement.canonicalPath);
  firstRoot.close(); replacementRoot.close();
});

test('coding session binding contains only stable workspace and physical-root identity', { skip: process.platform !== 'linux' }, async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'coding-agent-session-binding-'));
  const firstPath = path.join(parent, 'first');
  const secondPath = path.join(parent, 'second');
  await mkdir(firstPath); await mkdir(secondPath);
  const firstRoot = RootedFileAuthority.adopt(firstPath);
  const secondRoot = RootedFileAuthority.adopt(secondPath);
  try {
    const first = createSessionBinding(codingWorkspaceSessionBinding(identifyCodingWorkspace(firstRoot.identity)));
    const second = createSessionBinding(codingWorkspaceSessionBinding(identifyCodingWorkspace(secondRoot.identity)));
    assert.equal(first.schemaId, 'coding-agent/workspace');
    assert.deepEqual(Object.keys(first.subject).sort(), ['rootIdentity', 'workspaceId']);
    assert.notEqual(first.bindingSha256, second.bindingSha256);
    assert.equal(JSON.stringify(first).includes('provider'), false);
    assert.equal(JSON.stringify(first).includes('permission'), false);
  } finally { firstRoot.close(); secondRoot.close(); }
});

test('private state aliases into the workspace are rejected before state mutation', { skip: process.platform !== 'linux' }, async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'coding-agent-state-alias-'));
  const rootPath = path.join(parent, 'workspace');
  await mkdir(rootPath);
  const alias = path.join(parent, 'workspace-alias');
  await symlink(rootPath, alias, 'dir');
  const statePath = path.join(alias, 'private-state');
  await assert.rejects(openCodingWorkspace(rootPath, { stateRoot: statePath }), /outside the workspace/u);
  await assert.rejects(access(path.join(rootPath, 'private-state')));
});

test('workspace trust records are private, checksummed, revocable, and invalid for changed identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'coding-agent-trust-'));
  const state = await PrivateStateDirectory.create(root);
  const store = new WorkspaceTrustStore(state);
  const workspace = Object.freeze({ id: 'workspace-' + 'a'.repeat(64), platform: process.platform, canonicalPath: '/workspace', device: '1', inode: '2', mountId: '3' });
  assert.equal(await store.read(workspace), undefined);
  const decision = createTrustDecision({ workspace, level: 'trusted', actorKind: 'user', actor: 'local-user', now: new Date('2026-08-28T00:00:00.000Z') });
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
  assert.equal(decideWorkspaceAction('trusted', 'workspace_read').kind, 'allowed');
  assert.equal(decideWorkspaceAction('trusted', 'workspace_mutation').kind, 'allowed');
  assert.equal(decideWorkspaceAction('trusted', 'project_execution_policy').kind, 'allowed');
  assert.equal(decideWorkspaceAction('trusted', 'command_execution').kind, 'allowed');
  assert.equal(decideToolEffects('trusted', { accesses: [{ mode: 'read', scope: 'files/.env.local' }], lockScopes: [], recovery: { kind: 'unknown' } }).kind, 'blocked');
  assert.equal(decideToolEffects('trusted', { accesses: [{ mode: 'write', scope: 'files/src/a.ts' }], lockScopes: [], recovery: { kind: 'unknown' } }).kind, 'allowed');
  for (const candidate of ['.env', 'nested/.env.production', '.ssh/id_ed25519', 'keys/private-key.pem', '.npmrc']) assert.equal(isSensitiveWorkspacePath(candidate), true, candidate);
  assert.equal(isSensitiveWorkspacePath('src/environment.ts'), false);
  const workspace = Object.freeze({ id: 'workspace-' + 'd'.repeat(64), platform: process.platform, canonicalPath: '/workspace', device: '1', inode: '2', mountId: '3' });
  const boundary = new WorkspaceSecurityBoundary(workspace, 'trusted');
  assert.equal(boundary.authorizeTool({ effects: { accesses: [{ mode: 'execute', scope: 'workspace/processes' }], lockScopes: [], recovery: { kind: 'unknown' } } }).decision, 'allow');
});

test('workspace content preserves provenance while making deceptive controls visible', () => {
  const workspace = Object.freeze({ id: 'workspace-' + 'b'.repeat(64), platform: process.platform, canonicalPath: '/workspace', device: '1', inode: '2', mountId: '3' });
  const adopted = adoptWorkspaceContent({ content: 'safe\u001b[31m\u202Ehidden\u200B', kind: 'instruction', sourceUri: 'file:AGENTS.md', scope: '.', workspace, trustLevel: 'trusted' });
  assert.equal(adopted.content.includes('\u001b'), false);
  assert.match(adopted.content, /\\u\{1B\}/u);
  assert.deepEqual(adopted.provenance.hazards, ['terminal_control', 'bidirectional_control', 'invisible_unicode']);
  assert.equal(adopted.provenance.sourceUri, 'file:AGENTS.md');
  assert.equal(adopted.provenance.sha256.length, 64);
  const bounded = adoptWorkspaceContent({ content: 'é'.repeat(20), kind: 'source', sourceUri: 'file:a', scope: '.', workspace, trustLevel: 'trusted', maxBytes: 11 });
  assert.equal(Buffer.byteLength(bounded.content) <= 11, true);
  assert.equal(bounded.provenance.truncated, true);
});

test('provider admission rejects credentials before I/O and accepts redacted source code', async () => {
  let calls = 0;
  const provider = {
    id: 'scripted',
    implementationId: 'agents.tests.workspace-security-provider@1',
    describe: () => ({ id: 'scripted', displayName: 'Scripted', defaultModel: 'test' }),
    describeModel: async () => ({ id: 'test', provider: 'scripted', capabilities: { streaming: false, toolCalling: false, supportedToolInputs: [], jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false }, modalities: { input: ['text'], output: ['text'] }, limits: { contextTokens: 32000, outputTokens: 512 }, supportedParameters: ['maxOutputTokens'] }),
    async complete() { calls += 1; return { content: 'done', model: 'test', provider: 'scripted', terminationReason: 'stop' }; }
  };
  const invoke = (content, trustLevel = 'trusted') => InferenceService.inMemory({
    provider,
    admitRequest: request => admitProviderEgress(request, trustLevel)
  }).invoke({ invocationId: 'test', ownerId: 'workspace', purpose: 'test', outputReservation: 100,
    request: { model: 'test', messages: [{ role: 'user', content }] }
  });
  await assert.rejects(invoke('hello', 'untrusted'), /not been admitted/u);
  await assert.rejects(invoke('sk-' + 'x'.repeat(24)), /unredacted credentials/u);
  assert.equal(calls, 0);
  const source = "new OpenAIProvider({ apiKey: 'test' });";
  assert.equal(redactJson(source).value, source);
  assert.equal((await invoke(source)).response.content, 'done');
  await invoke('apiKey: [REDACTED]');
  await invoke(redactJson('API_TOKEN=private-value').value);
  assert.equal(calls, 3);
});

test('provider admission preserves native encrypted reasoning and still screens every plaintext channel', async () => {
  const { OpenAIProvider } = await import('@agent-core/provider-openai');
  const { createProviderContextState } = await import('@agent-core/model');
  const provider = new OpenAIProvider({ apiKey: 'test-key' });
  const model = 'gpt-5.6-sol';
  const profile = await provider.describeModel(model);
  const secret = 'sk-' + 'SYNTHETIC_NOT_A_REAL_KEY_1234567890';
  const opaque = `synthetic-opaque.${secret}.not-real-ciphertext`;
  const makeRequest = async (summary = 'safe summary', extraMessages = []) => {
    const prefix = [{ role: 'user', content: 'hello' }];
    const state = await createProviderContextState({
      provider: provider.id, endpoint: 'https://api.openai.com/v1/responses',
      protocolRevision: profile.capabilities.protocol.revision,
      request: { model, messages: prefix }, requestId: 'synthetic-response',
      kind: 'responses.reasoning', requiresExactPrefix: false,
      data: { items: [{ type: 'reasoning', id: 'synthetic-reasoning',
        encrypted_content: opaque, summary: [{ type: 'summary_text', text: summary }] }] }
    });
    return { model, maxOutputTokens: 100, messages: [...prefix, { role: 'protocol', content: '', state }, ...extraMessages] };
  };
  const request = await makeRequest();
  const compiled = await provider.compileRequest(request, { outputReservation: 100 });
  const before = JSON.stringify(compiled.body);
  assert.ok(redactJson(compiled.body).redactions > 0, 'fixture reproduces the opaque-byte false positive');
  assert.doesNotThrow(() => admitProviderEgress(compiled, 'trusted'));
  assert.equal(compiled.body.input[1].encrypted_content, opaque);
  assert.equal(JSON.stringify(compiled.body), before, 'inspection never mutates provider bytes');
  assert.throws(() => admitProviderEgress({ ...compiled }, 'trusted'), /unredacted credentials/u,
    'copied metadata cannot claim compiler provenance');
  assert.throws(() => admitProviderEgress({ body: { input: [{ type: 'reasoning', id: 'forged', encrypted_content: secret }] } }, 'trusted'), /unredacted credentials/u);
  assert.throws(() => admitProviderEgress({ body: { encrypted_content: secret } }, 'trusted'), /unredacted credentials/u);
  const poisonedSummary = await provider.compileRequest(await makeRequest(secret), { outputReservation: 100 });
  assert.throws(() => admitProviderEgress(poisonedSummary, 'trusted'), /unredacted credentials/u);
  for (const message of [
    { role: 'user', content: JSON.stringify({ encrypted_content: secret }) },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call-synthetic', name: 'test', type: 'function', input: { kind: 'json', value: { encrypted_content: secret } } }] }
  ]) {
    const plaintext = await provider.compileRequest(await makeRequest('safe summary', [message]), { outputReservation: 100 });
    assert.throws(() => admitProviderEgress(plaintext, 'trusted'), /unredacted credentials/u);
  }
  const retained = await provider.compileNativeFrame(request, { input: [] }, { input: compiled.body.input }, 0);
  assert.doesNotThrow(() => admitProviderEgress(retained, 'trusted'));
  assert.equal(retained.retainedBody.input[1].encrypted_content, opaque);
  const poisonedRetained = await provider.compileNativeFrame(request, { input: [] }, {
    input: compiled.body.input, extra: { encrypted_content: secret }
  }, 0);
  assert.throws(() => admitProviderEgress(poisonedRetained, 'trusted'), /unredacted credentials/u);
  const alteredNative = await provider.compileNativeFrame(request, {
    input: [{ ...compiled.body.input[1], encrypted_content: secret }]
  }, { input: [] }, 0);
  assert.throws(() => admitProviderEgress(alteredNative, 'trusted'), /unredacted credentials/u,
    'a protocol lookalike without exact logical-state provenance remains plaintext');
  const large = await provider.compileRequest(await makeRequest('safe summary', [
    { role: 'user', content: 'x'.repeat(1024 * 1024 + 1), images: [
      { type: 'base64', mediaType: 'image/png', data: 'A'.repeat(1024 * 1024 + 4) }
    ] }
  ]), { outputReservation: 100 });
  assert.doesNotThrow(() => admitProviderEgress(large, 'trusted'), 'classification does not reparse unrelated large text/media');
  const wrongProvider = structuredClone(request);
  wrongProvider.messages[1].state.provider = 'forged-provider';
  await assert.rejects(provider.compileRequest(wrongProvider), /Incompatible provider context/u);
});

test('Codex compiled reasoning receives the same narrow plaintext inspection policy', async () => {
  const { OpenAICodexProvider } = await import('@agent-core/provider-openai-codex');
  const { createProviderContextState } = await import('@agent-core/model');
  const provider = new OpenAICodexProvider({
    auth: { async getBearerToken() { throw new Error('No network authentication expected'); } }
  });
  const model = 'gpt-5.6';
  const profile = await provider.describeModel(model);
  const secret = 'sk-' + 'SYNTHETIC_NOT_A_REAL_KEY_1234567890';
  const state = await createProviderContextState({
    provider: provider.id, endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    protocolRevision: profile.capabilities.protocol.revision,
    request: { model, messages: [{ role: 'user', content: 'hello' }] },
    requestId: 'synthetic-codex-response', kind: 'responses.reasoning', requiresExactPrefix: false,
    data: { items: [{ type: 'reasoning', id: 'synthetic-codex-reasoning', encrypted_content: `opaque.${secret}.payload`, summary: [] }] }
  });
  const request = { model, messages: [{ role: 'protocol', content: '', state }] };
  const compiled = await provider.compileRequest(request, { outputReservation: 100 });
  assert.doesNotThrow(() => admitProviderEgress(compiled, 'trusted'));
  const visible = structuredClone(request);
  visible.messages[0].state.data.items[0].summary = [{ type: 'summary_text', text: secret }];
  const poisoned = await provider.compileRequest(visible, { outputReservation: 100 });
  assert.throws(() => admitProviderEgress(poisoned, 'trusted'), /unredacted credentials/u);
});

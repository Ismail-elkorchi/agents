import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadWorkspace } from '@ismail-elkorchi/coding-agent';
import { LocalArtifactRepository } from '@agent-core/evidence/node';
import { createLocalToolHost, TextPatchJournal, WorkspaceFileRoot } from '@agent-core/tools-local';
import { createToolCall, prepareToolCall } from '@agent-core/tools';
import { invokePreparedForTest, invokeToolCall, jsonToolCall } from './tool-call-helpers.js';

const owner = { runId: 'cli-composition-run', turnId: 'turn-1', requestAttempt: 1, toolBatchId: 'batch-1', callIndex: 0, toolAttempt: 1 };
const codingTools = ['list_directory', 'find_files', 'read_files', 'search_text', 'apply_patch', 'view_image', 'read_artifact'];

test('Coding Agent local tool composition exposes exact structured and artifact capabilities', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'coding-agent-cli-composition-'));
  const workspace = await loadWorkspace(root, { stateRoot: `${root}-state` });
  await mkdir(workspace.artifactsDir, { recursive: true });
  const patchJournalPath = path.join(workspace.runtimeDir, 'transactions', 'patch');
  await mkdir(patchJournalPath, { recursive: true, mode: 0o700 });
  const host = createLocalToolHost({
    workspaceFileRoot: WorkspaceFileRoot.adopt(workspace.workspaceRoot, { additionalDeniedEntries: ['.coding-agent'] }),
    artifactRepository: new LocalArtifactRepository({ rootDir: workspace.artifactsDir }),
    patchJournal: TextPatchJournal.adopt(patchJournalPath),
    enabledTools: codingTools
  });
  await host.ready();
  assert.deepEqual(await host.reconciliation(), { resolved: [], unresolved: [] });
  const artifacts = host.artifactRepository;
  assert.deepEqual(host.tools.map((tool) => tool.name), codingTools);
  assert.equal(host.services.artifactRepository, artifacts);

  const imagePath = path.join(root, 'pixel.png');
  await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  const stored = await artifacts.store({ label: 'text', content: new TextEncoder().encode('artifact text'), mediaType: 'text/plain; charset=utf-8' });
  const context = { policy: { allowedRisks: ['read'] }, services: host.services, invocation: owner };

  const viewed = await invokeToolCall(jsonToolCall('view_image', { path: 'pixel.png' }), host.tools, context);
  assert.equal(viewed.ok, true);
  const read = await invokeToolCall(jsonToolCall('read_artifact', { artifactId: stored.artifactId, offset: 0, byteCount: 64 }), host.tools, context);
  assert.equal(read.output.text, 'artifact text');

  await host.close();
});

test('local host exposes dry-run patching without a transaction directory and gates mutation dynamically', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'coding-agent-local-host-patch-services-'));
  await writeFile(path.join(root, 'note.txt'), 'old\n');
  const patch = '*** Begin Patch\n*** Update File: note.txt\n@@\n-old\n+new\n*** End Patch';
  const contextFor = (services) => ({
    policy: { allowedRisks: ['read', 'write', 'destructive'] }, services,
    signal: new AbortController().signal,
    boundary: { authorizationPolicyId: 'tests/local-host-patch@1', executionTargetId: root }
  });
  const withoutDirectory = createLocalToolHost({
    workspaceFileRoot: WorkspaceFileRoot.adopt(root),
    artifactRepository: new LocalArtifactRepository({ rootDir: path.join(root, 'artifacts-without-patch') }),
    enabledTools: codingTools
  });
  await withoutDirectory.ready();
  assert.equal(withoutDirectory.tools.some(tool => tool.name === 'apply_patch'), true);
  assert.equal('patchJournal' in withoutDirectory.services, false);
  const dryContext = contextFor(withoutDirectory.services);
  const dryPrepared = await prepareToolCall(createToolCall({ name: 'apply_patch', input: { kind: 'json', value: { patch, dryRun: true } } }), withoutDirectory.tools, dryContext);
  assert.equal(dryPrepared.ok, true);
  const dry = await invokePreparedForTest(dryPrepared.prepared, dryContext);
  assert.equal(dry.output.operationStatus, 'dry_run');
  const writePrepared = await prepareToolCall(createToolCall({ name: 'apply_patch', input: { kind: 'text', value: patch } }), withoutDirectory.tools, dryContext);
  assert.equal(writePrepared.ok, true);
  const missing = await invokePreparedForTest(writePrepared.prepared, dryContext);
  assert.equal(missing.kind, 'failure');
  assert.match(missing.summary, /patchJournal/u);
  await withoutDirectory.close();

  const patchJournalPath = path.join(root, 'patch-transactions');
  await mkdir(patchJournalPath, { recursive: true, mode: 0o700 });
  const withDirectory = createLocalToolHost({
    workspaceFileRoot: WorkspaceFileRoot.adopt(root),
    artifactRepository: new LocalArtifactRepository({ rootDir: path.join(root, 'artifacts-with-patch') }),
    patchJournal: TextPatchJournal.adopt(patchJournalPath),
    enabledTools: codingTools
  });
  await withDirectory.ready();
  assert.equal(withDirectory.tools.some(tool => tool.name === 'apply_patch'), true);
  const writeContext = contextFor(withDirectory.services);
  const prepared = await prepareToolCall(createToolCall({ name: 'apply_patch', input: { kind: 'text', value: patch } }), withDirectory.tools, writeContext);
  assert.equal(prepared.ok, true);
  const applied = await invokePreparedForTest(prepared.prepared, writeContext);
  assert.equal(applied.output.operationStatus, 'applied');
  await withDirectory.close();
});

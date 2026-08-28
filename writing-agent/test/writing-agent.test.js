import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runDocumentRevision, runWritingTask } from '../dist/index.js';

class WritingProvider {
  id = 'writing-test';
  implementationId = 'agents.tests.writing-provider@1';
  requests = [];
  constructor(responses = ['A focused draft.']) { this.responses = [...responses]; }
  describe() { return { id: this.id, displayName: 'Writing test provider', defaultModel: 'writing-test' }; }
  async describeModel() {
    return {
      id: 'writing-test', provider: this.id,
      capabilities: { streaming: false, toolCalling: true, supportedToolInputs: [{ kind: 'json' }, { kind: 'text' }], jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false },
      modalities: { input: ['text'], output: ['text'] },
      limits: { contextTokens: 16_000, outputTokens: 2_000 },
      supportedParameters: []
    };
  }
  async complete(request) {
    this.requests.push(request);
    const response = this.responses.shift();
    if (response === undefined) throw new Error('No scripted writing response remains.');
    return typeof response === 'string'
      ? { content: response, model: request.model, provider: this.id, terminationReason: 'stop' }
      : { ...response, model: request.model, provider: this.id };
  }
}

test('writing workflow composes the general runtime without coding prompt assumptions', async () => {
  const provider = new WritingProvider();
  const result = await runWritingTask({ brief: 'Draft a short introduction for a museum exhibition.', provider, model: 'writing-test' });
  assert.equal(result.state, 'ended');
  assert.equal(result.terminal.candidate.message, 'A focused draft.');
  assert.equal(provider.requests.length, 1);
  const system = provider.requests[0].messages.find((message) => message.role === 'system').content;
  assert.match(system, /Produce a finished draft/u);
  assert.doesNotMatch(system, /\b(?:coding|codebase|workspace|shell)\b/iu);
});

test('writing workflow rejects an empty brief before invoking a provider', async () => {
  const provider = new WritingProvider();
  await assert.rejects(() => runWritingTask({ brief: '   ', provider, model: 'writing-test' }), /must not be empty/u);
  assert.equal(provider.requests.length, 0);
});

test('document revision persists continuity and composes only file capabilities', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'writing-agent-document-'));
  const state = path.join(root, '.state');
  await writeFile(path.join(root, 'draft.txt'), 'A rough opening.\n');
  const patch = '*** Begin Patch\n*** Update File: draft.txt\n@@\n-A rough opening.\n+A precise opening for the intended reader.\n*** End Patch';
  const provider = new WritingProvider([
    {
      content: '', terminationReason: 'tool_calls',
      toolCalls: [{ id: 'read-1', type: 'function', name: 'read_files', input: { kind: 'json', value: { files: [{ path: 'draft.txt' }] } } }]
    },
    {
      content: '', terminationReason: 'tool_calls',
      toolCalls: [{ id: 'patch-1', type: 'function', name: 'apply_patch', input: { kind: 'json', value: { patch } } }]
    },
    'Updated the opening.'
  ]);
  const first = await runDocumentRevision({
    instruction: 'Make the opening precise.', documentPath: 'draft.txt', rootDirectory: root, stateDirectory: state,
    provider, model: 'writing-test'
  });
  assert.equal(first.result.state, 'ended');
  assert.equal(await readFile(path.join(root, 'draft.txt'), 'utf8'), 'A precise opening for the intended reader.\n');
  assert.deepEqual(provider.requests[0].tools.map((tool) => tool.type === 'function' ? tool.function.name : tool.name).sort(), ['apply_patch', 'read_files']);
  await assert.rejects(access(path.join(state, 'processes')), { code: 'ENOENT' });

  const resumedProvider = new WritingProvider(['Prior revision retained.']);
  const second = await runDocumentRevision({
    instruction: 'Confirm the prior revision.', documentPath: 'draft.txt', rootDirectory: root, stateDirectory: state,
    provider: resumedProvider, model: 'writing-test', sessionId: first.sessionId
  });
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.result.state, 'ended');
  assert.equal(resumedProvider.requests[0].messages.some((message) => message.content.includes('Updated the opening.')), true);
});

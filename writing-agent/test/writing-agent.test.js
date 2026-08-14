import test from 'node:test';
import assert from 'node:assert/strict';
import { runWritingTask } from '../dist/index.js';

class WritingProvider {
  id = 'writing-test';
  requests = [];
  describe() { return { id: this.id, displayName: 'Writing test provider', defaultModel: 'writing-test' }; }
  async describeModel() {
    return {
      id: 'writing-test', provider: this.id,
      capabilities: { streaming: false, toolCalling: false, supportedToolInputs: [], jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false },
      modalities: { input: ['text'], output: ['text'] },
      limits: { contextTokens: 16_000, outputTokens: 2_000 },
      supportedParameters: []
    };
  }
  async complete(request) {
    this.requests.push(request);
    return { content: 'A focused draft.', model: request.model, provider: this.id, terminationReason: 'stop' };
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

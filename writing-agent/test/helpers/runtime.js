import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openWritingApplication } from '@ismail-elkorchi/writing-agent';

export class ScriptedWritingProvider {
  id = 'writing-test';
  implementationId = 'agents.tests.writing-provider@1';
  requests = [];
  constructor(responses = ['A focused draft.']) {
    this.responses = [...responses];
  }
  describe() {
    return { id: this.id, displayName: 'Writing test provider', defaultModel: 'writing-test' };
  }
  async describeModel() {
    return {
      id: 'writing-test',
      provider: this.id,
      capabilities: {
        streaming: false,
        toolCalling: true,
        supportedToolInputs: [{ kind: 'json' }, { kind: 'text' }],
        jsonMode: false,
        jsonSchema: true,
        logprobs: false,
        temperature: false,
        topP: false
      },
      modalities: { input: ['text'], output: ['text'] },
      limits: { contextTokens: 64_000, outputTokens: 4_000 },
      supportedParameters: ['tools', 'responseFormat', 'maxOutputTokens']
    };
  }
  async complete(request) {
    this.requests.push(request);
    let response = this.responses.shift();
    if (response === undefined) throw new Error('No scripted writing response remains.');
    if (typeof response === 'function') response = await response(request);
    return typeof response === 'string'
      ? { content: response, model: request.model, provider: this.id, terminationReason: 'stop' }
      : { ...response, model: request.model, provider: this.id };
  }
}

export function toolCall(name, args) {
  return {
    content: '',
    terminationReason: 'tool_calls',
    toolCalls: [{ name, id: crypto.randomUUID(), type: 'function', input: { kind: 'json', value: args } }]
  };
}
export function patchResponse(patch) {
  return {
    content: '',
    terminationReason: 'tool_calls',
    toolCalls: [
      {
        id: crypto.randomUUID(),
        type: 'custom',
        name: 'apply_patch',
        input: { kind: 'text', value: patch }
      }
    ]
  };
}
export async function fixture(content = 'Old line.\n', options = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), 'writing-agent-test-'));
  const root = path.join(parent, 'workspace');
  const stateRoot = path.join(parent, 'state');
  await mkdir(root);
  await writeFile(path.join(root, 'document.txt'), content);
  const provider = new ScriptedWritingProvider(options.responses);
  const application = await openWritingApplication({
    rootDirectory: root,
    stateRoot,
    mode: options.mode,
    configuration: { provider, model: 'writing-test' }
  });
  return {
    parent,
    root,
    stateRoot,
    provider,
    application,
    async close() {
      await application.close();
      await rm(parent, { recursive: true, force: true });
    }
  };
}
export async function submit(application, instruction) {
  const result = await application.submit({ task: instruction });
  if (result.kind === 'rejected') throw new Error(result.reason);
  return result.completion;
}

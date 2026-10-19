import { conservativeProtocolCapabilities } from '@agent-core/model';
import assert from 'node:assert/strict';
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
        protocol: conservativeProtocolCapabilities('writing-test', { contextReset: 'fresh_request' }),
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

export function collaborationStartResponses(task, profile, respond = toolCall) {
  const names = request => (request.tools ?? []).map(tool => tool.type === 'function' ? tool.function.name : tool.name);
  return [
    request => {
      assert(names(request).includes('collaboration_inspect'));
      assert(!names(request).includes('collaboration_start'));
      return respond('tool_catalog_discover', { query: 'collaboration_start' });
    },
    request => {
      assert(!names(request).includes('collaboration_start'), 'discovery does not load a tool');
      const page = JSON.parse(request.messages.findLast(message => message.role === 'tool').content);
      const descriptor = page.items.find(item => item.name === 'collaboration_start');
      assert(descriptor, 'the granted start operation is discoverable');
      assert.equal(descriptor.loaded, false);
      return respond('tool_catalog_select', {
        references: [descriptor.reference], expectedSelectionRevision: page.selectionRevision
      });
    },
    request => {
      assert(names(request).includes('collaboration_start'));
      assert(!names(request).includes('collaboration_send'), 'only the selected operation is loaded');
      return respond('collaboration_start', { task, profile });
    }
  ];
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
  const provider = options.provider ?? new ScriptedWritingProvider(options.responses);
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

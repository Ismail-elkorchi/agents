import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWritingProject, createManagedTextResource } from '@ismail-elkorchi/writing-agent';

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

export const passingChecker = Object.freeze({
  implementationId: 'tests.semantic-checker@1',
  verificationPolicyId: 'tests.semantic-policy@1',
  calibrationId: 'tests.semantic-calibration@1',
  async verify({
    operation,
    declaration,
    base,
    proposedRevisionId,
    citationCatalog,
    verificationInputSha256
  }) {
    return {
      semanticPreservationFindings: [
        {
          findingId: `semantic-${operation.operationId}`,
          scope: operation.intents[0].intentId,
          requirement: 'required',
          verdict: 'passed',
          coverage: 'complete',
          supportingCitations: citationCatalog.filter(
            (citation) => citation.kind === 'proposed' || citation.kind === 'base'
          ),
          intendedChanges: declaration.kind === 'changes' ? declaration.items.map((item) => item.itemId) : [],
          observedChanges: [],
          unexplainedChanges: [],
          lostPriorEditIds: [],
          checkerId: this.implementationId,
          verificationPolicyId: this.verificationPolicyId,
          calibrationId: this.calibrationId,
          verificationInputSha256,
          baseRevisionId: base.revision.revisionId,
          proposedRevisionId,
          explanation: 'Synthetic calibrated test checker established complete preservation.'
        }
      ],
      editorialFindings: []
    };
  }
});

export const unknownChecker = Object.freeze({
  implementationId: 'tests.semantic-checker-unknown@1',
  verificationPolicyId: 'tests.semantic-policy-unknown@1',
  calibrationId: 'tests.semantic-calibration-unknown@1',
  async verify({ operation, declaration, base, proposedRevisionId, verificationInputSha256 }) {
    return {
      semanticPreservationFindings: [
        {
          findingId: `semantic-unknown-${operation.operationId}`,
          scope: operation.intents[0].intentId,
          requirement: 'required',
          verdict: 'unknown',
          coverage: 'unknown',
          supportingCitations: [],
          intendedChanges: declaration.kind === 'changes' ? declaration.items.map((item) => item.itemId) : [],
          observedChanges: [],
          unexplainedChanges: [],
          lostPriorEditIds: [],
          checkerId: this.implementationId,
          verificationPolicyId: this.verificationPolicyId,
          calibrationId: this.calibrationId,
          verificationInputSha256,
          baseRevisionId: base.revision.revisionId,
          proposedRevisionId,
          explanation: 'Synthetic checker cannot establish semantic preservation.'
        }
      ],
      editorialFindings: []
    };
  }
});

export async function fixture(content = 'Old line.\n', protectedRanges = []) {
  const parent = await mkdtemp(path.join(tmpdir(), 'writing-agent-test-'));
  const root = path.join(parent, 'project');
  const stateRoot = path.join(parent, 'state');
  await mkdir(root);
  const project = await createWritingProject({
    rootDirectory: root,
    stateRoot,
    brief: 'Write a concise document without inventing facts.'
  });
  const node = (await project.store.view()).current.nodes[0];
  const resource = await createManagedTextResource(project, {
    relativePath: 'draft.md',
    initialContent: content,
    mediaType: 'text/markdown',
    role: 'draft',
    nodeId: node.nodeId,
    protectedRanges
  });
  return { parent, root, stateRoot, project, node, resource };
}

export function proposalCall(resource, intentId = 'intent-suggest', replacement = 'New line.') {
  return (request) => {
    const anchorId = JSON.stringify(request.tools).match(/edit-anchor-[a-f0-9]+/u)?.[0];
    if (anchorId === undefined)
      throw new Error('Operation tool schema did not expose an application-owned edit anchor.');
    return {
      content: '',
      terminationReason: 'tool_calls',
      toolCalls: [
        {
          id: 'proposal-call',
          type: 'function',
          name: 'propose_revision',
          input: {
            kind: 'json',
            value: {
              operations: [
                {
                  intentId,
                  textChanges: [
                    {
                      resourceId: resource.resourceId,
                      replacements: [{ anchorId, replacementText: replacement }]
                    }
                  ]
                }
              ],
              semanticChangeDeclaration: { kind: 'none' },
              rationale: 'Tighten the exact admitted sentence.'
            }
          }
        }
      ]
    };
  };
}

export function revisionResponse(resourceId, replacementText) {
  return (request) => {
    const schema = JSON.stringify(request.tools);
    const anchorId = schema.match(/edit-anchor-[a-f0-9]+/u)?.[0];
    const intentId = schema.match(/intent-[a-f0-9]{8}-[a-f0-9-]{27,}/u)?.[0];
    assert(anchorId && intentId);
    return {
      content: '',
      terminationReason: 'tool_calls',
      toolCalls: [
        {
          id: 'proposal',
          type: 'function',
          name: 'propose_revision',
          input: {
            kind: 'json',
            value: {
              operations: [
                { intentId, textChanges: [{ resourceId, replacements: [{ anchorId, replacementText }] }] }
              ],
              semanticChangeDeclaration: { kind: 'none' },
              rationale: 'Revise only the selected sentence.'
            }
          }
        }
      ]
    };
  };
}

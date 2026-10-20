import { conservativeProtocolCapabilities } from '@agent-core/model';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentRunCoordinator, AgentRuntime, AgentSession, ContextService, HistoryReader,
  InMemorySessionRepository, InferenceService, agentEventCodec, createHistoryTools,
  authorizeSessionToolEffects
} from '@agent-core/runtime';

/** General conversational consumer: no workspace, filesystem, local tool host, or shell. */
export async function conversationalApplication({ principalId, responses, materials, skills, sessions = new InMemorySessionRepository(), descriptor }) {
  const binding = { schemaId: 'agents.tests.conversation', schemaVersion: 1, subject: { principalId } };
  const session = descriptor ?? await sessions.create({ binding });
  const artifacts = new InMemoryArtifactRepository();
  const events = new InMemoryEventRepository(agentEventCodec);
  const history = new HistoryReader({ repository: sessions, session, artifacts, events });
  const requests = [];
  const providerErrors = [];
  const provider = {
    id: 'conversation-test', implementationId: 'agents.tests.conversation@1',
    describe: () => ({ id: 'conversation-test', displayName: 'Conversation fixture' }),
    async describeModel() {
      return { id: 'conversation', provider: 'conversation-test', capabilities: {
        protocol: conservativeProtocolCapabilities('conversation-test', { contextReset: 'fresh_request' }),
        streaming: false, toolCalling: true, supportedToolInputs: [{ kind: 'json' }],
        jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false
      }, modalities: { input: ['text'], output: ['text'] }, limits: { contextTokens: 100_000, outputTokens: 2048 }, supportedParameters: ['tools', 'maxOutputTokens'] };
    },
    async complete(request) {
      requests.push(request);
      const response = responses.shift();
      if (response === undefined) throw new Error('No conversational fixture response remains.');
      let value;
      try { value = typeof response === 'function' ? await response(request) : response; }
      catch (error) { providerErrors.push(error); throw error; }
      return { ...(typeof value === 'string' ? { content: value, terminationReason: 'stop' } : value), provider: 'conversation-test', model: 'conversation' };
    }
  };
  const context = new ContextService({ repository: sessions, session, history, artifacts,
    ...(materials ? { materials } : {}), ...(skills ? { skills } : {}),
    policy: { maxSourceBytes: 1024 * 1024, historyRead: { history, isAvailable: () => true } } });
  const inference = InferenceService.inMemory({ provider });
  const agent = new AgentSession({ descriptor: session, expectedBinding: binding, repository: sessions,
    runs: new AgentRunCoordinator(events, artifacts), context, configuration: { provider: provider.id, model: 'conversation' },
    createRuntime(settings, onProgress) {
      return new AgentRuntime({ provider, model: settings.model, context, inferenceService: inference,
        repositories: { events, artifacts, session: { repository: sessions, descriptor: session } },
        instructions: [{ id: 'conversation/goal', content: 'Help the user with their people, activities and changing circumstances. Distinguish observations from interpretations.' }],
        tools: [...context.toolDefinitions(), ...createHistoryTools({ history })],
        toolBoundary: { authorizationPolicyId: `conversation:${principalId}`, executionTargetId: session.id },
        toolPolicy: { allowedRisks: ['read', 'write'] },
        toolAuthorizer: async request => authorizeSessionToolEffects(request, {
          sessionId: session.id, branchId: (await history.capture()).branchId, artifacts, allowArtifactRead: false,
          materials: context.materials, allowSkillRead: context.skills !== undefined
        }),
        maxOutputTokens: 1024, onProgress
      });
    }
  });
  return { agent, context, history, requests, providerErrors, session, sessions, artifacts, events,
    async submit(task) {
      const accepted = await agent.submit({ task });
      if (accepted.kind === 'rejected') throw new Error(accepted.reason);
      return accepted.completion;
    },
    close: () => agent.close()
  };
}
export const conversationTool = (name, value) => ({ content: '', terminationReason: 'tool_calls',
  toolCalls: [{ id: crypto.randomUUID(), name, type: 'function', input: { kind: 'json', value } }] });

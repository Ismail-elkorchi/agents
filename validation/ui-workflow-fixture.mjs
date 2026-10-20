// Deterministic presentation fixture. No provider calls, workspace writes, or tool execution.
import { createHash } from 'node:crypto';
import { InMemorySessionRepository } from '@agent-core/runtime';
import { createCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';
import { testResult, testTerminal } from '../coding-agent/test/helpers/results.js';
import { createTestEventSource } from '../coding-agent/test/helpers/event-source.js';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const budget = { modelTurns: 1, totalToolCalls: 1, elapsedMs: 1, promptTokens: 0,
  completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
  knownCosts: {}, pricingStatus: 'unknown', unknownPricedTokens: 0 };

export async function createUiWorkflowFixture() {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ binding: { schemaId: 'validation/ui-workflow', schemaVersion: 1, subject: {} } });
  const events = createTestEventSource();
  const decisions = [];
  const submissions = [];
  let emission = Promise.resolve();
  let turn = 0;
  const branchPoints = [];
  const publish = (message) => { emission = emission.then(() => events.enqueue(message)); return emission; };
  for (const task of ['Inspect the parser boundary', 'Review the recorded patch', 'Choose the next change']) {
    const runId = `fixture-run-${++turn}`;
    await repository.appendInput(session, { runId, task });
    const assistant = await repository.appendAssistant(session, { runId,
      identity: { turnId: `turn-${turn}`, turnIndex: turn, requestAttempt: 1 },
      content: `## ${task}\n\nThis is deterministic fixture evidence, not a live model result.\n\n${Array.from({ length: 12 }, (_, n) => `Line ${n + 1}: Unicode café 世界; preserved source evidence.`).join('\n')}` });
    branchPoints.push({ entryId: assistant.id, runId, timestamp: assistant.timestamp, kind: 'run_finalization' });
  }
  const patch = '*** Begin Patch\n*** Update File: src/parser.ts\n@@\n-export const limit = 1;\n+export const limit = 2;\n@@\n-export const mode = "old";\n+export const mode = "reviewed";\n*** End Patch';
  const change = { path: 'src/parser.ts', absolutePath: '/fixture/src/parser.ts', kind: 'modified',
    before: { kind: 'present', sha256: hash('before'), bytes: 48 },
    after: { kind: 'present', sha256: hash('after'), bytes: 54 }, receiptSequences: [1], state: 'changed' };
  const receipt = { eventId: 'event-1', sequence: 1, turnId: 'turn-1', toolBatchId: 'batch-1', callIndex: 0,
    callId: 'call-1', toolAttempt: 1, fingerprint: 'fixture-fingerprint', patchSha256: hash(patch),
    applicationStatus: 'applied', transactionOutcome: 'committed', rootState: 'known' };
  const view = { toolDiagnostics: [], history: await repository.readBranchPage(session),
    changes: [{ runId: 'fixture-run-1', changes: [change], mutationReceipts: [receipt] }], verification: [],
    session: { sessionId: session.id, phase: 'idle', queuedInputs: 0, configuration: { provider: 'fixture', model: 'no-model-calls' } },
    branchPoints, pendingSubmissions: [], runs: [] };
  const suspension = { state: 'suspended', reason: 'approval_required', runId: 'fixture-approval-run', finalizationId: 'fixture-final', budget,
    pendingApprovals: [{ runId: 'fixture-approval-run', approvalId: 'fixture-approval', status: 'pending', toolName: 'exec-command',
      fingerprint: 'fixture-command-fingerprint', input: { command: 'echo fixture-only' },
      effects: { accesses: [{ mode: 'execute', scope: '/fixture/command' }], lockScopes: ['/fixture/command'], recovery: { kind: 'unknown' } },
      binding: { toolImplementationId: 'fixture@1', authorizationPolicyId: 'fixture-policy@1', executionTargetId: 'fixture@1' },
      policyHash: 'fixture-policy', reason: 'UI fixture only: no command is executed.', turnIndex: 1, turnId: 'turn-approval', requestAttempt: 1,
      toolBatchId: 'batch-approval', callIndex: 0, callId: 'call-approval' }] };
  const app = createCodingAgentTuiApp('Review carefully: café 世界', {
    initialHydration: view, eventSource: events,
    runtimeDetails: { workspacePath: '/fixture', providerId: 'fixture', modelId: 'no-model-calls', workspaceTrust: 'trusted', permissions: { mode: 'read_only' } },
    navigation: {
      async listSessions() { return [{ id: session.id, preview: 'UI qualification fixture', updatedAt: '2026-10-20T00:00:00Z' }]; },
      async selectSession(id) { if (id !== session.id) throw new Error('Unknown fixture session'); await publish({ type: 'session.restored', view }); },
      async newSession() { throw new Error('Creating a session is outside this presentation fixture.'); },
      async branchFrom() { throw new Error('Branch mutation is outside this presentation fixture.'); },
      async readPendingSubmissions() { return []; },
      async updateQueuedSubmission() { throw new Error('No queued fixture input.'); },
      async readChange(runId, path, expectedSessionId) {
        if (runId !== 'fixture-run-1' || path !== change.path || expectedSessionId !== undefined && expectedSessionId !== session.id)
          throw new Error('Stale fixture change request.');
        return { change, patches: [{ receipt, patch }] };
      }
    },
    commandHandler: {
      execute(command) { return { message: command === '/exit' ? 'Fixture finished.' : 'Fixture command.', ...(command === '/exit' ? { exit: true } : {}) }; },
      submit(input, delivery) {
        submissions.push({ input, delivery });
        if (input.task === 'approval') void publish({ type: 'approval.required', suspension });
        else { void publish({ type: 'progress', runId: 'fixture-live', event: { type: 'assistant.ended', turnIndex: ++turn, turnId: `turn-${turn}`,
          requestAttempt: 1, content: `Fixture received ${delivery ?? 'default'}: ${input.task}`, modelOutput: { status: 'complete', message: input.task, source: 'content', turnIndex: turn } } });
          void publish({ type: 'result', result: testResult(testTerminal({ runId: 'fixture-live' })) });
        }
        return { message: 'Fixture input received; no external action performed.' };
      }
    },
    async approvalHandler(request, decision) { decisions.push({ runId: request.runId, decision }); },
    async externalEditor(text) { return `${text}\nFixture editor returned unchanged source plus this line.`; }
  });
  return { app, sessionId: session.id, patch, decisions, submissions,
    async close() { await emission; await events.close(); } };
}

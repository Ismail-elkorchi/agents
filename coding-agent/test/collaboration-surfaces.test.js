import assert from 'node:assert/strict';
import test from 'node:test';
import { openCodingApplication } from '@ismail-elkorchi/coding-agent';
import { codingRpcMethods } from '@ismail-elkorchi/coding-agent/rpc';
import { collaborationStartResponses } from '../../writing-agent/test/helpers/runtime.js';
import { createWorkspace, finalResponse, scriptedOllama, toolResponse, trust } from './fixtures/scripted-cli.js';

test('coding read-only application exposes bounded default collaboration through public RPC', { timeout: 90_000, skip: process.platform !== 'linux' }, async t => {
  const provider = await scriptedOllama([
    ...collaborationStartResponses('Inspect the repository independently.', 'review', toolResponse),
    finalResponse('Read-only inspection complete.'), finalResponse('Root inspection complete.'),
    finalResponse('Continued inspection complete.')
  ]);
  const f = await createWorkspace({ endpoint: provider.endpoint, tools: ['read_files'], checks: [] });
  let app, restored;
  t.after(async () => { await restored?.close(); await app?.close(); await provider.close(); await f.close(); });
  await trust(f);
  const options = { root: f.root, stateRoot: f.stateRoot, providerEndpoint: provider.endpoint,
    maxOutputTokens: f.maxOutputTokens, permissionMode: 'read_only' };
  app = await openCodingApplication(options);
  await app.start();
  const accepted = await app.submit({ task: 'Ask a participant to inspect the repository.' });
  assert.equal(accepted.kind, 'started');
  const outcome = await accepted.completion;
  assert.equal(outcome.state, 'ended', JSON.stringify(outcome));
  assert.equal(outcome.terminal.executionStatus, 'completed');
  const methods = codingRpcMethods(app, () => {});
  const snapshot = await methods['collaboration.read'].invoke({});
  assert.equal(snapshot.maxParticipants, 4);
  assert.equal(snapshot.participants.length, 1);
  const participant = snapshot.participants[0];
  assert.notEqual(participant.participant.sessionId, app.state().session.sessionId);
  assert.equal((await methods['collaboration.wait'].invoke({ participantIds: [participant.participant.participantId], timeoutMs: snapshot.maxWaitMs })).reason, 'settled');
  const current = await methods['collaboration.participant'].invoke({ participantId: participant.participant.participantId });
  const input = { participantId: current.participant.participantId, sessionId: current.participant.sessionId,
    expectedRunId: current.assignment.runId, expectedEpoch: snapshot.epoch,
    operationId: 'inspect-again', task: 'Inspect once more without changing files.' };
  await assert.rejects(methods['collaboration.continue'].invoke({ ...input, expectedRunId: 'stale-run' }));
  const next = await methods['collaboration.continue'].invoke(input);
  assert.equal(next.participant.sessionId, current.participant.sessionId);
  assert.notEqual(next.assignment.runId, current.assignment.runId);
  assert.equal((await methods['collaboration.wait'].invoke({ participantIds: [current.participant.participantId], timeoutMs: snapshot.maxWaitMs })).reason, 'settled');
  const sessionId = app.state().session.sessionId;
  await app.close();
  restored = await openCodingApplication({ ...options, sessionSelection: { kind: 'existing', id: sessionId } });
  await restored.start();
  const recovered = await restored.readParticipant(current.participant.participantId);
  assert.equal(recovered.assignment.runId, next.assignment.runId);
  assert.equal(recovered.phase, 'ended');
});

test('project collaboration policy is strict, bounded and can be disabled explicitly', async () => {
  const { parseCodingAgentConfiguration } = await import('@ismail-elkorchi/coding-agent');
  const base = { version: 1, provider: 'ollama', model: 'fixture', instructions: [], tools: { enabled: ['read_files'] }, verification: { required: [], advisory: [] } };
  assert.equal(parseCodingAgentConfiguration({ ...base, collaboration: false }).collaboration, false);
  const configured = parseCodingAgentConfiguration({ ...base, collaboration: { maxParticipants: 3, maxConcurrentRuns: 1, maxWaitMs: 100 } });
  assert.equal(configured.collaboration.maxParticipants, 3);
  assert.equal(configured.collaboration.maxConcurrentRuns, 1);
  assert.equal(configured.collaboration.maxWaitMs, 100);
  assert(Object.isFrozen(configured.collaboration));
  for (const collaboration of [{ maxParticipants: 0 }, { maxParticipants: 2, maxConcurrentRuns: 3 }, { maxWaitMs: Infinity }, { arbitrary: true }])
    assert.throws(() => parseCodingAgentConfiguration({ ...base, collaboration }));
});

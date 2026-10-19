import assert from 'node:assert/strict';
import test from 'node:test';
import { openWritingApplication } from '@ismail-elkorchi/writing-agent';
import { writingRpcMethods } from '@ismail-elkorchi/writing-agent/rpc';
import { collaborationStartResponses, fixture, ScriptedWritingProvider } from './helpers/runtime.js';

const integration = { skip: process.platform !== 'linux' };

test('ordinary writing requests fit a 32K model without loading collaboration operation schemas', { ...integration, timeout: 30_000 }, async t => {
  const provider = new ScriptedWritingProvider(['A focused response.']);
  const describeModel = provider.describeModel.bind(provider);
  provider.describeModel = async () => ({ ...await describeModel(), limits: { contextTokens: 32_768, outputTokens: 4_096 } });
  const f = await fixture('Draft.\n', { provider });
  t.after(() => f.close());
  await f.application.start();
  const accepted = await f.application.submit({ task: 'Discuss the draft briefly.' });
  assert.equal(accepted.kind, 'started');
  const outcome = await accepted.completion;
  assert.equal(outcome.state, 'ended', JSON.stringify(outcome));
  assert.equal(outcome.terminal.executionStatus, 'completed', JSON.stringify(outcome));
  assert.equal(provider.requests.length, 1);
  const names = provider.requests[0].tools.map(tool => tool.type === 'function' ? tool.function.name : tool.name);
  assert.deepEqual(names.filter(name => name.startsWith('collaboration_')), ['collaboration_inspect']);
  assert(names.includes('tool_catalog_discover'));
  assert(names.includes('tool_catalog_select'));
});

test('writing public RPC inspects default participants, continues exact targets and restores durable state', { ...integration, timeout: 90_000 }, async t => {
  const f = await fixture('Draft.\n', { mode: 'review', responses: [
    ...collaborationStartResponses('Inspect the draft independently.', 'review'),
    'Read-only review complete.', 'Root review complete.', 'Continued review complete.'
  ] });
  let restored;
  t.after(async () => { await restored?.close(); await f.close(); });
  const app = f.application;
  await app.start();
  const methods = writingRpcMethods(app, () => {});
  const first = await app.submit({ task: 'Ask a participant to review the draft.' });
  assert.equal(first.kind, 'started');
  const outcome = await first.completion;
  assert.equal(outcome.state, 'ended', JSON.stringify(outcome));
  assert.equal(outcome.terminal.executionStatus, 'completed');
  const snapshot = await methods['collaboration.read'].invoke({});
  assert.equal(snapshot.participants.length, 1);
  assert.equal(snapshot.maxParticipants, 4);
  const participant = snapshot.participants[0];
  const settled = await methods['collaboration.wait'].invoke({ participantIds: [participant.participant.participantId], timeoutMs: snapshot.maxWaitMs });
  assert.equal(settled.reason, 'settled');
  const current = await methods['collaboration.participant'].invoke({ participantId: participant.participant.participantId });
  const continuation = {
    participantId: current.participant.participantId, sessionId: current.participant.sessionId,
    expectedRunId: current.assignment.runId, expectedEpoch: snapshot.epoch,
    operationId: 'review-again', task: 'Review once more without editing.'
  };
  await assert.rejects(methods['collaboration.continue'].invoke({ ...continuation, sessionId: 'different-session' }));
  const next = await methods['collaboration.continue'].invoke(continuation);
  assert.equal(next.participant.sessionId, current.participant.sessionId);
  assert.notEqual(next.assignment.runId, current.assignment.runId);
  assert.equal((await methods['collaboration.wait'].invoke({ participantIds: [current.participant.participantId], timeoutMs: snapshot.maxWaitMs })).reason, 'settled');
  const rootSessionId = app.state().sessionId;
  await app.close();
  restored = await openWritingApplication({ rootDirectory: f.root, stateRoot: f.stateRoot, sessionId: rootSessionId,
    mode: 'review', configuration: { provider: f.provider, model: 'writing-test' } });
  await restored.start();
  const recovered = await restored.readParticipant(current.participant.participantId);
  assert.equal(recovered.participant.sessionId, current.participant.sessionId);
  assert.equal(recovered.assignment.runId, next.assignment.runId);
  assert.equal(recovered.phase, 'ended');
});

test('writing review mode refuses continuation of a historical edit grant before admitting work', { ...integration, timeout: 60_000 }, async t => {
  const f = await fixture('Draft.\n', { responses: [
    ...collaborationStartResponses('Inspect editing options.', 'edit'),
    'Participant inspection complete.', 'Root inspection complete.'
  ] });
  t.after(() => f.close());
  await f.application.start();
  const accepted = await f.application.submit({ task: 'Delegate an editing inspection.' });
  const outcome = await accepted.completion;
  assert.equal(outcome.state, 'ended', JSON.stringify(outcome));
  const page = await f.application.readCollaboration();
  const first = page.participants[0];
  assert.equal((await f.application.waitForParticipants({ participantIds: [first.participant.participantId], timeoutMs: page.maxWaitMs })).reason, 'settled');
  await f.application.setMode('review');
  const prior = await f.application.readParticipant(first.participant.participantId);
  await assert.rejects(f.application.continueParticipant({
    participantId: prior.participant.participantId, sessionId: prior.participant.sessionId,
    expectedRunId: prior.assignment.runId, expectedEpoch: page.epoch,
    operationId: 'denied-edit-continuation', task: 'Make an edit.'
  }), /review|capabilit|grant/i);
  assert.equal((await f.application.readParticipant(first.participant.participantId)).assignment.runId, prior.assignment.runId);
  assert.equal(f.provider.requests.length, 5);
});

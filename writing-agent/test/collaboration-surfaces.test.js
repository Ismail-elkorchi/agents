import assert from 'node:assert/strict';
import test from 'node:test';
import { openWritingApplication } from '@ismail-elkorchi/writing-agent';
import { writingRpcMethods } from '@ismail-elkorchi/writing-agent/rpc';
import { fixture, toolCall } from './helpers/runtime.js';

test('writing public RPC inspects default participants, continues exact targets and restores durable state', { timeout: 90_000 }, async t => {
  const f = await fixture('Draft.\n', { mode: 'review', responses: [
    toolCall('collaboration_start', { task: 'Inspect the draft independently.', profile: 'review' }),
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

test('writing review mode refuses continuation of a historical edit grant before admitting work', { timeout: 60_000 }, async t => {
  const f = await fixture('Draft.\n', { responses: [
    toolCall('collaboration_start', { task: 'Inspect editing options.', profile: 'edit' }),
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
  assert.equal(f.provider.requests.length, 3);
});

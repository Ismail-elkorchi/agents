import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import { InMemoryMaterialGrantProvider, InMemoryMaterialRepository } from '@agent-core/runtime';
import { InMemorySkillSource, SkillCatalog } from '@agent-core/skills';
import { openWritingApplication } from '@ismail-elkorchi/writing-agent';
import { writingRpcMethods } from '@ismail-elkorchi/writing-agent/rpc';
import { fixture, submit, toolCall, collaborationStartResponses } from './helpers/runtime.js';

const owner = { kind: 'scope', scopeId: 'private:writer-1' };
const materialHost = () => ({ repository: new InMemoryMaterialRepository(), artifacts: new InMemoryArtifactRepository(),
  grants: new InMemoryMaterialGrantProvider([{ owner, revision: 'host-1', read: true, write: true }]) });

test('writing RPC exposes current material truth across correction, mode change, restart and revocation', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const materials = materialHost();
  const f = await fixture('', { responses: [toolCall('context_state_save', { owner, operations: [{ kind: 'create', text: 'The audience is technical.' }] }), 'Saved.' ] });
  await f.application.close();
  let app = await openWritingApplication({ rootDirectory: f.root, stateRoot: f.stateRoot, mode: 'review',
    configuration: { provider: f.provider, model: 'writing-test', materials } });
  t.after(async () => { await app.close(); await f.close(); });
  await app.start();
  assert.equal((await submit(app, 'Remember the intended audience.')).terminal.executionStatus, 'completed');
  let methods = writingRpcMethods(app, () => {});
  const scopes = await methods['material.scopes'].invoke({});
  assert.deepEqual(scopes.items.map(value => value.owner), [owner]);
  const page = await methods['material.list'].invoke({ owner });
  const { itemId, revisionId } = page.items[0];
  const ref = { owner, itemId, revisionId };
  assert.equal((await methods['material.read'].invoke({ ref })).text, 'The audience is technical.');
  const sessionId = app.state().sessionId;
  await assert.rejects(methods['material.correct'].invoke({ sessionId: 'old-session', ref, text: 'Wrong session' }), /session changed/);
  f.provider.responses.push(toolCall('context_state_save', { owner, operations: [{ kind: 'replace', itemId, expectedRevisionId: revisionId, text: 'The audience is a general readership.' }] }), 'Audience corrected.');
  let unsubscribe;
  const correctionFinished = new Promise((resolve, reject) => {
    unsubscribe = app.subscribe(event => {
      if (event.type === 'run.completed') resolve(event.result);
      if (event.type === 'run.failed') reject(event.error);
    }, reject);
  });
  const accepted = await methods['material.correct'].invoke({ sessionId, ref, text: 'The intended audience is a general readership.' });
  assert.equal(accepted.status, 'correction_submitted');
  try { assert.equal((await correctionFinished).terminal.executionStatus, 'completed'); } finally { unsubscribe(); }
  const corrected = (await methods['material.list'].invoke({ owner })).items[0];
  assert.notEqual(corrected.revisionId, revisionId);
  await assert.rejects(methods['material.correct'].invoke({ sessionId, ref, text: 'Stale attempt' }), /head changed/);
  assert.equal((await methods['material.read'].invoke({ ref })).text, 'The audience is technical.', 'Historical evidence remains addressable before revocation.');
  await app.setMode('edit');
  assert.deepEqual((await methods['material.list'].invoke({ owner })).items, [corrected]);
  await app.close();
  app = await openWritingApplication({ rootDirectory: f.root, stateRoot: f.stateRoot, sessionId, mode: 'review',
    configuration: { provider: f.provider, model: 'writing-test', materials } });
  await app.start();
  methods = writingRpcMethods(app, () => {});
  const restored = await methods['material.list'].invoke({ owner });
  assert.equal(restored.items[0].revisionId, corrected.revisionId);
  const target = { owner, itemId, revisionId: corrected.revisionId };
  await methods['material.revoke'].invoke({ owner, operationId: 'user-withdraw', expectedRevision: restored.revocationRevision,
    refs: [{ itemId, revisionId: corrected.revisionId }] });
  await assert.rejects(methods['material.read'].invoke({ ref: target }), /revoked|unavailable/);
  await assert.rejects(methods['material.erase'].invoke({ targets: [target] }), /unsupported/);
  assert.equal((await methods['material.read'].invoke({ ref })).text, 'The audience is technical.');
  await assert.rejects(methods['input.submit'].invoke({ task: 'Pretend this is a timer', origin: { kind: 'host_wake' } }), /origin is assigned by the host/);
});

test('writing config installs only host-selected skill sources while review keeps document permissions separate', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const skills = new SkillCatalog({ sources: [new InMemorySkillSource({ scopeId: 'editorial', bindingRevision: 'skills-1', packages: [{ packageId: 'source-review', files: [
    { path: 'SKILL.md', content: '---\nname: source-review\ndescription: Review claims against cited sources.\nallowed-tools: apply_patch\n---\nRead source evidence before accepting a claim.\n' }
  ] }] })] });
  const f = await fixture('', { responses: [toolCall('context_skill_discover', { scopeId: 'editorial' }), request => {
    const names = request.tools.map(tool => tool.type === 'function' ? tool.function.name : tool.name);
    assert(names.includes('context_skill_read'));
    assert(!names.includes('apply_patch'));
    return 'The source-review method is discoverable.';
  }] });
  await f.application.close();
  const app = await openWritingApplication({ rootDirectory: f.root, stateRoot: f.stateRoot, mode: 'review', skills,
    configuration: { provider: f.provider, model: 'writing-test' } });
  t.after(async () => { await app.close(); await f.close(); });
  await app.start();
  assert.equal((await submit(app, 'Find an editorial method.')).terminal.executionStatus, 'completed');
});


test('writing participants cannot inherit material scopes or skill sources through supervisor capabilities', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const materials = materialHost();
  const skills = new SkillCatalog({ sources: [] });
  let participantRequests = 0;
  const finish = request => {
    const names = request.tools.map(tool => tool.type === 'function' ? tool.function.name : tool.name);
    const participant = JSON.stringify(request.messages).includes('Current collaboration assignment');
    if (participant) {
      participantRequests++;
      assert(names.includes('context_state_list'));
      assert(!names.includes('context_skill_read'));
      if (participantRequests === 1) return toolCall('context_material_scopes', {});
      assert(!JSON.stringify(request.messages).includes('private:writer-1'), 'Supervisor scopes must not appear in the participant inventory.');
    } else assert(names.includes('context_state_list'));
    return 'Inspection complete.';
  };
  const f = await fixture('', { responses: [
    ...collaborationStartResponses('Inspect the writing task independently.', 'review'), finish, finish, finish
  ] });
  await f.application.close();
  const app = await openWritingApplication({ rootDirectory: f.root, stateRoot: f.stateRoot, mode: 'review',
    configuration: { provider: f.provider, model: 'writing-test', materials, skills } });
  t.after(async () => { await app.close(); await f.close(); });
  await app.start();
  assert.equal((await submit(app, 'Ask for an independent inspection.')).terminal.executionStatus, 'completed');
  const collaboration = await app.readCollaboration();
  await app.waitForParticipants({ participantIds: collaboration.participants.map(value => value.participant.participantId), timeoutMs: collaboration.maxWaitMs });
  assert.equal(participantRequests, 2);
});

test('an active RPC correction fences older material writes before the next dependent action', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const materials = materialHost();
  const f = await fixture('', { responses: [toolCall('context_state_save', { owner, operations: [{ kind: 'create', text: 'The event is on Thursday.' }] }), 'Saved.'] });
  await f.application.close();
  const app = await openWritingApplication({ rootDirectory: f.root, stateRoot: f.stateRoot, mode: 'review',
    configuration: { provider: f.provider, model: 'writing-test', materials } });
  t.after(async () => { await app.close(); await f.close(); });
  await app.start();
  assert.equal((await submit(app, 'Remember the event date.')).terminal.executionStatus, 'completed');
  const methods = writingRpcMethods(app, () => {});
  const original = (await methods['material.list'].invoke({ owner })).items[0];
  const ref = { owner, itemId: original.itemId, revisionId: original.revisionId };
  let entered, release;
  const blocked = new Promise(resolve => { entered = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  let staleWasPublished = false, corrected = false;
  const continueWork = async request => {
    const current = (await app.materialService().list(owner)).items[0];
    staleWasPublished ||= (await app.materialService().read({ owner, itemId: current.itemId, revisionId: current.revisionId })).text === 'Stale Thursday assumption.';
    if (!corrected && JSON.stringify(request.messages).includes('Latest corrected date: Friday')) {
      corrected = true;
      return toolCall('context_state_save', { owner, operations: [{ kind: 'replace', itemId: ref.itemId, expectedRevisionId: current.revisionId, text: 'The event is on Friday.' }] });
    }
    return 'Reviewed the current date.';
  };
  f.provider.responses.push(() => { entered(); return response; }, continueWork, continueWork, continueWork, continueWork);
  const active = await app.submit({ task: 'Use the event date for planning.' });
  await blocked;
  const completedRuns = [];
  const unsubscribe = app.subscribe(event => { if (event.type === 'run.completed') completedRuns.push(event.runId); }, error => { throw error; });
  t.after(unsubscribe);
  const correction = await methods['material.correct'].invoke({ sessionId: app.state().sessionId, ref, text: 'Latest corrected date: Friday' });
  assert.equal(correction.status, 'correction_submitted');
  release(toolCall('context_state_save', { owner, operations: [{ kind: 'replace', itemId: ref.itemId, expectedRevisionId: ref.revisionId, text: 'Stale Thursday assumption.' }] }));
  const result = await active.completion;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify({ result, diagnostics: (await app.readSession()).toolDiagnostics }));
  while (!completedRuns.includes(correction.submission.runId)) {
    t.signal.throwIfAborted();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(staleWasPublished, false);
  assert.equal(corrected, true);
  const head = (await methods['material.list'].invoke({ owner })).items[0];
  assert.equal((await methods['material.read'].invoke({ ref: { owner, itemId: head.itemId, revisionId: head.revisionId } })).text, 'The event is on Friday.');
});

test('session-local material controls work without a shared-scope host and preserve revocation after restart', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const f = await fixture('', { responses: [toolCall('context_state_save', { operations: [{ kind: 'create', text: 'The current draft needs source review.' }] }), 'Saved.'] });
  let app = f.application;
  t.after(async () => { await app.close(); await f.close(); });
  await app.start();
  assert.equal((await submit(app, 'Preserve the current review context.')).terminal.executionStatus, 'completed');
  let methods = writingRpcMethods(app, () => {});
  const owner = await methods['material.owner'].invoke({});
  assert.equal(owner.kind, 'session');
  assert.equal(owner.sessionId, app.state().sessionId);
  assert.deepEqual((await methods['material.scopes'].invoke({})).items, []);
  const page = await methods['material.list'].invoke({ owner });
  assert.equal(page.items.length, 1);
  const { itemId, revisionId } = page.items[0];
  const ref = { owner, itemId, revisionId };
  assert.equal((await methods['material.read'].invoke({ ref })).text, 'The current draft needs source review.');
  await methods['material.revoke'].invoke({ owner, expectedRevision: page.revocationRevision, operationId: 'local-user-revocation', refs: [{ itemId, revisionId }] });
  await assert.rejects(app.readSessionState({ itemId, revisionId }), /revoked|unavailable/);
  await app.close();
  app = await openWritingApplication({ rootDirectory: f.root, stateRoot: f.stateRoot, sessionId: owner.sessionId, mode: 'review',
    configuration: { provider: f.provider, model: 'writing-test' } });
  await app.start();
  methods = writingRpcMethods(app, () => {});
  await assert.rejects(methods['material.read'].invoke({ ref }), /revoked|unavailable/);
  await assert.rejects(methods['material.erase'].invoke({ targets: [ref] }), /unsupported/);
});

test('correction refuses a run that ended during exact target inspection', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const materials = materialHost();
  const f = await fixture('', { responses: [toolCall('context_state_save', { owner, operations: [{ kind: 'create', text: 'An inspected preference.' }] }), 'Saved.'] });
  await f.application.close();
  const app = await openWritingApplication({ rootDirectory: f.root, stateRoot: f.stateRoot, mode: 'review', configuration: { provider: f.provider, model: 'writing-test', materials } });
  t.after(async () => { await app.close(); await f.close(); });
  await app.start();
  await submit(app, 'Retain the preference.');
  const service = app.materialService(), item = (await service.list(owner)).items[0];
  const ref = { owner, itemId: item.itemId, revisionId: item.revisionId };
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), response = new Promise(resolve => { release = resolve; });
  f.provider.responses.push(() => { enter(); return response; });
  const active = await app.submit({ task: 'Review the existing preference.' });
  await entered;
  let checked, releaseInspection;
  const inspected = new Promise(resolve => { checked = resolve; }), inspection = new Promise(resolve => { releaseInspection = resolve; });
  const assertCurrent = service.assertCurrent.bind(service);
  service.assertCurrent = async target => { await assertCurrent(target); checked(); await inspection; };
  const correction = app.submitMaterialCorrection(ref, 'A newer correction.', app.state().sessionId);
  await inspected;
  release('Review finished.');
  await active.completion;
  releaseInspection();
  await assert.rejects(correction, /active run changed/);
  service.assertCurrent = assertCurrent;
  assert.equal(f.provider.requests.length, 3);
});

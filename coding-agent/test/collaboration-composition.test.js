import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createCodingSession, closeCodingSession, openCodingWorkspace } from '@ismail-elkorchi/coding-agent';
import { LocalCommandExecution } from '@agent-core/tools-local';
import { sourceRef } from '@agent-core/runtime';
import { ScriptedWritingProvider, toolCall } from '../../writing-agent/test/helpers/runtime.js';
import { createWorkspace, trust } from './fixtures/scripted-cli.js';

const integration = { skip: process.platform !== 'linux', timeout: 90_000 };
async function composition(t, responses, options = {}) {
  const fixture = await createWorkspace({ tools: ['read_files', 'apply_patch', 'exec_command'], checks: [], files: { 'document.txt': 'Original.\n' } });
  await trust(fixture);
  const workspace = await openCodingWorkspace(fixture.root, { stateRoot: fixture.stateRoot });
  const provider = new ScriptedWritingProvider(responses);
  const session = await createCodingSession({ workspace, provider,
    settings: { provider: provider.id, model: 'writing-test' }, permissionMode: 'full_host',
    maxOutputTokens: 1000, ...options });
  t.after(async () => { await closeCodingSession(session); workspace.fileRoot.close(); await fixture.close(); });
  return { fixture, workspace, provider, session };
}
async function settle(session, selection) {
  for (;;) {
    const result = await session.collaboration.wait(selection);
    if (result.reason !== 'timeout') return result;
  }
}
function assignment(id, task, toolNames) {
  return { operationId: `start-${id}`, participantId: id, task, expectedEpoch: 0,
    capabilityRevision: 'test/exact-grant@1', capabilities: { toolNames }, budgetScopeId: id };
}
async function eventually(predicate) {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) assert.fail('The expected collaboration state was not observed.');
    await setTimeout(10);
  }
}

test('a read-only participant shares its supervisor file scheduler and the workspace command manager closes once', integration, async t => {
  const { session, provider } = await composition(t, [toolCall('read_files', { files: [{ path: 'document.txt' }] }), 'Read complete.']);
  const resources = session.workspaceResources;
  assert.equal(resources.resourceLeases, resources.commandExecution.resourceLeases);
  const held = await resources.resourceLeases.acquire({ accesses: [{ scope: 'files', mode: 'write' }], lockScopes: ['files'], recovery: { kind: 'unknown' } }, 'external-write');
  t.after(() => held.release());
  const starting = session.collaboration.start(assignment('reader', 'Read document.txt.', ['read_files']));
  await eventually(() => resources.resourceLeases.inspect().waitingCount === 1);
  assert.equal(provider.requests.length, 1, 'read has not passed the conflicting write');
  assert(!JSON.stringify(provider.requests[0].tools).includes('exec_command'), 'child cannot inherit shell capability through the shared manager');
  held.release();
  const child = await starting;
  const result = await settle(session, { participantIds: ['reader'] });
  assert.equal(result.reason, 'settled');
  assert.equal(result.participants[0].phase, 'ended');
  assert.notEqual(child.participant.sessionId, session.session.id);
  let closes = 0;
  const close = LocalCommandExecution.prototype.close;
  t.mock.method(resources.commandExecution, 'close', function () { closes++; return close.call(this); });
  await closeCodingSession(session);
  assert.equal(closes, 1);
  assert.equal(resources.resourceLeases.inspect().activeCount, 0);
});

test('participants planning from one revision reject the candidate whose exact base became stale', integration, async t => {
  const digest = createHash('sha256').update('Original.\n').digest('hex');
  const turns = new Map();
  const bothPlanning = Promise.withResolvers();
  const firstSettled = Promise.withResolvers();
  t.after(() => { bothPlanning.resolve(); firstSettled.resolve(); });
  const respond = async request => {
    const tag = JSON.stringify(request.messages).includes('FIRST edit.') ? 'FIRST' : 'SECOND';
    const turn = turns.get(tag) ?? 0; turns.set(tag, turn + 1);
    if (turn === 0) {
      if (tag === 'SECOND') { bothPlanning.resolve(); await firstSettled.promise; }
      else await bothPlanning.promise;
    }
    return turn === 0 ? toolCall('apply_patch', {
      patch: `*** Begin Patch\n*** Update File: document.txt\n@@\n-Original.\n+${tag}.\n*** End Patch`,
      expectedOldSha256: { 'document.txt': digest }
    }) : `${tag} candidate processed.`;
  };
  const { session, fixture } = await composition(t, Array(6).fill(respond));
  const first = await session.collaboration.start(assignment('first', 'FIRST edit.', ['apply_patch']));
  const second = await session.collaboration.start(assignment('second', 'SECOND edit.', ['apply_patch']));
  const committed = await settle(session, { participantIds: ['first'] });
  assert.equal(committed.reason, 'settled');
  firstSettled.resolve();
  const result = await settle(session, { participantIds: ['first', 'second'] });
  assert.equal(result.reason, 'settled');
  const histories = await Promise.all([first, second].map(async view => {
    const descriptor = await session.sessions.open(view.participant.sessionId, session.session.header.binding);
    return session.sessions.readBranchPage(descriptor);
  }));
  const observations = histories.flatMap(page => page.entries.filter(entry => entry.type === 'observation' && entry.toolName === 'apply_patch'));
  assert.equal(observations.filter(entry => entry.output?.applicationStatus === 'applied').length, 1);
  assert.equal(observations.filter(entry => entry.kind === 'failure' || entry.output?.applicationStatus === 'not_applied').length, 1);
  assert.match(JSON.stringify(observations), /sha256_mismatch|SHA-256|precondition/i);
  assert.match(await readFile(path.join(fixture.root, 'document.txt'), 'utf8'), /^(FIRST|SECOND)\.\n$/);
  assert.equal((await session.collaboration.inspect()).acceptances.length, 0, 'a mutation result does not fabricate application acceptance');
});

test('participant inference is charged to the root owner and the child allowance survives continuation', integration, async t => {
  const { session, provider } = await composition(t, ['First result.', 'Must not be generated.'], {
    inferenceBudget: { maxInvocations: 4 }, collaboration: { participantBudget: { maxInvocations: 1 } }
  });
  const first = await session.collaboration.start(assignment('bounded', 'First review.', []));
  await settle(session, { participantIds: ['bounded'] });
  await session.collaboration.continue({ ...assignment('bounded', 'Continue the review.', []), operationId: 'continue-bounded' });
  const settled = await settle(session, { participantIds: ['bounded'] });
  assert.equal(settled.reason, 'settled');
  assert.equal(provider.requests.length, 1, 'continuation cannot reset the registered child allowance');
  const current = await session.collaboration.inspectParticipant('bounded');
  assert.equal(current.participant.sessionId, first.participant.sessionId);
  assert.equal(current.assignment.revision, 2);
  const allowance = await session.inference.inspectOwnerAllowance(session.inferenceOwnerId);
  assert.match(JSON.stringify(allowance), /bounded/);
});

test('an admitted assignment keeps its model binding through factory failure and changes it only on a new continuation', integration, async t => {
  let adapter;
  const original = { provider: 'writing-test', model: 'writing-test', endpoint: 'http://127.0.0.1:11434' };
  const changed = { provider: 'writing-test', model: 'writing-next', endpoint: 'http://127.0.0.1:11435' };
  const { session, provider, workspace } = await composition(t, ['Recovered original assignment.', 'Continued with the new selection.'], {
    settings: original, resolveProvider: () => adapter
  });
  adapter = provider;
  const describeModel = provider.describeModel.bind(provider);
  t.mock.method(provider, 'describeModel', async model => ({ ...await describeModel(), id: model }));
  const create = session.sessions.create.bind(session.sessions);
  let fail = true;
  t.mock.method(session.sessions, 'create', async input => {
    if (fail) { fail = false; throw new Error('Simulated host failure before child session creation.'); }
    return create(input);
  });
  await assert.rejects(session.collaboration.start(assignment('captured-model', 'Review with the admitted selection.', [])), /Simulated host failure/);
  const admitted = await session.collaboration.inspectParticipant('captured-model');
  assert.deepEqual(admitted.assignment.configuration, original);
  await session.agent.changeModel({ selection: changed, provider,
    profile: await provider.describeModel(changed.model), artifacts: session.artifacts });
  await closeCodingSession(session);
  const restored = await createCodingSession({ workspace, provider, descriptor: session.session,
    settings: changed, resolveProvider: () => provider, permissionMode: 'full_host', maxOutputTokens: 1000 });
  try {
    assert.equal((await settle(restored, { participantIds: ['captured-model'] })).reason, 'settled');
    assert.equal(provider.requests[0].model, original.model);
    assert.deepEqual((await restored.collaboration.inspectParticipant('captured-model')).assignment.configuration, original);
    await restored.collaboration.continue({ ...assignment('captured-model', 'Continue under the new selection.', []),
      operationId: 'continue-captured-model' });
    assert.equal((await settle(restored, { participantIds: ['captured-model'] })).reason, 'settled');
    assert.equal(provider.requests[1].model, changed.model);
    const continued = await restored.collaboration.inspectParticipant('captured-model');
    assert.equal(continued.participant.sessionId, admitted.participant.sessionId);
    assert.deepEqual(continued.assignment.configuration, changed);
    const descriptor = await restored.sessions.open(continued.participant.sessionId, session.session.header.binding);
    assert.deepEqual(await restored.sessions.currentModelSettings(descriptor), changed);
  } finally { await closeCodingSession(restored); }
});

test('permanent cancellation settles a finished participant process owner without closing the shared manager', integration, async t => {
  const { session, provider } = await composition(t, [
    toolCall('exec_command', { command: 'sleep 30', yieldMs: 1, timeoutMs: 30_000 }),
    'The process is still running.',
    toolCall('read_files', { files: [{ path: 'document.txt' }] }),
    'The workspace is available again.'
  ]);
  const child = await session.collaboration.start(assignment('process-owner', 'Launch the process and report without waiting.', ['exec_command']));
  const result = await settle(session, { participantIds: ['process-owner'] });
  assert.equal(result.reason, 'settled');
  assert.equal(result.participants[0].phase, 'ended', JSON.stringify(await session.runs.inspect(child.assignment.runId)));
  const commands = session.workspaceResources.commandExecution;
  const ownerId = `coding-session:${child.participant.sessionId}`;
  assert.equal(commands.activeCount(ownerId), 1, 'the process outlives its participant run');
  const process = (await commands.listProcesses()).find(value => value.owner?.ownerId === ownerId);
  assert(process);
  let closes = 0;
  const close = commands.close.bind(commands);
  t.mock.method(commands, 'close', () => { closes++; return close(); });
  const control = { operationId: 'cancel-process-owner', participantId: 'process-owner', expectedEpoch: 0,
    expectedSessionId: child.participant.sessionId, expectedRunId: child.assignment.runId,
    reason: 'The delegated process is no longer needed.', cascade: false };
  await session.collaboration.cancel(control);
  await session.collaboration.cancel(control);
  assert.equal(commands.activeCount(ownerId), 0);
  const terminal = await commands.query(process.processId, 1000, 0, 0);
  assert(terminal.artifact, 'the shared manager retains its canonical terminal output');
  assert.equal(await session.collaboration.canReadPublicArtifact('process-owner', terminal.artifact), true,
    'the original producer grant commits before cancellation acknowledges resource settlement');
  assert.equal(session.workspaceResources.resourceLeases.inspect().activeCount, 0);
  assert.equal(closes, 0, 'cancellation only disposes the participant resource owner');
  const submission = await session.agent.submit({ task: 'Read document.txt after the child is cancelled.' });
  assert.equal(submission.kind, 'started');
  assert.equal((await submission.completion).state, 'ended');
  assert.equal(provider.requests.length, 4);
  const group = await session.collaboration.inspect();
  assert(group.controls.find(value => value.operationId === control.operationId).applied);
  await closeCodingSession(session);
  assert.equal(closes, 1);
});

test('opening a second local client shares the manager and cannot stop an active collaboration host process', integration, async t => {
  const { session, provider, workspace } = await composition(t, [
    toolCall('exec_command', { command: 'sleep 30', yieldMs: 1, timeoutMs: 30_000 }),
    'The root process remains running.', 'Child review complete.'
  ]);
  const second = await createCodingSession({ workspace, provider, descriptor: session.session,
    settings: { provider: provider.id, model: 'writing-test' }, permissionMode: 'read_only', maxOutputTokens: 1000 });
  t.after(() => closeCodingSession(second));
  assert.equal(second.workspaceResources.commandExecution, session.workspaceResources.commandExecution);
  const started = await session.agent.submit({ task: 'Launch a background process and finish.' });
  const outcome = await started.completion;
  assert.equal(outcome.state, 'ended', JSON.stringify(outcome));
  const commands = session.workspaceResources.commandExecution;
  const rootOwner = `coding-session:${session.session.id}`;
  assert.equal(commands.activeCount(rootOwner), 1);
  await closeCodingSession(second);
  assert.equal(commands.activeCount(rootOwner), 1, 'closing a passive client cannot dispose the active client owner');
  await session.collaboration.start(assignment('independent-review', 'Review independently.', []));
  await settle(session, { participantIds: ['independent-review'] });
  await assert.rejects(createCodingSession({ workspace, provider, descriptor: session.session,
    settings: { provider: provider.id, model: 'writing-test' }, permissionMode: 'full_host', maxOutputTokens: 1000 }), /own|host|busy|lock/i);
  assert.equal(commands.activeCount(rootOwner), 1, 'rejected group ownership cannot reconcile or stop the live root process');
  await closeCodingSession(session);
  assert.equal(commands.activeCount(rootOwner), 0);
});

test('compatible local clients keep one command authority until its last owner closes', integration, async t => {
  const { session, provider, workspace } = await composition(t, ['Independent review complete.']);
  const options = { workspace, provider, descriptor: session.session,
    settings: { provider: provider.id, model: 'writing-test' }, permissionMode: 'full_host', maxOutputTokens: 1000 };
  const second = await createCodingSession({ ...options, permissionMode: 'read_only' });
  t.after(() => closeCodingSession(second));
  const commands = session.workspaceResources.commandExecution;
  assert.equal(second.workspaceResources.commandExecution, commands);
  assert.equal(second.workspaceResources.resourceLeases, session.workspaceResources.resourceLeases);
  assert(!second.toolNames.includes('exec_command'), 'recovery authority does not grant read-only models execution');
  let closes = 0;
  const close = commands.close.bind(commands);
  t.mock.method(commands, 'close', () => { closes++; return close(); });
  await closeCodingSession(second);
  assert.equal(closes, 0);
  await session.collaboration.start(assignment('owner-review', 'Review independently.', []));
  assert.equal((await settle(session, { participantIds: ['owner-review'] })).reason, 'settled');
  await assert.rejects(createCodingSession(options), /own|host|busy|lock/i);
  assert.equal(closes, 0, 'an ownership contender cannot close the live shared manager');
  await closeCodingSession(session);
  assert.equal(closes, 1);
  let reconciles = 0;
  const reconcile = LocalCommandExecution.prototype.reconcile;
  t.mock.method(LocalCommandExecution.prototype, 'reconcile', function (ownerId) {
    reconciles++; return reconcile.call(this, ownerId);
  });
  const recovered = await createCodingSession({ ...options, permissionMode: 'read_only' });
  try {
    assert(reconciles > 0, 'read-only reopen explicitly reconciles recorded workspace resources');
    assert.notEqual(recovered.workspaceResources.commandExecution, commands);
    assert(!recovered.toolNames.includes('exec_command'));
    assert(!recovered.toolNames.includes('write_stdin'));
  } finally { await closeCodingSession(recovered); }
});

test('selected assignment context is imported before the first child request and stays scoped on continuation', integration, async t => {
  const selected = 'Selected original evidence.';
  const excluded = 'Unselected private root context.';
  const { session, provider } = await composition(t, ['Root evidence recorded.',
    'The selected evidence has been reviewed.', 'The selected evidence has been revisited.']);
  const rootRun = await session.agent.submit({ task: `${selected} ${excluded}` });
  assert.equal((await rootRun.completion).state, 'ended');
  const rootHistory = await session.sessions.readBranchPage(session.session);
  const original = rootHistory.entries.find(entry => entry.type === 'input');
  const reference = sourceRef(session.session.id, original);
  const representation = await session.history.read({ source: reference, maxBytes: 8192 });
  assert.equal(representation.status, 'available');
  const sourceBytes = Buffer.from(representation.item.text);
  const offset = sourceBytes.indexOf(Buffer.from(selected));
  assert(offset >= 0);
  assert.equal(sourceBytes.subarray(offset, offset + Buffer.byteLength(selected)).toString(), selected);
  const source = { kind: 'history', cut: await session.history.capture(), source: reference,
    range: { offset, bytes: Buffer.byteLength(selected) } };
  const child = await session.collaboration.start({ ...assignment('source-review', 'Review the selected evidence.', []),
    initialSources: [source], sourceSender: { participantId: `supervisor:${session.session.id}`,
      sessionId: session.session.id, runId: rootRun.runId } });
  assert.equal((await settle(session, { participantIds: ['source-review'] })).reason, 'settled');
  const descriptor = await session.sessions.open(child.participant.sessionId, session.session.header.binding);
  const childHistory = await session.sessions.readBranchPage(descriptor);
  const contribution = childHistory.entries.find(entry => entry.type === 'peer_contribution');
  assert.equal(contribution.authorship, 'model');
  assert.equal(contribution.contribution.shares[0].text, selected);
  assert.equal(contribution.contribution.shares[0].sourceRole, 'user');
  assert(!childHistory.entries.some(entry => entry.type === 'steering'));
  await session.collaboration.continue({ ...assignment('source-review', 'Revisit the selected evidence.', []), operationId: 'continue-source-review' });
  assert.equal((await settle(session, { participantIds: ['source-review'] })).reason, 'settled');
  assert.equal(provider.requests.length, 3);
  for (const request of provider.requests.slice(1)) {
    const serialized = JSON.stringify(request);
    assert(serialized.includes(selected), 'selected evidence reaches both the first and continued child request');
    assert(!serialized.includes(excluded), 'the participant receives only the exact selected source range');
  }
});

test('an exact public artifact range does not grant the child whole-artifact read access', integration, async t => {
  const selected = 'Selected artifact evidence.';
  const excluded = 'Unshared artifact contents must remain private.';
  let artifact;
  const { session, provider } = await composition(t, ['Root source ready.',
    () => toolCall('read_artifact', { artifactId: artifact.artifactId, offset: 0, byteCount: 1024 }),
    'Only the selected artifact evidence was available.'
  ]);
  artifact = await session.artifacts.store({ label: 'Root-owned evidence', mediaType: 'text/plain',
    content: Buffer.from(`${selected} ${excluded}`) });
  const rootRun = await session.agent.submit({ task: 'Record the source selection.' });
  assert.equal((await rootRun.completion).state, 'ended');
  const child = await session.collaboration.start({ ...assignment('artifact-review', 'Review the selected artifact.', ['read_artifact']),
    initialSources: [{ kind: 'public_artifact', artifact, range: { offset: 0, bytes: Buffer.byteLength(selected) } }],
    sourceSender: { participantId: `supervisor:${session.session.id}`, sessionId: session.session.id, runId: rootRun.runId }
  });
  assert.equal((await settle(session, { participantIds: ['artifact-review'] })).reason, 'settled');
  const descriptor = await session.sessions.open(child.participant.sessionId, session.session.header.binding);
  const history = await session.sessions.readBranchPage(descriptor);
  const observation = history.entries.find(entry => entry.type === 'observation' && entry.toolName === 'read_artifact');
  assert.equal(observation.kind, 'failure');
  assert.equal(await session.collaboration.canReadPublicArtifact('artifact-review', artifact), false);
  for (const request of provider.requests.slice(1)) {
    assert(JSON.stringify(request).includes(selected));
    assert(!JSON.stringify(request).includes(excluded));
  }
});

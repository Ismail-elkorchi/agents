import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { AgentSession } from '@agent-core/runtime';
import { JsonlEventRepository } from '@agent-core/persistence/node';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
import { closeCodingSession, openCodingApplication } from '@ismail-elkorchi/coding-agent';
import { createWorkspace, finalResponse, scriptedOllama, trust } from './fixtures/scripted-cli.js';

for (const operation of ['close', 'newSession'])
  test(`${operation} drains owned verification reads before releasing the old session`, {
    skip: process.platform !== 'linux', timeout: 30_000
  }, async t => {
    const provider = await scriptedOllama([finalResponse('Finished.')]);
    const fixture = await createWorkspace({ endpoint: provider.endpoint, tools: ['read_files'], checks: [] });
    let application;
    const blocked = Promise.withResolvers();
    const release = Promise.withResolvers();
    const observer = Promise.withResolvers();
    t.after(async () => {
      release.resolve();
      observer.resolve();
      await application?.close();
      await provider.close();
      await fixture.close();
    });
    await trust(fixture);
    application = await openCodingApplication({
      maxOutputTokens: fixture.maxOutputTokens, root: fixture.root, stateRoot: fixture.stateRoot,
      permissionMode: 'read_only', providerEndpoint: provider.endpoint
    });
    await application.start();
    let completedRun;
    let lateVerification = false;
    let stopping = false;
    application.subscribe(event => {
      if (event.type === 'run.completed') completedRun = event.runId;
      if (stopping && event.type === 'verification.updated') lateVerification = true;
    }, error => assert.fail(error));
    // An arbitrary external observer must never hold application cleanup hostage.
    application.subscribe(event => event.type === 'run.completed' ? observer.promise : undefined,
      error => assert.fail(error));
    const tail = JsonlEventRepository.prototype.tail;
    let intercepted = false;
    t.mock.method(JsonlEventRepository.prototype, 'tail', async function(runId) {
      if (!intercepted && runId === completedRun) {
        intercepted = true;
        blocked.resolve();
        await release.promise;
      }
      return tail.call(this, runId);
    });
    const submitted = await application.submit({ task: 'Finish without tools.' });
    assert.equal((await submitted.completion).state, 'ended');
    await blocked.promise;
    let agentCloseCalls = 0;
    const close = AgentSession.prototype.close;
    t.mock.method(AgentSession.prototype, 'close', function() {
      agentCloseCalls++;
      return close.call(this);
    });
    stopping = true;
    const completion = application[operation]();
    await setImmediate();
    assert.equal(agentCloseCalls, 0, 'the owned reader still holds the old session resources');
    release.resolve();
    await completion;
    assert.equal(agentCloseCalls, 1, 'the old dispatcher must stop, including its refresh timer');
    assert.equal(lateVerification, false, 'detached work cannot publish into the closed or replacement application');
  });

test('the composition close boundary stops the dispatcher and aggregates cleanup failures', async () => {
  const order = [];
  const agentFailure = new Error('dispatcher cleanup failed');
  const resourceFailure = new Error('resource cleanup failed');
  await assert.rejects(closeCodingSession({
    agent: { async close() { order.push('agent'); throw agentFailure; } },
    async closeResources() { order.push('resources'); throw resourceFailure; }
  }), error => error instanceof AggregateError &&
    error.errors[0] === agentFailure && error.errors[1] === resourceFailure);
  assert.deepEqual(order, ['agent', 'resources']);
});

for (const operation of ['close', 'newSession']) {
  test(`${operation} drains admitted history reads before releasing their captured session`, {
    skip: process.platform !== 'linux', timeout: 30_000
  }, async t => {
    const provider = await scriptedOllama([finalResponse('Finished.')]);
    const fixture = await createWorkspace({ endpoint: provider.endpoint, tools: ['read_files'], checks: [] });
    const release = Promise.withResolvers();
    let application;
    t.after(async () => {
      release.resolve();
      await application?.close();
      await provider.close();
      await fixture.close();
    });
    await trust(fixture);
    application = await openCodingApplication({
      maxOutputTokens: fixture.maxOutputTokens, root: fixture.root, stateRoot: fixture.stateRoot,
      permissionMode: 'read_only', providerEndpoint: provider.endpoint
    });
    await application.start();
    const original = await application.readHistory();
    const entered = Promise.withResolvers();
    const read = JsonlSessionRepository.prototype.readBranchPage;
    let intercepted = false;
    t.mock.method(JsonlSessionRepository.prototype, 'readBranchPage', async function(...args) {
      if (!intercepted) {
        intercepted = true;
        entered.resolve();
        await release.promise;
      }
      return read.apply(this, args);
    });
    const reading = application.readHistory();
    await entered.promise;
    let stopped = false;
    const stopping = application[operation]().then(() => { stopped = true; });
    await setImmediate();
    assert.equal(stopped, false);
    assert.throws(() => application.readHistory());
    release.resolve();
    const page = await reading;
    await stopping;
    assert.deepEqual(page.history.boundary, original.history.boundary, 'the admitted read retains its original session identity');
    if (operation === 'newSession') {
      const replacement = await application.readHistory();
      assert.notEqual(replacement.history.boundary.sessionId, original.history.boundary.sessionId);
    }
  });
}

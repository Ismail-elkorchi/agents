import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { HostWakeService } from '@agent-core/runtime';
import { JsonlIntentionRepository } from '@agent-core/runtime/node';
import { conversationText, projectSessionEntry } from '@agent-core/tui';
import { openWritingApplication } from '@ismail-elkorchi/writing-agent';
import { writingRpcMethods } from '@ismail-elkorchi/writing-agent/rpc';
import { fixture } from './helpers/runtime.js';

function nextCompletion(app) {
  let unsubscribe;
  const result = new Promise((resolve, reject) => {
    unsubscribe = app.subscribe(event => {
      if (event.type === 'run.completed') resolve(event.result);
      if (event.type === 'run.failed') reject(event.error);
    }, reject);
  });
  return { result, close: () => unsubscribe() };
}

test('writing host wake restores after restart with durable review authority and typed RPC/TUI provenance', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const f = await fixture('', { responses: ['The scheduled review is complete.'] });
  let app = f.application;
  t.after(async () => { await app.close(); await f.close(); });
  await app.start();
  const sessionId = app.state().sessionId;
  let now = '2026-10-19T12:00:00.000Z';
  let authorized = true;
  const createHost = () => new HostWakeService({
    repository: new JsonlIntentionRepository({ rootDir: path.join(f.parent, 'intentions') }),
    resolveSession: async id => app.hostWakeSession(id),
    adapter: {
      now: () => now,
      evaluate: async () => ({ key: 'clock-tick-1', evidence: { checkedAt: now } }),
      withAdmission: async (intention, _trigger, operation) => {
        assert.equal(intention.authorizationRef, 'user-request:review-tomorrow');
        if (!authorized) throw new Error('The host authorization was withdrawn.');
        return operation();
      }
    }
  });
  let host = createHost();
  await host.accept({ ownerId: 'writer', intentionId: 'review-tomorrow', sessionId,
    authorizationRef: 'user-request:review-tomorrow', condition: { kind: 'time', notBefore: '2026-10-20T12:00:00.000Z' },
    input: { task: 'Review the draft and report findings without editing.' } });
  assert.equal((await host.dispatch('writer', 'review-tomorrow')).status, 'pending');
  assert.equal(f.provider.requests.length, 0);
  await app.close();
  app = await openWritingApplication({ rootDirectory: f.root, stateRoot: f.stateRoot, sessionId, mode: 'review',
    configuration: { provider: f.provider, model: 'writing-test' } });
  await app.start();
  now = '2026-10-20T12:00:00.000Z';
  host = createHost();
  authorized = false;
  await assert.rejects(host.dispatch('writer', 'review-tomorrow'), /authorization was withdrawn/);
  assert.equal(f.provider.requests.length, 0);
  authorized = true;
  const completed = nextCompletion(app);
  const admitted = await host.dispatch('writer', 'review-tomorrow');
  assert.equal(admitted.status, 'admitted');
  try { assert.equal((await completed.result).terminal.executionStatus, 'completed'); } finally { completed.close(); }
  const methods = writingRpcMethods(app, () => {});
  assert(!Object.keys(methods).some(name => /wake|triggered/.test(name)), 'The privileged host ingress is not user RPC.');
  const history = await methods['history.read'].invoke({});
  const input = history.entries.find(entry => entry.type === 'input');
  assert.equal(input.originalInput.origin.kind, 'host_wake');
  assert.equal(input.originalInput.origin.intentionId, 'review-tomorrow');
  const presentation = projectSessionEntry(input);
  assert.match(conversationText(presentation[0]), /Host wake/);
  const toolNames = f.provider.requests[0].tools.map(tool => tool.type === 'function' ? tool.function.name : tool.name);
  assert(!toolNames.includes('apply_patch'));
  const settled = await host.dispatch('writer', 'review-tomorrow');
  assert.equal(settled.status, 'completed');
  assert.equal(settled.outcome, 'completed');
  await app.close();
  app = await openWritingApplication({ rootDirectory: f.root, stateRoot: f.stateRoot, sessionId, mode: 'edit',
    configuration: { provider: f.provider, model: 'writing-test' } });
  await app.start();
  host = createHost();
  const replay = await host.dispatch('writer', 'review-tomorrow');
  assert.deepEqual(replay.receipt, admitted.receipt);
  assert.equal(f.provider.requests.length, 1, 'Receipt replay after restart cannot repeat the work or change its permission.');
  assert.throws(() => app.hostWakeSession('wrong-session'), /not the current application session/);
});

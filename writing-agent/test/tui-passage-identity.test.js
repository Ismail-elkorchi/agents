import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySessionRepository } from '@agent-core/runtime';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { createWritingAgentTuiApp } from '@ismail-elkorchi/writing-agent/tui';
import { waitForState } from '../../test-helpers/tui-runtime.js';

async function fixture(t, effectPolicy) {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ binding: { schemaId: 'test/passage-identity', schemaVersion: 1, subject: {} } });
  let passageReads = 0;
  const application = {
    state: () => ({ workspace: '/workspace', mode: 'review', sessionId: session.id, status: 'ready' }),
    start: async () => {},
    readSession: async () => ({ toolDiagnostics: [], runs: [], session: {
      sessionId: session.id, phase: 'idle', configuration: { provider: 'fixture', model: 'fixture' }, queuedInputs: 0
    } }),
    readHistory: request => repository.readBranchPage(session, request),
    listDocuments: async () => ['a.txt', 'b.txt'].map(path => ({ path, type: 'file' })),
    readDocument: async path => ({ path, content: 'Same passage.', sha256: 'a'.repeat(64),
      revision: { path, expectedSha256: 'a'.repeat(64) } }),
    readPassageContext: async request => {
      passageReads++;
      return { id: `passage:${request.revision.path}`, sourceUri: `file:///workspace/${request.revision.path}`,
        sourceKind: 'user', integrity: 'verified', representation: 'excerpt', mediaType: 'text/plain',
        title: request.revision.path, content: 'Same passage.', purpose: 'User selected original.',
        range: { kind: 'byte', start: 0, end: 13 } };
    }
  };
  const runtime = createTuiRuntime({ host: createMemoryTerminalHost({ terminalSize: { columns: 90, rows: 28 } }),
    app: createWritingAgentTuiApp(application), ...(effectPolicy === undefined ? {} : { effectPolicy }) });
  t.after(() => runtime.dispose());
  await runtime.start();
  await waitForState(runtime, t.signal, () => runtime.state().history.length > 0);
  const open = async path => {
    await runtime.dispatch({ type: 'picker.open', subject: 'resources' });
    await waitForState(runtime, t.signal, () => runtime.state().overlay.kind === 'picker');
    await runtime.dispatch({ type: 'picker.accept', id: path });
    await waitForState(runtime, t.signal, () => runtime.state().document?.value.path === path && !runtime.state().documentRequest);
    await runtime.dispatch({ type: 'document.edit', transition: { kind: 'edit', operation: { kind: 'moveHome' } } });
    await runtime.dispatch({ type: 'document.edit', transition: { kind: 'edit', operation: { kind: 'moveEnd', extendSelection: true } } });
  };
  return { application, runtime, open, reads: () => passageReads };
}

test('repeated passage selection coalesces while identical text in another document remains distinct', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await f.open('a.txt');
  await f.runtime.dispatch({ type: 'document.use-passage' });
  await waitForState(f.runtime, t.signal, () => f.runtime.state().composer.attachments.length === 1);
  await f.runtime.dispatch({ type: 'document.use-passage' });
  await waitForState(f.runtime, t.signal, () => f.reads() === 2 && f.runtime.metrics().effects.owned === 0);
  assert.equal(f.runtime.state().composer.attachments.length, 1);
  await f.open('b.txt');
  await f.runtime.dispatch({ type: 'document.use-passage' });
  await waitForState(f.runtime, t.signal, () => f.runtime.state().composer.attachments.length === 2);
  assert.deepEqual(f.runtime.state().composer.attachments.map(value => value.item.id), ['passage:a.txt', 'passage:b.txt']);
});

test('late passage selection cannot attach after document navigation, including return to the same revision', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const pending = Promise.withResolvers();
  t.after(() => pending.resolve());
  let started = false;
  const read = f.application.readPassageContext;
  f.application.readPassageContext = async request => { started = true; await pending.promise; return read(request); };
  await f.open('a.txt');
  await f.runtime.dispatch({ type: 'document.use-passage' });
  await waitForState(f.runtime, t.signal, () => started);
  await f.runtime.dispatch({ type: 'document.use-passage' });
  await f.open('b.txt');
  await f.open('a.txt');
  pending.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await waitForState(f.runtime, t.signal, () => f.runtime.metrics().effects.owned === 0);
  assert.equal(f.runtime.state().composer.attachments.length, 0);
});

for (const duplicate of [false, true])
  test(`${duplicate ? 'Duplicate' : 'Distinct'} queued passage requests ${duplicate ? 'coalesce' : 'attach in order'} after the blocked first read`, { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const pending = Promise.withResolvers();
  t.after(() => pending.resolve());
  const read = f.application.readPassageContext;
  let calls = 0;
  f.application.readPassageContext = async request => {
    calls++;
    if (calls === 1) await pending.promise;
    const item = await read(request);
    const range = request.selector.range;
    return { ...item, id: `${item.id}:${range.start}:${range.end}` };
  };
  await f.open('a.txt');
  await f.runtime.dispatch({ type: 'document.use-passage' });
  await waitForState(f.runtime, t.signal, () => calls === 1);
  if (!duplicate) {
    await f.runtime.dispatch({ type: 'document.edit', transition: { kind: 'edit', operation: { kind: 'moveHome' } } });
    await f.runtime.dispatch({ type: 'document.edit', transition: { kind: 'edit', operation: { kind: 'moveRight', extendSelection: true } } });
  }
  await f.runtime.dispatch({ type: 'document.use-passage' });
  pending.resolve();
  await waitForState(f.runtime, t.signal, () => f.runtime.metrics().effects.owned === 0);
  assert.equal(calls, 2);
  assert.deepEqual(f.runtime.state().composer.attachments.map(value => value.item.id), duplicate
    ? ['passage:a.txt:0:13']
    : ['passage:a.txt:0:13', 'passage:a.txt:0:1']);
});

test('a full passage queue exposes its rejection without discarding already accepted selections', { timeout: 10000 }, async t => {
  const f = await fixture(t, { maxActive: 8, maxActivePerId: 1, maxQueued: 16,
    maxQueuedPerId: 1, replacementGracePeriodMs: 0 });
  const pending = Promise.withResolvers();
  t.after(() => pending.resolve());
  const read = f.application.readPassageContext;
  let calls = 0;
  f.application.readPassageContext = async request => { calls++; await pending.promise; return read(request); };
  await f.open('a.txt');
  await f.runtime.dispatch({ type: 'document.use-passage' });
  await waitForState(f.runtime, t.signal, () => calls === 1);
  await f.runtime.dispatch({ type: 'document.use-passage' });
  await f.runtime.dispatch({ type: 'document.use-passage' });
  await waitForState(f.runtime, t.signal, () => /writing-passage.*rejected/i.test(f.runtime.state().notice));
  pending.resolve();
  await waitForState(f.runtime, t.signal, () => f.runtime.metrics().effects.owned === 0);
  assert.equal(calls, 2);
  assert.equal(f.runtime.state().composer.attachments.length, 1);
});

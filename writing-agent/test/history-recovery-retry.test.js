import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import path from 'node:path';
import test from 'node:test';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
import { ContextService } from '@agent-core/runtime';
import { RootedFileAuthority } from '@agent-core/tools-local';
import { openWritingApplication } from '@ismail-elkorchi/writing-agent';
import { ScriptedWritingProvider } from './helpers/runtime.js';

const integration = { skip: process.platform !== 'linux', timeout: 30_000 };

async function fixture(t, selection = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'writing-recovery-retry-'));
  const rootDirectory = path.join(directory, 'workspace');
  const stateRoot = path.join(directory, 'state');
  await mkdir(rootDirectory);
  const provider = new ScriptedWritingProvider(['Accepted once.']);
  const app = await openWritingApplication({
    rootDirectory, stateRoot, sessionId: 'selected', mode: 'review',
    ...(selection
      ? { modelSelection: { provider: provider.id, model: 'writing-test' } }
      : { configuration: { provider, model: 'writing-test' } })
  });
  if (selection) app.connectProvider = () => provider;
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const authority = RootedFileAuthority.adopt(rootDirectory);
  const { device, inode, mountId } = authority.identity;
  authority.close();
  const repository = new JsonlSessionRepository(path.join(path.dirname(app.presentationPath()), 'sessions'));
  const descriptor = await repository.create({
    id: 'selected', binding: { schemaId: 'writing-agent/workspace', schemaVersion: 1, subject: { device, inode, mountId } }
  });
  await repository.appendInput(descriptor, { runId: 'earlier', task: 'Earlier original.' });
  const file = repository.location(descriptor.id);
  const index = `${file}.index`;
  const original = await readFile(file);
  await writeFile(index, 'old derived index\n');
  const events = [];
  let cancelFirst = true;
  app.subscribe(event => {
    if (event.type !== 'history.recovery') return;
    events.push(event.progress);
    if (cancelFirst && event.progress.phase === 'progress' && event.progress.records >= 1) {
      cancelFirst = false;
      void app.abort();
    }
  }, error => assert.fail(error));
  await assert.rejects(app.start(), error => error.name === 'AbortError');
  assert.equal(app.state().status, 'ready');
  assert.equal(await readFile(index, 'utf8'), 'old derived index\n');
  return { app, provider, file, index, original, events };
}

for (const selection of [false, true]) {
  test(`ordinary writing submission retries cancelled startup with ${selection ? 'model selection' : 'supplied configuration'}`, integration, async t => {
    const f = await fixture(t, selection);
    const draft = { task: 'Send this exact draft once.' };
    const expectedTask = draft.task;
    f.app.subscribe(event => {
      if (event.type === 'history.recovery' && event.progress.phase === 'started')
        draft.task = 'A later edit must not replace the submitted draft.';
    }, error => assert.fail(error));
    const options = {};
    const pending = f.app.submit(draft, options);
    draft.task = 'A synchronous edit after submit must not replace the accepted draft.';
    options.delivery = 'steer';
    options.expectedRunId = 'not-the-current-run';
    const accepted = await pending;
    assert.notEqual(accepted.kind, 'rejected');
    const result = await accepted.completion;
    assert.equal(result.state, 'ended');
    assert.equal(result.terminal.executionStatus, 'completed');
    assert.equal(f.provider.requests.length, 1);
    assert.equal(f.app.state().status, 'ready');
    assert.equal(f.app.state().mode, 'review');
    assert.equal(f.app.state().provider, f.provider.id);
    assert.equal(f.app.state().model, 'writing-test');
    assert.equal(f.events.filter(event => event.phase === 'started').length, 2);
    assert.equal(f.events.filter(event => event.phase === 'completed').length, 1);
    const inputs = (await f.app.readHistory()).entries.filter(entry => entry.type === 'input');
    assert.equal(inputs.filter(entry => entry.task === expectedTask).length, 1);
    assert.equal(inputs.filter(entry => entry.task === draft.task).length, 0);
    assert.deepEqual((await readFile(f.file)).subarray(0, f.original.length), f.original);
  });
}

test('cancelling a writing submission during startup recovery leaves the draft unaccepted and allows one later submission', integration, async t => {
  const f = await fixture(t);
  const draft = { task: 'Keep this draft until recovery completes.' };
  const snapshot = structuredClone(draft);
  const unsubscribe = f.app.subscribe(event => {
    if (event.type === 'history.recovery' && event.progress.phase === 'progress' && event.progress.records >= 1)
      void f.app.abort();
  }, error => assert.fail(error));
  await assert.rejects(f.app.submit(draft), error => error.name === 'AbortError');
  unsubscribe();
  assert.deepEqual(draft, snapshot);
  assert.equal(f.provider.requests.length, 0);
  assert.deepEqual(await readFile(f.file), f.original);
  assert.equal(await readFile(f.index, 'utf8'), 'old derived index\n');
  const accepted = await f.app.submit(draft);
  assert.notEqual(accepted.kind, 'rejected');
  assert.equal((await accepted.completion).terminal.executionStatus, 'completed');
  assert.equal(f.provider.requests.length, 1);
  assert.equal((await f.app.readHistory()).entries.filter(entry => entry.type === 'input' && entry.task === draft.task).length, 1);
});

test('closing during a writing startup retry cancels recovery and rejects a queued draft without executing either', integration, async t => {
  const f = await fixture(t);
  let closing;
  f.app.subscribe(event => {
    if (event.type === 'history.recovery' && event.progress.phase === 'started')
      closing = f.app.close();
  }, error => assert.fail(error));
  const first = f.app.submit({ task: 'First unsent draft.' });
  const second = f.app.submit({ task: 'Second unsent draft.' });
  const results = await Promise.allSettled([first, second]);
  await closing;
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[0].reason.name, 'AbortError');
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /closed/u);
  assert.equal(f.app.state().status, 'closed');
  assert.equal(f.provider.requests.length, 0);
  assert.deepEqual(await readFile(f.file), f.original);
  assert.equal(await readFile(f.index, 'utf8'), 'old derived index\n');
});

test('failed provider setup after recovery reports configuration required without accepting the draft', integration, async t => {
  const f = await fixture(t, true);
  f.provider.describeModel = async () => { throw new Error('Provider credentials are unavailable.'); };
  const draft = { task: 'Do not accept this without credentials.' };
  await assert.rejects(f.app.submit(draft), /credentials are unavailable/u);
  assert.equal(f.app.state().status, 'configuration_required');
  assert.equal(f.provider.requests.length, 0);
  assert.deepEqual(await readFile(f.file), f.original);
});

async function terminal(t, app) {
  const { createMemoryTerminalHost } = await import('@ismail-elkorchi/terminal-ui/host');
  const { createTuiRuntime } = await import('@ismail-elkorchi/terminal-ui/tui');
  const { createWritingAgentTuiApp } = await import('@ismail-elkorchi/writing-agent/tui');
  const runtime = createTuiRuntime({
    host: createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 32 } }),
    app: createWritingAgentTuiApp(app, {
      // The real event-driven terminal leaves startup cancelled until the next action.
      events: { id: 'test-writing-events', generation: 1, run: ({ signal }) => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })) }
    })
  });
  const detach = app.subscribe(event => {
    if (event.type === 'run.completed') return runtime.dispatch({ type: 'result', result: event.result });
    if (event.type === 'run.progress') return runtime.dispatch({ type: 'progress', runId: event.runId, event: event.event });
    if (event.type === 'application.state.changed') return runtime.dispatch({ type: 'application', state: event.state });
    if (event.type === 'history.recovery') return runtime.dispatch(event);
  }, error => assert.fail(error));
  t.after(async () => { detach(); await runtime.dispose(); });
  await runtime.start();
  return runtime;
}

for (const selection of [false, true]) {
  test(`normal Enter retries cancelled writing startup and clears the accepted draft with ${selection ? 'model selection' : 'supplied configuration'}`, integration, async t => {
    const { textDocumentText } = await import('@ismail-elkorchi/terminal-ui/text');
    const { waitForState } = await import('../../test-helpers/tui-runtime.js');
    const f = await fixture(t, selection);
    const runtime = await terminal(t, f.app);
    const task = 'Send after cancelling startup.';
    await runtime.dispatch({ type: 'composer.edit', transition: { kind: 'edit', operation: { kind: 'insert', text: task } } });
    await runtime.handleInput({ kind: 'key', key: 'enter', eventType: 'press', location: 'standard', modifiers: { ctrl: false, alt: false, shift: false, meta: false } });
    await waitForState(runtime, t.signal, () => runtime.state().result !== undefined && !runtime.state().submitting);
    assert.equal(runtime.state().application.sessionId, 'selected');
    assert.equal(runtime.state().overlay.kind, 'none');
    assert.equal(textDocumentText(runtime.state().composer.input.document), '');
    assert.equal(f.provider.requests.length, 1);
    assert.equal((await f.app.readHistory()).entries.filter(entry => entry.type === 'input' && entry.task === task).length, 1);
  });
}

for (const navigate of [false, true]) {
  test(`a startup submission receipt preserves ${navigate ? 'another selected conversation draft' : 'a later edit to the submitted draft'}`, integration, async t => {
    const { textDocumentText } = await import('@ismail-elkorchi/terminal-ui/text');
    const { waitForState } = await import('../../test-helpers/tui-runtime.js');
    const f = await fixture(t);
    const submit = f.app.submit.bind(f.app);
    const release = Promise.withResolvers();
    const accepted = Promise.withResolvers();
    t.after(() => release.resolve());
    f.app.submit = async (...args) => {
      const receipt = await submit(...args);
      assert.notEqual(receipt.kind, 'rejected');
      assert.equal(receipt.sessionId, 'selected');
      await receipt.completion;
      accepted.resolve(receipt);
      await release.promise;
      return receipt;
    };
    const runtime = await terminal(t, f.app);
    const task = 'A draft belonging to its own conversation.';
    await runtime.dispatch({ type: 'composer.edit', transition: { kind: 'edit', operation: { kind: 'insert', text: task } } });
    await runtime.dispatch({ type: 'submit' });
    await accepted.promise;
    await waitForState(runtime, t.signal, () => runtime.state().history.at(-1)?.boundary.sessionId === 'selected');
    let expected = task + ' A later edit.';
    if (navigate) {
      await f.app.newSession();
      const other = f.app.state().sessionId;
      assert.notEqual(other, 'selected');
      await runtime.dispatch({ type: 'refresh' });
      await waitForState(runtime, t.signal, () => runtime.state().history.at(-1)?.boundary.sessionId === other);
      // Identical text in another conversation is still a different unsent draft.
      expected = task;
    }
    await runtime.dispatch({ type: 'composer.edit', transition: { kind: 'edit', operation: { kind: 'insert', text: navigate ? task : ' A later edit.' } } });
    release.resolve();
    await waitForState(runtime, t.signal, () => !runtime.state().submitting);
    assert.equal(textDocumentText(runtime.state().composer.input.document), expected);
    assert.equal(f.provider.requests.length, 1);
    if (navigate) assert.equal(textDocumentText(runtime.state().sessionViews.selected.composer.input.document), '');
  });
}

test('navigation during a writing startup submission preserves the draft and initializes its supplied model selection', integration, async t => {
  const { textDocumentText } = await import('@ismail-elkorchi/terminal-ui/text');
  const { waitForState } = await import('../../test-helpers/tui-runtime.js');
  const f = await fixture(t, true);
  const runtime = await terminal(t, f.app);
  const task = 'Keep this unsent draft when I change conversations.';
  const navigating = Promise.withResolvers();
  let navigation;
  f.app.subscribe(event => {
    if (event.type === 'history.recovery' && event.progress.phase === 'started') {
      navigation = f.app.newSession();
      navigating.resolve();
    }
  }, error => assert.fail(error));
  await runtime.dispatch({ type: 'composer.edit', transition: { kind: 'edit', operation: { kind: 'insert', text: task } } });
  await runtime.dispatch({ type: 'submit' });
  await navigating.promise;
  await navigation;
  const destination = f.app.state().sessionId;
  assert.notEqual(destination, 'selected');
  await runtime.dispatch({ type: 'refresh' });
  await waitForState(runtime, t.signal, () => !runtime.state().submitting && runtime.state().history.at(-1)?.boundary.sessionId === destination);
  assert.equal(textDocumentText(runtime.state().composer.input.document), task);
  assert.doesNotMatch(runtime.state().notice, /abort|cancel|recover|index/iu);
  assert.equal(f.app.state().model, 'writing-test');
  assert.equal(f.app.state().mode, 'review');
  assert.equal(f.provider.requests.length, 0);
  assert.deepEqual(await readFile(f.file), f.original);
  assert.equal(await readFile(f.index, 'utf8'), 'old derived index\n');
  await runtime.handleInput({ kind: 'key', key: 'enter', eventType: 'press', location: 'standard', modifiers: { ctrl: false, alt: false, shift: false, meta: false } });
  await waitForState(runtime, t.signal, () => runtime.state().result !== undefined && !runtime.state().submitting);
  assert.equal(f.provider.requests.length, 1);
  assert.equal(runtime.state().application.sessionId, destination);
  assert.equal(textDocumentText(runtime.state().composer.input.document), '');
});

for (const method of ['readHistory', 'searchHistory', 'readHistoryEntry', 'inspectContext']) {
  test(`close drains an admitted ${method} before releasing writing session resources`, integration, async t => {
    const f = await fixture(t);
    await f.app.start();
    const originalPage = await f.app.readHistory();
    const repositoryMethod = { readHistory: 'readBranchPage', searchHistory: 'searchBranch', readHistoryEntry: 'readBranchEntry', inspectContext: 'inspect' }[method];
    const prototype = method === 'inspectContext' ? ContextService.prototype : JsonlSessionRepository.prototype;
    const read = prototype[repositoryMethod];
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    t.after(() => release.resolve());
    t.mock.method(prototype, repositoryMethod, async function(...args) {
      entered.resolve();
      await release.promise;
      return read.apply(this, args);
    });
    const args = method === 'searchHistory' ? [{ query: 'Earlier' }]
      : method === 'readHistoryEntry' ? [originalPage.boundary, originalPage.entries[0].id] : [];
    const reading = f.app[method](...args);
    await entered.promise;
    let closed = false;
    const closing = f.app.close().then(() => { closed = true; });
    try {
      await setImmediate();
      assert.equal(closed, false, 'close must await the admitted repository read');
      assert.throws(() => f.app.readHistory(), /closed/u);
    } finally { release.resolve(); }
    await reading;
    await closing;
    assert.equal(closed, true);
  });
}

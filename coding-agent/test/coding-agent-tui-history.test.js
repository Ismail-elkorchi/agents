import { waitForState } from '../../tui/test/helpers/runtime.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySessionRepository } from '@agent-core/runtime';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { createCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';

async function open(t, options) {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 48, rows: 22 } });
  const runtime = createTuiRuntime({
    host,
    app: createCodingAgentTuiApp('', options),
    initialFocus: { kind: 'element', elementId: 'composer' }
  });
  t.after(() => runtime.dispose());
  await runtime.start();
  return runtime;
}

test(
  'bounded page cache browses and searches a branch beyond 512 entries and 2 MiB',
  { timeout: 60_000 },
  async (t) => {
    const repository = new InMemorySessionRepository();
    const session = await repository.create({
      binding: { schemaId: 'test/history', schemaVersion: 1, subject: {} }
    });
    const entries = [];
    for (let i = 0; i < 700; i++)
      entries.push(
        await repository.appendInput(session, {
          runId: `run-${i}`,
          task: `${i === 0 ? 'UNLOADED_MATCH' : `Input ${i}`}\n${'文 '.repeat(1500)}`
        })
      );
    assert(Buffer.byteLength(JSON.stringify(entries)) > 2 * 1024 * 1024);
    const read = async (request) => ({
      history: await repository.readBranchPage(session, { ...request, limit: 8, maxBytes: 64 * 1024 }),
      handoffs: []
    });
    const latest = await read();
    const runtime = await open(t, {
      historyReader: read,
      historySearcher: (request) => repository.searchBranch(session, request),
      initialHydration: {
        ...latest,
        session: {
          sessionId: session.id,
          phase: 'idle',
          queuedInputs: 0,
          configuration: { provider: 'test', model: 'test' }
        },
        branchPoints: [],
        pendingSubmissions: [],
        runs: []
      }
    });
    const seen = new Set();
    for (;;) {
      for (const page of runtime.state().conversation.pages)
        for (const entry of page.history.entries) seen.add(entry.id);
      assert(runtime.state().conversation.pages.length <= 3);
      assert(runtime.state().conversation.items.length <= 24);
      if (!runtime.state().conversation.pages[0].history.older) break;
      const previous = new Map(runtime.state().conversation.items.map((entry) => [entry.id, entry]));
      await runtime.dispatch({ type: 'history.load', direction: 'older' });
      await waitForState(runtime, t.signal, () => runtime.state().conversation.loading === undefined);
      for (const entry of runtime.state().conversation.items)
        if (previous.has(entry.id)) assert.equal(entry, previous.get(entry.id));
    }
    assert.equal(seen.size, 700);
    await runtime.dispatch({ type: 'history.load', direction: 'tail' });
    await waitForState(runtime, t.signal, () => runtime.state().conversation.loading === undefined);
    await runtime.dispatch({ type: 'overlay.open', overlay: 'search' });
    await runtime.dispatch({
      type: 'search.transition',
      transition: { kind: 'setQuery', query: { text: 'UNLOADED_MATCH', mode: 'contains' } }
    });
    await waitForState(
      runtime,
      t.signal,
      () => runtime.state().overlay.kind === 'search' && runtime.state().overlay.result !== undefined
    );
    assert.equal(runtime.state().overlay.result.matches[0].entryId, entries[0].id);
    assert.equal(runtime.state().overlay.result.older, undefined);
    await runtime.dispatch({ type: 'search.accept', event: { kind: 'accept', id: entries[0].id } });
    await waitForState(runtime, t.signal, () => runtime.state().overlay.kind === 'none');
    assert.equal(runtime.state().conversation.items[0].id, 'input:run-0');
    assert.match(renderFramePlain(runtime.frame()), /UNLOADED_MATCH/);
    assert.equal(runtime.state().conversation.scroll.followTail, false);
    const historical = runtime.state().conversation.items;
    await runtime.dispatch({
      type: 'progress',
      event: {
        type: 'assistant.delta',
        turnId: 'live',
        turnIndex: 1,
        requestAttempt: 1,
        delta: 'New',
        accumulated: 'New'
      }
    });
    assert.deepEqual(runtime.state().conversation.items, historical);
    assert.equal(runtime.state().conversation.unread, true);
  }
);

test(
  'queued edits bind the observed input and preserve the instruction draft on rejection',
  { timeout: 60_000 },
  async (t) => {
    const submission = {
      submissionId: 'queued',
      runId: 'run-queued',
      state: 'queued',
      input: { task: 'Old instruction' },
      configuration: { provider: 'test', model: 'test' }
    };
    const calls = [];
    const runtime = await open(t, {
      navigation: {
        readPendingSubmissions: async () => [submission],
        updateQueuedSubmission: async (...args) => {
          calls.push(args);
          throw new Error('Input was already claimed');
        }
      }
    });
    await runtime.dispatch({ type: 'composer.restore', text: 'Unsent draft' });
    await runtime.dispatch({ type: 'panel.open', panel: 'queue' });
    await waitForState(runtime, t.signal, () => runtime.state().overlay.kind === 'panel');
    await runtime.dispatch({ type: 'panel.accept', id: submission.submissionId });
    await runtime.dispatch({
      type: 'panel.text',
      transition: { kind: 'edit', operation: { kind: 'insert', text: ' revised' } }
    });
    await runtime.dispatch({ type: 'panel.queue-save' });
    await waitForState(
      runtime,
      t.signal,
      () => runtime.state().overlay.kind === 'queue_edit' && !runtime.state().overlay.saving
    );
    assert.deepEqual(calls[0], [
      'queued',
      { kind: 'replace', expectedInput: submission.input, input: { task: ' revisedOld instruction' } }
    ]);
    assert.equal(textDocumentText(runtime.state().overlay.input.document), ' revisedOld instruction');
    assert.equal(textDocumentText(runtime.state().composer.input.document), 'Unsent draft');
  }
);

test(
  'session bookmarks restore drafts and source positions; recovery hydration preserves a paused viewport',
  { timeout: 60_000 },
  async (t) => {
    const repository = new InMemorySessionRepository();
    const first = await repository.create({
      binding: { schemaId: 'test/bookmark', schemaVersion: 1, subject: {} }
    });
    const second = await repository.create({
      binding: { schemaId: 'test/bookmark-second', schemaVersion: 1, subject: {} }
    });
    for (let i = 0; i < 24; i++)
      await repository.appendInput(first, { runId: `first-${i}`, task: `Input ${i}` });
    await repository.appendInput(second, { runId: 'second', task: 'Second session' });
    let selected = first;
    const read = async (request) => ({
      history: await repository.readBranchPage(selected, { ...request, limit: 4 }),
      handoffs: []
    });
    const view = async () => ({
      ...(await read()),
      session: {
        sessionId: selected.id,
        phase: 'idle',
        queuedInputs: 0,
        configuration: { provider: 'test', model: 'test' }
      },
      branchPoints: [],
      pendingSubmissions: [],
      runs: []
    });
    const runtime = await open(t, { historyReader: read, initialHydration: await view() });
    await runtime.dispatch({ type: 'composer.restore', text: 'First draft' });
    await runtime.dispatch({ type: 'history.load', direction: 'older' });
    await waitForState(runtime, t.signal, () => runtime.state().conversation.loading === undefined);
    const ids = runtime.state().conversation.items.map((entry) => entry.id);
    const anchor =
      runtime.state().conversation.anchor ??
      runtime.state().presentation.anchor(runtime.state().conversation.scroll.offsetRow);
    await repository.appendInput(first, { runId: 'later', task: 'Arrived while browsing' });
    await runtime.dispatch({ type: 'session.hydrated', hydration: await view() });
    assert.deepEqual(
      runtime.state().conversation.items.map((entry) => entry.id),
      ids
    );
    assert.equal(runtime.state().conversation.unread, true);
    selected = second;
    await runtime.dispatch({ type: 'session.hydrated', hydration: await view() });
    assert.equal(textDocumentText(runtime.state().composer.input.document), '');
    await runtime.dispatch({ type: 'composer.restore', text: 'Second draft' });
    selected = first;
    await runtime.dispatch({ type: 'session.hydrated', hydration: await view() });
    await waitForState(runtime, t.signal, () => runtime.state().conversation.loading === undefined);
    assert.equal(textDocumentText(runtime.state().composer.input.document), 'First draft');
    assert.equal(runtime.state().conversation.scroll.followTail, false);
    assert.deepEqual(
      runtime.state().conversation.anchor ??
        runtime.state().presentation.anchor(runtime.state().conversation.scroll.offsetRow),
      anchor
    );
    assert(runtime.state().conversation.items.some((entry) => entry.id === anchor.itemId));
    assert.equal(
      textDocumentText(runtime.state().sessionViews[second.id].composer.input.document),
      'Second draft'
    );
  }
);

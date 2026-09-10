import { waitForState } from '../../tui/test/helpers/runtime.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySessionRepository } from '@agent-core/runtime';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { createWritingAgentTuiApp } from '@ismail-elkorchi/writing-agent/tui';

test(
  'writing browses bounded history and finds unloaded original inputs while live output preserves position and draft',
  { timeout: 60_000 },
  async (t) => {
    const repository = new InMemorySessionRepository();
    const session = await repository.create({
      binding: { schemaId: 'test/writing-history', schemaVersion: 1, subject: {} }
    });
    const entries = [];
    for (let i = 0; i < 700; i++)
      entries.push(
        await repository.appendInput(session, {
          runId: `run-${i}`,
          task: `${i === 0 ? 'EARLIEST_PASSAGE' : `Instruction ${i}`}\n${'文 '.repeat(1500)}`
        })
      );
    const state = { projectId: 'project', sessionId: session.id, status: 'ready' };
    const application = {
      state: () => state,
      readSession: async () => ({ session: { sessionId: session.id, phase: 'idle' }, runs: [] }),
      start: async () => {},
      readProject: async () => ({ snapshot: { resources: [], sources: [] }, operations: [], proposals: [] }),
      readHistory: (request) => repository.readBranchPage(session, { ...request, limit: 8, maxBytes: 64000 }),
      searchHistory: (request) => repository.searchBranch(session, request)
    };
    const host = createMemoryTerminalHost({ terminalSize: { columns: 48, rows: 24 } });
    const runtime = createTuiRuntime({ host, app: createWritingAgentTuiApp(application) });
    t.after(() => runtime.dispose());
    await runtime.start();
    await waitForState(runtime, t.signal, () => runtime.state().history.length === 1);
    await runtime.dispatch({ type: 'view', view: 'conversation' });
    await runtime.dispatch({
      type: 'composer.edit',
      transition: { kind: 'edit', operation: { kind: 'insert', text: 'An unsent instruction.' } }
    });
    const seen = new Set();
    for (;;) {
      const value = runtime.state();
      for (const page of value.history) for (const entry of page.entries) seen.add(entry.id);
      assert(value.history.length <= 3);
      if (value.history[0].older === undefined) break;
      const previous = value.history[0].entries[0].id;
      await runtime.dispatch({ type: 'history.load', direction: 'older' });
      await waitForState(runtime, t.signal, () => runtime.state().history[0].entries[0].id !== previous);
    }
    assert.equal(seen.size, 700);
    await runtime.dispatch({ type: 'history.load', direction: 'tail' });
    await waitForState(runtime, t.signal, () => runtime.state().followTail);
    await runtime.dispatch({ type: 'search.open' });
    await runtime.dispatch({
      type: 'search.edit',
      transition: { kind: 'edit', operation: { kind: 'insert', text: 'EARLIEST_PASSAGE' } }
    });
    await runtime.dispatch({ type: 'search.submit', more: false });
    await waitForState(
      runtime,
      t.signal,
      () => runtime.state().overlay.kind === 'search' && runtime.state().overlay.result !== undefined
    );
    assert.equal(runtime.state().overlay.result.matches[0].entryId, entries[0].id);
    await runtime.dispatch({ type: 'search.jump', entryId: entries[0].id });
    await waitForState(runtime, t.signal, () => runtime.state().overlay.kind === 'none');
    assert.match(renderFramePlain(runtime.frame()), /EARLIEST_PASSAGE/);
    const history = runtime.state().history;
    const anchor = runtime.state().conversationAnchor;
    await repository.appendInput(session, { runId: 'new-run', task: 'New accepted instruction' });
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
    await runtime.dispatch({ type: 'refresh' });
    await waitForState(runtime, t.signal, () => runtime.state().unread);
    assert.equal(runtime.state().history, history);
    assert.deepEqual(runtime.state().conversationAnchor, anchor);
    assert.equal(textDocumentText(runtime.state().composer.document), 'An unsent instruction.');
  }
);

test(
  'switching writing sessions restores drafts and historical anchors without retaining inactive pages',
  { timeout: 60_000 },
  async (t) => {
    const repository = new InMemorySessionRepository();
    const first = await repository.create({
      binding: { schemaId: 'test/writing-bookmark', schemaVersion: 1, subject: {} }
    });
    const second = await repository.create({
      binding: { schemaId: 'test/bookmark-second', schemaVersion: 1, subject: {} }
    });
    for (let i = 0; i < 20; i++)
      await repository.appendInput(first, { runId: `first-${i}`, task: `Instruction ${i}` });
    let selected = first;
    const application = {
      state: () => ({ projectId: 'project', sessionId: selected.id, status: 'ready' }),
      readSession: async () => ({ session: { sessionId: selected.id, phase: 'idle' }, runs: [] }),
      start: async () => {},
      readProject: async () => ({ snapshot: { resources: [], sources: [] }, operations: [], proposals: [] }),
      readHistory: (request) => repository.readBranchPage(selected, { ...request, limit: 4 })
    };
    const host = createMemoryTerminalHost({ terminalSize: { columns: 48, rows: 24 } });
    const runtime = createTuiRuntime({ host, app: createWritingAgentTuiApp(application) });
    t.after(() => runtime.dispose());
    await runtime.start();
    await waitForState(runtime, t.signal, () => runtime.state().history.length > 0);
    await runtime.dispatch({
      type: 'composer.edit',
      transition: { kind: 'edit', operation: { kind: 'insert', text: 'First draft' } }
    });
    await runtime.dispatch({ type: 'view', view: 'conversation' });
    await runtime.dispatch({ type: 'history.load', direction: 'older' });
    await waitForState(runtime, t.signal, () => runtime.state().historyRequestId === undefined);
    const anchor = runtime.state().conversationAnchor;
    selected = second;
    await runtime.dispatch({ type: 'refresh' });
    await waitForState(runtime, t.signal, () => runtime.state().history[0].boundary.sessionId === second.id);
    assert.equal(textDocumentText(runtime.state().composer.document), '');
    await runtime.dispatch({
      type: 'composer.edit',
      transition: { kind: 'edit', operation: { kind: 'insert', text: 'Second draft' } }
    });
    selected = first;
    await runtime.dispatch({ type: 'refresh' });
    await waitForState(
      runtime,
      t.signal,
      () =>
        runtime.state().history[0].boundary.sessionId === first.id &&
        runtime.state().historyRequestId === undefined
    );
    assert.equal(textDocumentText(runtime.state().composer.document), 'First draft');
    assert.deepEqual(runtime.state().conversationAnchor, anchor);
    assert.equal(runtime.state().followTail, false);
    assert.equal(runtime.state().view, 'conversation');
    assert.equal('history' in runtime.state().sessionViews[second.id], false);
  }
);

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { InMemorySessionRepository } from '@agent-core/runtime';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { createWritingAgentTuiApp } from '@ismail-elkorchi/writing-agent/tui';

async function settle(host, condition, signal) {
  while (!condition()) {
    host.clock.advance(0);
    await setTimeout(0, undefined, { signal });
  }
}

test(
  'writing resource picker prepares against one owned index and fences close/reopen',
  { timeout: 20_000 },
  async (t) => {
    const repository = new InMemorySessionRepository();
    const session = await repository.create({
      binding: { schemaId: 'test/writing-picker', schemaVersion: 1, subject: {} }
    });
    const state = { workspace: '/workspace', mode: 'edit', sessionId: session.id, status: 'ready' };
    const application = {
      state: () => state,
      start: async () => {},
      readSession: async () => ({
        session: {
          sessionId: session.id,
          phase: 'idle',
          configuration: { provider: 'fixture', model: 'fixture' },
          queuedInputs: 0
        },
        runs: []
      }),
      readHistory: (request) => repository.readBranchPage(session, request),
      listDocuments: async () =>
        Array.from({ length: 512 }, (_, i) => ({ path: `document-${i}.txt`, type: 'file' }))
    };
    const host = createMemoryTerminalHost({ terminalSize: { columns: 80, rows: 24 } });
    const sleep = host.clock.sleep.bind(host.clock);
    let failQuery = false;
    host.clock.sleep = async (ms, signal) => {
      if (failQuery && ms === 0) throw new Error('Fixture query failure');
      return sleep(ms, signal);
    };
    const runtime = createTuiRuntime({ host, app: createWritingAgentTuiApp(application) });
    t.after(() => runtime.dispose());
    await runtime.start();
    failQuery = true;
    await runtime.dispatch({ type: 'picker.open', subject: 'resources' });
    await settle(host, () => runtime.state().overlay.kind === 'picker', t.signal);
    const index = runtime.state().overlay.searchPickerIndex;
    await settle(host, () => runtime.state().overlay.query.error !== null, t.signal);
    failQuery = false;
    assert.match(renderFramePlain(runtime.frame()), /Fixture query failure/);

    for (const text of ['document-1', 'document-2'])
      await runtime.dispatch({
        type: 'picker.transition',
        transition: { kind: 'setQuery', query: { text } }
      });
    await settle(host, () => !runtime.state().overlay.query.pending, t.signal);
    const ready = runtime.state().overlay;
    assert.equal(ready.searchPickerIndex, index);
    assert.equal(ready.query.result.searchPickerIndex, index);
    assert.equal(ready.picker.editor.activeId, ready.query.result.entries[0].id);
    assert.equal(ready.query.result.query.text, 'document-2');
    await runtime.dispatch({ type: 'overlay.close' });
    await runtime.dispatch({ type: 'picker.open', subject: 'resources' });
    await settle(host, () => runtime.state().overlay.kind === 'picker', t.signal);
    const reopened = runtime.state().overlay;
    await runtime.dispatch({
      type: 'picker.query',
      id: ready.id,
      message: { kind: 'ready', revision: reopened.query.revision, result: ready.query.result }
    });
    assert.notEqual(runtime.state().overlay.query.result, ready.query.result);
    await runtime.dispatch({ type: 'overlay.close' });
    assert.equal(runtime.state().overlay.kind, 'none');
  }
);

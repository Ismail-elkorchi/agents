import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { createDraft } from '@agent-core/tui';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { createCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';

async function settle(host, condition, signal) {
  while (!condition()) {
    host.clock.advance(0);
    await setTimeout(0, undefined, { signal });
  }
}

test(
  'navigation picker preserves its index across rapid edits and fences removed instances',
  { timeout: 20_000 },
  async (t) => {
    const host = createMemoryTerminalHost({ terminalSize: { columns: 80, rows: 24 } });
    const sleep = host.clock.sleep.bind(host.clock);
    let failQuery = false;
    host.clock.sleep = async (ms, signal) => {
      if (failQuery && ms === 0) throw new Error('Fixture query failure');
      return sleep(ms, signal);
    };
    const runtime = createTuiRuntime({
      host,
      app: createCodingAgentTuiApp('', {
        navigation: {
          async listSessions() {
            return Array.from({ length: 512 }, (_, i) => ({
              id: `session-${i}`,
              preview: `Session ${i}`,
              updatedAt: ''
            }));
          }
        }
      })
    });
    t.after(() => runtime.dispose());
    await runtime.start();
    await runtime.dispatch({ type: 'panel.open', panel: 'sessions' });
    await settle(host, () => runtime.state().overlay.kind === 'panel', t.signal);
    const index = runtime.state().overlay.searchPickerIndex;
    await settle(host, () => !runtime.state().overlay.query.pending, t.signal);
    assert.equal(runtime.state().overlay.query.error, null, 'empty queries use retained source order');
    failQuery = true;
    await runtime.dispatch({
      type: 'panel.transition',
      transition: { kind: 'setQuery', query: { text: 'Session' } }
    });
    await settle(host, () => runtime.state().overlay.query.error !== null, t.signal);
    failQuery = false;
    assert.match(renderFramePlain(runtime.frame()), /Fixture query failure/);

    for (const text of ['Session 1', 'Session 2'])
      await runtime.dispatch({
        type: 'panel.transition',
        transition: { kind: 'setQuery', query: { text } }
      });
    await settle(host, () => !runtime.state().overlay.query.pending, t.signal);
    const ready = runtime.state().overlay;
    assert.equal(ready.searchPickerIndex, index);
    assert.equal(ready.query.result.searchPickerIndex, index);
    assert.equal(ready.picker.editor.activeId, ready.query.result.entryAt(0).id);
    assert.equal(ready.query.result.query.text, 'Session 2');
    await runtime.dispatch({ type: 'overlay.close' });
    await runtime.dispatch({ type: 'panel.open', panel: 'sessions' });
    await settle(host, () => runtime.state().overlay.kind === 'panel', t.signal);
    const reopened = runtime.state().overlay;
    assert.notEqual(reopened.id, ready.id);
    await runtime.dispatch({
      type: 'panel.query',
      id: ready.id,
      message: { kind: 'ready', revision: reopened.query.revision, result: ready.query.result }
    });
    assert.notEqual(runtime.state().overlay.query.result, ready.query.result);
    await runtime.dispatch({ type: 'overlay.close' });
    assert.equal(runtime.state().overlay.kind, 'none');
  }
);

test(
  'prompt recall delivers cooperative results and ignores completions after reopening',
  { timeout: 20_000 },
  async (t) => {
    const host = createMemoryTerminalHost({ terminalSize: { columns: 80, rows: 24 } });
    const runtime = createTuiRuntime({ host, app: createCodingAgentTuiApp('Keep my draft') });
    t.after(() => runtime.dispose());
    await runtime.start();
    await runtime.dispatch({ type: 'recall.open' });
    const id = runtime.state().overlay.state.id;
    await runtime.dispatch({
      type: 'recall.loaded',
      id,
      drafts: Array.from({ length: 512 }, (_, i) => createDraft(`Prompt ${i}`))
    });
    const index = runtime.state().overlay.state.searchPickerIndex;
    await runtime.dispatch({
      type: 'recall.transition',
      transition: { kind: 'setQuery', query: { text: 'Prompt 3' } }
    });
    await settle(host, () => !runtime.state().overlay.state.query.pending, t.signal);
    const ready = runtime.state().overlay.state;
    assert.equal(ready.searchPickerIndex, index);
    assert.equal(ready.query.result.query.text, 'Prompt 3');
    await runtime.dispatch({ type: 'overlay.close' });
    await runtime.dispatch({ type: 'recall.open' });
    const reopened = runtime.state().overlay.state;
    await runtime.dispatch({
      type: 'recall.query',
      id,
      message: { kind: 'ready', revision: reopened.query.revision, result: ready.query.result }
    });
    assert.notEqual(runtime.state().overlay.state.query.result, ready.query.result);
    assert.equal(textDocumentText(runtime.state().composer.input.document), 'Keep my draft');
  }
);

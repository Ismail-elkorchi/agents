import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { createCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';
import { waitForState } from '../../test-helpers/tui-runtime.js';

for (const oversized of [false, true])
  test(
    `history search displays ${oversized ? 'an unsearched original' : 'a matched original whose excerpt omits the query'}`,
    { timeout: 10000 },
    async (t) => {
      const host = createMemoryTerminalHost({ terminalSize: { columns: 90, rows: 28 } });
      const runtime = createTuiRuntime({
        host,
        app: createCodingAgentTuiApp('', {
          historySearcher: async () => ({
            boundary: { sessionId: 'fixture', leafId: 'entry' },
            matches: oversized ? [] : [{ entryId: 'entry', excerpt: 'A bounded excerpt' }],
            ...(oversized ? { oversizedEntry: { entryId: 'entry', bytes: 4_000_000 } } : {})
          })
        })
      });
      t.after(() => runtime.dispose());
      await runtime.start();
      await runtime.dispatch({ type: 'overlay.open', overlay: 'search' });
      await runtime.dispatch({
        type: 'search.transition',
        transition: { kind: 'edit', operation: { kind: 'insert', text: 'original query' } }
      });
      await waitForState(
        runtime,
        t.signal,
        () =>
          runtime.state().overlay.kind === 'search' && runtime.state().overlay.result !== undefined
      );
      assert.match(
        renderFramePlain(runtime.frame()),
        oversized ? /Not searched.*inspect entry/ : /A bounded excerpt/
      );
    }
  );

test(
  'history search keyboard selection opens an unsearched original and Escape closes it',
  { timeout: 10000 },
  async (t) => {
    const host = createMemoryTerminalHost({ terminalSize: { columns: 90, rows: 28 } });
    const runtime = createTuiRuntime({
      host,
      app: createCodingAgentTuiApp('', {
        historySearcher: async () => ({
          boundary: { sessionId: 'fixture', leafId: 'entry' },
          matches: [],
          oversizedEntry: { entryId: 'entry', bytes: 4_000_000 }
        })
      })
    });
    t.after(() => runtime.dispose());
    await runtime.start();
    const raw = async (data) => {
      const batch = await runtime.handleInputChunk({ data });
      host.clock.advance(100);
      await batch.pending;
    };
    await runtime.dispatch({
      type: 'application.state.changed',
      state: {
        status: 'ready',
        requirements: [],
        runtimeDetails: {},
        session: {
          sessionId: 'fixture',
          phase: 'idle',
          queuedInputs: 0,
          configuration: { provider: 'fixture', model: 'fixture' }
        }
      }
    });
    await runtime.dispatch({ type: 'overlay.open', overlay: 'search' });
    await raw('original query');
    await waitForState(
      runtime,
      t.signal,
      () =>
        runtime.state().overlay.kind === 'search' && runtime.state().overlay.result !== undefined
    );
    await raw('\r');
    await waitForState(runtime, t.signal, () => runtime.state().overlay.kind === 'inspector');
    assert.equal(runtime.state().overlay.state.state.selected.entry.entryId, 'entry');
    await raw('\x1b');
    await waitForState(runtime, t.signal, () => runtime.state().overlay.kind === 'none');
  }
);

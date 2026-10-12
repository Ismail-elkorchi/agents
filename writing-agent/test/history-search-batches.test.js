import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySessionRepository } from '@agent-core/runtime';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { createWritingAgentTuiApp } from '@ismail-elkorchi/writing-agent/tui';
import { waitForState } from '../../test-helpers/tui-runtime.js';

test('writing exposes each bounded empty search batch and only continues on request', { timeout: 10000 }, async t => {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ binding: { schemaId: 'test/writing-search-batch', schemaVersion: 1, subject: {} } });
  const boundary = { sessionId: session.id, leafId: null };
  const cursor = { boundary, entryId: 'older', query: 'needle' };
  let calls = 0;
  const work = { metadataVisited: 0, scannedBytes: 1, indexed: 1, indexBytes: 1, postings: 1, candidates: 1, bytes: 1 };
  const application = {
    state: () => ({ workspace: '/workspace', mode: 'review', sessionId: session.id, status: 'ready' }),
    start: async () => {},
    readSession: async () => ({ toolDiagnostics: [], runs: [], session: {
      sessionId: session.id, phase: 'idle', configuration: { provider: 'fixture', model: 'fixture' }, queuedInputs: 0
    } }),
    readHistory: request => repository.readBranchPage(session, request),
    searchHistory: async request => {
      calls++;
      assert(request.signal instanceof AbortSignal);
      if (calls === 1) return { boundary, matches: [], older: cursor, coverage: 'partial', ...work };
      assert.deepEqual(request.cursor, cursor);
      return { boundary, matches: [{ entryId: 'older', excerpt: 'needle' }], coverage: 'complete', ...work };
    }
  };
  const runtime = createTuiRuntime({ host: createMemoryTerminalHost({ terminalSize: { columns: 90, rows: 28 } }),
    app: createWritingAgentTuiApp(application) });
  t.after(() => runtime.dispose());
  await runtime.start();
  await waitForState(runtime, t.signal, () => runtime.state().history.length > 0);
  await runtime.dispatch({ type: 'search.open' });
  await runtime.dispatch({ type: 'search.edit', transition: { kind: 'edit', operation: { kind: 'insert', text: 'needle' } } });
  await runtime.dispatch({ type: 'search.submit', more: false });
  await waitForState(runtime, t.signal, () => runtime.state().overlay.result !== undefined);
  assert.equal(calls, 1);
  assert.match(renderFramePlain(runtime.frame()), /More history remains/);
  await runtime.dispatch({ type: 'search.submit', more: true });
  await waitForState(runtime, t.signal, () => runtime.state().overlay.result.matches.length === 1);
  assert.equal(calls, 2);
});

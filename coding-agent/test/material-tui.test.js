import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySessionRepository } from '@agent-core/runtime';
import { createCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';
import { createWritingAgentTuiApp } from '@ismail-elkorchi/writing-agent/tui';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { waitForState } from '../../test-helpers/tui-runtime.js';

for (const kind of ['coding', 'writing']) test(`${kind} retained-material panel owns its session and ignores closed child messages`, { timeout: 20000 }, async t => {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ id: 'root-session', binding: { schemaId: 'test/material', schemaVersion: 1, subject: {} } });
  const rootState = { sessionId: session.id, phase: 'idle', queuedInputs: 0, configuration: { provider: 'fixture', model: 'fixture' } };
  const owner = { kind: 'scope', scopeId: 'person:alex' };
  const ref = { owner, itemId: 'preference', revisionId: 'exact-v2' };
  const service = {
    currentSessionOwner: async () => ({ kind: 'session', sessionId: session.id, branchId: session.id }),
    listScopes: async () => ({ items: [{ owner, read: true, write: true, revision: 'grant-1' }], coverage: 'complete' }),
    list: async () => ({ items: [{ ...ref, preview: 'Prefers quiet places' }], coverage: 'complete', revocationRevision: 0 }),
    read: async target => { assert.deepEqual(target, ref); return { ...ref, text: 'Prefers quiet places, depending on the occasion.' }; }
  };
  const operations = { materialService: expectedSessionId => { assert.equal(expectedSessionId, session.id); return service; } };
  const hydration = { session: rootState, history: await repository.readBranchPage(session), pendingSubmissions: [], runs: [], toolDiagnostics: [], changes: [], verification: [], branchPoints: [] };
  const app = kind === 'coding' ? createCodingAgentTuiApp('', { materials: operations, initialHydration: hydration })
    : createWritingAgentTuiApp({ ...operations,
      state: () => ({ sessionId: session.id, workspace: '/workspace', mode: 'review', status: 'ready' }),
      modelSelection: () => ({ provider: 'fixture', model: 'fixture' }),
      readSession: async () => hydration,
      readHistory: () => repository.readBranchPage(session), readPendingSubmissions: async () => []
    });
  const runtime = createTuiRuntime({ host: createMemoryTerminalHost({ terminalSize: { columns: 110, rows: 36 } }), app });
  t.after(() => runtime.dispose());
  await runtime.start();
  await runtime.dispatch({ type: 'material.open' });
  await waitForState(runtime, t.signal, () => runtime.state().overlay.kind === 'material' && !runtime.state().overlay.state.state.pending);
  assert.match(renderFramePlain(runtime.frame()), /person:alex/);
  const child = message => ({ type: 'material.child', child: { id: runtime.state().overlay.state.id, generation: runtime.state().overlay.state.generation, message } });
  await runtime.dispatch(child({ type: 'choose', owner }));
  await waitForState(runtime, t.signal, () => !runtime.state().overlay.state.state.pending);
  await runtime.dispatch(child({ type: 'read', ref }));
  await waitForState(runtime, t.signal, () => !runtime.state().overlay.state.state.pending);
  assert.match(renderFramePlain(runtime.frame()), /depending on the occasion/);
  const stale = child({ type: 'body', ref, body: { ...ref, text: 'STALE_PRIVATE_BODY' } });
  await runtime.dispatch({ type: 'overlay.close' });
  assert.equal(runtime.state().overlay.kind, 'none');
  await runtime.dispatch({ type: 'material.open' });
  await waitForState(runtime, t.signal, () => !runtime.state().overlay.state.state.pending);
  await runtime.dispatch(stale);
  assert.equal(runtime.state().overlay.state.state.body, undefined);
  assert.doesNotMatch(renderFramePlain(runtime.frame()), /STALE_PRIVATE_BODY/);
});

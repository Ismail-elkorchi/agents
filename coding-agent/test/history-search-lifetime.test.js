import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySessionRepository } from '@agent-core/runtime';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { createCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';
import { createWritingAgentTuiApp } from '@ismail-elkorchi/writing-agent/tui';
import { waitForState } from '../../test-helpers/tui-runtime.js';

async function fixture(t, kind) {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({
    binding: { schemaId: 'test/search', schemaVersion: 1, subject: {} }
  });
  await repository.appendInput(session, { runId: 'first', task: 'MATCH ONE' });
  await repository.appendInput(session, { runId: 'second', task: 'MATCH TWO' });
  const page = await repository.readBranchPage(session);
  const pending = Promise.withResolvers();
  let block = false;
  let started = false;
  let searches = 0;
  const read = async (request) => {
    if (block) {
      started = true;
      await pending.promise;
    }
    return repository.readBranchPage(session, request);
  };
  const search = (request) => {
    searches += 1;
    return repository.searchBranch(session, request);
  };
  const sessionView = {
    toolDiagnostics: [],
    runs: [],
    session: {
      sessionId: session.id,
      phase: 'idle',
      queuedInputs: 0,
      configuration: { provider: 'fixture', model: 'fixture' }
    }
  };
  const app =
    kind === 'coding'
      ? createCodingAgentTuiApp('', {
          initialHydration: {
            ...sessionView,
            history: page,
            branchPoints: [],
            pendingSubmissions: [],
            changes: [],
            verification: []
          },
          historyReader: async (request) => ({
            history: await read(request),
            changes: [],
            verification: []
          }),
          historySearcher: search
        })
      : createWritingAgentTuiApp({
          state: () => ({
            workspace: '/workspace',
            mode: 'review',
            status: 'ready',
            sessionId: session.id
          }),
          start: async () => {},
          readSession: async () => sessionView,
          readHistory: read,
          searchHistory: search
        });
  const host = createMemoryTerminalHost({ terminalSize: { columns: 90, rows: 28 } });
  const runtime = createTuiRuntime({ app, host });
  t.after(() => {
    pending.resolve();
    return runtime.dispose();
  });
  const settle = () => waitForState(runtime, t.signal, () => runtime.metrics().effects.owned === 0);
  const raw = async (data) => {
    const batch = await runtime.handleInputChunk({ data });
    host.clock.advance(100);
    await batch.pending;
    await settle();
  };
  const open = () =>
    runtime.dispatch(
      kind === 'coding' ? { type: 'overlay.open', overlay: 'search' } : { type: 'search.open' }
    );
  const edit = (value) =>
    runtime.dispatch(
      kind === 'coding'
        ? { type: 'search.transition', transition: { kind: 'setText', value } }
        : {
            type: 'search.edit',
            transition: { kind: 'edit', operation: { kind: 'insert', text: value || 'new query' } }
          }
    );
  await runtime.start();
  await settle();
  await open();
  await runtime.dispatch(
    kind === 'coding'
      ? { type: 'search.transition', transition: { kind: 'setText', value: 'MATCH' } }
      : {
          type: 'search.edit',
          transition: { kind: 'edit', operation: { kind: 'insert', text: 'MATCH' } }
        }
  );
  if (kind === 'writing') await runtime.dispatch({ type: 'search.submit', more: false });
  await settle();
  const firstMatch = runtime.state().overlay.result.matches[0].entryId;
  return {
    runtime,
    settle,
    raw,
    open,
    edit,
    searches: () => searches,
    block: () => {
      block = true;
    },
    started: () => waitForState(runtime, t.signal, () => started),
    release: () => pending.resolve(),
    jump: () =>
      runtime.dispatch(
        kind === 'coding'
          ? { type: 'search.accept', event: { kind: 'commit', id: firstMatch } }
          : { type: 'search.jump', entryId: firstMatch }
      )
  };
}

for (const kind of ['coding', 'writing']) {
  for (const action of ['replace', 'edit'])
    test(
      `${kind} cancels an obsolete history jump after ${action}`,
      { timeout: 10000 },
      async (t) => {
        const f = await fixture(t, kind);
        if (action === 'replace') {
          await f.jump();
          await f.settle();
        }
        f.block();
        if (action === 'replace')
          await f.runtime.dispatch({ type: 'search.adjacent', direction: 'next' });
        else await f.jump();
        await f.started();
        if (action === 'replace')
          await f.runtime.dispatch(
            kind === 'coding'
              ? { type: 'overlay.open', overlay: 'help' }
              : {
                  type: 'source.loaded',
                  title: 'Keep this panel',
                  content: 'Independent information'
                }
          );
        else await f.edit('');
        const overlay = f.runtime.state().overlay;
        f.release();
        await f.settle();
        assert.equal(f.runtime.state().overlay, overlay);
      }
    );
}

test(
  'writing search lets Enter activate the focused result instead of submitting another search',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, 'writing');
    for (
      let i = 0;
      i < 5 && !f.runtime.frame().focusPath.some((id) => id.startsWith('writing-search-result:'));
      i++
    )
      await f.raw('\t');
    assert(f.runtime.frame().focusPath.some((id) => id.startsWith('writing-search-result:')));
    const searches = f.searches();
    await f.raw('\r');
    assert.equal(f.runtime.state().overlay.kind, 'none');
    assert.equal(f.searches(), searches);
  }
);

test(
  'writing search preserves its results while moving the query caret',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, 'writing');
    const result = f.runtime.state().overlay.result;
    assert(result.matches.length > 0);
    await f.raw('\x1b[D');
    assert.equal(f.runtime.state().overlay.result, result);
    assert.equal(f.searches(), 1);
  }
);

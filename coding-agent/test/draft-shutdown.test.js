import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySessionRepository } from '@agent-core/runtime';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { runTui } from '@ismail-elkorchi/terminal-ui/tui';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { createCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';
import { createWritingAgentTuiApp } from '@ismail-elkorchi/writing-agent/tui';
import { createTestEventSource } from './helpers/event-source.js';
import { waitFor, latestFramePlain } from './coding-agent-tui-test-helpers.js';

for (const kind of ['coding', 'writing'])
  for (const synchronous of [false, true])
    test(
      `${kind} shutdown saves other session drafts after a ${synchronous ? 'synchronous' : 'rejected'} write failure`,
      { timeout: 10000 },
      async (t) => {
        const repository = new InMemorySessionRepository();
        const binding = { schemaId: 'test/drafts', schemaVersion: 1, subject: {} };
        const first = await repository.create({ binding });
        const second = await repository.create({ binding });
        let selected = first;
        const attempts = [];
        const failure = new Error('An earlier session draft could not be saved.');
        const drafts = {
          read: async () => undefined,
          write(sessionId, draft) {
            attempts.push([sessionId, textDocumentText(draft.input.document)]);
            if (sessionId !== first.id) return Promise.resolve();
            if (synchronous) throw failure;
            return Promise.reject(failure);
          }
        };
        const state = () => ({
          status: 'ready', workspace: '/workspace', mode: 'review', sessionId: selected.id
        });
        const view = async () => ({
          history: await repository.readBranchPage(selected),
          session: {
            sessionId: selected.id,
            phase: 'idle',
            queuedInputs: 0,
            configuration: { provider: 'test', model: 'test' }
          },
          toolDiagnostics: [], changes: [], verification: [],
          branchPoints: [], pendingSubmissions: [], runs: []
        });
        const events = createTestEventSource();
        const host = createMemoryTerminalHost({ terminalSize: { columns: 90, rows: 28 } });
        const app = kind === 'coding'
          ? createCodingAgentTuiApp('', { drafts, eventSource: events, initialHydration: await view() })
          : createWritingAgentTuiApp({ state }, { drafts, events });
        const running = runTui(app, { host }).then(result => ({ result }), error => ({ error }));
        t.after(async () => { host.endInput(); await running; });
        await waitFor(() => host.frames().length > 0);
        const load = async () => {
          const hydration = await view();
          await events.enqueue(kind === 'coding'
            ? { type: 'session.hydrated', hydration }
            : { type: 'loaded', application: state(), history: hydration.history, session: hydration });
        };
        const edit = text => events.enqueue(kind === 'coding'
          ? { type: 'composer.restore', text }
          : { type: 'composer.edit', transition: { kind: 'edit', operation: { kind: 'insert', text } } });
        await load();
        await edit('Unsent work from the first session');
        await waitFor(() => latestFramePlain(host).includes('Unsent work from the first session'));
        selected = second;
        await load();
        await edit('The active instruction must survive');
        await waitFor(() => latestFramePlain(host).includes('The active instruction must survive'));
        await events.enqueue({ type: kind === 'coding' ? 'application.exit' : 'exit' });
        const outcome = await running;
        assert(outcome.error, 'Shutdown must report the failed draft write.');
        assert.deepEqual(attempts, [
          [first.id, 'Unsent work from the first session'],
          [second.id, 'The active instruction must survive']
        ]);
      }
    );

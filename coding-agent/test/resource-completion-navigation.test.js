import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySessionRepository } from '@agent-core/runtime';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { createCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';
import { createWritingAgentTuiApp } from '@ismail-elkorchi/writing-agent/tui';
import { waitForState } from '../../test-helpers/tui-runtime.js';

for (const kind of ['coding', 'writing'])
  test(`${kind} navigates quoted resource scopes and inserts their selected file`, { timeout: 10000 }, async (t) => {
    const repository = new InMemorySessionRepository();
    const session = await repository.create({
      binding: { schemaId: 'test/resource-navigation', schemaVersion: 1, subject: {} }
    });
    const history = await repository.readBranchPage(session);
    const view = {
      session: {
        sessionId: session.id, phase: 'idle', queuedInputs: 0,
        configuration: { provider: 'test', model: 'test' }
      },
      runs: [], toolDiagnostics: []
    };
    const reads = [];
    const app = kind === 'coding'
      ? createCodingAgentTuiApp('', {
          initialHydration: {
            ...view, history, changes: [], verification: [], branchPoints: [], pendingSubmissions: []
          },
          resources: {
            async search(query) {
              reads.push(query);
              return query === ''
                ? [{ id: 'folder', label: 'Draft notes', reference: 'draft notes/', continueSearch: true }]
                : [{ id: 'file', label: 'Chapter one', reference: 'draft notes/chapter"one.md' }];
            }
          }
        })
      : createWritingAgentTuiApp({
          state: () => ({ status: 'ready', workspace: '/workspace', mode: 'review', sessionId: session.id }),
          start: async () => {},
          readSession: async () => view,
          readHistory: async () => history,
          async listDocuments(directory) {
            reads.push(directory);
            return directory === '.'
              ? [{ path: 'draft notes', type: 'directory' }]
              : [{ path: 'draft notes/chapter"one.md', type: 'file' }];
          }
        });
    const host = createMemoryTerminalHost({ terminalSize: { columns: 90, rows: 28 } });
    const runtime = createTuiRuntime({ app, host });
    t.after(() => runtime.dispose());
    const settle = () => waitForState(runtime, t.signal, () => runtime.metrics().effects.owned === 0);
    const raw = async data => {
      const batch = await runtime.handleInputChunk({ data });
      host.clock.advance(100);
      await batch.pending;
      await settle();
    };
    await runtime.start();
    await settle();
    await raw('@');
    assert.equal(runtime.state().resourceCompletion?.phase, 'ready');
    await raw('\r');
    assert.equal(textDocumentText(runtime.state().composer.input.document), '@"draft notes/"');
    assert.equal(runtime.state().resourceCompletion?.query, 'draft notes/');
    await raw('c');
    assert.equal(runtime.state().resourceCompletion?.query, 'draft notes/c');
    await raw('\r');
    assert.equal(textDocumentText(runtime.state().composer.input.document), '@"draft notes/chapter\\"one.md" ');
    assert.equal(runtime.state().resourceCompletion, undefined);
    assert.deepEqual(reads, kind === 'coding' ? ['', 'draft notes/', 'draft notes/c'] : ['.', 'draft notes', 'draft notes']);
  });

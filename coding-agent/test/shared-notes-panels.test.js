import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySessionRepository } from '@agent-core/runtime';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { createCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';
import { createWritingAgentTuiApp } from '@ismail-elkorchi/writing-agent/tui';
import { waitFor } from './coding-agent-tui-test-helpers.js';

for (const agent of ['coding', 'writing'])
  test(`${agent} notes close, replacement and reopen fence pending work`, async (t) => {
    const repository = new InMemorySessionRepository();
    const session = await repository.create({
      binding: { schemaId: 'notes-test', schemaVersion: 1, subject: {} }
    });
    const reads = [];
    const reader = {
      listNotes: () => new Promise((resolve) => reads.push(resolve)),
      readNote: async () => {
        throw new Error('Unexpected note content request');
      }
    };
    const application = {
      ...reader,
      state: () => ({
        workspace: '/workspace',
        mode: 'edit',
        sessionId: session.id,
        status: 'ready'
      }),
      start: async () => {},
      readHistory: () => repository.readBranchPage(session),
      readSession: async () => ({
        session: {
          sessionId: session.id,
          phase: 'idle',
          configuration: { provider: 'fixture', model: 'fixture' },
          queuedInputs: 0
        },
        runs: []
      })
    };
    const host = createMemoryTerminalHost({ terminalSize: { columns: 80, rows: 24 } });
    const runtime = createTuiRuntime({
      host,
      app:
        agent === 'coding'
          ? createCodingAgentTuiApp('', { navigation: reader })
          : createWritingAgentTuiApp(application)
    });
    t.after(() => runtime.dispose());
    await runtime.start();
    if (agent === 'writing') await waitFor(() => runtime.state().history.length > 0);
    await runtime.dispatch({ type: 'notes.open' });
    await waitFor(() => reads.length === 1);
    const first = runtime.state().overlay.state;
    assert.match(renderFramePlain(runtime.frame()), /Reading model-authored notes/);
    await runtime.dispatch({ type: 'overlay.close' });
    assert.equal(runtime.state().overlay.kind, 'none');
    await runtime.dispatch({ type: 'notes.open' });
    await waitFor(() => reads.length === 2);
    const second = runtime.state().overlay.state;
    assert.notEqual(first.generation, second.generation);
    const page = { items: [], coverage: 'complete' };
    await runtime.dispatch({
      type: 'notes.child',
      child: {
        id: first.id,
        generation: first.generation,
        message: {
          type: 'notes.failed',
          requestId: first.state.requestId,
          message: 'Stale failure'
        }
      }
    });
    assert.equal(runtime.state().overlay.state.state.error, undefined);
    reads[0](page);
    reads[1](page);
    await waitFor(() => runtime.state().overlay.state.state.page !== undefined);
    assert.equal(runtime.state().overlay.state.generation, second.generation);
    await runtime.dispatch({
      type: 'notes.child',
      child: { id: second.id, generation: second.generation, message: { type: 'notes.close' } }
    });
    assert.equal(runtime.state().overlay.kind, 'none');
    await runtime.dispatch({ type: 'notes.open' });
    await waitFor(() => reads.length === 3);
    await runtime.dispatch({ type: 'preferences.open' });
    reads[2](page);
    await runtime.dispatch({ type: 'terminal.resized' });
    assert.equal(runtime.state().overlay.kind, 'preferences');
  });

for (const agent of ['coding', 'writing'])
  for (const fails of [false, true])
    test(`${agent} hidden queue ${fails ? 'failure' : 'withdrawal'} settles once and releases child`, async (t) => {
      const repository = new InMemorySessionRepository();
      const session = await repository.create({
        binding: { schemaId: 'queue-test', schemaVersion: 1, subject: {} }
      });
      const submission = {
        submissionId: 'queued',
        runId: 'run',
        state: 'queued',
        input: { task: 'Keep the complete draft' }
      };
      const mutations = [];
      let complete;
      const operations = {
        readPendingSubmissions: async () => [submission],
        updateQueuedSubmission: (...args) => {
          mutations.push(args);
          return new Promise((resolve, reject) => {
            complete = fails ? () => reject(new Error('Input already claimed')) : resolve;
          });
        }
      };
      const application = {
        ...operations,
        state: () => ({
          workspace: '/workspace',
          mode: 'edit',
          sessionId: session.id,
          status: 'ready'
        }),
        start: async () => {},
        readHistory: () => repository.readBranchPage(session),
        readSession: async () => ({
          session: {
            sessionId: session.id,
            phase: 'idle',
            configuration: { provider: 'fixture', model: 'fixture' },
            queuedInputs: 0
          },
          runs: []
        })
      };
      const recovered = [];
      const drafts = {
        read: async () => undefined,
        write: async () => {},
        recover: async (id, draft) => recovered.push({ id, draft })
      };
      const runtime = createTuiRuntime({
        host: createMemoryTerminalHost({ terminalSize: { columns: 80, rows: 24 } }),
        app:
          agent === 'coding'
            ? createCodingAgentTuiApp('', { navigation: operations, drafts })
            : createWritingAgentTuiApp(application, { drafts })
      });
      t.after(() => runtime.dispose());
      await runtime.start();
      if (agent === 'writing') await waitFor(() => runtime.state().history.length > 0);
      await runtime.dispatch({ type: 'queue.open' });
      await waitFor(() => runtime.state().queuePanel?.state.stage === 'list');
      const child = runtime.state().queuePanel;
      const dispatchQueue = (message) =>
        runtime.dispatch({
          type: 'queue.child',
          child: { id: child.id, generation: child.generation, message }
        });
      await dispatchQueue({ type: 'queue.select', submissionId: submission.submissionId });
      await dispatchQueue({ type: 'queue.withdraw' });
      await waitFor(() => mutations.length === 1);
      await runtime.dispatch({ type: 'overlay.close' });
      assert.equal(runtime.state().overlay.kind, 'none');
      assert.equal(runtime.state().queuePanel.state.stage, 'saving');
      await runtime.dispatch({ type: 'queue.open' });
      assert.equal(runtime.state().queuePanel.generation, child.generation);
      await dispatchQueue({ type: 'queue.withdraw' });
      assert.equal(mutations.length, 1);
      await runtime.dispatch({ type: 'overlay.close' });
      complete();
      await waitFor(() => runtime.state().queuePanel === undefined);
      if (fails) {
        assert.equal(recovered.length, 0);
        assert.match(
          agent === 'coding'
            ? runtime
                .state()
                .conversation.items.map((entry) => entry.text ?? '')
                .join('\n')
            : runtime.state().notice,
          /Input already claimed/
        );
      } else {
        await waitFor(() => recovered.length === 1);
        assert.equal(recovered[0].draft.input.document !== undefined, true);
        assert.deepEqual(mutations[0], [
          'queued',
          { kind: 'cancel', expectedInput: submission.input }
        ]);
      }
      await dispatchQueue({
        type: 'queue.withdrawn',
        id: child.state.id,
        sessionId: session.id,
        input: submission.input
      });
      assert.equal(recovered.length, fails ? 0 : 1);
    });

for (const agent of ['coding', 'writing'])
  test(`${agent} configuration replacement fences an earlier discovery`, async (t) => {
    const repository = new InMemorySessionRepository();
    const session = await repository.create({
      binding: { schemaId: 'configuration-test', schemaVersion: 1, subject: {} }
    });
    const discoveries = [];
    const selection = { provider: 'openai', model: '' };
    const operations = {
      providers: [{ id: 'openai', label: 'OpenAI' }],
      current: () => selection,
      connect: () => new Promise((resolve) => discoveries.push(resolve)),
      save: async () => {}
    };
    const application = {
      state: () => ({
        workspace: '/workspace',
        mode: 'edit',
        sessionId: session.id,
        status: 'ready'
      }),
      start: async () => {},
      modelSelection: () => selection,
      connectProvider: operations.connect,
      readHistory: () => repository.readBranchPage(session),
      readSession: async () => ({
        session: {
          sessionId: session.id,
          phase: 'idle',
          configuration: { provider: 'fixture', model: 'fixture' },
          queuedInputs: 0
        },
        runs: []
      })
    };
    const runtime = createTuiRuntime({
      host: createMemoryTerminalHost({ terminalSize: { columns: 80, rows: 24 } }),
      app:
        agent === 'coding'
          ? createCodingAgentTuiApp('', { configuration: operations })
          : createWritingAgentTuiApp(application)
    });
    t.after(() => runtime.dispose());
    await runtime.start();
    if (agent === 'writing') await waitFor(() => runtime.state().history.length > 0);
    await runtime.dispatch({ type: 'configuration.open' });
    const first = runtime.state().overlay.state;
    await runtime.dispatch({
      type: 'configuration.child',
      child: {
        id: first.id,
        generation: first.generation,
        message: { type: 'configuration.pick', value: 'openai' }
      }
    });
    await waitFor(() => discoveries.length === 1);
    await runtime.dispatch({ type: 'overlay.close' });
    await runtime.dispatch({ type: 'configuration.open' });
    const second = runtime.state().overlay.state;
    discoveries[0]({ listModels: async () => [] });
    await runtime.dispatch({
      type: 'configuration.child',
      child: {
        id: first.id,
        generation: first.generation,
        message: { type: 'configuration.saved', id: first.state.id }
      }
    });
    assert.equal(runtime.state().overlay.state.generation, second.generation);
    assert.equal(runtime.state().overlay.state.state.pending, undefined);
    assert.equal(runtime.state().overlay.state.state.adapter, undefined);
    await runtime.dispatch({
      type: 'configuration.child',
      child: {
        id: second.id,
        generation: second.generation,
        message: { type: 'configuration.close' }
      }
    });
    assert.equal(runtime.state().overlay.kind, 'none');
  });

for (const agent of ['coding', 'writing'])
  test(`${agent} source inspection preserves session boundaries and ignores dismissed reads`, async (t) => {
    const repository = new InMemorySessionRepository();
    const session = await repository.create({
      binding: { schemaId: 'inspection-test', schemaVersion: 1, subject: {} }
    });
    const entry = await repository.appendInput(session, {
      runId: 'run',
      task: 'Original source\r\n文'
    });
    const page = await repository.readBranchPage(session);
    const reference = {
      kind: 'reference',
      id: 'reference',
      boundary: page.boundary,
      entryId: entry.id,
      bytes: 100
    };
    const reads = [];
    const read = (...args) => new Promise((resolve) => reads.push({ args, resolve }));
    const sessionState = {
      sessionId: session.id,
      phase: 'idle',
      configuration: { provider: 'fixture', model: 'fixture' },
      queuedInputs: 0
    };
    const application = {
      state: () => ({
        workspace: '/workspace',
        mode: 'edit',
        sessionId: session.id,
        status: 'ready'
      }),
      start: async () => {},
      readHistory: () => repository.readBranchPage(session),
      readSession: async () => ({ session: sessionState, runs: [] }),
      readHistoryEntry: read
    };
    const runtime = createTuiRuntime({
      host: createMemoryTerminalHost({ terminalSize: { columns: 80, rows: 24 } }),
      app:
        agent === 'coding'
          ? createCodingAgentTuiApp('', { historyEntryReader: read })
          : createWritingAgentTuiApp(application)
    });
    t.after(() => runtime.dispose());
    await runtime.start();
    if (agent === 'writing') await waitFor(() => runtime.state().history.length > 0);
    else
      await runtime.dispatch({
        type: 'application.state.changed',
        state: { status: 'ready', requirements: [], runtimeDetails: {}, session: sessionState }
      });
    await runtime.dispatch({
      type: 'history.inspect',
      reference: { ...reference, boundary: { ...reference.boundary, sessionId: 'other-session' } }
    });
    assert.equal(runtime.state().overlay.kind, 'none');
    await runtime.dispatch({ type: 'history.inspect', reference });
    const first = runtime.state().overlay.state;
    await runtime.dispatch({
      type: 'inspector.child',
      child: { id: first.id, generation: first.generation, message: { type: 'inspector.read' } }
    });
    await waitFor(() => reads.length === 1);
    assert.deepEqual(reads[0].args, [reference.boundary, reference.entryId]);
    await runtime.dispatch({ type: 'overlay.close' });
    await runtime.dispatch({ type: 'history.inspect', reference });
    const second = runtime.state().overlay.state;
    reads[0].resolve(entry);
    await runtime.dispatch({
      type: 'inspector.child',
      child: {
        id: first.id,
        generation: first.generation,
        message: { type: 'inspector.notice', message: 'Stale notice' }
      }
    });
    assert.equal(runtime.state().overlay.state.generation, second.generation);
    assert.equal(runtime.state().overlay.state.state.notice, undefined);
    assert.equal(runtime.state().overlay.state.state.selected.entry.kind, 'reference');
  });

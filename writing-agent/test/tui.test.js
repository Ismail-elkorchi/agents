import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { createWritingAgentTuiApp } from '@ismail-elkorchi/writing-agent/tui';
import { waitForState } from '../../test-helpers/tui-runtime.js';
import { fixture, patchResponse } from './helpers/runtime.js';

for (const columns of [48, 120])
  test(
    `writing TUI accepts a direct request without project setup at ${columns} columns`,
    {
      skip: process.platform !== 'linux',
      timeout: 30_000
    },
    async (t) => {
      const f = await fixture('Old line.\n', {
        responses: [
          patchResponse(
            '*** Begin Patch\n*** Update File: document.txt\n@@\n-Old line.\n+New line.\n*** End Patch'
          ),
          'Updated.'
        ]
      });
      const host = createMemoryTerminalHost({ terminalSize: { columns, rows: 32 } });
      const runtime = createTuiRuntime({ host, app: createWritingAgentTuiApp(f.application) });
      const unsubscribe = f.application.subscribe(
        (event) => {
          if (event.type === 'run.completed')
            return runtime.dispatch({ type: 'result', result: event.result });
          if (event.type === 'run.progress')
            return runtime.dispatch({ type: 'progress', runId: event.runId, event: event.event });
          if (event.type === 'application.state.changed')
            return runtime.dispatch({ type: 'application', state: event.state });
        },
        (error) => {
          throw error;
        }
      );
      t.after(async () => {
        unsubscribe();
        await runtime.dispose();
        await f.close();
      });
      await runtime.start();
      await waitForState(runtime, t.signal, () => runtime.state().history.length > 0);
      assert.equal(runtime.state().document, undefined);
      await runtime.dispatch({
        type: 'composer.edit',
        transition: {
          kind: 'edit',
          operation: { kind: 'insert', text: 'Replace Old line. with New line. in document.txt.' }
        }
      });
      await runtime.dispatch({ type: 'submit' });
      await waitForState(runtime, t.signal, () => runtime.state().result !== undefined);
      assert.equal(runtime.state().result.terminal.executionStatus, 'completed');
      assert.equal(textDocumentText(runtime.state().composer.input.document), '');
      assert.equal((await f.application.readDocument('document.txt')).content, 'New line.\n');
      await runtime.dispatch({ type: 'picker.open', subject: 'resources' });
      await waitForState(runtime, t.signal, () => runtime.state().overlay.kind === 'picker');
      await runtime.dispatch({ type: 'picker.accept', id: 'document.txt' });
      await waitForState(runtime, t.signal, () => runtime.state().document !== undefined);
      assert.match(renderFramePlain(runtime.frame()), /New line/);
      await runtime.dispatch({ type: 'mode.toggle' });
      await waitForState(runtime, t.signal, () => runtime.state().application.mode === 'review');
      assert.equal(runtime.state().application.status, 'ready');
    }
  );

test(
  'the document viewer attaches the selected passage without changing the instruction',
  {
    skip: process.platform !== 'linux',
    timeout: 30_000
  },
  async (t) => {
    const f = await fixture('Opening.\nA passage.\n');
    const host = createMemoryTerminalHost({ terminalSize: { columns: 80, rows: 32 } });
    const runtime = createTuiRuntime({ host, app: createWritingAgentTuiApp(f.application) });
    t.after(async () => {
      await runtime.dispose();
      await f.close();
    });
    await runtime.start();
    await waitForState(runtime, t.signal, () => runtime.state().history.length > 0);
    await runtime.dispatch({
      type: 'document.loaded',
      document: await f.application.readDocument('document.txt')
    });
    await runtime.dispatch({ type: 'document.toggle-source' });
    for (const operation of [
      { kind: 'moveLineDown' },
      { kind: 'moveHome' },
      { kind: 'moveEnd', extendSelection: true }
    ])
      await runtime.dispatch({ type: 'document.edit', transition: { kind: 'edit', operation } });
    await runtime.dispatch({ type: 'document.use-passage' });
    assert.equal(textDocumentText(runtime.state().composer.input.document), '');
    const attachment = runtime.state().composer.attachments[0];
    assert.equal(attachment.kind, 'context');
    assert.equal(attachment.item.content, 'A passage.');
    assert.equal(attachment.item.representation, 'excerpt');
  }
);

test(
  'provider interruptions leave a reviewable pending action and preserve the next instruction',
  { skip: process.platform !== 'linux', timeout: 30_000 },
  async (t) => {
    const f = await fixture('A short document.\n', {
      responses: [
        async () => {
          throw new Error('Provider connection closed');
        }
      ]
    });
    const app = f.application;
    const runtime = createTuiRuntime({
      host: createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 32 } }),
      app: createWritingAgentTuiApp(app)
    });
    const detach = app.subscribe(
      (event) => {
        if (event.type === 'run.completed')
          return runtime.dispatch({ type: 'result', result: event.result });
        if (event.type === 'run.progress')
          return runtime.dispatch({ type: 'progress', runId: event.runId, event: event.event });
        if (event.type === 'application.state.changed')
          return runtime.dispatch({ type: 'application', state: event.state });
      },
      (error) => {
        throw error;
      }
    );
    t.after(async () => {
      detach();
      await runtime.dispose();
      await f.close();
    });
    await runtime.start();
    await waitForState(runtime, t.signal, () => runtime.state().history.length > 0);
    const submission = await app.submit({ task: 'Review document.txt.' });
    const result = await submission.completion;
    assert.equal(result.state, 'suspended');
    await waitForState(
      runtime,
      t.signal,
      () => runtime.state().sessionView?.session.suspension !== undefined
    );
    assert.equal(runtime.state().overlay.kind, 'none');
    await runtime.dispatch({ type: 'recovery.open' });
    await waitForState(runtime, t.signal, () => runtime.state().overlay.kind === 'recovery');
    const frame = renderFramePlain(runtime.frame());
    assert.match(frame, /Response interrupted/);
    assert.match(frame, /Provider connection closed/);
    assert.match(frame, /Stop this run/);
    assert.match(frame, /Check for a recorded result/);
    await runtime.dispatch({
      type: 'composer.edit',
      transition: { kind: 'edit', operation: { kind: 'insert', text: 'Preserve this instruction' } }
    });
    await runtime.dispatch({ type: 'submit' });
    assert.equal(textDocumentText(runtime.state().composer.input.document), 'Preserve this instruction');
    await runtime.dispatch({ type: 'recovery.abort' });
    await waitForState(runtime, t.signal, () => runtime.state().overlay.kind === 'none');
  }
);

test(
  'failed admission releases the composer while preserving the exact unsent request',
  {
    skip: process.platform !== 'linux',
    timeout: 30_000
  },
  async (t) => {
    const f = await fixture('Document.\n');
    const host = createMemoryTerminalHost();
    f.application.submit = async () => {
      throw new Error('Credential expired. Sign in again.');
    };
    const runtime = createTuiRuntime({ host, app: createWritingAgentTuiApp(f.application) });
    t.after(async () => {
      await runtime.dispose();
      await f.close();
    });
    await runtime.start();
    await waitForState(runtime, t.signal, () => runtime.state().history.length > 0);
    await runtime.dispatch({
      type: 'composer.edit',
      transition: { kind: 'edit', operation: { kind: 'insert', text: 'Keep café 世界\nexact.\n' } }
    });
    const draft = runtime.state().composer;
    await runtime.dispatch({ type: 'submit' });
    await waitForState(runtime, t.signal, () => runtime.state().notice.includes('Credential expired'));
    assert.equal(runtime.state().submitting, false);
    assert.equal(runtime.state().composer, draft);
    assert.equal(
      runtime.state().liveConversation.some((entry) => entry.kind === 'user'),
      false
    );
  }
);

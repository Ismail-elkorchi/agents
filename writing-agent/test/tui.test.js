import { waitForState } from '../../tui/test/helpers/runtime.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { rm } from 'node:fs/promises';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { WritingApplication } from '@ismail-elkorchi/writing-agent';
import { createWritingAgentTuiApp } from '@ismail-elkorchi/writing-agent/tui';
import { fixture, passingChecker, ScriptedWritingProvider, revisionResponse } from './helpers/runtime.js';

const key = (name, modifiers = {}) => ({
  kind: 'key',
  key: name,
  eventType: 'press',
  location: 'standard',
  modifiers: { ctrl: false, alt: false, shift: false, meta: false, ...modifiers }
});

for (const columns of [48, 120])
  test(
    `document and passage interaction at ${columns} columns preserves acceptance and revision decisions`,
    { timeout: 60_000 },
    async (t) => {
      const f = await fixture('Opening.\n\nOld line.\n\nClosing.\n');
      const response = revisionResponse(f.resource.resourceId, 'New line.');
      const provider = new ScriptedWritingProvider([
        response,
        'Proposed.',
        response,
        'Proposed again.',
        response,
        'After undo.'
      ]);
      const app = new WritingApplication(f.project, {
        configuration: { provider, model: 'writing-test', editorialChecker: passingChecker }
      });
      const host = createMemoryTerminalHost({ terminalSize: { columns, rows: 32 } });
      const runtime = createTuiRuntime({ host, app: createWritingAgentTuiApp(app) });
      const detach = app.subscribe((event) => {
        if (event.type === 'operation.completed')
          return runtime.dispatch({ type: 'result', result: event.result });
        if (event.type === 'application.state.changed')
          return runtime.dispatch({ type: 'application', state: event.state });
        if (event.type === 'project.changed') return runtime.dispatch({ type: 'refresh' });
      });
      t.after(async () => {
        detach();
        await runtime.dispose();
        await app.close();
        await rm(f.parent, { recursive: true, force: true });
      });
      await runtime.start();
      await waitForState(runtime, t.signal, () => runtime.state().document !== undefined);
      await runtime.handleInput(key('f1'));
      assert.match(renderFramePlain(runtime.frame()), /Ctrl\+C\s+Copy selected source/);
      for (let page = 0; page < 3; page++) await runtime.handleInput(key('pageDown'));
      assert.match(renderFramePlain(runtime.frame()), /Ctrl\+O/);
      await runtime.handleInput(key('escape'));
      assert.equal(runtime.state().overlay.kind, 'none');
      await runtime.handleInput(key('f4'));
      await runtime.dispatch({
        type: 'document.edit',
        transition: { kind: 'edit', operation: { kind: 'moveLineDown' } }
      });
      await runtime.dispatch({
        type: 'document.edit',
        transition: { kind: 'edit', operation: { kind: 'moveLineDown' } }
      });
      await runtime.dispatch({
        type: 'document.edit',
        transition: { kind: 'edit', operation: { kind: 'moveEnd', extendSelection: true } }
      });
      await runtime.handleInput(key('f8'));
      assert.deepEqual(runtime.state().document.selectedRange, {
        start: { line: 3, column: 1 },
        end: { line: 3, column: 10 }
      });
      await runtime.handleInput({ kind: 'paste', text: 'Tighten this sentence.', bracketed: true });
      await runtime.handleInput(key('enter'));
      await waitForState(
        runtime,
        t.signal,
        () => runtime.state().result !== undefined && runtime.state().project.proposals.length === 1
      );
      assert.equal(textDocumentText(runtime.state().composer.document), '');
      await runtime.handleInput(key('f6'));
      await waitForState(runtime, t.signal, () => runtime.state().overlay.kind === 'picker');
      await runtime.handleInput(key('enter'));
      await waitForState(runtime, t.signal, () => runtime.state().proposal !== undefined);
      assert.equal(runtime.state().proposal.comparisons[0].after, 'Opening.\n\nNew line.\n\nClosing.\n');
      await runtime.dispatch({ type: 'proposal.reject' });
      await waitForState(runtime, t.signal, () => runtime.state().proposal.review.status === 'rejected');
      assert.equal(
        (await app.readDocument(f.resource.resourceId)).content,
        'Opening.\n\nOld line.\n\nClosing.\n'
      );
      await runtime.dispatch({
        type: 'composer.edit',
        transition: { kind: 'edit', operation: { kind: 'insert', text: 'Try it again.' } }
      });
      await runtime.dispatch({ type: 'submit' });
      await waitForState(runtime, t.signal, () => runtime.state().project.proposals.length === 2);
      await runtime.dispatch({ type: 'picker.open', subject: 'proposals' });
      await waitForState(runtime, t.signal, () => runtime.state().overlay.kind === 'picker');
      const proposalId = runtime
        .state()
        .project.proposals.find((proposal) => proposal.status === 'proposed').proposalId;
      await runtime.dispatch({ type: 'picker.accept', id: proposalId });
      await waitForState(
        runtime,
        t.signal,
        () => runtime.state().proposal.review.proposal.proposalId === proposalId
      );
      await runtime.dispatch({ type: 'proposal.accept' });
      await runtime.dispatch({ type: 'criterion.toggle', id: 'criterion-user-instruction' });
      await runtime.dispatch({ type: 'proposal.confirm-accept' });
      await waitForState(runtime, t.signal, () => runtime.state().proposal.review.status === 'accepted');
      assert.equal(runtime.state().proposal.review.authorization, undefined);
      await runtime.dispatch({ type: 'proposal.authorize' });
      await waitForState(
        runtime,
        t.signal,
        () => runtime.state().proposal.review.authorization !== undefined
      );
      await runtime.dispatch({ type: 'proposal.apply' });
      await waitForState(runtime, t.signal, () => runtime.state().proposal.review.status === 'applied');
      assert.equal(
        (await app.readDocument(f.resource.resourceId)).content,
        'Opening.\n\nNew line.\n\nClosing.\n'
      );
      await runtime.dispatch({ type: 'revision.undo' });
      await waitForState(runtime, t.signal, () => !runtime.state().busy);
      assert.equal(
        (await app.readDocument(f.resource.resourceId)).content,
        'Opening.\n\nOld line.\n\nClosing.\n'
      );
      const sessionId = app.state().sessionId;
      await runtime.dispatch({
        type: 'composer.edit',
        transition: { kind: 'edit', operation: { kind: 'insert', text: 'Continue after undo.' } }
      });
      await runtime.dispatch({ type: 'submit' });
      await waitForState(runtime, t.signal, () => runtime.state().project.proposals.length === 3);
      assert.equal(app.state().sessionId, sessionId);
      assert.equal(textDocumentText(runtime.state().composer.document), '');
    }
  );

test(
  'document source selection uses keyboard movement and copies the focused selection',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture('# Document\n\nOld line.\n');
    const app = new WritingApplication(f.project);
    const host = createMemoryTerminalHost({ terminalSize: { columns: 48, rows: 32 } });
    const runtime = createTuiRuntime({ host, app: createWritingAgentTuiApp(app) });
    t.after(async () => {
      await runtime.dispose();
      await app.close();
      await rm(f.parent, { recursive: true, force: true });
    });
    await runtime.start();
    await waitForState(runtime, t.signal, () => runtime.state().document !== undefined);
    await runtime.handleInput(key('f4'));
    await runtime.handleInput(key('arrowDown'));
    await runtime.handleInput(key('arrowDown'));
    await runtime.handleInput(key('home'));
    await runtime.handleInput(key('end', { shift: true }));
    await runtime.handleInput(key('c', { ctrl: true }));
    await waitForState(runtime, t.signal, () => runtime.state().notice === 'Source sent to clipboard.');
    assert(host.output().includes(`\x1b]52;c;${Buffer.from('Old line.').toString('base64')}\x07`));
    await runtime.handleInput(key('f8'));
    assert.deepEqual(runtime.state().document.selectedRange, {
      start: { line: 3, column: 1 },
      end: { line: 3, column: 10 }
    });
  }
);

test('provider interruptions open recovery with the actual failure and preserve the next instruction', { timeout: 30_000 }, async (t) => {
  const f = await fixture('A short document.\n');
  const provider = new ScriptedWritingProvider([async () => { throw new Error('Provider connection closed'); }]);
  const app = new WritingApplication(f.project, { configuration: { provider, model: 'writing-test', editorialChecker: passingChecker } });
  const runtime = createTuiRuntime({ host: createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 32 } }), app: createWritingAgentTuiApp(app) });
  const detach = app.subscribe(event => {
    if (event.type === 'operation.completed') return runtime.dispatch({ type: 'result', result: event.result });
    if (event.type === 'operation.progress') return runtime.dispatch({ type: 'progress', event: event.event });
    if (event.type === 'application.state.changed') return runtime.dispatch({ type: 'application', state: event.state });
  });
  t.after(async () => { detach(); await runtime.dispose(); await app.close(); await rm(f.parent, { recursive: true, force: true }); });
  await runtime.start();
  await waitForState(runtime, t.signal, () => runtime.state().document !== undefined);
  const document = await app.readDocument(f.resource.resourceId);
  const submission = await app.instruct({ kind: 'revise', instruction: 'Review this passage.', selection: document.selection });
  const result = await submission.completion;
  assert.equal(result.execution.state, 'suspended');
  await waitForState(runtime, t.signal, () => runtime.state().overlay.kind === 'recovery');
  const frame = renderFramePlain(runtime.frame());
  assert.match(frame, /Response interrupted/);
  assert.match(frame, /Provider connection closed/);
  assert.match(frame, /Stop this run/);
  assert.match(frame, /Check for a recorded result/);
  await runtime.dispatch({ type: 'composer.edit', transition: { kind: 'edit', operation: { kind: 'insert', text: 'Preserve this instruction' } } });
  await runtime.dispatch({ type: 'submit' });
  assert.equal(textDocumentText(runtime.state().composer.document), 'Preserve this instruction');
  await runtime.dispatch({ type: 'recovery.abort' });
  await waitForState(runtime, t.signal, () => runtime.state().overlay.kind === 'none');
});

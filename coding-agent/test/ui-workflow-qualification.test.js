import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { createUiWorkflowFixture } from '../../validation/ui-workflow-fixture.mjs';
import { waitForState } from '../../test-helpers/tui-runtime.js';

const key = (name, modifiers = {}) => ({ kind: 'key', key: name, eventType: 'press', location: 'standard',
  modifiers: { ctrl: false, alt: false, shift: false, meta: false, ...modifiers } });

for (const columns of [48, 120]) test(`review-to-question preserves the draft and exact evidence at ${columns} columns`, { timeout: 10_000 }, async (t) => {
  const fixture = await createUiWorkflowFixture();
  const host = createMemoryTerminalHost({ terminalSize: { columns, rows: 32 } });
  const runtime = createTuiRuntime({ host, app: fixture.app, initialFocus: { kind: 'element', elementId: 'composer' } });
  t.after(async () => { await runtime.dispose(); await fixture.close(); });
  await runtime.start();
  const draft = textDocumentText(runtime.state().composer.input.document);
  await runtime.dispatch({ type: 'overlay.open', overlay: 'help' });
  assert.match(renderFramePlain(runtime.frame()), /Keyboard|shortcut|help/i);
  await runtime.handleInput(key('escape'));
  assert.equal(textDocumentText(runtime.state().composer.input.document), draft);
  await runtime.dispatch({ type: 'panel.open', panel: 'changes' });
  await waitForState(runtime, t.signal, () => runtime.state().overlay.kind === 'panel');
  const item = runtime.state().overlay.items[0];
  assert.equal(item.kind, 'change');
  await runtime.dispatch({ type: 'panel.accept', id: item.id });
  await waitForState(runtime, t.signal, () => runtime.state().overlay.kind === 'source' && runtime.state().overlay.review?.evidence !== undefined);
  const requestId = runtime.state().overlay.review.requestId;
  await runtime.dispatch({ type: 'panel.review-hunk', requestId, direction: 'next' });
  const hunk = runtime.state().overlay.review.hunk;
  const evidence = runtime.state().overlay.review.evidence;
  assert.equal(hunk, 0);
  assert.match(evidence.content, /current working tree has not been read or compared/);
  await runtime.resize({ columns: columns === 48 ? 120 : 48, rows: 24 });
  assert.equal(runtime.state().overlay.review.hunk, hunk);
  await runtime.dispatch({ type: 'panel.review-attach', requestId, hunk, selection: false });
  assert.equal(runtime.state().overlay.kind, 'none');
  assert.equal(textDocumentText(runtime.state().composer.input.document), draft);
  assert.equal(runtime.state().composer.attachments.length, 1);
  const attachment = runtime.state().composer.attachments[0];
  assert.equal(attachment.item.content, evidence.hunks[0].content);
  assert.match(attachment.item.sourceUri, /sha256=.*excerptSha256=/);
  await runtime.dispatch({ type: 'panel.open', panel: 'branches' });
  await waitForState(runtime, t.signal, () => runtime.state().overlay.kind === 'panel');
  assert.ok(runtime.state().overlay.items.some((entry) => /Inspect the parser boundary/.test(entry.label)));
  await runtime.handleInput(key('escape'));
  assert.equal(runtime.state().composer.attachments[0], attachment);
  assert.equal(textDocumentText(runtime.state().composer.input.document), draft);
  assert.equal(fixture.decisions.length, 0);
  assert.equal(fixture.submissions.length, 0);
});

test('command palette can be filtered after a fixture turn completes', { timeout: 10_000 }, async (t) => {
  const fixture = await createUiWorkflowFixture();
  const host = createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 32 } });
  const runtime = createTuiRuntime({ host, app: fixture.app, initialFocus: { kind: 'element', elementId: 'composer' } });
  t.after(async () => { await runtime.dispose(); await fixture.close(); });
  await runtime.start();
  await runtime.handleInput(key('enter'));
  await waitForState(runtime, t.signal, () => runtime.state().run.kind === 'ended');
  await runtime.handleInput(key('p', { ctrl: true }));
  for (const character of 'exit') await runtime.handleInput({ kind: 'text', text: character, paste: false });
  assert.equal(runtime.state().overlay.kind, 'commands');
  assert.match(renderFramePlain(runtime.frame()), /exit/);
});

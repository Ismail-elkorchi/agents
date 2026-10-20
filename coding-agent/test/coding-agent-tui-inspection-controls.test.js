import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { createCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';

const key = (name, modifiers = {}) => ({
  kind: 'key', key: name, eventType: 'press', location: 'standard',
  modifiers: { ctrl: false, alt: false, shift: false, meta: false, ...modifiers }
});
async function open(t, options = {}, columns = 100, rows = 32) {
  const host = createMemoryTerminalHost({ terminalSize: { columns, rows } });
  const runtime = createTuiRuntime({ host, app: createCodingAgentTuiApp('Keep draft 文', options) });
  t.after(() => runtime.dispose());
  await runtime.start();
  return { runtime, host };
}

test('help filters the complete shortcut and command inventory and restores the draft', async (t) => {
  const { runtime } = await open(t);
  const draft = runtime.state().composer.input;
  await runtime.handleInput(key('f1'));
  assert.equal(runtime.state().overlay.kind, 'help');
  assert.ok(runtime.frame().focusPath.includes('help-query'));
  await runtime.handleInput({ kind: 'text', text: 'recovery', paste: false });
  assert.match(renderFramePlain(runtime.frame()), /\/recovery/);
  assert.doesNotMatch(renderFramePlain(runtime.frame()), /\/temperature/);
  await runtime.handleInput(key('escape'));
  assert.equal(runtime.state().overlay.kind, 'none');
  assert.equal(runtime.state().composer.input, draft);
  assert.ok(runtime.frame().focusPath.includes('composer'));
});

test('help results support keyboard scrolling without truncating the inventory', async (t) => {
  const { runtime } = await open(t, {}, 60, 18);
  await runtime.handleInput(key('f1'));
  await runtime.handleInput(key('tab'));
  await runtime.handleInput(key('pageDown'));
  assert.ok(runtime.state().overlay.results.caret.position.offset > 0);
  for (let i = 0; i < 20; i++) await runtime.handleInput(key('pageDown'));
  assert.match(renderFramePlain(runtime.frame()), /temperature/);
});

test('reading surfaces use large terminals while command selection remains compact', async (t) => {
  const { runtime } = await open(t, {}, 160, 50);
  const long = Array.from({ length: 38 }, (_, index) => `Line ${index + 1} ${'x'.repeat(110)}`).join('\n');
  await runtime.dispatch({ type: 'panel.source-loaded', title: 'Recorded source', content: long });
  const source = renderFramePlain(runtime.frame());
  assert.match(source, /Line 30/);
  assert.match(source, new RegExp('x'.repeat(110)));
  await runtime.handleInput(key('escape'));
  await runtime.handleInput(key('p', { ctrl: true }));
  assert.equal(runtime.state().overlay.kind, 'commands');
  await runtime.handleInput({ kind: 'text', text: 'Compose', paste: false });
  assert.match(renderFramePlain(runtime.frame()), /Compose/);
  assert.doesNotMatch(renderFramePlain(runtime.frame()), /\/temperature/);
});

test('remapped review shortcut replaces the original while ordinary text remains editable', async (t) => {
  const { runtime } = await open(t, {
    presentation: {
      preferences: { shortcuts: { help: { kind: 'key', key: 'h', modifiers: { alt: true } } }, statusline: ['model', 'mode', 'status'], theme: 'minimal', showTools: false, showReasoning: false, notify: false },
      save: async () => {}
    }
  });
  await runtime.handleInput(key('f1'));
  assert.equal(runtime.state().overlay.kind, 'none');
  await runtime.handleInput(key('h', { alt: true }));
  assert.equal(runtime.state().overlay.kind, 'help');
  await runtime.handleInput(key('escape'));
  await runtime.handleInput({ kind: 'text', text: ' suffix', paste: false });
  assert.equal(textDocumentText(runtime.state().composer.input.document), 'Keep draft 文 suffix');
});

test('stale approval decisions cannot authorize a replacement request', async (t) => {
  const decisions = [];
  const { runtime } = await open(t, { approvalHandler: async (suspension, decision) => { decisions.push([suspension.runId, decision]); } });
  const suspension = (runId, approvalId) => ({
    state: 'suspended', reason: 'approval_required', runId, finalizationId: 'final', pendingApprovals: [{ approvalId, toolName: 'read-files', reason: 'Review target', input: { path: 'a.ts' }, effects: { accesses: [], lockScopes: [], recovery: { kind: 'unknown' } } }]
  });
  await runtime.dispatch({ type: 'approval.required', suspension: suspension('old-run', 'old-request') });
  await runtime.dispatch({ type: 'approval.required', suspension: suspension('new-run', 'new-request') });
  await runtime.dispatch({ type: 'approval.decide', runId: 'old-run', approvalId: 'old-request', decision: 'allow' });
  await runtime.dispatch({ type: 'approval.decide', runId: 'new-run', approvalId: 'old-request', decision: 'allow' });
  assert.deepEqual(decisions, []);
  await runtime.dispatch({ type: 'recovery.open' });
  assert.match(renderFramePlain(runtime.frame()), /this exact action only/);
  assert.match(renderFramePlain(runtime.frame()), /Close keeps the decision pending/);
  await runtime.dispatch({ type: 'approval.decide', runId: 'new-run', approvalId: 'new-request', decision: 'deny' });
  assert.deepEqual(decisions, [['new-run', 'deny']]);
});

test('a complete raw help command selects help rather than a stale picker match', async (t) => {
  const { runtime, host } = await open(t);
  const input = await runtime.handleInputChunk({ data: '\x10help\r' });
  host.clock.advance(100);
  await input.pending;
  assert.equal(runtime.state().overlay.kind, 'help');
});


test('unavailable commands expose the same reason in menu and help and cannot dispatch', async (t) => {
  const { runtime } = await open(t);
  await runtime.handleInput(key('p', { ctrl: true }));
  await runtime.handleInput({ kind: 'text', text: 'export', paste: false });
  assert.match(renderFramePlain(runtime.frame()), /Local export is unavailable/);
  await runtime.dispatch({ type: 'commands.accept', event: { kind: 'accept', id: '/export' } });
  assert.equal(runtime.state().overlay.kind, 'commands');
  assert.equal(runtime.state().composer.submitting, false);
  await runtime.handleInput(key('escape'));
  await runtime.handleInput(key('f1'));
  await runtime.handleInput({ kind: 'text', text: 'export', paste: false });
  assert.match(renderFramePlain(runtime.frame()), /Local export is unavailable/);
});

test('approval exact-action details support keyboard paging without making a decision', async (t) => {
  const { runtime } = await open(t, {}, 60, 18);
  const content = Array.from({ length: 40 }, (_, i) => `Target ${i}`).join('\n');
  await runtime.dispatch({ type: 'approval.required', suspension: {
    state: 'suspended', reason: 'approval_required', runId: 'run', finalizationId: 'final',
    pendingApprovals: [{ approvalId: 'request', toolName: 'read-files', reason: content, input: {}, effects: { accesses: [], lockScopes: [], recovery: { kind: 'unknown' } } }]
  } });
  await runtime.dispatch({ type: 'recovery.open' });
  await runtime.handleInput(key('pageDown'));
  assert.ok(runtime.state().modalOffsetRow > 0);
  await runtime.handleInput(key('end'));
  assert.match(renderFramePlain(runtime.frame()), /Target 39/);
  const bottom = renderFramePlain(runtime.frame());
  await runtime.handleInput(key('pageUp'));
  assert.notEqual(renderFramePlain(runtime.frame()), bottom);
  await runtime.handleInput(key('home'));
  assert.equal(runtime.state().modalOffsetRow, 0);
  assert.equal(runtime.state().run.kind, 'waiting_for_approval');
});


test('recovery scope can be read with End then PageUp without resolving the run', async (t) => {
  const { runtime } = await open(t, {}, 40, 16);
  await runtime.dispatch({ type: 'run.suspended', suspension: {
    submissionId: 'input', category: 'external_recovery', actions: ['reconcile', 'abort'],
    reason: 'tool_outcome_unknown', runId: 'run', finalizationId: 'final',
    effectId: 'exact-effect-with-long-authoritative-identity', budget: {}
  } });
  await runtime.dispatch({ type: 'recovery.open' });
  await runtime.handleInput(key('end'));
  const bottom = renderFramePlain(runtime.frame());
  assert.ok(runtime.state().modalOffsetRow > 0);
  await runtime.handleInput(key('pageUp'));
  assert.notEqual(renderFramePlain(runtime.frame()), bottom);
  await runtime.handleInput(key('home'));
  assert.equal(runtime.state().modalOffsetRow, 0);
  assert.equal(runtime.state().run.kind, 'waiting_for_recovery');
});

test('command picker retains valid index identity after a submission completes', async (t) => {
  const { runtime } = await open(t, { commandHandler: { submit: async () => ({ message: '' }), execute: async () => ({ message: '' }) } });
  await runtime.dispatch({ type: 'composer.submit' });
  await runtime.handleInput(key('p', { ctrl: true }));
  await runtime.handleInput({ kind: 'text', text: 'exit', paste: false });
  assert.match(renderFramePlain(runtime.frame()), /exit/);
  assert.doesNotMatch(renderFramePlain(runtime.frame()), /Results unavailable/);
});

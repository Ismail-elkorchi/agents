import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { createCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';
import { waitFor } from './coding-agent-tui-test-helpers.js';

const key = (key, modifiers = {}) => ({ kind: 'key', key, eventType: 'press', location: 'standard',
  modifiers: { ctrl: false, alt: false, shift: false, meta: false, ...modifiers } });
const change = (path) => ({ path, absolutePath: `/project/${path}`, kind: 'modified',
  before: { kind: 'present', sha256: 'a'.repeat(64), bytes: 10 },
  after: { kind: 'present', sha256: 'b'.repeat(64), bytes: 12 }, receiptSequences: [1], state: 'changed' });
function hydration(sessionId = 'session-1') {
  return { session: { sessionId, phase: 'idle', queuedInputs: 0, configuration: { provider: 'test', model: 'test' } },
    history: { boundary: { sessionId, leafId: 'point-1', leafHash: 'hash' }, entries: [
      { id: 'input-1', parentId: null, timestamp: '2026-10-20T00:00:00Z', type: 'input', runId: 'run-1',
        task: 'Fix navigation without losing the draft', instructions: [] }
    ] },
    branchPoints: [{ entryId: 'point-1', runId: 'run-1', timestamp: '2026-10-20T00:01:00Z', kind: 'run_finalization' }],
    runs: [], pendingSubmissions: [], toolDiagnostics: [], verification: [],
    changes: [{ runId: 'run-1', changes: [change('a.ts'), change('b.ts')], mutationReceipts: [] }] };
}
const patch = '*** Begin Patch\n*** Update File: a.ts\n@@ first\n-old\n+new 文 👩🏽‍💻\n@@ second\n-other\n+next\n*** Add File: b.ts\n+second file\n*** Delete File: old.ts\n*** End Patch';
function inspection(path = 'a.ts', text = patch) {
  return { change: change(path), patches: [{ receipt: { applicationStatus: 'applied', patchSha256: 'c'.repeat(64) }, patch: text }] };
}
async function open(t, navigation = { readChange: async (_run, path) => inspection(path) }, terminalSize = { columns: 130, rows: 40 }) {
  const host = createMemoryTerminalHost({ terminalSize });
  const runtime = createTuiRuntime({ host, app: createCodingAgentTuiApp('', { initialHydration: hydration(), navigation }),
    initialFocus: { kind: 'element', elementId: 'composer' } });
  t.after(() => runtime.dispose());
  await runtime.start();
  return { runtime, host };
}
async function review(runtime) {
  await runtime.dispatch({ type: 'panel.open', panel: 'changes' });
  await waitFor(() => runtime.state().overlay.kind === 'panel');
  await runtime.dispatch({ type: 'panel.accept', id: runtime.state().overlay.items[0].id });
  await waitFor(() => runtime.state().overlay.kind === 'source' && !runtime.state().overlay.review.loading);
  return runtime.state().overlay.review;
}
async function hunk(runtime, direction) {
  await runtime.dispatch({ type: 'panel.review-hunk', requestId: runtime.state().overlay.review.requestId, direction });
}

test('branch navigation leads with the original prompt and explains workspace effects', async t => {
  const calls = [];
  const { runtime } = await open(t, { branchFrom: async (...args) => { calls.push(args); } });
  await runtime.dispatch({ type: 'panel.open', panel: 'branches' });
  await waitFor(() => runtime.state().overlay.kind === 'panel');
  assert.match(runtime.state().overlay.items[0].label, /^Fix navigation without losing the draft/);
  await runtime.dispatch({ type: 'panel.accept', id: 'point-1' });
  assert.match(renderFramePlain(runtime.frame()), /same workspace/);
  assert.match(renderFramePlain(runtime.frame()), /not an isolated Git worktree/);
  await runtime.dispatch({ type: 'panel.branch', entryId: 'point-1' });
  await waitFor(() => calls.length === 1);
  assert.deepEqual(calls[0], ['point-1', undefined, 'session-1']);
});

test('review attaches the exact inspected snapshot without replacing the draft or rereading files', async t => {
  const calls = [];
  let currentPatch = patch;
  const { runtime } = await open(t, { readChange: async (...args) => { calls.push(args); return inspection(args[1], currentPatch); } });
  await runtime.handleInput({ kind: 'paste', text: 'Keep my\nquestion', bracketed: true });
  const captured = await review(runtime);
  assert.match(renderFramePlain(runtime.frame()), /Current working tree not compared/);
  currentPatch = 'this is a newer unrelated file';
  await runtime.dispatch({ type: 'panel.review-attach', requestId: captured.requestId, hunk: undefined, selection: false });
  assert.equal(runtime.state().overlay.kind, 'none');
  assert.equal(textDocumentText(runtime.state().composer.input.document), 'Keep my\nquestion');
  assert.deepEqual(calls, [['run-1', 'a.ts', 'session-1']]);
  const attachment = runtime.state().composer.attachments[0];
  assert.equal(attachment.item.content, captured.evidence.content);
  assert.match(attachment.item.content, /new 文/);
  assert.doesNotMatch(attachment.item.content, /newer unrelated/);
  assert.equal(attachment.item.sourceKind, 'tool-observation');
  assert.match(attachment.item.sourceUri, /review:\/\/session-1\/run-1\/a.ts\?sha256=[a-f0-9]{64}&excerptSha256=/);
  assert.match(attachment.item.purpose, /not current file content/);
});

test('hunks stop at file and receipt boundaries and include added and deleted file segments', async t => {
  const { runtime } = await open(t, { readChange: async () => ({ ...inspection(), patches: [
    ...inspection().patches,
    { receipt: { applicationStatus: 'applied', patchSha256: 'd'.repeat(64) }, patch: '*** Begin Patch\n*** Update File: c.ts\n@@ third\n-before\n+after\n*** End Patch' }
  ] }) });
  const captured = await review(runtime);
  const hunks = captured.evidence.hunks;
  assert.equal(hunks.length, 5);
  assert.equal(hunks[0].content, '@@ first\n-old\n+new 文 👩🏽‍💻\n');
  assert.equal(hunks[1].content, '@@ second\n-other\n+next\n');
  assert.equal(hunks[2].content, '*** Add File: b.ts\n+second file\n');
  assert.equal(hunks[3].content, '*** Delete File: old.ts\n');
  for (const entry of hunks) assert.doesNotMatch(entry.content, /Recorded mutation|End Patch/);
  await hunk(runtime, 'next');
  assert.equal(runtime.state().overlay.review.hunk, 0);
  assert.match(renderFramePlain(runtime.frame()), /Hunk 1\/5/);
  await runtime.dispatch({ type: 'panel.review-attach', requestId: captured.requestId, hunk: 0, selection: false });
  const attachment = runtime.state().composer.attachments[0];
  assert.equal(attachment.item.content, hunks[0].content);
  assert.equal(attachment.item.representation, 'excerpt');
  assert.match(attachment.item.title, /a.ts.*first/);
});

test('review selection is exact and file navigation retains the original listing', async t => {
  const { runtime } = await open(t);
  const captured = await review(runtime);
  await hunk(runtime, 'next');
  await runtime.dispatch({ type: 'panel.source-mode' });
  await runtime.handleInput(key('a', { ctrl: true }));
  await runtime.dispatch({ type: 'panel.review-attach', requestId: captured.requestId, hunk: 0, selection: true });
  assert.equal(runtime.state().composer.attachments[0].item.content, captured.evidence.hunks[0].content);
  const second = await review(runtime);
  await runtime.dispatch({ type: 'panel.review-file', requestId: second.requestId, delta: 1 });
  await waitFor(() => runtime.state().overlay.review.evidence?.title === 'b.ts');
  const next = runtime.state().overlay.review;
  assert.equal(next.index, 1);
  await runtime.dispatch({ type: 'panel.review-list', requestId: next.requestId });
  assert.equal(runtime.state().overlay.kind, 'panel');
  assert.equal(runtime.state().overlay.items.length, 2);
});

test('stale review controls cannot attach a different file or hunk', async t => {
  const { runtime } = await open(t);
  const original = await review(runtime);
  await runtime.dispatch({ type: 'panel.review-file', requestId: original.requestId, delta: 1 });
  await waitFor(() => runtime.state().overlay.review.evidence?.title === 'b.ts');
  await runtime.dispatch({ type: 'panel.review-attach', requestId: original.requestId, hunk: undefined, selection: false });
  assert.equal(runtime.state().composer.attachments.length, 0);
  const next = runtime.state().overlay.review;
  await hunk(runtime, 'next');
  await runtime.dispatch({ type: 'panel.review-attach', requestId: next.requestId, hunk: undefined, selection: false });
  assert.equal(runtime.state().composer.attachments.length, 0);
});

test('a late change read and old review actions cannot enter a newly selected session', async t => {
  let finish;
  const read = new Promise(resolve => { finish = resolve; });
  const { runtime } = await open(t, { readChange: async () => read });
  await runtime.dispatch({ type: 'panel.open', panel: 'changes' });
  await waitFor(() => runtime.state().overlay.kind === 'panel');
  await runtime.dispatch({ type: 'panel.accept', id: runtime.state().overlay.items[0].id });
  const requestId = runtime.state().overlay.review.requestId;
  await runtime.dispatch({ type: 'session.hydrated', hydration: hydration('session-2') });
  finish(inspection());
  await new Promise(resolve => setTimeout(resolve, 20));
  await runtime.dispatch({ type: 'panel.review-attach', requestId, hunk: undefined, selection: false });
  assert.equal(runtime.state().debug.sessionId, 'session-2');
  assert.equal(runtime.state().overlay.kind, 'none');
  assert.equal(runtime.state().composer.attachments.length, 0);
});

test('unavailable structured patches remain explicit and cannot produce invented hunks', async t => {
  const { runtime } = await open(t, { readChange: async () => ({ change: change('a.ts'), patches: [] }) });
  const captured = await review(runtime);
  assert.equal(captured.evidence.patch, undefined);
  assert.equal(captured.evidence.hunks.length, 0);
  assert.match(captured.evidence.content, /No structured patch is recorded/);
  await hunk(runtime, 'next');
  assert.equal(runtime.state().overlay.review.hunk, undefined);
});

test('highlighted review scrolls with page and boundary keys without leaving the patch', async t => {
  const longPatch = `*** Begin Patch\n*** Update File: a.ts\n@@ long\n${Array.from({ length: 120 }, (_, index) => `+line ${index}`).join('\n')}\n*** End Patch`;
  const { runtime } = await open(t, { readChange: async () => inspection('a.ts', longPatch) });
  await review(runtime);
  await runtime.handleInput(key('pageDown'));
  assert.ok(runtime.state().overlay.offset > 0);
  assert.equal(runtime.state().overlay.rendered, true);
  await runtime.handleInput(key('end'));
  assert.ok(runtime.state().overlay.offset > 40);
  const lastPage = renderFramePlain(runtime.frame());
  await runtime.handleInput(key('pageUp'));
  assert.notEqual(renderFramePlain(runtime.frame()), lastPage);
  await runtime.handleInput(key('home'));
  assert.equal(runtime.state().overlay.offset, 0);
});


test('compact 40x12 review keeps captured patch content and essential controls visible', async t => {
  const { runtime } = await open(t, undefined, { columns: 40, rows: 12 });
  await review(runtime);
  const frame = renderFramePlain(runtime.frame());
  assert.match(frame, /Recorded/);
  assert.match(frame, /F›/);
  assert.match(frame, /Ask/);
  assert.match(frame, /Recorded mutation|Begin Patch|Update File|old|new/);
  await hunk(runtime, 'next');
  const hunkFrame = renderFramePlain(runtime.frame());
  assert.match(hunkFrame, /old|new/);
  assert.match(hunkFrame, /Ask/);
});


test('compact multi-file review labels the actual hunk file rather than the originally selected file', async t => {
  const multi = '*** Begin Patch\n*** Update File: a.ts\n@@ one\n-old\n+new\n*** Update File: b.ts\n@@ two\n-before\n+after\n*** End Patch';
  const { runtime } = await open(t, { readChange: async () => inspection('a.ts', multi) }, { columns: 40, rows: 12 });
  await review(runtime);
  await hunk(runtime, 'next');
  await hunk(runtime, 'next');
  assert.match(renderFramePlain(runtime.frame()), /b\.ts/);
  assert.match(runtime.state().overlay.title, /b\.ts/);
});

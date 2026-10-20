import { waitForState } from '../../test-helpers/tui-runtime.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySessionRepository } from '@agent-core/runtime';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { createCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';

const identity = (callIndex) => ({
  turnId: 'turn', turnIndex: 1, requestAttempt: 1,
  toolBatchId: 'batch', callIndex, callId: `call-${callIndex}`, toolAttempt: 1
});
function observation(index) {
  const content = `Unique evidence ${index}`;
  return {
    kind: 'result', summary: `Read file-${index}.ts`,
    scope: { resources: [`file-${index}.ts`], coverage: 'complete' },
    output: {
      files: [{
        path: `file-${index}.ts`, startLine: 1, lineCount: 1, content,
        bytes: content.length, fileBytes: content.length, eof: true, truncated: false,
        rangeSha256: 'a'.repeat(64), fullFileSha256: 'a'.repeat(64),
        newlineConvention: 'none', utf8Validation: 'valid'
      }],
      failures: [], coverage: 'complete', requestedFiles: 1, returnedFiles: 1,
      failedFiles: 0, returnedBytes: content.length
    }
  };
}
async function open(t, initialHydration) {
  const runtime = createTuiRuntime({
    host: createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 50 } }),
    app: createCodingAgentTuiApp('', initialHydration ? { initialHydration } : {})
  });
  t.after(() => runtime.dispose());
  await runtime.start();
  return runtime;
}

test('coding transcript groups actual read calls and reveals one member without expanding all output', async (t) => {
  const runtime = await open(t);
  for (const index of [1, 0, 2]) {
    await runtime.dispatch({
      type: 'progress', runId: 'run',
      event: { type: 'tool.ended', ...identity(index), toolName: 'read_files', observation: observation(index) }
    });
  }
  const entries = runtime.state().conversation.items;
  assert.equal(entries.length, 3);
  assert(entries.every((entry) => entry.kind === 'activity'));
  assert.match(renderFramePlain(runtime.frame()), /3 read calls/);
  assert.doesNotMatch(renderFramePlain(runtime.frame()), /Unique evidence/);
  const groupId = entries[0].id;
  await runtime.dispatch({ type: 'activity.toggle', id: `activity-group:${groupId}` });
  assert.match(renderFramePlain(runtime.frame()), /Read file-0.ts/);
  assert.doesNotMatch(renderFramePlain(runtime.frame()), /Unique evidence/);
  await runtime.dispatch({ type: 'activity.toggle', id: `activity-member:${entries[1].id}` });
  assert.match(renderFramePlain(runtime.frame()), /Unique evidence 0/);
  assert.doesNotMatch(renderFramePlain(runtime.frame()), /Unique evidence 1/);
  await runtime.dispatch({ type: 'activity.toggle', id: `activity-member:${entries[1].id}` });
  assert.doesNotMatch(renderFramePlain(runtime.frame()), /Unique evidence/);
  assert.deepEqual(runtime.state().conversation.items, entries);
});

test('rehydrated read groups match live semantics and a middle-member reading anchor survives regrouping and resize', async (t) => {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ binding: { schemaId: 'test/groups', schemaVersion: 1, subject: {} } });
  for (let index = 0; index < 4; index++) {
    await repository.appendObservation(session, {
      runId: 'run', identity: identity(index), toolName: 'read_files', observation: observation(index)
    });
  }
  const hydration = {
    toolDiagnostics: [], history: await repository.readBranchPage(session),
    changes: [], verification: [], branchPoints: [], pendingSubmissions: [], runs: [],
    session: {
      sessionId: session.id, phase: 'idle', queuedInputs: 0,
      configuration: { provider: 'test', model: 'test' }
    }
  };
  const runtime = await open(t, hydration);
  assert.match(renderFramePlain(runtime.frame()), /4 read calls/);
  await runtime.dispatch({ type: 'tools.toggle' });
  await runtime.dispatch({ type: 'conversation.scroll', transition: { kind: 'top' } });
  await runtime.dispatch({ type: 'conversation.message', direction: 'next' });
  const anchor = runtime.state().conversation.anchor;
  assert.equal(anchor.itemId, 'tool:run:turn:batch:1');
  await runtime.dispatch({ type: 'tools.toggle' });
  assert.equal(runtime.state().conversation.anchor.itemId, anchor.itemId);
  assert(runtime.state().presentation.layout.entries.some((entry) => entry.id === anchor.itemId));
  for (const columns of [40, 120, 60]) {
    await runtime.resize({ columns, rows: 20 });
    assert.equal(runtime.state().conversation.anchor.itemId, anchor.itemId);
    assert(runtime.state().presentation.layout.entries.some((entry) => entry.id === anchor.itemId));
  }
});


test('expanded later-member group rows survive session restoration and older history prepends', { timeout: 30_000 }, async (t) => {
  const repository = new InMemorySessionRepository();
  const first = await repository.create({ binding: { schemaId: 'test/group-bookmark', schemaVersion: 1, subject: {} } });
  const second = await repository.create({ binding: { schemaId: 'test/group-bookmark', schemaVersion: 1, subject: {} } });
  for (let index = 0; index < 8; index++) {
    const result = observation(index);
    result.output.files[0].content = Array.from({ length: 30 }, (_, line) => `Evidence ${index} line ${line}`).join('\n');
    result.output.files[0].lineCount = 30;
    await repository.appendObservation(first, { runId: 'run', identity: identity(index), toolName: 'read_files', observation: result });
  }
  await repository.appendInput(second, { runId: 'other', task: 'Other session' });
  let selected = first;
  const read = async (request) => ({ history: await repository.readBranchPage(selected, { ...request, limit: 4 }), changes: [], verification: [] });
  const view = async () => ({ toolDiagnostics: [], ...(await read()), branchPoints: [], pendingSubmissions: [], runs: [], session: { sessionId: selected.id, phase: 'idle', queuedInputs: 0, configuration: { provider: 'test', model: 'test' } } });
  const runtime = createTuiRuntime({
    host: createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 20 } }),
    app: createCodingAgentTuiApp('', { initialHydration: await view(), historyReader: read })
  });
  t.after(() => runtime.dispose());
  await runtime.start();
  const entries = runtime.state().conversation.items;
  const groupId = `activity-group:${entries[0].id}`;
  const memberId = `activity-member:${entries[2].id}`;
  await runtime.dispatch({ type: 'activity.toggle', id: groupId });
  await runtime.dispatch({ type: 'activity.toggle', id: memberId });
  await runtime.dispatch({ type: 'conversation.scroll', transition: { kind: 'setOffset', rows: 12 } });
  const anchor = runtime.state().conversation.anchor ?? runtime.state().presentation.anchor(runtime.state().presentation.layout.scroll.offsetRow);
  assert.equal(anchor.itemId, groupId);
  assert.ok(anchor.rowWithinItem > 5);
  const frame = renderFramePlain(runtime.frame());
  assert.match(frame, /Evidence 6 line/);
  selected = second;
  await runtime.dispatch({ type: 'session.hydrated', hydration: await view() });
  selected = first;
  await runtime.dispatch({ type: 'session.hydrated', hydration: await view() });
  await waitForState(runtime, t.signal, () => runtime.state().conversation.loading === undefined);
  assert.deepEqual(runtime.state().conversation.anchor, anchor);
  assert.ok(runtime.state().conversation.expandedIds.includes(groupId));
  assert.ok(runtime.state().conversation.expandedIds.includes(memberId));
  assert.equal(renderFramePlain(runtime.frame()), frame);
  await runtime.dispatch({ type: 'history.load', direction: 'older' });
  await waitForState(runtime, t.signal, () => runtime.state().conversation.loading === undefined);
  assert.deepEqual(runtime.state().conversation.anchor, anchor);
  assert.equal(renderFramePlain(runtime.frame()), frame);
});

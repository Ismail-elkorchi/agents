import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashJson } from '@agent-core/persistence';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { createCodingAgentTuiApp, runCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';
import { CodingApplication } from '@ismail-elkorchi/coding-agent';
import { main } from '@ismail-elkorchi/coding-agent/cli';
import { createInitialCodingAgentTuiState } from '../dist/tui/state.js';
import { codingStatusFields } from '../dist/tui/chrome.js';
import { createProcessPanel, updateProcesses } from '../dist/tui/processes.js';
import { waitFor } from './coding-agent-tui-test-helpers.js';

const suspension = { runId: 'run', submissionId: 'submission', category: 'external_recovery',
  reason: 'tool_outcome_unknown', effectId: 'effect', actions: ['reconcile', 'abort'] };
const owner = { ownerId: 'coding-session:session', runId: 'run', turnId: 'turn', toolBatchId: 'batch', callIndex: 0 };
const target = { processId: 'process', sessionId: 'session', owner, revision: 'revision', status: 'running' };
const output = { segments: ['result'], observedBytes: 6, capturedBytes: 6, omittedBytes: 0,
  startsAtOutputStart: true, endsAtOutputEnd: true };
const result = { processId: 'process', owner, status: 'exited', exitCode: 0,
  cursorStart: 0, cursorEnd: 6, stdout: output, stderr: output, combined: output };

function processOperations(processes, calls) {
  return { async listProcesses() { return processes; }, async controlProcess(selected, action) {
    calls.push({ selected, action }); return result;
  } };
}

async function listedPanel(processes, requested = target) {
  const calls = [];
  const operations = processOperations(processes, calls);
  const opened = updateProcesses(createProcessPanel(), { type: 'processes.open', target: requested }, operations);
  const response = await opened.effects[0].run();
  return { ...updateProcesses(opened.state, response.message, operations), calls };
}

test('direct process inspection refreshes authority and binds the complete causal owner', async () => {
  const panel = await listedPanel([target]);
  assert.equal(panel.state.selected.target, target);
  assert.equal(panel.state.requestedTarget, undefined);
  await panel.effects[0].run();
  assert.deepEqual(panel.calls, [{ selected: target, action: { kind: 'inspect', afterCursor: 0 } }]);
  for (const replacement of [
    { ...target, sessionId: 'other' },
    { ...target, owner: { ...owner, turnId: 'other' } },
    { ...target, owner: { ...owner, ownerId: 'other' } }
  ]) {
    const stale = await listedPanel([replacement]);
    assert.equal(stale.state.selected, undefined);
    assert.equal(stale.effects, undefined);
    assert.match(stale.state.error, /recorded owner/);
    assert.equal(stale.calls.length, 0);
  }
});

test('delayed process output from a reused ID cannot replace another owner', async () => {
  const panel = await listedPanel([target]);
  const updated = updateProcesses(panel.state, { type: 'processes.observed', id: panel.state.id,
    result: { ...result, owner: { ...owner, turnId: 'other' } } }, processOperations([], []));
  assert.equal(updated.state, panel.state);
});

test('operational fields distinguish missing measurements and unknown authority from zero', () => {
  const fields = codingStatusFields(createInitialCodingAgentTuiState());
  assert.equal(fields.find(x => x.id === 'mode').value, 'Permissions unknown');
  for (const id of ['cost', 'context', 'usage', 'changes', 'decisions'])
    assert.equal(fields.find(x => x.id === id).value, undefined);
});

test('narrow status retains authority and uncertain outcome instead of model trivia', async (t) => {
  const runtime = createTuiRuntime({ host: createMemoryTerminalHost({ terminalSize: { columns: 24, rows: 18 } }),
    app: createCodingAgentTuiApp('', { runtimeDetails: { permissions: { mode: 'read_only' }, modelId: 'a-long-model-name' } }) });
  t.after(() => runtime.dispose());
  await runtime.start();
  await runtime.dispatch({ type: 'run.suspended', suspension });
  const firstLine = renderFramePlain(runtime.frame()).split('\n')[0];
  assert.match(firstLine, /Read only/);
  assert.match(firstLine, /Unknown/);
  assert.doesNotMatch(firstLine, /a-long-model/);
});

test('stale recovery controls and results cannot target a replacement suspension in the same run', async (t) => {
  const calls = [];
  const runtime = createTuiRuntime({ host: createMemoryTerminalHost({ terminalSize: { columns: 90, rows: 24 } }),
    app: createCodingAgentTuiApp('Keep draft', { recoveryHandler: async (paused, action) => { calls.push({ paused, action }); return 'Checked'; } }) });
  t.after(() => runtime.dispose());
  await runtime.start();
  await runtime.dispatch({ type: 'run.suspended', suspension });
  const staleIdentity = hashJson(suspension);
  const replacement = { ...suspension, effectId: 'replacement' };
  await runtime.dispatch({ type: 'run.suspended', suspension: replacement });
  await runtime.dispatch({ type: 'recovery.act', identity: staleIdentity, action: 'resume' });
  assert.equal(calls.length, 0);
  await runtime.dispatch({ type: 'recovery.finished', runId: 'run', identity: staleIdentity, message: 'stale result' });
  assert.notEqual(runtime.state().run.message, 'stale result');
  await runtime.dispatch({ type: 'recovery.act', identity: hashJson(replacement), action: 'resume' });
  await waitFor(() => calls.length === 1 && runtime.state().run.operation === undefined);
  assert.deepEqual(calls[0], { paused: replacement, action: 'resume' });
});

test('accessible CLI option does not silently change exec or RPC output contracts', async () => {
  for (const mode of ['exec', 'rpc'])
    await assert.rejects(main([mode, '--accessible', 'task']), /only in interactive mode/);
});

test('runner exposes semantic scrollback output without terminal painting', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'coding-accessible-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const host = createMemoryTerminalHost({ terminalSize: { columns: 90, rows: 24 } });
  const controller = {
    state: () => ({ status: 'ready', requirements: [], runtimeDetails: { modelId: 'test-model' } }),
    subscribe: () => () => {}, start: async () => {}, close: async () => {},
    presentationPath: () => path.join(directory, 'preferences.json'),
    draftDirectory: () => path.join(directory, 'drafts'), modelSelection: () => undefined
  };
  const running = runCodingAgentTuiApp(controller, { host, outputMode: 'accessible' });
  await waitFor(() => host.output().includes('Coding'));
  assert.doesNotMatch(host.output(), /\u001b\[\?1049h|\u001b\[2J/);
  host.input('/exit\r');
  assert.equal((await running).exit.status, 'completed');
});

test('process notification actions cannot cross sessions after a switch', async (t) => {
  let listed = 0;
  const runtime = createTuiRuntime({ host: createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 24 } }),
    app: createCodingAgentTuiApp('Keep draft', { processes: { async listProcesses() { listed++; return [target]; },
      async controlProcess() { return result; } } }) });
  t.after(() => runtime.dispose());
  await runtime.start();
  const state = sessionId => ({ status: 'ready', requirements: [], runtimeDetails: {}, session: {
    sessionId, phase: 'idle', configuration: { provider: 'test', model: 'test' }, queuedInputs: 0
  } });
  await runtime.dispatch({ type: 'application.state.changed', state: state('session') });
  await runtime.dispatch({ type: 'processes.settled', result });
  assert.equal(runtime.state().settledProcess.sessionId, 'session');
  assert.match(renderFramePlain(runtime.frame()), /Inspect command/);
  await runtime.dispatch({ type: 'application.state.changed', state: state('other') });
  await runtime.dispatch({ type: 'processes.open', target });
  assert.equal(listed, 0);
  assert.notEqual(runtime.state().overlay.kind, 'processes');
  await runtime.dispatch({ type: 'processes.settled', result });
  assert.notEqual(runtime.state().settledProcess?.sessionId, 'other');
  assert.doesNotMatch(renderFramePlain(runtime.frame()), /Inspect command/);
});

test('refreshing a process list never substitutes a reused ID for an inspected owner', async () => {
  const opened = await listedPanel([target]);
  const replacement = { ...target, owner: { ...owner, turnId: 'replacement' } };
  const refreshed = updateProcesses(opened.state, { type: 'processes.listed', id: opened.state.id,
    processes: [replacement] }, processOperations([], []));
  assert.equal(refreshed.state.selected.target, target);
  assert.equal(refreshed.state.selected.unavailable, true);
  assert.match(refreshed.state.error, /recorded owner/);
  const action = updateProcesses(refreshed.state, { type: 'processes.action', panelId: refreshed.state.id, target, action: 'terminate' }, processOperations([], []));
  assert.equal(action.effects, undefined);
});

// Restoration can replace the paused request without changing the owning run.
test('recovery resume compares the authoritative descriptor after restoration', async () => {
  let current = suspension;
  const calls = [];
  const agent = {
    async restore() { current = { ...suspension, effectId: 'replacement-effect' }; },
    inspectSuspension() { return current; },
    async reconcileExternal(runId) { calls.push(runId); return 'resumed'; }
  };
  const application = { requireRuntime() { return { agent }; } };
  await assert.rejects(
    CodingApplication.prototype.resumeSuspension.call(application, suspension.runId, suspension),
    /paused request changed/
  );
  assert.deepEqual(calls, []);
  assert.equal(await CodingApplication.prototype.resumeSuspension.call(application, current.runId, current), 'resumed');
  assert.deepEqual(calls, ['run']);
});

test('captured process controls cannot operate a replacement selection or evidence revision', async () => {
  const panel = await listedPanel([target]);
  const calls = [];
  const operations = { ...processOperations([], calls), async reconcileProcesses(selected) { calls.push(selected); return []; } };
  const replacement = { ...panel.state, pending: false, selected: { ...panel.state.selected, target: { ...target, processId: 'other-process' } } };
  for (const message of [
    { type: 'processes.action', panelId: panel.state.id, target, action: 'terminate' },
    { type: 'processes.action', panelId: panel.state.id, target, action: 'input' },
    { type: 'processes.reconcile', panelId: panel.state.id, target, acknowledge: true }
  ]) {
    assert.equal(updateProcesses(replacement, message, operations).effects, undefined);
    assert.equal(updateProcesses({ ...replacement, id: 'new-panel' }, message, operations).effects, undefined);
    assert.equal(updateProcesses({ ...replacement, selected: { ...replacement.selected, target: { ...target, revision: 'new-evidence' } } }, message, operations).effects, undefined);
  }
  assert.deepEqual(calls, []);
});

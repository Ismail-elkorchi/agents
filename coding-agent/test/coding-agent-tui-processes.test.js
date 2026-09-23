import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { createCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';
import { processControls } from '../dist/execution/process-controls.js';
import { waitForState } from '../../test-helpers/tui-runtime.js';

const target = {
  sessionId: 'session',
  processId: 'process',
  command: 'node server.js',
  revision: 'initial',
  status: 'running',
  owner: { ownerId: 'owner', runId: 'run', turnId: 'turn', toolBatchId: 'batch', callIndex: 0 }
};
const output = {
  text: 'Ready\n',
  observedBytes: 6,
  capturedBytes: 6,
  omittedBytes: 0,
  startsAtOutputStart: true,
  endsAtOutputEnd: true
};
const result = {
  processId: target.processId,
  owner: target.owner,
  status: 'running',
  cursorStart: 0,
  cursorEnd: 6,
  stdout: output,
  stderr: { ...output, text: '' },
  combined: output
};

test('process controls inspect first and send exact input only on an explicit action', async (t) => {
  const actions = [];
  const runtime = createTuiRuntime({
    host: createMemoryTerminalHost({ terminalSize: { columns: 48, rows: 24 } }),
    app: createCodingAgentTuiApp('Preserve draft', {
      processes: {
        async listProcesses() {
          return [target];
        },
        async controlProcess(selected, action) {
          actions.push({ selected, action });
          return result;
        }
      }
    })
  });
  t.after(() => runtime.dispose());
  await runtime.start();
  await runtime.dispatch({ type: 'processes.open' });
  await waitForState(runtime, t.signal, () => !runtime.state().overlay.state.pending);
  assert.equal(actions.length, 0);
  await runtime.dispatch({ type: 'processes.select', processId: target.processId });
  await waitForState(
    runtime,
    t.signal,
    () => runtime.state().overlay.state.selected.result !== undefined
  );
  assert.deepEqual(
    actions.map((item) => item.action),
    [{ kind: 'inspect', afterCursor: 0 }]
  );
  await runtime.dispatch({
    type: 'processes.edit',
    field: 'input',
    transition: { kind: 'edit', operation: { kind: 'insert', text: 'Input 文\t\n' } }
  });
  await runtime.dispatch({ type: 'processes.action', action: 'input' });
  await waitForState(runtime, t.signal, () => !runtime.state().overlay.state.pending);
  assert.deepEqual(actions[1], {
    selected: target,
    action: { kind: 'input', text: 'Input 文\t\n' }
  });
  assert.equal(textDocumentText(runtime.state().overlay.state.selected.input.document), '');
  assert.equal(textDocumentText(runtime.state().composer.input.document), 'Preserve draft');
  await runtime.dispatch({ type: 'overlay.close' });
  assert.ok(runtime.frame().focusPath.includes('composer'));
});

test('process actions bind the exact session and causal owner, including after the authority closes', async () => {
  let writes = 0;
  const authority = {
    async listProcesses() {
      return [target];
    },
    async writeInput() {
      writes++;
    },
    async query() {
      return result;
    }
  };
  const controls = processControls('session', 'owner', authority);
  await assert.rejects(
    controls.controlProcess({ ...target, sessionId: 'other' }, { kind: 'input', text: 'x' }),
    /another session/
  );
  await assert.rejects(
    controls.controlProcess(
      { ...target, owner: { ...target.owner, turnId: 'reused' } },
      { kind: 'input', text: 'x' }
    ),
    /owner changed/
  );
  assert.equal(writes, 0);
  await controls.controlProcess(target, { kind: 'input', text: 'x' });
  assert.equal(writes, 1);
  const closed = processControls('session', 'owner', undefined);
  await assert.rejects(
    closed.controlProcess(target, { kind: 'terminate' }),
    /authority has closed/
  );
});

test('uncertainty decisions bind the current evidence revision and causal owner before acknowledgement', async () => {
  let acknowledgements = 0;
  let current = { ...target, status: 'unknown', diagnostic: 'Worker connection is unavailable.' };
  const authority = {
    async listProcesses() {
      return [current];
    },
    async acknowledgeUnresolved(ids) {
      assert.deepEqual(ids, [{ processId: 'process', revision: current.revision }]);
      acknowledgements++;
      current = { ...current, status: 'acknowledged-unknown', revision: 'accepted' };
    },
    async retryReconciliation() {}
  };
  const controls = processControls('session', 'owner', authority);
  await assert.rejects(
    controls.reconcileProcesses({ ...current, sessionId: 'other' }),
    /another session/
  );
  await assert.rejects(
    controls.reconcileProcesses({ ...current, revision: 'stale' }),
    /evidence changed/
  );
  await assert.rejects(
    controls.reconcileProcesses({ ...current, owner: { ...current.owner, runId: 'other' } }),
    /owner/
  );
  assert.equal(acknowledgements, 0);
  const processes = await controls.reconcileProcesses(current);
  assert.equal(processes[0].status, 'acknowledged-unknown');
  assert.equal(acknowledgements, 1);
});

test('process controls cannot relabel another session owner as the current session', async () => {
  const foreign = {
    ...target,
    processId: 'foreign',
    owner: { ...target.owner, ownerId: 'another-owner' }
  };
  const controls = processControls('session', 'owner', {
    async listProcesses() {
      return [target, foreign];
    },
    async terminate() {
      assert.fail('another owner must not reach execution');
    }
  });
  assert.deepEqual(
    (await controls.listProcesses()).map((process) => process.processId),
    [target.processId]
  );
  await assert.rejects(
    controls.controlProcess({ ...foreign, sessionId: 'session' }, { kind: 'terminate' }),
    /unavailable/
  );
  await assert.rejects(
    controls.reconcileProcesses({ ...foreign, sessionId: 'session', status: 'unknown' }),
    /evidence changed/
  );
});

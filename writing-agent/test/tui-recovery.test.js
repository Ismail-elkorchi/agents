import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySessionRepository } from '@agent-core/runtime';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { createWritingAgentTuiApp } from '@ismail-elkorchi/writing-agent/tui';
import { waitForState } from '../../test-helpers/tui-runtime.js';

async function fixture(t) {
  const repository = new InMemorySessionRepository();
  const sessions = await Promise.all(
    [1, 2].map(() =>
      repository.create({ binding: { schemaId: 'recovery-test', schemaVersion: 1, subject: {} } })
    )
  );
  let current = sessions[0];
  const inspection = (id) => ({
    toolDiagnostics: [],
    runs: [],
    session: {
      sessionId: id,
      phase: 'suspended',
      configuration: { provider: 'fixture', model: 'fixture' },
      queuedInputs: 0,
      suspension: {
        runId: `run:${id}`,
        reason: 'provider_outcome_unknown',
        category: 'provider',
        actions: ['reconcile', 'abort']
      }
    }
  });
  const application = {
    state: () => ({
      workspace: '/workspace',
      mode: 'review',
      sessionId: current.id,
      status: 'suspended'
    }),
    start: async () => {},
    readHistory: () => repository.readBranchPage(current),
    readSession: async () => inspection(current.id)
  };
  const runtime = createTuiRuntime({
    host: createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 32 } }),
    app: createWritingAgentTuiApp(application)
  });
  t.after(() => runtime.dispose());
  await runtime.start();
  await waitForState(
    runtime,
    t.signal,
    () => runtime.metrics().effects.owned === 0 && runtime.state().history.length > 0
  );
  return {
    application,
    runtime,
    inspection,
    switchSession: () => {
      current = sessions[1];
    }
  };
}
for (const action of ['close', 'replace', 'switch'])
  test(`a late recovery read cannot undo ${action}`, { timeout: 10000 }, async (t) => {
    const { application, runtime, inspection, switchSession } = await fixture(t);
    const gate = Promise.withResolvers();
    t.after(() => gate.resolve(inspection(application.state().sessionId)));
    const previous = await application.readSession();
    let started = false;
    application.readSession = async () => {
      started = true;
      return gate.promise;
    };
    await runtime.dispatch({ type: 'recovery.open' });
    await waitForState(runtime, t.signal, () => started);
    if (action === 'close') await runtime.dispatch({ type: 'overlay.close' });
    if (action === 'replace') await runtime.dispatch({ type: 'commands.open' });
    if (action === 'switch') {
      switchSession();
      await runtime.dispatch({ type: 'application', state: application.state() });
    }
    const overlay = runtime.state().overlay;
    gate.resolve(previous);
    await waitForState(runtime, t.signal, () => runtime.metrics().effects.owned === 0);
    assert.equal(runtime.state().overlay, overlay);
    if (action === 'switch') assert.notEqual(runtime.state().overlay.kind, 'recovery');
  });
test(
  'a recovery command stays owned after closing its dialog and does not close a replacement',
  { timeout: 10000 },
  async (t) => {
    const { application, runtime } = await fixture(t);
    const gate = Promise.withResolvers();
    t.after(() => gate.resolve());
    let calls = 0;
    application.abort = async () => {
      calls++;
      await gate.promise;
      return true;
    };
    await runtime.dispatch({ type: 'recovery.open' });
    await waitForState(
      runtime,
      t.signal,
      () => runtime.state().overlay.kind === 'recovery' && runtime.metrics().effects.owned === 0
    );
    await runtime.dispatch({ type: 'recovery.abort' });
    await waitForState(runtime, t.signal, () => calls === 1);
    await runtime.dispatch({ type: 'overlay.close' });
    await runtime.dispatch({ type: 'commands.open' });
    const overlay = runtime.state().overlay;
    gate.resolve();
    await waitForState(runtime, t.signal, () => runtime.metrics().effects.owned === 0);
    assert.equal(runtime.state().overlay, overlay);
    assert.equal(calls, 1);
  }
);

test(
  'reopening recovery replaces the old read instead of dropping the new request',
  { timeout: 10000 },
  async (t) => {
    const { application, runtime, inspection } = await fixture(t);
    const first = Promise.withResolvers();
    t.after(() => first.resolve(inspection(application.state().sessionId)));
    let calls = 0;
    application.readSession = async () => {
      if (++calls === 1) return first.promise;
      const value = inspection(application.state().sessionId);
      return {
        ...value,
        session: {
          ...value.session,
          suspension: { ...value.session.suspension, diagnostic: 'Current recovery information' }
        }
      };
    };
    await runtime.dispatch({ type: 'recovery.open' });
    await waitForState(runtime, t.signal, () => calls === 1);
    await runtime.dispatch({ type: 'overlay.close' });
    await runtime.dispatch({ type: 'recovery.open' });
    await waitForState(
      runtime,
      t.signal,
      () => calls === 2 && runtime.state().overlay.loading === false
    );
    first.resolve(inspection(application.state().sessionId));
    await waitForState(runtime, t.signal, () => runtime.metrics().effects.owned === 0);
    assert.equal(
      runtime.state().sessionView.session.suspension.diagnostic,
      'Current recovery information'
    );
  }
);

test(
  'a failed recovery action settles once after closure and leaves its failure visible',
  { timeout: 10000 },
  async (t) => {
    const { application, runtime } = await fixture(t);
    const gate = Promise.withResolvers();
    t.after(() => gate.resolve());
    let calls = 0;
    application.resume = async () => {
      calls++;
      await gate.promise;
      throw new Error('Recorded outcome remains unavailable.');
    };
    await runtime.dispatch({ type: 'recovery.open' });
    await waitForState(
      runtime,
      t.signal,
      () => runtime.state().overlay.kind === 'recovery' && runtime.metrics().effects.owned === 0
    );
    await runtime.dispatch({ type: 'recovery.resume' });
    await waitForState(runtime, t.signal, () => calls === 1);
    await runtime.dispatch({ type: 'recovery.resume' });
    assert.equal(calls, 1);
    await runtime.dispatch({ type: 'overlay.close' });
    gate.resolve();
    await waitForState(runtime, t.signal, () => runtime.metrics().effects.owned === 0);
    assert.equal(runtime.state().recoveryOperation, undefined);
    assert.equal(runtime.state().overlay.kind, 'none');
    assert.match(runtime.state().notice, /Recorded outcome remains unavailable/);
  }
);

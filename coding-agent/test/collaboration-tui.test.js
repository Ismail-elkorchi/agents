import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySessionRepository } from '@agent-core/runtime';
import { createCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';
import { createWritingAgentTuiApp } from '@ismail-elkorchi/writing-agent/tui';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { waitForState } from '../../test-helpers/tui-runtime.js';

for (const kind of ['coding', 'writing']) test(`${kind} collaboration inspector hydrates, targets a run and refreshes recorded state`, { timeout: 20_000 }, async t => {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ id: 'root-session', binding: { schemaId: 'test/collaboration', schemaVersion: 1, subject: {} } });
  const rootState = { sessionId: session.id, phase: 'idle', queuedInputs: 0, configuration: { provider: 'fixture', model: 'fixture' } };
  let page = { groupId: 'group', supervisorSessionId: session.id, epoch: 0, maxParticipants: 4, maxConcurrentRuns: 2, maxWaitMs: 50,
    total: 1, nextOffset: null, coverage: 'complete', participants: [{ participant: { participantId: 'reviewer', sessionId: 'child-session' },
      assignment: { assignmentId: 'assignment', revision: 1, runId: 'child-run', epoch: 0, task: 'Review independently', budgetOwnerId: 'owner', budgetScopeId: 'scope' },
      phase: 'running', cancelled: false, results: [], resultCount: 0, sourceCount: 0, taskTruncated: false }] };
  const controls = [];
  const collaboration = {
    readCollaboration: async () => page,
    interruptParticipant: async input => { controls.push(input); page = { ...page, participants: [{ ...page.participants[0], phase: 'ended' }] }; }
  };
  const hydration = { session: rootState, history: await repository.readBranchPage(session), pendingSubmissions: [], runs: [], toolDiagnostics: [], changes: [], verification: [], branchPoints: [] };
  const app = kind === 'coding' ? createCodingAgentTuiApp('', { collaboration, initialHydration: hydration })
    : createWritingAgentTuiApp({
      ...collaboration,
      state: () => ({ sessionId: session.id, workspace: '/workspace', mode: 'review', status: 'ready' }),
      modelSelection: () => ({ provider: 'fixture', model: 'fixture' }),
      readSession: async () => hydration,
      readHistory: () => repository.readBranchPage(session),
      readPendingSubmissions: async () => []
    });
  const runtime = createTuiRuntime({ host: createMemoryTerminalHost({ terminalSize: { columns: 110, rows: 36 } }), app });
  t.after(() => runtime.dispose());
  await runtime.start();
  await runtime.dispatch({ type: 'collaboration.open' });
  await waitForState(runtime, t.signal, () => runtime.state().overlay.kind === 'collaboration' && !runtime.state().overlay.state.state.pending);
  assert.match(renderFramePlain(runtime.frame()), /reviewer.*running/);
  const child = message => ({ type: 'collaboration.child', child: { id: runtime.state().overlay.state.id, generation: runtime.state().overlay.state.generation, message } });
  await runtime.dispatch(child({ type: 'select', participantId: 'reviewer' }));
  assert.match(renderFramePlain(runtime.frame()), /child-session/);
  assert.match(renderFramePlain(runtime.frame()), /child-run/);
  await runtime.dispatch(child({ type: 'control', action: 'interrupt' }));
  await waitForState(runtime, t.signal, () => !runtime.state().overlay.state.state.pending);
  assert.equal(controls[0].expectedSessionId, 'child-session');
  assert.equal(controls[0].expectedRunId, 'child-run');
  assert.equal(controls[0].expectedEpoch, 0);
  page = { ...page, epoch: 1, participants: [{ ...page.participants[0], cancelled: true }] };
  await runtime.dispatch({ type: 'collaboration.refresh' });
  await waitForState(runtime, t.signal, () => runtime.state().overlay.state.state.snapshot.epoch === 1);
  assert.match(renderFramePlain(runtime.frame()), /cancelled/);
  await runtime.dispatch({ type: 'overlay.close' });
  assert.equal(runtime.state().overlay.kind, 'none');
});

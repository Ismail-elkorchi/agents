import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentSession,
  AgentRunCoordinator,
  InMemorySessionRepository,
  agentEventCodec
} from '@agent-core/runtime';
import { InMemoryEventRepository } from '@agent-core/persistence';
import { CodingSession } from '@ismail-elkorchi/coding-agent';
import { testResult, testTerminal } from './helpers/results.js';

test('queued prompts remain admitted while application effects need reconciliation', async () => {
  const repository = new InMemorySessionRepository();
  const binding = { schemaId: 'test/coding-session', schemaVersion: 1, subject: {} };
  const descriptor = await repository.create({ binding });
  const controls = new Map();
  const core = new AgentSession({
    descriptor,
    expectedBinding: binding,
    repository,
    runs: new AgentRunCoordinator(new InMemoryEventRepository(agentEventCodec)),
    scheduling: 'manual',
    configuration: { provider: 'test', model: 'test' },
    createRuntime() {
      return {
        run(input) {
          let resolve;
          const result = new Promise((done) => {
            resolve = done;
          });
          controls.set(input.runId, resolve);
          return { runId: input.runId, result, injectSteering() {}, abort() {} };
        }
      };
    }
  });
  let reconciled = false;
  const ended = new Map();
  const session = new CodingSession(core, {
    async settle(execution) {
      ended.set(execution.terminal.runId, execution);
      return testResult(
        execution.terminal,
        execution.terminal.runId === 'first' && !reconciled
          ? {
              stage: 'awaiting_reconciliation',
              acceptance: 'inconclusive',
              reason: 'Publication response lost.'
            }
          : {}
      );
    },
    async recover() {
      return [];
    },
    async readExecution(runId) {
      return ended.get(runId);
    }
  });
  session.subscribe(() => {
    throw new Error('delivery failed');
  });
  const first = await session.submit({ runId: 'first', task: 'Original work.' });
  assert.equal(first.kind, 'started');
  const queued = await session.submit({ runId: 'second', task: 'Later original user contribution.' });
  assert.equal(queued.kind, 'queued');
  controls.get('first')({
    state: 'ended',
    terminal: testTerminal({ runId: 'first' }),
    deliveryDiagnostics: []
  });
  assert.equal((await first.completion).outcome.stage, 'awaiting_reconciliation');
  await session.waitForIdle();
  assert.equal(controls.has('second'), false);
  assert.equal(session.state().pendingSettlement.runId, 'first');
  assert.equal(
    (await repository.loadPendingSubmissions(descriptor))[0].input.task,
    'Later original user contribution.'
  );
  reconciled = true;
  await session.reconcileWork('first');
  assert.equal(controls.has('second'), true);
  controls.get('second')({
    state: 'ended',
    terminal: testTerminal({ runId: 'second' }),
    deliveryDiagnostics: []
  });
  assert.equal((await queued.completion).terminal.runId, 'second');
  await session.waitForIdle();
  assert.equal(session.state().pendingSettlement, undefined);
  assert.equal(session.state().queuedInputs, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeAgentTerminalSnapshot } from '@agent-core/runtime';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { createTuiRuntime, runTui } from '@ismail-elkorchi/terminal-ui/tui';
import {
  CodingAgentTuiEventSource,
  createCodingAgentTuiApp,
  runCodingAgentTuiApp
} from '@ismail-elkorchi/coding-agent/tui';
import { waitFor } from './coding-agent-tui-test-helpers.js';

test('durable restore precedes live append and stable identities prevent duplicates', async () => {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 20 } });
  const events = new CodingAgentTuiEventSource();
  const hydration = runningHydration();
  const running = runTui(createCodingAgentTuiApp('', {
    eventSource: events,
    initialHydration: hydration,
    commandHandler: { execute: () => ({ message: 'Exiting.', exit: true }) }
  }), { host });
  await waitFor(() => host.frames().length > 0);

  await events.enqueue({
    type: 'progress',
    event: { type: 'turn.started', runId: 'run-1', sessionId: 'session-1', turnIndex: 1, turnId: 'turn-1', requestAttempt: 1 }
  });
  await events.enqueue({
    type: 'progress',
    event: { type: 'assistant.delta', turnIndex: 1, turnId: 'turn-1', requestAttempt: 1, delta: ' restored', accumulated: 'Partial restored' }
  });
  await events.enqueue({
    type: 'progress',
    event: {
      type: 'assistant.ended', turnIndex: 1, turnId: 'turn-1', requestAttempt: 1,
      content: 'Partial restored',
      candidate: { status: 'complete', message: 'Partial restored', source: 'content', turnIndex: 1 }
    }
  });
  host.input('/exit\r');
  const exit = await running;
  await events.close();

  assert.equal(exit.state.conversation.items.filter((entry) => entry.kind === 'user' && entry.text === 'Existing task').length, 1);
  assert.equal(exit.state.conversation.items.filter((entry) => entry.kind === 'assistant' && entry.turnId === 'turn-1').length, 1);
  assert.equal(exit.state.conversation.items.find((entry) => entry.id === 'assistant:turn-1').text, 'Partial restored');
  assert.equal(exit.state.debug.session.sessionId, 'session-1');
  assert.equal(exit.state.debug.operations[0].state.control.status, 'owned');
});

test('hydration restores exact approval and unknown-effect recovery boundaries', async () => {
  const approvalRuntime = createTuiRuntime({
    app: createCodingAgentTuiApp('', { initialHydration: approvalHydration() }),
    host: createMemoryTerminalHost({ terminalSize: { columns: 90, rows: 18 } })
  });
  await approvalRuntime.start();
  assert.equal(approvalRuntime.state().run.kind, 'waiting_for_approval');
  assert.equal(approvalRuntime.state().run.suspension.pendingApprovals[0].approvalId, 'approval-1');
  assert.ok(approvalRuntime.frame().focusPath.includes('approval-deny'));
  await approvalRuntime.dispose();

  const recoveryRuntime = createTuiRuntime({
    app: createCodingAgentTuiApp('', { initialHydration: recoveryHydration() }),
    host: createMemoryTerminalHost({ terminalSize: { columns: 90, rows: 18 } })
  });
  await recoveryRuntime.start();
  assert.equal(recoveryRuntime.state().run.kind, 'waiting_for_recovery');
  assert.equal(recoveryRuntime.state().run.suspension.effectId, 'effect-unknown');
  assert.ok(recoveryRuntime.state().conversation.items.some((entry) => entry.kind === 'notice' && entry.text.includes('effect-unknown')));
  await recoveryRuntime.dispose();
});

test('recovered queued operations surface queue and driver control', async () => {
  const hydration = baseHydration({ phase: 'idle', queuedInputs: 1 }, {
    pendingState: 'claimed',
    control: { status: 'detached' },
    phase: { kind: 'preparing', step: 'assemble_turn', turnIndex: 2 }
  });
  const host = createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 16 } });
  const runtime = createTuiRuntime({
    app: createCodingAgentTuiApp('', { initialHydration: hydration }),
    host
  });
  await runtime.start();
  assert.equal(runtime.state().run.kind, 'working');
  assert.equal(runtime.state().run.label, 'Recovered operation queued');
  assert.match(host.output(), /1 queued · driver detached/u);
  await runtime.dispose();
});

test('completed hydration surfaces terminal checks and persisted workspace changes', async () => {
  const runtime = createTuiRuntime({
    app: createCodingAgentTuiApp('', { initialHydration: completedHydration() }),
    host: createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 18 } })
  });
  await runtime.start();
  assert.equal(runtime.state().run.kind, 'ended');
  assert.equal(runtime.state().run.terminal.runId, 'run-1');
  assert.equal(runtime.state().conversation.items.find((entry) => entry.id === 'check:run-1:tests').status, 'success');
  const changes = runtime.state().conversation.items.find((entry) => entry.id === 'change:run-1');
  assert.equal(changes.status, 'success');
  assert.match(changes.summary, /1 changed path.*no remaining uncertainty/u);
  assert.match(changes.details, /Remaining uncertainty\nnone/u);
  const history = runtime.state().conversation.items.find((entry) => entry.id === 'session:history');
  assert.equal(history.activity, 'history');
  assert.match(history.summary, /1 branch point · 1 terminal run/u);
  assert.match(history.details, /final assistant-1 · run run-1 · completed · verification passed · candidate complete/u);
  await runtime.dispose();
});

test('long stream pressure retains every reliable boundary and the latest stream value', async () => {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 80, rows: 12 } });
  const events = new CodingAgentTuiEventSource();
  const running = runTui(createCodingAgentTuiApp('', {
    eventSource: events,
    commandHandler: { execute: () => ({ message: 'Exiting.', exit: true }) }
  }), { host });
  await waitFor(() => host.frames().length > 0);
  await events.enqueue({
    type: 'progress',
    event: { type: 'turn.started', runId: 'pressure-run', turnIndex: 1, turnId: 'pressure-turn', requestAttempt: 1 }
  });
  const admissions = [];
  for (let index = 0; index < 1_100; index += 1) {
    admissions.push(events.enqueue({
      type: 'progress',
      event: {
        type: 'assistant.delta', turnIndex: 1, turnId: 'pressure-turn', requestAttempt: 1,
        delta: 'x', accumulated: `value-${String(index)}`
      }
    }));
  }
  await Promise.all(admissions);
  await events.enqueue({
    type: 'progress',
    event: {
      type: 'assistant.ended', turnIndex: 1, turnId: 'pressure-turn', requestAttempt: 1,
      content: 'final-value',
      candidate: { status: 'complete', message: 'final-value', source: 'content', turnIndex: 1 }
    }
  });
  host.input('/exit\r');
  const exit = await running;
  await events.close();
  const assistant = exit.state.conversation.items.find((entry) => entry.id === 'assistant:pressure-turn');
  assert.equal(assistant.text, 'final-value');
  assert.equal(assistant.status, 'complete');
});

test('composer history restores the draft and tiny resizes preserve focus', async () => {
  const submitted = [];
  const host = createMemoryTerminalHost({ terminalSize: { columns: 80, rows: 16 } });
  const runtime = createTuiRuntime({
    app: createCodingAgentTuiApp('', {
      commandHandler: { execute(line) { submitted.push(line); return { message: 'done' }; } }
    }),
    host,
    initialFocus: { kind: 'element', elementId: 'composer' }
  });
  await runtime.start();
  await send(runtime, 'first');
  await send(runtime, 'second');
  await runtime.handleInput({ kind: 'text', text: 'draft', paste: false });
  await runtime.handleInput(key('arrowUp'));
  assert.equal(composerText(runtime), 'second');
  await runtime.handleInput(key('arrowUp'));
  assert.equal(composerText(runtime), 'first');
  await runtime.handleInput(key('arrowDown'));
  assert.equal(composerText(runtime), 'second');
  await runtime.handleInput(key('arrowDown'));
  assert.equal(composerText(runtime), 'draft');
  await runtime.handleInput(key('p', { ctrl: true }));
  assert.equal(runtime.state().overlay.kind, 'commands');
  await runtime.resize({ columns: 12, rows: 4 });
  assert.ok(runtime.frame().accessibility.root);
  await runtime.handleInput(key('escape'));
  assert.equal(runtime.state().overlay.kind, 'none');
  assert.ok(runtime.frame().focusPath.includes('composer'));
  assert.deepEqual(submitted, ['first', 'second']);
  await runtime.dispose();
});

test('event source cancellation and dispatch failure terminate explicitly', async () => {
  const cancelled = new CodingAgentTuiEventSource();
  const controller = new AbortController();
  const cancellation = cancelled.run(sourceContext(controller.signal), { emit: async () => {} });
  await cancelled.enqueue({ type: 'app.exit', reason: 'before-cancel' });
  controller.abort();
  await cancellation;
  await cancelled.close();
  await assert.rejects(cancelled.enqueue({ type: 'app.exit' }), /closed/u);

  const failed = new CodingAgentTuiEventSource();
  const sourceRun = failed.run(sourceContext(new AbortController().signal), {
    emit: async () => { throw new Error('dispatch exploded'); }
  });
  await assert.rejects(failed.enqueue({ type: 'app.exit' }), /dispatch exploded/u);
  await assert.rejects(sourceRun, /dispatch exploded/u);
  const lifecycle = failed.onLifecycle({
    kind: 'failed', id: failed.id, generation: failed.generation,
    diagnostic: { code: 'TUI_SOURCE_FAILED', message: 'delivery failed', severity: 'error' }
  });
  assert.equal(lifecycle.type, 'delivery.failed');
  await assert.rejects(failed.close(), /dispatch exploded/u);
});

test('normal shutdown drains admitted messages without source diagnostics', async () => {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 60, rows: 10 } });
  const events = new CodingAgentTuiEventSource();
  const running = runTui(createCodingAgentTuiApp('', {
    eventSource: events,
    commandHandler: { execute: () => ({ message: 'Exiting.', exit: true }) }
  }), { host });
  await waitFor(() => host.frames().length > 0);
  await events.enqueue({ type: 'failure', message: 'visible before shutdown' });
  host.input('/exit\r');
  const exit = await running;
  await events.close();
  assert.ok(exit.state.conversation.items.some((entry) => entry.kind === 'notice' && entry.text === 'visible before shutdown'));
  assert.equal(exit.diagnostics.filter((item) => item.diagnostic.code === 'TUI_SOURCE_FAILED').length, 0);
});

test('application exit unsubscribes delivery before cancelling an active session', async () => {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 70, rows: 12 } });
  let subscribed = false;
  let aborted;
  let sessionState = {
    sessionId: 'session-1', phase: 'running', activeRunId: 'run-1', queuedInputs: 0,
    configuration: { provider: 'test-provider', model: 'test-model' }
  };
  const session = {
    state: () => sessionState,
    async restore() {},
    subscribe() {
      subscribed = true;
      return () => { subscribed = false; };
    },
    async abort(reason, runId) {
      assert.equal(subscribed, false);
      aborted = { reason, runId };
      sessionState = {
        sessionId: 'session-1', phase: 'idle', queuedInputs: 0,
        configuration: { provider: 'test-provider', model: 'test-model' }
      };
      return true;
    },
    async waitForIdle() { assert.equal(sessionState.phase, 'idle'); },
    async resumePending() {},
    async submit() { throw new Error('unexpected submission'); },
    async resolveApproval() { throw new Error('unexpected approval'); }
  };
  const running = runCodingAgentTuiApp(session, { host });
  await waitFor(() => host.frames().length > 0);
  host.input('/exit\r');
  const result = await running;
  assert.equal(result.exit.status, 'completed');
  assert.deepEqual(aborted, { reason: 'Coding Agent TUI closed.', runId: 'run-1' });
  assert.equal(subscribed, false);
});

function runningHydration() {
  const hydration = baseHydration({ phase: 'running', activeRunId: 'run-1', queuedInputs: 0 }, {
    pendingState: 'claimed',
    control: { status: 'owned', driverId: 'driver-1' },
    phase: { kind: 'preparing', step: 'assemble_turn', turnIndex: 1 }
  });
  return {
    ...hydration,
    replay: {
      ...hydration.replay,
      branch: [
        entry({ id: 'input-1', type: 'input', runId: 'run-1', task: 'Existing task', instructions: [] }),
        entry({ id: 'assistant-1', type: 'assistant', runId: 'run-1', turnIndex: 1, turnId: 'turn-1', requestAttempt: 1, content: 'Partial' })
      ],
      ledgerRunIds: ['run-1']
    }
  };
}

function approvalHydration() {
  return baseHydration({ phase: 'waiting_for_user', activeRunId: 'run-1', queuedInputs: 0, suspensionReason: 'approval_required' }, {
    pendingState: 'suspended',
    control: { status: 'detached' },
    phase: { kind: 'approval', approval: approvalRequest() },
    budget: budget()
  });
}

function recoveryHydration() {
  return baseHydration({ phase: 'waiting_for_user', activeRunId: 'run-1', queuedInputs: 0, suspensionReason: 'tool_outcome_unknown' }, {
    pendingState: 'suspended',
    control: { status: 'detached' },
    phase: { kind: 'suspended', reason: 'tool_outcome_unknown', effectId: 'effect-unknown' },
    budget: budget()
  });
}

function completedHydration() {
  const terminal = decodeAgentTerminalSnapshot({
    runId: 'run-1', finalizationId: 'final-1', phase: 'ended', executionStatus: 'completed',
    verificationStatus: 'passed', terminationReason: 'model_completed', modelTerminationReason: 'stop',
    candidate: { status: 'complete', message: 'Completed answer.', source: 'content', turnIndex: 1 },
    turnCount: 1,
    checkResults: [{
      id: 'tests', implementationId: 'tests@1', requirement: 'required', verdict: 'passed',
      summary: 'Tests passed', durationMs: 10
    }],
    budget: budget()
  });
  return {
    session: {
      sessionId: 'session-1', phase: 'idle', queuedInputs: 0,
      configuration: { provider: 'test-provider', model: 'test-model' }
    },
    replay: {
      session: descriptor(),
      branch: [entry({
        id: 'assistant-1', type: 'assistant', runId: 'run-1', turnIndex: 1,
        turnId: 'turn-1', requestAttempt: 1, content: 'Completed answer.'
      })],
      terminalProjections: [{
        type: 'final', id: 'projection-1', timestamp: '2026-08-28T00:00:01.000Z',
        throughEntryId: 'assistant-1', runId: 'run-1', finalizationId: 'final-1', terminal
      }],
      ledgerRunIds: ['run-1']
    },
    branchPoints: [{
      entryId: 'assistant-1', timestamp: '2026-08-28T00:00:01.000Z', kind: 'final',
      runId: 'run-1', finalizationId: 'final-1'
    }],
    pendingSubmissions: [],
    operations: [],
    changeReports: [{
      schemaVersion: 1, runId: 'run-1', baselineDigest: '1'.repeat(64), finalDigest: '2'.repeat(64),
      coverage: 'complete', causes: [],
      changes: [{
        path: 'src/app.ts', kind: 'modified', attribution: 'structured_mutation', initial: 'existing',
        versionControlBaseline: 'not_reported', content: 'text', receiptSequences: [4], conflicts: []
      }],
      totalChanges: 1, omittedChanges: 0, mutationReceipts: [], totalMutationReceipts: 0,
      omittedMutationReceipts: 0,
      facts: {
        changedPaths: ['src/app.ts'], structuredMutationPaths: ['src/app.ts'],
        externalOrConcurrentPaths: [], verificationStatus: 'passed'
      }
    }]
  };
}

function baseHydration(sessionOverrides, operationOverrides) {
  const pendingState = operationOverrides.pendingState;
  const operation = operationInspection({
    ...operationOverrides,
    pendingState: undefined
  });
  return {
    session: {
      sessionId: 'session-1',
      configuration: { provider: 'test-provider', model: 'test-model' },
      ...sessionOverrides
    },
    replay: {
      session: descriptor(), branch: [], terminalProjections: [], ledgerRunIds: ['run-1']
    },
    branchPoints: [],
    pendingSubmissions: [{
      submissionId: 'submission-1', runId: 'run-1', state: pendingState,
      input: { task: 'Existing task' }, configuration: { provider: 'test-provider', model: 'test-model' }
    }],
    operations: [operation],
    changeReports: []
  };
}

function operationInspection(overrides) {
  return {
    state: {
      runId: 'run-1', finalizationId: 'final-1', revision: 1, driverGeneration: 3,
      input: { task: 'Existing task', instructions: [], contextItems: [] },
      configuration: {
        providerId: 'test-provider', providerImplementationId: 'provider@1', model: 'test-model',
        runtimeImplementationId: 'runtime@1', toolImplementationIds: [], checks: [],
        disposition: { implementationId: 'disposition@1', policyIdentity: {}, policyHash: '0'.repeat(64) },
        policyHash: 'policy'
      },
      control: overrides.control,
      phase: overrides.phase,
      toolCalls: [], revisionInstructions: [],
      ...(overrides.budget === undefined ? {} : { budget: overrides.budget })
    },
    transition: { eventId: 'event-1', sequence: 1, hash: '1'.repeat(64) },
    tail: { sequence: 1, hash: '1'.repeat(64), driverGeneration: 3 },
    instruction: { kind: 'wait', reason: 'driver' }
  };
}

function descriptor() {
  return {
    id: 'session-1', leafId: null,
    header: { type: 'session', version: 1, id: 'session-1', timestamp: '2026-08-28T00:00:00.000Z' }
  };
}

function entry(value) {
  return { parentId: null, timestamp: '2026-08-28T00:00:00.000Z', ...value };
}

function approvalRequest() {
  return {
    runId: 'run-1', approvalId: 'approval-1', status: 'pending', toolName: 'exec_command',
    fingerprint: 'fingerprint', input: { command: 'echo ok' },
    effects: { accesses: [{ mode: 'execute', scope: 'workspace/command' }], lockScopes: ['workspace/command'], recovery: { kind: 'unknown' } },
    binding: { toolImplementationId: 'shell@1', authorizationPolicyId: 'policy@1', executionTargetId: 'workspace@1' },
    policyHash: 'policy-hash', reason: 'Command approval required.', turnIndex: 1, turnId: 'turn-1',
    requestAttempt: 1, toolBatchId: 'batch-1', callIndex: 0, callId: 'call-1'
  };
}

function budget() {
  return {
    modelTurns: 1, totalToolCalls: 1, repeatedIdenticalToolCalls: 1, candidateRevisions: 0,
    elapsedMs: 1, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, knownCosts: {}, pricingStatus: 'unknown', unknownPricedTokens: 0,
    consecutiveProviderFailures: 0, consecutiveToolFailures: 0
  };
}

function sourceContext(signal) {
  return {
    signal,
    terminalSize: { columns: 80, rows: 24 },
    previousTerminalSize: { columns: 80, rows: 24 },
    capabilities: { unicode: { widthProfile: 'unicode' } },
    clock: { monotonicNow: () => 0 }
  };
}

async function send(runtime, value) {
  await runtime.handleInput({ kind: 'text', text: value, paste: false });
  await runtime.handleInput(key('enter'));
  await waitFor(() => runtime.state().composer.submissionCount > 0);
}

function composerText(runtime) {
  return textDocumentText(runtime.state().composer.input.document);
}

function key(name, modifiers = {}) {
  return {
    kind: 'key', key: name, eventType: 'press', location: 'standard',
    modifiers: { ctrl: false, alt: false, shift: false, meta: false, ...modifiers }
  };
}

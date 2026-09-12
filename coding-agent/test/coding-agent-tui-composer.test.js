import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { createCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';

test('composer sends with Enter and inserts newlines with Shift+Enter and Ctrl+O', async () => {
  const submitted = [];
  const host = createMemoryTerminalHost({ terminalSize: { columns: 80, rows: 16 } });
  const runtime = createTuiRuntime({
    app: createCodingAgentTuiApp('', {
      commandHandler: {
        execute(line) {
          submitted.push(line);
          return { message: 'Run started.' };
        }
      }
    }),
    host,
    initialFocus: { kind: 'element', elementId: 'composer' }
  });
  await runtime.start();

  await runtime.handleInput({ kind: 'text', text: 'first', paste: false });
  await runtime.handleInput(key('enter', { shift: true }));
  await runtime.handleInput({ kind: 'text', text: 'second', paste: false });
  await runtime.handleInput(key('o', { ctrl: true }));
  await runtime.handleInput({ kind: 'text', text: 'third', paste: false });
  assert.equal(textDocumentText(runtime.state().composer.input.document), 'first\nsecond\nthird');

  await runtime.handleInput(key('enter'));
  await waitFor(() => submitted.length === 1 && !runtime.state().composer.submitting);
  assert.deepEqual(submitted, ['first\nsecond\nthird']);
  assert.equal(textDocumentText(runtime.state().composer.input.document), '');
  await runtime.dispose();
});

function key(name, modifiers = {}) {
  return {
    kind: 'key',
    key: name,
    eventType: 'press',
    location: 'standard',
    modifiers: { ctrl: false, alt: false, shift: false, meta: false, ...modifiers }
  };
}

async function waitFor(condition) {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for command effect.');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('approval dialogs focus Deny and Escape also denies', async () => {
  const decisions = [];
  const host = createMemoryTerminalHost({ terminalSize: { columns: 90, rows: 20 } });
  const suspension = approvalSuspension();
  const runtime = createTuiRuntime({
    app: createCodingAgentTuiApp('', {
      approvalHandler(_suspension, decision) {
        decisions.push(decision);
        return Promise.resolve(suspension);
      }
    }),
    host,
    initialFocus: { kind: 'element', elementId: 'composer' }
  });
  await runtime.start();
  await runtime.dispatch({ type: 'approval.required', suspension });
  await runtime.handleInput(key('enter'));
  await waitFor(() => decisions.length === 1);
  assert.equal(decisions[0], 'deny');

  await runtime.handleInput(key('escape'));
  await waitFor(() => decisions.length === 2);
  assert.equal(decisions[1], 'deny');
  await runtime.dispose();
});

test('non-approval suspensions remain distinct recovery decisions', async () => {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 90, rows: 20 } });
  const runtime = createTuiRuntime({
    app: createCodingAgentTuiApp(''),
    host,
    initialFocus: { kind: 'element', elementId: 'composer' }
  });
  await runtime.start();
  await runtime.dispatch({
    type: 'run.suspended',
    suspension: {
      state: 'suspended',
      reason: 'tool_outcome_unknown',
      runId: 'run',
      finalizationId: 'final',
      effectId: 'effect',
      budget: approvalSuspension().budget
    }
  });
  assert.equal(runtime.state().run.kind, 'waiting_for_recovery');
  assert.equal(runtime.state().run.suspension.reason, 'tool_outcome_unknown');
  await runtime.dispose();
});

function approvalSuspension() {
  return {
    state: 'suspended',
    reason: 'approval_required',
    runId: 'run',
    finalizationId: 'final',
    pendingApprovals: [
      {
        runId: 'run',
        approvalId: 'approval',
        status: 'pending',
        toolName: 'exec_command',
        fingerprint: 'fingerprint',
        input: { command: 'echo ok' },
        effects: {
          accesses: [{ mode: 'execute', scope: 'workspace/command' }],
          lockScopes: ['workspace/command'],
          recovery: { kind: 'unknown' }
        },
        binding: {
          toolImplementationId: 'shell@1',
          authorizationPolicyId: 'policy@1',
          executionTargetId: 'workspace@1'
        },
        policyHash: 'policy-hash',
        reason: 'Shell execution requires approval.',
        turnIndex: 1,
        turnId: 'turn-1',
        requestAttempt: 1,
        toolBatchId: 'batch-1',
        callIndex: 0,
        callId: 'call-1'
      }
    ],
    budget: {
      modelTurns: 1,
      totalToolCalls: 1,
      elapsedMs: 1,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      knownCosts: {},
      pricingStatus: 'unknown',
      unknownPricedTokens: 0,
      consecutiveProviderFailures: 0,
      consecutiveToolFailures: 0
    }
  };
}

for (const columns of [48, 100]) test(`interrupted runs expose recovery actions at ${columns} columns and preserve drafts`, async (t) => {
  const { renderFramePlain } = await import('@ismail-elkorchi/terminal-ui/renderer');
  const actions = [];
  const submitted = [];
  const runtime = createTuiRuntime({
    host: createMemoryTerminalHost({ terminalSize: { columns, rows: 26 } }),
    app: createCodingAgentTuiApp('', {
      recoveryHandler: async (suspension, action) => { actions.push([suspension.runId, action]); return 'No recorded result is available yet.'; },
      commandHandler: { execute(value) { submitted.push(value); return { message: 'Sent' }; } }
    }),
    initialFocus: { kind: 'element', elementId: 'composer' }
  });
  t.after(() => runtime.dispose());
  await runtime.start();
  await runtime.handleInput({ kind: 'text', text: 'Keep my next instruction', paste: false });
  await runtime.dispatch({ type: 'progress', event: { type: 'assistant.started', turnId: 'first', turnIndex: 1, requestAttempt: 1 } });
  assert.equal(runtime.state().conversation.items.some(item => item.kind === 'assistant'), false);
  assert.doesNotMatch(renderFramePlain(runtime.frame()), /Assistant/);
  await runtime.dispatch({ type: 'progress', event: { type: 'model.failed', turnId: 'first', turnIndex: 1, requestAttempt: 1,
    diagnostic: { provider: 'fixture', code: 'provider_unavailable', retryable: true, causeSummary: { message: 'Connection closed' } }
  } });
  await runtime.dispatch({ type: 'run.suspended', suspension: {
    ...approvalSuspension(), reason: 'provider_outcome_unknown', effectId: 'request'
  } });
  const frame = renderFramePlain(runtime.frame());
  assert.match(frame, /Response interrupted/);
  assert.match(frame, /Connection closed/);
  assert.match(frame, /Stop this run/);
  assert.match(frame, /Check for a recorded result/);
  assert.doesNotMatch(frame, /Enter send/);
  await runtime.dispatch({ type: 'composer.submit' });
  assert.deepEqual(submitted, []);
  assert.equal(textDocumentText(runtime.state().composer.input.document), 'Keep my next instruction');
  await runtime.handleInput(key('tab'));
  await runtime.handleInput(key('enter'));
  await waitFor(() => actions.length === 1 && runtime.state().run.operation === undefined);
  assert.deepEqual(actions, [['run', 'resume']]);
  assert.match(renderFramePlain(runtime.frame()), /No recorded result/);
  await runtime.handleInput(key('c', { ctrl: true }));
  await waitFor(() => actions.length === 2);
  assert.deepEqual(actions[1], ['run', 'stop']);
  assert.equal(textDocumentText(runtime.state().composer.input.document), 'Keep my next instruction');
});

test('tool-only and failed turns never create empty assistant messages; interrupted text stays visible', async (t) => {
  const runtime = createTuiRuntime({ host: createMemoryTerminalHost({ terminalSize: { columns: 90, rows: 24 } }), app: createCodingAgentTuiApp('') });
  t.after(() => runtime.dispose());
  await runtime.start();
  const identity = { turnId: 'first', turnIndex: 1, requestAttempt: 1 };
  await runtime.dispatch({ type: 'progress', event: { type: 'assistant.ended', ...identity, content: '', modelOutput: { status: 'absent' } } });
  assert.equal(runtime.state().conversation.items.some(item => item.kind === 'assistant'), false);
  await runtime.dispatch({ type: 'progress', event: { type: 'assistant.delta', ...identity, accumulated: 'Partial answer', delta: 'Partial answer' } });
  await runtime.dispatch({ type: 'progress', event: { type: 'assistant.interrupted', ...identity, content: 'Partial answer', finalResponseReceived: false,
    modelOutput: { status: 'partial', message: 'Partial answer', source: 'stream_recovery', turnIndex: 1 }
  } });
  const assistant = runtime.state().conversation.items.find(item => item.kind === 'assistant');
  assert.equal(assistant.text, 'Partial answer');
  assert.equal(assistant.status, 'interrupted');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EvaluationMetrics } from '../../validation/evaluation-metrics.mjs';

test('evaluation counts rejected calls, retries, and domain outcomes independently', () => {
  const metrics = new EvaluationMetrics();
  const identity = { turnId: 'turn', requestAttempt: 1, toolBatchId: 'batch', callIndex: 0, callId: 'call' };
  const event = (type, callIndex, fields = {}) => ({ ...identity, type, callIndex, toolAttempt: 1, ...fields });
  const result = (output, executionState = 'settled') => ({ kind: 'result', execution: { state: executionState },
    scope: { coverage: 'complete' }, output });
  metrics.record(event('tool.call.received', 0, { toolCall: { id: 'call', name: 'update_working_state' } }));
  const rejected = event('tool.ended', 0, { toolName: 'update_working_state', observation: {
    kind: 'failure', execution: { state: 'not_started' }, scope: { coverage: 'complete' },
    output: { reason: 'invalid_arguments' }
  } });
  metrics.record(rejected);
  metrics.record(rejected);
  metrics.record(event('tool.started', 0, { toolAttempt: 2, toolName: 'update_working_state', input: { id: 'call' } }));
  metrics.record(event('tool.ended', 0, { toolAttempt: 2, toolName: 'update_working_state', observation: result({ status: 'conflict' }) }));
  metrics.record(event('tool.started', 1, { toolName: 'exec_command', input: { id: 'command' } }));
  metrics.record(event('tool.ended', 1, { toolName: 'exec_command', observation: result({ status: 'exited', exitCode: 7 }) }));
  metrics.record(event('tool.ended', 2, { toolName: 'read_files', observation: result({ coverage: 'partial' }) }));
  const measured = metrics.toJSON();
  assert.equal(measured.toolCallCount, 3);
  assert.equal(measured.invocationAttemptCount, 4);
  assert.equal(measured.invokedAttemptCount, 2);
  assert.equal(measured.rejectedBeforeInvocationCount, 1);
  assert.equal(measured.failureObservationCount, 1);
  assert.equal(measured.toolCalls[0].attempts[1].domain.status, 'conflict');
  assert.equal(measured.toolCalls[1].attempts[0].domain.exitCode, 7);
  assert.equal(measured.toolCalls[2].attempts[0].domain.coverage, 'partial');
  assert.equal(measured.toolCalls[2].attempts[0].observationKind, 'result');
  assert.deepEqual(JSON.parse(JSON.stringify(metrics)), measured);
});

test('admission estimates do not substitute for provider token usage', () => {
  const metrics = new EvaluationMetrics();
  metrics.record({ type: 'model.requested', estimate: { totalPromptTokens: 123, toolSchemaTokens: 45 } });
  const measured = metrics.toJSON();
  assert.equal(measured.estimatedGenerationPromptTokens, 123);
  assert.equal(measured.estimatedGenerationToolSchemaTokens, 45);
  assert.equal(measured.promptTokens, undefined);
});

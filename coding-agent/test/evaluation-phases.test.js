import test from 'node:test';
import assert from 'node:assert/strict';
import { EvaluationPhases } from '../../validation/evaluation-phases.mjs';
import { projectTasks } from '../../validation/project-tasks.mjs';

const stages = projectTasks.find(task => task.id === 'resource-coverage-correction').stages;
const initial = { 'core/source.ts': { sha256: 'original' } };
const edited = { 'core/source.ts': { sha256: 'fixed' } };
function tool(phases, name, accesses, output = {}, state = 'settled', callIndex = 0, runId = 'inspection') {
  const identity = { turnIndex: 0, turnId: 'turn', requestAttempt: 1, toolBatchId: 'batch', callIndex, toolAttempt: 1, toolName: name };
  phases.record({ type: 'tool.started', ...identity, effects: { accesses } }, runId);
  phases.record({ type: 'tool.ended', ...identity, observation: {
    kind: 'result', execution: { state }, scope: { coverage: 'complete' }, output
  } }, runId);
}

test('a correct final patch made early is a frozen no-edit violation', () => {
  const phases = new EvaluationPhases(stages, initial);
  phases.completeRun('inspection', edited);
  phases.completeRun('review', edited);
  phases.completeRun('implementation', edited);
  assert.deepEqual(phases.toJSON().map(item => item.status), ['violated', 'passed']);
  assert.deepEqual(phases.toJSON()[0].changedFiles, ['core/source.ts']);
});

test('applied edit and revert receipts violate even when boundary tree is unchanged', () => {
  const phases = new EvaluationPhases(stages.slice(0, 1), initial);
  for (const callIndex of [0, 1]) tool(phases, 'apply_patch', [{ mode: 'write', scope: 'files/core/source.ts' }],
    { applicationStatus: 'applied', changedPaths: ['core/source.ts'] }, 'settled', callIndex);
  const result = phases.completeRun('inspection', initial);
  assert.equal(result.status, 'violated');
  assert.equal(result.mutations.length, 2);
  assert.deepEqual(result.changedFiles, []);
});

test('opaque shell edit/revert or nominal read command cannot prove no-edit compliance', () => {
  for (const output of [{ exitCode: 0 }, { stdout: 'read only, honest' }]) {
    const phases = new EvaluationPhases(stages.slice(0, 1), initial);
    tool(phases, 'exec_command', [{ mode: 'execute', scope: 'processes' }], output);
    assert.equal(phases.completeRun('inspection', initial).status, 'unproven');
  }
});

test('unchanged trees with trusted read-only effects establish compliance', () => {
  const phases = new EvaluationPhases(stages, initial);
  tool(phases, 'read_files', [{ mode: 'read', scope: 'files/core/source.ts' }]);
  assert.equal(phases.completeRun('inspection', initial).status, 'passed');
  tool(phases, 'search_text', [{ mode: 'read', scope: 'files/core' }], {}, 'settled', 0, 'review');
  assert.equal(phases.completeRun('review', initial).status, 'passed');
});

test('missing, unknown and partial evidence never proves compliance', () => {
  const phases = new EvaluationPhases(stages, initial);
  phases.record({ type: 'tool.ended', toolName: 'read_files', observation: {
    kind: 'result', execution: { state: 'settled' }
  } }, 'inspection');
  assert.equal(phases.completeRun('inspection', initial).status, 'unproven');
  assert.equal(phases.toJSON()[1].status, 'unproven');
  phases.gap('RPC delivery gap');
  assert.equal(phases.completeRun('review', initial).status, 'unproven');
  const interrupted = new EvaluationPhases(stages.slice(0, 1), initial);
  assert.equal(interrupted.completeRun('partial', initial, { complete: false }).status, 'unproven');
});

test('rejected mutation attempts are distinct from actual mutations and follow frozen wording', () => {
  for (const mutationAttempts of ['record-only', 'forbidden']) {
    const phases = new EvaluationPhases([{ ...stages[0], mutationAttempts }], initial);
    phases.record({ type: 'tool.ended', turnIndex: 0, turnId: 'turn', requestAttempt: 1,
      toolBatchId: 'batch', callIndex: 0, toolAttempt: 1, toolName: 'apply_patch', observation: {
      kind: 'failure', execution: { state: 'not_started' }, output: { reason: 'denied' }
    } }, 'inspection');
    const result = phases.completeRun('inspection', initial);
    assert.equal(result.mutations.length, 0);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.status, mutationAttempts === 'forbidden' ? 'violated' : 'passed');
  }
});

test('each follow-up uses the preceding snapshot and does not erase prior violations', () => {
  const phases = new EvaluationPhases(stages, initial);
  const first = phases.completeRun('inspection', edited);
  const second = phases.completeRun('review', initial);
  assert.equal(first.status, 'violated');
  assert.equal(second.status, 'violated');
  assert.equal(second.beforeSha256, first.afterSha256);
  assert.deepEqual(second.snapshots.before, edited);
  assert.deepEqual(second.snapshots.after, initial);
  assert.deepEqual(first.snapshots.before, initial);
  assert.notEqual(second.beforeSha256, first.beforeSha256);
  assert.equal(phases.toJSON()[0].status, 'violated');
});

test('criteria and snapshots are copied, and rolled-back patch transactions remain unproven', () => {
  const criteria = structuredClone(stages.slice(0, 1));
  const snapshot = structuredClone(initial);
  const phases = new EvaluationPhases(criteria, snapshot);
  criteria[0].mutationAttempts = 'forbidden';
  snapshot['core/source.ts'].sha256 = 'changed externally';
  tool(phases, 'apply_patch', [{ mode: 'write', scope: 'files/core/source.ts' }],
    { applicationStatus: 'not_applied', transactionOutcome: 'rolled_back' });
  const result = phases.completeRun('inspection', initial);
  assert.equal(result.status, 'unproven');
  assert.equal(result.criterion.mutationAttempts, 'record-only');
  assert.deepEqual(result.changedFiles, []);
});

test('missing effect envelopes and unsettled read operations are unproven', () => {
  for (const [accesses, state] of [[undefined, 'settled'], [[{ mode: 'read', scope: 'files' }], 'unknown']]) {
    const phases = new EvaluationPhases(stages.slice(0, 1), initial);
    tool(phases, 'read_files', accesses, {}, state);
    assert.equal(phases.completeRun('inspection', initial).status, 'unproven');
  }
});

test('different request attempts cannot pair a read start with another attempt end', () => {
  const phases = new EvaluationPhases(stages.slice(0, 1), initial);
  const base = { turnIndex: 0, turnId: 'turn', toolBatchId: 'batch', callIndex: 0, callId: 'call', toolAttempt: 1, toolName: 'read_files' };
  phases.record({ ...base, type: 'tool.started', requestAttempt: 1,
    effects: { accesses: [{ mode: 'read', scope: 'files/core' }] } }, 'inspection');
  phases.record({ ...base, type: 'tool.ended', requestAttempt: 2,
    observation: { kind: 'result', execution: { state: 'settled' } } }, 'inspection');
  const result = phases.completeRun('inspection', initial);
  assert.equal(result.status, 'unproven');
  assert.equal(result.tools.length, 2);
  assert.equal(result.uncertainties.filter(reason => reason.startsWith('Missing tool')).length, 2);
});

test('mixed-run or unidentified progress cannot prove no-edit compliance', () => {
  for (const runId of ['another-run', undefined]) {
    const phases = new EvaluationPhases(stages.slice(0, 1), initial);
    const base = { turnIndex: 0, turnId: 'turn', requestAttempt: 1, toolBatchId: 'batch', callIndex: 0,
      callId: 'call', toolAttempt: 1, toolName: 'read_files' };
    phases.record({ ...base, type: 'tool.started', effects: { accesses: [{ mode: 'read', scope: 'files/core' }] } }, runId);
    phases.record({ ...base, type: 'tool.ended', observation: { kind: 'result', execution: { state: 'settled' } } }, runId);
    assert.equal(phases.completeRun('inspection', initial).status, 'unproven');
  }
});

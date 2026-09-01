import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeAgentTerminalSnapshot } from '@agent-core/runtime';
import { codingChangeUncertainties, codingRunUncertainties } from '../dist/presentation/run-summary.js';

test('coding summaries derive every remaining uncertainty from machine facts', () => {
  const terminal = decodeAgentTerminalSnapshot({
    ...terminalInput(),
    verificationStatus: 'inconclusive',
    checkResults: [{
      id: 'tests', implementationId: 'tests@1', requirement: 'required', verdict: 'unknown',
      summary: 'Sandbox was unavailable.', durationMs: 3
    }]
  });
  const report = changeReport({
    coverage: 'partial',
    causes: ['final:entry_limit'],
    changes: [{
      path: 'src/app.ts', kind: 'modified', attribution: 'external_or_concurrent', initial: 'existing',
      preChangeVersionControl: 'changed', content: 'text', receiptSequences: [4],
      conflicts: ['final_state_does_not_match_structured_mutation_receipts']
    }],
    facts: {
      changedPaths: ['src/app.ts'], structuredMutationPaths: [],
      externalOrConcurrentPaths: ['src/app.ts'], verificationStatus: 'inconclusive'
    }
  });
  assert.deepEqual(codingRunUncertainties(terminal, report), [
    'Check tests is unknown: Sandbox was unavailable.',
    'Change coverage is partial: final — entry limit.',
    'Change attribution is external or concurrent for: src/app.ts.',
    'Mutation receipts conflict with src/app.ts: final state does not match structured mutation receipts.'
  ]);
  assert.deepEqual(codingChangeUncertainties(report), [
    'Change coverage is partial: final — entry limit.',
    'Change attribution is external or concurrent for: src/app.ts.',
    'Mutation receipts conflict with src/app.ts: final state does not match structured mutation receipts.'
  ]);
  assert.throws(() => codingRunUncertainties(terminal, { ...report, runId: 'other' }), /cannot summarize/u);

  const partial = decodeAgentTerminalSnapshot({
    ...terminalInput(),
    terminationReason: 'model_output_limit', modelTerminationReason: 'output_limit',
    modelOutput: { status: 'partial', message: 'Only part of the task completed.', source: 'content', turnIndex: 1 }
  });
  assert.deepEqual(codingRunUncertainties(partial, changeReport()), ['The model output is partial.']);
});

test('a complete model output with passed verification and exact changes has no uncertainty', () => {
  assert.deepEqual(codingRunUncertainties(
    decodeAgentTerminalSnapshot(terminalInput()),
    changeReport()
  ), []);
});

function terminalInput() {
  return {
    runId: 'run-1', finalizationId: 'final-1', phase: 'ended', executionStatus: 'completed',
    verificationStatus: 'passed', terminationReason: 'model_completed', modelTerminationReason: 'stop',
    modelOutput: { status: 'complete', message: 'Done.', source: 'content', turnIndex: 1 },
    turnCount: 1, checkResults: [],
    budget: {
      modelTurns: 1, totalToolCalls: 0, repeatedIdenticalToolCalls: 0, revisionAttempts: 0,
      elapsedMs: 1, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, knownCosts: {}, pricingStatus: 'unknown', unknownPricedTokens: 0,
      consecutiveProviderFailures: 0, consecutiveToolFailures: 0
    }
  };
}

function changeReport(overrides = {}) {
  const changes = overrides.changes ?? [];
  return {
    schemaVersion: 1, runId: 'run-1', preChangeDigest: '1'.repeat(64), finalDigest: '2'.repeat(64),
    coverage: 'complete', causes: [], changes, totalChanges: changes.length, omittedChanges: 0,
    mutationReceipts: [], totalMutationReceipts: 0, omittedMutationReceipts: 0,
    facts: { changedPaths: [], structuredMutationPaths: [], externalOrConcurrentPaths: [], verificationStatus: 'passed' },
    ...overrides
  };
}

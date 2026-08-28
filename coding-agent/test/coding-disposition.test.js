import assert from 'node:assert/strict';
import test from 'node:test';
import { CODING_AGENT_DISPOSITION } from '../dist/verification/coding-disposition.js';

test('coding disposition revises only proven required check failures', () => {
  assert.deepEqual(CODING_AGENT_DISPOSITION.evaluate(dispositionInput([])), { kind: 'accept' });
  assert.deepEqual(CODING_AGENT_DISPOSITION.evaluate(dispositionInput([
    check('advisory', 'failed'),
    check('required-unknown', 'unknown')
  ])), { kind: 'accept' });

  const decision = CODING_AGENT_DISPOSITION.evaluate(dispositionInput([
    check('lint\ncheck', 'failed', '  Unexpected   token.  '),
    check('advisory', 'failed')
  ]));
  assert.equal(decision.kind, 'revise');
  assert.match(decision.instruction, /Required verification failed for the exact candidate/u);
  assert.match(decision.instruction, /repair the underlying defect without weakening or bypassing the verifier/u);
  assert.match(decision.instruction, /- lint check: Unexpected token\./u);
  assert.doesNotMatch(decision.instruction, /advisory/u);
});

test('coding disposition bounds failure evidence supplied for revision', () => {
  const checks = Array.from({ length: 25 }, (_, index) => check(`check-${String(index)}`, 'failed', 'x'.repeat(500)));
  const decision = CODING_AGENT_DISPOSITION.evaluate(dispositionInput(checks));
  assert.equal(decision.kind, 'revise');
  assert.match(decision.instruction, /5 additional failed required checks omitted/u);
  assert.ok(decision.instruction.length < 8_000);
});

function dispositionInput(checkResults) {
  return {
    candidate: { status: 'complete', message: 'candidate', source: 'content', turnIndex: 1 },
    checkResults,
    budget: {
      modelTurns: 1, totalToolCalls: 0, repeatedIdenticalToolCalls: 0, candidateRevisions: 0,
      elapsedMs: 1, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, knownCosts: {}, pricingStatus: 'unknown', unknownPricedTokens: 0,
      consecutiveProviderFailures: 0, consecutiveToolFailures: 0
    },
    control: { status: 'owned', driverGeneration: 0 },
    policyIdentity: CODING_AGENT_DISPOSITION.policyIdentity,
    receipts: { providerSettlementEventId: 'provider', candidateEventId: 'candidate', verificationEventIds: [] }
  };
}

function check(id, verdict, summary = `${id} ${verdict}`) {
  return {
    id, implementationId: `${id}@1`, requirement: id === 'advisory' ? 'advisory' : 'required',
    verdict, summary, durationMs: 1
  };
}

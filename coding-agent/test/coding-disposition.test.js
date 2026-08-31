import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodingDisposition } from '../dist/verification/coding-disposition.js';

const reviewDisposition = createCodingDisposition({ mutable: false, requiredCoverage: 'missing' });

test('coding disposition revises proven regressions and blocks unknown required coverage', () => {
  assert.equal(reviewDisposition.kind, 'deterministic');
  assert.deepEqual(reviewDisposition.evaluate(dispositionInput([])), { kind: 'accept' });
  assert.deepEqual(reviewDisposition.evaluate(dispositionInput([check('advisory', 'failed')])), { kind: 'accept' });

  const unknown = reviewDisposition.evaluate(dispositionInput([check('required-unknown', 'unknown')]));
  assert.equal(unknown.kind, 'inconclusive');
  assert.match(unknown.reason, /cannot be completed or published/u);

  const decision = reviewDisposition.evaluate(dispositionInput([
    check('lint\ncheck', 'failed', '  Unexpected   token.  '),
    check('advisory', 'failed')
  ]));
  assert.equal(decision.kind, 'revise');
  assert.match(decision.instruction, /introduced or changed a failure/u);
  assert.match(decision.instruction, /repair the underlying defect without weakening the admitted verifier/u);
  assert.match(decision.instruction, /- lint check: Unexpected token\./u);
  assert.doesNotMatch(decision.instruction, /advisory/u);
});

test('coding disposition bounds failure evidence supplied for revision', () => {
  const checks = Array.from({ length: 25 }, (_, index) => check(`check-${String(index)}`, 'failed', 'x'.repeat(500)));
  const decision = reviewDisposition.evaluate(dispositionInput(checks));
  assert.equal(decision.kind, 'revise');
  assert.match(decision.instruction, /5 additional failed required checks omitted/u);
  assert.ok(decision.instruction.length < 8_000);
});

test('mutable acceptance is a prepared candidate-publication effect', async () => {
  const candidateWorkspace = {
    descriptor: { implementationId: 'tests.workspace@1', workspaceId: 'workspace', runId: 'run', sourceId: 'source' },
    baseline: { checkpointId: 'baseline', digest: 'a'.repeat(64), coverage: 'complete', causes: [], fileCount: 1, totalBytes: 1 },
    async checkpoint() { throw new Error('unused'); }, async diff() { throw new Error('unused'); }, async rollback() { throw new Error('unused'); },
    async preparePromotion() {
      const result = { status: 'promoted', baselineDigest: 'a'.repeat(64), candidateDigest: 'b'.repeat(64), changedPaths: ['source.js'], transactionId: 'transaction' };
      return {
        authorization: { workspace: 'workspace' }, recovery: { kind: 'unknown' },
        async start() { return result; }, async reconcile() { return { status: 'settled', result }; }, async release() {}
      };
    },
    async release() {}
  };
  const disposition = createCodingDisposition({ mutable: true, candidateWorkspace, requiredCoverage: 'admitted' });
  const prepared = await disposition.prepare(dispositionInput([]));
  assert.equal(typeof prepared.start, 'function');
  assert.deepEqual(await prepared.start(new AbortController().signal), { kind: 'accept' });
  await prepared.release();
});

test('missing verification coverage blocks changed publication but permits an unchanged clarification', async () => {
  const candidateWorkspace = (entries, coverage = 'complete', causes = []) => ({
    descriptor: { implementationId: 'tests.workspace@1', workspaceId: 'workspace', runId: 'run', sourceId: 'source' },
    baseline: { checkpointId: 'baseline', digest: 'a'.repeat(64), coverage: 'complete', causes: [], fileCount: 1, totalBytes: 1 },
    async checkpoint() { throw new Error('unused'); },
    async diff() {
      return {
        baselineDigest: 'a'.repeat(64), candidateDigest: entries.length === 0 ? 'a'.repeat(64) : 'b'.repeat(64),
        coverage, causes, entries
      };
    },
    async rollback() { throw new Error('unused'); },
    async preparePromotion() {
      return {
        authorization: { workspace: 'workspace' }, recovery: { kind: 'unknown' },
        async start() { return { status: 'promoted', baselineDigest: 'a'.repeat(64), candidateDigest: 'a'.repeat(64), changedPaths: [], transactionId: 'transaction' }; },
        async reconcile() { throw new Error('unused'); }, async release() {}
      };
    },
    async release() {}
  });
  const changed = createCodingDisposition({
    mutable: true,
    requiredCoverage: 'missing',
    candidateWorkspace: candidateWorkspace([{ path: 'source.js', kind: 'modified', content: 'text' }])
  });
  const blocked = await changed.prepare(dispositionInput([]));
  assert.equal(blocked.kind, 'inconclusive');
  assert.match(blocked.reason, /changed candidate.*no required verification command/iu);

  const partial = createCodingDisposition({
    mutable: true,
    requiredCoverage: 'missing',
    candidateWorkspace: candidateWorkspace([], 'partial', ['symbolic_link'])
  });
  const incomplete = await partial.prepare(dispositionInput([]));
  assert.equal(incomplete.kind, 'inconclusive');
  assert.match(incomplete.reason, /candidate diff is incomplete.*symbolic_link/iu);

  const unchanged = createCodingDisposition({
    mutable: true,
    requiredCoverage: 'missing',
    candidateWorkspace: candidateWorkspace([])
  });
  const prepared = await unchanged.prepare(dispositionInput([]));
  assert.equal(typeof prepared.start, 'function');
  assert.deepEqual(await prepared.start(new AbortController().signal), { kind: 'accept' });
  await prepared.release();
});

function dispositionInput(checkResults) {
  return {
    candidate: { status: 'complete', message: 'candidate', source: 'content', turnIndex: 1 }, checkResults,
    budget: {
      modelTurns: 1, totalToolCalls: 0, repeatedIdenticalToolCalls: 0, candidateRevisions: 0, elapsedMs: 1, promptTokens: 0, completionTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, knownCosts: {}, pricingStatus: 'unknown', unknownPricedTokens: 0,
      consecutiveProviderFailures: 0, consecutiveToolFailures: 0
    },
    control: { status: 'owned', driverGeneration: 0 }, policyIdentity: reviewDisposition.policyIdentity,
    receipts: { providerSettlementEventId: 'provider', candidateEventId: 'candidate', verificationEventIds: [] }
  };
}

function check(id, verdict, summary = `${id} ${verdict}`) {
  return { id, implementationId: `${id}@1`, requirement: id === 'advisory' ? 'advisory' : 'required', verdict, summary, durationMs: 1 };
}

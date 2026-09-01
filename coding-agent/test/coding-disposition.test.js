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
  assert.match(unknown.reason, /cannot be accepted or applied/u);

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

test('coding disposition bounds failed-check details supplied for revision', () => {
  const checks = Array.from({ length: 25 }, (_, index) => check(`check-${String(index)}`, 'failed', 'x'.repeat(500)));
  const decision = reviewDisposition.evaluate(dispositionInput(checks));
  assert.equal(decision.kind, 'revise');
  assert.match(decision.instruction, /5 additional failed required checks omitted/u);
  assert.ok(decision.instruction.length < 8_000);
});

test('mutable acceptance is an authorized working-copy application effect', async () => {
  const workingCopy = {
    descriptor: { implementationId: 'tests.workspace@1', workingCopyId: 'workspace', runId: 'run', sourceId: 'source' },
    preChange: { checkpointId: 'pre-change', digest: 'a'.repeat(64), coverage: 'complete', causes: [], fileCount: 1, totalBytes: 1 },
    async checkpoint() { throw new Error('unused'); },
    async diff() { return { preChangeDigest: 'a'.repeat(64), workingCopyDigest: 'b'.repeat(64), coverage: 'complete', causes: [], entries: [{ path: 'source.js' }] }; },
    async rollback() { throw new Error('unused'); },
    async authorizeApply() {
      const result = { status: 'applied', preChangeDigest: 'a'.repeat(64), workingCopyDigest: 'b'.repeat(64), changedPaths: ['source.js'], transactionId: 'transaction' };
      return {
        authorization: { workspace: 'workspace' }, recovery: { kind: 'unknown' },
        async start() { return result; }, async reconcile() { return { status: 'settled', result }; }, async release() {}
      };
    },
    async release() {}
  };
  const disposition = createCodingDisposition({ mutable: true, workingCopy, requiredCoverage: 'admitted' });
  const plan = await disposition.planEffect(dispositionInput([]));
  assert.equal(typeof plan.start, 'function');
  assert.deepEqual(await plan.start(new AbortController().signal), { kind: 'accept' });
  await plan.release();
});

test('mutable acceptance rejects checks from a stale working-copy revision', async () => {
  const workingCopy = {
    descriptor: { implementationId: 'tests.workspace@1', workingCopyId: 'workspace', runId: 'run', sourceId: 'source' },
    preChange: { checkpointId: 'pre-change', digest: 'a'.repeat(64), coverage: 'complete', causes: [], fileCount: 1, totalBytes: 1 },
    async checkpoint() { throw new Error('unused'); },
    async diff() { return { preChangeDigest: 'a'.repeat(64), workingCopyDigest: 'c'.repeat(64), coverage: 'complete', causes: [], entries: [{ path: 'source.js' }] }; },
    async rollback() { throw new Error('unused'); }, async authorizeApply() { throw new Error('must not apply'); }, async release() {}
  };
  const disposition = createCodingDisposition({ mutable: true, workingCopy, requiredCoverage: 'admitted' });
  const stale = await disposition.planEffect(dispositionInput([{
    id: 'tests', implementationId: 'tests@1', requirement: 'required', verdict: 'passed', summary: 'passed', durationMs: 1,
    output: { workingCopyDigest: 'b'.repeat(64) }
  }]));
  assert.equal(stale.kind, 'inconclusive');
  assert.match(stale.reason, /exact working-copy revision/u);
});

test('missing verification coverage blocks changed publication but permits an unchanged clarification', async () => {
  const workingCopy = (entries, coverage = 'complete', causes = []) => ({
    descriptor: { implementationId: 'tests.workspace@1', workingCopyId: 'workspace', runId: 'run', sourceId: 'source' },
    preChange: { checkpointId: 'pre-change', digest: 'a'.repeat(64), coverage: 'complete', causes: [], fileCount: 1, totalBytes: 1 },
    async checkpoint() { throw new Error('unused'); },
    async diff() {
      return {
        preChangeDigest: 'a'.repeat(64), workingCopyDigest: entries.length === 0 ? 'a'.repeat(64) : 'b'.repeat(64),
        coverage, causes, entries
      };
    },
    async rollback() { throw new Error('unused'); },
    async authorizeApply() {
      return {
        authorization: { workspace: 'workspace' }, recovery: { kind: 'unknown' },
        async start() { return { status: 'applied', preChangeDigest: 'a'.repeat(64), workingCopyDigest: 'a'.repeat(64), changedPaths: [], transactionId: 'transaction' }; },
        async reconcile() { throw new Error('unused'); }, async release() {}
      };
    },
    async release() {}
  });
  const changed = createCodingDisposition({
    mutable: true,
    requiredCoverage: 'missing',
    workingCopy: workingCopy([{ path: 'source.js', kind: 'modified', content: 'text' }])
  });
  const blocked = await changed.planEffect(dispositionInput([]));
  assert.equal(blocked.kind, 'inconclusive');
  assert.match(blocked.reason, /changed working copy.*no required verification command/iu);

  const partial = createCodingDisposition({
    mutable: true,
    requiredCoverage: 'missing',
    workingCopy: workingCopy([], 'partial', ['symbolic_link'])
  });
  const incomplete = await partial.planEffect(dispositionInput([]));
  assert.equal(incomplete.kind, 'inconclusive');
  assert.match(incomplete.reason, /working-copy diff is incomplete.*symbolic_link/iu);

  const unchanged = createCodingDisposition({
    mutable: true,
    requiredCoverage: 'missing',
    workingCopy: workingCopy([])
  });
  const plan = await unchanged.planEffect(dispositionInput([]));
  assert.equal(typeof plan.start, 'function');
  assert.deepEqual(await plan.start(new AbortController().signal), { kind: 'accept' });
  await plan.release();
});

function dispositionInput(checkResults) {
  return {
    modelOutput: { status: 'complete', message: 'model output', source: 'content', turnIndex: 1 }, checkResults,
    budget: {
      modelTurns: 1, totalToolCalls: 0, repeatedIdenticalToolCalls: 0, revisionAttempts: 0, elapsedMs: 1, promptTokens: 0, completionTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, knownCosts: {}, pricingStatus: 'unknown', unknownPricedTokens: 0,
      consecutiveProviderFailures: 0, consecutiveToolFailures: 0
    },
    control: { status: 'owned', driverGeneration: 0 }, policyIdentity: reviewDisposition.policyIdentity,
    receipts: { providerSettlementEventId: 'provider', modelOutputEventId: 'model-output', verificationEventIds: [] }
  };
}

function check(id, verdict, summary = `${id} ${verdict}`) {
  return { id, implementationId: `${id}@1`, requirement: id === 'advisory' ? 'advisory' : 'required', verdict, summary, durationMs: 1 };
}

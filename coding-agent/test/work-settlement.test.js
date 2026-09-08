import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CodingOutcomeRepository,
  codingOutcomeEventCodec,
  settleCodingWork
} from '@ismail-elkorchi/coding-agent';
import { EffectExecutor, effectExecutionEventCodec } from '@agent-core/runtime';
import { InMemoryEventRepository } from '@agent-core/persistence';
import { testTerminal } from './helpers/results.js';

const baseline = 'a'.repeat(64),
  revision = 'b'.repeat(64);
function fixture({
  verdict = 'passed',
  changed = true,
  coverage = 'admitted',
  checkedRevision = revision,
  start
} = {}) {
  const terminal = testTerminal();
  let applications = 0;
  const result = {
    status: 'applied',
    preChangeDigest: baseline,
    workingCopyDigest: revision,
    changedPaths: changed ? ['source.ts'] : [],
    transactionId: 'publication'
  };
  const workingCopy = {
    async diff() {
      return {
        preChangeDigest: baseline,
        workingCopyDigest: revision,
        coverage: 'complete',
        causes: [],
        entries: changed ? [{ path: 'source.ts', kind: 'modified' }] : []
      };
    },
    async authorizeApply() {
      return {
        authorization: { workingCopyDigest: revision },
        recovery: {
          kind: 'buffered_mutation',
          authority: 'workspace',
          reconcilerId: 'workspace@1',
          transactionId: 'publication'
        },
        start: async () => {
          applications++;
          if (start) return start(result);
          return result;
        },
        reconcile: async () => ({ status: 'settled', result }),
        release: async () => {}
      };
    }
  };
  const checks =
    coverage === 'missing'
      ? []
      : [
          {
            kind: 'deterministic',
            id: 'tests',
            implementationId: 'tests@1',
            requirement: 'required',
            description: 'Verify exact revision.',
            run: async () => ({
              verdict,
              summary: `Tests ${verdict}.`,
              output: { workingCopyDigest: checkedRevision }
            })
          }
        ];
  const input = {
    execution: { state: 'ended', terminal, deliveryDiagnostics: [] },
    work: {
      workId: 'work',
      ownerId: 'work-owner',
      sessionId: 'session',
      sourceId: 'source',
      mode: 'revision',
      status: 'active',
      requirementSources: [],
      runIds: [terminal.runId]
    },
    checks,
    context: {
      runId: terminal.runId,
      turnId: 'turn',
      turnIndex: 1,
      requestAttempt: 1,
      task: 'Change code.',
      instructions: [],
      metadata: {},
      signal: new AbortController().signal,
      execution: {}
    },
    requiredCoverage: coverage,
    workingCopy,
    effects: new EffectExecutor(new InMemoryEventRepository(effectExecutionEventCodec)),
    outcomes: new CodingOutcomeRepository(new InMemoryEventRepository(codingOutcomeEventCodec))
  };
  return { input, applications: () => applications };
}

test('failed or unknown verification leaves completed execution intact and never publishes', async () => {
  for (const verdict of ['failed', 'unknown']) {
    const state = fixture({ verdict });
    const result = await settleCodingWork(state.input);
    assert.strictEqual(result.terminal, state.input.execution.terminal);
    assert.equal(result.terminal.executionStatus, 'completed');
    assert.equal('verificationStatus' in result.terminal, false);
    assert.equal(result.outcome.acceptance, verdict === 'failed' ? 'rejected' : 'inconclusive');
    assert.equal(state.applications(), 0);
  }
});

test('publication requires current verification coverage and permits unchanged clarifications', async () => {
  for (const settings of [{ checkedRevision: 'c'.repeat(64) }, { coverage: 'missing' }]) {
    const state = fixture(settings);
    const result = await settleCodingWork(state.input);
    assert.equal(result.outcome.acceptance, 'inconclusive');
    assert.equal(result.outcome.publication, 'not_applied');
    assert.equal(state.applications(), 0);
  }
  const unchanged = fixture({ changed: false, coverage: 'missing' });
  assert.equal((await settleCodingWork(unchanged.input)).outcome.acceptance, 'accepted');
  assert.equal(unchanged.applications(), 1);
});

test('publication reconciles its exact committed revision after a lost application response', async () => {
  const state = fixture({
    start: async () => {
      throw new Error('response lost after applying');
    }
  });
  const first = await settleCodingWork(state.input);
  assert.equal(first.outcome.stage, 'awaiting_reconciliation');
  assert.equal(first.outcome.publication, 'not_applied');
  const recovered = await settleCodingWork(state.input);
  assert.equal(recovered.outcome.stage, 'settled');
  assert.equal(recovered.outcome.publication, 'applied');
  assert.equal(recovered.outcome.revision, revision);
  assert.equal(state.applications(), 1);
  assert.deepEqual(await settleCodingWork(state.input), recovered);
});

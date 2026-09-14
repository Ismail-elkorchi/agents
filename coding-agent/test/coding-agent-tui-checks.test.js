import assert from 'node:assert/strict';
import test from 'node:test';
import { applyConfiguredChecks } from '../dist/tui/event-reducer.js';
import { createInitialCodingAgentTuiState } from '../dist/tui/state.js';

test('TUI separates historical check passes, applicability and exact definitions', () => {
  const report = {
    runId: 'run-1',
    history: { complete: true, omittedEarlierChecks: 0, nextSequence: 4 },
    checks: [
      {
        id: 'test',
        status: 'passed',
        requirement: 'required',
        coverage: 'targeted',
        output: 'logs',
        outputComplete: false,
        definition: {
          id: 'test',
          command: 'original command',
          timeoutMs: 60000,
          definitionIdentity: 'definition-1',
          testedPaths: ['dirty.txt']
        },
        applicability: { status: 'unknown', reasons: ['external_mutation_not_excluded'] },
        receipt: { eventId: 'event-1', runId: 'run-1', sequence: 4, hash: 'hash-1' }
      }
    ]
  };
  const state = applyConfiguredChecks(createInitialCodingAgentTuiState(), report);
  const entry = state.conversation.items.find((item) => item.activity === 'check');
  assert.equal(entry.status, 'warning');
  assert.match(entry.summary, /historical passed.*applicability unknown.*output incomplete/u);
  assert.match(
    entry.details[0].content,
    /original command.*Timeout: 60000ms.*dirty.txt.*event-1/su
  );
  const changed = applyConfiguredChecks(state, {
    ...report,
    checks: [
      {
        ...report.checks[0],
        applicability: { status: 'stale', reasons: ['observed_tested_inputs_changed'] }
      }
    ]
  });
  const refreshed = changed.conversation.items.find((item) => item.id === entry.id);
  assert.match(refreshed.summary, /historical passed.*applicability stale/u);
  assert.equal(refreshed.status, 'warning');
});

test('TUI discloses incomplete verification history without inventing not_run checks', () => {
  const report = {
    runId: 'run',
    checks: [],
    history: { complete: false, nextSequence: 255, omittedEarlierChecks: 0 }
  };
  const state = applyConfiguredChecks(createInitialCodingAgentTuiState(), report);
  const entry = state.conversation.items.find((item) => item.activity === 'check-history');
  assert.equal(entry.status, 'warning');
  assert.match(entry.summary, /Partial history through event 255/u);
  assert.equal(
    state.conversation.items.some((item) => item.activity === 'check'),
    false
  );
  const refreshed = applyConfiguredChecks(state, {
    ...report,
    history: { ...report.history, complete: true, nextSequence: 300 }
  });
  assert.equal(
    refreshed.conversation.items.find((item) => item.id === entry.id).status,
    'complete'
  );
});

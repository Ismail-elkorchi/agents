import { decodeAgentTerminalSnapshot } from '@agent-core/runtime';
import { hashJson } from '@agent-core/persistence';
import { decodeCodingWorkOutcome } from '@ismail-elkorchi/coding-agent';

export function testTerminal(overrides = {}) {
  return decodeAgentTerminalSnapshot({
    runId: 'run',
    finalizationId: 'final',
    phase: 'ended',
    executionStatus: 'completed',
    terminationReason: 'model_completed',
    modelTerminationReason: 'stop',
    modelOutput: { status: 'complete', message: 'Done.', source: 'content', turnIndex: 1 },
    turnCount: 1,
    budget: {
      modelTurns: 1,
      totalToolCalls: 0,
      repeatedIdenticalToolCalls: 0,
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
    },
    ...overrides
  });
}

export function testOutcome(terminal, overrides = {}) {
  return decodeCodingWorkOutcome({
    runId: terminal.runId,
    workId: 'work',
    terminalSha256: hashJson(terminal),
    stage: 'settled',
    verification: { status: 'not_required', checks: [] },
    acceptance: 'not_required',
    publication: 'not_applicable',
    ...overrides
  });
}

export function testResult(terminal = testTerminal(), outcome = {}) {
  return { state: 'ended', terminal, outcome: testOutcome(terminal, outcome), deliveryDiagnostics: [] };
}

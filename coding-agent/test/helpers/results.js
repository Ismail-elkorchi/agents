import { decodeAgentTerminalSnapshot } from '@agent-core/runtime';

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
      elapsedMs: 1,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      knownCosts: {},
      pricingStatus: 'unknown',
      unknownPricedTokens: 0,
    },
    ...overrides
  });
}

export function testResult(terminal = testTerminal()) {
  return { state: 'ended', terminal, deliveryDiagnostics: [] };
}

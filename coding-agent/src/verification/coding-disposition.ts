import type { AgentCheckResult, AgentDispositionInput, AgentDeterministicDispositionPolicy } from '@agent-core/runtime';

const MAX_REPORTED_FAILURES = 20;

/** Revises a candidate only when admitted required verification proves it failed. */
export const CODING_AGENT_DISPOSITION: AgentDeterministicDispositionPolicy = Object.freeze({
  kind: 'deterministic',
  implementationId: 'coding-agent.disposition.required-check-repair@1',
  policyIdentity: Object.freeze({ strategy: 'revise-required-check-failures', version: 1 }),
  evaluate(input: AgentDispositionInput) {
    const failed = input.checkResults.filter((check) => check.requirement === 'required' && check.verdict === 'failed');
    return failed.length === 0
      ? Object.freeze({ kind: 'accept' as const })
      : Object.freeze({ kind: 'revise' as const, instruction: repairInstruction(failed) });
  }
});

function repairInstruction(failed: readonly AgentCheckResult[]): string {
  const retained = failed.slice(0, MAX_REPORTED_FAILURES);
  const lines = retained.map((check) => `- ${compact(check.id, 120)}: ${compact(check.summary, 240)}`);
  if (retained.length < failed.length) lines.push(`- ${String(failed.length - retained.length)} additional failed required checks omitted.`);
  return [
    'Required verification failed for the exact candidate.',
    'Inspect the candidate and this check evidence, repair the underlying defect without weakening or bypassing the verifier, inspect the exact change, and return a revised candidate.',
    'Failed required checks:',
    ...lines
  ].join('\n');
}

function compact(value: string, limit: number): string {
  const normalized = value.trim().replaceAll(/\s+/g, ' ');
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

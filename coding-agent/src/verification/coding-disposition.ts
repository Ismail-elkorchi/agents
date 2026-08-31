import {
  prepareCandidateWorkspaceAcceptance,
  type AgentCandidateWorkspace,
  type AgentCheckResult,
  type AgentDispositionInput,
  type AgentDispositionPolicy
} from '@agent-core/runtime';

const MAX_REPORTED_FAILURES = 20;

/** Required verification owns repair/inconclusive decisions; acceptance owns candidate publication. */
export function createCodingDisposition(input: {
  readonly candidateWorkspace?: AgentCandidateWorkspace;
  readonly mutable: boolean;
}): AgentDispositionPolicy {
  if (!input.mutable) return Object.freeze({
    kind: 'deterministic' as const,
    implementationId: 'coding-agent.disposition.review-only@2',
    policyIdentity: Object.freeze({ strategy: 'required-checks-review-only', version: 2 }),
    evaluate: (disposition: AgentDispositionInput) => verificationDecision(disposition)
  });
  return Object.freeze({
    kind: 'effect' as const,
    implementationId: 'coding-agent.disposition.verify-and-promote@2',
    policyIdentity: Object.freeze({
      strategy: 'required-checks-then-candidate-promotion',
      version: 2,
      ...(input.candidateWorkspace ? { candidateWorkspace: Object.freeze({
        implementationId: input.candidateWorkspace.descriptor.implementationId,
        workspaceId: input.candidateWorkspace.descriptor.workspaceId,
        runId: input.candidateWorkspace.descriptor.runId,
        sourceId: input.candidateWorkspace.descriptor.sourceId
      }) } : {})
    }),
    async prepare(disposition: AgentDispositionInput) {
      const decision = verificationDecision(disposition);
      if (decision.kind !== 'accept') return decision;
      if (input.candidateWorkspace === undefined) return Object.freeze({ kind: 'inconclusive' as const, reason: 'The mutable run has no isolated candidate workspace to publish.' });
      return prepareCandidateWorkspaceAcceptance(input.candidateWorkspace);
    }
  });
}

function verificationDecision(disposition: AgentDispositionInput) {
  const failed = disposition.checkResults.filter((check) => check.requirement === 'required' && check.verdict === 'failed');
  if (failed.length > 0) return Object.freeze({ kind: 'revise' as const, instruction: repairInstruction(failed) });
  const unknown = disposition.checkResults.filter((check) => check.requirement === 'required' && check.verdict === 'unknown');
  if (unknown.length > 0) return Object.freeze({ kind: 'inconclusive' as const, reason: inconclusiveReason(unknown) });
  return Object.freeze({ kind: 'accept' as const });
}

function repairInstruction(failed: readonly AgentCheckResult[]): string {
  const retained = failed.slice(0, MAX_REPORTED_FAILURES);
  const lines = retained.map((check) => `- ${compact(check.id, 120)}: ${compact(check.summary, 240)}`);
  if (retained.length < failed.length) lines.push(`- ${String(failed.length - retained.length)} additional failed required checks omitted.`);
  return [
    'Required baseline-aware verification proves that this candidate introduced or changed a failure.',
    'Inspect the exact candidate and check evidence, repair the underlying defect without weakening the admitted verifier, then return the revised candidate.',
    'Failed required checks:',
    ...lines
  ].join('\n');
}

function inconclusiveReason(unknown: readonly AgentCheckResult[]): string {
  const retained = unknown.slice(0, MAX_REPORTED_FAILURES);
  return [
    'Required verification coverage is unknown; the candidate cannot be completed or published.',
    ...retained.map((check) => `- ${compact(check.id, 120)}: ${compact(check.summary, 240)}`),
    ...(retained.length < unknown.length ? [`- ${String(unknown.length - retained.length)} additional unknown required checks omitted.`] : [])
  ].join('\n');
}

function compact(value: string, limit: number): string {
  const normalized = value.trim().replaceAll(/\s+/g, ' ');
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

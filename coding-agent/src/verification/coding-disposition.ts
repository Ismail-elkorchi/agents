import {
  type AgentCheckResult,
  type AgentDispositionInput,
  type AgentDispositionPolicy
} from '@agent-core/runtime';
import { createWorkingCopyDisposition, type CodingWorkingCopy } from '../changes/isolated-working-copy.js';
import type { AdmittedCodingCheckPlan } from './candidate-acceptance-checks.js';

const MAX_REPORTED_FAILURES = 20;

/** Required verification owns repair/inconclusive decisions; acceptance owns working-copy application. */
export function createCodingDisposition(input: {
  readonly workingCopy?: CodingWorkingCopy;
  readonly mutable: boolean;
  readonly requiredCoverage: AdmittedCodingCheckPlan['requiredCoverage'];
}): AgentDispositionPolicy {
  if (!input.mutable) return Object.freeze({
    kind: 'deterministic' as const,
    implementationId: 'coding-agent.disposition.review-only@3',
    policyIdentity: Object.freeze({ strategy: 'required-checks-review-only', version: 3 }),
    evaluate: (disposition: AgentDispositionInput) => verificationDecision(disposition)
  });
  return Object.freeze({
    kind: 'effect' as const,
    implementationId: 'coding-agent.disposition.verify-and-apply@3',
    policyIdentity: Object.freeze({
      strategy: 'required-checks-then-working-copy-application',
      version: 3,
      requiredCoverage: input.requiredCoverage,
      ...(input.workingCopy ? { workingCopy: Object.freeze({
        implementationId: input.workingCopy.descriptor.implementationId,
        workingCopyId: input.workingCopy.descriptor.workingCopyId,
        runId: input.workingCopy.descriptor.runId,
        sourceId: input.workingCopy.descriptor.sourceId
      }) } : {})
    }),
    async planEffect(disposition: AgentDispositionInput) {
      const decision = verificationDecision(disposition);
      if (decision.kind !== 'accept') return decision;
      if (input.workingCopy === undefined) return Object.freeze({ kind: 'inconclusive' as const, reason: 'The mutable run has no isolated working copy to apply.' });
      const diff = await input.workingCopy.diff();
      const staleChecks = disposition.checkResults
        .filter((check) => check.requirement === 'required' && check.verdict === 'passed')
        .filter((check) => checkWorkingCopyDigest(check) !== diff.workingCopyDigest);
      if (staleChecks.length > 0) {
        return Object.freeze({
          kind: 'inconclusive' as const,
          reason: `Required checks do not describe the exact working-copy revision selected for application: ${staleChecks.map((check) => check.id).join(', ')}.`
        });
      }
      if (input.requiredCoverage === 'missing') {
        if (diff.coverage !== 'complete') {
          return Object.freeze({
            kind: 'inconclusive' as const,
            reason: `Required verification coverage is unknown because the working-copy diff is incomplete: ${diff.causes.join(', ')}.`
          });
        }
        if (diff.entries.length > 0) {
          return Object.freeze({
            kind: 'inconclusive' as const,
            reason: 'Required verification coverage is unknown; the changed working copy cannot be accepted or applied because no required verification command was admitted.'
          });
        }
      }
      return createWorkingCopyDisposition(input.workingCopy);
    }
  });
}

function checkWorkingCopyDigest(check: AgentCheckResult): string | undefined {
  if (!record(check.output)) return undefined;
  const digest = check.output.workingCopyDigest;
  return typeof digest === 'string' && /^[a-f0-9]{64}$/u.test(digest) ? digest : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    'Required pre-change comparison proves that this working copy introduced or changed a failure.',
    'Inspect the exact working copy and check results, repair the underlying defect without weakening the admitted verifier, then return the revised result.',
    'Failed required checks:',
    ...lines
  ].join('\n');
}

function inconclusiveReason(unknown: readonly AgentCheckResult[]): string {
  const retained = unknown.slice(0, MAX_REPORTED_FAILURES);
  return [
    'Required verification coverage is unknown; the working copy cannot be accepted or applied.',
    ...retained.map((check) => `- ${compact(check.id, 120)}: ${compact(check.summary, 240)}`),
    ...(retained.length < unknown.length ? [`- ${String(unknown.length - retained.length)} additional unknown required checks omitted.`] : [])
  ].join('\n');
}

function compact(value: string, limit: number): string {
  const normalized = value.trim().replaceAll(/\s+/g, ' ');
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

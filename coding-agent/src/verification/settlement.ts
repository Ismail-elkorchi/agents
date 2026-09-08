import { NO_EFFECT_EXPOSURE, knownEffectExposure } from '@agent-core/effects';
import { parseJsonObject } from '@agent-core/json';
import { hashJson } from '@agent-core/persistence';
import { EffectExecutor, type AgentEndedRunResult } from '@agent-core/runtime';
import {
  deriveVerificationStatus,
  executeVerification,
  type CheckContext,
  type CheckDefinition,
  type CheckResult
} from '@agents/verification';
import type { CodingWorkingCopy, WorkingCopyApplicationResult } from '../changes/isolated-working-copy.js';
import { CodingOutcomeRepository, type CodingEndedRunResult, type CodingWorkOutcome } from '../outcome.js';
import type { CodingWork } from '../work.js';
import type { AdmittedCodingCheckPlan } from './revision-acceptance-checks.js';

/** Domain acceptance and publication occur after Core has committed execution. */
export async function settleCodingWork(input: {
  readonly execution: AgentEndedRunResult;
  readonly work: CodingWork;
  readonly checks: readonly CheckDefinition[];
  readonly context?: Omit<CheckContext, 'modelOutput'>;
  readonly requiredCoverage: AdmittedCodingCheckPlan['requiredCoverage'];
  readonly workingCopy?: CodingWorkingCopy;
  readonly effects: EffectExecutor;
  readonly outcomes: CodingOutcomeRepository;
}): Promise<CodingEndedRunResult> {
  const terminal = input.execution.terminal;
  const stored = await input.outcomes.read(terminal.runId);
  const terminalSha256 = hashJson(terminal);
  if (stored !== undefined && stored.terminalSha256 !== terminalSha256)
    throw new Error('Coding acceptance cannot bind a different execution result.');
  if (stored?.stage === 'settled') return Object.freeze({ ...input.execution, outcome: stored });
  let outcome: CodingWorkOutcome = {
    runId: terminal.runId,
    workId: input.work.workId,
    terminalSha256,
    stage: 'settled',
    verification: { status: 'not_run', checks: [] },
    acceptance: 'inconclusive',
    publication: input.work.mode === 'review' ? 'not_applicable' : 'not_applied',
    reason: 'Execution did not complete.'
  };
  if (terminal.executionStatus === 'completed') {
    if (input.context === undefined)
      throw new Error('Completed coding work requires its exact model response identity.');
    const verification = await executeVerification({
      ownerId: input.work.ownerId,
      checks: input.checks,
      effects: input.effects,
      context: { ...input.context, modelOutput: terminal.modelOutput }
    });
    const status =
      verification.status === 'completed'
        ? deriveVerificationStatus(input.checks, verification.results)
        : 'inconclusive';
    outcome = { ...outcome, verification: { status, checks: verification.results } };
    if (verification.status !== 'completed') {
      outcome = {
        ...outcome,
        stage: 'awaiting_reconciliation',
        reason: `Verification ${verification.checkId} has an unresolved effect: ${verification.status}.`
      };
    } else if (status === 'failed' || status === 'inconclusive') {
      outcome = {
        ...outcome,
        acceptance: status === 'failed' ? 'rejected' : 'inconclusive',
        reason: verification.results
          .filter((check) => check.requirement === 'required' && check.verdict !== 'passed')
          .map((check) => `${check.id}: ${check.summary}`)
          .join('\n')
      };
    } else if (input.work.mode === 'review') {
      outcome = {
        ...outcome,
        acceptance: 'not_required',
        publication: 'not_applicable',
        reason: 'Review work has no mutable revision to publish.'
      };
    } else if (input.workingCopy !== undefined) {
      outcome = await publishCheckedRevision(
        outcome,
        input.workingCopy,
        verification.results,
        input.requiredCoverage,
        input.effects,
        input.work.ownerId,
        input.context.signal
      );
    }
  }
  return Object.freeze({ ...input.execution, outcome: await input.outcomes.record(outcome) });
}

async function publishCheckedRevision(
  outcome: CodingWorkOutcome,
  workingCopy: CodingWorkingCopy,
  checks: readonly CheckResult[],
  coverage: AdmittedCodingCheckPlan['requiredCoverage'],
  effects: EffectExecutor,
  ownerId: string,
  signal: AbortSignal
): Promise<CodingWorkOutcome> {
  const diff = await workingCopy.diff(signal);
  const common = { ...outcome, revision: diff.workingCopyDigest };
  if (diff.coverage !== 'complete')
    return {
      ...common,
      reason: `The proposed revision has incomplete coverage: ${diff.causes.join(', ')}.`
    };
  const stale = checks.filter(
    (check) =>
      check.requirement === 'required' &&
      check.verdict === 'passed' &&
      (typeof check.output !== 'object' ||
        check.output === null ||
        Array.isArray(check.output) ||
        !('workingCopyDigest' in check.output) ||
        check.output.workingCopyDigest !== diff.workingCopyDigest)
  );
  if (stale.length > 0)
    return {
      ...common,
      reason: `Required checks do not bind the exact proposed revision: ${stale.map((check) => check.id).join(', ')}.`
    };
  if (coverage === 'missing' && diff.entries.length > 0)
    return {
      ...common,
      reason: 'The changed working copy has no admitted required verification coverage.'
    };
  const plan = await workingCopy.authorizeApply(signal);
  if (!('start' in plan))
    return {
      ...common,
      reason:
        plan.status === 'not_applied'
          ? plan.reason
          : 'Application did not provide its execution authorization.'
    };
  try {
    if (parseJsonObject(plan.authorization).workingCopyDigest !== diff.workingCopyDigest)
      return {
        ...common,
        reason: 'The working copy changed after its checks and before publication authorization.'
      };
    const result = await effects.execute<WorkingCopyApplicationResult>(
      {
        intent: {
          effectId: `coding-publication:${hashJson({ workId: outcome.workId, revision: diff.workingCopyDigest })}`,
          ownerId,
          implementationId: 'coding-agent.checked-publication@1',
          parametersDigest: hashJson(plan.authorization),
          recovery: plan.recovery,
          exposure: NO_EFFECT_EXPOSURE
        },
        codec: { encode: parseJsonObject, decode: decodeApplicationResult },
        exposure: () => knownEffectExposure([]),
        start: (effectSignal) => plan.start(effectSignal),
        reconcile: async (recoverySignal) => {
          const reconciliation = await plan.reconcile(recoverySignal);
          return reconciliation.status === 'settled'
            ? { status: 'settled', observation: reconciliation.result }
            : reconciliation;
        }
      },
      signal
    );
    if (result.status !== 'settled')
      return {
        ...common,
        stage: 'awaiting_reconciliation',
        reason: `Publication has an unresolved effect: ${result.status}.`
      };
    if (result.observation.status === 'not_applied')
      return { ...common, reason: result.observation.reason };
    if (result.observation.workingCopyDigest !== diff.workingCopyDigest)
      throw new Error('Publication settled a different coding revision.');
    return {
      ...common,
      reason: 'The exact verified revision was published.',
      acceptance: 'accepted',
      publication: 'applied'
    };
  } finally {
    await plan.release();
  }
}

function decodeApplicationResult(value: unknown): WorkingCopyApplicationResult {
  const result = parseJsonObject(value);
  if (
    result.status === 'not_applied' &&
    typeof result.reason === 'string' &&
    Object.keys(result).every((key) => key === 'status' || key === 'reason')
  )
    return Object.freeze({ status: result.status, reason: result.reason });
  const fields = ['status', 'preChangeDigest', 'workingCopyDigest', 'changedPaths', 'transactionId'];
  if (
    result.status !== 'applied' ||
    Object.keys(result).some((key) => !fields.includes(key)) ||
    typeof result.preChangeDigest !== 'string' ||
    typeof result.workingCopyDigest !== 'string' ||
    typeof result.transactionId !== 'string' ||
    !Array.isArray(result.changedPaths) ||
    !result.changedPaths.every((item): item is string => typeof item === 'string')
  )
    throw new TypeError('Incompatible coding publication result.');
  return Object.freeze({
    status: 'applied',
    preChangeDigest: result.preChangeDigest,
    workingCopyDigest: result.workingCopyDigest,
    transactionId: result.transactionId,
    changedPaths: Object.freeze(result.changedPaths)
  });
}

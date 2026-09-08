import { NO_EFFECT_EXPOSURE, knownEffectExposure } from '@agent-core/effects';
import { parseJsonObject } from '@agent-core/json';
import { hashJson } from '@agent-core/persistence';
import { EffectExecutor } from '@agent-core/runtime';
import {
  isCheckEffectPlan,
  parseCheckResult,
  type CheckContext,
  type CheckDefinition,
  type CheckObservation,
  type CheckResult
} from './contracts.js';

export type VerificationExecutionResult =
  | { readonly status: 'completed'; readonly results: readonly CheckResult[] }
  | {
      readonly status: 'running' | 'unknown' | 'expired' | 'cancelled_before_start';
      readonly checkId: string;
      readonly results: readonly CheckResult[];
    };

/** Applications choose the checks and their order. This service supplies execution guarantees. */
export async function executeVerification(input: {
  readonly ownerId: string;
  readonly checks: readonly CheckDefinition[];
  readonly context: CheckContext;
  readonly effects: EffectExecutor;
}): Promise<VerificationExecutionResult> {
  const results: CheckResult[] = [];
  for (const check of input.checks) {
    input.context.signal.throwIfAborted();
    const signal = AbortSignal.any([input.context.signal, AbortSignal.timeout(check.timeoutMs ?? 30_000)]);
    const context = { ...input.context, signal };
    const startedAt = performance.now();
    const capture = (observation: CheckObservation): CheckResult =>
      parseCheckResult({
        ...observation,
        id: check.id,
        implementationId: check.implementationId,
        requirement: check.requirement,
        durationMs: Math.max(0, performance.now() - startedAt)
      });
    const plan =
      check.kind === 'deterministic' ? await check.run(context) : await check.planEffect(context);
    if (!isCheckEffectPlan(plan)) {
      results.push(capture(plan));
      continue;
    }
    try {
      const identity = { runId: context.runId, turnId: context.turnId, checkId: check.id };
      const result = await input.effects.execute<CheckResult>(
        {
          intent: {
            effectId: `verification:${hashJson(identity)}`,
            ownerId: input.ownerId,
            implementationId: check.implementationId,
            parametersDigest: hashJson({
              identity,
              authorization: plan.authorization,
              recovery: plan.recovery
            }),
            recovery: plan.recovery,
            exposure: NO_EFFECT_EXPOSURE
          },
          codec: { encode: parseJsonObject, decode: parseCheckResult },
          exposure: () => knownEffectExposure([]),
          start: async (effectSignal) => capture(await plan.start(effectSignal)),
          reconcile: async (effectSignal) => {
            const reconciliation = await plan.reconcile(effectSignal);
            return reconciliation.status === 'settled'
              ? { status: 'settled', observation: capture(reconciliation.observation) }
              : reconciliation;
          }
        },
        signal
      );
      if (result.status !== 'settled') {
        return Object.freeze({ status: result.status, checkId: check.id, results: Object.freeze(results) });
      }
      results.push(result.observation);
    } finally {
      await plan.release();
    }
  }
  return Object.freeze({ status: 'completed', results: Object.freeze(results) });
}

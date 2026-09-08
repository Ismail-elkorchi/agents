import { decodeEffectRecoveryCapability, type EffectRecoveryCapability } from '@agent-core/effects';
import { parseJsonObject, parseJsonValue, type JsonValue } from '@agent-core/json';
import type { ArtifactRef } from '@agent-core/persistence';
import { AgentContractError } from '@agent-core/runtime';

export type VerificationStatus = 'not_required' | 'not_run' | 'passed' | 'failed' | 'inconclusive';

export type CompletedVerificationStatus = Exclude<VerificationStatus, 'not_run'>;

export type CheckVerdict = 'passed' | 'failed' | 'unknown';

export type CheckRequirement = 'required' | 'advisory';

export type CheckDiagnosticKind =
  | 'exception'
  | 'timeout'
  | 'unavailable'
  | 'permission_denied'
  | 'aborted'
  | 'invalid_result';

export type CheckDiagnostic = Readonly<{
  readonly kind: CheckDiagnosticKind;
  readonly message: string;
  readonly details?: JsonValue;
}>;

export interface CheckObservation {
  readonly verdict: CheckVerdict;
  readonly summary: string;
  readonly output?: unknown;
  readonly artifacts?: readonly ArtifactRef[];
  readonly diagnostic?: CheckDiagnostic;
}

export type CheckResult = Readonly<{
  readonly id: string;
  readonly implementationId: string;
  readonly requirement: CheckRequirement;
  readonly verdict: CheckVerdict;
  readonly summary: string;
  readonly durationMs: number;
  readonly output?: JsonValue;
  readonly artifacts?: readonly ArtifactRef[];
  readonly diagnostic?: CheckDiagnostic;
}>;

export interface CheckContext {
  /** Application-selected verification identity, stable across recovery within its owner. */
  readonly executionId: string;
  readonly signal: AbortSignal;
}

interface CheckDefinitionBase {
  readonly id: string;
  /** Stable identity for the admitted verifier implementation and semantics. */
  readonly implementationId: string;
  readonly requirement: CheckRequirement;
  readonly timeoutMs?: number;
}

export interface DeterministicCheckDefinition extends CheckDefinitionBase {
  readonly kind: 'deterministic';
  run(context: CheckContext): Promise<CheckObservation>;
}

export interface EffectCheckDefinition extends CheckDefinitionBase {
  readonly kind: 'effect';
  planEffect(context: CheckContext): Promise<CheckObservation | CheckEffectPlan>;
}

export type CheckDefinition = DeterministicCheckDefinition | EffectCheckDefinition;

export type CheckEffectReconciliation =
  | Readonly<{
      readonly status: 'settled';
      readonly observation: CheckObservation;
    }>
  | Readonly<{ readonly status: 'running' | 'unknown' | 'expired' }>;

export interface CheckEffectPlan {
  readonly authorization: JsonValue;
  readonly recovery: EffectRecoveryCapability;
  readonly start: (signal: AbortSignal) => Promise<CheckObservation>;
  readonly reconcile: (signal: AbortSignal) => Promise<CheckEffectReconciliation>;
  readonly release: () => Promise<void>;
}

const CHECK_EFFECT_PLANS = new WeakSet();

export function createCheckEffectPlan(input: CheckEffectPlan): CheckEffectPlan {
  if (
    typeof input.start !== 'function' ||
    typeof input.reconcile !== 'function' ||
    typeof input.release !== 'function'
  ) {
    throw new TypeError('Planned check effect requires start, reconcile, and release operations.');
  }
  const plan = Object.freeze({
    authorization: parseJsonValue(input.authorization),
    recovery: decodeEffectRecoveryCapability(input.recovery),
    start: input.start,
    reconcile: input.reconcile,
    release: input.release
  });
  CHECK_EFFECT_PLANS.add(plan);
  return plan;
}

export function isCheckEffectPlan(value: unknown): value is CheckEffectPlan {
  return typeof value === 'object' && value !== null && CHECK_EFFECT_PLANS.has(value);
}

export function deriveVerificationStatus(
  definitions: readonly Pick<CheckDefinition, 'id' | 'requirement'>[],
  results: readonly CheckResult[]
): CompletedVerificationStatus {
  if (definitions.length === 0) return 'not_required';
  const byId = new Map(results.map((result) => [result.id, result]));
  const required = definitions.filter((definition) => definition.requirement === 'required');
  if (required.length === 0) return 'not_required';
  if (required.some((definition) => byId.get(definition.id)?.verdict === 'failed')) return 'failed';
  if (required.some((definition) => byId.get(definition.id)?.verdict !== 'passed')) return 'inconclusive';
  return 'passed';
}

export function parseCheckResult(value: unknown): CheckResult {
  const object = parseJsonObject(value);
  const issues: string[] = [];
  const fields = [
    'id',
    'implementationId',
    'requirement',
    'verdict',
    'summary',
    'durationMs',
    'output',
    'artifacts',
    'diagnostic'
  ];
  for (const key of Object.keys(object)) {
    if (!fields.includes(key)) issues.push(`Unsupported check result field: ${key}.`);
  }
  const id = typeof object.id === 'string' && object.id.trim().length > 0 ? object.id : undefined;
  const implementationId =
    typeof object.implementationId === 'string' && validIdentity(object.implementationId)
      ? object.implementationId
      : undefined;
  const requirement = oneOf(object.requirement, ['required', 'advisory']) ? object.requirement : undefined;
  const verdict = oneOf(object.verdict, ['passed', 'failed', 'unknown']) ? object.verdict : undefined;
  const summary =
    typeof object.summary === 'string' && object.summary.trim().length > 0 ? object.summary : undefined;
  const rawDurationMs = object.durationMs;
  const durationMs =
    typeof rawDurationMs === 'number' && Number.isFinite(rawDurationMs) && rawDurationMs >= 0
      ? rawDurationMs
      : undefined;
  if (!id) issues.push('id must be non-empty.');
  if (!implementationId) issues.push('implementationId must be a non-empty bounded identity.');
  if (!requirement) issues.push('requirement is invalid.');
  if (!verdict) issues.push('verdict is invalid.');
  if (!summary) issues.push('summary must be non-empty.');
  if (durationMs === undefined) issues.push('durationMs must be finite and nonnegative.');
  const artifacts =
    object.artifacts === undefined
      ? undefined
      : Array.isArray(object.artifacts) && object.artifacts.every(isArtifactRef)
        ? Object.freeze([...object.artifacts])
        : undefined;
  if (object.artifacts !== undefined && !artifacts) issues.push('artifacts are invalid.');
  const diagnostic =
    object.diagnostic === undefined
      ? undefined
      : isCheckDiagnostic(object.diagnostic)
        ? object.diagnostic
        : undefined;
  if (object.diagnostic !== undefined && !diagnostic) issues.push('diagnostic is invalid.');
  if (
    issues.length > 0 ||
    !id ||
    !implementationId ||
    !requirement ||
    !verdict ||
    !summary ||
    durationMs === undefined
  )
    throw new AgentContractError('Invalid check result.', issues);
  return Object.freeze({
    id,
    implementationId,
    requirement,
    verdict,
    summary,
    durationMs,
    ...(object.output !== undefined ? { output: object.output } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(diagnostic ? { diagnostic } : {})
  });
}

function isCheckDiagnostic(value: unknown): value is CheckDiagnostic {
  return (
    isRecord(value) &&
    oneOf(value.kind, [
      'exception',
      'timeout',
      'unavailable',
      'permission_denied',
      'aborted',
      'invalid_result'
    ]) &&
    typeof value.message === 'string'
  );
}

function isArtifactRef(value: unknown): value is ArtifactRef {
  return (
    isRecord(value) &&
    typeof value.artifactId === 'string' &&
    typeof value.sha256 === 'string' &&
    typeof value.size === 'number' &&
    Number.isInteger(value.size) &&
    value.size >= 0 &&
    typeof value.mediaType === 'string'
  );
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 256;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.some((candidate) => candidate === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

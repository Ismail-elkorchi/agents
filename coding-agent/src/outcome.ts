import { parseJsonObject } from '@agent-core/json';
import { hashJson, type EventRepository, type RuntimeCodec } from '@agent-core/persistence';
import type { AgentEndedRunResult, AgentRunResult } from '@agent-core/runtime';
import { parseCheckResult, type CheckResult, type VerificationStatus } from '@agents/verification';

export interface CodingWorkOutcome {
  readonly runId: string;
  readonly workId: string;
  readonly terminalSha256: string;
  readonly stage: 'settled' | 'awaiting_reconciliation';
  readonly verification: {
    readonly status: VerificationStatus;
    readonly checks: readonly CheckResult[];
  };
  readonly acceptance: 'accepted' | 'rejected' | 'inconclusive' | 'not_required';
  readonly publication: 'applied' | 'not_applied' | 'not_applicable';
  readonly revision?: string;
  readonly reason?: string;
}

export interface CodingEndedRunResult extends AgentEndedRunResult {
  readonly outcome: CodingWorkOutcome;
}
export type CodingRunResult = Exclude<AgentRunResult, AgentEndedRunResult> | CodingEndedRunResult;

export interface CodingOutcomeEvent {
  readonly type: 'coding.outcome.recorded';
  readonly outcome: CodingWorkOutcome;
}

export function decodeCodingWorkOutcome(value: unknown): CodingWorkOutcome {
  const object = parseJsonObject(value);
  const verification = parseJsonObject(object.verification);
  const fields = [
    'runId',
    'workId',
    'terminalSha256',
    'stage',
    'verification',
    'acceptance',
    'publication',
    'revision',
    'reason'
  ];
  if (
    Object.keys(object).some((key) => !fields.includes(key)) ||
    Object.keys(verification).some((key) => key !== 'status' && key !== 'checks') ||
    !nonempty(object.runId) ||
    !nonempty(object.workId) ||
    !digest(object.terminalSha256) ||
    !oneOf(object.stage, ['settled', 'awaiting_reconciliation']) ||
    !oneOf(object.acceptance, ['accepted', 'rejected', 'inconclusive', 'not_required']) ||
    !oneOf(object.publication, ['applied', 'not_applied', 'not_applicable']) ||
    !oneOf(verification.status, ['not_required', 'not_run', 'passed', 'failed', 'inconclusive']) ||
    !Array.isArray(verification.checks) ||
    (object.revision !== undefined && !digest(object.revision)) ||
    (object.reason !== undefined && !nonempty(object.reason))
  )
    throw new TypeError('Incompatible coding work outcome.');
  if (
    object.publication === 'applied' &&
    (object.acceptance !== 'accepted' || !digest(object.revision) || object.stage !== 'settled')
  )
    throw new TypeError('Published coding work requires one accepted revision.');
  return Object.freeze({
    runId: object.runId,
    workId: object.workId,
    terminalSha256: object.terminalSha256,
    stage: object.stage,
    acceptance: object.acceptance,
    publication: object.publication,
    verification: Object.freeze({
      status: verification.status,
      checks: Object.freeze(verification.checks.map((check) => parseCheckResult(check)))
    }),
    ...(typeof object.revision === 'string' ? { revision: object.revision } : {}),
    ...(typeof object.reason === 'string' ? { reason: object.reason } : {})
  });
}

export const codingOutcomeEventCodec: RuntimeCodec<CodingOutcomeEvent> = {
  encode: (event) => parseJsonObject(event),
  decode(value) {
    const event = parseJsonObject(value);
    if (
      event.type !== 'coding.outcome.recorded' ||
      Object.keys(event).some((key) => key !== 'type' && key !== 'outcome')
    )
      throw new TypeError('Incompatible coding outcome event.');
    return Object.freeze({
      type: 'coding.outcome.recorded',
      outcome: decodeCodingWorkOutcome(event.outcome)
    });
  }
};

/** Application settlement is independent of Core's immutable execution terminal. */
export class CodingOutcomeRepository {
  constructor(private readonly events: EventRepository<CodingOutcomeEvent>) {}

  async read(runId: string): Promise<CodingWorkOutcome | undefined> {
    return (await this.events.latest(runId))?.event.outcome;
  }

  async record(value: CodingWorkOutcome): Promise<CodingWorkOutcome> {
    const outcome = decodeCodingWorkOutcome(value);
    const tail = await this.events.tail(outcome.runId);
    const previous = await this.read(outcome.runId);
    if (previous?.stage === 'settled') {
      if (hashJson(previous) !== hashJson(outcome))
        throw new Error('Coding outcome is already settled differently.');
      return previous;
    }
    const result = await this.events.appendConditional(
      outcome.runId,
      { type: 'coding.outcome.recorded', outcome },
      {
        idempotencyKey: hashJson(outcome),
        expectedTail: tail,
        driverGeneration: tail.driverGeneration
      }
    );
    if (result.kind !== 'committed')
      throw new Error(`Coding outcome recording did not commit: ${result.kind}.`);
    return outcome;
  }
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
function oneOf<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && values.some((item) => item === value);
}

import { createHash } from 'node:crypto';
import type { WorkspaceSnapshot } from '@agent-core/tools-local';
import type { PrivateStateDirectory } from '../state/private-state.js';
import type {
  AdmittedCodingCheckPlan,
  PreChangeCommandObservation
} from './candidate-acceptance-checks.js';

export async function loadOrObservePreChangeCommands(input: {
  readonly state: PrivateStateDirectory;
  readonly runId: string;
  readonly resuming: boolean;
  readonly plan: AdmittedCodingCheckPlan;
  readonly preChange: WorkspaceSnapshot;
  readonly observe: () => Promise<readonly PreChangeCommandObservation[]>;
}): Promise<readonly PreChangeCommandObservation[]> {
  const location = observationPath(input.runId);
  const stored = await input.state.read(location);
  if (stored !== undefined) return decodeObservations(JSON.parse(stored), input.plan, input.preChange.digest);
  const observations = input.resuming
    ? input.plan.checks.map((check) => Object.freeze({
        checkId: check.id,
        command: check.command,
        preChangeSnapshotDigest: input.preChange.digest,
        outcome: 'unknown' as const,
        outputComplete: false,
        summary: 'The run resumed without a committed pre-change command observation.'
      }))
    : await input.observe();
  const decoded = decodeObservations(observations, input.plan, input.preChange.digest);
  await input.state.write(location, JSON.stringify(decoded));
  return decoded;
}

export async function deletePreChangeCommandObservations(state: PrivateStateDirectory, runId: string): Promise<void> {
  await state.delete(observationPath(runId));
}

function decodeObservations(value: unknown, plan: AdmittedCodingCheckPlan, snapshotDigest: string): readonly PreChangeCommandObservation[] {
  if (!Array.isArray(value) || value.length !== plan.checks.length) throw new Error('Persisted pre-change command observations do not match the admitted check plan.');
  const decoded = value.map((entry, index) => decodeObservation(entry, plan.checks[index]?.id, plan.checks[index]?.command, snapshotDigest));
  return Object.freeze(decoded);
}

function decodeObservation(value: unknown, checkId: string | undefined, command: string | undefined, snapshotDigest: string): PreChangeCommandObservation {
  if (!record(value)
    || Object.keys(value).some((key) => !['checkId', 'command', 'preChangeSnapshotDigest', 'outcome', 'exitCode', 'failureSignature', 'outputComplete', 'summary'].includes(key))
    || value.checkId !== checkId || value.command !== command || value.preChangeSnapshotDigest !== snapshotDigest
    || (value.outcome !== 'passed' && value.outcome !== 'failed' && value.outcome !== 'unknown')
    || typeof value.outputComplete !== 'boolean' || typeof value.summary !== 'string'
    || (value.exitCode !== undefined && (typeof value.exitCode !== 'number' || !Number.isSafeInteger(value.exitCode)))
    || (value.failureSignature !== undefined && typeof value.failureSignature !== 'string')) {
    throw new Error('Persisted pre-change command observation is invalid.');
  }
  return Object.freeze({
    checkId: value.checkId as string,
    command: value.command as string,
    preChangeSnapshotDigest: value.preChangeSnapshotDigest,
    outcome: value.outcome,
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
    ...(value.failureSignature === undefined ? {} : { failureSignature: value.failureSignature }),
    outputComplete: value.outputComplete,
    summary: value.summary
  });
}

function observationPath(runId: string): string {
  return `run-pre-change-command-observations/${createHash('sha256').update(runId).digest('hex')}.json`;
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

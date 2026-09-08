import { hashJson } from '@agent-core/persistence';
import type { AdmittedCodingCheck, PreChangeCommandObservation } from './revision-acceptance-checks.js';

export function decodePreChangeCommandObservation(
  value: unknown,
  check: AdmittedCodingCheck,
  snapshotDigest: string
): PreChangeCommandObservation {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'checkId',
          'command',
          'preChangeSnapshotDigest',
          'outcome',
          'exitCode',
          'outputSha256',
          'checkImplementationId',
          'outputComplete',
          'summary'
        ].includes(key)
    ) ||
    value.checkId !== check.id ||
    value.command !== check.command ||
    value.preChangeSnapshotDigest !== snapshotDigest ||
    (value.outcome !== 'passed' && value.outcome !== 'failed' && value.outcome !== 'unknown') ||
    value.checkImplementationId !== `coding-agent.revision-acceptance-command@1:${hashJson(check)}` ||
    typeof value.outputComplete !== 'boolean' ||
    typeof value.summary !== 'string' ||
    (value.exitCode !== undefined &&
      (typeof value.exitCode !== 'number' || !Number.isSafeInteger(value.exitCode))) ||
    (value.outputSha256 !== undefined &&
      (typeof value.outputSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.outputSha256)))
  ) {
    throw new Error('Persisted pre-change command observation is invalid.');
  }
  return Object.freeze({
    checkId: check.id,
    command: check.command,
    preChangeSnapshotDigest: value.preChangeSnapshotDigest,
    outcome: value.outcome,
    checkImplementationId: value.checkImplementationId,
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
    ...(value.outputSha256 === undefined ? {} : { outputSha256: value.outputSha256 }),
    outputComplete: value.outputComplete,
    summary: value.summary
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

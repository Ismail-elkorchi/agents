import { hashJson } from '@agent-core/persistence';
import { createHash } from 'node:crypto';
import { PrivateStateDirectory } from '../state/private-state.js';
import type { AdmittedCodingCheck, AdmittedCodingCheckPlan } from './revision-acceptance-checks.js';

/** Admits one immutable verification plan per work and reloads it for every recovery path. */
export async function loadOrAdmitCheckPlan(input: {
  readonly state: PrivateStateDirectory;
  readonly workId: string;
  readonly resuming: boolean;
  readonly proposed: AdmittedCodingCheckPlan;
}): Promise<AdmittedCodingCheckPlan> {
  const location = checkPlanPath(input.workId);
  const stored = await input.state.read(location);
  if (stored !== undefined) {
    const admitted = decodeCheckPlan(JSON.parse(stored));
    if (admitted.implementationId !== input.proposed.implementationId)
      throw new Error(
        'Continuing work requires an explicitly admitted verification contract for the changed configuration or execution environment.'
      );
    return admitted;
  }
  if (input.resuming)
    throw new Error(`Admitted check plan for continuing work ${input.workId} is missing.`);
  await input.state.write(location, JSON.stringify(input.proposed));
  return input.proposed;
}

function decodeCheckPlan(value: unknown): AdmittedCodingCheckPlan {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !['implementationId', 'checks', 'requiredCoverage'].includes(key)) ||
    typeof value.implementationId !== 'string' ||
    !Array.isArray(value.checks) ||
    (value.requiredCoverage !== 'admitted' && value.requiredCoverage !== 'missing')
  )
    throw new Error('Persisted admitted check plan is invalid.');
  const checks = Object.freeze(value.checks.map(decodeCheck));
  const expected = `coding-agent.check-plan@3:${hashJson(checks)}`;
  if (
    value.implementationId !== expected ||
    (checks.some((check) => check.requirement === 'required') ? 'admitted' : 'missing') !==
      value.requiredCoverage
  ) {
    throw new Error('Persisted admitted check plan identity is invalid.');
  }
  return Object.freeze({
    implementationId: value.implementationId,
    checks,
    requiredCoverage: value.requiredCoverage
  });
}

function decodeCheck(value: unknown): AdmittedCodingCheck {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'id',
          'command',
          'coverage',
          'requirement',
          'source',
          'sourceId',
          'timeoutMs',
          'maxOutputBytes',
          'verifierInputs',
          'verifier'
        ].includes(key)
    ) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.command !== 'string' ||
    value.command.length === 0 ||
    (value.coverage !== 'targeted' && value.coverage !== 'full') ||
    (value.requirement !== 'required' && value.requirement !== 'advisory') ||
    (value.source !== 'active-project-config' && value.source !== 'manifest-inference') ||
    typeof value.sourceId !== 'string' ||
    value.sourceId.length === 0 ||
    !positive(value.timeoutMs) ||
    !positive(value.maxOutputBytes)
  )
    throw new Error('Persisted admitted check is invalid.');
  return Object.freeze({
    id: value.id,
    command: value.command,
    coverage: value.coverage,
    requirement: value.requirement,
    source: value.source,
    sourceId: value.sourceId,
    ...(value.verifierInputs === undefined ? {} : { verifierInputs: strings(value.verifierInputs) }),
    verifier: decodeVerifier(value.verifier),
    timeoutMs: value.timeoutMs,
    maxOutputBytes: value.maxOutputBytes
  });
}

function checkPlanPath(workId: string): string {
  return `work-check-plans/${createHash('sha256').update(workId).digest('hex')}.json`;
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
    throw new TypeError('Invalid verifier input paths.');
  return Object.freeze([...value]);
}
function decodeVerifier(value: unknown): AdmittedCodingCheck['verifier'] {
  if (!record(value)) throw new TypeError('Invalid verifier contract.');
  if (value.kind === 'observational' && Object.keys(value).length === 1)
    return Object.freeze({ kind: 'observational' });
  if (
    value.kind !== 'independent' ||
    typeof value.implementationId !== 'string' ||
    typeof value.environmentPolicyId !== 'string' ||
    value.observationReuse !== 'invocation' ||
    !Array.isArray(value.inputs) ||
    value.inputs.length === 0 ||
    Object.keys(value).some(
      (key) =>
        !['kind', 'implementationId', 'environmentPolicyId', 'observationReuse', 'inputs'].includes(key)
    )
  )
    throw new TypeError('Invalid independent verifier contract.');
  const inputs = value.inputs.map((input: unknown) => {
    if (
      !record(input) ||
      typeof input.path !== 'string' ||
      typeof input.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(input.sha256) ||
      Object.keys(input).some((key) => key !== 'path' && key !== 'sha256')
    )
      throw new TypeError('Invalid verifier source binding.');
    return Object.freeze({ path: input.path, sha256: input.sha256 });
  });
  return Object.freeze({
    kind: 'independent',
    implementationId: value.implementationId,
    environmentPolicyId: value.environmentPolicyId,
    observationReuse: 'invocation',
    inputs: Object.freeze(inputs)
  });
}

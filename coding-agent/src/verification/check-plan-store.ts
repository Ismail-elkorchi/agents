import { createHash } from 'node:crypto';
import { PrivateStateDirectory } from '../state/private-state.js';
import type { AdmittedCodingCheck, AdmittedCodingCheckPlan } from './candidate-acceptance-checks.js';

/** Admits one immutable verification plan per run and reloads it for every recovery path. */
export async function loadOrAdmitCheckPlan(input: {
  readonly state: PrivateStateDirectory;
  readonly runId: string;
  readonly resuming: boolean;
  readonly proposed: AdmittedCodingCheckPlan;
}): Promise<AdmittedCodingCheckPlan> {
  const location = checkPlanPath(input.runId);
  const stored = await input.state.read(location);
  if (stored !== undefined) return decodeCheckPlan(JSON.parse(stored));
  if (input.resuming) throw new Error(`Admitted check plan for resumed run ${input.runId} is missing.`);
  await input.state.write(location, JSON.stringify(input.proposed));
  return input.proposed;
}

export async function deleteAdmittedCheckPlan(state: PrivateStateDirectory, runId: string): Promise<void> {
  await state.delete(checkPlanPath(runId));
}

function decodeCheckPlan(value: unknown): AdmittedCodingCheckPlan {
  if (!record(value)
    || Object.keys(value).some((key) => !['implementationId', 'checks', 'requiredCoverage'].includes(key))
    || typeof value.implementationId !== 'string'
    || !Array.isArray(value.checks)
    || (value.requiredCoverage !== 'admitted' && value.requiredCoverage !== 'missing')) throw new Error('Persisted admitted check plan is invalid.');
  const checks = Object.freeze(value.checks.map(decodeCheck));
  const expected = `coding-agent.check-plan@2:${createHash('sha256').update(JSON.stringify(checks)).digest('hex')}`;
  if (value.implementationId !== expected
    || (checks.some((check) => check.requirement === 'required') ? 'admitted' : 'missing') !== value.requiredCoverage) {
    throw new Error('Persisted admitted check plan identity is invalid.');
  }
  return Object.freeze({ implementationId: value.implementationId, checks, requiredCoverage: value.requiredCoverage });
}

function decodeCheck(value: unknown): AdmittedCodingCheck {
  if (!record(value)
    || Object.keys(value).some((key) => !['id', 'command', 'coverage', 'requirement', 'source', 'sourceId', 'timeoutMs', 'maxOutputBytes'].includes(key))
    || typeof value.id !== 'string' || value.id.length === 0
    || typeof value.command !== 'string' || value.command.length === 0
    || (value.coverage !== 'targeted' && value.coverage !== 'full')
    || (value.requirement !== 'required' && value.requirement !== 'advisory')
    || (value.source !== 'active-project-config' && value.source !== 'manifest-inference')
    || typeof value.sourceId !== 'string' || value.sourceId.length === 0
    || !positive(value.timeoutMs) || !positive(value.maxOutputBytes)) throw new Error('Persisted admitted check is invalid.');
  return Object.freeze({
    id: value.id,
    command: value.command,
    coverage: value.coverage,
    requirement: value.requirement,
    source: value.source,
    sourceId: value.sourceId,
    timeoutMs: value.timeoutMs,
    maxOutputBytes: value.maxOutputBytes
  });
}

function checkPlanPath(runId: string): string { return `run-check-plans/${createHash('sha256').update(runId).digest('hex')}.json`; }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

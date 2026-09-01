import { PrivateStateDirectory } from '../state/private-state.js';
import { deletePreChangeSnapshot } from '../changes/pre-change-snapshot-store.js';
import { deleteIsolatedWorkingCopy } from '../changes/isolated-working-copy.js';
import { rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { deleteAdmittedCheckPlan } from './check-plan-store.js';
import { deletePreChangeCommandObservations } from './pre-change-command-observation-store.js';
import { deleteRepositoryGuidanceState } from '../instructions/repository-guidance.js';

export async function deleteVerificationRunState(input: {
  readonly state: PrivateStateDirectory;
  readonly runtimeDirectory: string;
  readonly runId: string;
}): Promise<void> {
  await rm(path.join(input.runtimeDirectory, 'verification', createHash('sha256').update(input.runId).digest('hex')), { recursive: true, force: true });
  await deleteIsolatedWorkingCopy(input.runtimeDirectory, input.runId);
  await deleteAdmittedCheckPlan(input.state, input.runId);
  await deletePreChangeCommandObservations(input.state, input.runId);
  await deletePreChangeSnapshot(input.state, input.runId);
  await deleteRepositoryGuidanceState(input.state, input.runId);
}

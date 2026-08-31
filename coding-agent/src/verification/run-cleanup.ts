import { PrivateStateDirectory } from '../state/private-state.js';
import { deleteRunWorkspaceBaseline } from '../changes/workspace-baseline-store.js';
import { deleteCandidateWorkspace } from '@agent-core/tools-local';
import { rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { deleteAdmittedCheckPlan } from './check-plan-store.js';

export async function deleteVerificationRunState(input: {
  readonly state: PrivateStateDirectory;
  readonly runtimeDirectory: string;
  readonly runId: string;
}): Promise<void> {
  await rm(path.join(input.runtimeDirectory, 'verification', createHash('sha256').update(input.runId).digest('hex')), { recursive: true, force: true });
  await deleteCandidateWorkspace(input.runtimeDirectory, input.runId);
  await deleteAdmittedCheckPlan(input.state, input.runId);
  await deleteRunWorkspaceBaseline(input.state, input.runId);
}

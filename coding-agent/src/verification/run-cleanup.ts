import { PrivateStateDirectory } from '../state/private-state.js';
import { deleteRunWorkspaceBaseline } from '../changes/workspace-baseline-store.js';
import { deleteVerificationMaterializations } from './candidate-materialization.js';

export async function deleteVerificationRunState(input: {
  readonly state: PrivateStateDirectory;
  readonly runtimeDirectory: string;
  readonly runId: string;
}): Promise<void> {
  await deleteVerificationMaterializations(input.runtimeDirectory, input.runId);
  await deleteRunWorkspaceBaseline(input.state, input.runId);
}

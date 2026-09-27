import type { CompiledModelRequest } from '@agent-core/model';
import { redactJson } from '@agent-core/persistence';
import { decideWorkspaceAction, type WorkspaceTrustLevel } from './workspace-trust.js';

/** Application policy for exact provider input; Core owns admission and dispatch. */
export function admitProviderEgress(
  request: CompiledModelRequest,
  trustLevel: WorkspaceTrustLevel
): void {
  const decision = decideWorkspaceAction(trustLevel, 'provider_egress');
  if (decision.kind !== 'allowed') throw new Error(decision.reason);
  const material = request.retainedBody === undefined
    ? request.body
    : { body: request.body, retainedBody: request.retainedBody };
  if (redactJson(material).redactions > 0)
    throw new Error('Provider request contains unredacted credentials.');
}

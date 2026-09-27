import type { CompiledModelRequest } from '@agent-core/model';
import type { ToolAuthorizationDecision, ToolAuthorizationRequest } from '@agent-core/tools';
import {
  adoptWorkspaceContent,
  type ProvenancedWorkspaceContent,
  type WorkspaceContentKind
} from './content-provenance.js';
import { admitProviderEgress } from './provider-egress.js';
import type { CodingWorkspaceIdentity } from './workspace-identity.js';
import {
  decideToolEffects,
  decideWorkspaceAction,
  type WorkspaceAction,
  type WorkspaceActionDecision,
  type WorkspaceTrustLevel
} from './workspace-trust.js';

export class WorkspaceSecurityBoundary {
  readonly workspace: CodingWorkspaceIdentity;
  readonly trustLevel: WorkspaceTrustLevel;

  constructor(workspace: CodingWorkspaceIdentity, trustLevel: WorkspaceTrustLevel) {
    this.workspace = Object.freeze({ ...workspace });
    this.trustLevel = trustLevel;
  }

  decide(action: WorkspaceAction): WorkspaceActionDecision {
    return decideWorkspaceAction(this.trustLevel, action);
  }

  authorizeTool(request: ToolAuthorizationRequest): ToolAuthorizationDecision {
    const decision = decideToolEffects(this.trustLevel, request.effects);
    if (decision.kind === 'allowed')
      return Object.freeze({ decision: 'allow', reason: 'Allowed by the workspace trust boundary.' });
    return Object.freeze({ decision: 'deny', reason: decision.reason });
  }

  admitProviderRequest(request: CompiledModelRequest): void {
    admitProviderEgress(request, this.trustLevel);
  }

  adoptContent(input: {
    readonly content: string;
    readonly kind: WorkspaceContentKind;
    readonly sourceUri: string;
    readonly scope: string;
    readonly maxBytes?: number;
  }): ProvenancedWorkspaceContent {
    return adoptWorkspaceContent({ ...input, workspace: this.workspace, trustLevel: this.trustLevel });
  }
}

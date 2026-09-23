import type {
  AgentRunInspection,
  AgentSessionEvent,
  AgentSessionState,
  AgentSessionSubmissionResult,
  ApplicationDeliveryEvent,
  SessionBranchPage,
  SessionBranchPoint,
  SessionPendingSubmission
} from '@agent-core/runtime';
import type { RunChangeReport } from '../changes/run-change-report.js';
import type { CodingRunVerification } from '../verification/configured-check-tool.js';

export interface CodingRuntimeDetails {
  readonly workspacePath?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly temperature?: number;
  readonly reasoning?: import('@agent-core/model').ModelReasoningRequest;
  readonly sessionLocation?: string;
  readonly workspaceTrust?: 'untrusted' | 'trusted';
  readonly permissions?: {
    readonly mode: 'read_only' | 'sandbox' | 'full_host';
    readonly workspaceRead: 'root_bound';
    readonly workspaceWrite: 'denied' | 'structured';
    readonly commandExecution: 'denied' | 'sandboxed' | 'host';
    readonly network: 'denied' | 'host';
    readonly hostEscape: 'denied' | 'allowed';
    readonly tools: readonly string[];
  };
}

export interface CodingHistoryPage {
  readonly history: SessionBranchPage;
  readonly changes: readonly RunChangeReport[];
  readonly verification: readonly CodingRunVerification[];
}

export interface CodingSessionView extends CodingHistoryPage {
  readonly session: AgentSessionState;
  readonly branchPoints: readonly SessionBranchPoint[];
  readonly pendingSubmissions: readonly SessionPendingSubmission[];
  readonly runs: readonly AgentRunInspection[];
}

export type CodingSetupRequirement = 'workspace_trust' | 'provider' | 'model';
export interface CodingApplicationState {
  readonly status: 'initializing' | 'setup_required' | 'ready';
  readonly requirements: readonly CodingSetupRequirement[];
  readonly runtimeDetails: CodingRuntimeDetails;
  readonly session?: AgentSessionState;
}
export type CodingSubmissionResult =
  | AgentSessionSubmissionResult
  | {
      readonly kind: 'rejected';
      readonly reason: 'setup_required';
      readonly requirements: readonly CodingSetupRequirement[];
    };
export type CodingApplicationEvent =
  | {
      readonly type: 'command.settled';
      readonly result: import('@agent-core/tools').CommandExecutionResult;
    }
  | AgentSessionEvent
  | ApplicationDeliveryEvent
  | { readonly type: 'application.state.changed'; readonly state: CodingApplicationState }
  | { readonly type: 'session.restored'; readonly view: CodingSessionView }
  | { readonly type: 'verification.updated'; readonly verification: CodingRunVerification };

import type {
  AgentRunInspection,
  AgentSessionState,
  SessionBranchPage,
  SessionBranchPoint,
  SessionPendingSubmission
} from '@agent-core/runtime';
import type { ApplicationDeliveryEvent } from '@agents/application';
import type { CodingHandoff } from '../changes/coding-handoff.js';
import type { CodingSessionEvent, CodingSessionSubmissionResult } from '../coding-session.js';

export interface CodingRuntimeDetails {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly temperature?: number;
  readonly reasoningEffort?: string;
  readonly sessionLocation?: string;
  readonly workspaceTrust?: 'untrusted' | 'restricted' | 'trusted';
  readonly permissions?: {
    readonly mode: 'review' | 'edit' | 'develop';
    readonly trust: 'restricted' | 'trusted';
    readonly workspaceRead: 'root_bound';
    readonly workspaceWrite: 'denied' | 'structured';
    readonly commandExecution: 'denied' | 'sandboxed';
    readonly network: 'denied';
    readonly hostEscape: 'denied';
    readonly tools: readonly string[];
  };
}

export interface CodingHistoryPage {
  readonly history: SessionBranchPage;
  readonly handoffs: readonly CodingHandoff[];
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
  | CodingSessionSubmissionResult
  | {
      readonly kind: 'rejected';
      readonly reason: 'setup_required';
      readonly requirements: readonly CodingSetupRequirement[];
    };
export type CodingLoginResult =
  | { readonly kind: 'not_required'; readonly provider: 'ollama' }
  | { readonly kind: 'api_key'; readonly provider: 'openai' | 'openrouter'; readonly available: boolean }
  | { readonly kind: 'authenticated'; readonly provider: 'openai-codex' };
export type CodingApplicationEvent =
  | CodingSessionEvent
  | ApplicationDeliveryEvent
  | { readonly type: 'application.state.changed'; readonly state: CodingApplicationState }
  | {
      readonly type: 'authentication.required';
      readonly verificationUri: string;
      readonly userCode: string;
      readonly expiresInSeconds: number;
    }
  | { readonly type: 'session.restored'; readonly view: CodingSessionView }
  | { readonly type: 'handoff.ready'; readonly handoff: CodingHandoff };

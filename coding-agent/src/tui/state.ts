import { createScrollState, createTextAreaState } from '@ismail-elkorchi/terminal-ui/behavior';
import type { ScrollState, TextAreaState, UnscrolledSearchPickerState } from '@ismail-elkorchi/terminal-ui/behavior';
import type {
  AgentApprovalSuspension,
  AgentOperationInspection,
  AgentOperationSuspension,
  AgentDeliveryDiagnostic,
  AgentProgressEvent,
  AgentProviderStateSummary,
  AgentReplayPayload,
  AgentRunBudgetState,
  AgentRunConfiguration,
  AgentRunPhase,
  AgentSessionState,
  SessionBranchPoint,
  SessionPendingSubmission,
  SessionReplayState,
  AgentTerminalSnapshot
} from '@agent-core/runtime';
import type { RunChangeReport } from '../changes/run-change-report.js';
import type { CodingAgentTuiConversationEntry } from './conversation-model.js';

export interface CodingAgentTuiRuntimeDetails {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly temperature?: number;
  readonly reasoningEffort?: string;
  readonly showReasoning?: boolean;
  readonly sessionLocation?: string;
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

export interface CodingAgentTuiDebugState {
  readonly runId?: string;
  readonly sessionId?: string;
  readonly sessionLocation?: string;
  readonly phase?: AgentRunPhase;
  readonly configuration?: AgentRunConfiguration;
  readonly budget?: AgentRunBudgetState;
  readonly replay?: AgentReplayPayload;
  readonly providerState?: AgentProviderStateSummary;
  readonly latestHistoryReduction?: Extract<AgentProgressEvent, { readonly type: 'context.history.reduced' }>;
  readonly latestCheckpoint?: Extract<AgentProgressEvent, { readonly type: 'context.checkpoint.created' }>;
  readonly terminal?: AgentTerminalSnapshot;
  readonly deliveryDiagnostics: readonly AgentDeliveryDiagnostic[];
  readonly session?: AgentSessionState;
  readonly replayState?: SessionReplayState;
  readonly branchPoints: readonly SessionBranchPoint[];
  readonly pendingSubmissions: readonly SessionPendingSubmission[];
  readonly operations: readonly AgentOperationInspection[];
  readonly changeReports: readonly RunChangeReport[];
}

export type CodingAgentTuiRunState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working'; readonly label: string; readonly phase?: AgentRunPhase }
  | { readonly kind: 'waiting_for_approval'; readonly suspension: AgentApprovalSuspension }
  | { readonly kind: 'waiting_for_recovery'; readonly suspension: AgentOperationSuspension }
  | { readonly kind: 'ended'; readonly terminal: AgentTerminalSnapshot }
  | { readonly kind: 'failed'; readonly message: string };

export type CodingAgentTuiOverlay =
  | { readonly kind: 'none' }
  | { readonly kind: 'commands'; readonly picker: CodingAgentTuiPickerState }
  | { readonly kind: 'search'; readonly picker: CodingAgentTuiPickerState }
  | { readonly kind: 'help' }
  | { readonly kind: 'debug'; readonly text: string };

export type CodingAgentTuiPickerState = UnscrolledSearchPickerState;

export interface CodingAgentTuiConversationState {
  readonly items: readonly CodingAgentTuiConversationEntry[];
  readonly omittedEntries: number;
  readonly omittedBytes: number;
  readonly scroll: ScrollState;
  readonly expandedIds: readonly string[];
}

export interface CodingAgentTuiComposerState {
  readonly input: TextAreaState;
  readonly history: readonly string[];
  readonly historyIndex: number | null;
  readonly historyDraft: string;
  readonly submissionCount: number;
}

export interface CodingAgentTuiState {
  readonly run: CodingAgentTuiRunState;
  readonly conversation: CodingAgentTuiConversationState;
  readonly composer: CodingAgentTuiComposerState;
  readonly overlay: CodingAgentTuiOverlay;
  readonly modalOffsetRow: number;
  readonly runtimeDetails: CodingAgentTuiRuntimeDetails;
  readonly debug: CodingAgentTuiDebugState;
  readonly nextLocalId: number;
}

export function createInitialCodingAgentTuiState(
  runtimeDetails: CodingAgentTuiRuntimeDetails = {}
): CodingAgentTuiState {
  return {
    run: { kind: 'idle' },
    conversation: {
      items: [],
      omittedEntries: 0,
      omittedBytes: 0,
      scroll: createScrollState({ followTail: true }),
      expandedIds: []
    },
    composer: {
      input: createTextAreaState({ value: '', scroll: createScrollState({ followTail: true }) }),
      history: [],
      historyIndex: null,
      historyDraft: '',
      submissionCount: 0
    },
    overlay: { kind: 'none' },
    modalOffsetRow: 0,
    runtimeDetails,
    debug: {
      ...(runtimeDetails.sessionLocation === undefined ? {} : { sessionLocation: runtimeDetails.sessionLocation }),
      deliveryDiagnostics: [],
      branchPoints: [],
      pendingSubmissions: [],
      operations: [],
      changeReports: []
    },
    nextLocalId: 1
  };
}

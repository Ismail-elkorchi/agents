import { createScrollState, createTextAreaState } from '@ismail-elkorchi/terminal-ui/behavior';
import type { ScrollState, TextAreaState, UnscrolledSearchPickerState } from '@ismail-elkorchi/terminal-ui/behavior';
import type {
  AgentApprovalSuspension,
  AgentOperationSuspension,
  AgentDeliveryDiagnostic,
  AgentProgressEvent,
  AgentProviderStateSummary,
  AgentReplayPayload,
  AgentRunBudgetState,
  AgentRunConfiguration,
  AgentRunPhase,
  AgentTerminalSnapshot
} from '@agent-core/runtime';
import type { CodingAgentTuiConversationEntry } from './conversation-model.js';

export interface CodingAgentTuiRuntimeDetails {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly temperature?: number;
  readonly reasoningEffort?: string;
  readonly showReasoning?: boolean;
  readonly sessionLocation?: string;
  readonly permissions?: {
    readonly workspaceWrites: 'denied' | 'dry_run' | 'allowed' | 'ambient_shell';
    readonly shell: 'denied' | 'ambient';
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
  task: string,
  runtimeDetails: CodingAgentTuiRuntimeDetails = {}
): CodingAgentTuiState {
  const trimmed = task.trim();
  const items: readonly CodingAgentTuiConversationEntry[] = trimmed.length === 0
    ? []
    : [{ id: 'user:initial', kind: 'user', text: trimmed }];
  return {
    run: { kind: 'idle' },
    conversation: {
      items,
      omittedEntries: 0,
      omittedBytes: 0,
      scroll: createScrollState({ followTail: true }),
      expandedIds: []
    },
    composer: {
      input: createTextAreaState({ value: '', scroll: createScrollState({ followTail: true }) }),
      history: [],
      submissionCount: 0
    },
    overlay: { kind: 'none' },
    modalOffsetRow: 0,
    runtimeDetails,
    debug: {
      ...(runtimeDetails.sessionLocation === undefined ? {} : { sessionLocation: runtimeDetails.sessionLocation }),
      deliveryDiagnostics: []
    },
    nextLocalId: 1
  };
}

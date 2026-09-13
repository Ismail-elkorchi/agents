import type {
  AgentApprovalSuspension,
  AgentDeliveryDiagnostic,
  AgentProviderStateSummary,
  AgentReplayPayload,
  AgentRunBudgetState,
  AgentRunConfiguration,
  AgentRunInspection,
  AgentRunPhase,
  AgentRunSuspension,
  AgentSessionState,
  AgentTerminalSnapshot,
  SessionBranchPoint,
  SessionPendingSubmission
} from '@agent-core/runtime';
import type { ComposerDraft, ConversationEntry, NotesState } from '@agent-core/tui';
import { defaultTuiPreferences, RetainedListPresentation } from '@agent-core/tui';
import type { ScrollState, UnscrolledSearchPickerState } from '@ismail-elkorchi/terminal-ui/behavior';
import { createScrollState, createTextAreaState } from '@ismail-elkorchi/terminal-ui/behavior';
import type { MeasuredWindowAnchor } from '@ismail-elkorchi/terminal-ui/collection';
import type {
  CodingHistoryPage,
  CodingRuntimeDetails,
  CodingSetupRequirement
} from '../application/contracts.js';
import type { RunChangeReport } from '../changes/run-change-report.js';
import type { CodingRunVerification } from '../verification/configured-check-tool.js';
import type { InteractiveCommandName } from './interactive-commands.js';
import type { CodingPanel } from './panels.js';
import type { HistorySearch } from './search.js';

export interface CodingAgentTuiSetupState {
  readonly status: 'initializing' | 'setup_required' | 'ready';
  readonly requirements: readonly CodingSetupRequirement[];
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
  readonly terminal?: AgentTerminalSnapshot;
  readonly deliveryDiagnostics: readonly AgentDeliveryDiagnostic[];
  readonly session?: AgentSessionState;
  readonly branchPoints: readonly SessionBranchPoint[];
  readonly pendingSubmissions: readonly SessionPendingSubmission[];
  readonly runs: readonly AgentRunInspection[];
  readonly changes: readonly RunChangeReport[];
  readonly verification: readonly CodingRunVerification[];
}

export type CodingAgentTuiRunState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working'; readonly label: string; readonly phase?: AgentRunPhase }
  | { readonly kind: 'waiting_for_approval'; readonly suspension: AgentApprovalSuspension }
  | {
      readonly kind: 'waiting_for_recovery';
      readonly suspension: AgentRunSuspension;
      readonly operation?: import('./recovery.js').RecoveryAction;
      readonly message?: string;
    }
  | { readonly kind: 'ended'; readonly terminal: AgentTerminalSnapshot }
  | { readonly kind: 'failed'; readonly message: string };

export type CodingAgentTuiOverlay =
  | { readonly kind: 'processes'; readonly state: import('./processes.js').ProcessPanel }
  | { readonly kind: 'session-name'; readonly state: import('@agent-core/tui').SessionNameState }
  | { readonly kind: 'inspector'; readonly state: import('@agent-core/tui').SourceInspector }
  | { readonly kind: 'attachments'; readonly state: import('@agent-core/tui').AttachmentState }
  | { readonly kind: 'recall'; readonly state: import('@agent-core/tui').PromptRecallState }
  | { readonly kind: 'queue'; readonly state: import('@agent-core/tui').QueueState }
  | {
      readonly kind: 'preferences';
      readonly capture?: string;
      readonly error?: string;
      readonly preferences: import('@agent-core/tui').TuiPreferences;
    }
  | { readonly kind: 'configuration'; readonly state: import('@agent-core/tui').ConfigurationState }
  | { readonly kind: 'context-loading'; readonly requestId: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'decision' }
  | { readonly kind: 'notes'; readonly state: NotesState }
  | { readonly kind: 'commands'; readonly picker: CodingAgentTuiPickerState }
  | {
      readonly kind: 'command_values';
      readonly command: InteractiveCommandName;
      readonly picker: CodingAgentTuiPickerState;
    }
  | HistorySearch
  | CodingPanel
  | { readonly kind: 'help' }
  | { readonly kind: 'debug'; readonly text: string };

export type CodingAgentTuiPickerState = UnscrolledSearchPickerState;

export interface CodingAgentTuiConversationState {
  readonly items: readonly ConversationEntry[];
  readonly pages: readonly CodingHistoryPage[];
  readonly unread: boolean;
  readonly loading?: {
    readonly id: string;
    readonly direction: 'older' | 'newer' | 'tail' | 'restore';
    readonly refreshTail?: boolean;
  };
  readonly anchor?: MeasuredWindowAnchor;
  readonly scroll: ScrollState;
  readonly expandedIds: readonly string[];
}

export interface CodingAgentTuiComposerState extends ComposerDraft {
  readonly submitting: boolean;
  readonly commandReturnDraft?: ComposerDraft;
  readonly history: import('@agent-core/tui').PromptHistory;
  readonly submissionCount: number;
}

export interface CodingAgentTuiState {
  readonly historyMatch?: import('@agent-core/tui').HistoryMatchPosition;
  readonly draftRestoreSession?: string;
  readonly progress: import('@agent-core/tui').ProgressPresentation;
  readonly attention: import('@agent-core/tui').AttentionState;
  readonly resourceCompletion?: import('@agent-core/tui').ResourceCompletion | undefined;
  readonly completion?: import('@agent-core/tui').CommandCompletion | undefined;
  readonly sessionViews: Readonly<
    Record<
      string,
      {
        readonly composer: CodingAgentTuiComposerState;
        readonly history: import('@agent-core/tui').HistoryBookmark;
      }
    >
  >;
  readonly presentation: RetainedListPresentation<ConversationEntry>;
  readonly preferences: import('@agent-core/tui').TuiPreferences;
  readonly setup: CodingAgentTuiSetupState;
  readonly run: CodingAgentTuiRunState;
  readonly conversation: CodingAgentTuiConversationState;
  readonly composer: CodingAgentTuiComposerState;
  readonly overlay: CodingAgentTuiOverlay;
  readonly modalOffsetRow: number;
  readonly runtimeDetails: CodingRuntimeDetails;
  readonly debug: CodingAgentTuiDebugState;
  readonly nextLocalId: number;
}

export function createInitialCodingAgentTuiState(
  runtimeDetails: CodingRuntimeDetails = {},
  setup: CodingAgentTuiSetupState = { status: 'ready', requirements: [] },
  preferences = defaultTuiPreferences
): CodingAgentTuiState {
  return {
    sessionViews: {},
    attention: { focused: true },
    progress: { label: 'Idle' },
    presentation: new RetainedListPresentation<ConversationEntry>(),
    preferences,
    setup,
    run: { kind: 'idle' },
    conversation: {
      items: [],
      pages: [],
      unread: false,
      scroll: createScrollState({ followTail: true }),
      expandedIds: []
    },
    composer: {
      submitting: false,
      attachments: [],
      input: createTextAreaState({ value: '', scroll: createScrollState({ followTail: true }) }),
      history: { entries: [], index: null },
      submissionCount: 0
    },
    overlay: { kind: 'none' },
    modalOffsetRow: 0,
    runtimeDetails,
    debug: {
      ...(runtimeDetails.sessionLocation === undefined
        ? {}
        : { sessionLocation: runtimeDetails.sessionLocation }),
      deliveryDiagnostics: [],
      branchPoints: [],
      pendingSubmissions: [],
      runs: [],
      changes: [],
      verification: []
    },
    nextLocalId: 1
  };
}

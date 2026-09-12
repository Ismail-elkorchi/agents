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
import type { NotesState } from '@agents/tui';
import { RetainedListPresentation } from '@agents/tui';
import type {
  ScrollState,
  TextAreaState,
  UnscrolledSearchPickerState
} from '@ismail-elkorchi/terminal-ui/behavior';
import { createScrollState, createTextAreaState } from '@ismail-elkorchi/terminal-ui/behavior';
import type { MeasuredWindowAnchor } from '@ismail-elkorchi/terminal-ui/collection';
import type {
  CodingHistoryPage,
  CodingRuntimeDetails,
  CodingSetupRequirement
} from '../application/contracts.js';
import type { RunChangeReport } from '../changes/run-change-report.js';
import type { CodingRunVerification } from '../verification/configured-check-tool.js';
import type { CodingAgentTuiConversationEntry } from './conversation-model.js';
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
  | { readonly kind: 'none' }
  | { readonly kind: 'notes'; readonly state: NotesState }
  | { readonly kind: 'commands'; readonly picker: CodingAgentTuiPickerState }
  | {
      readonly kind: 'command_values';
      readonly command: InteractiveCommandName;
      readonly picker: CodingAgentTuiPickerState;
    }
  | HistorySearch
  | CodingPanel
  | { readonly kind: 'files_loading'; readonly request: FileCompletionRequest }
  | {
      readonly kind: 'files';
      readonly request: FileCompletionRequest;
      readonly paths: readonly string[];
      readonly picker: CodingAgentTuiPickerState;
    }
  | { readonly kind: 'help' }
  | { readonly kind: 'debug'; readonly text: string };

export type CodingAgentTuiPickerState = UnscrolledSearchPickerState;

export interface FileCompletionRequest {
  readonly id: string;
  readonly original: string;
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
}

export interface CodingAgentTuiConversationState {
  readonly items: readonly CodingAgentTuiConversationEntry[];
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

export interface CodingAgentTuiComposerState {
  readonly submitting: boolean;
  readonly commandReturnDraft?: string;
  readonly input: TextAreaState;
  readonly history: readonly string[];
  readonly historyIndex: number | null;
  readonly historyDraft: string;
  readonly submissionCount: number;
}

export interface CodingAgentTuiState {
  readonly sessionViews: Readonly<
    Record<
      string,
      {
        readonly composer: CodingAgentTuiComposerState;
        readonly history: import('@agents/tui').HistoryBookmark;
      }
    >
  >;
  readonly presentation: RetainedListPresentation<CodingAgentTuiConversationEntry>;
  readonly showReasoning: boolean;
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
  showReasoning = false
): CodingAgentTuiState {
  return {
    sessionViews: {},
    presentation: new RetainedListPresentation<CodingAgentTuiConversationEntry>(),
    showReasoning,
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

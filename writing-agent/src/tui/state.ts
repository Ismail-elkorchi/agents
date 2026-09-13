import type {
  AgentProgressEvent,
  AgentRunResult,
  SessionBranchEntry,
  SessionBranchPage
} from '@agent-core/runtime';
import type { ComposerDraft, ConversationEntry, NotesState } from '@agent-core/tui';
import {
  createDraft,
  defaultTuiPreferences,
  MarkdownDocument,
  RetainedListPresentation
} from '@agent-core/tui';
import type {
  SearchPickerControlTransition,
  TextAreaState,
  TextAreaTransition,
  UnscrolledSearchPickerState
} from '@ismail-elkorchi/terminal-ui/behavior';
import type { MeasuredWindowAnchor } from '@ismail-elkorchi/terminal-ui/collection';
import type { ScrollRequest } from '@ismail-elkorchi/terminal-ui/interaction';
import type {
  WritingApplication,
  WritingApplicationState,
  WritingDocument
} from '../application/service.js';

export type WritingView = 'document' | 'conversation';
export type WritingTuiOverlay =
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
  | { readonly kind: 'none' }
  | { readonly kind: 'notes'; readonly state: NotesState }
  | { readonly kind: 'loading'; readonly requestId: string }
  | { readonly kind: 'source' }
  | { readonly kind: 'recovery' }
  | {
      readonly kind: 'search';
      readonly input: TextAreaState;
      readonly result?: import('@agent-core/runtime').SessionBranchSearchResult;
      readonly requestId?: string;
      readonly error?: string;
    }
  | {
      readonly kind: 'picker';
      readonly subject: 'resources' | 'outline' | 'sessions' | 'commands';
      readonly entries: readonly {
        readonly id: string;
        readonly label: string;
      }[];
      readonly picker: UnscrolledSearchPickerState;
    }
  | { readonly kind: 'configuration'; readonly state: import('@agent-core/tui').ConfigurationState };

export interface WritingTuiState {
  readonly historyMatch?: import('@agent-core/tui').HistoryMatchPosition;
  readonly draftRestoreSession?: string;
  readonly progress: import('@agent-core/tui').ProgressPresentation;
  readonly attention: import('@agent-core/tui').AttentionState;
  readonly resourceCompletion?: import('@agent-core/tui').ResourceCompletion | undefined;
  readonly completion?: import('@agent-core/tui').CommandCompletion | undefined;
  readonly preferences: import('@agent-core/tui').TuiPreferences;
  readonly liveConversation: readonly ConversationEntry[];
  readonly expandedTools: readonly string[];
  readonly sessionViews: Readonly<
    Record<
      string,
      {
        readonly composer: ComposerDraft;
        readonly view: WritingView;
        readonly bookmark: import('@agent-core/tui').HistoryBookmark;
      }
    >
  >;
  readonly application: WritingApplicationState;
  readonly document?: {
    readonly value: WritingDocument;
    readonly input: TextAreaState;
    readonly markdown: MarkdownDocument;
    readonly source: boolean;
    readonly offsetRow: number;
  };
  readonly composer: ComposerDraft;

  readonly submitting: boolean;
  readonly directory: string;
  readonly view: WritingView;
  readonly overlay: WritingTuiOverlay;
  readonly history: readonly SessionBranchPage[];
  readonly historyRequestId?: string;
  readonly conversationOffset: number;
  readonly presentation: RetainedListPresentation<ConversationEntry>;
  readonly historyEntryCache: WeakMap<
    SessionBranchEntry,
    {
      readonly activity?: import('@agent-core/tui').ConversationActivityEntry;
      readonly entries: readonly ConversationEntry[];
    }
  >;
  readonly followTail: boolean;
  readonly unread: boolean;
  readonly conversationAnchor?: MeasuredWindowAnchor;
  readonly offsets: Readonly<Record<string, number>>;
  readonly promptHistory: import('@agent-core/tui').PromptHistory;
  readonly source?: { readonly title: string; readonly input: TextAreaState };
  readonly sessionView?: Awaited<ReturnType<WritingApplication['readSession']>>;
  readonly result?: AgentRunResult;
  readonly failure?: string;
  readonly notice: string;
}

export function initialWritingState(
  application: WritingApplicationState,
  preferences = defaultTuiPreferences
): WritingTuiState {
  return {
    application,
    sessionViews: {},
    attention: { focused: true },
    progress: { label: 'Idle' },
    preferences,
    liveConversation: [],
    expandedTools: [],
    composer: createDraft(),
    submitting: false,
    directory: '.',
    view: 'conversation',
    overlay: { kind: 'none' },
    history: [],
    conversationOffset: 0,
    presentation: new RetainedListPresentation(),
    historyEntryCache: new WeakMap(),
    followTail: true,
    unread: false,
    offsets: {},
    promptHistory: { entries: [], index: null },
    notice: ''
  };
}

export type WritingTuiMessage =
  | { readonly type: 'submission.failed'; readonly sessionId: string; readonly message: string }
  | {
      readonly type: 'context.loaded';
      readonly requestId: string;
      readonly sessionId: string;
      readonly content: string;
    }
  | { readonly type: 'context.failed'; readonly requestId: string; readonly message: string }
  | { readonly type: 'search.adjacent'; readonly direction: 'previous' | 'next' }
  | { readonly type: 'conversation.message'; readonly direction: 'previous' | 'next' }
  | { readonly type: 'terminal.resized' }
  | {
      readonly type: 'history.inspect';
      readonly reference: import('@agent-core/tui').ConversationReferenceEntry;
    }
  | import('@agent-core/tui').SessionNameMessage
  | import('@agent-core/tui').ResourceCompletionMessage
  | { readonly type: 'conversation.export' }
  | import('@agent-core/tui').SourceInspectorMessage
  | import('@agent-core/tui').DraftMessage
  | import('@agent-core/tui').AttachmentMessage
  | import('@agent-core/tui').PromptRecallMessage
  | import('@agent-core/tui').QueueMessage
  | { readonly type: 'queue.open' | 'context.open' | 'status.open' }
  | { readonly type: 'prompt.navigate'; readonly direction: 'older' | 'newer' }
  | { readonly type: 'terminal.focus'; readonly focused: boolean }
  | import('@agent-core/tui').PreferencesMessage
  | { readonly type: 'preferences.open' }
  | import('@agent-core/tui').NotesMessage
  | { readonly type: 'commands.open' | 'tools.toggle' | 'reasoning.toggle' | 'completion.close' }
  | { readonly type: 'completion.move'; readonly delta: number }
  | { readonly type: 'completion.accept'; readonly open: boolean; readonly name?: string }
  | { readonly type: 'tool.toggle'; readonly id: string }
  | { readonly type: 'source.copy'; readonly text: string }
  | { readonly type: 'search.open' }
  | { readonly type: 'search.edit'; readonly transition: TextAreaTransition }
  | { readonly type: 'search.submit'; readonly more: boolean }
  | {
      readonly type: 'search.loaded';
      readonly requestId: string;
      readonly result: import('@agent-core/runtime').SessionBranchSearchResult;
    }
  | {
      readonly type: 'search.failed';
      readonly requestId: string;
      readonly message: string;
    }
  | { readonly type: 'search.jump'; readonly entryId: string }
  | {
      readonly type: 'search.jumped';
      readonly page: SessionBranchPage;
      readonly entryId: string;
    }
  | {
      readonly type: 'section.scroll';
      readonly id: string;
      readonly request: ScrollRequest;
    }
  | {
      readonly type: 'source.loaded';
      readonly title: string;
      readonly content: string;
    }
  | { readonly type: 'source.edit'; readonly transition: TextAreaTransition }
  | { readonly type: 'recovery.open' }
  | {
      readonly type: 'recovery.loaded';
      readonly session: Awaited<ReturnType<WritingApplication['readSession']>>;
    }
  | { readonly type: 'recovery.resume' }
  | { readonly type: 'recovery.abort' }
  | { readonly type: 'recovery.choice'; readonly choice: string }
  | {
      readonly type: 'recovery.approval';
      readonly runId: string;
      readonly approvalId: string;
      readonly fingerprint: string;
      readonly decision: 'allow' | 'deny';
    }
  | { readonly type: 'refresh' }
  | {
      readonly type: 'loaded';
      readonly recordedRunId?: string;
      readonly session?: Awaited<ReturnType<WritingApplication['readSession']>>;
      readonly document?:
        | { readonly kind: 'available'; readonly value: WritingDocument }
        | { readonly kind: 'unavailable'; readonly message: string };
      readonly history: SessionBranchPage;
      readonly application: WritingApplicationState;
    }
  | { readonly type: 'notice'; readonly message: string }
  | { readonly type: 'application'; readonly state: WritingApplicationState }
  | { readonly type: 'progress'; readonly runId: string; readonly event: AgentProgressEvent }
  | { readonly type: 'result'; readonly result: AgentRunResult }
  | {
      readonly type: 'composer.edit' | 'document.edit';
      readonly transition: TextAreaTransition;
    }
  | { readonly type: 'submit'; readonly delivery?: 'follow_up' | 'steer' }
  | {
      readonly type: 'submitted';
      readonly sessionId: string;
      readonly draft: import('@agent-core/tui').ComposerDraft;
      readonly receipt:
        | Omit<
            Exclude<
              import('../application/service.js').WritingSubmissionResult,
              { readonly kind: 'rejected' }
            >,
            'completion'
          >
        | Extract<
            import('../application/service.js').WritingSubmissionResult,
            { readonly kind: 'rejected' }
          >;
    }
  | { readonly type: 'view'; readonly view: WritingView }
  | {
      readonly type:
        | 'document.toggle-source'
        | 'document.use-passage'
        | 'external-editor'
        | 'interrupt'
        | 'exit';
    }
  | {
      readonly type: 'external-edited';
      readonly sessionId: string;
      readonly draft: import('@agent-core/tui').ComposerDraft;
      readonly text: string;
    }
  | {
      readonly type: 'document.scroll' | 'conversation.scroll';
      readonly request: ScrollRequest;
    }
  | {
      readonly type: 'picker.open';
      readonly subject: Exclude<Extract<WritingTuiOverlay, { kind: 'picker' }>['subject'], 'commands'>;
    }
  | {
      readonly type: 'picker.loaded';
      readonly requestId: string;
      readonly subject: Exclude<Extract<WritingTuiOverlay, { kind: 'picker' }>['subject'], 'commands'>;
      readonly entries: readonly {
        readonly id: string;
        readonly label: string;
      }[];
    }
  | {
      readonly type: 'picker.transition';
      readonly transition: SearchPickerControlTransition;
    }
  | { readonly type: 'picker.accept'; readonly id: string }
  | { readonly type: 'document.loaded'; readonly document: WritingDocument }
  | import('@agent-core/tui').ConfigurationMessage
  | { readonly type: 'configuration.open' }
  | {
      readonly type: 'history.failed';
      readonly requestId: string;
      readonly message: string;
    }
  | {
      readonly type: 'history.load';
      readonly direction: 'older' | 'newer' | 'tail';
    }
  | {
      readonly type: 'history.loaded';
      readonly requestId: string;
      readonly pages: readonly SessionBranchPage[];
      readonly direction: 'older' | 'newer' | 'tail' | 'restore';
    }
  | { readonly type: 'overlay.close' | 'mode.toggle' | 'session.new' };

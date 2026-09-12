import type {
  AgentProgressEvent,
  AgentRunResult,
  SessionBranchEntry,
  SessionBranchPage
} from '@agent-core/runtime';
import type { NotesState } from '@agents/tui';
import { MarkdownDocument, RetainedListPresentation } from '@agents/tui';
import type {
  SearchPickerControlTransition,
  TextAreaState,
  TextAreaTransition,
  UnscrolledSearchPickerState
} from '@ismail-elkorchi/terminal-ui/behavior';
import { createTextAreaState } from '@ismail-elkorchi/terminal-ui/behavior';
import type { MeasuredWindowAnchor } from '@ismail-elkorchi/terminal-ui/collection';
import type { ScrollRequest } from '@ismail-elkorchi/terminal-ui/interaction';
import type { WritingApplication, WritingApplicationState, WritingDocument } from '../application/service.js';
import type { WritingHistoryMessage } from './history.js';

export type WritingView = 'document' | 'conversation';
export type WritingTuiOverlay =
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
      readonly subject: 'resources' | 'outline' | 'sessions' | 'drafts';
      readonly entries: readonly {
        readonly id: string;
        readonly label: string;
      }[];
      readonly picker: UnscrolledSearchPickerState;
    }
  | {
      readonly kind: 'form';
      readonly subject: 'configure';
      readonly fields: readonly {
        readonly name: string;
        readonly input: TextAreaState;
      }[];
    };

export interface WritingTuiState {
  readonly sessionViews: Readonly<
    Record<
      string,
      {
        readonly composer: TextAreaState;
        readonly view: WritingView;
        readonly bookmark: import('@agents/tui').HistoryBookmark;
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
  readonly composer: TextAreaState;
  readonly submitting: boolean;
  readonly directory: string;
  readonly view: WritingView;
  readonly overlay: WritingTuiOverlay;
  readonly history: readonly SessionBranchPage[];
  readonly historyRequestId?: string;
  readonly conversationOffset: number;
  readonly presentation: RetainedListPresentation<WritingHistoryMessage>;
  readonly historyEntryCache: WeakMap<SessionBranchEntry, WritingHistoryMessage>;
  readonly followTail: boolean;
  readonly unread: boolean;
  readonly conversationAnchor?: MeasuredWindowAnchor;
  readonly offsets: Readonly<Record<string, number>>;
  readonly savedDrafts: readonly string[];
  readonly source?: { readonly title: string; readonly input: TextAreaState };
  readonly sessionView?: Awaited<ReturnType<WritingApplication['readSession']>>;
  readonly live?: { readonly turnId: string; readonly content: string };
  readonly result?: AgentRunResult;
  readonly failure?: string;
  readonly notice: string;
}

export function initialWritingState(application: WritingApplicationState): WritingTuiState {
  return {
    application,
    sessionViews: {},
    composer: createTextAreaState({ value: '' }),
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
    savedDrafts: [],
    notice: ''
  };
}

export type WritingTuiMessage =
  | import('@agents/tui').NotesMessage
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
  | { readonly type: 'form.completed' }
  | { readonly type: 'refresh' }
  | {
      readonly type: 'loaded';
      readonly session?: Awaited<ReturnType<WritingApplication['readSession']>>;
      readonly document?:
        | { readonly kind: 'available'; readonly value: WritingDocument }
        | { readonly kind: 'unavailable'; readonly message: string };
      readonly history: SessionBranchPage;
      readonly application: WritingApplicationState;
    }
  | { readonly type: 'notice'; readonly message: string }
  | { readonly type: 'application'; readonly state: WritingApplicationState }
  | { readonly type: 'progress'; readonly event: AgentProgressEvent }
  | { readonly type: 'result'; readonly result: AgentRunResult }
  | {
      readonly type: 'composer.edit' | 'document.edit';
      readonly transition: TextAreaTransition;
    }
  | { readonly type: 'submit' }
  | {
      readonly type: 'submitted';
      readonly original: string;
      readonly accepted: boolean;
      readonly message: string;
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
      readonly original: string;
      readonly text: string;
    }
  | {
      readonly type: 'document.scroll' | 'conversation.scroll';
      readonly request: ScrollRequest;
    }
  | {
      readonly type: 'picker.open';
      readonly subject: Extract<WritingTuiOverlay, { kind: 'picker' }>['subject'];
    }
  | {
      readonly type: 'picker.loaded';
      readonly requestId: string;
      readonly subject: Extract<WritingTuiOverlay, { kind: 'picker' }>['subject'];
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
  | { readonly type: 'form.open'; readonly subject: 'configure' }
  | {
      readonly type: 'form.edit';
      readonly index: number;
      readonly transition: TextAreaTransition;
    }
  | { readonly type: 'form.submit' }
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

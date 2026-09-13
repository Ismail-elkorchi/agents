import type {
  AgentApprovalSuspension,
  AgentEndedRunResult,
  AgentProgressEvent,
  AgentRunSuspension,
  ContextWindowRecord,
  SessionBranchSearchResult,
  SessionPendingSubmission
} from '@agent-core/runtime';
import type {
  ScrollTransition,
  SearchPickerAcceptEvent,
  SearchPickerControlTransition,
  TextAreaTransition
} from '@ismail-elkorchi/terminal-ui/behavior';
import type { ScrollRequest } from '@ismail-elkorchi/terminal-ui/interaction';
import type {
  CodingApplicationState,
  CodingHistoryPage,
  CodingSessionView
} from '../application/contracts.js';
import type { CodingRunVerification } from '../verification/configured-check-tool.js';
import type { CodingAgentTuiCommandExecution, CodingAgentTuiCommandRequest } from './command-surface.js';
import type { PanelItem, PanelKind } from './panels.js';

export type CodingAgentTuiMessage =
  | {
      readonly type: 'context.loaded';
      readonly requestId: string;
      readonly sessionId: string;
      readonly content: string;
    }
  | { readonly type: 'context.failed'; readonly requestId: string; readonly message: string }
  | { readonly type: 'context.open' }
  | { readonly type: 'search.adjacent'; readonly direction: 'previous' | 'next' }
  | { readonly type: 'conversation.message'; readonly direction: 'previous' | 'next' }
  | import('./processes.js').ProcessMessage
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
  | { readonly type: 'queue.open' }
  | { readonly type: 'terminal.focus'; readonly focused: boolean }
  | import('@agent-core/tui').PreferencesMessage
  | { readonly type: 'preferences.open' }
  | import('@agent-core/tui').NotesMessage
  | import('@agent-core/tui').ConfigurationMessage
  | { readonly type: 'completion.move'; readonly delta: number }
  | { readonly type: 'completion.accept'; readonly open: boolean; readonly name?: string }
  | { readonly type: 'completion.close' }
  | { readonly type: 'configuration.open' | 'recovery.open' | 'session.new' | 'setup.open' }
  | { readonly type: 'tools.toggle' | 'reasoning.toggle' | 'application.exit' }
  | { readonly type: 'source.copy' }
  | {
      readonly type: 'submissions.changed';
      readonly cancelledRunId?: string;
      readonly pending: readonly SessionPendingSubmission[];
    }
  | { readonly type: 'panel.source-loaded'; readonly title: string; readonly content: string }
  | { readonly type: 'panel.open'; readonly panel: PanelKind }
  | {
      readonly type: 'panel.loaded';
      readonly requestId: string;
      readonly panel: PanelKind;
      readonly items: readonly PanelItem[];
    }
  | { readonly type: 'panel.failed'; readonly requestId: string; readonly message: string }
  | { readonly type: 'panel.transition'; readonly transition: SearchPickerControlTransition }
  | { readonly type: 'panel.accept'; readonly id: string }
  | { readonly type: 'panel.text'; readonly transition: TextAreaTransition }
  | { readonly type: 'panel.branch'; readonly entryId: string }
  | { readonly type: 'panel.done' | 'panel.operation-failed'; readonly message: string }
  | { readonly type: 'progress'; readonly runId: string; readonly event: AgentProgressEvent }
  | { readonly type: 'result'; readonly result: AgentEndedRunResult }
  | { readonly type: 'failure'; readonly message: string }
  | { readonly type: 'delivery.failed'; readonly message: string }
  | { readonly type: 'context.transitioned'; readonly window: ContextWindowRecord }
  | { readonly type: 'verification.updated'; readonly verification: CodingRunVerification }
  | { readonly type: 'application.state.changed'; readonly state: CodingApplicationState }
  | {
      readonly type: 'interactive.notice';
      readonly message: string;
      readonly tone?: 'info' | 'warning' | 'error';
    }
  | { readonly type: 'session.hydrated'; readonly hydration: CodingSessionView }
  | { readonly type: 'approval.required'; readonly suspension: AgentApprovalSuspension }
  | { readonly type: 'run.suspended'; readonly suspension: AgentRunSuspension }
  | { readonly type: 'recovery.act'; readonly action: import('./recovery.js').RecoveryAction }
  | { readonly type: 'recovery.finished'; readonly runId: string; readonly message: string }
  | { readonly type: 'approval.decide'; readonly decision: 'allow' | 'deny' }
  | { readonly type: 'composer.edit'; readonly transition: TextAreaTransition }
  | { readonly type: 'composer.history'; readonly direction: 'previous' | 'next' }
  | { readonly type: 'composer.submit'; readonly delivery?: 'steer' | 'follow_up' }
  | { readonly type: 'composer.external-editor' }
  | { readonly type: 'composer.cancel-command' }
  | { readonly type: 'composer.complete' }
  | {
      readonly type: 'composer.external-edited';
      readonly sessionId: string;
      readonly draft: import('@agent-core/tui').ComposerDraft;
      readonly text: string;
    }
  | { readonly type: 'work.interrupt' }
  | { readonly type: 'history.load'; readonly direction: 'older' | 'newer' | 'tail' }
  | {
      readonly type: 'history.loaded';
      readonly requestId: string;
      readonly pages: readonly CodingHistoryPage[];
    }
  | { readonly type: 'history.failed'; readonly requestId: string; readonly message: string }
  | { readonly type: 'composer.restore'; readonly text: string }
  | {
      readonly type: 'command.completed';
      readonly execution: CodingAgentTuiCommandExecution;
      readonly request: CodingAgentTuiCommandRequest;
    }
  | {
      readonly type: 'command.failed';
      readonly request: CodingAgentTuiCommandRequest;
      readonly message: string;
    }
  | { readonly type: 'conversation.scroll'; readonly transition: ScrollTransition }
  | { readonly type: 'conversation.scrolled'; readonly request: ScrollRequest }
  | { readonly type: 'activity.toggle'; readonly id: string }
  | { readonly type: 'overlay.open'; readonly overlay: 'commands' | 'search' | 'help' | 'debug' }
  | { readonly type: 'overlay.close' }
  | { readonly type: 'modal.scrolled'; readonly offsetRow: number }
  | { readonly type: 'commands.transition'; readonly transition: SearchPickerControlTransition }
  | { readonly type: 'commands.accept'; readonly event: SearchPickerAcceptEvent }
  | { readonly type: 'command-values.transition'; readonly transition: SearchPickerControlTransition }
  | { readonly type: 'command-values.accept'; readonly event: SearchPickerAcceptEvent }
  | { readonly type: 'search.more' }
  | {
      readonly type: 'search.loaded';
      readonly requestId: string;
      readonly result: SessionBranchSearchResult;
    }
  | { readonly type: 'search.failed'; readonly requestId: string; readonly message: string }
  | { readonly type: 'search.jumped'; readonly page: CodingHistoryPage; readonly entryId: string }
  | { readonly type: 'search.transition'; readonly transition: SearchPickerControlTransition }
  | { readonly type: 'search.accept'; readonly event: SearchPickerAcceptEvent }
  | { readonly type: 'terminal.resized' }
  | { readonly type: 'app.exit'; readonly reason?: string };

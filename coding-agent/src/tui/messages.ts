import type {
  AgentApprovalSuspension,
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
import type { CodingHandoff } from '../changes/coding-handoff.js';
import type { CodingEndedRunResult } from '../outcome.js';
import type { CodingAgentTuiCommandExecution, CodingAgentTuiCommandRequest } from './command-surface.js';
import type { PanelItem, PanelKind } from './panels.js';
import type { FileCompletionRequest } from './state.js';

export type CodingAgentTuiMessage =
  | import('@agents/tui').NotesMessage
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
  | { readonly type: 'panel.queue-save' | 'panel.queue-cancel' }
  | { readonly type: 'panel.branch'; readonly entryId: string }
  | { readonly type: 'panel.done' | 'panel.operation-failed'; readonly message: string }
  | { readonly type: 'progress'; readonly event: AgentProgressEvent }
  | { readonly type: 'result'; readonly result: CodingEndedRunResult }
  | { readonly type: 'failure'; readonly message: string }
  | { readonly type: 'delivery.failed'; readonly message: string }
  | { readonly type: 'context.transitioned'; readonly window: ContextWindowRecord }
  | { readonly type: 'handoff.ready'; readonly handoff: CodingHandoff }
  | { readonly type: 'application.state.changed'; readonly state: CodingApplicationState }
  | {
      readonly type: 'interactive.notice';
      readonly message: string;
      readonly tone?: 'info' | 'warning' | 'error';
    }
  | { readonly type: 'session.hydrated'; readonly hydration: CodingSessionView }
  | { readonly type: 'approval.required'; readonly suspension: AgentApprovalSuspension }
  | { readonly type: 'run.suspended'; readonly suspension: AgentRunSuspension }
  | { readonly type: 'approval.decide'; readonly decision: 'allow' | 'deny' }
  | { readonly type: 'composer.edit'; readonly transition: TextAreaTransition }
  | { readonly type: 'composer.history'; readonly direction: 'previous' | 'next' }
  | { readonly type: 'composer.submit'; readonly delivery?: 'steer' | 'follow_up' }
  | { readonly type: 'composer.external-editor' }
  | { readonly type: 'composer.cancel-command' }
  | { readonly type: 'composer.complete' }
  | {
      readonly type: 'files.loaded';
      readonly request: FileCompletionRequest;
      readonly paths: readonly string[];
    }
  | { readonly type: 'files.failed'; readonly requestId: string; readonly message: string }
  | { readonly type: 'files.transition'; readonly transition: SearchPickerControlTransition }
  | { readonly type: 'files.accept'; readonly event: SearchPickerAcceptEvent }
  | { readonly type: 'composer.external-edited'; readonly original: string; readonly text: string }
  | { readonly type: 'work.interrupt' }
  | { readonly type: 'conversation.copy'; readonly format: 'original' | 'displayed' | 'code' }
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
  | { readonly type: 'command.failed'; readonly message: string }
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
  | { readonly type: 'search.loaded'; readonly requestId: string; readonly result: SessionBranchSearchResult }
  | { readonly type: 'search.failed'; readonly requestId: string; readonly message: string }
  | { readonly type: 'search.jumped'; readonly page: CodingHistoryPage; readonly entryId: string }
  | { readonly type: 'search.transition'; readonly transition: SearchPickerControlTransition }
  | { readonly type: 'search.accept'; readonly event: SearchPickerAcceptEvent }
  | { readonly type: 'terminal.resized' }
  | { readonly type: 'app.exit'; readonly reason?: string };

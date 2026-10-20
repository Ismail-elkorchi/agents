import type {
  AgentApprovalSuspension,
  AgentEndedRunResult,
  AgentProgressEvent,
  AgentSessionSuspensionDescriptor,
  ContextWindowRecord,
  SessionBranchSearchResult,
  SessionPendingSubmission
} from '@agent-core/runtime';
import type {
  AutocompleteComboboxTransition,
  ComboboxCommitEvent,
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
import type {
  CodingAgentTuiCommandExecution,
  CodingAgentTuiCommandRequest
} from './command-surface.js';

export type CodingAgentTuiMessage =
  | Extract<import('../application/contracts.js').CodingApplicationEvent, { readonly type: 'history.recovery' }>
  | { readonly type: 'activity.tick' }
  | { readonly type: 'operational.open'; readonly sessionId: string; readonly target: 'changes' | 'context' | 'recovery' }
  | import('./panels.js').PanelMessage
  | import('@agent-core/tui').ContextMessage
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
  | { readonly type: 'material.open' }
  | { readonly type: 'material.child'; readonly child: import('@ismail-elkorchi/terminal-ui/tui').TuiChildMessage<import('@agent-core/tui').MaterialPanelMessage> }
  | { readonly type: 'collaboration.open' | 'collaboration.refresh' }
  | { readonly type: 'collaboration.child'; readonly child: import('@ismail-elkorchi/terminal-ui/tui').TuiChildMessage<import('@agent-core/tui').CollaborationPanelMessage> }
  | { readonly type: 'inspector.open' }
  | {
      readonly type: 'inspector.child';
      readonly child: import('@ismail-elkorchi/terminal-ui/tui').TuiChildMessage<
        import('@agent-core/tui').SourceInspectorMessage
      >;
    }
  | import('@agent-core/tui').DraftMessage
  | import('@agent-core/tui').AttachmentMessage
  | import('@agent-core/tui').PromptRecallMessage
  | Extract<import('@agent-core/tui').QueueMessage, { readonly type: 'queue.withdrawn' }>
  | {
      readonly type: 'queue.child';
      readonly child: import('@ismail-elkorchi/terminal-ui/tui').TuiChildMessage<
        import('@agent-core/tui').QueueMessage
      >;
    }
  | { readonly type: 'queue.open' }
  | { readonly type: 'terminal.focus'; readonly focused: boolean }
  | import('@agent-core/tui').PreferencesMessage
  | { readonly type: 'preferences.open' }
  | {
      readonly type: 'configuration.child';
      readonly child: import('@ismail-elkorchi/terminal-ui/tui').TuiChildMessage<
        import('@agent-core/tui').ConfigurationMessage
      >;
    }
  | { readonly type: 'completion.move'; readonly delta: number }
  | { readonly type: 'completion.accept'; readonly open: boolean; readonly name?: string }
  | { readonly type: 'completion.close' }
  | {
      readonly type: 'configuration.open';
      readonly target?: import('@agent-core/tui').ConfigurationTarget;
    }
  | { readonly type: 'recovery.open' | 'session.new' | 'setup.open' }
  | { readonly type: 'tools.toggle' | 'reasoning.toggle' | 'application.exit' }
  | { readonly type: 'source.copy' }
  | {
      readonly type: 'submissions.changed';
      readonly cancelledRunId?: string;
      readonly pending: readonly SessionPendingSubmission[];
    }
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
  | { readonly type: 'run.suspended'; readonly suspension: AgentSessionSuspensionDescriptor }
  | { readonly type: 'recovery.act'; readonly identity: string; readonly action: import('./recovery.js').RecoveryAction }
  | { readonly type: 'recovery.finished'; readonly runId: string; readonly identity: string; readonly message: string }
  | { readonly type: 'approval.decide'; readonly runId: string; readonly approvalId: string; readonly decision: 'allow' | 'deny' }
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
  | { readonly type: 'modal.page'; readonly direction: 'previous' | 'next' | 'start' | 'end' }
  | { readonly type: 'modal.scrolled'; readonly offsetRow: number }
  | { readonly type: 'help.results'; readonly transition: TextAreaTransition }
  | { readonly type: 'help.query'; readonly transition: TextAreaTransition }
  | { readonly type: 'commands.transition'; readonly transition: SearchPickerControlTransition }
  | { readonly type: 'commands.accept'; readonly event: SearchPickerAcceptEvent }
  | {
      readonly type: 'command-values.transition';
      readonly transition: SearchPickerControlTransition;
    }
  | { readonly type: 'command-values.accept'; readonly event: SearchPickerAcceptEvent }
  | { readonly type: 'search.more' }
  | {
      readonly type: 'search.loaded';
      readonly requestId: string;
      readonly result: SessionBranchSearchResult;
    }
  | { readonly type: 'search.failed'; readonly requestId: string; readonly message: string }
  | { readonly type: 'search.jumped'; readonly page: CodingHistoryPage; readonly entryId: string }
  | { readonly type: 'search.transition'; readonly transition: AutocompleteComboboxTransition }
  | { readonly type: 'search.accept'; readonly event: ComboboxCommitEvent }
  | { readonly type: 'terminal.resized' }
  | { readonly type: 'app.exit'; readonly reason?: string };

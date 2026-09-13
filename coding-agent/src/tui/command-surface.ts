import type { SessionSubmissionInput } from '@agent-core/runtime';
import {
  commandName,
  createDraft,
  draftSubmission,
  insertAcceptedInput,
  mergeConversationEntries,
  navigatePromptHistory,
  rememberPrompt,
  sameDraft,
  type ComposerDraft,
  type ConversationEntry,
  type ConversationUserEntry
} from '@agent-core/tui';
import type { SearchPickerIndex, TextAreaTransition } from '@ismail-elkorchi/terminal-ui/behavior';
import {
  createScrollState,
  createSearchPickerIndex,
  createTextAreaState,
  textAreaReducer
} from '@ismail-elkorchi/terminal-ui/behavior';
import type { SearchEntry } from '@ismail-elkorchi/terminal-ui/components';
import { textCaretAt, textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { appendNotice } from './conversation.js';
import type { InteractiveCommandResult } from './interactive-commands.js';
import { INTERACTIVE_COMMANDS } from './interactive-commands.js';
import type { CodingAgentTuiComposerState, CodingAgentTuiState } from './state.js';

export type CodingAgentTuiCommandExecution = InteractiveCommandResult & {
  readonly exit?: boolean;
  readonly tone?: 'success' | 'error' | 'muted';
};

export interface CodingAgentTuiCommandHandler {
  submit(
    input: SessionSubmissionInput,
    delivery?: 'steer' | 'follow_up'
  ): CodingAgentTuiCommandExecution | Promise<CodingAgentTuiCommandExecution>;
  execute(line: string): CodingAgentTuiCommandExecution | Promise<CodingAgentTuiCommandExecution>;
}

export type CodingAgentTuiCommandRequest = {
  readonly id: string;
  readonly sessionId: string;
  readonly recordResult: boolean;
  readonly draft?: ComposerDraft;
} & (
  | { readonly kind: 'command'; readonly value: string }
  | {
      readonly kind: 'submission';
      readonly input: SessionSubmissionInput;
      readonly delivery?: 'steer' | 'follow_up';
    }
);

export interface CodingAgentTuiCommandSubmitResult {
  readonly state: CodingAgentTuiState;
  readonly request?: CodingAgentTuiCommandRequest;
}

export const COMMAND_ENTRIES: readonly SearchEntry[] = INTERACTIVE_COMMANDS.map((command) => ({
  id: command.name,
  label: command.name,
  value: command.name,
  description: command.description,
  keywords: [command.name.slice(1), command.description]
}));

export const COMMAND_INDEX: SearchPickerIndex = createSearchPickerIndex(COMMAND_ENTRIES);

export function editComposer(
  state: CodingAgentTuiState,
  transition: TextAreaTransition
): CodingAgentTuiState {
  const input = textAreaReducer(state.composer.input, transition).state;
  const preserveHistoryPosition = transition.kind === 'pointer' || transition.kind === 'scroll';
  return {
    ...state,
    composer: {
      ...state.composer,
      input,
      history: preserveHistoryPosition
        ? state.composer.history
        : { entries: state.composer.history.entries, index: null }
    }
  };
}

export function setComposerText(state: CodingAgentTuiState, value: string): CodingAgentTuiState {
  return {
    ...state,
    composer: {
      ...state.composer,
      input: composerInput(value),
      history: { entries: state.composer.history.entries, index: null }
    }
  };
}

export function navigateComposerHistory(
  state: CodingAgentTuiState,
  direction: 'previous' | 'next'
): CodingAgentTuiState {
  const result = navigatePromptHistory(state.composer.history, state.composer, direction);
  return {
    ...state,
    composer: { ...composerWithDraft(state.composer, result.draft), history: result.history }
  };
}

export function submitComposer(
  state: CodingAgentTuiState,
  delivery?: 'steer' | 'follow_up'
): CodingAgentTuiCommandSubmitResult {
  const value = textDocumentText(state.composer.input.document);
  if (value.trim().length === 0 || state.composer.submitting) return { state };
  const slashCommand = commandName(value, INTERACTIVE_COMMANDS) !== undefined;
  const next: CodingAgentTuiState = {
    ...state,
    composer: {
      ...state.composer,
      submitting: true,
      submissionCount: state.composer.submissionCount + 1
    }
  };
  return {
    state: next,
    request: {
      id: `command:${String(next.composer.submissionCount)}`,
      sessionId: state.debug.sessionId ?? ':new',
      draft: state.composer,
      recordResult: slashCommand || delivery !== undefined,
      ...(slashCommand && delivery === undefined
        ? { kind: 'command', value }
        : {
            kind: 'submission',
            input: draftSubmission(state.composer),
            ...(delivery === undefined ? {} : { delivery })
          })
    }
  };
}

function composerInput(value: string) {
  return createTextAreaState({
    value,
    caret: textCaretAt(value.length),
    scroll: createScrollState({ followTail: true })
  });
}

export function applyCommandExecution(
  state: CodingAgentTuiState,
  execution: CodingAgentTuiCommandExecution,
  request: CodingAgentTuiCommandRequest
): { readonly state: CodingAgentTuiState; readonly exit?: boolean } {
  if (request.sessionId !== (state.debug.sessionId ?? ':new')) {
    const saved = state.sessionViews[request.sessionId];
    return saved === undefined || request.draft === undefined || !sameDraft(saved.composer, request.draft)
      ? { state }
      : {
          state: {
            ...state,
            sessionViews: {
              ...state.sessionViews,
              [request.sessionId]: {
                ...saved,
                composer: composerWithDraft({ ...saved.composer, submitting: false }, createDraft())
              }
            }
          }
        };
  }
  let next: CodingAgentTuiState = { ...state, composer: { ...state.composer, submitting: false } };
  if (request.draft !== undefined) {
    if (sameDraft(next.composer, request.draft)) {
      const { commandReturnDraft, ...composer } = next.composer;
      next = { ...next, composer: composerWithDraft(composer, commandReturnDraft ?? createDraft()) };
    }
    next = {
      ...next,
      composer: {
        ...next.composer,
        history:
          request.kind === 'submission'
            ? rememberPrompt(next.composer.history, request.draft)
            : next.composer.history
      }
    };
  }
  if (execution.submission !== undefined && execution.submission.acceptance.kind !== 'queued') {
    const { acceptance, text } = execution.submission;
    const insert =
      acceptance.kind === 'steered'
        ? (entries: readonly ConversationEntry[], input: ConversationUserEntry) =>
            mergeConversationEntries(entries, [input])
        : insertAcceptedInput;
    next = {
      ...next,
      conversation: {
        ...next.conversation,
        items: insert(next.conversation.items, {
          id:
            acceptance.kind === 'steered'
              ? `steering:${acceptance.submissionId}`
              : `input:${acceptance.runId}`,
          kind: 'user',
          runId: acceptance.runId,
          ...(request.kind === 'submission' && request.input.images !== undefined
            ? { images: request.input.images }
            : {}),
          text
        })
      }
    };
  }
  if (execution.action === undefined && request.recordResult && execution.message.length > 0) {
    const tone = execution.tone === 'error' ? 'error' : execution.tone === 'muted' ? 'info' : 'success';
    next = appendNotice(next, execution.message, tone);
  }
  return { state: next, ...(execution.exit === undefined ? {} : { exit: execution.exit }) };
}

export function applyCommandFailure(
  state: CodingAgentTuiState,
  message: string,
  request: CodingAgentTuiCommandRequest
): CodingAgentTuiState {
  if (request.sessionId !== (state.debug.sessionId ?? ':new')) {
    const saved = state.sessionViews[request.sessionId];
    const next =
      saved === undefined
        ? state
        : {
            ...state,
            sessionViews: {
              ...state.sessionViews,
              [request.sessionId]: { ...saved, composer: { ...saved.composer, submitting: false } }
            }
          };
    return appendNotice(next, `Session ${request.sessionId}: ${message}`, 'error');
  }
  return appendNotice({ ...state, composer: { ...state.composer, submitting: false } }, message, 'error');
}

export function composerWithDraft(
  current: CodingAgentTuiComposerState,
  draft: ComposerDraft
): CodingAgentTuiComposerState {
  return {
    ...draft,
    history: current.history,
    submitting: current.submitting,
    submissionCount: current.submissionCount
  };
}

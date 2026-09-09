import type { SearchPickerIndex, TextAreaTransition } from '@ismail-elkorchi/terminal-ui/behavior';
import {
  createScrollState,
  createSearchPickerIndex,
  createTextAreaState,
  textAreaReducer
} from '@ismail-elkorchi/terminal-ui/behavior';
import type { SearchEntry } from '@ismail-elkorchi/terminal-ui/components';
import { textCaretAt, textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { appendNotice, upsertConversationEntry } from './conversation.js';
import type { InteractiveCommandResult } from './interactive-commands.js';
import { INTERACTIVE_COMMANDS } from './interactive-commands.js';
import type { CodingAgentTuiState } from './state.js';

const COMPOSER_HISTORY_LIMIT = 100;

export type CodingAgentTuiCommandExecution = InteractiveCommandResult & {
  readonly exit?: boolean;
  readonly tone?: 'success' | 'error' | 'muted';
};

export interface CodingAgentTuiCommandHandler {
  execute(line: string): CodingAgentTuiCommandExecution | Promise<CodingAgentTuiCommandExecution>;
}

export interface CodingAgentTuiCommandRequest {
  readonly id: string;
  readonly value: string;
  readonly recordResult: boolean;
  readonly draft?: string;
}

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
      historyIndex: preserveHistoryPosition ? state.composer.historyIndex : null,
      historyDraft: preserveHistoryPosition ? state.composer.historyDraft : ''
    }
  };
}

export function setComposerText(state: CodingAgentTuiState, value: string): CodingAgentTuiState {
  return {
    ...state,
    composer: {
      ...state.composer,
      input: composerInput(value),
      historyIndex: null,
      historyDraft: ''
    }
  };
}

export function navigateComposerHistory(
  state: CodingAgentTuiState,
  direction: 'previous' | 'next'
): CodingAgentTuiState {
  const history = state.composer.history;
  if (history.length === 0) return state;
  const currentIndex = state.composer.historyIndex;
  if (direction === 'previous') {
    const historyIndex = currentIndex === null ? history.length - 1 : Math.max(0, currentIndex - 1);
    const value = history[historyIndex];
    if (value === undefined) return state;
    return {
      ...state,
      composer: {
        ...state.composer,
        input: composerInput(value),
        historyIndex,
        historyDraft:
          currentIndex === null
            ? textDocumentText(state.composer.input.document)
            : state.composer.historyDraft
      }
    };
  }
  if (currentIndex === null) return state;
  if (currentIndex < history.length - 1) {
    const historyIndex = currentIndex + 1;
    const value = history[historyIndex];
    if (value === undefined) return state;
    return {
      ...state,
      composer: { ...state.composer, input: composerInput(value), historyIndex }
    };
  }
  return {
    ...state,
    composer: {
      ...state.composer,
      input: composerInput(state.composer.historyDraft),
      historyIndex: null,
      historyDraft: ''
    }
  };
}

export function submitComposer(
  state: CodingAgentTuiState,
  delivery?: 'steer' | 'follow_up'
): CodingAgentTuiCommandSubmitResult {
  const value = textDocumentText(state.composer.input.document);
  if (value.trim().length === 0 || state.composer.submitting) return { state };
  const slashCommand = value.startsWith('/');
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
      value: delivery === undefined ? value : `${delivery === 'steer' ? '/steer' : '/follow'} ${value}`,
      draft: textDocumentText(state.composer.input.document),
      recordResult: slashCommand || delivery !== undefined
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
  let next: CodingAgentTuiState = { ...state, composer: { ...state.composer, submitting: false } };
  if (request.draft !== undefined) {
    if (textDocumentText(next.composer.input.document) === request.draft) {
      const { commandReturnDraft, ...composer } = next.composer;
      next = setComposerText({ ...next, composer }, commandReturnDraft ?? '');
    }
    next = {
      ...next,
      composer: {
        ...next.composer,
        history: [...next.composer.history, request.value].slice(-COMPOSER_HISTORY_LIMIT)
      }
    };
  }
  if (execution.submission !== undefined) {
    const { acceptance, text } = execution.submission;
    next = upsertConversationEntry(next, {
      id: acceptance.kind === 'steered' ? `steering:${acceptance.submissionId}` : `input:${acceptance.runId}`,
      kind: 'user',
      text
    });
  }
  if (execution.view !== 'debug' && request.recordResult) {
    const tone = execution.tone === 'error' ? 'error' : execution.tone === 'muted' ? 'info' : 'success';
    next = appendNotice(next, execution.message, tone);
  }
  return { state: next, ...(execution.exit === undefined ? {} : { exit: execution.exit }) };
}

export function applyCommandFailure(state: CodingAgentTuiState, message: string): CodingAgentTuiState {
  return appendNotice({ ...state, composer: { ...state.composer, submitting: false } }, message, 'error');
}

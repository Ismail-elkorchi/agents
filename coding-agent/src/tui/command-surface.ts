import {
  createScrollState,
  createTextAreaState,
  createSearchPickerIndex,
  textAreaReducer
} from '@ismail-elkorchi/terminal-ui/behavior';
import type { SearchPickerIndex, TextAreaTransition } from '@ismail-elkorchi/terminal-ui/behavior';
import type { SearchEntry } from '@ismail-elkorchi/terminal-ui/components';
import { textCaretAt, textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { INTERACTIVE_COMMANDS } from './interactive-commands.js';
import type { InteractiveCommandResult } from './interactive-commands.js';
import { normalizeTaskInput } from './task-input.js';
import type { CodingAgentTuiState } from './state.js';
import { appendNotice, appendUser } from './conversation.js';

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

export function editComposer(state: CodingAgentTuiState, transition: TextAreaTransition): CodingAgentTuiState {
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
    const historyIndex = currentIndex === null
      ? history.length - 1
      : Math.max(0, currentIndex - 1);
    const value = history[historyIndex];
    if (value === undefined) return state;
    return {
      ...state,
      composer: {
        ...state.composer,
        input: composerInput(value),
        historyIndex,
        historyDraft: currentIndex === null
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

export function submitComposer(state: CodingAgentTuiState): CodingAgentTuiCommandSubmitResult {
  const value = normalizeTaskInput(textDocumentText(state.composer.input.document));
  if (value.length === 0) return { state };
  const slashCommand = value.startsWith('/');
  const cleared: CodingAgentTuiState = {
    ...state,
    composer: {
      input: composerInput(''),
      history: [...state.composer.history, value].slice(-COMPOSER_HISTORY_LIMIT),
      historyIndex: null,
      historyDraft: '',
      submissionCount: state.composer.submissionCount + 1
    }
  };
  const next = slashCommand ? cleared : appendUser(cleared, value);
  return {
    state: next,
    request: {
      id: `command:${String(next.composer.submissionCount)}`,
      value,
      recordResult: slashCommand
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
  recordResult: boolean
): { readonly state: CodingAgentTuiState; readonly exit?: boolean } {
  let next = state;
  if (execution.view !== 'debug' && recordResult) {
    const tone = execution.tone === 'error' ? 'error' : execution.tone === 'muted' ? 'info' : 'success';
    next = appendNotice(next, execution.message, tone);
  }
  return { state: next, ...(execution.exit === undefined ? {} : { exit: execution.exit }) };
}

export function applyCommandFailure(state: CodingAgentTuiState, message: string): CodingAgentTuiState {
  return appendNotice(state, message, 'error');
}

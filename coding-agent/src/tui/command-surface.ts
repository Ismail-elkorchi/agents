import {
  createScrollState,
  createTextAreaState,
  createSearchPickerIndex,
  textAreaReducer
} from '@ismail-elkorchi/terminal-ui/behavior';
import type { SearchPickerIndex, TextAreaTransition } from '@ismail-elkorchi/terminal-ui/behavior';
import type { SearchEntry } from '@ismail-elkorchi/terminal-ui/components';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
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
  return {
    ...state,
    composer: { ...state.composer, input: textAreaReducer(state.composer.input, transition).state }
  };
}

export function setComposerText(state: CodingAgentTuiState, value: string): CodingAgentTuiState {
  return {
    ...state,
    composer: {
      ...state.composer,
      input: createTextAreaState({ value, scroll: createScrollState({ followTail: true }) })
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
      input: createTextAreaState({ value: '', scroll: createScrollState({ followTail: true }) }),
      history: [...state.composer.history, value].slice(-COMPOSER_HISTORY_LIMIT),
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

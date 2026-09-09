import type { SessionBranchSearchRequest, SessionBranchSearchResult } from '@agent-core/runtime';
import { findBranchMatches } from '@agents/application';
import { diagnosticMessage } from '@agents/tui';
import type { SearchPickerControlTransition } from '@ismail-elkorchi/terminal-ui/behavior';
import {
  createSearchPickerIndex,
  createSearchPickerState,
  searchPickerReducer,
  searchPickerView
} from '@ismail-elkorchi/terminal-ui/behavior';
import type { TuiUpdateResult } from '@ismail-elkorchi/terminal-ui/tui';
import { applyBranchEntry } from './branch-presentation.js';
import { appendNotice } from './conversation.js';
import type { CodingHistoryReader } from './history.js';
import { presentHistoryPages } from './history.js';
import type { CodingAgentTuiMessage } from './messages.js';
import type { CodingAgentTuiPickerState, CodingAgentTuiState } from './state.js';

export interface HistorySearch {
  readonly kind: 'search';
  readonly picker: CodingAgentTuiPickerState;
  readonly result?: SessionBranchSearchResult;
  readonly loading?: string;
  readonly error?: string;
}
export type HistorySearcher = (request: SessionBranchSearchRequest) => Promise<SessionBranchSearchResult>;
type Update = TuiUpdateResult<CodingAgentTuiState, CodingAgentTuiMessage>;

export function historySearchIndex(search: HistorySearch) {
  return createSearchPickerIndex(search.result?.matches ?? [], (match) => ({
    id: match.entryId,
    label: match.excerpt,
    value: match.entryId
  }));
}

export function openHistorySearch(state: CodingAgentTuiState): Update {
  const index = createSearchPickerIndex([], () => ({ id: '', label: '', value: '' }));
  return {
    state: {
      ...state,
      overlay: {
        kind: 'search',
        picker: createSearchPickerState({ query: { text: '', mode: 'contains', caseSensitive: true } }, index)
      }
    },
    focus: { kind: 'element', elementId: 'conversation-search' }
  };
}

export function transitionHistorySearch(
  state: CodingAgentTuiState,
  transition: SearchPickerControlTransition,
  search: HistorySearcher | undefined
): Update {
  if (state.overlay.kind !== 'search') return { state };
  const previous = searchPickerView(state.overlay.picker).input.text;
  const picker = searchPickerReducer(state.overlay.picker, transition, {
    searchPickerIndex: historySearchIndex(state.overlay)
  });
  const next = { ...state, overlay: { ...state.overlay, picker } };
  return previous === searchPickerView(picker).input.text ? { state: next } : searchHistory(next, search);
}

export function searchHistory(
  state: CodingAgentTuiState,
  search: HistorySearcher | undefined,
  more = false
): Update {
  if (state.overlay.kind !== 'search') return { state };
  const query = searchPickerView(state.overlay.picker).input.text;
  const cursor = more ? state.overlay.result?.older : undefined;
  if (more && cursor === undefined) return { state };
  const id = `search:${String(state.nextLocalId)}`;
  const overlay: HistorySearch = { kind: 'search', picker: state.overlay.picker };
  if (!query.length) return { state: { ...state, overlay } };
  return {
    state: { ...state, nextLocalId: state.nextLocalId + 1, overlay: { ...overlay, loading: id } },
    effects: [
      {
        id: 'history-search',
        concurrency: 'replace',
        async run({ signal }) {
          if (search === undefined) throw new Error('History search is unavailable.');
          const result = await findBranchMatches(
            search,
            cursor === undefined ? { query } : { query, cursor },
            signal
          );
          return { kind: 'message', message: { type: 'search.loaded', requestId: id, result } };
        },
        onError: ({ diagnostic }) => ({
          kind: 'message',
          message: { type: 'search.failed', requestId: id, message: diagnosticMessage(diagnostic) }
        })
      }
    ]
  };
}

export function receiveSearch(
  state: CodingAgentTuiState,
  message: Extract<CodingAgentTuiMessage, { type: 'search.loaded' | 'search.failed' }>
): CodingAgentTuiState {
  if (state.overlay.kind !== 'search' || state.overlay.loading !== message.requestId) return state;
  const overlay = { ...state.overlay };
  delete overlay.loading;
  return {
    ...state,
    overlay:
      message.type === 'search.loaded'
        ? { ...overlay, result: message.result }
        : { ...overlay, error: message.message }
  };
}

export function jumpToSearchResult(
  state: CodingAgentTuiState,
  entryId: string,
  read: CodingHistoryReader | undefined
): Update {
  if (state.overlay.kind !== 'search' || state.overlay.result === undefined) return { state };
  const { boundary, matches } = state.overlay.result;
  if (!matches.some((match) => match.entryId === entryId)) return { state };
  return {
    state,
    effects: [
      {
        id: 'history-jump',
        concurrency: 'replace',
        async run() {
          if (read === undefined) throw new Error('History retrieval is unavailable.');
          const page = await read({ cursor: { boundary, entryId }, direction: 'newer' });
          return { kind: 'message', message: { type: 'search.jumped', page, entryId } };
        },
        onError: ({ diagnostic }) => ({
          kind: 'message',
          message: { type: 'interactive.notice', tone: 'error', message: diagnosticMessage(diagnostic) }
        })
      }
    ]
  };
}

export function receiveSearchJump(
  state: CodingAgentTuiState,
  message: Extract<CodingAgentTuiMessage, { type: 'search.jumped' }>
): CodingAgentTuiState {
  if (message.page.history.boundary.sessionId !== state.debug.sessionId) return state;
  const entry = message.page.history.entries.find((entry) => entry.id === message.entryId);
  if (entry === undefined)
    return appendNotice(state, 'The selected entry is no longer in this history page.', 'error');
  const presented = presentHistoryPages(state, [message.page], false);
  const itemId = applyBranchEntry({ ...state, conversation: { ...state.conversation, items: [] } }, entry)
    .conversation.items[0]?.id;
  return {
    ...presented,
    overlay: { kind: 'none' },
    conversation: {
      ...presented.conversation,
      ...(itemId === undefined ? {} : { anchor: { itemId, rowWithinItem: 0, viewportRow: 0 } }),
      scroll: { ...presented.conversation.scroll, followTail: false }
    }
  };
}

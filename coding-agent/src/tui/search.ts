import type { SessionBranchSearchRequest, SessionBranchSearchResult } from '@agent-core/runtime';
import { findBranchMatches } from '@agent-core/runtime';
import {
  adjacentHistoryMatch,
  diagnosticMessage,
  oversizedHistoryEntry,
  selectHistoryMatch
} from '@agent-core/tui';
import {
  autocompleteComboboxReducer,
  createAutocompleteComboboxState,
  createListboxCollection,
  createListboxView,
  type AutocompleteComboboxTransition,
  type AutocompleteComboboxState,
  type CompleteListboxCollection,
  type ListboxView
} from '@ismail-elkorchi/terminal-ui/behavior';
import type { TuiUpdateResult } from '@ismail-elkorchi/terminal-ui/tui';
import { applyBranchEntry } from './branch-presentation.js';
import { appendNotice } from './conversation.js';
import type { CodingHistoryReader } from './history.js';
import { presentHistoryPages } from './history.js';
import type { CodingAgentTuiMessage } from './messages.js';
import type { CodingAgentTuiState } from './state.js';

interface SearchResultItem {
  readonly id: string;
  readonly label: string;
}

export interface HistorySearch {
  readonly kind: 'search';
  readonly collection: CompleteListboxCollection<SearchResultItem>;
  readonly optionsView: ListboxView<SearchResultItem>;
  readonly picker: AutocompleteComboboxState;
  readonly result?: SessionBranchSearchResult;
  readonly loading?: string;
  readonly error?: string;
}
export type HistorySearcher = (
  request: SessionBranchSearchRequest
) => Promise<SessionBranchSearchResult>;
type Update = TuiUpdateResult<CodingAgentTuiState, CodingAgentTuiMessage>;

const EMPTY_COLLECTION = createListboxCollection<SearchResultItem>([], (item) => item);
const EMPTY_VIEW = createListboxView(EMPTY_COLLECTION);
function historySearchCollection(result: SessionBranchSearchResult | undefined) {
  const reference = result?.oversizedEntry;
  return createListboxCollection(
    [
      ...(result?.matches.map((match) => ({
        id: match.entryId,
        label: match.excerpt
      })) ?? []),
      ...(reference === undefined
        ? []
        : [
            {
              id: reference.entryId,
              label: `Not searched · ${String(reference.bytes)} bytes · inspect entry`
            }
          ])
    ],
    (item) => item
  );
}

export function openHistorySearch(state: CodingAgentTuiState): Update {
  const previous =
    state.historyMatch?.result.boundary.sessionId === state.debug.sessionId
      ? state.historyMatch
      : undefined;
  const collection = historySearchCollection(previous?.result);
  const optionsView = createListboxView(collection);
  return {
    state: {
      ...state,
      overlay: {
        kind: 'search',
        collection,
        optionsView,
        ...(previous === undefined ? {} : { result: previous.result }),
        picker: createAutocompleteComboboxState(
          { value: previous?.query ?? '', open: true },
          optionsView.interactionIndex
        )
      }
    },
    cancel: [
      { kind: 'effect', id: 'history-search' },
      { kind: 'effect', id: 'history-jump' }
    ]
  };
}

export function transitionHistorySearch(
  state: CodingAgentTuiState,
  transition: AutocompleteComboboxTransition,
  search: HistorySearcher | undefined
): Update {
  if (state.overlay.kind !== 'search') return { state };
  const overlay = state.overlay;
  const previous = overlay.picker.editor.input.text;
  const picker = autocompleteComboboxReducer(overlay.picker, transition, {
    indexForText: () => overlay.optionsView.interactionIndex
  });
  const next = { ...state, overlay: { ...state.overlay, picker } };
  return previous === picker.editor.input.text ? { state: next } : searchHistory(next, search);
}

export function searchHistory(
  state: CodingAgentTuiState,
  search: HistorySearcher | undefined,
  more = false
): Update {
  if (state.overlay.kind !== 'search') return { state };
  const query = state.overlay.picker.editor.input.text;
  const cursor = more ? state.overlay.result?.older : undefined;
  if (more && cursor === undefined) return { state };
  const id = `search:${String(state.nextLocalId)}`;
  const overlay: HistorySearch = {
    kind: 'search',
    picker: autocompleteComboboxReducer(
      state.overlay.picker,
      { kind: 'setActive' },
      { indexForText: () => EMPTY_VIEW.interactionIndex }
    ),
    collection: EMPTY_COLLECTION,
    optionsView: EMPTY_VIEW
  };
  if (!query.length)
    return {
      state: { ...state, overlay },
      cancel: [
        { kind: 'effect', id: 'history-search' },
        { kind: 'effect', id: 'history-jump' }
      ]
    };
  return {
    state: { ...state, nextLocalId: state.nextLocalId + 1, overlay: { ...overlay, loading: id } },
    cancel: [{ kind: 'effect', id: 'history-jump' }],
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
  if (message.type === 'search.failed')
    return { ...state, overlay: { ...overlay, error: message.message } };
  const collection = historySearchCollection(message.result);
  const optionsView = createListboxView(collection);
  return {
    ...state,
    overlay: {
      ...overlay,
      result: message.result,
      collection,
      optionsView,
      picker: autocompleteComboboxReducer(
        overlay.picker,
        { kind: 'firstActive' },
        { indexForText: () => optionsView.interactionIndex }
      )
    }
  };
}

export function jumpToSearchResult(
  state: CodingAgentTuiState,
  entryId: string,
  read: CodingHistoryReader | undefined,
  openSource: (
    state: CodingAgentTuiState,
    reference: import('@agent-core/tui').ConversationReferenceEntry
  ) => TuiUpdateResult<CodingAgentTuiState, CodingAgentTuiMessage>,
  result = state.overlay.kind === 'search' ? state.overlay.result : undefined
): Update {
  if (result === undefined) return { state };
  const { boundary } = result;
  const query =
    state.overlay.kind === 'search'
      ? state.overlay.picker.editor.input.text
      : (state.historyMatch?.query ?? '');
  if (result.oversizedEntry?.entryId === entryId) {
    const reference = oversizedHistoryEntry({
      ...result,
      entries: [],
      oversizedEntry: result.oversizedEntry
    })[0];
    if (reference === undefined) return { state };
    return openSource({ ...state, historyMatch: { result, query, index: -1 } }, reference);
  }
  const historyMatch = selectHistoryMatch(result, entryId, query);
  if (historyMatch === undefined) return { state };
  return {
    state: { ...state, historyMatch },
    effects: [
      {
        id: 'history-jump',
        concurrency: 'replace',
        async run({ signal }) {
          if (read === undefined) throw new Error('History retrieval is unavailable.');
          const page = await read({ cursor: { boundary, entryId }, direction: 'newer' });
          signal.throwIfAborted();
          return { kind: 'message', message: { type: 'search.jumped', page, entryId } };
        },
        onError: ({ diagnostic }) => ({
          kind: 'message',
          message: {
            type: 'interactive.notice',
            tone: 'error',
            message: diagnosticMessage(diagnostic)
          }
        })
      }
    ]
  };
}

export function jumpToAdjacentMatch(
  state: CodingAgentTuiState,
  direction: 'previous' | 'next',
  read: CodingHistoryReader | undefined,
  openSource: (
    state: CodingAgentTuiState,
    reference: import('@agent-core/tui').ConversationReferenceEntry
  ) => TuiUpdateResult<CodingAgentTuiState, CodingAgentTuiMessage>
): Update {
  const position = state.historyMatch;
  if (position === undefined || position.result.boundary.sessionId !== state.debug.sessionId)
    return { state };
  const entryId = adjacentHistoryMatch(position, direction);
  return entryId === undefined
    ? {
        state: appendNotice(state, 'End of this match batch. Open search to search another batch.')
      }
    : jumpToSearchResult(state, entryId, read, openSource, position.result);
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
  const itemId = applyBranchEntry(
    { ...state, conversation: { ...state.conversation, items: [] } },
    entry
  ).conversation.items[0]?.id;
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

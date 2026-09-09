import type { SessionBranchPageRequest } from '@agent-core/runtime';
import { isDeepStrictEqual } from 'node:util';
import { diagnosticMessage } from '@agents/tui';
import type { TuiEffect, TuiUpdateResult } from '@ismail-elkorchi/terminal-ui/tui';
import type { CodingHistoryPage } from '../application/contracts.js';
import { applyBranchEntry } from './branch-presentation.js';
import { appendNotice } from './conversation.js';
import { applyCodingHandoff } from './event-reducer.js';
import type { CodingAgentTuiMessage } from './messages.js';
import type { CodingAgentTuiState } from './state.js';

export type CodingHistoryReader = (request?: SessionBranchPageRequest) => Promise<CodingHistoryPage>;
type Update = TuiUpdateResult<CodingAgentTuiState, CodingAgentTuiMessage>;

export function loadHistory(
  state: CodingAgentTuiState,
  direction: 'older' | 'newer' | 'tail',
  read: CodingHistoryReader | undefined
): Update {
  if (state.conversation.loading !== undefined) return { state };
  if (read === undefined) return { state: appendNotice(state, 'No history reader is attached.') };
  const pages = state.conversation.pages;
  const cursor = direction === 'older' ? pages[0]?.history.older : pages.at(-1)?.history.newer;
  if (direction === 'older' && cursor === undefined) return { state };
  if (direction === 'newer' && cursor === undefined) direction = 'tail';
  const id = `history:${String(state.nextLocalId)}`;
  const effect: TuiEffect<CodingAgentTuiMessage> = {
    id: 'history-page',
    concurrency: 'replace',
    async run() {
      const page = await read(
        cursor === undefined || direction === 'tail' ? undefined : { cursor, direction }
      );
      return { kind: 'message', message: { type: 'history.loaded', requestId: id, pages: [page] } };
    },
    onError: ({ diagnostic }) => ({
      kind: 'message',
      message: { type: 'history.failed', requestId: id, message: diagnosticMessage(diagnostic) }
    })
  };
  return {
    state: {
      ...state,
      nextLocalId: state.nextLocalId + 1,
      conversation: { ...state.conversation, loading: { id, direction } }
    },
    effects: [effect]
  };
}

export function presentHistoryPages(
  state: CodingAgentTuiState,
  pages: readonly CodingHistoryPage[],
  retainLive: boolean
): CodingAgentTuiState {
  let presented: CodingAgentTuiState = { ...state, conversation: { ...state.conversation, items: [] } };
  for (const page of pages) {
    for (const entry of page.history.entries) presented = applyBranchEntry(presented, entry);
    for (const handoff of page.handoffs) presented = applyCodingHandoff(presented, handoff);
  }
  const previous = new Map(state.conversation.items.map((entry) => [entry.id, entry]));
  const recorded = presented.conversation.items.map((entry) => {
    const retained = previous.get(entry.id);
    return retained !== undefined && isDeepStrictEqual(retained, entry) ? retained : entry;
  });
  const ids = new Set(presented.conversation.items.map((entry) => entry.id));
  const recordedInputs = new Set(
    state.conversation.pages.flatMap((page) =>
      page.history.entries.flatMap((entry) => (entry.type === 'input' ? [`input:${entry.runId}`] : []))
    )
  );
  const live = retainLive
    ? state.conversation.items.filter(
        (entry) =>
          !ids.has(entry.id) &&
          ((entry.kind === 'assistant' && entry.status === 'streaming') ||
            (entry.kind === 'activity' && entry.status === 'running') ||
            (entry.kind === 'user' && !recordedInputs.has(entry.id)))
      )
    : [];
  const notices = state.conversation.items
    .filter((entry) => entry.kind === 'notice' && entry.id.startsWith('notice:local:'))
    .slice(-8);
  return {
    ...state,
    debug: { ...state.debug, handoffs: pages.flatMap((page) => page.handoffs) },
    conversation: {
      ...state.conversation,
      pages,
      items: [...recorded, ...live, ...notices],
      expandedIds: presented.conversation.expandedIds.filter((id) => ids.has(id))
    },
    nextLocalId: presented.nextLocalId
  };
}

export function receiveHistory(
  state: CodingAgentTuiState,
  requestId: string,
  received: readonly CodingHistoryPage[]
): CodingAgentTuiState {
  const { loading, ...conversation } = state.conversation;
  if (loading?.id !== requestId || received[0]?.history.boundary.sessionId !== state.debug.sessionId)
    return state;
  const direction = loading.direction;
  const pages =
    direction === 'tail' || direction === 'restore'
      ? received
      : direction === 'older'
        ? [...received, ...conversation.pages].slice(0, 3)
        : [...conversation.pages, ...received].slice(-3);
  const anchor =
    direction === 'tail'
      ? undefined
      : (conversation.anchor ?? state.presentation.anchor(conversation.scroll.offsetRow));
  const presented = presentHistoryPages({ ...state, conversation }, pages, direction === 'tail');
  return {
    ...presented,
    conversation: {
      ...presented.conversation,
      ...(anchor === undefined ? {} : { anchor }),
      unread: direction === 'tail' ? false : conversation.unread,
      scroll: { ...conversation.scroll, followTail: direction === 'tail' }
    }
  };
}

export function failHistory(
  state: CodingAgentTuiState,
  requestId: string,
  message: string
): CodingAgentTuiState {
  const { loading, ...conversation } = state.conversation;
  if (loading?.id !== requestId) return state;
  return appendNotice({ ...state, conversation }, message, 'error');
}

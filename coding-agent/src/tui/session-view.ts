import { createDraft, diagnosticMessage, historyBookmark, sessionConversationId } from '@agent-core/tui';
import { createScrollState } from '@ismail-elkorchi/terminal-ui/behavior';
import type { TuiUpdateResult } from '@ismail-elkorchi/terminal-ui/tui';
import type { CodingSessionView } from '../application/contracts.js';
import type { CodingHistoryReader } from './history.js';
import { hydrateCodingAgentTuiState } from './hydration.js';
import type { CodingAgentTuiMessage } from './messages.js';
import type { CodingAgentTuiState } from './state.js';

export function restoreSessionView(
  state: CodingAgentTuiState,
  view: CodingSessionView,
  read: CodingHistoryReader | undefined
): TuiUpdateResult<CodingAgentTuiState, CodingAgentTuiMessage> {
  if (state.debug.sessionId === view.session.sessionId || state.debug.sessionId === undefined)
    return { state: hydrateCodingAgentTuiState(state, view) };
  const anchor =
    state.conversation.anchor ?? state.presentation.anchor(state.presentation.layout.scroll.offsetRow);
  const views = {
    ...state.sessionViews,
    [state.debug.sessionId]: {
      composer: state.composer,
      expandedIds: state.conversation.expandedIds,
      history: historyBookmark(
        state.conversation.pages.map((page) => page.history),
        anchor,
        state.conversation.scroll.followTail,
        anchor?.itemId.startsWith('activity-group:')
          ? (entry) => `activity-group:${sessionConversationId(entry)}`
          : sessionConversationId
      )
    }
  };
  const saved = views[view.session.sessionId];
  let next = hydrateCodingAgentTuiState(
    {
      ...state,
      sessionViews: views,
      // Inspectors and completion candidates belong to the session that opened
      // them. Keep its draft/bookmark, not controls that could target new work.
      overlay: { kind: 'none' },
      modalOffsetRow: 0,
      inspection: {},
      completion: undefined,
      resourceCompletion: undefined,
      panelGeneration: state.panelGeneration + 1,
      run: { kind: 'idle' },
      progress: { label: 'Ready' },
      composer: saved?.composer ?? {
        ...createDraft(),
        submissionCount: state.composer.submissionCount,
        submitting: false,
        history: { entries: [], index: null }
      },
      conversation: {
        items: [],
        pages: [],
        expandedIds: saved?.expandedIds ?? [],
        unread: false,
        scroll: createScrollState({ followTail: true })
      }
    },
    view
  );
  const bookmark = saved?.history;
  if (bookmark?.cursor === undefined || read === undefined)
    return { state: next, focus: { kind: 'element', elementId: 'composer' } };
  const cursor = bookmark.cursor;
  const requestId = crypto.randomUUID();
  next = {
    ...next,
    conversation: {
      ...next.conversation,
      // Initial hydration reads the tail; retain the bookmark's disclosure
      // state until its own historical pages arrive and can prune it correctly.
      expandedIds: saved?.expandedIds ?? [],
      ...(bookmark.anchor === undefined ? {} : { anchor: bookmark.anchor }),
      loading: { id: requestId, direction: 'restore' },
      scroll: createScrollState({ followTail: false })
    }
  };
  return {
    state: next,
    focus: { kind: 'element', elementId: 'composer' },
    effects: [
      {
        id: 'history-page',
        concurrency: 'replace',
        async run() {
          const pages = [await read({ cursor, direction: 'newer' })];
          while (pages.length < 3) {
            const next = pages.at(-1)?.history.newer;
            if (next === undefined) break;
            pages.push(await read({ cursor: next, direction: 'newer' }));
          }
          return { kind: 'message', message: { type: 'history.loaded', requestId, pages } };
        },
        onError: ({ diagnostic }) => ({
          kind: 'message',
          message: { type: 'history.failed', requestId, message: diagnosticMessage(diagnostic) }
        })
      }
    ]
  };
}

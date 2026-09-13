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
  const views = {
    ...state.sessionViews,
    [state.debug.sessionId]: {
      composer: state.composer,
      history: historyBookmark(
        state.conversation.pages.map((page) => page.history),
        state.conversation.anchor ?? state.presentation.anchor(state.conversation.scroll.offsetRow),
        state.conversation.scroll.followTail,
        sessionConversationId
      )
    }
  };
  const saved = views[view.session.sessionId];
  let next = hydrateCodingAgentTuiState(
    {
      ...state,
      sessionViews: views,
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
        expandedIds: [],
        unread: false,
        scroll: createScrollState({ followTail: true })
      }
    },
    view
  );
  const bookmark = saved?.history;
  if (bookmark?.cursor === undefined || read === undefined) return { state: next };
  const cursor = bookmark.cursor;
  const requestId = crypto.randomUUID();
  next = {
    ...next,
    conversation: {
      ...next.conversation,
      ...(bookmark.anchor === undefined ? {} : { anchor: bookmark.anchor }),
      loading: { id: requestId, direction: 'restore' },
      scroll: createScrollState({ followTail: false })
    }
  };
  return {
    state: next,
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

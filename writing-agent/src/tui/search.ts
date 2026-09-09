import { findBranchMatches } from '@agents/application';
import { diagnosticMessage } from '@agents/tui';
import { createTextAreaState, textAreaReducer } from '@ismail-elkorchi/terminal-ui/behavior';
import { button, text, textArea, type Element } from '@ismail-elkorchi/terminal-ui/components';
import { column } from '@ismail-elkorchi/terminal-ui/layout';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import type { TuiUpdateResult } from '@ismail-elkorchi/terminal-ui/tui';
import type { WritingApplication } from '../application/service.js';
import type { WritingTuiMessage, WritingTuiState } from './state.js';

type Message = Extract<WritingTuiMessage, { type: `search.${string}` }>;
export function updateHistorySearch(
  state: WritingTuiState,
  message: Message,
  application: WritingApplication
): TuiUpdateResult<WritingTuiState, WritingTuiMessage> {
  if (message.type === 'search.open')
    return { state: { ...state, overlay: { kind: 'search', input: createTextAreaState({ value: '' }) } } };
  if (message.type === 'search.jumped') {
    if (message.page.boundary.sessionId !== state.history[0]?.boundary.sessionId) return { state };
    const entry = message.page.entries.find((entry) => entry.id === message.entryId);
    const itemId = entry?.type === 'assistant' ? `assistant:${entry.turnId}` : message.entryId;
    return {
      state: {
        ...state,
        history: [message.page],
        followTail: false,
        conversationOffset: 0,
        conversationAnchor: { itemId, rowWithinItem: 0, viewportRow: 0 },
        view: 'conversation',
        overlay: { kind: 'none' }
      }
    };
  }
  if (state.overlay.kind !== 'search') return { state };
  const overlay = state.overlay;
  if (message.type === 'search.edit')
    return {
      state: {
        ...state,
        overlay: { kind: 'search', input: textAreaReducer(overlay.input, message.transition).state }
      }
    };
  if (message.type === 'search.loaded')
    return overlay.requestId !== message.requestId
      ? { state }
      : { state: { ...state, overlay: { kind: 'search', input: overlay.input, result: message.result } } };
  if (message.type === 'search.failed')
    return overlay.requestId !== message.requestId
      ? { state }
      : { state: { ...state, overlay: { kind: 'search', input: overlay.input, error: message.message } } };
  if (message.type === 'search.jump') {
    const result = overlay.result;
    if (!result?.matches.some((match) => match.entryId === message.entryId)) return { state };
    return {
      state,
      effects: [
        {
          id: 'writing-search-jump',
          concurrency: 'replace',
          async run() {
            const page = await application.readHistory({
              cursor: { boundary: result.boundary, entryId: message.entryId },
              direction: 'newer'
            });
            return { kind: 'message', message: { type: 'search.jumped', page, entryId: message.entryId } };
          },
          onError: ({ diagnostic }) => ({
            kind: 'message',
            message: { type: 'notice', message: diagnosticMessage(diagnostic) }
          })
        }
      ]
    };
  }
  const query = textDocumentText(overlay.input.document);
  if (!query) return { state };
  const cursor = message.more ? overlay.result?.older : undefined;
  if (message.more && cursor === undefined) return { state };
  const requestId = crypto.randomUUID();
  return {
    state: { ...state, overlay: { ...overlay, requestId } },
    effects: [
      {
        id: 'writing-history-search',
        concurrency: 'replace',
        async run({ signal }) {
          const result = await findBranchMatches(
            (request) => application.searchHistory(request),
            { query, limit: 16, ...(cursor === undefined ? {} : { cursor }) },
            signal
          );
          return { kind: 'message', message: { type: 'search.loaded', requestId, result } };
        },
        onError: ({ diagnostic }) => ({
          kind: 'message',
          message: { type: 'search.failed', requestId, message: diagnosticMessage(diagnostic) }
        })
      }
    ]
  };
}
export function historySearchView(state: WritingTuiState): Element<WritingTuiMessage> {
  const search = state.overlay;
  if (search.kind !== 'search') return text({ content: '' });
  return column([
    textArea<WritingTuiMessage>({
      id: 'writing-history-search',
      meta: { accessibleName: 'Search recorded conversation' },
      state: search.input,
      placeholder: 'Literal, case-sensitive history text',
      onTransition: (
        transition: import('@ismail-elkorchi/terminal-ui/behavior').TextAreaTransition
      ): WritingTuiMessage => ({ type: 'search.edit', transition })
    }),
    button({
      id: 'writing-search-submit',
      label: 'Search recorded history',
      onPress: () => ({ type: 'search.submit', more: false })
    }),
    text({
      content:
        search.error ??
        (search.requestId !== undefined
          ? 'Searching…'
          : search.result === undefined
            ? 'Search includes unloaded history.'
            : search.result.older === undefined
              ? 'End of branch reached.'
              : 'More history remains.')
    }),
    ...(search.result?.matches.map((match) =>
      button<WritingTuiMessage>({
        id: `writing-search-result:${match.entryId}`,
        label: match.excerpt,
        onPress: () => ({ type: 'search.jump', entryId: match.entryId })
      })
    ) ?? []),
    button({
      id: 'writing-search-more',
      label: 'Next match batch',
      onPress: () => ({ type: 'search.submit', more: true })
    })
  ]);
}

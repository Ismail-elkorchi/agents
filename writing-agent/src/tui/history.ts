import type { SessionBranchEntry } from '@agent-core/runtime';
import { measuredWindow } from '@ismail-elkorchi/terminal-ui/collection';
import { richText, type Element } from '@ismail-elkorchi/terminal-ui/components';
import { measuredViewport } from '@ismail-elkorchi/terminal-ui/layout';
import { wrapTextCells } from '@ismail-elkorchi/terminal-ui/text';
import type { TuiContext } from '@ismail-elkorchi/terminal-ui/tui';
import type { WritingTuiMessage, WritingTuiState } from './state.js';

export interface WritingHistoryMessage {
  readonly id: string;
  readonly source: string;
  readonly markdown: boolean;
}
export function historyMessages(state: WritingTuiState): readonly WritingHistoryMessage[] {
  const entries = new Map<string, WritingHistoryMessage>();
  for (const page of state.history)
    for (const entry of page.entries) {
      let message = state.historyEntryCache.get(entry);
      if (message === undefined) {
        message = presentEntry(entry, state);
        if (message !== undefined) state.historyEntryCache.set(entry, message);
      }
      if (message !== undefined) entries.set(message.id, message);
    }
  if (state.followTail && state.live !== undefined)
    entries.set(`assistant:${state.live.turnId}`, {
      id: `assistant:${state.live.turnId}`,
      source: state.live.content,
      markdown: true
    });
  return [...entries.values()];
}
function presentEntry(entry: SessionBranchEntry, state: WritingTuiState): WritingHistoryMessage | undefined {
  switch (entry.type) {
    case 'input': {
      const operation = state.project?.operations.find((operation) =>
        operation.attempts.some((attempt) => attempt.runId === entry.runId)
      );
      return { id: entry.id, source: `You\n${operation?.instruction ?? entry.task}\n`, markdown: false };
    }
    case 'assistant':
      return { id: `assistant:${entry.turnId}`, source: entry.content, markdown: true };
    case 'observation':
      return { id: entry.id, source: `${entry.ok ? '✓' : '!'} ${entry.summary}\n`, markdown: false };
    case 'context_transition':
      return { id: entry.id, source: `Context changed · ${entry.window.reason}\n`, markdown: false };
    case 'steering':
      return { id: entry.id, source: `You\n${entry.content}\n`, markdown: false };
    case 'branch':
      return { id: entry.id, source: `Branch · ${entry.label ?? entry.id}\n`, markdown: false };
    case 'model_settings':
    case 'tool_call':
      return undefined;
  }
}

export function historyViewport(
  state: WritingTuiState,
  width: number,
  rows: number,
  context: TuiContext
): Element<WritingTuiMessage> {
  // Reserve the visible vertical scrollbar so history measurements have one stable width.
  const columns = Math.max(1, width - 1);
  const segments = (entry: WritingHistoryMessage) =>
    entry.markdown
      ? state.presentation.markdown(entry.id, entry.source).render(columns).segments
      : [{ kind: 'text' as const, text: entry.source }];
  const collection = state.presentation.measure(
    historyMessages(state),
    [],
    `${String(columns)}:${JSON.stringify(context.capabilities.unicode.widthProfile)}`,
    (entry) => {
      const content = segments(entry)
        .map((segment) => segment.text)
        .join('');
      return Math.max(
        1,
        wrapTextCells(content, columns, {
          widthProfile: context.capabilities.unicode.widthProfile,
          preserveWords: true
        }).length
      );
    }
  );
  const window = measuredWindow(collection, {
    viewportRows: rows,
    ...(state.followTail
      ? { offsetRow: Math.max(0, collection.totalRows - rows) }
      : state.conversationAnchor === undefined
        ? { offsetRow: state.conversationOffset }
        : { anchor: state.conversationAnchor })
  });
  return measuredViewport(
    window,
    (entry) =>
      richText({
        id: `history:${entry.item.id}`,
        segments: segments(entry.item.value),
        wrap: { preserveWords: true }
      }),
    {
      id: 'writing-conversation',
      scrollbar: { axis: 'vertical', visible: 'always' },
      onScroll: (request): WritingTuiMessage => ({ type: 'conversation.scroll', request })
    }
  );
}

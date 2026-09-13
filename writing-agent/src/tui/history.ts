import {
  conversationText,
  oversizedHistoryEntry,
  projectSessionEntry,
  reconcileConversationEntries,
  sessionConversationId,
  type ConversationEntry
} from '@agent-core/tui';
import { measuredWindow } from '@ismail-elkorchi/terminal-ui/collection';
import { button, richText, type Element } from '@ismail-elkorchi/terminal-ui/components';
import { column, measuredViewport } from '@ismail-elkorchi/terminal-ui/layout';
import { wrapTextCells } from '@ismail-elkorchi/terminal-ui/text';
import type { TuiContext } from '@ismail-elkorchi/terminal-ui/tui';
import type { WritingTuiMessage, WritingTuiState } from './state.js';

export function historyMessages(state: WritingTuiState): readonly ConversationEntry[] {
  const entries = new Map<string, ConversationEntry>();
  for (const page of state.history) {
    for (const reference of oversizedHistoryEntry(page)) entries.set(reference.id, reference);
    for (const entry of page.entries) {
      const current = entries.get(sessionConversationId(entry));
      const activity = current?.kind === 'activity' ? current : undefined;
      let projection = state.historyEntryCache.get(entry);
      if (projection === undefined || projection.activity !== activity) {
        projection = {
          ...(activity === undefined ? {} : { activity }),
          entries: projectSessionEntry(entry, activity)
        };
        state.historyEntryCache.set(entry, projection);
      }
      for (const item of projection.entries) entries.set(item.id, item);
    }
  }
  const recorded = [...entries.values()];
  const conversation = state.followTail
    ? reconcileConversationEntries(recorded, state.liveConversation)
    : recorded;
  return state.preferences.showReasoning
    ? conversation
    : conversation.filter((entry) => entry.kind !== 'reasoning');
}

export function historyViewport(
  state: WritingTuiState,
  width: number,
  rows: number,
  context: TuiContext
): Element<WritingTuiMessage> {
  // Reserve the visible vertical scrollbar so history measurements have one stable width.
  const columns = Math.max(1, width - 1);
  const expanded = (entry: ConversationEntry) =>
    state.preferences.showTools !== state.expandedTools.includes(entry.id);
  const source = (entry: ConversationEntry) => conversationText(entry, expanded(entry));
  const segments = (entry: ConversationEntry) =>
    entry.kind === 'assistant'
      ? state.presentation.markdown(entry.id, entry.text).render(columns).segments
      : [{ kind: 'text' as const, text: source(entry) }];
  const collection = state.presentation.measure(
    historyMessages(state),
    state.expandedTools,
    `${String(columns)}:${String(state.preferences.showTools)}:${JSON.stringify(context.capabilities.unicode.widthProfile)}`,
    (entry) => {
      if (entry.kind === 'reference') return 1;
      const content = segments(entry)
        .map((segment) => segment.text)
        .join('');
      return (
        (entry.kind === 'activity' ? 1 : 0) +
        Math.max(
          1,
          wrapTextCells(content, columns, {
            widthProfile: context.capabilities.unicode.widthProfile,
            preserveWords: true
          }).length
        )
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
      entry.item.value.kind === 'reference'
        ? referenceButton(entry.item.value)
        : column([
            ...(entry.item.value.kind === 'activity'
              ? [
                  button<WritingTuiMessage>({
                    id: `history-toggle:${entry.item.id}`,
                    label: `${expanded(entry.item.value) ? 'Hide' : 'Show'} ${entry.item.value.label}`,
                    onPress: () => ({ type: 'tool.toggle', id: entry.item.id })
                  })
                ]
              : []),
            richText({
              id: `history:${entry.item.id}`,
              segments: segments(entry.item.value),
              wrap: { preserveWords: true }
            })
          ]),
    {
      id: 'writing-conversation',
      scrollbar: { axis: 'vertical', visible: 'always' },
      onScroll: (request): WritingTuiMessage => ({ type: 'conversation.scroll', request })
    }
  );
}

function referenceButton(
  reference: import('@agent-core/tui').ConversationReferenceEntry
): Element<WritingTuiMessage> {
  return button({
    id: reference.id,
    label: `Read recorded entry · ${String(reference.bytes)} bytes`,
    onPress: () => ({ type: 'history.inspect', reference })
  });
}

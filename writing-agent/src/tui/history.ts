import { renderLocalToolObservation } from '@agent-core/tools-local';
import {
  conversationText,
  oversizedHistoryEntry,
  projectSessionEntry,
  reconcileConversationEntries,
  sessionConversationId,
  type ConversationEntry
} from '@agent-core/tui';
import { button, richText, type Element } from '@ismail-elkorchi/terminal-ui/components';
import { column, measuredViewport } from '@ismail-elkorchi/terminal-ui/layout';
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
          entries: projectSessionEntry(entry, activity, undefined, renderLocalToolObservation)
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

export function historyViewport(state: WritingTuiState, width: number): Element<WritingTuiMessage> {
  const expanded = (entry: ConversationEntry) =>
    state.preferences.showTools !== state.expandedTools.includes(entry.id);
  const source = (entry: ConversationEntry) => conversationText(entry, expanded(entry));
  const segments = (entry: ConversationEntry) =>
    entry.kind === 'assistant'
      ? state.presentation.markdown(entry.id, entry.text).render(width).segments
      : [{ kind: 'text' as const, text: source(entry) }];
  const entries = state.presentation.render(
    historyMessages(state),
    state.expandedTools,
    `${String(width)}:${String(state.preferences.showTools)}`,
    (entry) =>
      entry.kind === 'reference'
        ? referenceButton(entry)
        : column(
            [
              ...(entry.kind === 'activity'
                ? [
                    button<WritingTuiMessage>({
                      id: `history-toggle:${entry.id}`,
                      label: `${expanded(entry) ? 'Hide' : 'Show'} ${entry.label}`,
                      onPress: () => ({ type: 'tool.toggle', id: entry.id })
                    })
                  ]
                : []),
              richText({
                id: `history:${entry.id}`,
                segments: segments(entry),
                wrap: { preserveWords: true }
              })
            ],
            { id: entry.id }
          )
  );
  return measuredViewport(entries, {
    id: 'writing-conversation',
    offset: { row: state.conversationOffset },
    followTail: state.followTail,
    ...(state.conversationAnchor === undefined ? {} : { anchor: state.conversationAnchor }),
    onLayout: (layout) => {
      state.presentation.layout = layout;
    },
    scrollbar: { axis: 'vertical', visible: 'auto' },
    onScroll: (request): WritingTuiMessage => ({ type: 'conversation.scroll', request })
  });
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

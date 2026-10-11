import { localToolCallPresentation, renderLocalToolObservation } from '@agent-core/tools-local';
import {
  conversationEntryView,
  oversizedHistoryEntry,
  projectSessionEntry,
  reconcileConversationEntries,
  sessionConversationId,
  type ConversationEntry
} from '@agent-core/tui';
import type { Element } from '@ismail-elkorchi/terminal-ui/components';
import { measuredViewport } from '@ismail-elkorchi/terminal-ui/layout';
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
          entries: projectSessionEntry(
            entry,
            activity,
            localToolCallPresentation,
            renderLocalToolObservation
          )
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
    (entry.kind === 'reasoning' || state.preferences.showTools) !==
    state.expandedTools.includes(entry.id);
  const entries = state.presentation.render(
    historyMessages(state),
    state.expandedTools,
    `${String(width)}:${String(state.preferences.showTools)}`,
    (entry) =>
      conversationEntryView(entry, {
        width,
        expanded: expanded(entry),
        markdown: (id, source) => state.presentation.markdown(id, source),
        onToggle: (id): WritingTuiMessage => ({ type: 'tool.toggle', id }),
        onInspect: (reference): WritingTuiMessage => ({ type: 'history.inspect', reference })
      })
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

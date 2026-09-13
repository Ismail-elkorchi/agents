import type {
  ConversationActivityEntry,
  ConversationEntry,
  ConversationNoticeEntry
} from '@agent-core/tui';
import { mergeConversationEntries } from '@agent-core/tui';
import type { CodingAgentTuiState } from './state.js';

export function appendNotice(
  state: CodingAgentTuiState,
  text: string,
  tone: ConversationNoticeEntry['tone'] = 'info'
): CodingAgentTuiState {
  return appendEntry(state, { id: localId(state, 'notice'), kind: 'notice', tone, text });
}

export function upsertActivity(
  state: CodingAgentTuiState,
  entry: ConversationActivityEntry
): CodingAgentTuiState {
  const next = upsertConversationEntry(state, entry);
  if (
    entry.status !== 'failed' ||
    next.preferences.showTools ||
    next.conversation.expandedIds.includes(entry.id)
  )
    return next;
  return {
    ...next,
    conversation: {
      ...next.conversation,
      expandedIds: [...next.conversation.expandedIds, entry.id]
    }
  };
}

export function upsertConversationEntry(
  state: CodingAgentTuiState,
  entry: ConversationEntry
): CodingAgentTuiState {
  return {
    ...state,
    conversation: {
      ...state.conversation,
      items: mergeConversationEntries(state.conversation.items, [entry])
    }
  };
}

export function toggleActivity(state: CodingAgentTuiState, id: string): CodingAgentTuiState {
  const expanded = state.conversation.expandedIds.includes(id);
  return {
    ...state,
    conversation: {
      ...state.conversation,
      expandedIds: expanded
        ? state.conversation.expandedIds.filter((candidate) => candidate !== id)
        : [...state.conversation.expandedIds, id]
    }
  };
}

function appendEntry(state: CodingAgentTuiState, entry: ConversationEntry): CodingAgentTuiState {
  return {
    ...state,
    conversation: { ...state.conversation, items: [...state.conversation.items, entry] },
    nextLocalId: state.nextLocalId + 1
  };
}

function localId(state: CodingAgentTuiState, kind: string): string {
  return `${kind}:local:${String(state.nextLocalId)}`;
}

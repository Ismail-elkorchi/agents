import type {
  CodingAgentTuiActivityEntry,
  CodingAgentTuiAssistantEntry,
  CodingAgentTuiConversationEntry,
  CodingAgentTuiNoticeEntry
} from './conversation-model.js';
import type { CodingAgentTuiState } from './state.js';

export function appendUser(state: CodingAgentTuiState, text: string): CodingAgentTuiState {
  return appendEntry(state, { id: localId(state, 'user'), kind: 'user', text });
}

export function appendNotice(
  state: CodingAgentTuiState,
  text: string,
  tone: CodingAgentTuiNoticeEntry['tone'] = 'info'
): CodingAgentTuiState {
  return appendEntry(state, { id: localId(state, 'notice'), kind: 'notice', tone, text });
}

export function upsertAssistant(
  state: CodingAgentTuiState,
  turnId: string,
  text: string,
  status: CodingAgentTuiAssistantEntry['status']
): CodingAgentTuiState {
  if (text.length === 0) return state;
  const id = `assistant:${turnId}`;
  const current = state.conversation.items.find(
    (item): item is CodingAgentTuiAssistantEntry => item.id === id && item.kind === 'assistant'
  );
  if (current?.status === 'complete' && status === 'streaming') return state;
  const entry: CodingAgentTuiAssistantEntry = { id, kind: 'assistant', turnId, text, status };
  if (current === undefined) return appendEntry(state, entry);
  return replaceEntry(state, entry);
}

export function upsertReasoning(
  state: CodingAgentTuiState,
  turnId: string,
  text: string
): CodingAgentTuiState {
  const entry = { id: `reasoning:${turnId}`, kind: 'reasoning' as const, turnId, text };
  return state.conversation.items.some((item) => item.id === entry.id)
    ? replaceEntry(state, entry)
    : appendEntry(state, entry);
}

export function upsertActivity(
  state: CodingAgentTuiState,
  entry: CodingAgentTuiActivityEntry
): CodingAgentTuiState {
  const exists = state.conversation.items.some((item) => item.id === entry.id);
  const next = exists ? replaceEntry(state, entry) : appendEntry(state, entry);
  if (entry.status !== 'failed' || next.conversation.expandedIds.includes(entry.id)) return next;
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
  entry: CodingAgentTuiConversationEntry
): CodingAgentTuiState {
  return state.conversation.items.some((item) => item.id === entry.id)
    ? replaceEntry(state, entry)
    : appendEntry(state, entry);
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

function appendEntry(
  state: CodingAgentTuiState,
  entry: CodingAgentTuiConversationEntry
): CodingAgentTuiState {
  return {
    ...state,
    conversation: { ...state.conversation, items: [...state.conversation.items, entry] },
    nextLocalId: state.nextLocalId + 1
  };
}

function replaceEntry(
  state: CodingAgentTuiState,
  entry: CodingAgentTuiConversationEntry
): CodingAgentTuiState {
  return {
    ...state,
    conversation: {
      ...state.conversation,
      items: state.conversation.items.map((item) => (item.id === entry.id ? entry : item))
    }
  };
}

function localId(state: CodingAgentTuiState, kind: string): string {
  return `${kind}:local:${String(state.nextLocalId)}`;
}

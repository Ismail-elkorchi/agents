import type {
  ConversationActivityEntry,
  ConversationEntry,
  ConversationNoticeEntry
} from '@agent-core/tui';
import { mergeConversationEntries, type ConversationGroupingPresentation } from '@agent-core/tui';
import type { CodingAgentTuiState } from './state.js';

/** Only known, read-only tool identities are eligible, never labels or matching output text. */
export function codingConversationDisplay(
  presentation: ConversationGroupingPresentation,
  entries: readonly ConversationEntry[],
  preserveIds: readonly string[] = []
) {
  return presentation.project(entries, {
    preserveIds,
    classify: (entry) => {
      switch (entry.toolName) {
        case 'read_files':
          return 'read';
        case 'search_text':
          return 'text search';
        case 'find_files':
          return 'file search';
        case 'list_directory':
          return 'directory listing';
        default:
          return undefined;
      }
    }
  });
}

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

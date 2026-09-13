import type { SessionBranchEntry } from '@agent-core/runtime';
import {
  projectSessionEntry,
  sessionConversationId,
  type ConversationActivityEntry
} from '@agent-core/tui';
import { upsertActivity, upsertConversationEntry } from './conversation.js';
import type { CodingAgentTuiState } from './state.js';
import { toolLabel } from './tool-presentation.js';

export function applyBranchEntry(
  state: CodingAgentTuiState,
  entry: SessionBranchEntry
): CodingAgentTuiState {
  const id = sessionConversationId(entry);
  const current = state.conversation.items.find(
    (item): item is ConversationActivityEntry => item.kind === 'activity' && item.id === id
  );
  return projectSessionEntry(entry, current, toolLabel).reduce(
    (state, item) =>
      item.kind === 'activity' ? upsertActivity(state, item) : upsertConversationEntry(state, item),
    state
  );
}

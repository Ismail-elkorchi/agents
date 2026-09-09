import type { SessionBranchEntry } from '@agent-core/runtime';
import { decodeToolCall } from '@agent-core/tools';
import type { CodingAgentTuiActivityEntry } from './conversation-model.js';
import { upsertActivity, upsertAssistant, upsertConversationEntry } from './conversation.js';
import type { CodingAgentTuiState } from './state.js';
import {
  completedSessionToolActivity,
  pendingToolActivity,
  sessionObservationActivityId,
  toolActivityId
} from './tool-presentation.js';

export function applyBranchEntry(state: CodingAgentTuiState, entry: SessionBranchEntry): CodingAgentTuiState {
  switch (entry.type) {
    case 'input':
      return upsertConversationEntry(state, {
        id: `input:${entry.runId}`,
        kind: 'user',
        text: entry.task
      });
    case 'steering':
      return upsertConversationEntry(state, {
        id: entry.deliveryId === undefined ? `session:${entry.id}` : `steering:${entry.deliveryId}`,
        kind: 'user',
        text: entry.content
      });
    case 'assistant':
      return upsertAssistant(
        state,
        entry.turnId,
        entry.content,
        entry.completeness === undefined || entry.completeness === 'complete' ? 'complete' : 'interrupted'
      );
    case 'tool_call': {
      const call = decodeToolCall(entry.call);
      return upsertActivity(state, pendingToolActivity(toolActivityId(entry), call));
    }
    case 'observation': {
      const id = sessionObservationActivityId(entry);
      return upsertActivity(state, completedSessionToolActivity(activity(state, id), entry));
    }
    case 'model_settings':
      return state;
    case 'context_transition':
      return upsertConversationEntry(state, {
        id: `session:${entry.window.windowId}`,
        kind: 'notice',
        tone: 'info',
        text: `Context changed · ${entry.window.selection.strategy} · ${entry.window.windowId}\n${entry.window.reason}`
      });
    case 'branch':
      return upsertConversationEntry(state, {
        id: `session:${entry.id}`,
        kind: 'notice',
        tone: 'info',
        text: `Session branched${entry.label === undefined ? '' : ` · ${entry.label}`}`
      });
  }
}

function activity(state: CodingAgentTuiState, id: string): CodingAgentTuiActivityEntry | undefined {
  return state.conversation.items.find(
    (entry): entry is CodingAgentTuiActivityEntry => entry.kind === 'activity' && entry.id === id
  );
}

import { localToolCallPresentation, renderLocalToolObservation } from '@agent-core/tools-local';
import type { SessionBranchEntry } from '@agent-core/runtime';
import {
  projectSessionEntry,
  sessionConversationId,
  type ConversationActivityEntry
} from '@agent-core/tui';
import { upsertActivity, upsertConversationEntry } from './conversation.js';
import type { CodingAgentTuiState } from './state.js';

export function applyBranchEntry(
  state: CodingAgentTuiState,
  entry: SessionBranchEntry
): CodingAgentTuiState {
  const id = sessionConversationId(entry);
  const current = state.conversation.items.find(
    (item): item is ConversationActivityEntry => item.kind === 'activity' && item.id === id
  );
  return projectSessionEntry(
    entry,
    current,
    localToolCallPresentation,
    renderLocalToolObservation
  ).reduce(
    (state, item) =>
      item.kind === 'activity' ? upsertActivity(state, item) : upsertConversationEntry(state, item),
    state
  );
}

/** Use admitted user intent when available; runtime identifiers remain inspection details. */
export function branchPointPresentation(
  state: CodingAgentTuiState,
  point: import('@agent-core/runtime').SessionBranchPoint
): { readonly title: string; readonly detail: string } {
  const run = point.runId === undefined
    ? undefined
    : state.debug.runs.find((run) => run.state.runId === point.runId);
  const inputs = state.conversation.pages.flatMap((page) => page.history.entries)
    .filter((entry): entry is Extract<SessionBranchEntry, { type: 'input' }> =>
      entry.type === 'input' && entry.timestamp <= point.timestamp);
  const input = point.runId === undefined
    ? inputs.at(-1)
    : inputs.find((entry) => entry.runId === point.runId);
  const task = run?.state.input.task ?? input?.task;
  const kind = point.kind === 'run_finalization' ? 'Completed run'
    : point.kind === 'context_transition' ? 'Context transition' : 'Saved session state';
  const preview = task?.trim().replaceAll(/\s+/gu, ' ');
  return {
    title: preview ? preview.length > 140 ? `${preview.slice(0, 139)}…` : preview : `${kind} (prompt not loaded)`,
    detail: `${point.timestamp} · ${kind}\nEntry: ${point.entryId}${point.runId === undefined ? '' : `\nRun: ${point.runId}`}\n${state.runtimeDetails.workspacePath === undefined ? '' : `Workspace: ${state.runtimeDetails.workspacePath}\n`}Creates a conversation branch in the same workspace, not an isolated Git worktree. Original history remains stored.`
  };
}

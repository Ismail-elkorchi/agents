import { sourceRef, type ContextTransitionRequest, type HistoryView } from '@agent-core/runtime';

/** Conservative overflow policy: retain original user inputs and the latest settled run. */
export function codingHistoryPressureTransition(view: HistoryView): ContextTransitionRequest | undefined {
  const identity = (entry: HistoryView['entries'][number]) => sourceRef(view.cut.sessionId, entry).entryId;
  const olderRuns = new Set(view.runFinalizations.slice(0, -1).map((finalization) => finalization.runId));
  const alreadyOmitted = new Set(
    view.contextWindow?.selection.omitted.flatMap((range) => {
      const start = view.entries.findIndex((entry) => identity(entry) === range.fromEntryId);
      const end = view.entries.findIndex((entry) => identity(entry) === range.toEntryId);
      return view.entries.slice(start, end + 1).map(identity);
    }) ?? []
  );
  const removable = view.entries.filter(
    (entry) =>
      'runId' in entry &&
      olderRuns.has(entry.runId) &&
      (entry.type === 'assistant' || entry.type === 'tool_call' || entry.type === 'observation')
  );
  if (!removable.some((entry) => !alreadyOmitted.has(identity(entry)))) return undefined;
  const omittedIds = new Set(removable.map(identity));
  const omitted: { fromEntryId: string; toEntryId: string; reason: string }[] = [];
  let lastOmitted = false;
  for (const entry of view.entries) {
    if (!omittedIds.has(identity(entry))) {
      lastOmitted = false;
      continue;
    }
    const previous = omitted.at(-1);
    if (lastOmitted && previous) previous.toEntryId = identity(entry);
    else
      omitted.push({
        fromEntryId: identity(entry),
        toEntryId: identity(entry),
        reason: 'Older settled output remains retrievable by exact history source identity.'
      });
    lastOmitted = true;
  }
  return Object.freeze({
    expectedWindowId: view.contextWindow?.windowId ?? null,
    expectedSourceRevision: view.cut.sourceRevision,
    idempotencyKey: `coding-pressure-${view.cut.branchId}-${String(view.cut.sourceRevision)}`,
    reason: 'Context pressure: retain original user contributions and the latest completed work.',
    selection: Object.freeze({
      strategy: 'retain',
      retained: Object.freeze(
        view.entries
          .filter((entry) => entry.type !== 'context_transition' && !omittedIds.has(identity(entry)))
          .map((entry) => sourceRef(view.cut.sessionId, entry))
      ),
      notes: view.contextWindow?.selection.notes ?? [],
      omitted: Object.freeze(omitted)
    })
  });
}

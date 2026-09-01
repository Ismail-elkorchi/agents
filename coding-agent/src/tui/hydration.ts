import type {
  AgentApprovalSuspension,
  AgentRunInspection,
  AgentRunSuspension,
  AgentRunState,
  AgentSessionState,
  AgentTerminalSnapshot,
  SessionBranchEntry,
  SessionBranchPoint,
  SessionPendingSubmission,
  SessionReplayState
} from '@agent-core/runtime';
import { decodeToolCall } from '@agent-core/tools';
import type { CodingHandoff } from '../changes/coding-handoff.js';
import { upsertActivity, upsertAssistant, upsertConversationEntry } from './conversation.js';
import type { CodingAgentTuiActivityEntry } from './conversation-model.js';
import {
  applyCodingHandoff,
  applyCheckResult,
  applyHydratedTerminal,
  applySessionState
} from './event-reducer.js';
import type { CodingAgentTuiState } from './state.js';
import {
  completedSessionToolActivity,
  pendingToolActivity,
  sessionObservationActivityId,
  toolActivityId
} from './tool-presentation.js';

export interface CodingAgentTuiHydration {
  readonly session: AgentSessionState;
  readonly replay: SessionReplayState;
  readonly branchPoints: readonly SessionBranchPoint[];
  readonly pendingSubmissions: readonly SessionPendingSubmission[];
  readonly runs: readonly AgentRunInspection[];
  readonly handoffs: readonly CodingHandoff[];
}

export function hydrateCodingAgentTuiState(
  state: CodingAgentTuiState,
  hydration: CodingAgentTuiHydration
): CodingAgentTuiState {
  assertHydration(hydration);
  let next: CodingAgentTuiState = {
    ...state,
    runtimeDetails: {
      ...state.runtimeDetails,
      providerId: hydration.session.configuration.provider,
      modelId: hydration.session.configuration.model,
      ...(hydration.session.configuration.temperature === undefined
        ? {}
        : { temperature: hydration.session.configuration.temperature })
    },
    debug: {
      ...state.debug,
      sessionId: hydration.session.sessionId,
      session: hydration.session,
      replayState: hydration.replay,
      branchPoints: Object.freeze([...hydration.branchPoints]),
      pendingSubmissions: Object.freeze([...hydration.pendingSubmissions]),
      runs: Object.freeze([...hydration.runs]),
      handoffs: []
    }
  };
  for (const entry of hydration.replay.branch) next = applyBranchEntry(next, entry);
  next = applySessionState(next, hydration.session);
  for (const finalization of hydration.replay.runFinalizations) {
    for (const check of finalization.terminal.checkResults) {
      next = applyCheckResult(next, check, finalization.runId);
    }
  }
  const latestTerminal = hydration.replay.runFinalizations.at(-1)?.terminal;
  if (latestTerminal !== undefined) next = applyHydratedTerminal(next, latestTerminal);
  for (const handoff of hydration.handoffs) next = applyCodingHandoff(next, handoff);
  next = restoreSessionHistory(next, hydration.branchPoints, hydration.replay);
  return restoreSessionRunState(next, hydration);
}

function restoreSessionHistory(
  state: CodingAgentTuiState,
  branchPoints: readonly SessionBranchPoint[],
  replay: SessionReplayState
): CodingAgentTuiState {
  if (branchPoints.length === 0) return state;
  const terminals = new Map<string, AgentTerminalSnapshot>(
    replay.runFinalizations.map((finalization) => [finalization.throughEntryId, finalization.terminal])
  );
  const retained = branchPoints.slice(-100);
  const lines = retained.map((point) => {
    if (point.kind === 'compaction') return `compaction ${point.entryId} · ${point.timestamp}`;
    const terminal = terminals.get(point.entryId);
    const identity = `final ${point.entryId}${point.runId === undefined ? '' : ` · run ${point.runId}`}`;
    return terminal === undefined
      ? `${identity} · terminal outside active replay · ${point.timestamp}`
      : `${identity} · ${terminal.executionStatus} · verification ${terminal.verificationStatus} · model output ${terminal.modelOutput.status}`;
  });
  if (branchPoints.length > retained.length) lines.unshift(`${String(branchPoints.length - retained.length)} earlier branch points omitted`);
  const details = lines.join('\n');
  const priorRuns = branchPoints.filter((point) => point.kind === 'run_finalization').length;
  return upsertActivity(state, {
    id: 'session:history',
    kind: 'activity',
    activity: 'history',
    label: 'Session history',
    status: 'success',
    summary: `${String(branchPoints.length)} branch point${branchPoints.length === 1 ? '' : 's'} · ${String(priorRuns)} terminal run${priorRuns === 1 ? '' : 's'}`,
    details: details.length <= 6_000 ? details : `${details.slice(0, 5_999)}…`
  });
}

function applyBranchEntry(
  state: CodingAgentTuiState,
  entry: SessionBranchEntry
): CodingAgentTuiState {
  switch (entry.type) {
    case 'input':
      return upsertConversationEntry(state, {
        id: `session:${entry.id}`,
        kind: 'user',
        text: entry.task
      });
    case 'steering':
      return upsertConversationEntry(state, {
        id: `session:${entry.id}`,
        kind: 'user',
        text: entry.content
      });
    case 'assistant':
      return upsertAssistant(state, entry.turnId, entry.content, 'complete');
    case 'tool_call': {
      const call = decodeToolCall(entry.call);
      return upsertActivity(state, pendingToolActivity(toolActivityId(entry), call));
    }
    case 'observation': {
      const id = sessionObservationActivityId(entry);
      return upsertActivity(state, completedSessionToolActivity(activity(state, id), entry));
    }
    case 'model_settings': return state;
    case 'compaction':
      return upsertConversationEntry(state, {
        id: `session:${entry.id}`,
        kind: 'notice',
        tone: 'info',
        text: `Session compacted · ${entry.provider}/${entry.model}\n${entry.summary}`
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

function restoreSessionRunState(
  state: CodingAgentTuiState,
  hydration: CodingAgentTuiHydration
): CodingAgentTuiState {
  const session = hydration.session;
  const run = selectedRun(hydration);
  if (session.phase === 'suspended') {
    if (run === undefined) throw new Error('Restored suspended session has no durable run.');
    if (session.suspension?.runId !== run.state.runId) {
      throw new Error('Restored session suspension has no matching durable descriptor.');
    }
    const suspension = runSuspension(run.state);
    if (suspension.reason !== session.suspension.reason) {
      throw new Error('Restored session suspension contradicts its durable run.');
    }
    if (suspension.reason === 'approval_required') {
      return { ...state, run: { kind: 'waiting_for_approval', suspension } };
    }
    return upsertConversationEntry({
      ...state,
      run: { kind: 'waiting_for_recovery', suspension }
    }, {
      id: `recovery:${suspension.runId}`,
      kind: 'notice',
      tone: 'warning',
      text: `Recovery required · ${suspension.reason.replaceAll('_', ' ')}${suspension.effectId === undefined ? '' : ` · effect ${suspension.effectId}`}`
    });
  }
  if (session.phase === 'running') {
    if (run === undefined) throw new Error('Restored running session has no durable run.');
    return { ...state, run: { kind: 'working', label: runLabel(run.state) } };
  }
  if (session.phase === 'compacting') {
    return { ...state, run: { kind: 'working', label: 'Compacting session' } };
  }
  if (session.queuedInputs > 0) {
    const recovering = hydration.pendingSubmissions.some((submission) => submission.state === 'claimed');
    return {
      ...state,
      run: {
        kind: 'working',
        label: recovering ? 'Recovered run queued' : `${String(session.queuedInputs)} queued`
      }
    };
  }
  return state;
}

function selectedRun(hydration: CodingAgentTuiHydration): AgentRunInspection | undefined {
  const activeRunId = hydration.session.activeRunId;
  if (activeRunId !== undefined) {
    return hydration.runs.find((run) => run.state.runId === activeRunId);
  }
  const pendingRunIds = new Set(hydration.pendingSubmissions.map((submission) => submission.runId));
  return hydration.runs.find((run) => pendingRunIds.has(run.state.runId));
}

function runSuspension(
  run: AgentRunState
): AgentApprovalSuspension | AgentRunSuspension {
  if (run.budget === undefined) {
    throw new Error(`Suspended run ${run.runId} has no durable budget.`);
  }
  if (run.phase.kind === 'approval') {
    return {
      state: 'suspended',
      reason: 'approval_required',
      runId: run.runId,
      finalizationId: run.finalizationId,
      pendingApprovals: [run.phase.approval],
      budget: run.budget
    };
  }
  const reason = runSuspensionReason(run);
  if (reason === undefined) throw new Error(`Run ${run.runId} is not suspended.`);
  const effectId = runEffectId(run);
  return {
    state: 'suspended',
    reason,
    runId: run.runId,
    finalizationId: run.finalizationId,
    ...(effectId === undefined ? {} : { effectId }),
    budget: run.budget
  };
}

function runSuspensionReason(
  run: AgentRunState
): AgentRunSuspension['reason'] | undefined {
  const phase = run.phase;
  if (phase.kind === 'provider' && phase.stage === 'outcome_unknown') return 'provider_outcome_unknown';
  if (phase.kind === 'tools' && phase.callStates.some((call) => call.stage === 'outcome_unknown')) return 'tool_outcome_unknown';
  if (phase.kind === 'disposition' && phase.stage === 'outcome_unknown') return 'disposition_outcome_unknown';
  if (phase.kind === 'suspended') return phase.reason;
  return undefined;
}

function runEffectId(run: AgentRunState): string | undefined {
  const phase = run.phase;
  if (phase.kind === 'provider' && phase.stage === 'outcome_unknown') return phase.effect.intent.effectId;
  if (phase.kind === 'tools') {
    return phase.callStates.find((call) => call.stage === 'outcome_unknown')?.effect.intent.effectId;
  }
  if (phase.kind === 'disposition' && phase.stage === 'outcome_unknown') return phase.effect.intent.effectId;
  if (phase.kind === 'suspended') return phase.effectId;
  return undefined;
}

function runLabel(run: AgentRunState): string {
  const control = run.control.status === 'detached'
    ? 'detached'
    : run.control.status === 'abort_requested' ? 'abort requested' : `driver generation ${String(run.driverGeneration)}`;
  const phase = run.phase.kind === 'initializing'
    ? run.phase.step.replaceAll('_', ' ')
    : run.phase.kind === 'provider' || run.phase.kind === 'verification' || run.phase.kind === 'disposition'
      ? `${run.phase.kind} ${run.phase.stage.replaceAll('_', ' ')}`
      : run.phase.kind;
  return `Recovered ${phase} · ${control}`;
}

function activity(state: CodingAgentTuiState, id: string): CodingAgentTuiActivityEntry | undefined {
  return state.conversation.items.find(
    (entry): entry is CodingAgentTuiActivityEntry => entry.kind === 'activity' && entry.id === id
  );
}

function assertHydration(hydration: CodingAgentTuiHydration): void {
  if (hydration.session.sessionId !== hydration.replay.session.id) {
    throw new Error('TUI hydration session does not match its replay state.');
  }
  const pendingRunIds = new Set(hydration.pendingSubmissions.map((submission) => submission.runId));
  for (const run of hydration.runs) {
    if (!pendingRunIds.has(run.state.runId)) {
      throw new Error(`TUI hydration contains an run outside the session pending set: ${run.state.runId}.`);
    }
  }
  for (const handoff of hydration.handoffs) {
    if (!hydration.replay.runFinalizations.some((finalization) => finalization.runId === handoff.runId)) {
      throw new Error(`TUI hydration contains a coding handoff outside the session replay: ${handoff.runId}.`);
    }
  }
}

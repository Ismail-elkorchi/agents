import type {
  AgentApprovalSuspension,
  AgentOperationInspection,
  AgentOperationSuspension,
  AgentOperationState,
  AgentSessionState,
  AgentTerminalSnapshot,
  SessionBranchEntry,
  SessionBranchPoint,
  SessionPendingSubmission,
  SessionReplayState
} from '@agent-core/runtime';
import { decodeToolCall } from '@agent-core/tools';
import type { RunChangeReport } from '../changes/run-change-report.js';
import { upsertActivity, upsertAssistant, upsertConversationEntry } from './conversation.js';
import type { CodingAgentTuiActivityEntry } from './conversation-model.js';
import {
  applyChangeReport,
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
  readonly operations: readonly AgentOperationInspection[];
  readonly changeReports: readonly RunChangeReport[];
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
      operations: Object.freeze([...hydration.operations]),
      changeReports: []
    }
  };
  for (const entry of hydration.replay.branch) next = projectBranchEntry(next, entry);
  next = applySessionState(next, hydration.session);
  for (const projection of hydration.replay.terminalProjections) {
    for (const check of projection.terminal.checkResults) {
      next = applyCheckResult(next, check, projection.runId);
    }
  }
  const latestTerminal = hydration.replay.terminalProjections.at(-1)?.terminal;
  if (latestTerminal !== undefined) next = applyHydratedTerminal(next, latestTerminal);
  for (const report of hydration.changeReports) next = applyChangeReport(next, report);
  next = projectSessionHistory(next, hydration.branchPoints, hydration.replay);
  return projectSessionRunState(next, hydration);
}

function projectSessionHistory(
  state: CodingAgentTuiState,
  branchPoints: readonly SessionBranchPoint[],
  replay: SessionReplayState
): CodingAgentTuiState {
  if (branchPoints.length === 0) return state;
  const terminals = new Map<string, AgentTerminalSnapshot>(
    replay.terminalProjections.map((projection) => [projection.throughEntryId, projection.terminal])
  );
  const retained = branchPoints.slice(-100);
  const lines = retained.map((point) => {
    if (point.kind === 'compaction') return `compaction ${point.entryId} · ${point.timestamp}`;
    const terminal = terminals.get(point.entryId);
    const identity = `final ${point.entryId}${point.runId === undefined ? '' : ` · run ${point.runId}`}`;
    return terminal === undefined
      ? `${identity} · terminal outside active replay · ${point.timestamp}`
      : `${identity} · ${terminal.executionStatus} · verification ${terminal.verificationStatus} · candidate ${terminal.candidate.status}`;
  });
  if (branchPoints.length > retained.length) lines.unshift(`${String(branchPoints.length - retained.length)} earlier branch points omitted`);
  const details = lines.join('\n');
  const priorRuns = branchPoints.filter((point) => point.kind === 'final').length;
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

function projectBranchEntry(
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

function projectSessionRunState(
  state: CodingAgentTuiState,
  hydration: CodingAgentTuiHydration
): CodingAgentTuiState {
  const session = hydration.session;
  const operation = selectedOperation(hydration);
  if (session.phase === 'waiting_for_user') {
    if (operation === undefined) throw new Error('Restored suspended session has no durable operation.');
    const suspension = operationSuspension(operation.state);
    if (suspension.reason !== session.suspensionReason) {
      throw new Error('Restored session suspension contradicts its durable operation.');
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
    if (operation === undefined) throw new Error('Restored running session has no durable operation.');
    return { ...state, run: { kind: 'working', label: operationLabel(operation.state) } };
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
        label: recovering ? 'Recovered operation queued' : `${String(session.queuedInputs)} queued`
      }
    };
  }
  return state;
}

function selectedOperation(hydration: CodingAgentTuiHydration): AgentOperationInspection | undefined {
  const activeRunId = hydration.session.activeRunId;
  if (activeRunId !== undefined) {
    return hydration.operations.find((operation) => operation.state.runId === activeRunId);
  }
  const pendingRunIds = new Set(hydration.pendingSubmissions.map((submission) => submission.runId));
  return hydration.operations.find((operation) => pendingRunIds.has(operation.state.runId));
}

function operationSuspension(
  operation: AgentOperationState
): AgentApprovalSuspension | AgentOperationSuspension {
  if (operation.budget === undefined) {
    throw new Error(`Suspended operation ${operation.runId} has no durable budget.`);
  }
  if (operation.phase.kind === 'approval') {
    return {
      state: 'suspended',
      reason: 'approval_required',
      runId: operation.runId,
      finalizationId: operation.finalizationId,
      pendingApprovals: [operation.phase.approval],
      budget: operation.budget
    };
  }
  const reason = operationSuspensionReason(operation);
  if (reason === undefined) throw new Error(`Operation ${operation.runId} is not suspended.`);
  const effectId = operationEffectId(operation);
  return {
    state: 'suspended',
    reason,
    runId: operation.runId,
    finalizationId: operation.finalizationId,
    ...(effectId === undefined ? {} : { effectId }),
    budget: operation.budget
  };
}

function operationSuspensionReason(
  operation: AgentOperationState
): AgentOperationSuspension['reason'] | undefined {
  const phase = operation.phase;
  if (phase.kind === 'provider' && phase.stage === 'outcome_unknown') return 'provider_outcome_unknown';
  if (phase.kind === 'tools' && phase.callStates.some((call) => call.stage === 'outcome_unknown')) return 'tool_outcome_unknown';
  if (phase.kind === 'disposition' && phase.stage === 'outcome_unknown') return 'disposition_outcome_unknown';
  if (phase.kind === 'suspended') return phase.reason;
  return undefined;
}

function operationEffectId(operation: AgentOperationState): string | undefined {
  const phase = operation.phase;
  if (phase.kind === 'provider' && phase.stage === 'outcome_unknown') return phase.effect.intent.effectId;
  if (phase.kind === 'tools') {
    return phase.callStates.find((call) => call.stage === 'outcome_unknown')?.effect.intent.effectId;
  }
  if (phase.kind === 'disposition' && phase.stage === 'outcome_unknown') return phase.effect.intent.effectId;
  if (phase.kind === 'suspended') return phase.effectId;
  return undefined;
}

function operationLabel(operation: AgentOperationState): string {
  const control = operation.control.status === 'detached'
    ? 'detached'
    : operation.control.status === 'abort_requested' ? 'abort requested' : `driver generation ${String(operation.driverGeneration)}`;
  const phase = operation.phase.kind === 'preparing'
    ? operation.phase.step.replaceAll('_', ' ')
    : operation.phase.kind === 'provider' || operation.phase.kind === 'verification' || operation.phase.kind === 'disposition'
      ? `${operation.phase.kind} ${operation.phase.stage.replaceAll('_', ' ')}`
      : operation.phase.kind;
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
  for (const operation of hydration.operations) {
    if (!pendingRunIds.has(operation.state.runId)) {
      throw new Error(`TUI hydration contains an operation outside the session pending set: ${operation.state.runId}.`);
    }
  }
  for (const report of hydration.changeReports) {
    if (!hydration.replay.terminalProjections.some((projection) => projection.runId === report.runId)) {
      throw new Error(`TUI hydration contains a change report outside the session replay: ${report.runId}.`);
    }
  }
}

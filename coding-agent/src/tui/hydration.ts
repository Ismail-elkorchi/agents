import type {
  AgentApprovalSuspension,
  AgentRunInspection,
  AgentRunState,
  AgentRunSuspension
} from '@agent-core/runtime';
import { suspensionPresentation } from '@agents/tui';
import type { CodingSessionView } from '../application/contracts.js';
import { upsertConversationEntry } from './conversation.js';
import { applySessionState } from './event-reducer.js';
import { presentHistoryPages } from './history.js';
import type { CodingAgentTuiState } from './state.js';

export function hydrateCodingAgentTuiState(
  state: CodingAgentTuiState,
  hydration: CodingSessionView
): CodingAgentTuiState {
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
      branchPoints: Object.freeze([...hydration.branchPoints]),
      pendingSubmissions: Object.freeze([...hydration.pendingSubmissions]),
      runs: Object.freeze([...hydration.runs]),
      changes: [],
      verification: []
    }
  };
  const sameSession = state.debug.sessionId === hydration.session.sessionId;
  const historical = sameSession && !state.conversation.scroll.followTail;
  next = presentHistoryPages(
    next,
    historical
      ? state.conversation.pages
      : [{ history: hydration.history, changes: hydration.changes, verification: hydration.verification }],
    sameSession && !historical
  );
  if (historical)
    next = {
      ...next,
      conversation: {
        ...next.conversation,
        unread:
          state.conversation.unread ||
          state.conversation.pages.at(-1)?.history.boundary.leafId !== hydration.history.boundary.leafId
      }
    };
  for (const pending of hydration.pendingSubmissions) {
    if (!historical && pending.state === 'queued')
      next = upsertConversationEntry(next, {
        id: `input:${pending.runId}`,
        kind: 'user',
        text: pending.input.task
      });
  }
  next = applySessionState(next, hydration.session);
  return restoreSessionRunState(next, hydration);
}

function restoreSessionRunState(
  state: CodingAgentTuiState,
  hydration: CodingSessionView
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
    return upsertConversationEntry(
      {
        ...state,
        run: { kind: 'waiting_for_recovery', suspension }
      },
      {
        id: `recovery:${suspension.runId}`,
        kind: 'notice',
        tone: 'warning',
        text: suspensionPresentation(suspension.reason).explanation
      }
    );
  }
  if (session.phase === 'running') {
    if (run === undefined) throw new Error('Restored running session has no durable run.');
    return { ...state, run: { kind: 'working', label: runLabel(run.state) } };
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

function selectedRun(hydration: CodingSessionView): AgentRunInspection | undefined {
  const activeRunId = hydration.session.activeRunId;
  if (activeRunId !== undefined) {
    return hydration.runs.find((run) => run.state.runId === activeRunId);
  }
  const pendingRunIds = new Set(hydration.pendingSubmissions.map((submission) => submission.runId));
  return hydration.runs.find((run) => pendingRunIds.has(run.state.runId));
}

function runSuspension(run: AgentRunState): AgentApprovalSuspension | AgentRunSuspension {
  if (run.budget === undefined) {
    throw new Error(`Suspended run ${run.runId} has no durable budget.`);
  }
  const approvals = run.toolBatches.flatMap((batch) =>
    batch.callStates.flatMap((call) => (call.stage === 'approval' ? [call.approval] : []))
  );
  const approvalId =
    run.phase.kind === 'suspended' && run.phase.reason === 'approval'
      ? run.phase.approvalId
      : run.phase.kind === 'active'
        ? approvals[0]?.approvalId
        : undefined;
  if (approvalId !== undefined) {
    const selected = approvals.find((approval) => approval.approvalId === approvalId);
    if (selected === undefined) {
      throw new Error(`Suspended run ${run.runId} has no matching pending tool approval.`);
    }
    const pendingApprovals = [
      selected,
      ...approvals.filter((approval) => approval.approvalId !== approvalId)
    ];
    return {
      state: 'suspended',
      reason: 'approval_required',
      runId: run.runId,
      finalizationId: run.finalizationId,
      pendingApprovals,
      budget: run.budget
    };
  }
  const reason = runSuspensionReason(run);
  if (reason === undefined) throw new Error(`Run ${run.runId} is not suspended.`);
  const effectId = runEffectId(run, reason);
  return {
    state: 'suspended',
    reason,
    runId: run.runId,
    finalizationId: run.finalizationId,
    ...(effectId === undefined ? {} : { effectId }),
    budget: run.budget
  };
}

function runSuspensionReason(run: AgentRunState): AgentRunSuspension['reason'] | undefined {
  const phase = run.phase;
  if (phase.kind === 'suspended') return phase.reason === 'approval' ? undefined : phase.reason;
  if (run.providerRequests.some((request) => request.stage === 'outcome_unknown'))
    return 'provider_outcome_unknown';
  if (run.toolBatches.some((batch) => batch.callStates.some((call) => call.stage === 'outcome_unknown')))
    return 'tool_outcome_unknown';
  return undefined;
}

function runEffectId(run: AgentRunState, reason: AgentRunSuspension['reason']): string | undefined {
  const phase = run.phase;
  if (phase.kind === 'suspended' && phase.reason !== 'approval' && phase.effectId !== undefined)
    return phase.effectId;
  if (reason === 'provider_outcome_unknown') {
    return run.providerRequests.find((request) => request.stage === 'outcome_unknown')?.effect.intent
      .effectId;
  }
  if (reason === 'tool_outcome_unknown') {
    return run.toolBatches
      .flatMap((batch) => batch.callStates)
      .find((call) => call.stage === 'outcome_unknown')?.effect.intent.effectId;
  }
  return undefined;
}

function runLabel(run: AgentRunState): string {
  const control =
    run.control.status === 'detached'
      ? 'detached'
      : run.control.status === 'abort_requested'
        ? 'abort requested'
        : `driver generation ${String(run.driverGeneration)}`;
  const phase = run.phase.kind === 'initializing' ? run.phase.step.replaceAll('_', ' ') : run.phase.kind;
  const providers = run.providerRequests.filter((request) => request.stage !== 'consumed').length;
  const calls = run.toolBatches
    .flatMap((batch) => batch.callStates)
    .filter((call) => call.stage !== 'recorded' && call.stage !== 'cancelled').length;
  const work =
    run.phase.kind === 'active'
      ? ` · ${String(providers)} provider request${providers === 1 ? '' : 's'} · ${String(calls)} pending tool${calls === 1 ? '' : 's'}`
      : '';
  return `Recovered ${phase}${work} · ${control}`;
}

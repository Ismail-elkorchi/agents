import type { AgentProgressEvent, AgentRunPhase, AgentSessionState } from '@agent-core/runtime';
import { type CheckResult } from '@agents/verification';
import { codingHandoffUncertainties } from '../presentation/run-summary.js';
import type { CodingHandoff } from '../changes/coding-handoff.js';
import type { CodingEndedRunResult } from '../outcome.js';
import type { CodingAgentTuiActivityEntry } from './conversation-model.js';
import {
  appendNotice,
  upsertActivity,
  upsertAssistant,
  upsertConversationEntry,
  upsertReasoning
} from './conversation.js';
import { terminalPresentation } from './run-presentation.js';
import type { CodingAgentTuiState } from './state.js';
import {
  completedToolActivity,
  pendingToolActivity,
  runningToolActivity,
  toolActivityId,
  updatedToolActivity
} from './tool-presentation.js';

type ProgressEventType = AgentProgressEvent['type'];
type ProgressEvent<K extends ProgressEventType> = Extract<AgentProgressEvent, { readonly type: K }>;

export function applyProgress(state: CodingAgentTuiState, event: AgentProgressEvent): CodingAgentTuiState {
  switch (event.type) {
    case 'turn.started':
      return reduceTurnStarted(state, event);
    case 'context.transitioned':
      return upsertConversationEntry(state, {
        id: `session:${event.window.windowId}`,
        kind: 'notice',
        tone: 'info',
        text: `Context changed · ${event.window.selection.strategy} · ${event.window.windowId}\n${event.window.reason}`
      });
    case 'context.replay.restored':
      return reduceReplayRestored(state, event);
    case 'provider.state.restored':
      return reduceProviderStateRestored(state, event);
    case 'run.configured':
      return reduceRunConfigured(state, event);
    case 'run.phase.changed':
      return reducePhaseChanged(state, event);
    case 'assistant.started':
      return upsertAssistant(withWorking(state, 'Thinking'), event.turnId, '', 'streaming');
    case 'assistant.delta':
      return upsertAssistant(
        withWorking(state, 'Responding'),
        event.turnId,
        event.accumulated,
        'streaming'
      );
    case 'assistant.reasoning':
      return reduceReasoning(state, event);
    case 'assistant.status':
      return withWorking(state, compact(event.message));
    case 'tool.call.received':
      return reduceToolCall(state, event);
    case 'assistant.ended':
      return upsertAssistant(withWorking(state, 'Working'), event.turnId, event.content, 'complete');
    case 'assistant.interrupted':
      return reduceAssistantInterrupted(state, event);
    case 'model.failed':
      return reduceModelFailed(state, event);
    case 'tool.started':
      return reduceToolStarted(state, event);
    case 'tool.updated':
      return reduceToolUpdated(state, event);
    case 'tool.ended':
      return reduceToolEnded(state, event);
    case 'run.ended':
      return applyTerminal(state, event.terminal, event.deliveryDiagnostics);
  }
  return state;
}

function reduceTurnStarted(
  state: CodingAgentTuiState,
  event: ProgressEvent<'turn.started'>
): CodingAgentTuiState {
  return {
    ...withWorking(state, 'Initializing'),
    debug: {
      ...state.debug,
      runId: event.runId,
      ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId })
    }
  };
}

function reduceReplayRestored(
  state: CodingAgentTuiState,
  event: ProgressEvent<'context.replay.restored'>
): CodingAgentTuiState {
  return {
    ...state,
    debug: {
      ...state.debug,
      sessionId: event.sessionId,
      replay: event,
      ...(event.restoredProviderState === undefined ? {} : { providerState: event.restoredProviderState })
    }
  };
}

function reduceProviderStateRestored(
  state: CodingAgentTuiState,
  event: ProgressEvent<'provider.state.restored'>
): CodingAgentTuiState {
  return { ...state, debug: { ...state.debug, providerState: event.state } };
}

function reduceRunConfigured(
  state: CodingAgentTuiState,
  event: ProgressEvent<'run.configured'>
): CodingAgentTuiState {
  const reasoning = event.configuration.runtime.reasoning;
  return {
    ...state,
    runtimeDetails: {
      ...state.runtimeDetails,
      providerId: event.configuration.provider.id,
      modelId: event.configuration.model.id,
      ...(event.configuration.runtime.temperature === undefined
        ? {}
        : { temperature: event.configuration.runtime.temperature }),
      ...(reasoning?.strategy === 'effort' ? { reasoningEffort: reasoning.effort } : {})
    },
    debug: { ...state.debug, configuration: event.configuration }
  };
}

function reducePhaseChanged(
  state: CodingAgentTuiState,
  event: ProgressEvent<'run.phase.changed'>
): CodingAgentTuiState {
  return {
    ...state,
    run: { kind: 'working', phase: event.phase, label: phaseLabel(event.phase) },
    debug: { ...state.debug, phase: event.phase, budget: event.budget }
  };
}

function reduceReasoning(
  state: CodingAgentTuiState,
  event: ProgressEvent<'assistant.reasoning'>
): CodingAgentTuiState {
  if (state.runtimeDetails.showReasoning !== true || event.channel !== 'summary')
    return withWorking(state, 'Thinking');
  return upsertReasoning(withWorking(state, 'Thinking'), event.turnId, event.accumulated);
}

function reduceToolCall(
  state: CodingAgentTuiState,
  event: ProgressEvent<'tool.call.received'>
): CodingAgentTuiState {
  return upsertActivity(
    withWorking(state, 'Planning tool'),
    pendingToolActivity(toolActivityId({ ...event, runId: currentRunId(state) }), event.toolCall)
  );
}

function reduceAssistantInterrupted(
  state: CodingAgentTuiState,
  event: ProgressEvent<'assistant.interrupted'>
): CodingAgentTuiState {
  let next = upsertAssistant(withWorking(state, 'Recovering'), event.turnId, event.content, 'interrupted');
  if (event.reasoningSummary !== undefined && state.runtimeDetails.showReasoning === true) {
    next = upsertReasoning(next, event.turnId, event.reasoningSummary);
  }
  if (event.diagnostic !== undefined) {
    next = appendNotice(next, diagnosticText(event.diagnostic), 'error');
  }
  return next;
}

function reduceModelFailed(
  state: CodingAgentTuiState,
  event: ProgressEvent<'model.failed'>
): CodingAgentTuiState {
  return appendNotice(withWorking(state, 'Provider failed'), diagnosticText(event.diagnostic), 'error');
}

function reduceToolStarted(
  state: CodingAgentTuiState,
  event: ProgressEvent<'tool.started'>
): CodingAgentTuiState {
  return upsertActivity(
    withWorking(state, 'Running tool'),
    runningToolActivity(
      toolActivityId({ ...event, runId: currentRunId(state) }),
      event.input,
      event.effects
    )
  );
}

function reduceToolUpdated(
  state: CodingAgentTuiState,
  event: ProgressEvent<'tool.updated'>
): CodingAgentTuiState {
  const id = toolActivityId({ ...event, runId: currentRunId(state) });
  const label = progressLabel(event.progress);
  return upsertActivity(
    withWorking(state, 'Running tool'),
    updatedToolActivity(activity(state, id), id, event.toolName, label)
  );
}

function progressLabel(progress: import('@agent-core/tools').ToolProgress): string {
  switch (progress.type) {
    case 'status':
      return progress.message ?? progress.stage;
    case 'output':
      return `${progress.stream}: ${progress.text}`;
    case 'metric':
      return `${progress.name}: ${String(progress.value)}${progress.unit ? ` ${progress.unit}` : ''}`;
  }
}

function reduceToolEnded(
  state: CodingAgentTuiState,
  event: ProgressEvent<'tool.ended'>
): CodingAgentTuiState {
  const id = toolActivityId({ ...event, runId: currentRunId(state) });
  return upsertActivity(
    withWorking(state, event.observation.ok ? 'Working' : 'Tool failed'),
    completedToolActivity(activity(state, id), id, event.toolName, event.observation)
  );
}

export function applyCheckResult(
  state: CodingAgentTuiState,
  result: CheckResult,
  runId: string
): CodingAgentTuiState {
  const status =
    result.verdict === 'passed'
      ? 'success'
      : result.verdict === 'failed' && result.requirement === 'required'
        ? 'failed'
        : 'warning';
  const details = [
    result.diagnostic?.message,
    result.output === undefined ? undefined : JSON.stringify(result.output, null, 2),
    result.artifacts === undefined || result.artifacts.length === 0
      ? undefined
      : `Artifacts\n${result.artifacts.map((artifact) => artifact.artifactId).join('\n')}`
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join('\n\n');
  return upsertActivity(state, {
    id: `check:${runId}:${result.id}`,
    kind: 'activity',
    activity: 'check',
    label: `Check ${result.id}`,
    status,
    summary: compact(result.summary),
    ...(details.length === 0
      ? {}
      : { details: details.length <= 6_000 ? details : `${details.slice(0, 5_999)}…` })
  });
}

export function applySessionState(
  state: CodingAgentTuiState,
  session: AgentSessionState
): CodingAgentTuiState {
  const reasoning = session.configuration.reasoning;
  return {
    ...state,
    runtimeDetails: {
      ...state.runtimeDetails,
      providerId: session.configuration.provider,
      modelId: session.configuration.model,
      ...(session.configuration.temperature === undefined
        ? {}
        : { temperature: session.configuration.temperature }),
      ...(reasoning?.strategy === 'effort' ? { reasoningEffort: reasoning.effort } : {})
    },
    debug: { ...state.debug, session }
  };
}

export function applyCodingHandoff(
  state: CodingAgentTuiState,
  handoff: CodingHandoff
): CodingAgentTuiState {
  state = handoff.outcome.verification.checks.reduce(
    (current, check) => applyCheckResult(current, check, handoff.terminal.runId),
    state
  );
  const report = handoff.changeReport;
  const uncertainties = codingHandoffUncertainties(handoff);
  const structured = report.changes.filter((change) => change.attribution === 'structured_mutation').length;
  const external = report.changes.filter(
    (change) => change.attribution === 'external_or_concurrent'
  ).length;
  const changeSummary =
    report.totalChanges === 0
      ? 'No workspace changes'
      : `${String(report.totalChanges)} changed path${report.totalChanges === 1 ? '' : 's'} · ${String(structured)} structured · ${String(external)} external/concurrent`;
  const summary = `${changeSummary} · ${handoff.outcome.publication.replaceAll('_', ' ')} · ${uncertainties.length === 0 ? 'no remaining uncertainty' : `${String(uncertainties.length)} remaining uncertaint${uncertainties.length === 1 ? 'y' : 'ies'}`}`;
  const details = [
    `Reviewed revision ${report.finalDigest}`,
    `Publication ${handoff.outcome.publication}`,
    `Change artifact ${handoff.changeArtifact.artifactId}`,
    '',
    ...report.changes.map(
      (change) =>
        `${change.kind} ${change.path} · ${change.attribution}${change.conflicts.length === 0 ? '' : ` · ${change.conflicts.join(', ')}`}`
    ),
    ...(report.omittedChanges === 0 ? [] : [`${String(report.omittedChanges)} additional changes omitted`]),
    '',
    `Remaining uncertainty\n${uncertainties.length === 0 ? 'none' : uncertainties.join('\n')}`
  ].join('\n');
  const handoffs = state.debug.handoffs.some(
    (candidate) => candidate.terminal.runId === handoff.terminal.runId
  )
    ? state.debug.handoffs.map((candidate) =>
        candidate.terminal.runId === handoff.terminal.runId ? handoff : candidate
      )
    : [...state.debug.handoffs, handoff];
  return upsertActivity(
    {
      ...state,
      debug: { ...state.debug, handoffs }
    },
    {
      id: `handoff:${handoff.terminal.runId}`,
      kind: 'activity',
      activity: 'change',
      label: 'Coding handoff',
      status: report.coverage === 'partial' || uncertainties.length > 0 ? 'warning' : 'success',
      summary,
      ...(details.length === 0 ? {} : { details })
    }
  );
}

export function applyResult(state: CodingAgentTuiState, result: CodingEndedRunResult): CodingAgentTuiState {
  const checked = result.outcome.verification.checks.reduce(
    (current, check) => applyCheckResult(current, check, result.terminal.runId),
    state
  );
  const ended = applyTerminal(checked, result.terminal, result.deliveryDiagnostics);
  if (result.outcome.acceptance === 'rejected') return appendNotice(ended, 'Verification failed', 'error');
  if (result.outcome.acceptance === 'inconclusive')
    return appendNotice(
      ended,
      result.outcome.reason ?? 'Acceptance requires reconciliation or further work.',
      'warning'
    );
  return ended;
}

export function applyFailure(state: CodingAgentTuiState, message: string): CodingAgentTuiState {
  return appendNotice({ ...state, run: { kind: 'failed', message } }, message, 'error');
}

function applyTerminal(
  state: CodingAgentTuiState,
  terminal: CodingEndedRunResult['terminal'],
  deliveryDiagnostics: CodingEndedRunResult['deliveryDiagnostics']
): CodingAgentTuiState {
  const presentation = terminalPresentation(terminal);
  let next = state;
  next = {
    ...next,
    run: { kind: 'ended', terminal },
    debug: {
      ...next.debug,
      phase: 'ended',
      budget: terminal.budget,
      terminal,
      deliveryDiagnostics
    }
  };
  if (presentation.message.trim().length > 0 && !hasVisibleMessage(next, presentation.message)) {
    next =
      terminal.modelOutput.status === 'absent'
        ? appendNotice(next, presentation.message, presentation.status === 'error' ? 'error' : 'warning')
        : upsertAssistant(next, `terminal:${terminal.finalizationId}`, presentation.message, 'complete');
  }
  if (presentation.status === 'warning' || presentation.status === 'error') {
    if (!hasVisibleMessage(next, presentation.headline)) {
      next = appendNotice(
        next,
        presentation.headline,
        presentation.status === 'error' ? 'error' : 'warning'
      );
    }
  }
  return next;
}

export function applyHydratedTerminal(
  state: CodingAgentTuiState,
  terminal: CodingEndedRunResult['terminal']
): CodingAgentTuiState {
  return applyTerminal(state, terminal, []);
}

function hasVisibleMessage(state: CodingAgentTuiState, message: string): boolean {
  const normalized = message.trim();
  return state.conversation.items.some(
    (item) => (item.kind === 'assistant' || item.kind === 'notice') && item.text.trim() === normalized
  );
}

function activity(state: CodingAgentTuiState, id: string): CodingAgentTuiActivityEntry | undefined {
  return state.conversation.items.find(
    (item): item is CodingAgentTuiActivityEntry => item.id === id && item.kind === 'activity'
  );
}

function withWorking(state: CodingAgentTuiState, label: string): CodingAgentTuiState {
  const phase = state.run.kind === 'working' ? state.run.phase : state.debug.phase;
  return { ...state, run: { kind: 'working', label, ...(phase === undefined ? {} : { phase }) } };
}

function currentRunId(state: CodingAgentTuiState): string {
  if (state.debug.runId === undefined)
    throw new Error('Run progress arrived before its durable run identity.');
  return state.debug.runId;
}

function phaseLabel(phase: AgentRunPhase): string {
  switch (phase) {
    case 'initializing':
      return 'Initializing';
    case 'requesting_model':
      return 'Thinking';
    case 'executing_tools':
      return 'Using tools';
    case 'waiting_for_approval':
      return 'Approval required';
    case 'finalizing':
      return 'Finishing';
    case 'ended':
      return 'Completed';
  }
}

function compact(value: string): string {
  const normalized = value.trim().replaceAll(/\s+/g, ' ');
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 239)}…`;
}

function diagnosticText(diagnostic: ProgressEvent<'model.failed'>['diagnostic']): string {
  const cause =
    diagnostic.causeSummary === undefined ? '' : ` · ${JSON.stringify(diagnostic.causeSummary)}`;
  return `${diagnostic.provider} ${diagnostic.code}${cause}`;
}

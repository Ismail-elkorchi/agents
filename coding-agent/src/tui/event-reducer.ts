import type {
  AgentEndedRunResult,
  AgentProgressEvent,
  AgentRunPhase,
  AgentSessionState
} from '@agent-core/runtime';
import { providerFailureText } from '@agents/tui';
import type { CodingAgentTuiActivityEntry } from './conversation-model.js';
import type { CodingRunVerification } from '../verification/configured-check-tool.js';
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
      return withWorking(state, 'Thinking');
    case 'assistant.delta':
      return upsertAssistant(withWorking(state, 'Responding'), event.turnId, event.accumulated, 'streaming');
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
  if (!state.showReasoning || event.channel !== 'summary') return withWorking(state, 'Thinking');
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
  if (event.reasoningSummary !== undefined && state.showReasoning) {
    next = upsertReasoning(next, event.turnId, event.reasoningSummary);
  }
  if (event.diagnostic !== undefined) {
    next = appendNotice(next, providerFailureText(event.diagnostic), 'error');
  }
  return next;
}

function reduceModelFailed(
  state: CodingAgentTuiState,
  event: ProgressEvent<'model.failed'>
): CodingAgentTuiState {
  return appendNotice(withWorking(state, 'Provider failed'), providerFailureText(event.diagnostic), 'error');
}

function reduceToolStarted(
  state: CodingAgentTuiState,
  event: ProgressEvent<'tool.started'>
): CodingAgentTuiState {
  return upsertActivity(
    withWorking(state, 'Running tool'),
    runningToolActivity(toolActivityId({ ...event, runId: currentRunId(state) }), event.input, event.effects)
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

export function applyConfiguredChecks(
  state: CodingAgentTuiState,
  verification: CodingRunVerification
): CodingAgentTuiState {
  const reports: readonly CodingRunVerification[] = state.debug.verification.some(
    (item) => item.runId === verification.runId
  )
    ? state.debug.verification.map((item) =>
        item.runId === verification.runId ? verification : item
      )
    : [...state.debug.verification, verification];
  return verification.checks.reduce<CodingAgentTuiState>(
    (current, check) =>
      upsertActivity(current, {
        id: `check:${verification.runId}:${check.id}`,
        kind: 'activity',
        activity: 'check',
        label: `Check ${check.id}`,
        status:
          check.status === 'passed'
            ? 'success'
            : check.status === 'failed' && check.requirement === 'required'
              ? 'failed'
              : 'warning',
        summary: `${check.requirement} · ${check.status} · ${check.coverage}`,
        ...(check.output ? { details: check.output } : {})
      }),
    { ...state, debug: { ...state.debug, verification: reports } }
  );
}

export function applyResult(state: CodingAgentTuiState, result: AgentEndedRunResult): CodingAgentTuiState {
  return applyTerminal(state, result.terminal, result.deliveryDiagnostics);
}

export function applyFailure(state: CodingAgentTuiState, message: string): CodingAgentTuiState {
  return appendNotice({ ...state, run: { kind: 'failed', message } }, message, 'error');
}

function applyTerminal(
  state: CodingAgentTuiState,
  terminal: AgentEndedRunResult['terminal'],
  deliveryDiagnostics: AgentEndedRunResult['deliveryDiagnostics']
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
      next = appendNotice(next, presentation.headline, presentation.status === 'error' ? 'error' : 'warning');
    }
  }
  return next;
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

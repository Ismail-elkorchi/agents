import { renderLocalToolObservation } from '@agent-core/tools-local';
import type {
  AgentEndedRunResult,
  AgentProgressEvent,
  AgentRunPhase,
  AgentSessionState
} from '@agent-core/runtime';
import { presentProgress, projectProgress, providerFailureText } from '@agent-core/tui';
import type { CodingRunVerification } from '../verification/configured-check-tool.js';
import { appendNotice, upsertActivity, upsertConversationEntry } from './conversation.js';
import { terminalPresentation } from './run-presentation.js';
import type { CodingAgentTuiState } from './state.js';
import { toolLabel } from './tool-presentation.js';

type ProgressEventType = AgentProgressEvent['type'];
type ProgressEvent<K extends ProgressEventType> = Extract<AgentProgressEvent, { readonly type: K }>;

export function applyProgress(
  state: CodingAgentTuiState,
  event: AgentProgressEvent,
  runId: string
): CodingAgentTuiState {
  state = { ...state, progress: presentProgress(state.progress, event) };
  state = projectProgress(
    { runId, event },
    state.conversation.items,
    toolLabel,
    renderLocalToolObservation
  ).reduce(
    (state, entry) =>
      entry.kind === 'activity'
        ? upsertActivity(state, entry)
        : upsertConversationEntry(state, entry),
    state
  );
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
      return withWorking(state, 'Preparing request');
    case 'model.requested':
      return withWorking(state, 'Requesting response');
    case 'assistant.delta':
      return withWorking(state, 'Responding');
    case 'assistant.reasoning':
      return withWorking(state, 'Reasoning');
    case 'assistant.status':
      return withWorking(state, compact(event.message));
    case 'tool.call.received':
      return withWorking(state, 'Preparing tool');
    case 'assistant.ended':
      return withWorking(state, 'Working');
    case 'assistant.interrupted':
      return reduceAssistantInterrupted(state, event);
    case 'model.failed':
      return reduceModelFailed(state, event);
    case 'tool.started':
      return withWorking(state, 'Running tool');
    case 'tool.updated':
      return withWorking(state, 'Running tool');
    case 'tool.ended':
      return withWorking(state, event.observation.kind === 'failure' ? 'Tool failed' : 'Working');
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
      ...(event.restoredProviderState === undefined
        ? {}
        : { providerState: event.restoredProviderState })
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
  const details = { ...state.runtimeDetails };
  delete details.reasoning;
  delete details.temperature;
  return {
    ...state,
    runtimeDetails: {
      ...details,
      providerId: event.configuration.provider.id,
      modelId: event.configuration.model.id,
      ...(event.configuration.runtime.temperature === undefined
        ? {}
        : { temperature: event.configuration.runtime.temperature }),
      ...(reasoning === undefined ? {} : { reasoning })
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

function reduceAssistantInterrupted(
  state: CodingAgentTuiState,
  event: ProgressEvent<'assistant.interrupted'>
): CodingAgentTuiState {
  let next = withWorking(state, 'Recovering');
  if (event.diagnostic !== undefined) {
    next = appendNotice(next, providerFailureText(event.diagnostic), 'error');
  }
  return next;
}

function reduceModelFailed(
  state: CodingAgentTuiState,
  event: ProgressEvent<'model.failed'>
): CodingAgentTuiState {
  return appendNotice(
    withWorking(state, 'Provider failed'),
    providerFailureText(event.diagnostic),
    'error'
  );
}

export function applySessionState(
  state: CodingAgentTuiState,
  session: AgentSessionState
): CodingAgentTuiState {
  const reasoning = session.configuration.reasoning;
  const details = { ...state.runtimeDetails };
  delete details.reasoning;
  delete details.temperature;
  return {
    ...state,
    runtimeDetails: {
      ...details,
      providerId: session.configuration.provider,
      modelId: session.configuration.model,
      ...(session.configuration.temperature === undefined
        ? {}
        : { temperature: session.configuration.temperature }),
      ...(reasoning === undefined ? {} : { reasoning })
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
  const historyId = `check-history:${verification.runId}`;
  if (
    !verification.history.complete ||
    state.conversation.items.some((entry) => entry.id === historyId)
  )
    state = upsertActivity(state, {
      id: historyId,
      kind: 'activity',
      activity: 'check-history',
      label: 'Check history',
      status: verification.history.complete ? 'complete' : 'warning',
      summary: verification.history.complete
        ? 'Recorded check history loaded.'
        : `Partial history through event ${String(verification.history.nextSequence)}; ${String(verification.history.omittedEarlierChecks)} earlier checks outside this view. Further history reads advance the bounded page.`
    });
  return verification.checks.reduce<CodingAgentTuiState>(
    (current, check) =>
      upsertActivity(current, {
        id: `check:${verification.runId}:${check.receipt?.eventId ?? check.definition.definitionIdentity}`,
        kind: 'activity',
        activity: 'check',
        label: `Check ${check.id}`,
        status:
          check.status === 'passed' && check.applicability.status === 'current'
            ? 'success'
            : check.status === 'failed'
              ? 'failed'
              : 'warning',
        summary: `${check.requirement} · ${check.receipt ? 'historical ' : ''}${check.status} · ${check.coverage} · applicability ${check.applicability.status}${check.outputComplete === false ? ' · output incomplete' : ''}`,
        details: [
          {
            id: 'check-definition',
            content: `${check.definition.command}\nTimeout: ${String(check.definition.timeoutMs)}ms\nDefinition: ${check.definition.definitionIdentity}\nTested paths: ${check.definition.testedPaths.join(', ') || 'undeclared'}\n${check.applicability.reasons.join(', ')}${check.receipt ? `\nEvent: ${check.receipt.eventId}` : ''}`
          },
          ...(check.output ? [{ id: 'check-output', content: check.output }] : []),
          ...(check.outputArtifacts ?? []).map((artifact) => ({
            id: `check-artifact:${artifact.artifactId}`,
            content: `Original output: ${artifact.artifactId}`
          }))
        ]
      }),
    { ...state, debug: { ...state.debug, verification: reports } }
  );
}

export function applyResult(
  state: CodingAgentTuiState,
  result: AgentEndedRunResult
): CodingAgentTuiState {
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
        ? appendNotice(
            next,
            presentation.message,
            presentation.status === 'error' ? 'error' : 'warning'
          )
        : upsertConversationEntry(next, {
            id: `assistant:terminal:${terminal.finalizationId}`,
            turnId: `terminal:${terminal.finalizationId}`,
            kind: 'assistant',
            text: presentation.message,
            status: 'complete'
          });
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

function hasVisibleMessage(state: CodingAgentTuiState, message: string): boolean {
  const normalized = message.trim();
  return state.conversation.items.some(
    (item) =>
      (item.kind === 'assistant' || item.kind === 'notice') && item.text.trim() === normalized
  );
}

function withWorking(state: CodingAgentTuiState, label: string): CodingAgentTuiState {
  const phase = state.run.kind === 'working' ? state.run.phase : state.debug.phase;
  return { ...state, run: { kind: 'working', label, ...(phase === undefined ? {} : { phase }) } };
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

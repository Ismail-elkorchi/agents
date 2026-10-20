import {
  progressStatusFields,
  reasoningLabel,
  responsiveStatusline,
  suspensionPresentation,
  type StatusField
} from '@agent-core/tui';
import type { Element, InlineContent } from '@ismail-elkorchi/terminal-ui/components';
import { button, richText, text } from '@ismail-elkorchi/terminal-ui/components';
import { row } from '@ismail-elkorchi/terminal-ui/layout';
import { terminalTextWidth } from '@ismail-elkorchi/terminal-ui/text';
import type { CodingAgentTuiMessage } from './messages.js';
import { terminalPresentation } from './run-presentation.js';
import type { CodingAgentTuiState } from './state.js';

export function statusChrome(state: CodingAgentTuiState, columns: number): Element {
  return text({
    id: 'status',
    content: responsiveStatusline(
      columns < 36 ? 'CA' : columns < 90 ? 'Coding' : 'Coding Agent',
      state.preferences,
      codingStatusFields(state),
      columns
    )
  });
}

function modelSelectionLabel(state: CodingAgentTuiState): string | undefined {
  const provider = state.runtimeDetails.providerId;
  const model = state.runtimeDetails.modelId;
  if (provider !== undefined && model !== undefined) return `${provider}/${model}`;
  return provider ?? model;
}

function queueLabel(state: CodingAgentTuiState): string | undefined {
  const queued = state.debug.session?.queuedInputs ?? 0;
  return queued === 0 ? undefined : `${String(queued)} queued`;
}

export function codingStatusFields(state: CodingAgentTuiState): readonly StatusField[] {
  const field = (id: string, label: string, value: string | undefined): StatusField => ({
    id,
    label,
    ...(value === undefined ? {} : { value })
  });
  return [
    ...progressStatusFields(state.progress),
    field('session', 'Session', state.debug.sessionId),
    field('workspace', 'Workspace', state.runtimeDetails.workspacePath),
    field('changes', 'Loaded recorded changes', recordedChanges(state) === 0 ? undefined : `${String(recordedChanges(state))} recorded changes`),
    field('decisions', 'Pending decisions', state.run.kind === 'waiting_for_approval' ? `${String(state.run.suspension.pendingApprovals.length)} approval requests` : state.run.kind === 'waiting_for_recovery' ? 'Recovery decision' : undefined),
    {
      ...field('model', 'Model', modelSelectionLabel(state)),
      ...(state.runtimeDetails.modelId === undefined
        ? {}
        : { compactValue: state.runtimeDetails.modelId })
    },
    field('reasoning', 'Reasoning configuration', reasoningLabel(state.runtimeDetails.reasoning)),
    { ...field(
      'mode',
      'Permissions',
      state.runtimeDetails.permissions === undefined
        ? 'Permissions unknown'
        : state.runtimeDetails.permissions.mode === 'full_host'
          ? 'Full host'
          : 'Read only'
    ), compactValue: state.runtimeDetails.permissions === undefined ? 'Auth ?' : state.runtimeDetails.permissions.mode === 'full_host' ? 'Full host' : 'Read only' },
    field('trust', 'Workspace trust', state.runtimeDetails.workspaceTrust),
    { ...field('status', 'Run status', runStatus(state)), compactValue: compactRunStatus(state) },
    field('queue', 'Queued inputs', queueLabel(state))
  ];
}

export function hintBar(
  columns: number,
  bindings: readonly { readonly label: string; readonly keys: string }[]
): Element<CodingAgentTuiMessage> {
  const show = (label: string, action: string) => {
    const entry = bindings.find((item) => item.label === label);
    return entry === undefined ? '' : `${entry.keys} ${action}`;
  };
  const text =
    columns < 50
      ? show('commands', 'commands')
      : [show('commands', 'commands'), show('help', 'help')].filter(Boolean).join(' · ');
  return richText({ id: 'hints', segments: muted(text), wrap: false });
}

function runStatus(state: CodingAgentTuiState): string {
  if (state.setup.status === 'initializing') return 'Initializing';
  if (state.setup.status === 'setup_required') return 'Setup required';
  switch (state.run.kind) {
    case 'idle':
      return 'Idle';
    case 'working':
      return state.progress.label;
    case 'waiting_for_approval':
      return 'Approval required';
    case 'waiting_for_recovery':
      return suspensionPresentation(state.run.suspension).title;
    case 'failed':
      return 'Failed';
    case 'ended':
      return terminalPresentation(state.run.terminal).headline;
  }
}

function muted(text: string): InlineContent {
  return [{ kind: 'text', text, style: { dim: true } }];
}


/** Contextual reading controls over existing authoritative inspectors, not another state store. */
export function operationalControls(
  state: CodingAgentTuiState,
  columns: number
): Element<CodingAgentTuiMessage> | undefined {
  const sessionId = state.debug.sessionId;
  if (sessionId === undefined) return undefined;
  const candidates: { id: string; label: string; message: CodingAgentTuiMessage }[] = [];
  if (state.run.kind === 'waiting_for_approval' || state.run.kind === 'waiting_for_recovery')
    candidates.push({ id: 'inspect-decision', label: state.run.kind === 'waiting_for_approval'
      ? `Review ${String(state.run.suspension.pendingApprovals.length)} approval${state.run.suspension.pendingApprovals.length === 1 ? '' : 's'}`
      : 'Review recovery', message: { type: 'operational.open', sessionId, target: 'recovery' } });
  if (state.settledProcess?.sessionId === sessionId) {
    const result = state.settledProcess.result;
    candidates.push({ id: 'inspect-settled-command', label: `Inspect command (${result.status})`,
      message: { type: 'processes.open', target: { sessionId, processId: result.processId, owner: result.owner } } });
  }
  if (recordedChanges(state) > 0)
    candidates.push({ id: 'inspect-recorded-changes', label: 'Review changes',
      message: { type: 'operational.open', sessionId, target: 'changes' } });
  const request = state.progress.request;
  if (request?.contextWindowTokens !== undefined && request.contextWindowTokens > 0 &&
      request.estimate.totalPromptTokens / request.contextWindowTokens >= 0.8)
    candidates.push({ id: 'inspect-context-pressure', label: `Last request ≈${String(Math.round(request.estimate.totalPromptTokens / request.contextWindowTokens * 100))}%`,
      message: { type: 'operational.open', sessionId, target: 'context' } });
  let remaining = columns;
  const visible = candidates.filter((item) => {
    const width = terminalTextWidth(item.label) + 4;
    if (width > remaining) return false;
    remaining -= width;
    return true;
  });
  if (visible.length === 0) return undefined;
  return row(visible.map((item) => button<CodingAgentTuiMessage>({
    id: item.id, label: item.label, onPress: () => item.message
  })), { id: 'operational-controls', sizes: visible.map(() => ({ kind: 'content' })) });
}

function recordedChanges(state: CodingAgentTuiState): number {
  return state.debug.changes.reduce((count, report) => count + report.changes.length, 0);
}

function compactRunStatus(state: CodingAgentTuiState): string {
  if (state.setup.status !== 'ready') return state.setup.status === 'initializing' ? 'Starting' : 'Setup';
  if (state.run.kind === 'waiting_for_approval') return 'Pending';
  if (state.run.kind === 'waiting_for_recovery')
    return state.run.suspension.reason === 'tool_outcome_unknown' || state.run.suspension.reason === 'provider_outcome_unknown'
      ? 'Unknown' : 'Paused';
  if (state.run.kind === 'working') return 'Working';
  return runStatus(state);
}

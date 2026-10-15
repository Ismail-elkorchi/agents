import {
  progressStatusFields,
  reasoningLabel,
  responsiveStatusline,
  suspensionPresentation,
  type StatusField
} from '@agent-core/tui';
import type { Element, InlineContent } from '@ismail-elkorchi/terminal-ui/components';
import { richText, text } from '@ismail-elkorchi/terminal-ui/components';
import type { CodingAgentTuiMessage } from './messages.js';
import { terminalPresentation } from './run-presentation.js';
import type { CodingAgentTuiState } from './state.js';

export function statusChrome(state: CodingAgentTuiState, columns: number): Element {
  return text({
    id: 'status',
    content: responsiveStatusline(
      columns < 90 ? 'Coding' : 'Coding Agent',
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
    {
      ...field('model', 'Model', modelSelectionLabel(state)),
      ...(state.runtimeDetails.modelId === undefined
        ? {}
        : { compactValue: state.runtimeDetails.modelId })
    },
    field('reasoning', 'Reasoning configuration', reasoningLabel(state.runtimeDetails.reasoning)),
    field(
      'mode',
      'Permissions',
      state.runtimeDetails.permissions === undefined
        ? undefined
        : state.runtimeDetails.permissions.mode === 'full_host'
          ? 'Full host'
          : 'Read only'
    ),
    field('trust', 'Workspace trust', state.runtimeDetails.workspaceTrust),
    field('status', 'Run status', runStatus(state)),
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

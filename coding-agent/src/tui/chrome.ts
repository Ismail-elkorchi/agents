import { progressStatusFields, reasoningLabel, statusline, type StatusField } from '@agent-core/tui';
import type { Element, InlineContent, StatusBarStatus } from '@ismail-elkorchi/terminal-ui/components';
import { richText, statusBar } from '@ismail-elkorchi/terminal-ui/components';
import type { CodingAgentTuiMessage } from './messages.js';
import { terminalPresentation } from './run-presentation.js';
import type { CodingAgentTuiState } from './state.js';

export function statusChrome(state: CodingAgentTuiState, columns: number): Element {
  const presentation = runPresentation(state);
  const preferences =
    columns < 80
      ? { ...state.preferences, statusline: state.preferences.statusline.filter((id) => id !== 'status') }
      : state.preferences;
  const center = statusline(preferences, codingStatusFields(state));
  const runText = state.conversation.unread
    ? 'New output · Ctrl+End'
    : columns < 80
      ? presentation.text
      : '';
  return statusBar({
    id: 'status',
    leading: [{ id: 'app', kind: 'text', text: columns < 80 ? 'Coding' : 'Coding Agent' }],
    center: center.length === 0 ? [] : [{ id: 'model-and-authority', kind: 'text', text: center }],
    trailing: [{ id: 'run', kind: 'status', text: runText, status: presentation.status }]
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
    field('model', 'Model', modelSelectionLabel(state)),
    field('reasoning', 'Reasoning configuration', reasoningLabel(state.runtimeDetails.reasoning)),
    field('mode', 'Permissions', state.runtimeDetails.permissions?.mode),
    field('trust', 'Workspace trust', state.runtimeDetails.workspaceTrust),
    field('status', 'Run status', runPresentation(state).text),
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
      : [show('composer submit', 'send'), show('commands', 'commands'), show('help', 'help')]
          .filter(Boolean)
          .join(' · ');
  return richText({ id: 'hints', segments: muted(text), wrap: false });
}

function runPresentation(state: CodingAgentTuiState): {
  readonly text: string;
  readonly status: StatusBarStatus;
} {
  if (state.setup.status === 'initializing') return { text: 'Initializing', status: 'running' };
  if (state.setup.status === 'setup_required') return { text: 'Setup required', status: 'warning' };
  switch (state.run.kind) {
    case 'idle':
      return { text: 'Idle', status: 'idle' };
    case 'working':
      return { text: state.run.label, status: 'running' };
    case 'waiting_for_approval':
      return { text: 'Approval required', status: 'warning' };
    case 'waiting_for_recovery':
      return { text: 'Run paused', status: 'warning' };
    case 'failed':
      return { text: 'Failed', status: 'error' };
    case 'ended': {
      const terminal = terminalPresentation(state.run.terminal);
      return { text: terminal.headline, status: terminal.status };
    }
  }
}

function muted(text: string): InlineContent {
  return [{ kind: 'text', text, style: { dim: true } }];
}

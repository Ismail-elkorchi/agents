import { richText, statusBar } from '@ismail-elkorchi/terminal-ui/components';
import type { Element, InlineContent, StatusBarStatus } from '@ismail-elkorchi/terminal-ui/components';
import type { CodingAgentTuiMessage } from './messages.js';
import type { CodingAgentTuiState } from './state.js';
import { terminalPresentation } from './run-presentation.js';

export function statusChrome(state: CodingAgentTuiState): Element {
  const presentation = runPresentation(state);
  const center = [modelSelectionLabel(state), permissionLabel(state)].filter((value): value is string => value !== undefined).join(' · ');
  const runText = [presentation.text, queueLabel(state), driverLabel(state)]
    .filter((value): value is string => value !== undefined)
    .join(' · ');
  return statusBar({
    id: 'status',
    leading: [{ id: 'app', kind: 'text', text: 'Coding Agent' }],
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

function driverLabel(state: CodingAgentTuiState): string | undefined {
  const activeRunId = state.debug.session?.activeRunId ?? state.debug.runId;
  const operation = activeRunId === undefined
    ? state.debug.operations.find((candidate) => candidate.state.phase.kind !== 'terminal')
    : state.debug.operations.find((candidate) => candidate.state.runId === activeRunId);
  if (operation === undefined) return undefined;
  const control = operation.state.control;
  if (control.status === 'detached') return 'driver detached';
  if (control.status === 'abort_requested') return 'abort requested';
  return `driver g${String(operation.state.driverGeneration)}`;
}

function permissionLabel(state: CodingAgentTuiState): string | undefined {
  const permissions = state.runtimeDetails.permissions;
  if (!permissions) return undefined;
  const write = permissions.workspaceWrite === 'structured' ? 'write structured' : 'write denied';
  const command = permissions.commandExecution === 'sandboxed' ? 'exec sandboxed' : 'exec denied';
  return `${permissions.mode}/${permissions.trust} · ${write} · ${command} · net/escape denied · ${String(permissions.tools.length)} tools`;
}

export function hintBar(state: CodingAgentTuiState, columns: number): Element<CodingAgentTuiMessage> {
  const text = state.run.kind === 'waiting_for_approval'
    ? 'Tab move · Enter choose · Esc deny'
    : columns < 50
      ? 'Ctrl+P commands'
      : 'Enter send · Ctrl+P commands · F1 help';
  return richText({ id: 'hints', segments: muted(text), wrap: false });
}

function runPresentation(state: CodingAgentTuiState): { readonly text: string; readonly status: StatusBarStatus } {
  if (state.setup.status === 'initializing') return { text: 'Initializing', status: 'running' };
  if (state.setup.status === 'setup_required') return { text: 'Setup required', status: 'warning' };
  switch (state.run.kind) {
    case 'idle': return { text: 'Idle', status: 'idle' };
    case 'working': return { text: state.run.label, status: 'running' };
    case 'waiting_for_approval': return { text: 'Approval required', status: 'warning' };
    case 'waiting_for_recovery': return { text: 'Recovery decision required', status: 'warning' };
    case 'failed': return { text: 'Failed', status: 'error' };
    case 'ended': {
      const terminal = terminalPresentation(state.run.terminal);
      return { text: terminal.headline, status: terminal.status };
    }
  }
}

function muted(text: string): InlineContent {
  return [{ kind: 'text', text, style: { dim: true } }];
}

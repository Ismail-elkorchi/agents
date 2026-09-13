import type { ShortcutAction } from '@agent-core/tui';
import type { CodingSubmissionResult } from '../application/contracts.js';
import type { CodingAgentTuiMessage } from './messages.js';

export interface InteractiveCommandChoice {
  readonly value: string;
  readonly description: string;
}

type ApplicationCommandName =
  | '/permissions'
  | '/trust'
  | '/temperature'
  | '/steer'
  | '/follow'
  | '/stop'
  | '/status'
  | '/debug';
export type InteractiveCommandName =
  | ApplicationCommandName
  | '/model'
  | '/provider'
  | '/login'
  | '/reasoning'
  | '/settings'
  | '/statusline'
  | '/sessions'
  | '/new'
  | '/name'
  | '/notes'
  | '/search'
  | '/attach'
  | '/drafts'
  | '/queue'
  | '/branches'
  | '/changes'
  | '/export'
  | '/source'
  | '/tools'
  | '/context'
  | '/processes'
  | '/editor'
  | '/recovery'
  | '/exit';
export type InteractiveCommandEntry = {
  readonly description: string;
  readonly value: 'none' | 'optional' | 'required';
  readonly choices?: readonly InteractiveCommandChoice[];
} & (
  | { readonly kind: 'application'; readonly name: ApplicationCommandName }
  | {
      readonly kind: 'interface';
      readonly name: InteractiveCommandName;
      readonly message: CodingAgentTuiMessage;
    }
);

export interface InteractiveCommandResult {
  readonly message: string;
  readonly action?: CodingAgentTuiMessage;
  readonly submission?: {
    readonly acceptance: Exclude<CodingSubmissionResult, { readonly kind: 'rejected' }>;
    readonly text: string;
  };
}

const action = (
  name: InteractiveCommandName,
  description: string,
  message: CodingAgentTuiMessage
): InteractiveCommandEntry => ({ kind: 'interface', name, description, message, value: 'none' });
const command = (
  name: ApplicationCommandName,
  description: string,
  value: InteractiveCommandEntry['value'],
  choices?: readonly InteractiveCommandChoice[]
): InteractiveCommandEntry => ({
  kind: 'application',
  name,
  description,
  value,
  ...(choices === undefined ? {} : { choices })
});

export const INTERACTIVE_COMMAND_REGISTRY = {
  '/model': action('/model', 'Choose provider, model and reasoning.', { type: 'configuration.open' }),
  '/provider': action('/provider', 'Choose provider and model.', { type: 'configuration.open' }),
  '/login': action('/login', 'Manage provider credentials.', { type: 'configuration.open' }),
  '/reasoning': action('/reasoning', 'Configure supported model reasoning.', {
    type: 'configuration.open'
  }),
  '/settings': action('/settings', 'Configure presentation.', { type: 'preferences.open' }),
  '/statusline': action('/statusline', 'Customize the status line and appearance.', {
    type: 'preferences.open'
  }),
  '/sessions': action('/sessions', 'Choose a saved conversation.', {
    type: 'panel.open',
    panel: 'sessions'
  }),
  '/name': action('/name', 'Name this conversation.', { type: 'session-name.open' }),
  '/new': action('/new', 'Start a new conversation.', { type: 'session.new' }),
  '/notes': action('/notes', 'Inspect model-authored notes.', { type: 'notes.open' }),
  '/search': action('/search', 'Search recorded conversation.', {
    type: 'overlay.open',
    overlay: 'search'
  }),
  '/attach': action('/attach', 'Add or inspect draft attachments.', { type: 'attachments.open' }),
  '/drafts': action('/drafts', 'Recall a prior prompt or recovered draft.', { type: 'recall.open' }),
  '/queue': action('/queue', 'Inspect, edit or cancel queued input.', {
    type: 'queue.open'
  }),
  '/branches': action('/branches', 'Branch recorded conversation history.', {
    type: 'panel.open',
    panel: 'branches'
  }),
  '/changes': action('/changes', 'Inspect recorded workspace changes.', {
    type: 'panel.open',
    panel: 'changes'
  }),
  '/export': action('/export', 'Export the loaded conversation pages locally.', {
    type: 'conversation.export'
  }),
  '/source': action('/source', 'Inspect original conversation source.', {
    type: 'inspector.open'
  }),
  '/tools': action('/tools', 'Toggle tool details.', { type: 'tools.toggle' }),
  '/processes': action('/processes', 'Inspect command processes, send input or terminate.', {
    type: 'processes.open'
  }),
  '/editor': action('/editor', 'Edit the draft in an external editor.', {
    type: 'composer.external-editor'
  }),
  '/recovery': action('/recovery', 'Review pending decisions and uncertain outcomes.', {
    type: 'recovery.open'
  }),
  '/exit': action('/exit', 'Close the terminal interface.', { type: 'application.exit' }),
  '/permissions': command('/permissions', 'Choose authority for new runs.', 'required', [
    { value: 'review', description: 'Read files inside the selected workspace.' },
    { value: 'edit', description: 'Also permit structured file changes.' },
    { value: 'develop', description: 'Also permit sandboxed command execution.' }
  ]),
  '/trust': command('/trust', 'Choose the workspace trust decision.', 'required', [
    { value: 'restricted', description: 'Request approval for every mutation and command.' },
    { value: 'trusted', description: 'Apply the selected permissions without per-operation approvals.' }
  ]),
  '/temperature': command('/temperature', 'Set supported provider temperature.', 'required'),
  '/steer': command('/steer', 'Steer the active run.', 'required'),
  '/follow': command('/follow', 'Queue a follow-up after active work.', 'required'),
  '/context': action('/context', 'Inspect effective context and available resources.', {
    type: 'context.open'
  }),
  '/stop': command('/stop', 'Interrupt active work.', 'optional'),
  '/status': command('/status', 'Inspect setup, configuration and session status.', 'none'),
  '/debug': command('/debug', 'Inspect runtime diagnostics.', 'none')
} satisfies Record<InteractiveCommandName, InteractiveCommandEntry>;

export const INTERACTIVE_COMMANDS: readonly InteractiveCommandEntry[] = Object.freeze(
  Object.values(INTERACTIVE_COMMAND_REGISTRY)
);

export function parseInteractiveCommandLine(
  line: string
):
  | { readonly kind: 'interface'; readonly message: CodingAgentTuiMessage }
  | { readonly kind: 'application'; readonly command: ApplicationCommandName; readonly value: string } {
  const trimmed = line.trim();
  const separator = trimmed.search(/\s/u);
  const name = separator < 0 ? trimmed : trimmed.slice(0, separator);
  const value = separator < 0 ? '' : trimmed.slice(separator).trim();
  const specification = INTERACTIVE_COMMANDS.find((entry) => entry.name === name);
  if (specification === undefined) throw new Error(`Unknown command: ${name}`);
  if (specification.value === 'required' && !value) throw new Error(`${name} requires a value.`);
  if (specification.value === 'none' && value) throw new Error(`${name} does not accept a value.`);
  return specification.kind === 'interface'
    ? { kind: 'interface', message: specification.message }
    : { kind: 'application', command: specification.name, value };
}

export const CODING_SHORTCUTS: readonly ShortcutAction[] = [
  {
    id: 'commands',
    label: 'Commands',
    bindings: ['commands', 'close-commands']
  },
  {
    id: 'notes',
    label: 'Model notes',
    bindings: ['Model notes', 'close-notes']
  },
  {
    id: 'tools',
    label: 'Tool output',
    bindings: ['tool-output']
  },
  {
    id: 'reasoning',
    label: 'Reasoning visibility',
    bindings: ['reasoning']
  },
  {
    id: 'search',
    label: 'Search history',
    bindings: ['search']
  },
  {
    id: 'editor',
    label: 'External editor',
    bindings: ['external-editor']
  }
];

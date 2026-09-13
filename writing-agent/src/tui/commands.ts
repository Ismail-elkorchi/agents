import type { ShortcutAction } from '@agent-core/tui';
import type { WritingTuiMessage } from './state.js';

export const WRITING_COMMANDS: readonly {
  readonly name: string;
  readonly description: string;
  readonly message: WritingTuiMessage;
}[] = [
  {
    name: '/statusline',
    description: 'Customize status line and appearance',
    message: { type: 'preferences.open' }
  },
  { name: '/settings', description: 'Customize presentation', message: { type: 'preferences.open' } },
  {
    name: '/model',
    description: 'Choose provider, model and reasoning',
    message: { type: 'configuration.open' }
  },
  {
    name: '/provider',
    description: 'Choose or authenticate a provider',
    message: { type: 'configuration.open' }
  },
  {
    name: '/login',
    description: 'Manage provider authentication',
    message: { type: 'configuration.open' }
  },
  { name: '/mode', description: 'Switch edit or review', message: { type: 'mode.toggle' } },
  {
    name: '/files',
    description: 'Browse workspace documents',
    message: { type: 'picker.open', subject: 'resources' }
  },
  {
    name: '/sessions',
    description: 'Search saved conversations',
    message: { type: 'picker.open', subject: 'sessions' }
  },
  {
    name: '/context',
    description: 'Inspect available context and admitted sources',
    message: { type: 'context.open' }
  },
  {
    name: '/status',
    description: 'Inspect configuration and session state',
    message: { type: 'status.open' }
  },
  {
    name: '/export',
    description: 'Export the loaded conversation pages locally',
    message: { type: 'conversation.export' }
  },
  {
    name: '/source',
    description: 'Inspect original messages, tool output and code',
    message: { type: 'inspector.open' }
  },
  {
    name: '/outline',
    description: 'Navigate document headings',
    message: { type: 'picker.open', subject: 'outline' }
  },
  {
    name: '/passage',
    description: 'Insert the selected document passage',
    message: { type: 'document.use-passage' }
  },
  {
    name: '/document',
    description: 'Show the opened document',
    message: { type: 'view', view: 'document' }
  },
  {
    name: '/conversation',
    description: 'Show the conversation',
    message: { type: 'view', view: 'conversation' }
  },
  {
    name: '/attach',
    description: 'Add or inspect draft attachments',
    message: { type: 'attachments.open' }
  },
  { name: '/queue', description: 'Inspect or revise pending inputs', message: { type: 'queue.open' } },
  { name: '/drafts', description: 'Recall a prior or recovered draft', message: { type: 'recall.open' } },
  { name: '/name', description: 'Name this conversation', message: { type: 'session-name.open' } },
  { name: '/new', description: 'Start a new conversation', message: { type: 'session.new' } },
  { name: '/notes', description: 'Inspect model-authored notes', message: { type: 'notes.open' } },
  { name: '/search', description: 'Search recorded history', message: { type: 'search.open' } },
  { name: '/recovery', description: 'Review pending decisions', message: { type: 'recovery.open' } },
  {
    name: '/editor',
    description: 'Edit the draft in an external editor',
    message: { type: 'external-editor' }
  },
  { name: '/tools', description: 'Toggle tool output', message: { type: 'tools.toggle' } },
  { name: '/reasoning', description: 'Configure model reasoning', message: { type: 'configuration.open' } },
  { name: '/stop', description: 'Interrupt active work', message: { type: 'interrupt' } },
  { name: '/exit', description: 'Close the terminal interface', message: { type: 'exit' } }
];

export const WRITING_SHORTCUTS: readonly ShortcutAction[] = [
  {
    id: 'commands',
    label: 'Commands',
    bindings: ['Commands', 'Close commands']
  },
  {
    id: 'notes',
    label: 'Model notes',
    bindings: ['Model notes', 'Close notes']
  },
  {
    id: 'tools',
    label: 'Tool output',
    bindings: ['Tool output']
  },
  {
    id: 'reasoning',
    label: 'Reasoning visibility',
    bindings: ['Reasoning']
  },
  {
    id: 'search',
    label: 'Search history',
    bindings: ['Search history']
  },
  {
    id: 'editor',
    label: 'External editor',
    bindings: ['External instruction editor']
  }
];

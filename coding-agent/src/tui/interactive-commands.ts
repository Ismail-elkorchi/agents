export interface InteractiveCommandChoice {
  readonly value: string;
  readonly description: string;
}

export interface InteractiveCommandEntry {
  readonly name: InteractiveCommandName;
  readonly description: string;
  readonly value: 'none' | 'optional' | 'required';
  readonly choices?: readonly InteractiveCommandChoice[];
}

export type InteractiveCommandName =
  | '/exit'
  | '/quit'
  | '/login'
  | '/provider'
  | '/model'
  | '/permissions'
  | '/trust'
  | '/temperature'
  | '/reasoning-effort'
  | '/steer'
  | '/follow'
  | '/compact'
  | '/abort'
  | '/status'
  | '/debug';

export interface InteractiveCommandResult {
  readonly message: string;
  readonly view?: 'debug';
}

const PROVIDERS = Object.freeze([
  choice('ollama', 'Local or self-hosted Ollama provider.'),
  choice('openrouter', 'OpenRouter API provider.'),
  choice('openai', 'OpenAI Platform API provider.'),
  choice('openai-codex', 'OpenAI Codex provider using ChatGPT subscription authentication.')
]);

const PERMISSION_MODES = Object.freeze([
  choice('review', 'Root-bound workspace reads only.'),
  choice('edit', 'Add structured workspace mutations.'),
  choice('develop', 'Add sandboxed command execution.')
]);

const WORKSPACE_TRUST_LEVELS = Object.freeze([
  choice('restricted', 'Require approval for every mutation and command.'),
  choice('trusted', 'Apply the selected permission mode without restricted-workspace approvals.')
]);

export const INTERACTIVE_COMMAND_REGISTRY = {
  '/provider': command('/provider', 'Select the model provider.', 'required', PROVIDERS),
  '/model': command('/model', 'Select the provider model for new submissions.', 'required'),
  '/login': command('/login', 'Authenticate an account used for model access.', 'optional', PROVIDERS),
  '/permissions': command('/permissions', 'Select the permission mode for new runs.', 'required', PERMISSION_MODES),
  '/trust': command('/trust', 'Set the workspace trust level.', 'required', WORKSPACE_TRUST_LEVELS),
  '/temperature': command('/temperature', 'Set provider temperature for new submissions.', 'required'),
  '/reasoning-effort': command('/reasoning-effort', 'Set provider reasoning effort for new submissions.', 'required'),
  '/steer': command('/steer', 'Steer the active run.', 'required'),
  '/follow': command('/follow', 'Queue a follow-up after current work.', 'required'),
  '/compact': command('/compact', 'Summarize stable session history for future turns.', 'none'),
  '/abort': command('/abort', 'Abort the active run.', 'optional'),
  '/status': command('/status', 'Show interactive setup and session status.', 'none'),
  '/debug': command('/debug', 'Inspect detailed interactive and session state.', 'none'),
  '/exit': command('/exit', 'Exit the interactive surface.', 'none'),
  '/quit': command('/quit', 'Exit the interactive surface.', 'none')
} satisfies Record<InteractiveCommandName, InteractiveCommandEntry>;

export const INTERACTIVE_COMMANDS: readonly InteractiveCommandEntry[] = Object.freeze(Object.values(INTERACTIVE_COMMAND_REGISTRY));

export function parseInteractiveCommandLine(commandLine: string): { readonly command: InteractiveCommandName; readonly value: string } {
  const [commandName, ...rest] = commandLine.trim().split(/\s+/);
  const value = rest.join(' ').trim();
  if (!isInteractiveCommandName(commandName)) throw new Error(`Unknown interactive command: ${commandName ?? ''}`);
  const specification = INTERACTIVE_COMMAND_REGISTRY[commandName];
  if (specification.value === 'required' && value.length === 0) throw new Error(`${commandName} requires a value.`);
  if (specification.value === 'none' && value.length > 0) throw new Error(`${commandName} does not accept a value.`);
  return { command: commandName, value };
}

function command(
  name: InteractiveCommandName,
  description: string,
  value: InteractiveCommandEntry['value'],
  choices?: readonly InteractiveCommandChoice[]
): InteractiveCommandEntry {
  return Object.freeze({ name, description, value, ...(choices === undefined ? {} : { choices }) });
}

function choice(value: string, description: string): InteractiveCommandChoice {
  return Object.freeze({ value, description });
}

function isInteractiveCommandName(value: string | undefined): value is InteractiveCommandName {
  return INTERACTIVE_COMMANDS.some((commandEntry) => commandEntry.name === value);
}

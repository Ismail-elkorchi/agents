export type CodingPermissionMode = 'read_only' | 'full_host';

export interface CodingAuthority {
  readonly mode: CodingPermissionMode;
  readonly enabledTools: readonly string[];
  readonly verificationCommands: boolean;
  readonly permissions: {
    readonly mode: CodingPermissionMode;
    readonly workspaceRead: 'root_bound';
    readonly workspaceWrite: 'denied' | 'structured';
    readonly commandExecution: 'denied' | 'host';
    readonly network: 'denied' | 'configured_tools' | 'host';
    readonly hostEscape: 'denied' | 'allowed';
    readonly tools: readonly string[];
  };
}

const READ_TOOLS = Object.freeze([
  'list_directory',
  'find_files',
  'read_files',
  'search_text',
  'view_image',
  'read_artifact'
]);
const LOCAL_WORK_TOOLS = Object.freeze([
  'apply_patch',
  'edit_text',
  'exec_command',
  'write_stdin',
  'stop_process'
]);
const WORK_TOOLS = Object.freeze([...READ_TOOLS, ...LOCAL_WORK_TOOLS]);
export const CODING_AGENT_TOOLS = WORK_TOOLS;

export function isCodingWorkspaceMutatingTool(name: string): boolean {
  return LOCAL_WORK_TOOLS.includes(name) || name === 'run_check';
}

export function resolveCodingAuthority(input: {
  readonly requestedMode: CodingPermissionMode;
  readonly enabledTools?: readonly string[];
  readonly hasVerificationChecks: boolean;
  readonly configuredNetworkTools?: boolean;
}): CodingAuthority {
  const mode = input.requestedMode;
  const available = mode === 'read_only' ? READ_TOOLS : WORK_TOOLS;
  const enabledTools = Object.freeze(
    input.enabledTools === undefined
      ? [...available]
      : available.filter((name) => input.enabledTools?.includes(name))
  );
  const verificationCommands = mode !== 'read_only' && input.hasVerificationChecks;
  return Object.freeze({
    mode,
    enabledTools,
    verificationCommands,
    permissions: Object.freeze({
      mode,
      workspaceRead: 'root_bound',
      workspaceWrite: mode === 'read_only' ? 'denied' : 'structured',
      commandExecution: mode === 'read_only' ? 'denied' : 'host',
      network: mode === 'full_host' ? 'host' : input.configuredNetworkTools ? 'configured_tools' : 'denied',
      hostEscape: mode === 'full_host' ? 'allowed' : 'denied',
      tools: Object.freeze([...enabledTools, ...(verificationCommands ? ['run_check'] : [])])
    })
  });
}

export function parseCodingPermissionMode(
  value: unknown,
  label = 'permission mode'
): CodingPermissionMode {
  if (value === 'read_only' || value === 'full_host') return value;
  throw new Error(`${label} must be read_only or full_host.`);
}

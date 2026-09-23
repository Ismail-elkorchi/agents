import type { ToolPolicy, ToolRisk } from '@agent-core/tools';

export type CodingPermissionMode = 'read_only' | 'sandbox' | 'full_host';

export interface CodingAuthority {
  readonly mode: CodingPermissionMode;
  readonly toolPolicy: ToolPolicy;
  readonly enabledTools: readonly string[];
  readonly verificationCommands: boolean;
  readonly permissions: {
    readonly mode: CodingPermissionMode;
    readonly workspaceRead: 'root_bound';
    readonly workspaceWrite: 'denied' | 'structured';
    readonly commandExecution: 'denied' | 'sandboxed' | 'host';
    readonly network: 'denied' | 'host';
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
const WORK_TOOLS = Object.freeze([
  ...READ_TOOLS,
  'apply_patch',
  'exec_command',
  'write_stdin',
  'stop_process'
]);
export const CODING_AGENT_TOOLS = WORK_TOOLS;

export function resolveCodingAuthority(input: {
  readonly requestedMode: CodingPermissionMode;
  readonly enabledTools?: readonly string[];
  readonly hasVerificationChecks: boolean;
}): CodingAuthority {
  const mode = input.requestedMode;
  const available = mode === 'read_only' ? READ_TOOLS : WORK_TOOLS;
  const enabledTools = Object.freeze(
    input.enabledTools === undefined
      ? [...available]
      : available.filter((name) => input.enabledTools?.includes(name))
  );
  const allowedRisks: readonly ToolRisk[] =
    mode === 'read_only' ? ['read'] : ['read', 'write', 'destructive', 'execute'];
  const verificationCommands = mode !== 'read_only' && input.hasVerificationChecks;
  return Object.freeze({
    mode,
    toolPolicy: Object.freeze({ allowedRisks: Object.freeze(allowedRisks) }),
    enabledTools,
    verificationCommands,
    permissions: Object.freeze({
      mode,
      workspaceRead: 'root_bound',
      workspaceWrite: mode === 'read_only' ? 'denied' : 'structured',
      commandExecution:
        mode === 'read_only' ? 'denied' : mode === 'sandbox' ? 'sandboxed' : 'host',
      network: mode === 'full_host' ? 'host' : 'denied',
      hostEscape: mode === 'full_host' ? 'allowed' : 'denied',
      tools: Object.freeze([
        ...enabledTools,
        ...(verificationCommands ? ['run_check'] : [])
      ])
    })
  });
}

export function parseCodingPermissionMode(
  value: unknown,
  label = 'permission mode'
): CodingPermissionMode {
  if (value === 'read_only' || value === 'sandbox' || value === 'full_host') return value;
  throw new Error(`${label} must be read_only, sandbox, or full_host.`);
}

import type { ToolPolicy, ToolRisk } from '@agent-core/tools';
import type { WorkspaceTrustLevel } from './workspace-trust.js';

export type CodingPermissionMode = 'review' | 'edit' | 'develop';
export type CodingApprovalKind = 'write' | 'delete' | 'command';

export interface CodingPermissionConfiguration {
  readonly maximumMode: CodingPermissionMode;
  readonly requireApprovalFor: readonly CodingApprovalKind[];
}

export interface CodingAuthority {
  readonly mode: CodingPermissionMode;
  readonly toolPolicy: ToolPolicy;
  readonly enabledTools: readonly string[];
  readonly verificationCommands: 'disabled' | 'sandboxed';
  readonly requiredApprovals: readonly CodingApprovalKind[];
  readonly permissions: {
    readonly mode: CodingPermissionMode;
    readonly trust: Exclude<WorkspaceTrustLevel, 'untrusted'>;
    readonly workspaceRead: 'root_bound';
    readonly workspaceWrite: 'denied' | 'structured';
    readonly commandExecution: 'denied' | 'sandboxed';
    readonly network: 'denied';
    readonly hostEscape: 'denied';
    readonly tools: readonly string[];
  };
}

const READ_TOOLS = Object.freeze([
  'list_directory', 'find_files', 'read_files', 'search_text', 'view_image', 'read_artifact'
]);
const EDIT_TOOLS = Object.freeze([...READ_TOOLS, 'apply_patch']);
const DEVELOP_TOOLS = Object.freeze([...EDIT_TOOLS, 'exec_command', 'write_stdin', 'stop_process']);
export const CODING_AGENT_TOOLS = DEVELOP_TOOLS;

export function resolveCodingAuthority(input: {
  readonly requestedMode: CodingPermissionMode;
  readonly trust: Exclude<WorkspaceTrustLevel, 'untrusted'>;
  readonly project?: {
    readonly permissions: CodingPermissionConfiguration;
    readonly enabledTools: readonly string[];
  };
  readonly hasVerificationChecks: boolean;
}): CodingAuthority {
  const maximum = input.project?.permissions.maximumMode ?? 'develop';
  const mode = lesserMode(input.requestedMode, maximum);
  const ceiling = toolsForMode(mode);
  const project = input.project;
  const selected = project
    ? ceiling.filter((name) => project.enabledTools.includes(name))
    : ceiling;
  const enabledTools = Object.freeze([...selected]);
  const allowedRisks: ToolRisk[] = mode === 'review'
    ? ['read']
    : mode === 'edit'
      ? ['read', 'write', 'destructive']
      : ['read', 'write', 'destructive', 'execute'];
  const configuredApprovals = input.project?.permissions.requireApprovalFor ?? [];
  const requiredApprovals = new Set<CodingApprovalKind>(configuredApprovals);
  if (input.trust === 'restricted') {
    if (mode !== 'review') {
      requiredApprovals.add('write');
      requiredApprovals.add('delete');
    }
    if (mode === 'develop') requiredApprovals.add('command');
  }
  const verificationCommands = input.hasVerificationChecks && mode === 'develop' ? 'sandboxed' : 'disabled';
  const commandAvailable = verificationCommands === 'sandboxed'
    || enabledTools.some((name) => name === 'exec_command' || name === 'write_stdin' || name === 'stop_process');
  return Object.freeze({
    mode,
    toolPolicy: Object.freeze({ allowedRisks: Object.freeze(allowedRisks) }),
    enabledTools,
    verificationCommands,
    requiredApprovals: Object.freeze([...requiredApprovals]),
    permissions: Object.freeze({
      mode,
      trust: input.trust,
      workspaceRead: 'root_bound',
      workspaceWrite: mode === 'review' ? 'denied' : 'structured',
      commandExecution: commandAvailable ? 'sandboxed' : 'denied',
      network: 'denied',
      hostEscape: 'denied',
      tools: enabledTools
    })
  });
}

export function parseCodingPermissionMode(value: unknown, label = 'permission mode'): CodingPermissionMode {
  if (value === 'review' || value === 'edit' || value === 'develop') return value;
  throw new Error(`${label} must be review, edit, or develop.`);
}

export function parseCodingApprovalKinds(value: unknown): readonly CodingApprovalKind[] {
  if (!Array.isArray(value)) {
    throw new Error('Permission approvals must contain only write, delete, or command.');
  }
  const approvals: CodingApprovalKind[] = [];
  for (const item of value as readonly unknown[]) {
    if (!isCodingApprovalKind(item)) {
      throw new Error('Permission approvals must contain only write, delete, or command.');
    }
    approvals.push(item);
  }
  if (new Set(approvals).size !== approvals.length) throw new Error('Permission approvals must be unique.');
  return Object.freeze(approvals);
}

function isCodingApprovalKind(value: unknown): value is CodingApprovalKind {
  return value === 'write' || value === 'delete' || value === 'command';
}

function toolsForMode(mode: CodingPermissionMode): readonly string[] {
  return mode === 'review' ? READ_TOOLS : mode === 'edit' ? EDIT_TOOLS : DEVELOP_TOOLS;
}

function lesserMode(left: CodingPermissionMode, right: CodingPermissionMode): CodingPermissionMode {
  const rank: Record<CodingPermissionMode, number> = { review: 0, edit: 1, develop: 2 };
  return rank[left] <= rank[right] ? left : right;
}

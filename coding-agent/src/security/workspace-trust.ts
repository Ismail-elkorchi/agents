import type { ToolEffects } from '@agent-core/tools';
import type { CodingWorkspaceIdentity } from './workspace-identity.js';

export type WorkspaceTrustLevel = 'untrusted' | 'restricted' | 'trusted';
export type WorkspaceAction =
  | 'inspect_metadata'
  | 'inspect_selected_content'
  | 'provider_egress'
  | 'workspace_read'
  | 'workspace_mutation'
  | 'command_execution'
  | 'network_access'
  | 'watcher_activation'
  | 'project_guidance'
  | 'project_execution_policy';

export type WorkspaceActionDecision =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'approval_required'; readonly reason: string }
  | { readonly kind: 'blocked'; readonly reason: string };

export interface WorkspaceTrustDecision {
  readonly workspace: CodingWorkspaceIdentity;
  readonly level: WorkspaceTrustLevel;
  readonly decidedBy: { readonly kind: 'user' | 'organization'; readonly subject: string };
  readonly decidedAt: string;
}

export function decideWorkspaceAction(level: WorkspaceTrustLevel, action: WorkspaceAction): WorkspaceActionDecision {
  if (action === 'inspect_metadata' || action === 'inspect_selected_content') return Object.freeze({ kind: 'allowed' });
  if (level === 'untrusted') return Object.freeze({ kind: 'blocked', reason: 'The workspace has not been admitted for model or effectful use.' });
  if (action === 'project_execution_policy' && level !== 'trusted') {
    return Object.freeze({ kind: 'blocked', reason: 'Repository execution policy is inactive until the workspace is trusted.' });
  }
  if (level === 'restricted' && (action === 'workspace_mutation' || action === 'command_execution' || action === 'network_access' || action === 'watcher_activation')) {
    return Object.freeze({ kind: 'approval_required', reason: `Restricted workspaces require explicit approval for ${action.replaceAll('_', ' ')}.` });
  }
  return Object.freeze({ kind: 'allowed' });
}

export function decideToolEffects(level: WorkspaceTrustLevel, effects: ToolEffects): WorkspaceActionDecision {
  let result: WorkspaceActionDecision = Object.freeze({ kind: 'allowed' });
  for (const access of effects.accesses) {
    if (access.mode === 'read' && isSensitiveWorkspaceScope(access.scope)) {
      return Object.freeze({ kind: 'blocked', reason: 'The requested path is excluded by the default sensitive-workspace policy.' });
    }
    const action: WorkspaceAction = access.mode === 'read' ? 'workspace_read'
      : access.mode === 'execute' ? 'command_execution'
        : access.mode === 'network' ? 'network_access'
          : 'workspace_mutation';
    const decision = decideWorkspaceAction(level, action);
    if (decision.kind === 'blocked') return decision;
    if (decision.kind === 'approval_required') result = decision;
  }
  return result;
}

export function isSensitiveWorkspacePath(workspacePath: string): boolean {
  const names = workspacePath.split('/');
  return names.some((name) => name === '.git' || name === '.ssh' || name === '.gnupg' || name === '.npmrc' || name === '.pypirc' || name === '.netrc'
    || name === 'credentials' || name === 'secrets' || name === '.env' || name.startsWith('.env.') || /(?:^|[._-])(?:private[_-]?key|credentials|secrets?)(?:[._-]|$)/iu.test(name)
    || /\.(?:pem|p12|pfx|key)$/iu.test(name));
}

function isSensitiveWorkspaceScope(scope: string): boolean {
  const prefix = 'workspace/files/';
  return scope.startsWith(prefix) && isSensitiveWorkspacePath(scope.slice(prefix.length));
}

export function createTrustDecision(input: {
  readonly workspace: CodingWorkspaceIdentity;
  readonly level: WorkspaceTrustLevel;
  readonly actorKind: 'user' | 'organization';
  readonly actor: string;
  readonly now?: Date;
}): WorkspaceTrustDecision {
  const actor = input.actor.trim();
  if (actor.length === 0) throw new TypeError('Workspace trust decisions require an identified owner.');
  return Object.freeze({
    workspace: Object.freeze({ ...input.workspace }),
    level: input.level,
    decidedBy: Object.freeze({ kind: input.actorKind, subject: actor }),
    decidedAt: (input.now ?? new Date()).toISOString()
  });
}

import type {
  AgentApprovalSuspension,
  AgentSessionEvent,
  AgentSessionState
} from '@agent-core/runtime';
import type { CodingHandoff } from '../changes/coding-handoff.js';
import type { CodingAgentTuiHydration } from './hydration.js';
import type { InteractiveCommandResult } from './interactive-commands.js';
import type { CodingAgentTuiRuntimeDetails } from './state.js';

export type CodingAgentSetupRequirement = 'workspace_trust' | 'provider' | 'model';

export interface CodingAgentInteractiveState {
  readonly status: 'initializing' | 'setup_required' | 'ready';
  readonly requirements: readonly CodingAgentSetupRequirement[];
  readonly runtimeDetails: CodingAgentTuiRuntimeDetails;
  readonly session?: AgentSessionState;
}

export type CodingAgentInteractiveEvent =
  | AgentSessionEvent
  | { readonly type: 'interactive.state.changed'; readonly state: CodingAgentInteractiveState }
  | { readonly type: 'interactive.notice'; readonly message: string; readonly tone?: 'info' | 'warning' | 'error' }
  | { readonly type: 'session.hydrated'; readonly hydration: CodingAgentTuiHydration }
  | { readonly type: 'handoff.ready'; readonly handoff: CodingHandoff };

export interface CodingAgentInteractiveController {
  state(): CodingAgentInteractiveState;
  subscribe(listener: (event: CodingAgentInteractiveEvent) => void | Promise<void>): () => void;
  start(): Promise<void>;
  submit(task: string): Promise<InteractiveCommandResult>;
  execute(commandLine: string): InteractiveCommandResult | Promise<InteractiveCommandResult>;
  resolveApproval(suspension: AgentApprovalSuspension, decision: 'allow' | 'deny'): Promise<void>;
  close(): Promise<void>;
}

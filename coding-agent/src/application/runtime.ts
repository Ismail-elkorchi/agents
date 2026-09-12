import { type ModelProvider, type ModelReasoningEffort, type ModelReasoningRequest } from '@agent-core/model';
import { OllamaProvider } from '@agent-core/provider-ollama';
import { OpenAIProvider } from '@agent-core/provider-openai';
import { OpenAICodexProvider, type OpenAICodexTransport } from '@agent-core/provider-openai-codex';
import { OpenRouterProvider } from '@agent-core/provider-openrouter';
import { type AgentSession, type SessionBindingInput, type SessionDescriptor } from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
import { readRunChangeReport } from '../changes/run-change-report.js';
import {
  isCodingAgentProviderId,
  loadCodingAgentConfiguration,
  type CodingAgentConfiguration,
  type CodingAgentProviderId
} from '../configuration.js';
import { type CodingPermissionMode } from '../security/permission-mode.js';
import { readConfiguredCheckResults } from '../verification/configured-check-tool.js';
import { createCodingSession, type CodingSessionComposition } from '../session.js';
import { type CodingAgentModelSelection } from '../state/model-selection-store.js';
import { codingWorkspaceSessionBinding, type OpenCodingWorkspace } from '../workspace.js';
import type { CodingRuntimeDetails } from './contracts.js';
import { parseReasoningEffort } from './input.js';

export type SessionSelection =
  | { readonly kind: 'new' }
  | { readonly kind: 'latest' }
  | { readonly kind: 'existing'; readonly id: string };

export interface CodingApplicationOptions {
  root: string;
  provider?: CodingAgentProviderId;
  model?: string;
  providerEndpoint?: string;
  codexTransport?: OpenAICodexTransport;
  maxOutputTokens?: number;
  permissionMode: CodingPermissionMode;
  sessionSelection: SessionSelection;
  branch?: string;
  temperature?: number;
  reasoning?: ModelReasoningRequest;
  config?: string;
  stateRoot?: string;
  configuration?: CodingAgentConfiguration;
  configurationSource?: {
    readonly sourceUri: string;
    readonly sha256: string;
    readonly trustLevel: 'restricted' | 'trusted';
  };
}

export interface ModelProviderBinding {
  provider: ModelProvider;
  providerId: CodingAgentProviderId;
  model: string;
}

export interface ResolvedSessionSettings {
  readonly provider: CodingAgentProviderId;
  readonly model: string;
  readonly providerEndpoint?: string;
  readonly codexTransport?: OpenAICodexTransport;
  readonly temperature?: number;
  readonly reasoning?: ModelReasoningRequest;
}

export interface RuntimeSettingsSelection {
  readonly provider?: CodingAgentProviderId;
  readonly model?: string;
  readonly providerEndpoint?: string;
  readonly codexTransport?: OpenAICodexTransport;
  readonly temperature?: number;
  readonly reasoning?: ModelReasoningRequest;
}

export interface PersistedModelSettings {
  readonly provider?: string;
  readonly model?: string;
  readonly temperature?: number;
  readonly reasoningEffort?: string;
}

export interface CodingAgentRuntimeComposition extends CodingSessionComposition {
  readonly details: CodingRuntimeDetails;
}

export async function persistedModelSettings(
  repository: JsonlSessionRepository,
  session: SessionDescriptor
): Promise<PersistedModelSettings> {
  const replay = await repository.loadReplayState(session);
  const latest = [...replay.branch].reverse().find((entry) => entry.type === 'model_settings');
  return (
    latest ?? {
      ...(session.header.provider ? { provider: session.header.provider } : {}),
      ...(session.header.model ? { model: session.header.model } : {})
    }
  );
}

export function resolveRuntimeSettingsSelection(
  options: CodingApplicationOptions,
  persisted: PersistedModelSettings | undefined,
  projectExecutionPolicy: boolean,
  stored?: CodingAgentModelSelection
): RuntimeSettingsSelection {
  const persistedProvider = persisted?.provider;
  const projectConfiguration = projectExecutionPolicy ? options.configuration : undefined;
  const provider =
    options.provider ??
    (persistedProvider ? parseProviderId(persistedProvider) : undefined) ??
    projectConfiguration?.provider ??
    stored?.provider ??
    (process.env.CODING_AGENT_PROVIDER ? parseProviderId(process.env.CODING_AGENT_PROVIDER) : undefined);
  const persistedMatches = provider !== undefined && persistedProvider === provider;
  const storedMatches = provider !== undefined && stored?.provider === provider;
  const projectMatches = projectConfiguration !== undefined && projectConfiguration.provider === provider;
  const model =
    options.model ??
    (persistedMatches ? persisted?.model : undefined) ??
    (projectMatches ? projectConfiguration.model : undefined) ??
    (storedMatches ? stored.model : undefined) ??
    process.env.CODING_AGENT_MODEL;
  const normalizedModel = model?.trim();
  const persistedSettingsMatch = persistedMatches && persisted?.model === normalizedModel;
  const configurationSettingsMatch = projectMatches && projectConfiguration.model === normalizedModel;
  const persistedReasoning =
    persistedSettingsMatch && persisted?.reasoningEffort
      ? reasoningFromEffort(
          parseReasoningEffort(persisted.reasoningEffort, 'persisted session reasoning effort')
        )
      : undefined;
  const providerEndpoint = options.providerEndpoint ?? process.env.CODING_AGENT_PROVIDER_ENDPOINT;
  const temperature = options.temperature ?? (persistedSettingsMatch ? persisted?.temperature : undefined);
  const reasoning =
    options.reasoning ??
    persistedReasoning ??
    (configurationSettingsMatch ? projectConfiguration.reasoning : undefined) ??
    (process.env.CODING_AGENT_REASONING_EFFORT
      ? reasoningFromEffort(
          parseReasoningEffort(process.env.CODING_AGENT_REASONING_EFFORT, 'CODING_AGENT_REASONING_EFFORT')
        )
      : undefined);
  if (options.codexTransport !== undefined && provider !== undefined && provider !== 'openai-codex') {
    throw new Error('--codex-transport requires provider openai-codex.');
  }
  return Object.freeze({
    ...(provider === undefined ? {} : { provider }),
    ...(normalizedModel === undefined || normalizedModel.length === 0 ? {} : { model: normalizedModel }),
    ...(providerEndpoint === undefined ? {} : { providerEndpoint }),
    ...(options.codexTransport === undefined ? {} : { codexTransport: options.codexTransport }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(reasoning === undefined ? {} : { reasoning })
  });
}

export function requireIdleSession(agent: AgentSession): void {
  const state = agent.state();
  if (state.phase !== 'idle' || state.queuedInputs > 0) {
    throw new Error(
      'Provider, model, permission mode, and workspace trust can change only when the session is idle with no queued submissions.'
    );
  }
}

export async function readCodingSessionView(runtime: CodingAgentRuntimeComposition) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const before = runtime.agent.state();
    const [history, inspection, branchPoints] = await Promise.all([
      readCodingHistoryPage(runtime),
      runtime.agent.inspect(),
      runtime.sessions.listBranchPoints(runtime.session)
    ]);
    const session = runtime.agent.state();
    if (JSON.stringify(before) !== JSON.stringify(session)) continue;
    const runs = [...inspection.runs];
    if (session.activeRunId !== undefined && !runs.some((run) => run.state.runId === session.activeRunId))
      runs.push(await runtime.runs.inspect(session.activeRunId));
    return { session, ...history, branchPoints, pendingSubmissions: inspection.pendingSubmissions, runs };
  }
  throw new Error('Session scheduling changed during the read; request a fresh session view.');
}

export async function readCodingHistoryPage(
  runtime: CodingAgentRuntimeComposition,
  request?: Parameters<JsonlSessionRepository['readBranchPage']>[1]
) {
  const history = await runtime.sessions.readBranchPage(runtime.session, request);
  const runIds = [...new Set(history.entries.flatMap((entry) => ('runId' in entry ? [entry.runId] : [])))];
  const [changes, verification] = await Promise.all([
    Promise.all(
      runIds.map((runId) => readRunChangeReport(runtime.events, runId, runtime.workspaceRoot))
    ),
    Promise.all(
      runIds.map((runId) => readConfiguredCheckResults(runtime.events, runId, runtime.configuration))
    )
  ]);
  return { history, changes, verification };
}

export async function createRuntime(
  options: CodingApplicationOptions,
  openedWorkspace: OpenCodingWorkspace,
  persistedSessionId?: string
): Promise<CodingAgentRuntimeComposition> {
  const workspace = openedWorkspace.layout;
  const sessions = new JsonlSessionRepository({ rootDir: workspace.sessionsDir });
  const binding = codingWorkspaceSessionBinding(workspace.identity);
  let session = await selectSession(options, sessions, binding, persistedSessionId);
  const persistedSettings = session ? await persistedModelSettings(sessions, session) : undefined;
  const projectExecutionPolicy =
    openedWorkspace.security.decide('project_execution_policy').kind === 'allowed';
  const settings = resolveRuntimeSettings(options, persistedSettings, projectExecutionPolicy);
  const providerRuntime = createProviderRuntime(settings);
  session ??= await sessions.create({
    binding,
    provider: providerRuntime.providerId,
    model: providerRuntime.model
  });
  const composition = await createCodingSession({
    workspace: openedWorkspace,
    provider: providerRuntime.provider,
    descriptor: session,
    settings: {
      provider: settings.provider,
      model: settings.model,
      ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
      ...(settings.reasoning === undefined ? {} : { reasoning: settings.reasoning })
    },
    permissionMode: options.permissionMode,
    ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
    ...(options.configuration === undefined ? {} : { configuration: options.configuration }),
    ...(options.configurationSource === undefined ? {} : { configurationSource: options.configurationSource })
  });
  if (options.branch) await composition.agent.branchFrom(options.branch, 'cli branch');
  return {
    ...composition,
    details: {
      providerId: providerRuntime.providerId,
      modelId: providerRuntime.model,
      ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
      ...(settings.reasoning?.strategy === 'effort' ? { reasoningEffort: settings.reasoning.effort } : {}),
      sessionLocation: sessions.location(session.id),
      permissions: composition.permissions
    }
  };
}

export function admittedTrustLevel(
  value: OpenCodingWorkspace['security']['trustLevel']
): 'restricted' | 'trusted' {
  if (value === 'restricted' || value === 'trusted') return value;
  throw new Error('Runtime creation requires an admitted workspace.');
}

export function createProviderRuntime(options: ResolvedSessionSettings): ModelProviderBinding {
  const model = options.model;
  switch (options.provider) {
    case 'ollama':
      return {
        providerId: 'ollama',
        model,
        provider: new OllamaProvider({
          model,
          ...(options.providerEndpoint ? { host: options.providerEndpoint } : {})
        })
      };
    case 'openrouter':
      return {
        providerId: 'openrouter',
        model,
        provider: new OpenRouterProvider({
          model,
          ...(options.providerEndpoint ? { baseUrl: options.providerEndpoint } : {})
        })
      };
    case 'openai':
      return {
        providerId: 'openai',
        model,
        provider: new OpenAIProvider({
          model,
          ...(options.providerEndpoint ? { baseUrl: options.providerEndpoint } : {})
        })
      };
    case 'openai-codex':
      return {
        providerId: 'openai-codex',
        model,
        provider: new OpenAICodexProvider({
          model,
          ...(options.providerEndpoint ? { baseUrl: options.providerEndpoint } : {}),
          ...(options.codexTransport ? { transport: options.codexTransport } : {})
        })
      };
  }
}

export function parseProviderId(value: string): CodingAgentProviderId {
  if (isCodingAgentProviderId(value)) return value;
  throw new Error(
    `Unsupported provider: ${value}. Supported providers: ollama, openrouter, openai, openai-codex.`
  );
}

export async function loadProjectConfiguration(
  workspace: OpenCodingWorkspace,
  explicitPath: string | undefined
) {
  const configurationPath = explicitPath ?? 'coding-agent.config.json';
  if (explicitPath === undefined) {
    const status = await workspace.fileRoot.inspectPath(configurationPath);
    if (status.kind === 'absent') return undefined;
    if (status.kind !== 'file')
      throw new Error(`Optional project configuration is not a regular file: ${configurationPath}`);
  }
  return loadCodingAgentConfiguration(workspace.fileRoot, workspace.security, configurationPath);
}

export async function selectSession(
  options: CodingApplicationOptions,
  repository: JsonlSessionRepository,
  binding: SessionBindingInput,
  persistedSessionId?: string
): Promise<SessionDescriptor | undefined> {
  let session: SessionDescriptor | undefined;
  if (persistedSessionId !== undefined) {
    session = await repository.open(persistedSessionId, binding);
  } else if (options.sessionSelection.kind === 'existing') {
    session = await repository.open(options.sessionSelection.id, binding);
  } else if (options.sessionSelection.kind === 'latest') {
    const latest = (await repository.list())[0];
    if (latest === undefined) throw new Error('No existing session is available to resume.');
    session = await repository.open(latest.id, binding);
  }
  if (!session && options.branch) throw new Error('--branch requires an existing session.');
  return session;
}

export function resolveRuntimeSettings(
  options: CodingApplicationOptions,
  persisted: PersistedModelSettings | undefined,
  projectExecutionPolicy: boolean
): ResolvedSessionSettings {
  const candidate = resolveRuntimeSettingsSelection(options, persisted, projectExecutionPolicy);
  const provider = candidate.provider;
  if (provider === undefined)
    throw new Error(
      'No model provider is configured. Use --provider, resume a configured session, set CODING_AGENT_PROVIDER, or trust a project configuration.'
    );
  const model = candidate.model;
  if (model === undefined)
    throw new Error(
      'No model is configured. Use --model, resume a configured session, set CODING_AGENT_MODEL, or trust a project configuration.'
    );
  return Object.freeze({
    provider,
    model,
    ...(candidate.providerEndpoint === undefined ? {} : { providerEndpoint: candidate.providerEndpoint }),
    ...(candidate.codexTransport === undefined ? {} : { codexTransport: candidate.codexTransport }),
    ...(candidate.temperature === undefined ? {} : { temperature: candidate.temperature }),
    ...(candidate.reasoning === undefined ? {} : { reasoning: candidate.reasoning })
  });
}

export function reasoningFromEffort(effort: ModelReasoningEffort): ModelReasoningRequest {
  return effort === 'none' ? { strategy: 'disabled' } : { strategy: 'effort', effort };
}

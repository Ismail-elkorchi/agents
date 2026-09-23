import { CompleteRequestEstimator, type ModelProvider } from '@agent-core/model';
import { JsonlEventRepository, LocalArtifactRepository } from '@agent-core/persistence/node';
import {
  AgentRunCoordinator,
  AgentRuntime,
  AgentSession,
  ContextService,
  HistoryReader,
  InferenceService,
  agentEventCodec,
  createContextTools,
  createHistoryTools,
  createNotesTools,
  type AgentEvent,
  type AgentSessionConfiguration,
  type AgentSessionOptions,
  type InferenceBudget,
  type PromptContextItemInput,
  type SessionDescriptor
} from '@agent-core/runtime';
import {
  JsonlInferenceRepository,
  JsonlNoteRepository,
  JsonlSessionRepository
} from '@agent-core/runtime/node';
import { accessRisk, commandExecutionResources } from '@agent-core/tools';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CodingAgentConfiguration } from './configuration.js';
import {
  openCodingEnvironment,
  type CodingEnvironment
} from './execution/coding-command-authority.js';
import { processControls } from './execution/process-controls.js';
import { createWorkspaceToolHost } from '@agent-core/tools-local';
import { RepositoryGuidanceSession } from './instructions/repository-guidance.js';
import {
  resolveCodingAuthority,
  type CodingApprovalKind,
  type CodingAuthority,
  type CodingPermissionMode
} from './security/permission-mode.js';
import { createConfiguredCheckTool } from './verification/configured-check-tool.js';
import { codingWorkspaceSessionBinding, type OpenCodingWorkspace } from './workspace.js';

export interface CodingSessionOptions {
  readonly workspace: OpenCodingWorkspace;
  readonly provider: ModelProvider;
  readonly settings: AgentSessionConfiguration;
  readonly permissionMode: CodingPermissionMode;
  readonly descriptor?: SessionDescriptor;
  readonly maxOutputTokens?: number;
  readonly inferenceBudget?: InferenceBudget;
  readonly onCommandSettlement?: (
    result: import('@agent-core/tools').CommandExecutionResult
  ) => void;
  readonly configuration?: CodingAgentConfiguration;
  readonly configurationSource?: {
    readonly sourceUri: string;
    readonly sha256: string;
    readonly trustLevel: 'restricted' | 'trusted';
  };
  readonly environment?: CodingEnvironment;
  readonly environmentFactory?: CodingEnvironmentFactory;
}

export type CodingEnvironmentFactory = typeof openCodingEnvironment;

/** Application composition shared by the CLI, TUI, and RPC surfaces. */
export type CodingSessionComposition = Awaited<ReturnType<typeof createCodingSession>>;

export async function createCodingSession(options: CodingSessionOptions) {
  const openedWorkspace = options.workspace;
  const workspace = openedWorkspace.layout;
  const settings = options.settings;
  if (settings.provider !== options.provider.id)
    throw new Error('Coding session configuration must identify its exact provider.');

  const sessions = new JsonlSessionRepository({ rootDir: workspace.sessionsDir });
  const binding = codingWorkspaceSessionBinding(workspace.identity);
  const session =
    options.descriptor === undefined
      ? await sessions.create({ binding, provider: options.provider.id, model: settings.model })
      : await sessions.open(options.descriptor.id, binding);
  const sessionBinding = { repository: sessions, descriptor: session };
  const events = new JsonlEventRepository<AgentEvent>({
    rootDir: workspace.runsDir,
    codec: agentEventCodec
  });
  const projectPolicy =
    openedWorkspace.security.decide('project_execution_policy').kind === 'allowed';
  const configuration = projectPolicy ? options.configuration : undefined;
  const authority = resolveCodingAuthority({
    requestedMode: options.permissionMode,
    trust: admittedTrustLevel(openedWorkspace.security.trustLevel),
    ...(configuration
      ? {
          project: {
            permissions: configuration.permissions,
            enabledTools: configuration.tools.enabled
          }
        }
      : {}),
    hasVerificationChecks: Boolean(
      configuration &&
        (configuration.verification.required.length > 0 ||
          configuration.verification.advisory.length > 0)
    )
  });

  await fs.mkdir(workspace.artifactsDir, { recursive: true, mode: 0o700 });
  const artifacts = new LocalArtifactRepository({ rootDir: workspace.artifactsDir });
  let provider = openedWorkspace.security.protectProvider(options.provider);
  const ownerId = `coding-session:${session.id}`;
  const inferenceRepository = new JsonlInferenceRepository({
    rootDir: path.join(workspace.runtimeDir, 'inference')
  });
  const createInference = () =>
    new InferenceService({
      provider,
      repository: inferenceRepository,
      artifacts,
      ...(options.inferenceBudget === undefined ? {} : { budget: options.inferenceBudget })
    });
  let inference = createInference();
  const runs = new AgentRunCoordinator(events, artifacts);
  const history = new HistoryReader({ repository: sessions, session, events, artifacts });
  const notes = new JsonlNoteRepository({
    rootDir: path.join(workspace.runtimeDir, 'notes'),
    artifacts
  });
  const context = new ContextService({
    repository: sessions,
    session,
    history,
    notes,
    policy: {
      maxSourceBytes: 4 * 1024 * 1024,
      historyRead: { history, isAvailable: () => true }
    }
  });
  const memoryTools = Object.freeze([
    ...createHistoryTools({ history }),
    ...createNotesTools({
      repository: notes,
      scope: async () => {
        const cut = await history.capture();
        return { sessionId: cut.sessionId, branchId: cut.branchId };
      },
      authorId: 'coding-model'
    }),
    ...createContextTools({ context })
  ]);
  const memoryToolNames = new Set(memoryTools.map((tool) => tool.name));

  const ownsEnvironment = options.environment === undefined;
  const environment =
    options.environment ??
    (await (options.environmentFactory ?? openCodingEnvironment)({
      repositoryDirectory: path.join(workspace.runtimeDir, 'sandsurf'),
      hostWorkspaceRoot: openedWorkspace.fileRoot.identity.canonicalPath,
      workspaceId: workspace.identity.id,
      state: openedWorkspace.privateState,
      events,
      artifacts,
      commandExecution: authority.permissions.commandExecution === 'sandboxed',
      writable: authority.toolPolicy.allowedRisks.includes('write'),
      onSettlement: ({ result }) => options.onCommandSettlement?.(result)
    }));
  const commandExecution = environment.commandExecution;
  const sessionGuidance = RepositoryGuidanceSession.open({
    root: environment.files,
    security: openedWorkspace.security,
    configuredPaths: configuration?.instructions.map((instruction) => instruction.path) ?? []
  });
  try {
    await commandExecution?.reconcile();
  } catch (error) {
    if (ownsEnvironment) await environment.close();
    throw error;
  }

  try {
    const sessionOptions: AgentSessionOptions = {
      descriptor: session,
      expectedBinding: binding,
      repository: sessions,
      runs,
      context,
      notes,
      configuration: {
        provider: options.provider.id,
        model: settings.model,
        ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
        ...(settings.reasoning === undefined ? {} : { reasoning: settings.reasoning }),
        ...(settings.responseFormat === undefined
          ? {}
          : { responseFormat: settings.responseFormat })
      },
      async createRuntime(runtimeSettings, onProgress) {
        if (runtimeSettings.provider !== provider.id)
          throw new Error(`Provider ${runtimeSettings.provider} is unavailable in this session.`);
        const guidance = RepositoryGuidanceSession.open({
          root: environment.files,
          security: openedWorkspace.security,
          configuredPaths: configuration?.instructions.map((instruction) => instruction.path) ?? []
        });
        const host = createWorkspaceToolHost({
          files: environment.files,
          artifacts,
          ...(commandExecution ? { commandExecution } : {}),
          enabledTools: authority.enabledTools
        });

        const checkTools =
          commandExecution &&
          configuration &&
          authority.verificationCommands === 'sandboxed' &&
          configuration.verification.required.length + configuration.verification.advisory.length >
            0
            ? [
                createConfiguredCheckTool({
                  required: configuration.verification.required,
                  advisory: configuration.verification.advisory,
                  commandExecution,
                  root: environment.files
                })
              ]
            : [];
        const tools = Object.freeze([...host.tools, ...checkTools, ...memoryTools]);
        const runtime = new AgentRuntime({
          provider,
          inferenceService: inference,
          context,
          contextRenewal: { automatic: true },
          notes,
          inferenceOwnerId: ownerId,
          model: runtimeSettings.model,
          toolBoundary: {
            authorizationPolicyId: `coding-agent/${authority.mode}/${openedWorkspace.security.trustLevel}@2`,
            executionTargetId:
              commandExecution?.descriptor.recoveryIdentity ?? workspace.identity.id
          },
          repositories: { events, session: sessionBinding, artifacts },
          estimator: new CompleteRequestEstimator(),
          maxOutputTokens:
            options.maxOutputTokens ??
            defaultGenerationAllowance(await provider.describeModel(runtimeSettings.model)),
          tools,
          toolContext: { services: host.services },
          ...(commandExecution
            ? {
                resources: commandExecutionResources(commandExecution, { kind: 'owner', ownerId })
              }
            : {}),
          toolPolicy: authority.toolPolicy,
          toolContextPrerequisite: (request) =>
            memoryToolNames.has(request.call.name)
              ? Promise.resolve(undefined)
              : guidance.contextPrerequisite(request),
          toolAuthorizer: async (request) => {
            if (memoryToolNames.has(request.call.name))
              return {
                decision: 'allow',
                reason: 'The tool is bound to this session history, notes, or context service.'
              };
            const workspaceDecision = openedWorkspace.security.authorizeTool(request);
            if (workspaceDecision.decision === 'deny') return workspaceDecision;
            const guidanceDecision = await guidance.authorize(request);
            if (guidanceDecision) return guidanceDecision;
            if (workspaceDecision.decision === 'require_approval') return workspaceDecision;
            const approvals = request.effects.accesses
              .map((access) => approvalKind(accessRisk(access.mode)))
              .filter(
                (kind): kind is CodingApprovalKind =>
                  kind !== undefined && authority.requiredApprovals.includes(kind)
              );
            return approvals.length === 0
              ? { decision: 'allow' as const, reason: 'Allowed by workspace policy.' }
              : {
                  decision: 'require_approval' as const,
                  reason: `The permission boundary requires approval for ${[...new Set(approvals)].join(', ')}.`
                };
          },
          instructions: async () => (await guidance.refresh()).instructions,
          onRequestAdmitted: (admitted) => {
            guidance.markRequestAdmitted(admitted);
          },
          contextProvider: () =>
            commandExecution
              ?.recoveredTerminalReports()
              .slice(-16)
              .map(({ result }) => ({
                id: `command:${result.processId}`,
                sourceUri: `command:${result.processId}`,
                sourceKind: 'external',
                integrity: 'verified',
                representation: 'summary',
                mediaType: 'application/json',
                title: 'Command completion',
                purpose:
                  'Committed result of a command owned by this session; use process controls or the output artifact to retrieve original output.',
                content: JSON.stringify({
                  processId: result.processId,
                  runId: result.owner.runId,
                  status: result.status,
                  exitCode: result.exitCode,
                  signal: result.signal,
                  artifact: result.artifact,
                  originalOutput: result.originalOutput
                })
              })) ?? [],
          contextItems: [workspaceContext(authority)],
          ...(projectPolicy && configuration?.limits ? { limits: configuration.limits } : {}),
          metadata: {
            workspaceId: workspace.identity.id,
            workspaceName: workspace.workspaceName,
            workspaceRoot: environment.files.descriptor.displayRoot,
            workspaceTrust: openedWorkspace.security.trustLevel,
            ...(options.configurationSource
              ? {
                  projectConfigurationSource: options.configurationSource.sourceUri,
                  projectConfigurationSha256: options.configurationSource.sha256,
                  projectConfigurationTrust: options.configurationSource.trustLevel
                }
              : {})
          },
          ...(runtimeSettings.temperature === undefined
            ? {}
            : { temperature: runtimeSettings.temperature }),
          ...(runtimeSettings.reasoning === undefined
            ? {}
            : { reasoning: runtimeSettings.reasoning }),
          ...(runtimeSettings.responseFormat === undefined
            ? {}
            : { responseFormat: runtimeSettings.responseFormat }),
          onProgress
        });
        return runtime;
      }
    };
    const agent = new AgentSession(sessionOptions);

    return {
      ...processControls(session.id, commandExecution),
      agent,
      get inference() {
        return inference;
      },
      get provider() {
        return provider;
      },
      setProvider(next: ModelProvider) {
        provider = openedWorkspace.security.protectProvider(next);
        inference = createInference();
      },
      history,
      artifacts,
      notes,
      context,
      runs,
      events,
      sessions,
      session,
      async inspectContext() {
        const profile = await provider.describeModel(agent.state().configuration.model);
        return {
          ...(await context.inspect()),
          suspension: agent.inspectSuspension(),
          generation: {
            outputReservation: options.maxOutputTokens ?? defaultGenerationAllowance(profile),
            enforcement: profile.supportedParameters.includes('maxOutputTokens')
              ? 'provider-cap'
              : 'reservation-only'
          },
          available: {
            instructions: (await sessionGuidance.refresh()).instructions,
            resources: [workspaceContext(authority)],
            toolNames: authority.enabledTools
          }
        };
      },
      workspaceRoot: environment.files.descriptor.displayRoot,
      fileRoot: environment.files,
      permissions: authority.permissions,
      ...(configuration ? { configuration } : {}),
      async closeResources() {
        if (ownsEnvironment) await environment.close();
      }
    };
  } catch (error) {
    try {
      if (ownsEnvironment) await environment.close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Coding session construction and cleanup failed.',
        { cause: cleanup }
      );
    }
    throw error;
  }
}

function workspaceContext(authority: CodingAuthority): PromptContextItemInput {
  return Object.freeze({
    id: 'coding-agent/workspace',
    sourceUri: 'workspace:///',
    sourceKind: 'external',
    integrity: 'verified',
    representation: 'full',
    mediaType: 'text/plain; charset=utf-8',
    title: 'Active workspace',
    content: [
      'Workspace root: /workspace (inside the persistent Sandsurf Linux environment)',
      `Permission mode: ${authority.mode}`,
      `Available workspace tools: ${authority.enabledTools.join(', ') || 'none'}`
    ].join('\n'),
    purpose: 'Current source location and permission boundary.'
  });
}

function admittedTrustLevel(
  value: OpenCodingWorkspace['security']['trustLevel']
): 'restricted' | 'trusted' {
  if (value === 'restricted' || value === 'trusted') return value;
  throw new Error('Runtime creation requires an admitted workspace.');
}

function approvalKind(risk: ReturnType<typeof accessRisk>): CodingApprovalKind | undefined {
  if (risk === 'write') return 'write';
  if (risk === 'destructive') return 'delete';
  if (risk === 'execute') return 'command';
  return undefined;
}

export async function closeCodingSession(runtime: CodingSessionComposition): Promise<void> {
  await runtime.closeResources();
}

/** Application policy: reserve at most half the context and up to 16,384 output tokens. */
function defaultGenerationAllowance(profile: import('@agent-core/model').ModelProfile): number {
  return Math.min(
    16_384,
    profile.limits.outputTokens ?? Infinity,
    profile.limits.contextTokens === undefined
      ? Infinity
      : Math.max(1, Math.floor(profile.limits.contextTokens / 2))
  );
}

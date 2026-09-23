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
import { commandExecutionResources, isWorkspaceFiles } from '@agent-core/tools';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CodingAgentConfiguration } from './configuration.js';
import {
  openCodingEnvironment,
  type CodingEnvironment
} from './execution/coding-command-authority.js';
import { processControls } from './execution/process-controls.js';
import {
  createLocalToolHost,
  createWorkspaceToolHost,
  DEFAULT_LOCAL_TOOL_CONFIGURATION,
  LocalCommandExecution,
  TextPatchJournal,
  type RootedFileAuthority
} from '@agent-core/tools-local';
import { RepositoryGuidanceSession } from './instructions/repository-guidance.js';
import {
  resolveCodingAuthority,
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
    readonly trustLevel: 'trusted';
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
    ...(configuration ? { enabledTools: configuration.tools.enabled } : {}),
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

  const ownsEnvironment = authority.mode !== 'sandbox' || options.environment === undefined;
  const environment =
    authority.mode === 'sandbox'
      ? options.environment ??
        (await (options.environmentFactory ?? openCodingEnvironment)({
          repositoryDirectory: path.join(workspace.runtimeDir, 'sandsurf'),
          hostWorkspaceRoot: openedWorkspace.fileRoot.identity.canonicalPath,
          workspaceId: workspace.identity.id,
          state: openedWorkspace.privateState,
          events,
          artifacts,
          commandExecution: true,
          writable: true,
          onSettlement: ({ result }) => {
            if (result.owner.ownerId === ownerId) options.onCommandSettlement?.(result);
          }
        }))
      : await openHostEnvironment(
          openedWorkspace.fileRoot,
          workspace.runtimeDir,
          artifacts,
          authority,
          (result) => {
            if (result.owner.ownerId === ownerId) options.onCommandSettlement?.(result);
          }
        );
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
        const host =
          'toolHost' in environment
            ? environment.toolHost
            : createWorkspaceToolHost({
                files: environment.files,
                artifacts,
                ...(commandExecution ? { commandExecution } : {}),
                enabledTools: authority.enabledTools
              });

        const checkTools =
          commandExecution &&
          configuration &&
          authority.verificationCommands &&
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
            return { decision: 'allow' as const, reason: 'Allowed by workspace policy.' };
          },
          instructions: async () => (await guidance.refresh()).instructions,
          onRequestAdmitted: (admitted) => {
            guidance.markRequestAdmitted(admitted);
          },
          contextProvider: () =>
            commandExecution
              ?.recoveredTerminalReports()
              .filter(({ result }) => result.owner.ownerId === ownerId)
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
            workspaceRoot: workspaceDisplayRoot(environment.files),
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
      ...processControls(session.id, ownerId, commandExecution),
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
      workspaceRoot: workspaceDisplayRoot(environment.files),
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
      authority.mode === 'sandbox'
        ? 'Workspace root: /workspace in Sandsurf. Edits stay in the guest; they do not appear in the host project.'
        : authority.mode === 'read_only'
          ? 'Workspace root: the selected host project. Read-only tools are available; edits and commands are disabled.'
          : 'Workspace root: the selected host project. Commands run under your host account with access to the rest of the system and network.',
      `Permission mode: ${authority.mode}`,
      `Available workspace tools: ${authority.enabledTools.join(', ') || 'none'}`
    ].join('\n'),
    purpose: 'Current source location and permission boundary.'
  });
}

function workspaceDisplayRoot(files: CodingEnvironment['files'] | RootedFileAuthority): string {
  return isWorkspaceFiles(files) ? files.descriptor.displayRoot : files.displayPath;
}

async function openHostEnvironment(
  workspaceRoot: RootedFileAuthority,
  runtimeDirectory: string,
  artifacts: LocalArtifactRepository,
  authority: CodingAuthority,
  onSettlement: (result: import('@agent-core/tools').CommandExecutionResult) => void
) {
  const files = workspaceRoot.derive();
  const journalDirectory = path.join(runtimeDirectory, 'transactions', 'host-patch');
  const processDirectory = path.join(runtimeDirectory, 'host-processes');
  let commands: LocalCommandExecution | undefined;
  let journal: TextPatchJournal | undefined;
  let host: ReturnType<typeof createLocalToolHost> | undefined;
  try {
    if (authority.mode === 'full_host') {
      await fs.mkdir(journalDirectory, { recursive: true, mode: 0o700 });
      await fs.mkdir(processDirectory, { recursive: true, mode: 0o700 });
      journal = TextPatchJournal.adopt(journalDirectory);
      commands = new LocalCommandExecution({
        artifactRepository: artifacts,
        rootedFileAuthority: files,
        ledgerDirectory: processDirectory,
        onSettlement,
        ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process
      });
    }
    host = createLocalToolHost({
      rootedFileAuthority: files,
      artifactRepository: artifacts,
      ...(commands ? { commandExecution: commands } : {}),
      ...(journal ? { patchJournal: journal } : {}),
      enabledTools: authority.enabledTools
    });
    await host.ready();
    const openedCommands = commands;
    const openedHost = host;
    return {
      files,
      ...(openedCommands ? { commandExecution: openedCommands } : {}),
      toolHost: openedHost,
      async close() {
        try {
          await openedCommands?.close();
        } finally {
          await openedHost.close();
        }
      }
    };
  } catch (error) {
    try {
      await commands?.close();
    } finally {
      if (host) await host.close();
      else {
        journal?.close();
        files.close();
      }
    }
    throw error;
  }
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

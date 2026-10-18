import type { NativeToolExposure } from '@agent-core/runtime';
import { resolveRuntimeToolCatalog, SessionToolCatalogSelectionStore } from '@agent-core/runtime';
import { createProgrammaticTool } from '@agent-core/tools-programmatic';
import { createQuickJSProgramRunner } from '@agent-core/tools-programmatic/node';
import { createConfiguredWebTools } from '@agent-core/tools-web/node';
import { createConfiguredMcpSources } from '@agent-core/tools-mcp/node';
import { ToolCatalog } from '@agent-core/tools';
import type { ProgramLimits } from '@agent-core/tools-programmatic';
import type { WebConfiguration } from '@agent-core/tools-web';
import type { NodeMcpConfiguration } from '@agent-core/tools-mcp/node';
import { RequestTokenEstimator, type ModelProvider } from '@agent-core/model';
import { JsonlEventRepository, LocalArtifactRepository } from '@agent-core/persistence/node';
import {
  AgentRunCoordinator,
  authorizeSessionToolEffects,
  commitResourceRelease,
  createResourceReportTool,
  readPendingResourceReports,
  AgentRuntime,
  AgentSession,
  ContextService,
  HistoryReader,
  SessionProviderBinding,
  generationAllowance,
  resolveOutputReservation,
  resolveEffectiveToolCatalog,
  inspectSessionOperational,
  type SessionOperationalInspection,
  type ContextResourcePolicy,
  type ContextControlPolicy,
  type OutputReservationPolicy,

  agentEventCodec,
  createHistoryTools,
  type AgentEvent,
  type ContextOperationalInspectionPage,
  type AgentSessionConfiguration,
  type AgentSessionOptions,
  type InferenceBudget,
  type PromptContextItemInput,
  type SessionDescriptor
} from '@agent-core/runtime';
import { JsonlInferenceRepository, JsonlSessionRepository } from '@agent-core/runtime/node';
import {
  commandExecutionResources,
  commandReleaseReport,
  type ToolPolicy,
  type CommandExecutionReport
} from '@agent-core/tools';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CodingAgentConfiguration } from './configuration.js';
import { processControls } from './execution/process-controls.js';
import { recoveredCommandContext } from './execution/recovered-command-context.js';
import {
  createLocalToolHost,
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
  readonly resolveProvider?: (configuration: AgentSessionConfiguration) => ModelProvider;
  readonly settings: AgentSessionConfiguration;
  readonly permissionMode: CodingPermissionMode;
  readonly descriptor?: SessionDescriptor;
  readonly maxOutputTokens?: number;
  readonly inferenceBudget?: InferenceBudget;
  readonly contextPolicy?: ContextResourcePolicy;
  readonly contextControlPolicy?: Partial<ContextControlPolicy>;
  readonly outputReservationPolicy?: OutputReservationPolicy;
  readonly programmaticTools?: Partial<ProgramLimits>;
  readonly nativeToolExposure?: NativeToolExposure;
  readonly webTools?: WebConfiguration;
  readonly mcpTools?: NodeMcpConfiguration;
  readonly onCommandSettlement?: (
    result: import('@agent-core/tools').CommandExecutionResult
  ) => void;
  readonly configuration?: CodingAgentConfiguration;
  readonly configurationSource?: {
    readonly sourceUri: string;
    readonly sha256: string;
    readonly trustLevel: 'trusted';
  };
}

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
    configuredNetworkTools: options.webTools !== undefined || (options.mcpTools?.servers.length ?? 0) > 0,
    ...(configuration ? { enabledTools: configuration.tools.enabled } : {}),
    hasVerificationChecks: Boolean(
      configuration &&
        (configuration.verification.required.length > 0 ||
          configuration.verification.advisory.length > 0)
    )
  });

  await fs.mkdir(workspace.artifactsDir, { recursive: true, mode: 0o700 });
  const artifacts = new LocalArtifactRepository({ rootDir: workspace.artifactsDir });
  const ownerId = `coding-session:${session.id}`;
  const inferenceRepository = new JsonlInferenceRepository({
    rootDir: path.join(workspace.runtimeDir, 'inference')
  });
  const contextControlPolicy = options.contextControlPolicy ?? configuration?.contextControlPolicy;
  const outputReservationPolicy = options.outputReservationPolicy ?? configuration?.outputReservationPolicy;
  const inferenceBudget = options.inferenceBudget ?? configuration?.inferenceBudget;
  const providerBinding = new SessionProviderBinding({
    provider: options.provider,
    selection: (() => { const { responseFormat: ignored, ...selection } = settings; void ignored; return selection; })(),
    ...(options.resolveProvider ? { resolveProvider: options.resolveProvider } : {}),
    repository: inferenceRepository,
    artifacts,
    admitRequest: (request) => { openedWorkspace.security.admitProviderRequest(request); },
    ...(inferenceBudget === undefined ? {} : { budget: inferenceBudget })
  });
  const runs = new AgentRunCoordinator(events, artifacts);
  if (options.programmaticTools && options.nativeToolExposure?.programmatic) throw new Error('Choose either portable or provider-native programmatic execution.');
  const programRunner = options.programmaticTools ? createQuickJSProgramRunner({ limits: options.programmaticTools }) : undefined;
  const configuredMcp = options.mcpTools ? createConfiguredMcpSources(options.mcpTools, { artifacts, allowedRisks: options.permissionMode === 'read_only' ? ['read', 'network'] : ['read', 'write', 'execute', 'destructive', 'network'] }) : undefined;
  const programTool = programRunner ? createProgrammaticTool({ limits: options.programmaticTools ?? {} }) : undefined;
  const additionalTools = Object.freeze([
    ...(programTool ? [programTool] : []),
    ...(options.webTools ? createConfiguredWebTools(options.webTools, { artifacts }) : [])
  ]);
  const history = new HistoryReader({ repository: sessions, session, events, artifacts });

  let inspectOperational: (page?: ContextOperationalInspectionPage) => Promise<SessionOperationalInspection>;
  const context = new ContextService({
    inspectOperational: (page) => inspectOperational(page),
    repository: sessions,
    session,
    history,

    artifacts,
    policy: {
      maxSourceBytes: 4 * 1024 * 1024,
      ...(options.contextPolicy ?? configuration?.contextPolicy),
      historyRead: { history, isAvailable: () => true }
    }
  });
  const commitTerminalReport = async (report: CommandExecutionReport): Promise<void> => {
    await commitResourceRelease({
      runId: report.result.owner.runId,
      report: commandReleaseReport(report),
      events
    });
  };
  const environment = await openHostEnvironment(
    openedWorkspace.fileRoot,
    workspace.runtimeDir,
    artifacts,
    authority,
    commitTerminalReport,
    (result) => {
      if (result.owner.ownerId === ownerId) options.onCommandSettlement?.(result);
    }
  );
  const closeEnvironment = async (): Promise<void> => {
    const results = await Promise.allSettled([configuredMcp?.close(), environment.close()]);
    const failures = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason as unknown] : []);
    if (failures.length > 0) throw new AggregateError(failures, 'Coding session resources could not all be closed.');
  };
  const commandExecution = environment.commandExecution;
  const resourceReports = { repository: sessions, session, events, ownerId, command: commandExecution };
  const sessionTools = Object.freeze([
    ...createHistoryTools({ history }),
    createResourceReportTool(resourceReports),
    ...context.toolDefinitions()
  ]);
  const sessionToolNames = new Set(sessionTools.map((tool) => tool.name));

  const sessionGuidance = RepositoryGuidanceSession.open({
    root: environment.files,
    security: openedWorkspace.security,
    configuredPaths: configuration?.instructions.map((instruction) => instruction.path) ?? []
  });
  try {
    await commandExecution?.reconcile();
  } catch (error) {
    await closeEnvironment();
    throw error;
  }

  try {
    const host = environment.toolHost;

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
    const tools = Object.freeze([...host.tools, ...checkTools, ...sessionTools, ...additionalTools]);
    const toolCatalog = new ToolCatalog({ tools, selectionStore: new SessionToolCatalogSelectionStore(sessions, session), ...(configuredMcp ? { sources: configuredMcp.sources } : {}) });
    const resources = commandExecution
      ? commandExecutionResources(commandExecution, { kind: 'owner', ownerId })
      : undefined;
    const toolPolicy: ToolPolicy = { allowedRisks: ['read', 'write', 'destructive', 'execute', ...(options.webTools || options.mcpTools ? ['network' as const] : [])] };
    const sessionOptions: AgentSessionOptions = {
      descriptor: session,
      expectedBinding: binding,
      repository: sessions,
      runs,
      context,

      configuration: {
        provider: options.provider.id,
        model: settings.model,
        ...(settings.endpoint === undefined ? {} : { endpoint: settings.endpoint }),
        ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
        ...(settings.reasoning === undefined ? {} : { reasoning: settings.reasoning }),
        ...(settings.responseFormat === undefined
          ? {}
          : { responseFormat: settings.responseFormat })
      },
      providerBinding,
      async createRuntime(runtimeSettings, onProgress) {
        const guidance = RepositoryGuidanceSession.open({
          root: environment.files,
          security: openedWorkspace.security,
          configuredPaths: configuration?.instructions.map((instruction) => instruction.path) ?? []
        });
        const runtime = new AgentRuntime({
          provider: providerBinding.provider,
          modelBindingId: providerBinding.bindingId,
          inferenceService: providerBinding.inference,
          context,
          ...(contextControlPolicy ? { contextControlPolicy } : {}),
          ...(outputReservationPolicy ? { outputReservationPolicy } : {}),
          contextRenewal: { automatic: true },

          inferenceOwnerId: ownerId,
          model: runtimeSettings.model,
          toolBoundary: {
            authorizationPolicyId: `coding-agent/${authority.mode}/${openedWorkspace.security.trustLevel}@2`,
            executionTargetId:
              commandExecution?.descriptor.recoveryIdentity ?? workspace.identity.id
          },
          repositories: { events, session: sessionBinding, artifacts },
          estimator: new RequestTokenEstimator(),
          maxOutputTokens:
            options.maxOutputTokens ??
            generationAllowance(await providerBinding.provider.describeModel(runtimeSettings.model), 16_384),
          toolCatalog,
          ...(programRunner ? { programRunner } : {}),
          ...(options.nativeToolExposure ? { nativeToolExposure: options.nativeToolExposure } : {}),
          toolContext: { services: host.services },
          ...(resources === undefined ? {} : { resources }),
          // File/command authority is enforced by the exposed host capabilities and authorizer.
          // Session-state publication remains available in read-only workspaces.
          toolPolicy,
          toolContextPrerequisite: (request) =>
            sessionToolNames.has(request.call.name)
              ? Promise.resolve(undefined)
              : guidance.contextPrerequisite(request),
          toolAuthorizer: async (request) => {
            if (sessionToolNames.has(request.call.name)) {
              const decision = await authorizeSessionToolEffects(request, { sessionId: session.id, branchId: (await history.capture()).branchId,
                artifacts: host.services.artifactRepository,
                allowArtifactRead: host.tools.some(tool => tool.name === 'read_artifact') });
              if (decision.decision !== 'allow') return decision;
              const accesses = request.effects.accesses.filter(access => access.scope.startsWith('artifacts/'));
              return accesses.length === 0 ? decision : openedWorkspace.security.authorizeTool({
                ...request, effects: { ...request.effects, accesses }
              });
            }
            if (authority.mode === 'read_only' && request.effects.accesses.some(access => access.mode === 'write' || access.mode === 'delete' || access.mode === 'execute'))
              return { decision: 'deny' as const, reason: 'Read-only mode does not permit external mutations or execution.' };
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
          contextProvider: async () => recoveredCommandContext(
            await readPendingResourceReports(resourceReports, { limit: 16, maxBytes: 7_000 })
          ),
          contextItems: [workspaceContext(authority, environment.files.displayPath)],
          ...(projectPolicy && configuration?.limits ? { limits: configuration.limits } : {}),
          metadata: {
            workspaceId: workspace.identity.id,
            workspaceName: workspace.workspaceName,
            workspaceRoot: environment.files.displayPath,
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
    inspectOperational = async (page = {}) => {
      const resolved = await providerBinding.resolve(agent.state().configuration);
      const catalog = resolveEffectiveToolCatalog({ bindingId: resolved.bindingId,
        programmaticRunner: programRunner !== undefined, modelProfile: resolved.profile,
        ...(options.nativeToolExposure ? { nativeToolExposure: options.nativeToolExposure } : {}),
        ...(programTool ? { eagerTool: programTool } : {}), tools: await resolveRuntimeToolCatalog(toolCatalog), policy: toolPolicy,
        host: { services: { ...host.services, ...(programRunner ? { programExecution: true } : {}) }, modelInputModalities: resolved.profile.modalities.input,
          hostCapabilities: resources?.capabilities ?? [] } });
      const contextAdmission = context.admittedCapabilities();
      return inspectSessionOperational({ configured: catalog.snapshot, profile: resolved.profile,
        configuredOutputReservation: options.maxOutputTokens ?? generationAllowance(resolved.profile, 16_384),
        outputReservation: resolveOutputReservation(options.maxOutputTokens ?? generationAllowance(resolved.profile, 16_384),
          outputReservationPolicy, (await history.selectedContext())?.outputReservation),
        ...(contextControlPolicy ? { contextControlPolicy } : {}),
        ...(outputReservationPolicy ? { outputReservationPolicy } : {}),
        inference: resolved.inference, ownerId, page,
        ...(contextAdmission ? { contextAdmission } : {}) });
    };

    let closeCompletion: Promise<void> | undefined;
    return {
      ...processControls(session.id, ownerId, commandExecution),
      agent,
      get inference() {
        return providerBinding.inference;
      },
      get provider() {
        return providerBinding.provider;
      },
      history,
      artifacts,

      context,
      runs,
      events,
      sessions,
      session,
      async inspectContext(page?: ContextOperationalInspectionPage) {
        return {
          ...(await context.inspect(undefined, undefined, page)),
          suspension: agent.inspectSuspension(),
          available: {
            instructions: (await sessionGuidance.refresh()).instructions,
            resources: [workspaceContext(authority, environment.files.displayPath)]
          }
        };
      },
      workspaceRoot: environment.files.displayPath,
      fileRoot: environment.files,
      permissions: authority.permissions,
      ...(configuration ? { configuration } : {}),
      closeResources() {
        closeCompletion ??= (async () => {
          try {
            if (commandExecution) for (const report of await commandExecution.disposeOwner(ownerId)) {
              await commitResourceRelease({
                runId: report.result.owner.runId,
                report: commandReleaseReport(report),
                events,
                acknowledge: (resourceId) => commandExecution.acknowledgeTerminalReport(resourceId)
              });
            }
          } finally {
            await closeEnvironment();
          }
        })();
        return closeCompletion;
      }
    };
  } catch (error) {
    try {
      await closeEnvironment();
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

function workspaceContext(authority: CodingAuthority, displayRoot: string): PromptContextItemInput {
  return Object.freeze({
    id: 'coding-agent/workspace',
    sourceUri: 'workspace:///',
    sourceKind: 'external',
    integrity: 'verified',
    representation: 'full',
    mediaType: 'text/plain; charset=utf-8',
    title: 'Active workspace',
    content: [
      `Workspace root: ${JSON.stringify(displayRoot)}`,
      'File-tool paths and command workdir are relative to this root; "." means this root.',
      authority.mode === 'read_only'
        ? 'Read-only host workspace. Edits and commands are disabled.'
        : 'Host workspace. Commands run under your host account with access to the rest of the system and network.',
      `Permission mode: ${authority.mode}`
    ].join('\n'),
    purpose: 'Current source location and permission boundary.'
  });
}

async function openHostEnvironment(
  workspaceRoot: RootedFileAuthority,
  runtimeDirectory: string,
  artifacts: LocalArtifactRepository,
  authority: CodingAuthority,
  commitTerminalReport: (report: CommandExecutionReport) => Promise<void>,
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
        commitTerminalReport: async (report) => {
          await commitTerminalReport(report);
          try {
            onSettlement(report.result);
          } catch {
            // Subscriber delivery cannot change the committed command settlement.
          }
        },
        ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process
      });
    }
    host = createLocalToolHost({
      artifactReadMaxBytes: 2_000_000,
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
  const failures: unknown[] = [];
  try {
    await runtime.agent.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await runtime.closeResources();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0)
    throw new AggregateError(failures, 'Coding session cleanup failed.');
}

import { CompleteRequestEstimator, type ModelProvider } from '@agent-core/model';
import { hashJson } from '@agent-core/persistence';
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
import { accessRisk, commandExecutionResources, commandReleaseReport } from '@agent-core/tools';
import { TextPatchJournal, createLocalToolHost } from '@agent-core/tools-local';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CodingAgentConfiguration } from './configuration.js';
import {
  createCodingCommandAuthority,
  type CodingCommandAuthority
} from './execution/coding-command-authority.js';
import { processControls } from './execution/process-controls.js';
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
  readonly configuration?: CodingAgentConfiguration;
  readonly configurationSource?: {
    readonly sourceUri: string;
    readonly sha256: string;
    readonly trustLevel: 'restricted' | 'trusted';
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
  const provider = openedWorkspace.security.protectProvider(options.provider);
  const ownerId = `coding-session:${session.id}`;
  const inference = new InferenceService({
    provider,
    repository: new JsonlInferenceRepository({
      rootDir: path.join(workspace.runtimeDir, 'inference')
    }),
    artifacts,
    ...(options.inferenceBudget === undefined ? {} : { budget: options.inferenceBudget })
  });
  const runs = new AgentRunCoordinator(events, artifacts);
  const history = new HistoryReader({ repository: sessions, session, events, artifacts });
  const notes = new JsonlNoteRepository({
    rootDir: path.join(workspace.runtimeDir, 'notes'),
    artifacts
  });
  const sessionGuidance = RepositoryGuidanceSession.open({
    root: openedWorkspace.fileRoot,
    security: openedWorkspace.security,
    configuredPaths: configuration?.instructions.map((instruction) => instruction.path) ?? []
  });
  const openHosts = new Set<ReturnType<typeof createLocalToolHost>>();
  const commandAuthorities = new Set<CodingCommandAuthority>();

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
      ...(settings.responseFormat === undefined ? {} : { responseFormat: settings.responseFormat })
    },
    async createRuntime(runtimeSettings, onProgress, runtimeContext) {
      if (runtimeSettings.provider !== options.provider.id)
        throw new Error(`Provider ${runtimeSettings.provider} is unavailable in this session.`);
      const runKey = createHash('sha256').update(runtimeContext.runId).digest('hex');
      const patchEnabled = authority.enabledTools.includes('apply_patch');
      const patchJournalDirectory = path.join(
        workspace.runtimeDir,
        'run-tools',
        runKey,
        'patch-transactions'
      );
      if (patchEnabled) await fs.mkdir(patchJournalDirectory, { recursive: true, mode: 0o700 });
      const root = openedWorkspace.fileRoot.derive();
      let commandExecution: ReturnType<typeof createCodingCommandAuthority> | undefined;
      let guidance: RepositoryGuidanceSession;
      let host: ReturnType<typeof createLocalToolHost>;
      try {
        commandExecution =
          authority.permissions.commandExecution === 'sandboxed'
            ? createCodingCommandAuthority({
                repositoryDirectory: path.join(workspace.runtimeDir, 'commands', session.id),
                rootedFileAuthority: root,
                state: openedWorkspace.privateState
              })
            : undefined;
        guidance = RepositoryGuidanceSession.open({
          root,
          security: openedWorkspace.security,
          configuredPaths: configuration?.instructions.map((instruction) => instruction.path) ?? []
        });
        host = createLocalToolHost({
          rootedFileAuthority: root,
          artifactRepository: artifacts,
          ...(commandExecution ? { commandExecution } : {}),
          ...(patchEnabled ? { patchJournal: TextPatchJournal.adopt(patchJournalDirectory) } : {}),
          enabledTools: authority.enabledTools,
          async deliverRecoveredTerminalReport(report) {
            const runId = report.result.owner.runId;
            await events.append(
              runId,
              { type: 'resource.released', runId, ...commandReleaseReport(report) },
              {
                idempotencyKey: `${runId}:resource:${report.result.processId}:released:${hashJson(commandReleaseReport(report))}`
              }
            );
            return (await events.latestOfType(runId, 'run.ended'))?.event.type === 'run.ended';
          }
        });
      } catch (error) {
        root.close();
        throw error;
      }
      openHosts.add(host);
      if (commandExecution !== undefined) commandAuthorities.add(commandExecution);
      try {
        await host.ready();
      } catch (error) {
        openHosts.delete(host);
        if (commandExecution !== undefined) commandAuthorities.delete(commandExecution);
        await host.close().catch(() => undefined);
        throw error;
      }
      const reconciliation = await host.reconciliation();
      if (reconciliation.unresolved.length > 0)
        throw new Error(
          `Unresolved command execution blocks this run: ${reconciliation.unresolved
            .map((item) => `${item.processId}: ${item.diagnostic}`)
            .join('; ')}`
        );

      const checkTools =
        commandExecution &&
        configuration &&
        authority.verificationCommands === 'sandboxed' &&
        configuration.verification.required.length + configuration.verification.advisory.length > 0
          ? [
              createConfiguredCheckTool({
                required: configuration.verification.required,
                advisory: configuration.verification.advisory,
                commandExecution,
                root
              })
            ]
          : [];
      const tools = Object.freeze([...host.tools, ...checkTools, ...memoryTools]);
      const release = async () => {
        openHosts.delete(host);
        if (commandExecution !== undefined) commandAuthorities.delete(commandExecution);
        await host.close();
      };
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
          executionTargetId: commandExecution?.descriptor.recoveryIdentity ?? workspace.identity.id
        },
        repositories: { events, session: sessionBinding, artifacts },
        estimator: new CompleteRequestEstimator(),
        ...(options.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: options.maxOutputTokens }),
        tools,
        toolContext: { services: host.services },
        ...(commandExecution
          ? { resources: commandExecutionResources(commandExecution, { kind: 'owner', ownerId }) }
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
        contextItems: [workspaceContext(openedWorkspace, authority)],
        ...(projectPolicy && configuration?.limits ? { limits: configuration.limits } : {}),
        metadata: {
          workspaceId: workspace.identity.id,
          workspaceName: workspace.workspaceName,
          workspaceRoot: openedWorkspace.fileRoot.identity.canonicalPath,
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
        onProgress,
        release
      });
      return runtime;
    }
  };
  const agent = new AgentSession(sessionOptions);

  return {
    ...processControls(session.id, commandAuthorities),
    agent,
    inference,
    history,
    artifacts,
    notes,
    context,
    runs,
    events,
    sessions,
    session,
    async inspectContext() {
      return {
        ...(await context.inspect()),
        suspension: agent.inspectSuspension(),
        available: {
          instructions: (await sessionGuidance.refresh()).instructions,
          resources: [workspaceContext(openedWorkspace, authority)],
          toolNames: authority.enabledTools
        }
      };
    },
    workspaceRoot: openedWorkspace.fileRoot.identity.canonicalPath,
    fileRoot: openedWorkspace.fileRoot,
    permissions: authority.permissions,
    ...(configuration ? { configuration } : {}),
    async closeResources() {
      const results = await Promise.allSettled([...openHosts].map((host) => host.close()));
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason as unknown);
      if (failures.length > 0)
        throw new AggregateError(failures, 'Coding Agent resource release failed.');
    }
  };
}

function workspaceContext(
  workspace: OpenCodingWorkspace,
  authority: CodingAuthority
): PromptContextItemInput {
  return Object.freeze({
    id: 'coding-agent/workspace',
    sourceUri: `file://${workspace.fileRoot.identity.canonicalPath}`,
    sourceKind: 'external',
    integrity: 'verified',
    representation: 'full',
    mediaType: 'text/plain; charset=utf-8',
    title: 'Active workspace',
    content: [
      `Workspace root: ${workspace.fileRoot.identity.canonicalPath}`,
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

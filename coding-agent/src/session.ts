import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AgentRunCoordinator,
  AgentRuntime,
  AgentSession,
  InferenceService,
  ContextService,
  HistoryReader,
  createHistoryTools,
  createNotesTools,
  createContextTools,
  createRuntimeContextBootstrapValidator,
  sourceRef,
  agentEventCodec,
  type PromptContextItemInput,
  type AgentEvent,
  type InferenceBudget,
  type AgentSessionConfiguration,
  type SessionDescriptor
} from '@agent-core/runtime';
import {
  JsonlInferenceRepository,
  JsonlNoteRepository,
  JsonlSessionRepository
} from '@agent-core/runtime/node';
import { JsonlEventRepository, LocalArtifactRepository } from '@agent-core/persistence/node';
import { type ModelProvider, CompleteRequestEstimator } from '@agent-core/model';
import { accessRisk, type CompiledToolDefinition } from '@agent-core/tools';
import {
  createLocalToolHost,
  DEFAULT_LOCAL_TOOL_CONFIGURATION,
  RootedFileAuthority,
  TextPatchJournal
} from '@agent-core/tools-local';
import { parseJsonValue } from '@agent-core/json';
import { openSandboxExecutionRepository } from '@ismail-elkorchi/sandbox';
import type { CodingAgentConfiguration } from './configuration.js';
import { codingWorkspaceSessionBinding, type OpenCodingWorkspace } from './workspace.js';
import {
  loadInitialRepositoryGuidance,
  loadInitialRepositoryGuidanceFromRoot,
  RepositoryGuidanceSession
} from './instructions/repository-guidance.js';
import {
  inspectRepositoryOrientation,
  inspectRepositoryVersionControl,
  repositoryOrientationContext
} from './workspace/repository-orientation.js';
import { SandboxGitRepositoryObserver } from './workspace/git/sandbox-git-observer.js';
import {
  unavailableGitRepositoryObserver,
  type GitRepositoryObserver
} from './workspace/git/repository-observer.js';
import { createCodingCommandAuthority } from './execution/coding-command-authority.js';
import {
  resolveCodingAuthority,
  type CodingApprovalKind,
  type CodingPermissionMode,
  type CodingAuthority
} from './security/permission-mode.js';
import {
  createCandidateAcceptanceChecks,
  deriveAdmittedCheckPlan,
  observePreChangeCommands
} from './verification/candidate-acceptance-checks.js';
import { createCodingDisposition } from './verification/coding-disposition.js';
import { loadOrAdmitCheckPlan } from './verification/check-plan-store.js';
import { loadOrObservePreChangeCommands } from './verification/pre-change-command-observation-store.js';
import { loadOrCapturePreChangeSnapshot } from './changes/pre-change-snapshot-store.js';
import { IsolatedWorkingCopy } from './changes/isolated-working-copy.js';
import { codingHistoryPressureTransition } from './context-policy.js';
import { DEFAULT_CODING_CONTRACT } from './instructions/coding-contract.js';
import { codingSessionBoundaryContext } from './session-context.js';
import { CodingHandoffService } from './changes/coding-handoff-service.js';

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

/** Reusable application composition shared by CLI, TUI, and programmatic consumers. */
export interface CodingSessionComposition {
  readonly agent: AgentSession;
  readonly inference: InferenceService;
  readonly history: HistoryReader;
  readonly notes: JsonlNoteRepository;
  readonly context: ContextService;
  readonly runs: AgentRunCoordinator;
  readonly events: JsonlEventRepository<AgentEvent>;
  readonly sessions: JsonlSessionRepository;
  readonly session: SessionDescriptor;
  readonly permissions: CodingAuthority['permissions'];
  readonly gitObserver: GitRepositoryObserver;
  readonly handoffs: CodingHandoffService;
}

export async function createCodingSession(options: CodingSessionOptions): Promise<CodingSessionComposition> {
  const openedWorkspace = options.workspace;
  const workspace = openedWorkspace.layout;
  const sessions = new JsonlSessionRepository({ rootDir: workspace.sessionsDir });
  const binding = codingWorkspaceSessionBinding(workspace.identity);
  const settings = options.settings;
  if (settings.provider !== options.provider.id)
    throw new Error('Coding session configuration must identify its exact provider.');
  const providerRuntime = {
    provider: openedWorkspace.security.protectProvider(options.provider),
    providerId: options.provider.id,
    model: settings.model
  };
  const session =
    options.descriptor === undefined
      ? await sessions.create({ binding, provider: providerRuntime.providerId, model: providerRuntime.model })
      : await sessions.open(options.descriptor.id, binding);
  const projectExecutionPolicy =
    openedWorkspace.security.decide('project_execution_policy').kind === 'allowed';
  const sessionBinding = { repository: sessions, descriptor: session };
  const events = new JsonlEventRepository<AgentEvent>({ rootDir: workspace.runsDir, codec: agentEventCodec });
  const existingRunIds = new Set(await events.listRunIds());
  const activeConfiguration = projectExecutionPolicy ? options.configuration : undefined;
  const orientationGuidance = await loadInitialRepositoryGuidance(openedWorkspace);
  const gitObserver = await createGitObserver(workspace.runtimeDir);
  const orientation = await inspectRepositoryOrientation(
    openedWorkspace,
    orientationGuidance,
    activeConfiguration,
    gitObserver
  );
  const checkPlan = deriveAdmittedCheckPlan(orientation.proposedVerificationChecks);
  const authority = resolveCodingAuthority({
    requestedMode: options.permissionMode,
    trust: admittedTrustLevel(openedWorkspace.security.trustLevel),
    ...(activeConfiguration
      ? {
          project: {
            permissions: activeConfiguration.permissions,
            enabledTools: activeConfiguration.tools.enabled
          }
        }
      : {}),
    hasVerificationChecks: checkPlan.checks.length > 0
  });
  try {
    await fs.mkdir(workspace.artifactsDir, { recursive: true, mode: 0o700 });
    const artifactStore = new LocalArtifactRepository({ rootDir: workspace.artifactsDir });
    const estimator = new CompleteRequestEstimator();
    const inference = new InferenceService({
      provider: providerRuntime.provider,
      repository: new JsonlInferenceRepository({ rootDir: path.join(workspace.runtimeDir, 'inference') }),
      artifacts: artifactStore,
      budget: options.inferenceBudget ?? {
        maxInvocations: 128,
        maxPromptTokens: 2_000_000,
        maxCompletionTokens: 256_000
      }
    });
    const handoffs = new CodingHandoffService({
      state: openedWorkspace.privateState,
      runtimeDirectory: workspace.runtimeDir,
      root: openedWorkspace.fileRoot,
      events,
      artifacts: artifactStore
    });
    const runs = new AgentRunCoordinator(events);
    const history = new HistoryReader({ repository: sessions, session, events, artifacts: artifactStore });
    const notes = new JsonlNoteRepository({
      rootDir: path.join(workspace.runtimeDir, 'notes'),
      artifacts: artifactStore
    });
    let activeRuntime: AgentRuntime | undefined;
    let activeRunId: string | undefined;
    let activeTools: readonly CompiledToolDefinition[] = [];
    let activeContext: (() => Promise<readonly PromptContextItemInput[]>) | undefined;
    let providerActive = false;
    const context: ContextService = new ContextService({
      repository: sessions,
      session,
      history,
      notes,
      bootstrap: {
        maxBytes: 4 * 1024 * 1024,
        providerStrategyAvailable: async () => {
          if (
            !activeRunId ||
            providerActive ||
            !providerRuntime.provider.compileContextTransform ||
            !providerRuntime.provider.transformContextCompiled
          )
            return false;
          const profile = await providerRuntime.provider.describeModel(agent.state().configuration.model);
          return (profile.capabilities.protocol?.contextTransforms.length ?? 0) > 0;
        },
        historyRead: {
          history,
          isAvailable: () =>
            activeTools.some((tool) => tool.name === 'history_read') || activeRuntime === undefined
        },
        mandatorySources: async () =>
          (await history.view()).entries
            .filter((entry) => entry.type === 'input' || entry.type === 'steering')
            .map((entry) => sourceRef(session.id, entry)),
        schedule: async (request) => {
          if (activeRuntime === undefined)
            throw new Error('No active coding runtime can schedule a model context transition.');
          return activeRuntime.scheduleContextTransition(request);
        },
        validate: async (input) => {
          if (providerActive)
            throw new Error(
              'context_admission_failed: the provider has not reached a legal transition boundary.'
            );
          if (activeTools.length === 0)
            throw new Error(
              'context_admission_failed: start or resume a coding run before validating its complete tool catalog.'
            );
          const configured = agent.state().configuration;
          return createRuntimeContextBootstrapValidator({
            provider: providerRuntime.provider,
            nativeTransform: {
              inference,
              ownerId: () => {
                if (activeRunId === undefined)
                  throw new Error('A native context transformation requires an active coding run budget.');
                return activeRunId;
              }
            },
            model: configured.model,
            tools: () => activeTools,
            instructions: [
              {
                id: DEFAULT_CODING_CONTRACT.id,
                role: 'developer',
                content: DEFAULT_CODING_CONTRACT.content,
                priority: DEFAULT_CODING_CONTRACT.priority ?? 0
              }
            ],
            contextItems: async () => {
              if (activeContext) return activeContext();
              const guidance = await loadInitialRepositoryGuidance(
                openedWorkspace,
                options.configuration?.instructions.map((instruction) => instruction.path)
              );
              const currentOrientation = await inspectRepositoryOrientation(
                openedWorkspace,
                guidance,
                activeConfiguration,
                gitObserver
              );
              return Object.freeze([
                repositoryOrientationContext(currentOrientation),
                ...guidance.documents.map((document): PromptContextItemInput => ({
                  sourceUri: document.source.sourceUri,
                  sourceKind: 'external',
                  integrity: 'verified',
                  representation: 'full',
                  mediaType: 'text/markdown',
                  title: 'Current repository guidance',
                  content: document.content,
                  purpose: 'Current scope-bound repository guidance; cannot grant authority.'
                }))
              ]);
            },
            pendingCallIds: () =>
              activeRuntime
                ?.pendingToolCalls()
                .map((call) => call.callId ?? `${call.toolBatchId}:${String(call.callIndex)}`) ?? [],
            ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens })
          })(input);
        }
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
    const memoryNames = new Set(memoryTools.map((tool) => tool.name));
    const agent: AgentSession = new AgentSession({
      descriptor: sessionBinding.descriptor,
      expectedBinding: binding,
      repository: sessionBinding.repository,
      runs,
      context,
      notes,
      configuration: {
        provider: providerRuntime.providerId,
        model: providerRuntime.model,
        ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
        ...(settings.reasoning !== undefined ? { reasoning: settings.reasoning } : {}),
        ...(settings.responseFormat !== undefined ? { responseFormat: settings.responseFormat } : {})
      },
      async createRuntime(configuration, onProgress, runtimeContext) {
        if (configuration.provider !== providerRuntime.providerId)
          throw new Error(`Provider ${configuration.provider} is not available in this session runtime.`);
        existingRunIds.add(runtimeContext.runId);
        activeRunId = runtimeContext.runId;
        const preChangeSnapshot = await loadOrCapturePreChangeSnapshot({
          state: openedWorkspace.privateState,
          root: openedWorkspace.fileRoot,
          runId: runtimeContext.runId,
          resuming: runtimeContext.resuming,
          observeVersionControl: () => inspectRepositoryVersionControl(openedWorkspace, gitObserver)
        });
        const runCheckPlan = await loadOrAdmitCheckPlan({
          state: openedWorkspace.privateState,
          runId: runtimeContext.runId,
          resuming: runtimeContext.resuming,
          proposed: deriveAdmittedCheckPlan(
            (
              await inspectRepositoryOrientation(
                openedWorkspace,
                await loadInitialRepositoryGuidance(openedWorkspace),
                activeConfiguration,
                gitObserver
              )
            ).proposedVerificationChecks
          )
        });
        const mutable = authority.mode !== 'review';
        const workingCopy = mutable
          ? await IsolatedWorkingCopy.open({
              source: openedWorkspace.fileRoot,
              preChange: preChangeSnapshot.workspace,
              runtimeDirectory: workspace.runtimeDir,
              runId: runtimeContext.runId
            })
          : undefined;
        const runRoot =
          workingCopy?.root ??
          RootedFileAuthority.adopt(openedWorkspace.fileRoot.identity.canonicalPath, {
            additionalDeniedEntries: ['.git', '.coding-agent']
          });
        const runIdentity = createHash('sha256').update(runtimeContext.runId).digest('hex');
        const patchEnabled = authority.enabledTools.includes('apply_patch');
        const commandEnabled = authority.permissions.commandExecution === 'sandboxed';
        const patchJournalPath = path.join(
          workspace.runtimeDir,
          'run-tools',
          runIdentity,
          'patch-transactions'
        );
        if (patchEnabled) await fs.mkdir(patchJournalPath, { recursive: true, mode: 0o700 });
        let localHost: ReturnType<typeof createLocalToolHost> | undefined;
        try {
          const initialGuidance = runtimeContext.resuming
            ? undefined
            : await loadInitialRepositoryGuidanceFromRoot(
                runRoot,
                openedWorkspace.security,
                options.configuration?.instructions.map((instruction) => instruction.path)
              );
          const repositoryGuidance = await RepositoryGuidanceSession.open({
            root: runRoot,
            security: openedWorkspace.security,
            state: openedWorkspace.privateState,
            runId: runtimeContext.runId,
            ...(initialGuidance ? { initial: initialGuidance } : {}),
            resuming: runtimeContext.resuming
          });
          const commandExecution = commandEnabled
            ? await createCodingCommandAuthority({
                repositoryDirectory: path.join(
                  workspace.runtimeDir,
                  'run-tools',
                  runIdentity,
                  'sandbox-commands'
                ),
                rootedFileAuthority: runRoot,
                state: openedWorkspace.privateState
              })
            : undefined;
          localHost = createLocalToolHost({
            rootedFileAuthority: runRoot,
            artifactRepository: artifactStore,
            ...(commandExecution ? { commandExecution } : {}),
            ...(patchEnabled ? { patchJournal: TextPatchJournal.adopt(patchJournalPath) } : {}),
            enabledTools: authority.enabledTools,
            async deliverRecoveredTerminalReport(report) {
              const runId = report.result.owner.runId;
              if (!existingRunIds.has(runId)) return false;
              await events.append(
                runId,
                {
                  type: 'process.ended',
                  runId,
                  processId: report.result.processId,
                  status: report.result.status,
                  result: parseJsonValue(report)
                },
                { idempotencyKey: `${runId}:process:${report.result.processId}:ended` }
              );
              const terminal = await events.latestOfType(runId, 'run.ended');
              return terminal?.event.type === 'run.ended';
            }
          });
          await localHost.ready();
          const reconciliation = await localHost.reconciliation();
          if (reconciliation.unresolved.length > 0) {
            throw new Error(
              'Unresolved sandbox command execution blocks this run: ' +
                reconciliation.unresolved.map((item) => `${item.processId}: ${item.diagnostic}`).join('; ')
            );
          }
          const createCheckCommandExecution = ({
            root,
            repositoryDirectory
          }: {
            readonly root: RootedFileAuthority;
            readonly repositoryDirectory: string;
          }) =>
            createCodingCommandAuthority({
              repositoryDirectory,
              rootedFileAuthority: root,
              state: openedWorkspace.privateState
            });
          const preChangeObservations = !mutable
            ? Object.freeze([])
            : await loadOrObservePreChangeCommands({
                state: openedWorkspace.privateState,
                runId: runtimeContext.runId,
                resuming: runtimeContext.resuming,
                plan: runCheckPlan,
                preChange: preChangeSnapshot.workspace,
                observe: () =>
                  observePreChangeCommands({
                    plan: runCheckPlan,
                    runId: runtimeContext.runId,
                    root: runRoot,
                    snapshot: preChangeSnapshot.workspace,
                    runtimeDirectory: workspace.runtimeDir,
                    createCommandExecution: createCheckCommandExecution,
                    commandYieldMs: DEFAULT_LOCAL_TOOL_CONFIGURATION.process.maxYieldMs
                  })
              });
          const checks = !mutable
            ? Object.freeze([])
            : createCandidateAcceptanceChecks({
                plan: runCheckPlan,
                runId: runtimeContext.runId,
                root: runRoot,
                preChange: preChangeSnapshot.workspace,
                preChangeObservations,
                runtimeDirectory: workspace.runtimeDir,
                createCommandExecution: createCheckCommandExecution,
                commandYieldMs: DEFAULT_LOCAL_TOOL_CONFIGURATION.process.maxYieldMs
              });
          const host = localHost;
          activeTools = Object.freeze([...host.tools, ...memoryTools]);
          activeContext = async () => {
            const guidance = await repositoryGuidance.contextItems();
            const currentOrientation = await inspectRepositoryOrientation(
              openedWorkspace,
              await loadInitialRepositoryGuidance(openedWorkspace),
              activeConfiguration,
              gitObserver
            );
            const currentState = await codingSessionBoundaryContext({
              root: runRoot,
              sourceRoot: openedWorkspace.fileRoot,
              state: openedWorkspace.privateState,
              runId: runtimeContext.runId,
              events,
              sessions,
              session,
              handoffs,
              checkPlan: runCheckPlan
            });
            return Object.freeze([
              ...guidance,
              repositoryOrientationContext(currentOrientation),
              currentState
            ]);
          };
          activeRuntime = new AgentRuntime({
            provider: providerRuntime.provider,
            inferenceService: inference,
            context,
            notes,
            contextPressurePolicy: async () => codingHistoryPressureTransition(await history.view()),
            model: configuration.model,
            toolBoundary: {
              authorizationPolicyId: `coding-agent/${authority.mode}/${openedWorkspace.security.trustLevel}@2`,
              executionTargetId:
                commandExecution?.descriptor.recoveryIdentity ??
                workingCopy?.descriptor.workingCopyId ??
                `${workspace.identity.id}:review-only`
            },
            repositories: { events, session: sessionBinding, artifacts: artifactStore },
            estimator,
            ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
            tools: activeTools,
            toolContext: { services: host.services },
            toolPolicy: {
              allowedRisks: [...new Set([...authority.toolPolicy.allowedRisks, 'write' as const])]
            },
            toolAuthorizer: async (request) => {
              if (memoryNames.has(request.call.name))
                return {
                  decision: 'allow',
                  reason:
                    'The host-bound tool accesses only this session’s original history, generated notes, or governed context transitions.'
                };
              const trustDecision = openedWorkspace.security.authorizeTool(request);
              if (trustDecision.decision === 'deny') return trustDecision;
              const guidanceDecision = await repositoryGuidance.authorize(request);
              if (guidanceDecision) return guidanceDecision;
              if (trustDecision.decision === 'require_approval') return trustDecision;
              const approvalKinds = request.effects.accesses
                .map((access) => approvalKind(accessRisk(access.mode)))
                .filter(
                  (kind): kind is CodingApprovalKind =>
                    kind !== undefined && authority.requiredApprovals.includes(kind)
                );
              return approvalKinds.length > 0
                ? {
                    decision: 'require_approval' as const,
                    reason: `The active permission boundary requires approval for ${[...new Set(approvalKinds)].join(', ')}.`
                  }
                : { decision: 'allow' as const, reason: 'Allowed by workspace policy.' };
            },
            instructions: repositoryGuidance.initialInstructions(),
            contextProvider: () => {
              if (!activeContext) throw new Error('Coding boundary context is unavailable.');
              return activeContext();
            },
            ...(checks.length > 0 ? { checks } : {}),
            disposition: createCodingDisposition({
              ...(workingCopy ? { workingCopy } : {}),
              mutable,
              requiredCoverage: runCheckPlan.requiredCoverage
            }),
            ...(projectExecutionPolicy && options.configuration?.limits
              ? { limits: options.configuration.limits }
              : {}),
            metadata: {
              workspaceId: workspace.identity.id,
              workspaceName: workspace.workspaceName,
              workspaceTrust: openedWorkspace.security.trustLevel,
              checkPlanImplementationId: runCheckPlan.implementationId,
              checkPlanRequiredCoverage: runCheckPlan.requiredCoverage,
              ...(options.configurationSource
                ? {
                    projectConfigurationSource: options.configurationSource.sourceUri,
                    projectConfigurationSha256: options.configurationSource.sha256,
                    projectConfigurationTrust: options.configurationSource.trustLevel
                  }
                : {})
            },
            ...(configuration.temperature !== undefined ? { temperature: configuration.temperature } : {}),
            ...(configuration.reasoning !== undefined ? { reasoning: configuration.reasoning } : {}),
            ...(configuration.responseFormat !== undefined
              ? { responseFormat: configuration.responseFormat }
              : {}),
            onProgress: async (event) => {
              if (event.type === 'assistant.started') providerActive = true;
              else if (
                event.type === 'assistant.ended' ||
                event.type === 'assistant.interrupted' ||
                event.type === 'model.failed'
              )
                providerActive = false;
              await onProgress(event);
            },
            release: async () => {
              try {
                await host.close();
              } finally {
                activeRuntime = undefined;
                activeRunId = undefined;
                activeContext = undefined;
                providerActive = false;
                await workingCopy?.release();
              }
            }
          });
          return activeRuntime;
        } catch (error) {
          if (localHost) await localHost.close().catch(() => undefined);
          else runRoot.close();
          await workingCopy?.release().catch(() => undefined);
          throw error;
        }
      }
    });
    agent.subscribe((event) =>
      event.type === 'run.completed' && event.result.state === 'ended'
        ? handoffs.finalize(event.runId, event.result).then(() => undefined)
        : undefined
    );
    return {
      agent,
      inference,
      history,
      notes,
      context,
      runs,
      events,
      sessions: sessionBinding.repository,
      session: sessionBinding.descriptor,
      permissions: authority.permissions,
      gitObserver,
      handoffs
    };
  } catch (error) {
    await gitObserver.close().catch(() => undefined);
    throw error;
  }
}

function admittedTrustLevel(value: OpenCodingWorkspace['security']['trustLevel']): 'restricted' | 'trusted' {
  if (value === 'restricted' || value === 'trusted') return value;
  throw new Error('Runtime creation requires an admitted workspace.');
}

function platformGitExecutable(): string {
  if (process.platform === 'win32')
    return path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe');
  return '/usr/bin/git';
}

async function createGitObserver(runtimeDirectory: string): Promise<GitRepositoryObserver> {
  try {
    const repository = await openSandboxExecutionRepository({
      directory: path.join(runtimeDirectory, 'git-observations'),
      maxRetainedOutputBytes: 2 * 1024 * 1024,
      completedRetentionMs: 60 * 60 * 1_000,
      expiredIdentityRetentionMs: 24 * 60 * 60 * 1_000
    });
    return new SandboxGitRepositoryObserver({ repository, gitExecutable: platformGitExecutable() });
  } catch {
    return unavailableGitRepositoryObserver();
  }
}

function approvalKind(risk: ReturnType<typeof accessRisk>): CodingApprovalKind | undefined {
  if (risk === 'write') return 'write';
  if (risk === 'destructive') return 'delete';
  if (risk === 'execute') return 'command';
  return undefined;
}

export async function closeCodingSession(runtime: CodingSessionComposition): Promise<void> {
  const failures: unknown[] = [];
  try {
    await runtime.handoffs.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await runtime.gitObserver.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Coding Agent runtime cleanup failed.');
}

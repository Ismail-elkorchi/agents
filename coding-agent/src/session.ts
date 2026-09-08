import { CompleteRequestEstimator, type ModelProvider } from '@agent-core/model';
import { hashJson } from '@agent-core/persistence';
import { JsonlEventRepository, LocalArtifactRepository } from '@agent-core/persistence/node';
import {
  AgentRunCoordinator,
  AgentRuntime,
  AgentSession,
  ContextService,
  EffectExecutor,
  HistoryReader,
  InferenceService,
  agentEventCodec,
  createContextTools,
  createHistoryTools,
  createNotesTools,
  createObservationAccess,
  createRuntimeContextBootstrapValidator,
  effectExecutionEventCodec,
  sourceRef,
  type AgentEndedRunResult,
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
import {
  accessRisk,
  commandExecutionResources,
  commandReleaseReport,
  type CompiledToolDefinition
} from '@agent-core/tools';
import {
  DEFAULT_LOCAL_TOOL_CONFIGURATION,
  RootedFileAuthority,
  TextPatchJournal,
  createLocalToolHost
} from '@agent-core/tools-local';
import { openSandboxExecutionRepository } from '@ismail-elkorchi/sandbox';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CodingHandoffService } from './changes/coding-handoff-service.js';
import { IsolatedWorkingCopy } from './changes/isolated-working-copy.js';
import {
  loadOrCapturePreChangeSnapshot,
  loadPreChangeSnapshot
} from './changes/pre-change-snapshot-store.js';
import { CodingSession } from './coding-session.js';
import type { CodingAgentConfiguration } from './configuration.js';
import {
  CODING_COMMAND_ENVIRONMENT_POLICY_ID,
  createCodingCommandAuthority
} from './execution/coding-command-authority.js';
import { DEFAULT_CODING_CONTRACT } from './instructions/coding-contract.js';
import {
  RepositoryGuidanceSession,
  loadInitialRepositoryGuidance,
  loadInitialRepositoryGuidanceFromRoot
} from './instructions/repository-guidance.js';
import { CodingOutcomeRepository, codingOutcomeEventCodec, type CodingEndedRunResult } from './outcome.js';
import {
  resolveCodingAuthority,
  type CodingApprovalKind,
  type CodingAuthority,
  type CodingPermissionMode
} from './security/permission-mode.js';
import { codingSessionBoundaryContext } from './session-context.js';
import {
  createRevisionAcceptanceChecks,
  deriveAdmittedCheckPlan,
  observePreChangeCommands
} from './verification/revision-acceptance-checks.js';
import { loadOrAdmitCheckPlan } from './verification/check-plan-store.js';
import { settleCodingWork } from './verification/settlement.js';
import {
  CodingWorkRepository,
  codingWorkContextAnchors,
  codingWorkEventCodec,
  type CodingWork
} from './work.js';
import { codingWorkspaceSessionBinding, type OpenCodingWorkspace } from './workspace.js';
import {
  unavailableGitRepositoryObserver,
  type GitRepositoryObserver
} from './workspace/git/repository-observer.js';
import { SandboxGitRepositoryObserver } from './workspace/git/sandbox-git-observer.js';
import {
  inspectRepositoryOrientation,
  inspectRepositoryVersionControl,
  repositoryOrientationContext
} from './workspace/repository-orientation.js';

export interface CodingSessionOptions {
  readonly workspace: OpenCodingWorkspace;
  readonly provider: ModelProvider;
  readonly settings: AgentSessionConfiguration;
  readonly permissionMode: CodingPermissionMode;
  readonly descriptor?: SessionDescriptor;
  readonly maxOutputTokens?: number;
  readonly inferenceBudget?: InferenceBudget;
  readonly work?: { readonly kind: 'new' } | { readonly kind: 'continue'; readonly workId: string };
  readonly configuration?: CodingAgentConfiguration;
  readonly configurationSource?: {
    readonly sourceUri: string;
    readonly sha256: string;
    readonly trustLevel: 'restricted' | 'trusted';
  };
}

/** Reusable application composition shared by CLI, TUI, and programmatic consumers. */
export interface CodingSessionComposition {
  readonly agent: CodingSession;
  readonly outcomes: CodingOutcomeRepository;
  closeResources(): Promise<void>;
  readonly work: CodingWorkRepository;
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

export async function createCodingSession(
  options: CodingSessionOptions
): Promise<CodingSessionComposition> {
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
      ? await sessions.create({
          binding,
          provider: providerRuntime.providerId,
          model: providerRuntime.model
        })
      : await sessions.open(options.descriptor.id, binding);
  const projectExecutionPolicy =
    openedWorkspace.security.decide('project_execution_policy').kind === 'allowed';
  const sessionBinding = { repository: sessions, descriptor: session };
  const events = new JsonlEventRepository<AgentEvent>({
    rootDir: workspace.runsDir,
    codec: agentEventCodec
  });
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
    const effects = new EffectExecutor(
      new JsonlEventRepository({
        rootDir: path.join(workspace.runtimeDir, 'effects'),
        codec: effectExecutionEventCodec
      })
    );
    const outcomes = new CodingOutcomeRepository(
      new JsonlEventRepository({
        rootDir: path.join(workspace.runtimeDir, 'outcomes'),
        codec: codingOutcomeEventCodec
      })
    );
    const workHosts = new Map<
      string,
      {
        host: ReturnType<typeof createLocalToolHost>;
        root: RootedFileAuthority;
        workingCopy: IsolatedWorkingCopy | undefined;
        ownerId: string;
      }
    >();
    const releaseWorkHost = async (workId: string): Promise<void> => {
      let owned = workHosts.get(workId);
      if (!owned) {
        const repositoryDirectory = path.join(
          workspace.runtimeDir,
          'work-tools',
          createHash('sha256').update(workId).digest('hex'),
          'sandbox-commands'
        );
        try {
          await fs.stat(repositoryDirectory);
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
          throw error;
        }
        const admitted = await work.read(workId);
        const preChange = await loadPreChangeSnapshot(openedWorkspace.privateState, workId);
        const workingCopy = await IsolatedWorkingCopy.open({
          source: openedWorkspace.fileRoot,
          preChange: preChange.workspace,
          runtimeDirectory: workspace.runtimeDir,
          workId
        });
        try {
          const commandExecution = await createCodingCommandAuthority({
            repositoryDirectory,
            rootedFileAuthority: workingCopy.root,
            state: openedWorkspace.privateState
          });
          owned = {
            host: createLocalToolHost({
              rootedFileAuthority: workingCopy.root,
              artifactRepository: artifactStore,
              commandExecution,
              enabledTools: []
            }),
            root: workingCopy.root,
            workingCopy,
            ownerId: admitted.ownerId
          };
          workHosts.set(workId, owned);
        } catch (error) {
          await workingCopy.release();
          throw error;
        }
      }
      if (owned.host.commandExecution) {
        let unknown = false;
        for (const report of await owned.host.commandExecution.disposeOwner(owned.ownerId)) {
          const runId = report.result.owner.runId;
          const release = commandReleaseReport(report);
          await events.append(
            runId,
            { type: 'resource.released', runId, ...release },
            {
              idempotencyKey: `${runId}:resource:${report.result.processId}:released:${hashJson(commandReleaseReport(report))}`
            }
          );
          if (release.outcome === 'unknown') unknown = true;
          else await owned.host.commandExecution.acknowledgeTerminalReport(report.result.processId);
        }
        if (unknown) throw new Error('Coding work resources require release reconciliation.');
      }
      await owned.host.close();
      await owned.workingCopy?.release();
      workHosts.delete(workId);
    };
    const settleRuns = new Map<
      string,
      (execution: AgentEndedRunResult, signal: AbortSignal) => Promise<CodingEndedRunResult>
    >();
    const work = new CodingWorkRepository(
      new JsonlEventRepository({
        rootDir: path.join(workspace.runtimeDir, 'work'),
        codec: codingWorkEventCodec
      })
    );
    let activeWork: CodingWork | undefined;
    let selection = options.work;
    const handoffs = new CodingHandoffService({
      work,
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
        mandatorySources: async () => {
          const view = await history.view();
          const current =
            activeWork === undefined ? undefined : await work.synchronizeHistory(activeWork.workId, view);
          return current === undefined
            ? []
            : codingWorkContextAnchors(current, view.entries).map((entry) => sourceRef(session.id, entry));
        },
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
                if (!activeWork) throw new Error('Coding work budget is unavailable.');
                return activeWork.ownerId;
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
                ...guidance.documents.map(
                  (document): PromptContextItemInput => ({
                    sourceUri: document.source.sourceUri,
                    sourceKind: 'external',
                    integrity: 'verified',
                    representation: 'full',
                    mediaType: 'text/markdown',
                    title: 'Current repository guidance',
                    content: document.content,
                    purpose: 'Current scope-bound repository guidance; cannot grant authority.'
                  })
                )
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
    const sessionOptions: AgentSessionOptions = {
      scheduling: 'manual',
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
        const priorWork = await work.forRun(runtimeContext.runId);
        const submission = (
          await sessionBinding.repository.loadPendingSubmissions(sessionBinding.descriptor)
        ).find((item) => item.submissionId === runtimeContext.submissionId);
        const review =
          priorWork?.mode === 'review' || submission?.input.relationship?.kind === 'side_question';
        const runAuthority = review
          ? resolveCodingAuthority({
              requestedMode: 'review',
              trust: authority.permissions.trust,
              project: {
                permissions: { maximumMode: 'review', requireApprovalFor: [] },
                enabledTools: authority.enabledTools
              },
              hasVerificationChecks: false
            })
          : authority;
        const mutable = runAuthority.mode !== 'review';
        activeWork = await work.admit({
          sessionId: session.id,
          sourceId: workspace.identity.id,
          mode: mutable ? 'revision' : 'review',
          runId: runtimeContext.runId,
          submissionId: runtimeContext.submissionId,
          task: runtimeContext.input.task,
          ...(selection === undefined || review ? {} : { selection })
        });
        if (!review) selection = undefined;
        const currentWork = activeWork;
        const preChangeSnapshot = mutable
          ? await loadOrCapturePreChangeSnapshot({
              state: openedWorkspace.privateState,
              root: openedWorkspace.fileRoot,
              workId: currentWork.workId,
              resuming: currentWork.baselineDigest !== undefined,
              observeVersionControl: () => inspectRepositoryVersionControl(openedWorkspace, gitObserver)
            })
          : undefined;
        const runCheckPlan = mutable
          ? await loadOrAdmitCheckPlan({
              state: openedWorkspace.privateState,
              workId: currentWork.workId,
              resuming: currentWork.checkPlanId !== undefined,
              proposed: deriveAdmittedCheckPlan(
                (
                  await inspectRepositoryOrientation(
                    openedWorkspace,
                    await loadInitialRepositoryGuidance(openedWorkspace),
                    activeConfiguration,
                    gitObserver
                  )
                ).proposedVerificationChecks,
                preChangeSnapshot === undefined
                  ? undefined
                  : {
                      snapshot: preChangeSnapshot.workspace,
                      environmentPolicyId: CODING_COMMAND_ENVIRONMENT_POLICY_ID
                    }
              )
            })
          : deriveAdmittedCheckPlan([]);
        if (preChangeSnapshot)
          activeWork = await work.bindRevision(
            currentWork.workId,
            preChangeSnapshot.workspace.digest,
            runCheckPlan.implementationId
          );
        const cachedHost = workHosts.get(currentWork.workId);
        const workingCopy =
          cachedHost?.workingCopy ??
          (preChangeSnapshot
            ? await IsolatedWorkingCopy.open({
                source: openedWorkspace.fileRoot,
                preChange: preChangeSnapshot.workspace,
                runtimeDirectory: workspace.runtimeDir,
                workId: currentWork.workId
              })
            : undefined);
        const runRoot =
          cachedHost?.root ??
          workingCopy?.root ??
          RootedFileAuthority.adopt(openedWorkspace.fileRoot.identity.canonicalPath, {
            additionalDeniedEntries: ['.git', '.coding-agent']
          });
        const runIdentity = createHash('sha256').update(currentWork.workId).digest('hex');
        const patchEnabled = runAuthority.enabledTools.includes('apply_patch');
        const commandEnabled = runAuthority.permissions.commandExecution === 'sandboxed';
        const patchJournalPath = path.join(
          workspace.runtimeDir,
          'work-tools',
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
          const commandExecution =
            cachedHost?.host.commandExecution ??
            (commandEnabled
              ? await createCodingCommandAuthority({
                  repositoryDirectory: path.join(
                    workspace.runtimeDir,
                    'work-tools',
                    runIdentity,
                    'sandbox-commands'
                  ),
                  rootedFileAuthority: runRoot,
                  state: openedWorkspace.privateState
                })
              : undefined);
          localHost =
            cachedHost?.host ??
            createLocalToolHost({
              rootedFileAuthority: runRoot,
              artifactRepository: artifactStore,
              ...(commandExecution ? { commandExecution } : {}),
              ...(patchEnabled ? { patchJournal: TextPatchJournal.adopt(patchJournalPath) } : {}),
              enabledTools: runAuthority.enabledTools,
              async deliverRecoveredTerminalReport(report) {
                const runId = report.result.owner.runId;
                if (!existingRunIds.has(runId)) return false;
                await events.append(
                  runId,
                  {
                    type: 'resource.released',
                    runId,
                    ...commandReleaseReport(report)
                  },
                  {
                    idempotencyKey: `${runId}:resource:${report.result.processId}:released:${hashJson(commandReleaseReport(report))}`
                  }
                );
                const terminal = await events.latestOfType(runId, 'run.ended');
                return terminal?.event.type === 'run.ended';
              }
            });
          await localHost.ready();
          workHosts.set(currentWork.workId, {
            host: localHost,
            root: runRoot,
            workingCopy,
            ownerId: currentWork.ownerId
          });
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
          const preChangeObservations =
            !preChangeSnapshot || !workingCopy
              ? Object.freeze([])
              : await workingCopy.withPreChangeRoot((root) =>
                  observePreChangeCommands({
                    effects,
                    ownerId: currentWork.ownerId,
                    plan: runCheckPlan,
                    runId: runtimeContext.runId,
                    root,
                    snapshot: preChangeSnapshot.workspace,
                    runtimeDirectory: workspace.runtimeDir,
                    createCommandExecution: createCheckCommandExecution,
                    commandYieldMs: DEFAULT_LOCAL_TOOL_CONFIGURATION.process.maxYieldMs
                  })
                );
          const checks = !preChangeSnapshot
            ? Object.freeze([])
            : createRevisionAcceptanceChecks({
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
            await work.synchronizeHistory(currentWork.workId, await history.view());
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
              outcomes,
              checkPlan: runCheckPlan,
              work: await work.read(currentWork.workId)
            });
            return Object.freeze([
              ...guidance,
              repositoryOrientationContext(currentOrientation),
              currentState
            ]);
          };
          settleRuns.set(runtimeContext.runId, async (execution, signal) => {
            const response = await events.latestOfType(runtimeContext.runId, 'assistant.ended');
            return settleCodingWork({
              execution,
              work: await work.read(currentWork.workId),
              checks,
              requiredCoverage: runCheckPlan.requiredCoverage,
              ...(workingCopy ? { workingCopy } : {}),
              effects,
              outcomes,
              ...(response?.event.type === 'assistant.ended'
                ? {
                    context: {
                      runId: runtimeContext.runId,
                      task: runtimeContext.input.task,
                      instructions: [],
                      turnId: response.event.turnId,
                      turnIndex: response.event.turnIndex,
                      requestAttempt: response.event.requestAttempt,
                      metadata: { workId: currentWork.workId },
                      signal,
                      execution: createObservationAccess({
                        events,
                        runId: runtimeContext.runId,
                        artifacts: artifactStore
                      })
                    }
                  }
                : {})
            });
          });
          activeRuntime = new AgentRuntime({
            provider: providerRuntime.provider,
            inferenceService: inference,
            context,
            notes,
            inferenceOwnerId: currentWork.ownerId,
            model: configuration.model,
            toolBoundary: {
              authorizationPolicyId: `coding-agent/${runAuthority.mode}/${openedWorkspace.security.trustLevel}@2`,
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
            ...(host.commandExecution
              ? {
                  resources: commandExecutionResources(host.commandExecution, {
                    kind: 'owner',
                    ownerId: currentWork.ownerId
                  })
                }
              : {}),
            toolPolicy: {
              allowedRisks: [...new Set([...runAuthority.toolPolicy.allowedRisks, 'write' as const])]
            },
            toolContextPrerequisite: (request) =>
              memoryNames.has(request.call.name)
                ? Promise.resolve(undefined)
                : repositoryGuidance.contextPrerequisite(request),
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
                    kind !== undefined && runAuthority.requiredApprovals.includes(kind)
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
            ...(projectExecutionPolicy && options.configuration?.limits
              ? { limits: options.configuration.limits }
              : {}),
            metadata: {
              workId: currentWork.workId,
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
            release: () => {
              activeRuntime = undefined;
              activeRunId = undefined;
              activeContext = undefined;
              providerActive = false;
              return Promise.resolve();
            }
          });
          return activeRuntime;
        } catch (error) {
          if (cachedHost) throw error;
          workHosts.delete(currentWork.workId);
          const failures: unknown[] = [error];
          try {
            if (localHost) await localHost.close();
            else runRoot.close();
          } catch (cleanupError) {
            failures.push(cleanupError);
          }
          try {
            await workingCopy?.release();
          } catch (cleanupError) {
            failures.push(cleanupError);
          }
          if (failures.length > 1)
            throw new AggregateError(failures, 'Coding runtime construction and resource release failed.', {
              cause: error
            });
          throw error;
        }
      }
    };
    const agent = new CodingSession(new AgentSession(sessionOptions), {
      async readExecution(runId) {
        const admitted = await work.forRun(runId);
        if (admitted?.sessionId !== session.id)
          throw new Error('Coding execution is outside this session.');
        const ended = await events.latestOfType(runId, 'run.ended');
        if (ended?.event.type !== 'run.ended')
          throw new Error('Coding reconciliation requires its committed execution outcome.');
        return { state: 'ended', terminal: ended.event.terminal, deliveryDiagnostics: [] };
      },
      async settle(execution, signal) {
        const runId = execution.terminal.runId;
        const recorded = await outcomes.read(runId);
        let result: CodingEndedRunResult;
        if (recorded?.stage === 'settled') result = { ...execution, outcome: recorded };
        else {
          if (!settleRuns.has(runId)) {
            const inspection = await runs.inspect(runId);
            const admitted = await work.forRun(runId);
            const contribution = admitted?.requirementSources.find((item) => item.runId === runId);
            if (contribution === undefined)
              throw new Error('Coding recovery requires the original admitted contribution.');
            await sessionOptions.createRuntime(settings, () => undefined, {
              runId,
              submissionId: contribution.submissionId,
              resuming: true,
              input: { ...inspection.state.input, runId }
            });
          }
          const settle = settleRuns.get(runId);
          if (settle === undefined) throw new Error('Coding work settlement is unavailable.');
          result = await settle(execution, signal);
        }
        if (result.outcome.publication === 'applied') await releaseWorkHost(result.outcome.workId);
        if (result.outcome.publication !== 'not_applicable' && result.outcome.stage === 'settled')
          await handoffs.finalize(runId, result);
        return result;
      },
      async recover() {
        const results: AgentEndedRunResult[] = [];
        for (const runId of existingRunIds) {
          const admitted = await work.forRun(runId);
          if (admitted?.sessionId !== session.id) continue;
          if (
            (await outcomes.read(runId))?.stage === 'settled' &&
            (admitted.mode === 'review' || (await handoffs.read(runId)))
          )
            continue;
          const ended = await events.latestOfType(runId, 'run.ended');
          if (ended?.event.type === 'run.ended')
            results.push({ state: 'ended', terminal: ended.event.terminal, deliveryDiagnostics: [] });
        }
        return results;
      }
    });
    return {
      agent,
      outcomes,
      async closeResources() {
        const released = await Promise.allSettled([...workHosts.keys()].map(releaseWorkHost));
        const failures = released
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason as unknown);
        if (failures.length > 0)
          throw new AggregateError(failures, 'Coding resource release remains incomplete.');
      },
      work,
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

function admittedTrustLevel(
  value: OpenCodingWorkspace['security']['trustLevel']
): 'restricted' | 'trusted' {
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
    await runtime.closeResources();
  } catch (error) {
    failures.push(error);
  }
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

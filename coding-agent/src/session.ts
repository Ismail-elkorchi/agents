import type { NativeToolExposure } from '@agent-core/runtime';
import { resolveRuntimeToolCatalog, SessionToolCatalogSelectionStore } from '@agent-core/runtime';
import { createProgrammaticTool } from '@agent-core/tools-programmatic';
import { createQuickJSProgramRunner } from '@agent-core/tools-programmatic/node';
import { createConfiguredWebTools } from '@agent-core/tools-web/node';
import { createConfiguredMcpSources } from '@agent-core/tools-mcp/node';
import { ToolCatalog, type CompiledToolDefinition } from '@agent-core/tools';
import type { ProgramLimits } from '@agent-core/tools-programmatic';
import type { WebConfiguration } from '@agent-core/tools-web';
import type { NodeMcpConfiguration } from '@agent-core/tools-mcp/node';
import { RequestTokenEstimator, type ModelProvider } from '@agent-core/model';
import { JsonlEventRepository, LocalArtifactRepository } from '@agent-core/persistence/node';
import { hashJson, sameArtifactIdentity, type ArtifactRepository } from '@agent-core/persistence';
import {
  AgentRunCoordinator,
  CollaborationCoordinator,
  parseCollaborationPolicy,
  createCollaborationTools,
  createCollaborationToolHost,
  createCollaborationToolSource,
  createCollaborationPeerDelivery,
  createParticipantArtifactRepository,
  type ParticipantArtifactRepository,
  peerDeliveryEventCodec,
  type PeerDeliveryEvent,
  type SessionPeerContributionEntry,
  authorizeSessionToolEffects,
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
  type SessionDescriptor,
  type ParticipantExecutionBinding,
  type CollaborationPolicy
} from '@agent-core/runtime';
import { JsonlInferenceRepository, JsonlSessionRepository, JsonlCollaborationRepository } from '@agent-core/runtime/node';
import {
  commandExecutionResources,
  type ToolPolicy,
} from '@agent-core/tools';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { CodingAgentConfiguration } from './configuration.js';
import { openCodingWorkspaceResources, type CodingWorkspaceResources } from './execution/workspace-resources.js';
import { processControls } from './execution/process-controls.js';
import { recoveredCommandContext } from './execution/recovered-command-context.js';
import {
  createLocalToolHost,
  TextPatchJournal,
  type RootedFileAuthority
} from '@agent-core/tools-local';
import { RepositoryGuidanceSession } from './instructions/repository-guidance.js';
import {
  isCodingWorkspaceMutatingTool,
  resolveCodingAuthority,
  type CodingAuthority,
  type CodingPermissionMode
} from './security/permission-mode.js';
import { createConfiguredCheckTool } from './verification/configured-check-tool.js';
import { codingWorkspaceSessionBinding, type OpenCodingWorkspace } from './workspace.js';

export interface CodingSessionOptions {
  readonly workspace: OpenCodingWorkspace;
  /** Borrowed by participant sessions. The supervisor closes this host after children settle. */
  readonly workspaceResources?: CodingWorkspaceResources;
  readonly provider: ModelProvider;
  readonly resolveProvider?: (configuration: AgentSessionConfiguration) => ModelProvider;
  readonly settings: AgentSessionConfiguration;
  readonly permissionMode: CodingPermissionMode;
  readonly collaboration?: false | Partial<CollaborationPolicy>;
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

interface CodingParticipantOptions extends CodingSessionOptions {
  readonly artifactRepository?: ParticipantArtifactRepository;
  readonly participant?: ParticipantExecutionBinding;
  readonly withSubmissionAdmission?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly withSupervisorExecution?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly allowedToolNames?: readonly string[];
  readonly collaborationTools?: (session: SessionDescriptor, names: readonly string[]) => readonly CompiledToolDefinition[];
  readonly participantBudget?: InferenceBudget;
  readonly participantContext?: PromptContextItemInput;
  readonly authorizePeerContribution?: (entry: SessionPeerContributionEntry, stage: 'read' | 'admit') => Promise<void>;
}

const catalogControls = ['tool_catalog_discover', 'tool_catalog_select'];
const observerTools = ['collaboration_inspect', 'collaboration_result', 'collaboration_send', 'collaboration_wait', ...catalogControls];

/** Host-owned collaboration shares execution resources, never a provider conversation. */
export async function createCodingSession(options: CodingSessionOptions) {
  const configured = options.collaboration ?? (options.workspace.security.decide('project_execution_policy').kind === 'allowed'
    ? options.configuration?.collaboration : undefined);
  const policy = configured === false ? undefined : parseCollaborationPolicy(configured);
  let collaboration: CollaborationCoordinator | undefined;
  let peer: ReturnType<typeof createCollaborationPeerDelivery> | undefined;
  const participants = new Map<string, Awaited<ReturnType<typeof composeCodingSession>>>();
  const recoveredOwners = new Map<string, () => Promise<void>>();
  const coordinator = () => {
    if (!collaboration) throw new Error('Collaboration host is not ready.');
    return collaboration;
  };
  const root = await composeCodingSession({ ...options,
    withSubmissionAdmission: operation => collaboration ? collaboration.withSupervisorSubmission(operation) : operation(),
    ...(policy ? {
      withSupervisorExecution: <T>(operation: () => Promise<T>) => coordinator().withSupervisorExecution(operation),
      authorizePeerContribution: (entry: SessionPeerContributionEntry, stage: 'read' | 'admit') => {
        if (!peer) throw new Error('Peer delivery host is not ready.');
        return peer.authorizeContribution(entry, stage);
      },
      collaborationTools: (session: SessionDescriptor, names: readonly string[]) => {
        const childCollaboration = { actions: ['inspect', 'message'] as const,
          participantIds: [`supervisor:${session.id}`] };
        const toolNames = [...names, ...observerTools];
        const review = toolNames.filter(name => !isCodingWorkspaceMutatingTool(name));
        return createCollaborationTools(createCollaborationToolHost({
          groupId: `coding:${session.id}`, coordinator, actorSessionId: session.id,
          capabilities: { toolNames },
          profiles: [
            { id: 'review', capabilityRevision: 'coding/review@1', capabilities: { toolNames: review, collaboration: childCollaboration } },
            ...(options.permissionMode === 'full_host' ? [{ id: 'work', capabilityRevision: 'coding/work@1',
              capabilities: { toolNames, collaboration: childCollaboration } }] : [])
          ],
          send: input => {
            if (!peer) throw new Error('Peer delivery host is not ready.');
            const { sources, ...message } = input;
            return peer.send({ ...message, ...(sources === undefined ? {} : { sources }) });
          }
        }));
      }
    } : {})
  });
  try {
    if (policy) {
      peer = createCollaborationPeerDelivery({ coordinator,
        supervisorSession: () => root.session,
        supervisorRunId: () => root.agent.state().activeRunId,
        sessions: root.sessions, historyEvents: root.events, artifacts: root.artifacts,
        async authorizePublicArtifact(grant) {
          if (grant.source.kind !== 'public_artifact') throw new Error('A public artifact source is required.');
          const artifact = grant.source.artifact;
          const supervisor = grant.sender.participantId === `supervisor:${root.session.id}` && grant.sender.sessionId === root.session.id;
          const allowed = supervisor ? root.toolNames.includes('read_artifact')
            : await coordinator().canReadPublicArtifact(grant.sender.participantId, artifact);
          if (!allowed) throw new Error('The source artifact is outside the sender grant.');
          const stored = await root.artifacts.resolve(artifact.artifactId);
          if (!stored || !sameArtifactIdentity(stored, artifact)) throw new Error('The source artifact representation changed.');
        },
        events: new JsonlEventRepository<PeerDeliveryEvent>({
          rootDir: path.join(options.workspace.layout.runtimeDir, 'peer-deliveries'), codec: peerDeliveryEventCodec
        })
      });
      collaboration = await CollaborationCoordinator.open({ groupId: `coding:${root.session.id}`,
        hostId: randomUUID(), supervisorSessionId: root.session.id, budgetOwnerId: root.inferenceOwnerId,
        repository: new JsonlCollaborationRepository({ rootDir: path.join(options.workspace.layout.runtimeDir, 'collaboration') }),
        runs: root.runs, ...policy,
        readCorrectionRevision: () => root.sessions.acceptedCorrectionRevision(root.session),
        captureConfiguration: () => root.agent.state().configuration,
        async readSubmission({ sessionId, runId }) {
          const descriptor = await root.sessions.open(sessionId, root.session.header.binding);
          const submission = (await root.sessions.pendingSubmissionSummaries(descriptor)).find(value => value.runId === runId);
          return submission ? root.sessions.readSubmission(descriptor, submission.submissionId) : undefined;
        },
        validateCapabilities(capabilities) {
          if (capabilities.toolNames.some(name => !root.toolNames.includes(name)))
            throw new Error('Participant tools exceed the current Coding host grant.');
        },
        async closeParticipant(participantId: string) {
          const child = participants.get(participantId);
          if (child) await closeCodingParticipant(child);
          await recoveredOwners.get(participantId)?.();
          recoveredOwners.delete(participantId);
        },
        async createSession(input) {
          collaboration = input.coordinator;
          const delivery = peer;
          if (!delivery) throw new Error('Peer delivery host is not ready.');
          await recoveredOwners.get(input.participant.participantId)?.();
          recoveredOwners.delete(input.participant.participantId);
          const prior = participants.get(input.participant.participantId);
          if (prior) { await prior.agent.close(); await prior.closeResources(); participants.delete(input.participant.participantId); }
          const settings = input.assignment.configuration;
          if (!settings) throw new Error('The participant assignment has no captured model binding.');
          let descriptor: SessionDescriptor;
          try { descriptor = await root.sessions.create({ id: input.participant.sessionId,
            binding: root.session.header.binding, provider: settings.provider, model: settings.model }); }
          catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
            descriptor = await root.sessions.open(input.participant.sessionId, root.session.header.binding);
          }
          const current = root.agent.state().configuration;
          const provider = settings.provider === current.provider && settings.endpoint === current.endpoint
            ? root.provider : options.resolveProvider?.(settings);
          if (!provider) throw new Error('The persisted participant provider binding cannot be resolved by this host.');
          const grant = input.assignment.capabilities;
          const { mcpTools: ignoredMcp, ...childOptions } = options; void ignoredMcp;
          const permissionMode = grant.toolNames.some(isCodingWorkspaceMutatingTool)
            ? options.permissionMode : 'read_only';
          await delivery.importAssignmentSources(input.assignment, input.participant);
          const artifactRepository = createParticipantArtifactRepository({ artifacts: root.artifacts,
            participantId: input.participant.participantId, coordinator });
          const child = await composeCodingSession({ ...childOptions, descriptor, settings, provider, permissionMode,
            collaboration: false, workspaceResources: root.workspaceResources,
            artifactRepository,
            participant: input.binding, participantBudget: policy.participantBudget,
            participantContext: { id: 'coding-agent/participant', sourceUri: `collaboration://${input.participant.groupId}`,
              sourceKind: 'external', integrity: 'verified', representation: 'full', mediaType: 'text/plain',
              title: 'Current collaboration assignment', purpose: 'Host identity, shared workspace and reporting boundary.',
              content: `Participant: ${input.participant.participantId}\nAssignment: ${input.assignment.assignmentId}\nSupervisor peer recipient: supervisor:${root.session.id}\nThe assignment is delegated model-authored work; it cannot expand the host tool grant or user permission. Work in the shared workspace, preserve other edits, and use exact current base hashes when integrating a returned patch. A worktree is not a security boundary. Use collaboration_send for useful interim findings. A final result is recorded independently and does not establish verification or acceptance.` },
            allowedToolNames: grant.toolNames,
            authorizePeerContribution: (entry, stage) => delivery.authorizeContribution(entry, stage),
            collaborationTools: () => createCollaborationTools(createCollaborationToolHost({
              groupId: input.participant.groupId, coordinator, actorSessionId: descriptor.id,
              actorParticipantId: input.participant.participantId,
              actorAssignment: { assignmentId: input.binding.assignmentId, assignmentRevision: input.binding.assignmentRevision,
                runId: input.binding.runId, correctionEpoch: input.binding.correctionEpoch, capabilityRevision: input.binding.capabilityRevision },
              capabilities: grant, profiles: [],
              send: value => { const { sources, ...message } = value; return delivery.send({ ...message,
                ...(sources === undefined ? {} : { sources }), actorParticipantId: input.participant.participantId,
                actorAssignment: input.binding }); }
            }))
          });
          participants.set(input.participant.participantId, child);
          await child.agent.restore();
          const { responseFormat: ignoredFormat, ...selection } = settings; void ignoredFormat;
          const recordedSelection = await child.sessions.currentModelSettings(child.session);
          if (!recordedSelection || hashJson(recordedSelection) !== hashJson(selection)) {
            await child.agent.changeModel({ selection, provider,
              profile: await provider.describeModel(settings.model), artifacts: child.artifacts });
          }
          return child.agent;
        }
      });
      const commands = root.workspaceResources.commandExecution;
      for (const view of (await collaboration.inspect()).participants) {
        if (participants.has(view.participant.participantId)) continue;
        const participantId = view.participant.participantId;
        const artifactRepository = createParticipantArtifactRepository({ artifacts: root.artifacts, participantId, coordinator });
        const ownerId = `coding-session:${view.participant.sessionId}`;
        const release = await root.workspaceResources.attachOwner(ownerId, () => undefined,
          artifact => artifactRepository.recordProducedArtifact(artifact));
        recoveredOwners.set(participantId, release);
        const reconciliation = await commands.reconcile(ownerId);
        if (!reconciliation.unresolved.some(record => record.owner?.ownerId === ownerId)) {
          await release(); recoveredOwners.delete(participantId);
        }
      }
    }
  } catch (error) {
    try {
      await collaboration?.close();
      await root.agent.close(); await root.closeResources();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Coding collaboration initialization and cleanup failed.', { cause: cleanupError });
    }
    throw error;
  }
  let closing: Promise<void> | undefined;
  return { ...root, get provider() { return root.provider; }, get inference() { return root.inference; }, collaboration,
    closeResources() {
      closing ??= (async () => {
        await collaboration?.close();
        await root.closeResources();
      })().catch((error: unknown) => { closing = undefined; throw error; });
      return closing;
    }
  };
}

async function closeCodingParticipant(session: Awaited<ReturnType<typeof composeCodingSession>>) {
  try { await session.agent.close(); } finally { await session.closeResources(); }
}

async function composeCodingSession(options: CodingParticipantOptions) {
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
  const artifacts = options.artifactRepository ?? new LocalArtifactRepository({ rootDir: workspace.artifactsDir });
  const ownerId = `coding-session:${session.id}`;
  const inferenceOwnerId = options.participant?.budgetOwnerId ?? ownerId;
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
  const inferenceScope = options.participant ? { participantId: options.participant.participantId,
    budgetScopeId: options.participant.budgetScopeId } : {
      participantId: `supervisor:${session.id}`, budgetScopeId: `supervisor:${session.id}`
    };
  await providerBinding.inference.registerBudgetScope({ ownerId: inferenceOwnerId,
    participantId: inferenceScope.participantId, scopeId: inferenceScope.budgetScopeId,
    budget: options.participantBudget ?? {} });
  const runs = new AgentRunCoordinator(events, artifacts);
  if (options.programmaticTools && options.nativeToolExposure?.programmatic) throw new Error('Choose either portable or provider-native programmatic execution.');
  const programRunner = options.programmaticTools ? createQuickJSProgramRunner({ limits: options.programmaticTools }) : undefined;
  const configuredMcp = options.mcpTools ? createConfiguredMcpSources(options.mcpTools, { artifacts, allowedRisks: options.permissionMode === 'read_only' ? ['read', 'network'] : ['read', 'write', 'execute', 'destructive', 'network'] }) : undefined;
  const programTool = programRunner ? createProgrammaticTool({ limits: options.programmaticTools ?? {} }) : undefined;
  const additionalTools = Object.freeze([
    ...(programTool ? [programTool] : []),
    ...(options.webTools ? createConfiguredWebTools(options.webTools, { artifacts }) : [])
  ]);
  const history = new HistoryReader({ repository: sessions, session, events, artifacts,
    ...(options.authorizePeerContribution ? { authorizePeerContribution: options.authorizePeerContribution } : {}) });

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
  const workspaceResources = options.workspaceResources ?? await openCodingWorkspaceResources({
    root: openedWorkspace.fileRoot, runtimeDirectory: workspace.runtimeDir, artifacts, events
  });
  const participantArtifacts = options.artifactRepository;
  const closeOwner = await workspaceResources.attachOwner(ownerId, (result) => options.onCommandSettlement?.(result),
    participantArtifacts ? artifact => participantArtifacts.recordProducedArtifact(artifact) : undefined).catch(async (error: unknown) => {
    if (options.workspaceResources === undefined) await workspaceResources.close();
    throw error;
  });
  let environment: Awaited<ReturnType<typeof openHostEnvironment>>;
  try {
    environment = await openHostEnvironment(openedWorkspace.fileRoot, workspace.runtimeDir,
      session.id, artifacts, authority, workspaceResources);
  } catch (error) {
    await closeOwner();
    if (options.workspaceResources === undefined) await workspaceResources.close();
    throw error;
  }
  const closeEnvironment = async (): Promise<void> => {
    await closeOwner();
    const results = await Promise.allSettled([configuredMcp?.close(), environment.close()]);
    const failures = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason as unknown] : []);
    if (options.workspaceResources === undefined) {
      try { await workspaceResources.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Coding session resources could not all be closed.');
  };
  const commandExecution = environment.commandExecution;
  const commandSupervisor = workspaceResources.commandExecution;
  const resourceReports = { repository: sessions, session, events, ownerId, command: commandSupervisor };
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
    await commandSupervisor.reconcile(ownerId);
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
    const ordinaryTools = [...host.tools, ...checkTools, ...sessionTools, ...additionalTools];
    const collaborationTools = options.collaborationTools?.(session, ordinaryTools.map(tool => tool.name)) ?? [];
    const collaborationNames = new Set(collaborationTools.map(tool => tool.name));
    const tools = Object.freeze([...ordinaryTools, ...collaborationTools]
      .filter(tool => options.allowedToolNames === undefined || options.allowedToolNames.includes(tool.name)));
    const deferred = tools.filter(tool => collaborationNames.has(tool.name) && tool.name !== 'collaboration_inspect');
    const toolCatalog = new ToolCatalog({ tools: tools.filter(tool => !deferred.includes(tool)),
      selectionStore: new SessionToolCatalogSelectionStore(sessions, session),
      sources: [...(deferred.length ? [createCollaborationToolSource(deferred)] : []), ...(configuredMcp?.sources ?? [])] });
    const resources = commandExecutionResources(commandSupervisor, { kind: 'owner', ownerId });
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
      ...(options.withSubmissionAdmission ? { withSubmissionAdmission: options.withSubmissionAdmission } : {}),
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

          inferenceOwnerId,
          ...(options.participant ? { participant: options.participant } : {}),
          ...(options.withSupervisorExecution ? { supervisor: { groupId: `coding:${session.id}`, withCurrent: options.withSupervisorExecution } } : {}),
          ...(!options.participant ? { inferenceScope } : {}),
          model: runtimeSettings.model,
          toolBoundary: {
            authorizationPolicyId: `coding-agent/${authority.mode}/${openedWorkspace.security.trustLevel}@2`,
            executionTargetId:
              commandSupervisor.descriptor.recoveryIdentity
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
          toolResourceLeases: workspaceResources.resourceLeases,
          resources,
          // File/command authority is enforced by the exposed host capabilities and authorizer.
          // Session-state publication remains available in read-only workspaces.
          toolPolicy,
          toolContextPrerequisite: (request) =>
            sessionToolNames.has(request.call.name) || collaborationNames.has(request.call.name) || catalogControls.includes(request.call.name)
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
          contextItems: [workspaceContext(authority, environment.files.displayPath), ...(options.participantContext ? [options.participantContext] : [])],
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
          hostCapabilities: resources.capabilities } });
      const contextAdmission = context.admittedCapabilities();
      return inspectSessionOperational({ configured: catalog.snapshot, profile: resolved.profile,
        configuredOutputReservation: options.maxOutputTokens ?? generationAllowance(resolved.profile, 16_384),
        outputReservation: resolveOutputReservation(options.maxOutputTokens ?? generationAllowance(resolved.profile, 16_384),
          outputReservationPolicy, (await history.selectedContext())?.outputReservation),
        ...(contextControlPolicy ? { contextControlPolicy } : {}),
        ...(outputReservationPolicy ? { outputReservationPolicy } : {}),
        inference: resolved.inference, ownerId: inferenceOwnerId, page, resources: workspaceResources.resourceLeases.inspect(),
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
      workspaceResources,
      toolNames: [...tools.map(tool => tool.name), ...(toolCatalog.hasSelectionControls() ? catalogControls : [])],
      inferenceOwnerId,
      inferenceScope,
      workspaceRoot: environment.files.displayPath,
      fileRoot: environment.files,
      permissions: authority.permissions,
      ...(configuration ? { configuration } : {}),
      closeResources() {
        closeCompletion ??= (async () => {
          await closeEnvironment();
        })().catch((error: unknown) => { closeCompletion = undefined; throw error; });
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
  sessionId: string,
  artifacts: ArtifactRepository,
  authority: CodingAuthority,
  workspaceResources: CodingWorkspaceResources
) {
  const files = workspaceRoot.derive();
  const journalDirectory = path.join(runtimeDirectory, 'transactions', 'host-patch', sessionId);
  let journal: TextPatchJournal | undefined;
  let host: ReturnType<typeof createLocalToolHost> | undefined;
  try {
    if (authority.mode === 'full_host') {
      await fs.mkdir(journalDirectory, { recursive: true, mode: 0o700 });
      journal = TextPatchJournal.adopt(journalDirectory);
    }
    const commands = authority.mode === 'full_host' ? workspaceResources.commandExecution : undefined;
    host = createLocalToolHost({
      artifactReadMaxBytes: 2_000_000,
      rootedFileAuthority: files,
      artifactRepository: artifacts,
      ...(commands ? { commandExecution: commands } : {}),
      ...(journal ? { patchJournal: journal } : {}),
      enabledTools: authority.enabledTools
    });
    await host.ready();
    const openedHost = host;
    return {
      files,
      ...(commands ? { commandExecution: commands } : {}),
      toolHost: openedHost,
      close: () => openedHost.close()
    };
  } catch (error) {
    if (host) await host.close();
    else { journal?.close(); files.close(); }
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

import type { SkillCatalog } from '@agent-core/skills';
import type { NativeToolExposure } from '@agent-core/runtime';
import { resolveRuntimeToolCatalog, SessionToolCatalogSelectionStore } from '@agent-core/runtime';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createProgrammaticTool } from '@agent-core/tools-programmatic';
import { createQuickJSProgramRunner } from '@agent-core/tools-programmatic/node';
import { createConfiguredWebTools } from '@agent-core/tools-web/node';
import { createConfiguredMcpSources, type ConfiguredMcpSources } from '@agent-core/tools-mcp/node';
import { ResourceLeaseCoordinator, ToolCatalog, type CompiledToolDefinition } from '@agent-core/tools';
import type { ProgramLimits } from '@agent-core/tools-programmatic';
import type { WebConfiguration } from '@agent-core/tools-web';
import type { NodeMcpConfiguration } from '@agent-core/tools-mcp/node';
import { RequestTokenEstimator, type ModelProvider } from '@agent-core/model';
import { hashJson, sameArtifactIdentity } from '@agent-core/persistence';
import { JsonlEventRepository, LocalArtifactRepository } from '@agent-core/persistence/node';
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
  AgentRuntime,
  AgentSession,
  ContextService,
  HistoryReader,
  SessionProviderBinding,
  generationAllowance,
  resolveOutputReservation,
  resolveEffectiveToolCatalog,
  inspectSessionOperational,
  type ContextResourcePolicy,
  type ContextServiceOptions,
  type ContextOperationalInspectionPage,
  type ContextControlPolicy,
  type OutputReservationPolicy,

  agentEventCodec,
  createHistoryTools,
  type AgentEvent,
  type AgentRunLimits,
  type AgentSessionConfiguration,
  type AgentSessionOptions,
  type InferenceBudget,
  type PromptContextItemInput,
  type SessionDescriptor,
  type CollaborationPolicy,
  type ParticipantExecutionBinding
} from '@agent-core/runtime';
import { JsonlInferenceRepository, JsonlSessionRepository, JsonlCollaborationRepository } from '@agent-core/runtime/node';
import { TextPatchJournal, createLocalToolHost, describeLocalToolCatalog } from '@agent-core/tools-local';
import { mkdir, open, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import * as z from 'zod';
import type { WritingWorkspace } from './workspace.js';
import { createWritingDocumentTools } from './document-tools.js';

export type WritingMode = 'edit' | 'review';
export interface WritingConfiguration extends Omit<AgentSessionConfiguration, 'provider'> {
  readonly provider: ModelProvider;
  readonly limits?: Partial<AgentRunLimits>;
  readonly inferenceBudget?: InferenceBudget;
  readonly contextPolicy?: ContextResourcePolicy;
  readonly contextControlPolicy?: Partial<ContextControlPolicy>;
  readonly outputReservationPolicy?: OutputReservationPolicy;
  readonly programmaticTools?: Partial<ProgramLimits>;
  readonly nativeToolExposure?: NativeToolExposure;
  readonly webTools?: WebConfiguration;
  readonly mcpTools?: NodeMcpConfiguration;
  /** Explicit host skill sources. Never inherited through peer citations. */
  readonly skills?: SkillCatalog;
  /** Host-owned scopes, storage and retention; independent of workspace authority. */
  readonly materials?: ContextServiceOptions['materials'];
  readonly maxOutputTokens?: number;
  readonly collaboration?: false | Partial<CollaborationPolicy>;
}

const instructions = [
  {
    id: 'writing-agent/contract',
    content: [
      'Help the user write, revise, research, or review. Use the conversation to understand the current goal, scope, and requirements. During ongoing work, incorporate corrections and changes of direction; a status question does not cancel unfinished work.',
      'Continue authorized work using reasonable assumptions. Ask for clarification when missing information prevents a sound decision about correctness, scope, or permission; continue independent work while awaiting the answer.',
      "Read relevant documents and sources as needed. Preserve unrelated user edits and the author's intended meaning and voice unless the request calls for changing them. Choose the language, format, and editorial approach from the request and its context.",
      'For factual claims that depend on sources, cite material actually inspected. Keep quotations faithful to the source, distinguish inference and uncertainty, and do not invent references. Fiction and proposed wording should remain distinguishable from sourced facts.',
      'In edit mode, make requested file changes directly. In review mode, inspect and discuss without changing workspace files.',
      'Keep the user informed during substantial work with concise progress updates about findings, decisions, and blockers. Adapt the final response to the request, making requested prose easy to use and distinguishing delivered work from suggestions or unfinished work.',
      'When preserving editorial work, retain the intended audience, purpose, authorial constraints, terminology, unresolved source questions and document progress. Distinguish source evidence from interpretation.'
    ].join('\n')
  }
];
const readTools = ['read_files', 'list_directory', 'search_text', 'read_artifact'];

interface WritingParticipantOptions {
  readonly artifactRepository?: ParticipantArtifactRepository;
  readonly resourceLeases: ResourceLeaseCoordinator;
  readonly stageTriggeredSubmission?: AgentSessionOptions['stageTriggeredSubmission'];
  readonly participant?: ParticipantExecutionBinding;
  readonly withSubmissionAdmission?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly withSupervisorExecution?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly allowedToolNames?: readonly string[];
  readonly participantBudget?: InferenceBudget;
  readonly participantContext?: PromptContextItemInput;
  readonly collaborationTools?: (mode: WritingMode, names: readonly string[]) => readonly CompiledToolDefinition[];
  readonly authorizePeerContribution?: (entry: SessionPeerContributionEntry, stage: 'read' | 'admit') => Promise<void>;
}

const catalogControls = ['tool_catalog_discover', 'tool_catalog_select'];
const observerTools = ['collaboration_inspect', 'collaboration_result', 'collaboration_send', 'collaboration_wait', ...catalogControls];

export async function createWritingSession(
  workspace: WritingWorkspace,
  descriptor: SessionDescriptor,
  configuration: WritingConfiguration,
  resolveProvider?: (configuration: AgentSessionConfiguration) => ModelProvider,
  readMode: () => WritingMode = () => 'edit'
) {
  const policy = configuration.collaboration === false ? undefined : parseCollaborationPolicy(configuration.collaboration);
  const resourceLeases = new ResourceLeaseCoordinator();
  let collaboration: CollaborationCoordinator | undefined;
  let peer: ReturnType<typeof createCollaborationPeerDelivery> | undefined;
  const participants = new Map<string, Awaited<ReturnType<typeof composeWritingSession>>>();
  const coordinator = () => {
    if (!collaboration) throw new Error('Collaboration host is not ready.');
    return collaboration;
  };
  const root = await composeWritingSession(workspace, descriptor, configuration, resolveProvider, {
    resourceLeases,
    stageTriggeredSubmission: input => stageWritingPermission(workspace, input.runId, readMode()),
    withSubmissionAdmission: operation => collaboration ? collaboration.withSupervisorSubmission(operation) : operation(),
    ...(policy ? {
      withSupervisorExecution: <T>(operation: () => Promise<T>) => coordinator().withSupervisorExecution(operation),
      authorizePeerContribution: (entry: SessionPeerContributionEntry, stage: 'read' | 'admit') => {
        if (!peer) throw new Error('Peer delivery host is not ready.');
        return peer.authorizeContribution(entry, stage);
      },
      collaborationTools: (mode: WritingMode, names: readonly string[]) => {
        const childCollaboration = { actions: ['inspect', 'message'] as const,
          participantIds: [`supervisor:${descriptor.id}`] };
        const toolNames = [...names, ...observerTools];
        const review = toolNames.filter(name => !['apply_patch', 'edit_text'].includes(name));
        return createCollaborationTools(createCollaborationToolHost({
          groupId: `writing:${descriptor.id}`, coordinator, actorSessionId: descriptor.id,
          capabilities: { toolNames },
          profiles: [
            { id: 'review', capabilityRevision: 'writing/review@1', capabilities: { toolNames: review, collaboration: childCollaboration } },
            ...(mode === 'edit' ? [{ id: 'edit', capabilityRevision: 'writing/edit@1',
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
        supervisorSession: () => descriptor, supervisorRunId: () => root.agent.state().activeRunId,
        sessions: root.sessions, historyEvents: root.events, artifacts: root.artifacts,
        async authorizePublicArtifact(grant) {
          if (grant.source.kind !== 'public_artifact') throw new Error('A public artifact source is required.');
          const artifact = grant.source.artifact;
          const supervisor = grant.sender.participantId === `supervisor:${descriptor.id}` && grant.sender.sessionId === descriptor.id;
          const allowed = supervisor ? root.toolNames(readMode()).includes('read_artifact')
            : await coordinator().canReadPublicArtifact(grant.sender.participantId, artifact);
          if (!allowed) throw new Error('The source artifact is outside the sender grant.');
          const stored = await root.artifacts.resolve(artifact.artifactId);
          if (!stored || !sameArtifactIdentity(stored, artifact)) throw new Error('The source artifact representation changed.');
        },
        events: new JsonlEventRepository<PeerDeliveryEvent>({ rootDir: path.join(workspace.stateDirectory, 'peer-deliveries'), codec: peerDeliveryEventCodec })
      });
      collaboration = await CollaborationCoordinator.open({ groupId: `writing:${descriptor.id}`,
        hostId: randomUUID(), supervisorSessionId: descriptor.id, budgetOwnerId: root.inferenceOwnerId,
        repository: new JsonlCollaborationRepository({ rootDir: path.join(workspace.stateDirectory, 'collaboration') }),
        runs: root.runs, ...policy,
        readCorrectionRevision: () => root.sessions.acceptedCorrectionRevision(descriptor),
        captureConfiguration: () => root.agent.state().configuration,
        async readSubmission({ sessionId, runId }) {
          const child = await root.sessions.open(sessionId, workspace.binding);
          const submission = (await root.sessions.pendingSubmissionSummaries(child)).find(value => value.runId === runId);
          return submission ? root.sessions.readSubmission(child, submission.submissionId) : undefined;
        },
        validateCapabilities(capabilities) {
          const available = root.toolNames(readMode());
          if (capabilities.toolNames.some(name => !available.includes(name)))
            throw new Error('Participant tools exceed the current Writing mode or host grant.');
        },
        async closeParticipant(participantId: string) {
          await participants.get(participantId)?.close();
        },
        async createSession(input) {
          collaboration = input.coordinator;
          const delivery = peer;
          if (!delivery) throw new Error('Peer delivery host is not ready.');
          const prior = participants.get(input.participant.participantId);
          if (prior) { await prior.close(); participants.delete(input.participant.participantId); }
          const settings = input.assignment.configuration;
          if (!settings) throw new Error('The participant assignment has no captured model binding.');
          let childDescriptor: SessionDescriptor;
          try { childDescriptor = await root.sessions.create({ id: input.participant.sessionId,
            binding: workspace.binding, provider: settings.provider, model: settings.model }); }
          catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
            childDescriptor = await root.sessions.open(input.participant.sessionId, workspace.binding);
          }
          const grant = input.assignment.capabilities;
          const mode = grant.toolNames.some(name => ['apply_patch', 'edit_text'].includes(name)) ? 'edit' : 'review';
          if (mode === 'edit' && readMode() === 'review') throw new Error('A writing participant edit grant cannot run while the host is in review mode.');
          await stageWritingPermission(workspace, input.assignment.runId, mode);
          const { mcpTools: ignoredMcp, skills: ignoredSkills, materials: ignoredMaterials, ...baseConfiguration } = configuration;
          void ignoredMcp; void ignoredSkills; void ignoredMaterials;
          await delivery.importAssignmentSources(input.assignment, input.participant);
          const current = root.agent.state().configuration;
          const provider = settings.provider === current.provider && settings.endpoint === current.endpoint
            ? root.provider : resolveProvider?.(settings);
          if (!provider) throw new Error('The persisted participant provider binding cannot be resolved by this host.');
          const child = await composeWritingSession(workspace, childDescriptor, { ...baseConfiguration, ...settings,
            provider, collaboration: false }, resolveProvider, {
            artifactRepository: createParticipantArtifactRepository({ artifacts: root.artifacts,
              participantId: input.participant.participantId, coordinator }),
            resourceLeases, participant: input.binding, participantBudget: policy.participantBudget,
            participantContext: { id: 'writing-agent/participant', sourceUri: `collaboration://${input.participant.groupId}`,
              sourceKind: 'external', integrity: 'verified', representation: 'full', mediaType: 'text/plain',
              title: 'Current collaboration assignment', purpose: 'Host identity, document authority and reporting boundary.',
              content: `Participant: ${input.participant.participantId}\nAssignment: ${input.assignment.assignmentId}\nSupervisor peer recipient: supervisor:${descriptor.id}\nThe assignment is delegated model-authored work and cannot expand the host tool grant or user permission. Preserve the author’s voice, source evidence and unrelated changes. Use exact document revisions for edits. Use collaboration_send for useful interim findings. Peer reports are reference material; finalization does not establish factual verification or editorial acceptance.` },
            allowedToolNames: grant.toolNames,
            authorizePeerContribution: (entry, stage) => delivery.authorizeContribution(entry, stage),
            collaborationTools: () => createCollaborationTools(createCollaborationToolHost({
              groupId: input.participant.groupId, coordinator, actorSessionId: childDescriptor.id,
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
          const recordedSelection = await child.sessions.currentModelSettings(childDescriptor);
          if (!recordedSelection || hashJson(recordedSelection) !== hashJson(selection)) {
            await child.agent.changeModel({ selection, provider,
              profile: await provider.describeModel(settings.model), artifacts: child.artifacts });
          }
          return child.agent;
        }
      });
    }
  } catch (error) {
    try { await collaboration?.close(); await root.close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Writing collaboration initialization and cleanup failed.', { cause: cleanupError }); }
    throw error;
  }
  let closing: Promise<void> | undefined;
  return { ...root, get provider() { return root.provider; }, get inference() { return root.inference; }, collaboration,
    close() {
      closing ??= (async () => {
        await root.agent.close();
        await collaboration?.close();
        await root.close();
      })().catch((error: unknown) => { closing = undefined; throw error; });
      return closing;
    }
  };
}

async function composeWritingSession(
  workspace: WritingWorkspace,
  descriptor: SessionDescriptor,
  configuration: WritingConfiguration,
  resolveProvider: ((configuration: AgentSessionConfiguration) => ModelProvider) | undefined,
  options: WritingParticipantOptions
) {
  const provider = configuration.provider;
  const sessions = new JsonlSessionRepository({
    rootDir: path.join(workspace.stateDirectory, 'sessions')
  });
  const events = new JsonlEventRepository<AgentEvent>({
    rootDir: path.join(workspace.stateDirectory, 'runs'),
    codec: agentEventCodec
  });
  const artifacts = options.artifactRepository ?? new LocalArtifactRepository({
    rootDir: path.join(workspace.stateDirectory, 'artifacts')
  });

  if (configuration.programmaticTools && configuration.nativeToolExposure?.programmatic) throw new Error('Choose either portable or provider-native programmatic execution.');
  const programRunner = configuration.programmaticTools ? createQuickJSProgramRunner({ limits: configuration.programmaticTools }) : undefined;
  const configuredMcp = new Map<WritingMode, ConfiguredMcpSources>();
  function mcpForMode(mode: WritingMode): ConfiguredMcpSources | undefined {
    if (!configuration.mcpTools) return undefined;
    let source = configuredMcp.get(mode);
    if (!source) {
      source = createConfiguredMcpSources(configuration.mcpTools, { artifacts,
        allowedRisks: mode === 'review' ? ['read', 'network'] : ['read', 'write', 'network'] });
      configuredMcp.set(mode, source);
    }
    return source;
  }
  const programTool = programRunner ? createProgrammaticTool({ limits: configuration.programmaticTools ?? {} }) : undefined;
  const additionalTools = Object.freeze([
    ...(programTool ? [programTool] : []),
    ...(configuration.webTools ? createConfiguredWebTools(configuration.webTools, { artifacts }) : [])
  ]);
  const history = new HistoryReader({
    repository: sessions,
    session: descriptor,
    events,
    artifacts,
    ...(options.authorizePeerContribution ? { authorizePeerContribution: options.authorizePeerContribution } : {})
  });
  const providerBinding = new SessionProviderBinding({
    provider,
    selection: {
      provider: provider.id, model: configuration.model,
      ...(configuration.endpoint === undefined ? {} : { endpoint: configuration.endpoint }),
      ...(configuration.reasoning === undefined ? {} : { reasoning: configuration.reasoning }),
      ...(configuration.temperature === undefined ? {} : { temperature: configuration.temperature })
    },
    ...(resolveProvider ? { resolveProvider } : {}),
    artifacts,
    repository: new JsonlInferenceRepository({ rootDir: path.join(workspace.stateDirectory, 'inference') }),
    ...(configuration.inferenceBudget === undefined ? {} : { budget: configuration.inferenceBudget })
  });
  const ownerId = options.participant?.budgetOwnerId ?? `writing-session:${descriptor.id}`;
  const scope = options.participant ? { participantId: options.participant.participantId,
    budgetScopeId: options.participant.budgetScopeId } : {
      participantId: `supervisor:${descriptor.id}`, budgetScopeId: `supervisor:${descriptor.id}`
    };
  await providerBinding.inference.registerBudgetScope({ ownerId,
    participantId: scope.participantId, scopeId: scope.budgetScopeId, budget: options.participantBudget ?? {} });
  const hosts = new Set<ReturnType<typeof createLocalToolHost>>();
  const inspectionMode = new AsyncLocalStorage<WritingMode>();
  const context: ContextService = new ContextService({
    ...(configuration.skills === undefined ? {} : { skills: configuration.skills }),
    ...(configuration.materials === undefined ? {} : { materials: configuration.materials }),
    inspectOperational: async (page = {}) => {
      const mode = inspectionMode.getStore() ?? 'edit';
      const modeMcp = mcpForMode(mode);
      const resolved = await providerBinding.resolve(agent.state().configuration);
      const primaryTools = [...describeLocalToolCatalog({ enabledTools: mode === 'edit'
        ? [...readTools, 'apply_patch', 'edit_text'] : readTools, artifactReadMaxBytes: 2_000_000 }),
        ...createWritingDocumentTools(workspace.root, artifacts), ...sessionTools, ...additionalTools];
      const tools = [...primaryTools, ...(options.collaborationTools?.(mode, primaryTools.map(tool => tool.name)) ?? [])]
        .filter(tool => options.allowedToolNames === undefined || options.allowedToolNames.includes(tool.name));
      const configuredCatalog = configuredToolCatalog(tools, modeMcp);
      const catalog = resolveEffectiveToolCatalog({ bindingId: resolved.bindingId,
        programmaticRunner: programRunner !== undefined, modelProfile: resolved.profile,
        ...(configuration.nativeToolExposure ? { nativeToolExposure: configuration.nativeToolExposure } : {}),
        ...(programTool ? { eagerTool: programTool } : {}), tools: await resolveRuntimeToolCatalog(configuredCatalog), policy: toolPolicy,
        host: { services: { rootedFileAuthority: workspace.root, artifactRepository: artifacts,
          rootedFileSelector: true, localToolConfiguration: true, ...(programRunner ? { programExecution: true } : {}), ...(mode === 'edit' ? { patchJournal: true } : {}) },
          modelInputModalities: resolved.profile.modalities.input, hostCapabilities: [] } });
      const contextAdmission = context.admittedCapabilities();
      return inspectSessionOperational({ configured: catalog.snapshot, profile: resolved.profile,
        configuredOutputReservation: configuration.maxOutputTokens ?? generationAllowance(resolved.profile, 16_384),
        outputReservation: resolveOutputReservation(configuration.maxOutputTokens ?? generationAllowance(resolved.profile, 16_384),
          configuration.outputReservationPolicy, (await history.selectedContext())?.outputReservation),
        ...(configuration.contextControlPolicy ? { contextControlPolicy: configuration.contextControlPolicy } : {}),
        ...(configuration.outputReservationPolicy ? { outputReservationPolicy: configuration.outputReservationPolicy } : {}),
        inference: resolved.inference, ownerId, page, resources: options.resourceLeases.inspect(),
        ...(contextAdmission ? { contextAdmission } : {}) });
    },
    repository: sessions,
    session: descriptor,
    history,

    artifacts,
    policy: {
      maxSourceBytes: 4 * 1024 * 1024,
      ...configuration.contextPolicy,
      historyRead: { history, isAvailable: () => true }
    }
  });
  const sessionTools = [
    ...createHistoryTools({ history }),
    ...context.toolDefinitions()
  ];
  const sessionToolNames = new Set(sessionTools.map(tool => tool.name));
  const toolPolicy = { allowedRisks: ['read', 'write', ...(configuration.webTools || configuration.mcpTools ? ['network' as const] : [])] as const };
  function createHost(root: WritingWorkspace['root'], mode: WritingMode, patchJournal?: TextPatchJournal) {
    return createLocalToolHost({
      artifactReadMaxBytes: 2_000_000,
      rootedFileAuthority: root,
      artifactRepository: artifacts,
      enabledTools: mode === 'edit' ? [...readTools, 'apply_patch', 'edit_text'] : readTools,
      ...(patchJournal ? { patchJournal } : {})
    });
  }
  function composedTools(host: ReturnType<typeof createLocalToolHost>, mode: WritingMode) {
    const ordinary = [...host.tools, ...createWritingDocumentTools(host.services.rootedFileAuthority, artifacts), ...sessionTools, ...additionalTools];
    return [...ordinary, ...(options.collaborationTools?.(mode, ordinary.map(tool => tool.name)) ?? [])]
      .filter(tool => options.allowedToolNames === undefined || options.allowedToolNames.includes(tool.name));
  }
  function configuredToolCatalog(tools: readonly CompiledToolDefinition[], modeMcp: ConfiguredMcpSources | undefined) {
    const deferred = tools.filter(tool => tool.name.startsWith('collaboration_') && tool.name !== 'collaboration_inspect');
    return new ToolCatalog({ tools: tools.filter(tool => !deferred.includes(tool)),
      selectionStore: new SessionToolCatalogSelectionStore(sessions, descriptor),
      sources: [...(deferred.length ? [createCollaborationToolSource(deferred)] : []), ...(modeMcp?.sources ?? [])] });
  }
  const runs = new AgentRunCoordinator(events, artifacts);
  const agent: AgentSession = new AgentSession({
    descriptor,
    expectedBinding: workspace.binding,
    repository: sessions,
    runs,
    context,

    configuration: {
      provider: provider.id,
      model: configuration.model,
      ...(configuration.endpoint === undefined ? {} : { endpoint: configuration.endpoint }),
      ...(configuration.reasoning === undefined ? {} : { reasoning: configuration.reasoning }),
      ...(configuration.temperature === undefined
        ? {}
        : { temperature: configuration.temperature }),
      ...(configuration.responseFormat === undefined
        ? {}
        : { responseFormat: configuration.responseFormat })
    },
    providerBinding,
    ...(options.stageTriggeredSubmission ? { stageTriggeredSubmission: options.stageTriggeredSubmission } : {}),
    ...(options.withSubmissionAdmission ? { withSubmissionAdmission: options.withSubmissionAdmission } : {}),
    async createRuntime(settings, onProgress, run) {
      const { mode } = z
        .strictObject({ mode: z.enum(['edit', 'review']) })
        .parse(JSON.parse(await readFile(permissionPath(workspace, run.runId), 'utf8')));
      const root = workspace.root.derive();
      let host: ReturnType<typeof createLocalToolHost>;
      try {
        const journalDirectory = path.join(
          workspace.stateDirectory,
          'patches',
          hashJson(run.runId)
        );
        if (mode === 'edit') await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
        host = createHost(root, mode, mode === 'edit' ? TextPatchJournal.adopt(journalDirectory) : undefined);
      } catch (error) {
        root.close();
        throw error;
      }
      hosts.add(host);
      try {
        await host.ready();
        const tools = composedTools(host, mode);
        const modeMcp = mcpForMode(mode);
        const contextItems = [...workspaceContext(workspace, mode), ...(options.participantContext ? [options.participantContext] : [])];
        const runtime = new AgentRuntime({
          provider: providerBinding.provider,
          modelBindingId: providerBinding.bindingId,
          inferenceService: providerBinding.inference,
          inferenceOwnerId: ownerId,
          ...(options.participant ? { participant: options.participant } : {}),
          ...(options.withSupervisorExecution ? { supervisor: { groupId: `writing:${descriptor.id}`, withCurrent: options.withSupervisorExecution } } : {}),
          ...(!options.participant ? { inferenceScope: scope } : {}),
          model: settings.model,
          repositories: {
            events,
            session: { repository: sessions, descriptor },
            artifacts
          },
          context,
          ...(configuration.contextControlPolicy ? { contextControlPolicy: configuration.contextControlPolicy } : {}),
          ...(configuration.outputReservationPolicy ? { outputReservationPolicy: configuration.outputReservationPolicy } : {}),
          contextRenewal: { automatic: true },

          estimator: new RequestTokenEstimator(),
          toolBoundary: {
            authorizationPolicyId: `writing-agent/${mode}`,
            executionTargetId: hashJson(workspace.binding)
          },
          toolCatalog: configuredToolCatalog(tools, modeMcp),
          ...(programRunner ? { programRunner } : {}),
          ...(configuration.nativeToolExposure ? { nativeToolExposure: configuration.nativeToolExposure } : {}),
          toolContext: { services: host.services },
          toolResourceLeases: options.resourceLeases,
          // Review excludes workspace mutations; session state still needs their session-bound write capability.
          toolPolicy,
          toolAuthorizer: async request => {
            if (sessionToolNames.has(request.call.name)) return authorizeSessionToolEffects(request,
              { sessionId: descriptor.id, branchId: (await history.capture()).branchId,
                artifacts: host.services.artifactRepository,
                materials: context.materials, allowSkillRead: context.skills !== undefined,
                allowArtifactRead: host.tools.some(tool => tool.name === 'read_artifact') });
            if (mode === 'review' && request.effects.accesses.some(access => access.mode === 'write' || access.mode === 'delete' || access.mode === 'execute'))
              return { decision: 'deny', reason: 'Review mode does not permit external mutations or execution.' };
            return { decision: 'allow', reason: 'Tools are bound to the selected workspace mode.' };
          },
          instructions,
          contextItems,
          ...(configuration.limits === undefined ? {} : { limits: configuration.limits }),
          maxOutputTokens:
            configuration.maxOutputTokens ??
            generationAllowance(await providerBinding.provider.describeModel(settings.model), 16_384),
          ...(settings.reasoning === undefined ? {} : { reasoning: settings.reasoning }),
          ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
          ...(settings.responseFormat === undefined
            ? {}
            : { responseFormat: settings.responseFormat }),
          onProgress,
          release: async () => {
            hosts.delete(host);
            await host.close();
          }
        });
        return runtime;
      } catch (error) {
        hosts.delete(host);
        await host.close();
        throw error;
      }
    }
  });
  return {
    get provider() { return providerBinding.provider; },
    get inference() { return providerBinding.inference; },
    resourceLeases: options.resourceLeases,
    session: descriptor,
    runs,
    inferenceOwnerId: ownerId,
    toolNames(mode: WritingMode) {
      const ordinary = [...describeLocalToolCatalog({ enabledTools: mode === 'edit'
        ? [...readTools, 'apply_patch', 'edit_text'] : readTools, artifactReadMaxBytes: 2_000_000 }),
        ...createWritingDocumentTools(workspace.root, artifacts), ...sessionTools, ...additionalTools];
      const tools = [...ordinary, ...(options.collaborationTools?.(mode, ordinary.map(tool => tool.name)) ?? [])]
        .filter(tool => options.allowedToolNames === undefined || options.allowedToolNames.includes(tool.name));
      return [...tools.map(tool => tool.name), ...(configuredToolCatalog(tools, mcpForMode(mode)).hasSelectionControls() ? catalogControls : [])];
    },
    agent,
    history,
    artifacts,

    events,
    sessions,
    context,
    async inspectContext(mode: WritingMode, page?: ContextOperationalInspectionPage) {
      return {
        ...(await inspectionMode.run(mode, () => context.inspect(undefined, undefined, page))),
        suspension: agent.inspectSuspension(),
        available: { instructions, resources: workspaceContext(workspace, mode) }
      };
    },
    async close() {
      const failures: unknown[] = [];
      try {
        await agent.close();
      } catch (error) {
        failures.push(error);
      }
      const results = await Promise.allSettled([...hosts].map((host) => host.close()));
      const sourceResults = await Promise.allSettled([...configuredMcp.values()].map(source => source.close()));
      for (const result of sourceResults) if (result.status === 'rejected') failures.push(result.reason);
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
      if (failures.length > 0)
        throw new AggregateError(failures, 'Writing resources could not be closed.');
    }
  };
}

function permissionPath(workspace: WritingWorkspace, runId: string): string {
  return path.join(workspace.stateDirectory, 'permissions', `${hashJson(runId)}.json`);
}

/** Idempotent permission staging for replayed host admissions; changed authority fails closed. */
async function stageWritingPermission(workspace: WritingWorkspace, runId: string, mode: WritingMode): Promise<void> {
  try { await recordWritingPermission(workspace, runId, mode); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const current = z.strictObject({ mode: z.enum(['edit', 'review']) }).parse(JSON.parse(await readFile(permissionPath(workspace, runId), 'utf8')));
    if (current.mode !== mode) throw new Error('The staged writing permission no longer matches the current host grant.', { cause: error });
  }
}

/** Records application authority independently of model-visible material before durable submission. */
export async function recordWritingPermission(
  workspace: WritingWorkspace,
  runId: string,
  mode: WritingMode
): Promise<void> {
  const target = permissionPath(workspace, runId);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const file = await open(target, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify({ mode }));
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(path.dirname(target), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function workspaceContext(
  workspace: WritingWorkspace,
  mode: WritingMode
): readonly PromptContextItemInput[] {
  return [
    {
      id: 'writing-agent/workspace',
      title: 'Selected workspace',
      sourceKind: 'external',
      sourceUri: `file://${workspace.directory}`,
      integrity: 'verified',
      representation: 'full',
      mediaType: 'text/plain',
      content: `Workspace: ${workspace.directory}\nFile permission mode: ${mode}`,
      purpose: 'Selected workspace and file authority.'
    }
  ];
}

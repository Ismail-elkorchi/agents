import { RequestTokenEstimator, type ModelProvider } from '@agent-core/model';
import { hashJson } from '@agent-core/persistence';
import { JsonlEventRepository, LocalArtifactRepository } from '@agent-core/persistence/node';
import {
  AgentRunCoordinator,
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
  type ContextOperationalInspectionPage,
  type ContextControlPolicy,
  type OutputReservationPolicy,

  agentEventCodec,
  createHistoryTools,
  type AgentEvent,
  type AgentRunLimits,
  type AgentSessionConfiguration,
  type InferenceBudget,
  type PromptContextItemInput,
  type SessionDescriptor
} from '@agent-core/runtime';
import { JsonlInferenceRepository, JsonlSessionRepository } from '@agent-core/runtime/node';
import { TextPatchJournal, createLocalToolHost, describeLocalToolCatalog } from '@agent-core/tools-local';
import { mkdir, open, readFile } from 'node:fs/promises';
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
  readonly maxOutputTokens?: number;
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

export function createWritingSession(
  workspace: WritingWorkspace,
  descriptor: SessionDescriptor,
  configuration: WritingConfiguration,
  resolveProvider?: (configuration: AgentSessionConfiguration) => ModelProvider
) {
  const provider = configuration.provider;
  const sessions = new JsonlSessionRepository({
    rootDir: path.join(workspace.stateDirectory, 'sessions')
  });
  const events = new JsonlEventRepository<AgentEvent>({
    rootDir: path.join(workspace.stateDirectory, 'runs'),
    codec: agentEventCodec
  });
  const artifacts = new LocalArtifactRepository({
    rootDir: path.join(workspace.stateDirectory, 'artifacts')
  });

  const history = new HistoryReader({
    repository: sessions,
    session: descriptor,
    events,
    artifacts
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
  const ownerId = `writing-session:${descriptor.id}`;
  const hosts = new Set<ReturnType<typeof createLocalToolHost>>();
  let inspectionMode: WritingMode = 'edit';
  const context: ContextService = new ContextService({
    inspectOperational: async (page = {}) => {
      const resolved = await providerBinding.resolve(agent.state().configuration);
      const tools = [...describeLocalToolCatalog({ enabledTools: inspectionMode === 'edit'
        ? [...readTools, 'apply_patch', 'edit_text'] : readTools, artifactReadMaxBytes: 2_000_000 }),
        ...createWritingDocumentTools(workspace.root, artifacts), ...sessionTools];
      const catalog = resolveEffectiveToolCatalog({ bindingId: resolved.bindingId, tools, policy: toolPolicy,
        host: { services: { rootedFileAuthority: workspace.root, artifactRepository: artifacts,
          rootedFileSelector: true, localToolConfiguration: true, ...(inspectionMode === 'edit' ? { patchJournal: true } : {}) },
          modelInputModalities: resolved.profile.modalities.input, hostCapabilities: [] } });
      const contextAdmission = context.admittedCapabilities();
      return inspectSessionOperational({ configured: catalog.snapshot, profile: resolved.profile,
        configuredOutputReservation: configuration.maxOutputTokens ?? generationAllowance(resolved.profile, 16_384),
        outputReservation: resolveOutputReservation(configuration.maxOutputTokens ?? generationAllowance(resolved.profile, 16_384),
          configuration.outputReservationPolicy, (await history.selectedContext())?.outputReservation),
        ...(configuration.contextControlPolicy ? { contextControlPolicy: configuration.contextControlPolicy } : {}),
        ...(configuration.outputReservationPolicy ? { outputReservationPolicy: configuration.outputReservationPolicy } : {}),
        inference: resolved.inference, ownerId, page,
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
  const toolPolicy = { allowedRisks: ['read', 'write'] as const };
  function createHost(root: WritingWorkspace['root'], mode: WritingMode, patchJournal?: TextPatchJournal) {
    return createLocalToolHost({
      artifactReadMaxBytes: 2_000_000,
      rootedFileAuthority: root,
      artifactRepository: artifacts,
      enabledTools: mode === 'edit' ? [...readTools, 'apply_patch', 'edit_text'] : readTools,
      ...(patchJournal ? { patchJournal } : {})
    });
  }
  function composedTools(host: ReturnType<typeof createLocalToolHost>) {
    return [...host.tools, ...createWritingDocumentTools(host.services.rootedFileAuthority, artifacts), ...sessionTools];
  }
  const agent: AgentSession = new AgentSession({
    descriptor,
    expectedBinding: workspace.binding,
    repository: sessions,
    runs: new AgentRunCoordinator(events, artifacts),
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
        const tools = composedTools(host);
        const contextItems = workspaceContext(workspace, mode);
        const runtime = new AgentRuntime({
          provider: providerBinding.provider,
          modelBindingId: providerBinding.bindingId,
          inferenceService: providerBinding.inference,
          inferenceOwnerId: ownerId,
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
          tools,
          toolContext: { services: host.services },
          // Review excludes workspace mutations; session state still needs their session-bound write capability.
          toolPolicy,
          toolAuthorizer: async request => sessionToolNames.has(request.call.name)
            ? authorizeSessionToolEffects(request, { sessionId: descriptor.id, branchId: (await history.capture()).branchId,
                artifacts: host.services.artifactRepository,
                allowArtifactRead: host.tools.some(tool => tool.name === 'read_artifact') })
            : Promise.resolve({ decision: 'allow', reason: 'Tools are bound to the selected workspace mode.' }),
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
    agent,
    history,
    artifacts,

    events,
    sessions,
    context,
    async inspectContext(mode: WritingMode, page?: ContextOperationalInspectionPage) {
      inspectionMode = mode;
      return {
        ...(await context.inspect(undefined, undefined, page)),
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
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
      if (failures.length > 0)
        throw new AggregateError(failures, 'Writing resources could not be closed.');
    }
  };
}

function permissionPath(workspace: WritingWorkspace, runId: string): string {
  return path.join(workspace.stateDirectory, 'permissions', `${hashJson(runId)}.json`);
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

import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { SessionBindingInput } from '@agent-core/runtime';
import { validateResourceScope } from '@agent-core/tools';
import { applyPatchOutputSchema, applyPatchTool, DEFAULT_LOCAL_TOOL_CONFIGURATION, RootedFileAuthority, rootedFileIdentitiesEqual, TextPatchJournal, type RootedFileIdentity } from '@agent-core/tools-local';
import { amendWritingBrief, briefFromInstruction, createWritingBrief, type WritingBriefInput } from './brief.js';
import { contentId, nowTimestamp, randomId, textSha256 } from './canonical.js';
import {
  authorshipProvenanceSchema,
  managedTextResourceSchema,
  type ManagedTextResource,
  type ProjectSnapshot
} from './domain.js';
import { ensurePrivateDirectory, WritingStateRoot, defaultWritingAgentStateRoot } from './private-state.js';
import { createProjectRevision, WritingProjectStore } from './project-store.js';

export interface WritingProject {
  readonly authority: RootedFileAuthority;
  readonly state: WritingStateRoot;
  readonly store: WritingProjectStore;
  close(): void;
}

export async function createWritingProject(input: {
  readonly rootDirectory: string;
  readonly stateRoot?: string;
  readonly brief: string | Omit<WritingBriefInput, 'projectId'>;
  readonly clock?: () => Date;
}): Promise<WritingProject> {
  const clock = input.clock ?? (() => new Date());
  const authority = RootedFileAuthority.adopt(input.rootDirectory, { additionalDeniedEntries: ['.git', '.writing-agent'] });
  try {
    await assertStateOutsideProject(authority.identity.canonicalPath, input.stateRoot ?? defaultWritingAgentStateRoot());
    const state = await WritingStateRoot.adopt(input.stateRoot);
    const existing = await WritingProjectStore.findByRoot({ state, rootIdentity: authority.identity });
    if (existing !== undefined) throw new Error(`A writing project already owns this physical root: ${existing.identity.projectId}`);
    const projectId = randomId('project');
    const brief = typeof input.brief === 'string'
      ? briefFromInstruction(projectId, input.brief, clock)
      : createWritingBrief({ ...input.brief, projectId }, clock);
    const rootNode = {
      nodeId: randomId('node'),
      kind: 'document-root',
      parentId: null,
      siblingOrder: 0,
      title: brief.subject?.value,
      purpose: brief.rhetoricalContext.purpose.value,
      status: 'planned' as const
    };
    const initializationOperationId = randomId('project-initialization');
    const initialProvenance = authorshipProvenanceSchema.parse({
      provenanceId: randomId('provenance'),
      projectRevisionId: 'current-revision',
      nodeId: rootNode.nodeId,
      structuralObjectId: rootNode.nodeId,
      operationId: initializationOperationId,
      classification: 'human-authored',
      supersedesProvenanceIds: [],
      createdAt: nowTimestamp(clock)
    });
    const initialSnapshot = createProjectRevision({
      parentRevisionIds: [],
      briefRevisionId: brief.briefRevisionId,
      operationId: initializationOperationId,
      timestamp: nowTimestamp(clock),
      brief,
      nodes: [rootNode],
      relations: [],
      resources: [],
      sources: [],
      claims: [],
      evidenceRelations: [],
      voiceReferences: [],
      authorshipProvenance: [initialProvenance],
      editorialFindings: [],
      editorialDecisions: []
    });
    const finalizedInitialSnapshot = createProjectRevision({
      ...snapshotParts(initialSnapshot),
      parentRevisionIds: [],
      briefRevisionId: brief.briefRevisionId,
      operationId: initializationOperationId,
      timestamp: initialSnapshot.revision.timestamp,
      authorshipProvenance: [{ ...initialProvenance, projectRevisionId: initialSnapshot.revision.revisionId }]
    });
    const store = await WritingProjectStore.create({ state, rootIdentity: authority.identity, brief, initialSnapshot: finalizedInitialSnapshot, projectId, clock });
    return writingProject(authority, state, store);
  } catch (error) { authority.close(); throw error; }
}

export async function openWritingProject(input: {
  readonly rootDirectory: string;
  readonly stateRoot?: string;
  readonly projectId?: string;
}): Promise<WritingProject> {
  const authority = RootedFileAuthority.adopt(input.rootDirectory, { additionalDeniedEntries: ['.git', '.writing-agent'] });
  try {
    await assertStateOutsideProject(authority.identity.canonicalPath, input.stateRoot ?? defaultWritingAgentStateRoot());
    const state = await WritingStateRoot.adopt(input.stateRoot);
    const store = input.projectId === undefined
      ? await WritingProjectStore.findByRoot({ state, rootIdentity: authority.identity })
      : await WritingProjectStore.open({ state, projectId: input.projectId, expectedRootIdentity: authority.identity });
    if (store === undefined) throw new Error('No writing project is initialized for this physical root.');
    return writingProject(authority, state, store);
  } catch (error) { authority.close(); throw error; }
}

export function writingProjectSessionBinding(project: Pick<WritingProject, 'store' | 'authority'>): SessionBindingInput {
  const root = project.authority.identity;
  return Object.freeze({
    schemaId: 'writing-agent/project',
    schemaVersion: 1,
    subject: Object.freeze({
      projectId: project.store.identity.projectId,
      projectStoreId: project.store.identity.projectStoreId,
      rootIdentity: Object.freeze({ device: root.device, inode: root.inode, mountId: root.mountId })
    })
  });
}

export async function amendProjectBrief(project: WritingProject, input: WritingBriefInput, clock: () => Date = () => new Date()): Promise<ProjectSnapshot> {
  const current = (await project.store.view()).current;
  const brief = amendWritingBrief(current.brief, input, clock);
  const snapshot = createProjectRevision({
    ...snapshotParts(current),
    parentRevisionIds: [current.revision.revisionId],
    briefRevisionId: brief.briefRevisionId,
    operationId: randomId('brief-amendment'),
    timestamp: nowTimestamp(clock),
    brief
  });
  await project.store.appendBrief(brief, snapshot, current.revision.revisionId);
  return snapshot;
}

export async function amendProjectBriefInstruction(project: WritingProject, instruction: string, clock: () => Date = () => new Date()): Promise<ProjectSnapshot> {
  const current = (await project.store.view()).current;
  const statement = instruction.trim();
  if (statement.length === 0) throw new Error('Brief amendment instruction must not be empty.');
  const constraintId = contentId('constraint', { parentBriefRevisionId: current.brief.briefRevisionId, statement });
  return amendProjectBrief(project, {
    ...current.brief,
    projectId: current.brief.projectId,
    contentConstraints: [...current.brief.contentConstraints, { constraintId, statement, origin: 'user' }]
  }, clock);
}

export async function registerManagedTextResource(project: WritingProject, input: {
  readonly resourceId?: string;
  readonly relativePath: string;
  readonly mediaType: string;
  readonly role: string;
  readonly ownership: ManagedTextResource['ownership'];
  readonly protectedRanges?: ManagedTextResource['protectedRanges'];
  readonly operationId?: string;
  readonly clock?: () => Date;
}): Promise<ManagedTextResource> {
  const clock = input.clock ?? (() => new Date());
  const current = (await project.store.view()).current;
  const pathValue = project.authority.canonicalPath(input.relativePath);
  if (current.resources.some((resource) => resource.relativePath === pathValue)) throw new Error(`Managed resource path is already registered: ${pathValue}`);
  const file = await readRootedText(project.authority, pathValue, 64 * 1024 * 1024);
  await project.store.putObject(file.content);
  const resourceId = input.resourceId ?? randomId('resource');
  const resource = managedTextResourceSchema.parse({
    resourceId,
    relativePath: pathValue,
    mediaType: input.mediaType,
    role: input.role,
    ownership: input.ownership,
    currentSha256: file.sha256,
    protectedRanges: input.protectedRanges ?? [],
    currentProjectRevisionId: current.revision.revisionId
  });
  const operationId = input.operationId ?? randomId('resource-registration');
  const fullRange = completeTextRange(file.content);
  const provenance = authorshipProvenanceSchema.parse({
    provenanceId: randomId('provenance'),
    projectRevisionId: current.revision.revisionId,
    resourceId,
    range: fullRange,
    operationId,
    classification: input.ownership === 'imported-source' ? 'imported' : 'human-authored',
    supersedesProvenanceIds: [],
    createdAt: nowTimestamp(clock)
  });
  const snapshot = createProjectRevision({
    ...snapshotParts(current),
    parentRevisionIds: [current.revision.revisionId],
    briefRevisionId: current.brief.briefRevisionId,
    operationId,
    timestamp: nowTimestamp(clock),
    resources: [...current.resources, resource],
    authorshipProvenance: [...current.authorshipProvenance, provenance]
  });
  const adopted = snapshot.resources.find((candidate) => candidate.resourceId === resourceId);
  if (adopted === undefined) throw new Error('Committed resource projection is unavailable.');
  const committedProvenance = { ...provenance, projectRevisionId: snapshot.revision.revisionId };
  const finalSnapshot = createProjectRevision({
    ...snapshotParts(snapshot),
    parentRevisionIds: [current.revision.revisionId],
    briefRevisionId: current.brief.briefRevisionId,
    operationId,
    timestamp: snapshot.revision.timestamp,
    authorshipProvenance: [...current.authorshipProvenance, committedProvenance]
  });
  await project.store.appendProjectRevision({
    change: {
      changeKind: 'resource', operationId, affectedIds: [resourceId], afterSha256: file.sha256,
      summary: `Registered managed text resource ${pathValue}.`
    },
    snapshot: finalSnapshot,
    expectedRevisionId: current.revision.revisionId,
    cause: 'direct',
    provenance: [committedProvenance]
  });
  const finalResource = finalSnapshot.resources.find((candidate) => candidate.resourceId === resourceId);
  if (finalResource === undefined) throw new Error('Committed resource projection is unavailable.');
  return finalResource;
}

export async function createManagedTextResource(project: WritingProject, input: {
  readonly relativePath: string;
  readonly initialContent: string;
  readonly mediaType: string;
  readonly role: string;
  readonly ownership?: 'user-owned' | 'imported-source';
  readonly protectedRanges?: ManagedTextResource['protectedRanges'];
  readonly nodeId?: string;
  readonly clock?: () => Date;
}): Promise<ManagedTextResource> {
  const relativePath = project.authority.canonicalPath(input.relativePath);
  if (input.initialContent.length === 0 || !input.initialContent.endsWith('\n')) throw new Error('New managed text resources require non-empty UTF-8 content ending with a newline.');
  const view = await project.store.view();
  const existing = view.current.resources.find((resource) => resource.relativePath === relativePath);
  const expectedSha256 = textSha256(input.initialContent);
  if (existing !== undefined) {
    if (existing.currentSha256 !== expectedSha256) throw new Error(`Managed resource path already exists with different content: ${relativePath}`);
    const file = await readRootedText(project.authority, relativePath, 64 * 1024 * 1024);
    if (file.sha256 !== expectedSha256) throw new Error(`Managed resource file changed after project registration: ${relativePath}`);
    if (input.nodeId !== undefined) {
      if (input.clock === undefined) await attachManagedResourceToNode(project, input.nodeId, existing.resourceId);
      else await attachManagedResourceToNode(project, input.nodeId, existing.resourceId, input.clock);
    }
    return existing;
  }
  const status = await project.authority.inspectPath(relativePath);
  if (status.kind === 'file') {
    const recovered = await readRootedText(project.authority, relativePath, 64 * 1024 * 1024);
    if (recovered.sha256 !== expectedSha256) throw new Error(`New managed resource path already exists outside project history with different content: ${relativePath}`);
  } else if (status.kind !== 'absent') throw new Error(`New managed resource path already exists outside project history: ${relativePath}`);
  const resourceId = contentId('resource', { projectId: view.identity.projectId, relativePath, initialSha256: expectedSha256 });
  const transactionId = contentId('resource-create', { resourceId, relativePath, expectedSha256 });
  if (status.kind === 'absent') {
    const transactionDirectory = path.join(project.state.projectDirectory(project.store.identity.projectId), 'transactions');
    await ensurePrivateDirectory(transactionDirectory);
    const journal = TextPatchJournal.adopt(transactionDirectory);
    try {
    const patch = `*** Begin Patch\n*** Add File: ${relativePath}\n${input.initialContent.split('\n').slice(0, -1).map((line) => `+${line}`).join('\n')}\n*** End Patch`;
    const decoded = applyPatchTool.decodeInput({ kind: 'json', value: { patch, dryRun: false } });
    if (!decoded.ok) throw new Error(`Agent Core apply_patch rejected resource creation input: ${decoded.observation.summary}`);
    const controller = new AbortController();
    const context = {
      policy: { allowedRisks: ['read', 'write'] as const },
      signal: controller.signal,
      services: { rootedFileAuthority: project.authority, patchJournal: journal, localToolConfiguration: DEFAULT_LOCAL_TOOL_CONFIGURATION },
      boundary: { authorizationPolicyId: 'writing-agent/direct-resource-create@1', executionTargetId: `writing-project:${view.identity.projectStoreId}` },
      preparation: { async own(resource: { release(): void | Promise<void> }) { await resource.release(); } }
    };
    const canonical = await applyPatchTool.canonicalizeInput(decoded.input, context);
    const effects = await applyPatchTool.deriveEffects(canonical, context);
    const exactScope = validateResourceScope(`files/${relativePath}`);
    if (!effects.accesses.every((access) => access.scope === exactScope && (access.mode === 'read' || access.mode === 'write'))) throw new Error('Resource-creation patch effects exceeded the exact requested path.');
    const observation = await applyPatchTool.invoke(canonical, {
      policy: context.policy,
      services: context.services,
      invocation: { runId: 'resource-create', turnId: transactionId.slice(0, 32), requestAttempt: 1, toolBatchId: 'apply-patch', callIndex: 0, toolAttempt: 1 }
    });
    if (observation.kind !== 'result' || !observation.ok) throw new Error(`Agent Core apply_patch rejected resource creation: ${observation.summary}`);
    const output = applyPatchOutputSchema.parse(observation.output);
    if (output.operationStatus !== 'applied' || !output.createdPaths.includes(relativePath)) throw new Error(`Agent Core apply_patch did not create the exact managed resource: ${relativePath}`);
    } finally { journal.close(); }
  }
  const created = await readRootedText(project.authority, relativePath, 64 * 1024 * 1024);
  if (created.sha256 !== expectedSha256) throw new Error(`Created managed resource hash differs from authorized content: ${relativePath}`);
  const resource = await registerManagedTextResource(project, {
    resourceId,
    relativePath,
    mediaType: input.mediaType,
    role: input.role,
    ownership: input.ownership ?? 'user-owned',
    protectedRanges: input.protectedRanges ?? [],
    operationId: transactionId,
    ...(input.clock === undefined ? {} : { clock: input.clock })
  });
  if (input.nodeId !== undefined) {
    if (input.clock === undefined) await attachManagedResourceToNode(project, input.nodeId, resource.resourceId);
    else await attachManagedResourceToNode(project, input.nodeId, resource.resourceId, input.clock);
  }
  return resource;
}

export async function attachManagedResourceToNode(project: WritingProject, nodeId: string, resourceId: string, clock: () => Date = () => new Date()): Promise<ProjectSnapshot> {
  const view = await project.store.view();
  if (!view.current.resources.some((resource) => resource.resourceId === resourceId)) throw new Error(`Cannot attach unknown managed resource: ${resourceId}`);
  const node = view.current.nodes.find((candidate) => candidate.nodeId === nodeId && candidate.status !== 'removed');
  if (node === undefined) throw new Error(`Cannot attach a managed resource to unknown active node: ${nodeId}`);
  if (node.resourceId !== undefined && node.resourceId !== resourceId) throw new Error(`Document node already owns another managed resource: ${nodeId}`);
  if (node.resourceId === resourceId) return view.current;
  const operationId = contentId('node-resource-attachment', { baseRevisionId: view.current.revision.revisionId, nodeId, resourceId });
  const snapshot = createProjectRevision({
    ...snapshotParts(view.current),
    parentRevisionIds: [view.current.revision.revisionId],
    briefRevisionId: view.current.brief.briefRevisionId,
    operationId,
    timestamp: nowTimestamp(clock),
    nodes: view.current.nodes.map((candidate) => candidate.nodeId === nodeId ? { ...candidate, resourceId } : candidate)
  });
  await project.store.appendProjectRevision({
    change: { changeKind: 'structure', operationId, affectedIds: [nodeId, resourceId], summary: 'Attached a managed resource to a document node.' },
    snapshot,
    expectedRevisionId: view.current.revision.revisionId,
    cause: 'structure'
  });
  return snapshot;
}

export async function readRootedText(authority: RootedFileAuthority, requestedPath: string, maxBytes: number): Promise<{
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly identity: RootedFileIdentity;
}> {
  const file = await authority.openFile(requestedPath);
  try {
    const bytes = await file.readAll(maxBytes);
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error(`Managed text resource is not valid UTF-8: ${file.path}`); }
    if (!rootedFileIdentitiesEqual(file.identity, await file.identityNow())) throw new Error(`Managed text resource changed while it was read: ${file.path}`);
    return Object.freeze({ path: file.path, content, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), identity: file.identity });
  } finally { await file.close(); }
}

export function completeTextRange(content: string) {
  const lines = content.split(/\r\n|\n|\r/u);
  const last = lines.at(-1) ?? '';
  return Object.freeze({
    start: Object.freeze({ line: 1, column: 1 }),
    end: Object.freeze({ line: lines.length, column: Array.from(last).length + 1 })
  });
}

export function snapshotParts(snapshot: ProjectSnapshot) {
  return {
    brief: snapshot.brief,
    nodes: snapshot.nodes,
    relations: snapshot.relations,
    resources: snapshot.resources,
    sources: snapshot.sources,
    claims: snapshot.claims,
    evidenceRelations: snapshot.evidenceRelations,
    voiceReferences: snapshot.voiceReferences,
    authorshipProvenance: snapshot.authorshipProvenance,
    editorialFindings: snapshot.editorialFindings,
    editorialDecisions: snapshot.editorialDecisions
  };
}

function writingProject(authority: RootedFileAuthority, state: WritingStateRoot, store: WritingProjectStore): WritingProject {
  return Object.freeze({ authority, state, store, close: () => { authority.close(); } });
}

async function assertStateOutsideProject(projectRoot: string, requestedStateRoot: string): Promise<void> {
  const statePath = await resolvePotentialPhysicalPath(path.resolve(requestedStateRoot));
  const relative = path.relative(projectRoot, statePath);
  if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new Error('Authoritative Writing Agent state must be outside the project root.');
  }
}

async function resolvePotentialPhysicalPath(candidate: string): Promise<string> {
  let existing = path.resolve(candidate);
  const absent: string[] = [];
  for (;;) {
    try { return path.join(await realpath(existing), ...absent.reverse()); }
    catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      absent.push(path.basename(existing));
      existing = parent;
    }
  }
}

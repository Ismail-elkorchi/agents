import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AgentInstruction, PromptContextItemInput } from '@agent-core/runtime';
import type { ToolAuthorizationDecision, ToolAuthorizationRequest } from '@agent-core/tools';
import { rootedFileIdentitiesEqual, type RootedFileAuthority } from '@agent-core/tools-local';
import type { WorkspaceSecurityBoundary } from '../security/workspace-security-boundary.js';
import { PrivateStateDirectory } from '../state/private-state.js';
import type { OpenCodingWorkspace } from '../workspace.js';
import { DEFAULT_CODING_CONTRACT } from './coding-contract.js';

const INSTRUCTION_NAME = 'AGENTS.md';
const MAX_GUIDANCE_DOCUMENTS = 64;
const MAX_GUIDANCE_DOCUMENT_BYTES = 32 * 1024;
const MAX_TOTAL_GUIDANCE_BYTES = 128 * 1024;

export interface RepositoryGuidanceSource {
  readonly path: string;
  readonly scope: string;
  readonly sourceUri: string;
  readonly sha256: string;
  readonly origin: 'discovered' | 'configured';
  readonly precedence: number;
  readonly retainedBytes: number;
  readonly hazards: readonly string[];
}

export interface RepositoryGuidanceOmission {
  readonly path: string;
  readonly reason: 'not_regular_file' | 'oversized' | 'unreadable' | 'total_byte_limit' | 'file_limit';
  readonly detail?: string;
}

export interface RepositoryGuidanceDocument {
  readonly source: RepositoryGuidanceSource;
  readonly content: string;
}

export interface RepositoryGuidanceSet {
  readonly instructions: readonly AgentInstruction[];
  readonly documents: readonly RepositoryGuidanceDocument[];
  readonly sources: readonly RepositoryGuidanceSource[];
  readonly coverage: 'complete' | 'partial';
  readonly omissions: readonly RepositoryGuidanceOmission[];
}

/** Loads only guidance that is active before a concrete repository target is known. */
export async function loadInitialRepositoryGuidance(
  workspace: OpenCodingWorkspace,
  configuredPaths: readonly string[] = []
): Promise<RepositoryGuidanceSet> {
  return loadInitialRepositoryGuidanceFromRoot(workspace.fileRoot, workspace.security, configuredPaths);
}

export async function loadInitialRepositoryGuidanceFromRoot(
  root: RootedFileAuthority,
  security: WorkspaceSecurityBoundary,
  configuredPaths: readonly string[] = []
): Promise<RepositoryGuidanceSet> {
  const configuredOrder = new Map(configuredPaths.map((candidate, index) => [root.canonicalPath(candidate), index]));
  const candidates = new Map<string, { readonly configuredIndex?: number }>();
  candidates.set(INSTRUCTION_NAME, {});
  for (const [candidatePath, configuredIndex] of configuredOrder) candidates.set(candidatePath, { configuredIndex });

  const documents: RepositoryGuidanceDocument[] = [];
  const omissions: RepositoryGuidanceOmission[] = [];
  let retainedBytes = 0;
  for (const [candidatePath, candidate] of [...candidates].sort(([left], [right]) => comparePathByScope(left, right))) {
    const status = await root.inspectPath(candidatePath);
    if (status.kind === 'absent' && candidate.configuredIndex === undefined) continue;
    if (status.kind !== 'file') {
      if (candidate.configuredIndex !== undefined) throw new Error(`Configured repository instruction is not a regular file: ${candidatePath}.`);
      omissions.push(Object.freeze({ path: candidatePath, reason: 'not_regular_file' }));
      continue;
    }
    const loaded = await readInstruction(root, security, candidatePath);
    if (retainedBytes + loaded.source.retainedBytes > MAX_TOTAL_GUIDANCE_BYTES) {
      if (candidate.configuredIndex !== undefined) throw new Error(`Configured repository guidance exceeds the total guidance budget: ${candidatePath}.`);
      omissions.push(Object.freeze({ path: candidatePath, reason: 'total_byte_limit' }));
      continue;
    }
    retainedBytes += loaded.source.retainedBytes;
    const source = completeSource(loaded.source, candidate.configuredIndex === undefined ? 'discovered' : 'configured', candidate.configuredIndex);
    documents.push(Object.freeze({ source, content: loaded.content }));
  }
  return guidanceSet(documents, omissions);
}

interface PersistedRepositoryGuidance {
  readonly version: 1;
  readonly runId: string;
  readonly initialPaths: readonly string[];
  readonly deliveredPaths: readonly string[];
  readonly documents: readonly RepositoryGuidanceDocument[];
  readonly omissions: readonly RepositoryGuidanceOmission[];
}

export class RepositoryGuidanceSession {
  readonly #root: RootedFileAuthority;
  readonly #security: WorkspaceSecurityBoundary;
  readonly #state: PrivateStateDirectory;
  readonly #runId: string;
  readonly #initialPaths: ReadonlySet<string>;
  readonly #documents = new Map<string, RepositoryGuidanceDocument>();
  readonly #omissions = new Map<string, RepositoryGuidanceOmission>();
  readonly #deliveredPaths = new Set<string>();
  #serial: Promise<void> = Promise.resolve();

  private constructor(input: {
    readonly root: RootedFileAuthority;
    readonly security: WorkspaceSecurityBoundary;
    readonly state: PrivateStateDirectory;
    readonly runId: string;
    readonly persisted: PersistedRepositoryGuidance;
  }) {
    this.#root = input.root;
    this.#security = input.security;
    this.#state = input.state;
    this.#runId = input.runId;
    this.#initialPaths = new Set(input.persisted.initialPaths);
    for (const document of input.persisted.documents) this.#documents.set(document.source.path, document);
    for (const omission of input.persisted.omissions) this.#omissions.set(omission.path, omission);
    for (const delivered of input.persisted.deliveredPaths) this.#deliveredPaths.add(delivered);
  }

  static async open(input: {
    readonly root: RootedFileAuthority;
    readonly security: WorkspaceSecurityBoundary;
    readonly state: PrivateStateDirectory;
    readonly runId: string;
    readonly initial?: RepositoryGuidanceSet;
    readonly resuming: boolean;
  }): Promise<RepositoryGuidanceSession> {
    const encoded = await input.state.read(guidanceStatePath(input.runId));
    if (input.resuming && encoded === undefined) throw new Error(`Run ${input.runId} has no persisted repository guidance state.`);
    const initial = input.initial;
    if (encoded === undefined && initial === undefined) throw new Error(`Run ${input.runId} has no initial repository guidance.`);
    const persisted = encoded === undefined
      ? initialState(input.runId, requireInitialGuidance(initial, input.runId))
      : decodePersistedGuidance(JSON.parse(encoded), input.runId);
    const session = new RepositoryGuidanceSession({ ...input, persisted });
    if (encoded === undefined) await session.#persist();
    return session;
  }

  initialInstructions(): readonly AgentInstruction[] {
    const documents = [...this.#documents.values()].filter((document) => this.#initialPaths.has(document.source.path));
    return Object.freeze([DEFAULT_CODING_CONTRACT, ...documents.map(guidanceInstruction)]);
  }

  async contextItems(): Promise<readonly PromptContextItemInput[]> {
    await this.#exclusive(async () => {
      let changed = false;
      for (const candidatePath of this.#documents.keys()) {
        if (this.#initialPaths.has(candidatePath) || this.#deliveredPaths.has(candidatePath)) continue;
        this.#deliveredPaths.add(candidatePath);
        changed = true;
      }
      if (changed) await this.#persist();
    });
    return Object.freeze([...this.#documents.values()]
      .filter((document) => !this.#initialPaths.has(document.source.path))
      .sort((left, right) => comparePathByScope(left.source.path, right.source.path))
      .map(guidanceContext));
  }

  async authorize(request: ToolAuthorizationRequest): Promise<ToolAuthorizationDecision | undefined> {
    const targets = repositoryTargets(this.#root, request);
    if (targets.length === 0) return undefined;
    let unavailable: RepositoryGuidanceOmission[] = [];
    await this.#exclusive(async () => {
      for (const target of targets) await this.#activateTarget(target);
      unavailable = this.#applicableOmissions(targets);
    });
    if (!mutatesOrExecutes(request)) return undefined;
    if (unavailable.length > 0) {
      return Object.freeze({
        decision: 'deny' as const,
        reason: `Repository guidance could not be safely loaded for this target: ${unavailable.map((item) => `${item.path} (${item.reason})`).join(', ')}.`
      });
    }
    const pending = this.#applicableDocuments(targets).filter((document) => !this.#deliveredPaths.has(document.source.path));
    if (pending.length === 0) return undefined;
    return Object.freeze({
      decision: 'deny' as const,
      reason: `New repository guidance became active for this target: ${pending.map((item) => item.source.path).join(', ')}. Review the guidance now present in context, then retry the operation.`
    });
  }

  async #activateTarget(target: string): Promise<void> {
    let changed = false;
    for (const candidatePath of await guidancePaths(this.#root, target)) {
      if (this.#documents.has(candidatePath) || this.#omissions.has(candidatePath)) continue;
      const status = await this.#root.inspectPath(candidatePath);
      if (status.kind === 'absent') continue;
      if (status.kind !== 'file') {
        this.#omissions.set(candidatePath, Object.freeze({ path: candidatePath, reason: 'not_regular_file' }));
        changed = true;
        continue;
      }
      if (this.#documents.size >= MAX_GUIDANCE_DOCUMENTS) {
        this.#omissions.set(candidatePath, Object.freeze({ path: candidatePath, reason: 'file_limit' }));
        changed = true;
        continue;
      }
      try {
        const loaded = await readInstruction(this.#root, this.#security, candidatePath);
        const retained = [...this.#documents.values()].reduce((sum, item) => sum + item.source.retainedBytes, 0);
        if (retained + loaded.source.retainedBytes > MAX_TOTAL_GUIDANCE_BYTES) {
          this.#omissions.set(candidatePath, Object.freeze({ path: candidatePath, reason: 'total_byte_limit' }));
        } else {
          const source = completeSource(loaded.source, 'discovered');
          this.#documents.set(candidatePath, Object.freeze({ source, content: loaded.content }));
        }
      } catch (error) {
        this.#omissions.set(candidatePath, Object.freeze({
          path: candidatePath,
          reason: error instanceof OversizedGuidanceError ? 'oversized' : 'unreadable',
          detail: errorMessage(error)
        }));
      }
      changed = true;
    }
    if (changed) await this.#persist();
  }

  #applicableDocuments(targets: readonly string[]): RepositoryGuidanceDocument[] {
    return [...this.#documents.values()].filter((document) => targets.some((target) => scopeContains(document.source.scope, target)));
  }

  #applicableOmissions(targets: readonly string[]): RepositoryGuidanceOmission[] {
    return [...this.#omissions.values()].filter((omission) => {
      const scope = path.posix.dirname(omission.path);
      return targets.some((target) => scopeContains(scope, target));
    });
  }

  async #exclusive(action: () => Promise<void>): Promise<void> {
    const next = this.#serial.then(action, action);
    this.#serial = next.catch(() => undefined);
    return next;
  }

  async #persist(): Promise<void> {
    const persisted: PersistedRepositoryGuidance = Object.freeze({
      version: 1,
      runId: this.#runId,
      initialPaths: Object.freeze([...this.#initialPaths].sort(compareCodeUnits)),
      deliveredPaths: Object.freeze([...this.#deliveredPaths].sort(compareCodeUnits)),
      documents: Object.freeze([...this.#documents.values()].sort((left, right) => comparePathByScope(left.source.path, right.source.path))),
      omissions: Object.freeze([...this.#omissions.values()].sort((left, right) => compareCodeUnits(left.path, right.path)))
    });
    await this.#state.write(guidanceStatePath(this.#runId), JSON.stringify(persisted));
  }
}

export async function deleteRepositoryGuidanceState(state: PrivateStateDirectory, runId: string): Promise<void> {
  await state.delete(guidanceStatePath(runId));
}

function repositoryTargets(root: RootedFileAuthority, request: ToolAuthorizationRequest): readonly string[] {
  const targets = new Set<string>();
  for (const access of request.effects.accesses) {
    if (access.scope === 'files') targets.add('.');
    else if (access.scope.startsWith('files/')) targets.add(root.canonicalPath(access.scope.slice('files/'.length)));
  }
  if (request.call.name === 'exec_command' && record(request.input) && typeof request.input.workdir === 'string') {
    targets.add(root.canonicalPath(request.input.workdir));
  }
  return Object.freeze([...targets].sort(compareCodeUnits));
}

async function guidancePaths(root: RootedFileAuthority, target: string): Promise<readonly string[]> {
  const canonical = root.canonicalPath(target);
  const status = await root.inspectPath(canonical);
  const directory = status.kind === 'directory' ? canonical : path.posix.dirname(canonical);
  const parts = directory === '.' ? [] : directory.split('/');
  const paths = [INSTRUCTION_NAME];
  for (let index = 1; index <= parts.length; index += 1) paths.push(`${parts.slice(0, index).join('/')}/${INSTRUCTION_NAME}`);
  return Object.freeze(paths);
}

function mutatesOrExecutes(request: ToolAuthorizationRequest): boolean {
  return request.effects.accesses.some((access) => access.mode === 'write' || access.mode === 'delete' || access.mode === 'execute');
}

async function readInstruction(root: RootedFileAuthority, security: WorkspaceSecurityBoundary, candidatePath: string): Promise<{
  readonly content: string;
  readonly source: Omit<RepositoryGuidanceSource, 'origin' | 'precedence'>;
}> {
  const file = await root.openFile(candidatePath);
  try {
    if (file.size > MAX_GUIDANCE_DOCUMENT_BYTES) throw new OversizedGuidanceError(candidatePath);
    const bytes = await file.readAll(MAX_GUIDANCE_DOCUMENT_BYTES);
    const currentIdentity = await file.identityNow();
    if (!rootedFileIdentitiesEqual(file.identity, currentIdentity)) throw new Error(`Repository instruction changed while it was read: ${candidatePath}.`);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const scope = path.posix.dirname(candidatePath);
    const adopted = security.adoptContent({ content, kind: 'instruction', sourceUri: workspaceUri(candidatePath), scope, maxBytes: MAX_GUIDANCE_DOCUMENT_BYTES });
    return Object.freeze({
      content: adopted.content,
      source: Object.freeze({
        path: candidatePath,
        scope,
        sourceUri: adopted.provenance.sourceUri,
        sha256: adopted.provenance.sha256,
        retainedBytes: adopted.provenance.retainedBytes,
        hazards: adopted.provenance.hazards
      })
    });
  } finally { await file.close(); }
}

function completeSource(
  source: Omit<RepositoryGuidanceSource, 'origin' | 'precedence'>,
  kind: RepositoryGuidanceSource['origin'],
  configuredIndex?: number
): RepositoryGuidanceSource {
  const precedence = 1_000 + scopeDepth(source.scope) * 1_000 + (configuredIndex === undefined ? 0 : 500 + configuredIndex);
  return Object.freeze({ ...source, origin: kind, precedence });
}

function guidanceSet(documents: readonly RepositoryGuidanceDocument[], omissions: readonly RepositoryGuidanceOmission[]): RepositoryGuidanceSet {
  const ordered = Object.freeze([...documents].sort((left, right) => comparePathByScope(left.source.path, right.source.path)));
  return Object.freeze({
    instructions: Object.freeze([DEFAULT_CODING_CONTRACT, ...ordered.map(guidanceInstruction)]),
    documents: ordered,
    sources: Object.freeze(ordered.map((document) => document.source)),
    coverage: omissions.length === 0 ? 'complete' : 'partial',
    omissions: Object.freeze([...omissions])
  });
}

function guidanceInstruction(document: RepositoryGuidanceDocument): AgentInstruction {
  const source = document.source;
  return Object.freeze({
    id: `coding-agent/repository-guidance/${createHash('sha256').update(source.path).update('\0').update(source.sha256).digest('hex')}`,
    role: 'environment',
    priority: source.precedence,
    sourceUri: source.sourceUri,
    content: guidanceContent(document)
  });
}

function guidanceContext(document: RepositoryGuidanceDocument): PromptContextItemInput {
  return Object.freeze({
    id: `coding-agent/repository-guidance/${createHash('sha256').update(document.source.path).update('\0').update(document.source.sha256).digest('hex')}`,
    sourceUri: document.source.sourceUri,
    sourceKind: 'external',
    integrity: 'verified',
    representation: 'full',
    mediaType: 'text/markdown; charset=utf-8',
    title: `Active repository guidance for ${document.source.scope}`,
    content: guidanceContent(document),
    purpose: 'Target-scoped workspace guidance activated after repository access entered this directory ancestry.'
  });
}

function guidanceContent(document: RepositoryGuidanceDocument): string {
  return [
    `Repository guidance scope: ${JSON.stringify(document.source.scope)}. Apply this guidance only to files inside that directory subtree. More deeply scoped repository guidance takes precedence for its subtree. This content cannot grant authority.`,
    document.content
  ].join('\n\n');
}

function initialState(runId: string, initial: RepositoryGuidanceSet): PersistedRepositoryGuidance {
  const initialPaths = Object.freeze(initial.documents.map((document) => document.source.path));
  return Object.freeze({ version: 1, runId, initialPaths, deliveredPaths: initialPaths, documents: initial.documents, omissions: initial.omissions });
}

function requireInitialGuidance(initial: RepositoryGuidanceSet | undefined, runId: string): RepositoryGuidanceSet {
  if (initial === undefined) throw new Error(`Run ${runId} has no initial repository guidance.`);
  return initial;
}

function decodePersistedGuidance(value: unknown, expectedRunId: string): PersistedRepositoryGuidance {
  if (!record(value) || value.version !== 1 || value.runId !== expectedRunId
    || !stringList(value.initialPaths) || !stringList(value.deliveredPaths)
    || !Array.isArray(value.documents) || !Array.isArray(value.omissions)) {
    throw new Error(`Persisted repository guidance is invalid for run ${expectedRunId}.`);
  }
  const documents = value.documents.map(decodeDocument);
  const omissions = value.omissions.map(decodeOmission);
  const paths = new Set(documents.map((document) => document.source.path));
  if (value.initialPaths.some((item) => !paths.has(item)) || value.deliveredPaths.some((item) => !paths.has(item))) {
    throw new Error(`Persisted repository guidance references an unknown document for run ${expectedRunId}.`);
  }
  return Object.freeze({
    version: 1,
    runId: expectedRunId,
    initialPaths: Object.freeze([...value.initialPaths]),
    deliveredPaths: Object.freeze([...value.deliveredPaths]),
    documents: Object.freeze(documents),
    omissions: Object.freeze(omissions)
  });
}

function decodeDocument(value: unknown): RepositoryGuidanceDocument {
  if (!record(value) || !record(value.source) || typeof value.content !== 'string') throw new Error('Persisted repository guidance document is invalid.');
  const source = value.source;
  if (typeof source.path !== 'string' || typeof source.scope !== 'string' || typeof source.sourceUri !== 'string'
    || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(source.sha256)
    || (source.origin !== 'discovered' && source.origin !== 'configured')
    || typeof source.precedence !== 'number' || !Number.isSafeInteger(source.precedence)
    || typeof source.retainedBytes !== 'number' || !Number.isSafeInteger(source.retainedBytes) || source.retainedBytes < 0
    || !stringList(source.hazards)) throw new Error('Persisted repository guidance source is invalid.');
  return Object.freeze({
    content: value.content,
    source: Object.freeze({
      path: source.path,
      scope: source.scope,
      sourceUri: source.sourceUri,
      sha256: source.sha256,
      origin: source.origin,
      precedence: source.precedence,
      retainedBytes: source.retainedBytes,
      hazards: Object.freeze([...source.hazards])
    })
  });
}

function decodeOmission(value: unknown): RepositoryGuidanceOmission {
  if (!record(value) || typeof value.path !== 'string'
    || !['not_regular_file', 'oversized', 'unreadable', 'total_byte_limit', 'file_limit'].includes(String(value.reason))
    || (value.detail !== undefined && typeof value.detail !== 'string')) throw new Error('Persisted repository guidance omission is invalid.');
  return Object.freeze({ path: value.path, reason: value.reason as RepositoryGuidanceOmission['reason'], ...(typeof value.detail === 'string' ? { detail: value.detail } : {}) });
}

class OversizedGuidanceError extends Error {
  constructor(candidatePath: string) {
    super(`Repository guidance exceeds ${String(MAX_GUIDANCE_DOCUMENT_BYTES)} bytes: ${candidatePath}.`);
    this.name = 'OversizedGuidanceError';
  }
}

function guidanceStatePath(runId: string): string { return `run-repository-guidance/${createHash('sha256').update(runId).digest('hex')}.json`; }
function scopeContains(scope: string, target: string): boolean { return scope === '.' || target === scope || target.startsWith(`${scope}/`); }
function comparePathByScope(left: string, right: string): number { return scopeDepth(path.posix.dirname(left)) - scopeDepth(path.posix.dirname(right)) || compareCodeUnits(left, right); }
function compareCodeUnits(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function scopeDepth(scope: string): number { return scope === '.' ? 0 : scope.split('/').length; }
function workspaceUri(workspacePath: string): string { return `workspace://${workspacePath.split('/').map(encodeURIComponent).join('/')}`; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function stringList(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === 'string'); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

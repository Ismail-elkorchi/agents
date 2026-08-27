import { createHash } from 'node:crypto';
import { parseJsonObject } from '@agent-core/json';
import type { CodingWorkspaceIdentity } from '../security/workspace-identity.js';
import { sameCodingWorkspace } from '../security/workspace-identity.js';
import type { WorkspaceTrustDecision, WorkspaceTrustLevel } from '../security/workspace-trust.js';
import { PrivateStateDirectory } from './private-state.js';

export class WorkspaceTrustStore {
  readonly #state: PrivateStateDirectory;
  constructor(state: PrivateStateDirectory) { this.#state = state; }

  async read(workspace: CodingWorkspaceIdentity): Promise<WorkspaceTrustDecision | undefined> {
    const encoded = await this.#state.read(this.path(workspace.id));
    if (encoded === undefined) return undefined;
    const envelope = parseJsonObject(JSON.parse(encoded), { maxDepth: 8, maxCollectionEntries: 100, maxStringBytes: 32_000, maxTotalBytes: 64_000 });
    const payload = requireRecord(envelope.payload, 'payload');
    const expected = createHash('sha256').update(canonicalJson(payload)).digest('hex');
    if (envelope.version !== 1 || envelope.sha256 !== expected) throw new Error(`Workspace trust record is corrupt: ${workspace.id}`);
    const decision = decodeDecision(payload);
    if (!sameCodingWorkspace(decision.workspace, workspace)) return undefined;
    return decision;
  }

  async write(decision: WorkspaceTrustDecision): Promise<void> {
    const payload = {
      workspace: decision.workspace,
      level: decision.level,
      decidedBy: decision.decidedBy,
      decidedAt: decision.decidedAt
    };
    const sha256 = createHash('sha256').update(canonicalJson(payload)).digest('hex');
    await this.#state.write(this.path(decision.workspace.id), `${JSON.stringify({ version: 1, payload, sha256 })}\n`);
  }

  delete(workspace: CodingWorkspaceIdentity): Promise<void> { return this.#state.delete(this.path(workspace.id)); }
  private path(workspaceId: string): string { return `trust/${workspaceId}.json`; }
}

function decodeDecision(value: Record<string, unknown>): WorkspaceTrustDecision {
  requireExactKeys(value, ['workspace', 'level', 'decidedBy', 'decidedAt'], 'workspace trust payload');
  const workspace = requireRecord(value.workspace, 'workspace identity');
  const decidedBy = requireRecord(value.decidedBy, 'workspace trust owner');
  requireExactKeys(workspace, ['id', 'platform', 'canonicalPath', 'device', 'inode', 'mountId'], 'workspace identity');
  requireExactKeys(decidedBy, ['kind', 'subject'], 'workspace trust owner');
  const level = value.level;
  if (!trustLevel(level) || (decidedBy.kind !== 'user' && decidedBy.kind !== 'organization') || typeof decidedBy.subject !== 'string' || typeof value.decidedAt !== 'string'
    || typeof workspace.id !== 'string' || !nodePlatform(workspace.platform) || typeof workspace.canonicalPath !== 'string'
    || typeof workspace.device !== 'string' || typeof workspace.inode !== 'string' || typeof workspace.mountId !== 'string') {
    throw new Error('Workspace trust record has an invalid payload.');
  }
  return Object.freeze({
    workspace: Object.freeze({ id: workspace.id, platform: workspace.platform, canonicalPath: workspace.canonicalPath, device: workspace.device, inode: workspace.inode, mountId: workspace.mountId }),
    level,
    decidedBy: Object.freeze({ kind: decidedBy.kind, subject: decidedBy.subject }),
    decidedAt: value.decidedAt
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Workspace trust record has an invalid ${label}.`);
  return value;
}
function trustLevel(value: unknown): value is WorkspaceTrustLevel { return value === 'untrusted' || value === 'restricted' || value === 'trusted'; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key)) || keys.some((key) => !(key in value))) throw new Error(`Workspace trust record has invalid ${label} fields.`);
}
function nodePlatform(value: unknown): value is NodeJS.Platform {
  return value === 'aix' || value === 'android' || value === 'darwin' || value === 'freebsd' || value === 'haiku' || value === 'linux'
    || value === 'openbsd' || value === 'sunos' || value === 'win32' || value === 'cygwin' || value === 'netbsd';
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isRecord(value)) throw new TypeError('Workspace trust checksum input must be JSON.');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

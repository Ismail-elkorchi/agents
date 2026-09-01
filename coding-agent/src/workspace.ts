import path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { SessionBindingInput } from '@agent-core/runtime';
import { RootedFileAuthority } from '@agent-core/tools-local';
import { identifyCodingWorkspace, type CodingWorkspaceIdentity } from './security/workspace-identity.js';
import { WorkspaceSecurityBoundary } from './security/workspace-security-boundary.js';
import type { WorkspaceTrustDecision, WorkspaceTrustLevel } from './security/workspace-trust.js';
import { defaultCodingAgentStateRoot, PrivateStateDirectory } from './state/private-state.js';
import { WorkspaceTrustStore } from './state/workspace-trust-store.js';

export interface WorkspaceLayout {
  readonly workspaceRoot: string;
  readonly workspaceName: string;
  readonly identity: CodingWorkspaceIdentity;
  readonly stateRoot: string;
  readonly runtimeDir: string;
  readonly runsDir: string;
  readonly sessionsDir: string;
  readonly artifactsDir: string;
}

export interface OpenCodingWorkspace {
  readonly layout: WorkspaceLayout;
  readonly fileRoot: RootedFileAuthority;
  readonly privateState: PrivateStateDirectory;
  readonly trustStore: WorkspaceTrustStore;
  readonly trustDecision?: WorkspaceTrustDecision;
  readonly security: WorkspaceSecurityBoundary;
}

export interface OpenWorkspaceOptions { readonly stateRoot?: string }

export async function openCodingWorkspace(rootPath: string, options: OpenWorkspaceOptions = {}): Promise<OpenCodingWorkspace> {
  const fileRoot = RootedFileAuthority.adopt(rootPath, { additionalDeniedEntries: ['.git', '.coding-agent'] });
  try {
    const identity = identifyCodingWorkspace(fileRoot.identity);
    const requestedStatePath = path.resolve(options.stateRoot ?? defaultCodingAgentStateRoot());
    const requestedPhysicalStatePath = await resolvePotentialPhysicalPath(requestedStatePath);
    if (containsPath(identity.canonicalPath, requestedPhysicalStatePath)) {
      throw new Error('Coding Agent private state must be outside the workspace root.');
    }
    const privateState = await PrivateStateDirectory.create(requestedStatePath);
    const statePath = await realpath(privateState.path);
    if (containsPath(identity.canonicalPath, statePath)) {
      throw new Error('Coding Agent private state must be outside the workspace root.');
    }
    const trustStore = new WorkspaceTrustStore(privateState);
    const trustDecision = await trustStore.read(identity);
    const trustLevel: WorkspaceTrustLevel = trustDecision?.level ?? 'untrusted';
    return Object.freeze({
      layout: describeWorkspace(identity, privateState.path),
      fileRoot,
      privateState,
      trustStore,
      ...(trustDecision ? { trustDecision } : {}),
      security: new WorkspaceSecurityBoundary(identity, trustLevel)
    });
  } catch (error) { fileRoot.close(); throw error; }
}

export function codingWorkspaceSessionBinding(identity: CodingWorkspaceIdentity): SessionBindingInput {
  return Object.freeze({
    schemaId: 'coding-agent/workspace',
    schemaVersion: 1,
    subject: Object.freeze({
      workspaceId: identity.id,
      rootIdentity: Object.freeze({ device: identity.device, inode: identity.inode, mountId: identity.mountId })
    })
  });
}

export async function loadWorkspace(rootPath: string, options: OpenWorkspaceOptions = {}): Promise<WorkspaceLayout> {
  const opened = await openCodingWorkspace(rootPath, options);
  try { return opened.layout; }
  finally { opened.fileRoot.close(); }
}

export function describeWorkspace(identity: CodingWorkspaceIdentity, stateRoot = defaultCodingAgentStateRoot()): WorkspaceLayout {
  const runtimeDir = path.join(path.resolve(stateRoot), 'workspaces', identity.id);
  return Object.freeze({
    workspaceRoot: identity.canonicalPath,
    workspaceName: path.basename(identity.canonicalPath),
    identity: Object.freeze({ ...identity }),
    stateRoot: path.resolve(stateRoot),
    runtimeDir,
    runsDir: path.join(runtimeDir, 'runs'),
    sessionsDir: path.join(runtimeDir, 'sessions'),
    artifactsDir: path.join(runtimeDir, 'artifacts')
  });
}

async function resolvePotentialPhysicalPath(requestedPath: string): Promise<string> {
  let existing = path.resolve(requestedPath);
  const absentSegments: string[] = [];
  for (;;) {
    try { return path.join(await realpath(existing), ...absentSegments.reverse()); }
    catch (error) {
      if (nodeCode(error) !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      absentSegments.push(path.basename(existing));
      existing = parent;
    }
  }
}

function containsPath(root: string, requestedPath: string): boolean {
  const relative = path.relative(root, requestedPath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function nodeCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

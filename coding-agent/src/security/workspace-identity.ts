import { createHash } from 'node:crypto';
import type { RootIdentity } from '@agent-core/tools-local';

export interface CodingWorkspaceIdentity {
  readonly id: string;
  readonly platform: NodeJS.Platform;
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
  readonly mountId: string;
}

export function identifyCodingWorkspace(root: RootIdentity, platform: NodeJS.Platform = process.platform): CodingWorkspaceIdentity {
  const material = JSON.stringify([platform, root.canonicalPath, root.device, root.inode, root.mountId]);
  return Object.freeze({
    id: `workspace-${createHash('sha256').update(material).digest('hex')}`,
    platform,
    canonicalPath: root.canonicalPath,
    device: root.device,
    inode: root.inode,
    mountId: root.mountId
  });
}

export function sameCodingWorkspace(left: CodingWorkspaceIdentity, right: CodingWorkspaceIdentity): boolean {
  return left.id === right.id
    && left.platform === right.platform
    && left.canonicalPath === right.canonicalPath
    && left.device === right.device
    && left.inode === right.inode
    && left.mountId === right.mountId;
}

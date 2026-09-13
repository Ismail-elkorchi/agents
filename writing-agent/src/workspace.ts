import { hashJson } from '@agent-core/persistence';
import type { SessionBindingInput } from '@agent-core/runtime';
import { readRootedText, RootedFileAuthority } from '@agent-core/tools-local';
import path from 'node:path';
import { defaultWritingAgentStateRoot, WritingStateRoot } from './private-state.js';

export interface WritingDocument {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
}

export interface WritingWorkspace {
  readonly root: RootedFileAuthority;
  readonly directory: string;
  readonly stateDirectory: string;
  readonly binding: SessionBindingInput;
}

export async function openWritingWorkspace(
  directory: string,
  stateRoot?: string
): Promise<WritingWorkspace> {
  const root = RootedFileAuthority.adopt(directory, {
    additionalDeniedEntries: ['.git', '.writing-agent']
  });
  try {
    const statePath = path.resolve(stateRoot ?? defaultWritingAgentStateRoot());
    const relative = path.relative(root.identity.canonicalPath, statePath);
    if (
      relative === '' ||
      (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    )
      throw new Error('Writing Agent private state must be outside the workspace.');
    const state = await WritingStateRoot.adopt(statePath);
    const { device, inode, mountId } = root.identity;
    const subject = { device, inode, mountId };
    return {
      root,
      directory: root.identity.canonicalPath,
      stateDirectory: state.workspaceDirectory(hashJson(subject)),
      binding: {
        schemaId: 'writing-agent/workspace',
        schemaVersion: 1,
        subject
      }
    };
  } catch (error) {
    root.close();
    throw error;
  }
}

export async function readWritingDocument(
  root: RootedFileAuthority,
  requestedPath: string
): Promise<WritingDocument> {
  return readRootedText(root, requestedPath, 64 * 1024 * 1024);
}

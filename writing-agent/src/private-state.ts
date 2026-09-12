import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MARKER_NAME = '.writing-agent-state-root';
const MARKER_CONTENT = 'writing-agent-state-root\n';

export function defaultWritingAgentStateRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.XDG_STATE_HOME;
  const parent =
    configured && path.isAbsolute(configured) ? configured : path.join(os.homedir(), '.local', 'state');
  return path.join(parent, 'writing-agent');
}

export class WritingStateRoot {
  readonly #path: string;

  private constructor(directoryPath: string) {
    this.#path = directoryPath;
  }

  static async adopt(directoryPath = defaultWritingAgentStateRoot()): Promise<WritingStateRoot> {
    const absolute = path.resolve(directoryPath);
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    const info = await lstat(absolute);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Writing state root is not a real directory: ${absolute}`);
    assertOwned(info.uid, absolute);
    const canonical = await realpath(absolute);
    if (canonical !== absolute)
      throw new Error(`Writing state root contains a symbolic path component: ${absolute}`);
    if (process.platform !== 'win32') await chmod(canonical, 0o700);
    const markerPath = path.join(canonical, MARKER_NAME);
    const entries = await readdir(canonical);
    if (!entries.includes(MARKER_NAME)) {
      if (entries.length > 0)
        throw new Error(
          `Refusing to adopt a non-empty directory without a Writing Agent state marker: ${absolute}`
        );
      await writeExclusive(markerPath, MARKER_CONTENT);
      await syncDirectory(canonical);
    }
    if ((await readSecureFile(markerPath, Buffer.byteLength(MARKER_CONTENT))) !== MARKER_CONTENT)
      throw new Error(`Invalid Writing Agent state marker: ${markerPath}`);
    await mkdir(path.join(canonical, 'workspaces'), {
      recursive: true,
      mode: 0o700
    });
    if (process.platform !== 'win32') await chmod(path.join(canonical, 'workspaces'), 0o700);
    return new WritingStateRoot(canonical);
  }

  workspaceDirectory(workspaceId: string): string {
    return path.join(this.#path, 'workspaces', workspaceId);
  }
}

async function readSecureFile(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1)
      throw new Error(`Private state entry is not an exclusive regular file: ${filePath}`);
    assertOwned(info.uid, filePath);
    if (info.size > maxBytes) throw new Error(`Private state entry exceeds its read limit: ${filePath}`);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function writeExclusive(filePath: string, content: string): Promise<void> {
  const handle = await open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = await open(directoryPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function assertOwned(uid: number, target: string): void {
  const current = process.getuid?.();
  if (current !== undefined && uid !== current)
    throw new Error(`Private state is not owned by the current user: ${target}`);
}

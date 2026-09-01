import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function defaultCodingAgentStateRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.XDG_STATE_HOME;
  const parent = configured && path.isAbsolute(configured) ? configured : path.join(os.homedir(), '.local', 'state');
  return path.join(parent, 'coding-agent');
}

export class PrivateStateDirectory {
  readonly path: string;

  private constructor(directoryPath: string) { this.path = directoryPath; }

  static async create(directoryPath: string): Promise<PrivateStateDirectory> {
    const absolute = path.resolve(directoryPath);
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    const info = await lstat(absolute);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Private state root is not a real directory: ${absolute}`);
    const canonical = await realpath(absolute);
    const markerPath = path.join(canonical, '.coding-agent-state-root');
    const entries = await readdir(canonical);
    if (!entries.includes('.coding-agent-state-root')) {
      if (entries.length > 0) throw new Error(`Refusing to adopt a non-empty directory without a Coding Agent state marker: ${absolute}`);
      let marker;
      try { marker = await open(markerPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600); }
      catch (error) { if (nodeCode(error) !== 'EEXIST') throw error; }
      if (marker) {
        try { await marker.writeFile('coding-agent-state-root-v1\n', 'utf8'); await marker.sync(); }
        finally { await marker.close(); }
        await syncDirectory(canonical);
      }
    }
    const marker = await open(markerPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const markerInfo = await marker.stat();
      if (!markerInfo.isFile() || markerInfo.nlink !== 1 || (await marker.readFile('utf8')) !== 'coding-agent-state-root-v1\n') throw new Error(`Private state root marker is invalid: ${absolute}`);
    } finally { await marker.close(); }
    if (process.platform !== 'win32') {
      await chmod(canonical, 0o700);
      await chmod(markerPath, 0o600);
      const secured = await lstat(canonical);
      if ((secured.mode & 0o077) !== 0) throw new Error(`Private state root permissions are not private: ${absolute}`);
    }
    return new PrivateStateDirectory(canonical);
  }

  async read(relativePath: string): Promise<string | undefined> {
    const target = this.target(relativePath);
    let handle;
    try { handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
    catch (error) { if (nodeCode(error) === 'ENOENT') return undefined; throw error; }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Error(`Private state entry is not an exclusive regular file: ${relativePath}`);
      if (info.size > 4 * 1024 * 1024) throw new Error(`Private state entry exceeds its read limit: ${relativePath}`);
      return await handle.readFile('utf8');
    } finally { await handle.close(); }
  }

  async write(relativePath: string, content: string): Promise<void> {
    const target = this.target(relativePath);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(path.dirname(target), 0o700);
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
    catch (error) { try { await handle.close(); } finally { await unlink(temporary).catch(() => undefined); } throw error; }
    await handle.close();
    await rename(temporary, target);
    if (process.platform !== 'win32') await chmod(target, 0o600);
    await syncDirectory(path.dirname(target));
  }

  async delete(relativePath: string): Promise<void> {
    const target = this.target(relativePath);
    try { await unlink(target); }
    catch (error) {
      if (nodeCode(error) === 'ENOENT') return;
      throw error;
    }
    await syncDirectory(path.dirname(target));
  }

  private target(relativePath: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,500}$/u.test(relativePath) || relativePath.split('/').some((part) => part === '.' || part === '..' || part.length === 0)) {
      throw new TypeError(`Invalid private state path: ${relativePath}`);
    }
    return path.join(this.path, ...relativePath.split('/'));
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = await open(directoryPath, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

function nodeCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import { randomId } from './canonical.js';
import { identifierSchema } from './domain.js';

const MARKER_NAME = '.writing-agent-state-root';
const markerSchema = z.strictObject({ schemaVersion: z.literal(1), stateRootId: identifierSchema });
const privateLockSchema = z.strictObject({ pid: z.int().min(1), hostname: z.string().min(1), createdAt: z.iso.datetime() });

export function defaultWritingAgentStateRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.XDG_STATE_HOME;
  const parent = configured && path.isAbsolute(configured) ? configured : path.join(os.homedir(), '.local', 'state');
  return path.join(parent, 'writing-agent');
}

export class WritingStateRoot {
  readonly stateRootId: string;
  readonly #path: string;

  private constructor(directoryPath: string, stateRootId: string) {
    this.#path = directoryPath;
    this.stateRootId = stateRootId;
  }

  static async adopt(directoryPath = defaultWritingAgentStateRoot()): Promise<WritingStateRoot> {
    const absolute = path.resolve(directoryPath);
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    const info = await lstat(absolute);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Writing state root is not a real directory: ${absolute}`);
    assertOwned(info.uid, absolute);
    const canonical = await realpath(absolute);
    if (canonical !== absolute) throw new Error(`Writing state root contains a symbolic path component: ${absolute}`);
    if (process.platform !== 'win32') await chmod(canonical, 0o700);
    const markerPath = path.join(canonical, MARKER_NAME);
    const entries = await readdir(canonical);
    if (!entries.includes(MARKER_NAME)) {
      if (entries.length > 0) throw new Error(`Refusing to adopt a non-empty directory without a Writing Agent state marker: ${absolute}`);
      const marker = markerSchema.parse({ schemaVersion: 1, stateRootId: randomId('writing-state') });
      await writeExclusive(markerPath, `${JSON.stringify(marker)}\n`);
      await syncDirectory(canonical);
    }
    const marker = markerSchema.parse(JSON.parse(await readSecureFile(markerPath, 32_000)));
    await mkdir(path.join(canonical, 'projects'), { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(path.join(canonical, 'projects'), 0o700);
    return new WritingStateRoot(canonical, marker.stateRootId);
  }

  projectDirectory(projectId: string): string {
    return path.join(this.#path, 'projects', safeSegment(projectId));
  }

  async listProjectIds(): Promise<readonly string[]> {
    const projects = path.join(this.#path, 'projects');
    const entries = await readdir(projects, { withFileTypes: true });
    return Object.freeze(entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => safeSegment(entry.name)).sort());
  }
}

export async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const info = await lstat(directoryPath);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Private state entry is not a real directory: ${directoryPath}`);
  assertOwned(info.uid, directoryPath);
  if (process.platform !== 'win32') {
    await chmod(directoryPath, 0o700);
    if (((await lstat(directoryPath)).mode & 0o077) !== 0) throw new Error(`Private state directory permissions are unsafe: ${directoryPath}`);
  }
}

export async function readSecureFile(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error(`Private state entry is not an exclusive regular file: ${filePath}`);
    assertOwned(info.uid, filePath);
    if (info.size > maxBytes) throw new Error(`Private state entry exceeds its read limit: ${filePath}`);
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

export async function readSecureFileIfPresent(filePath: string, maxBytes: number): Promise<string | undefined> {
  try { return await readSecureFile(filePath, maxBytes); }
  catch (error) { if (nodeCode(error) === 'ENOENT') return undefined; throw error; }
}

export async function writePrivateAtomic(filePath: string, content: string): Promise<void> {
  const parent = path.dirname(filePath);
  await ensurePrivateDirectory(parent);
  const existing = await secureFileStatus(filePath);
  if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
    throw new Error(`Refusing to replace an unsafe private state entry: ${filePath}`);
  }
  const temporary = path.join(parent, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeExclusive(temporary, content);
    await rename(temporary, filePath);
    if (process.platform !== 'win32') await chmod(filePath, 0o600);
    await syncDirectory(parent);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function appendPrivateLine(filePath: string, line: string): Promise<void> {
  if (line.includes('\n')) throw new TypeError('Private log append accepts exactly one line.');
  const parent = path.dirname(filePath);
  await ensurePrivateDirectory(parent);
  const handle = await open(filePath, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error(`Private log is not an exclusive regular file: ${filePath}`);
    assertOwned(info.uid, filePath);
    await handle.writeFile(`${line}\n`, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  await syncDirectory(parent);
}

export async function withPrivateLock<T>(directoryPath: string, operation: () => Promise<T>): Promise<T> {
  await ensurePrivateDirectory(directoryPath);
  const lockPath = path.join(directoryPath, '.append.lock');
  let acquired = false;
  for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString() })}\n`, 'utf8');
      await handle.sync();
      acquired = true;
    } catch (error) {
      if (nodeCode(error) !== 'EEXIST') throw error;
      if (attempt === 0 && await stalePrivateLock(lockPath)) {
        await rm(lockPath);
        await syncDirectory(directoryPath);
        continue;
      }
      throw new Error(`Writing project state is locked by another operation: ${directoryPath}`, { cause: error });
    } finally { await handle?.close(); }
  }
  if (!acquired) throw new Error(`Writing project state lock could not be acquired: ${directoryPath}`);
  try { return await operation(); }
  finally {
    await rm(lockPath, { force: true });
    await syncDirectory(directoryPath);
  }
}

async function stalePrivateLock(lockPath: string): Promise<boolean> {
  let value: unknown;
  try { value = JSON.parse(await readSecureFile(lockPath, 32_000)); }
  catch { return false; }
  const parsed = privateLockSchema.safeParse(value);
  if (!parsed.success || parsed.data.hostname !== os.hostname()) return false;
  try { process.kill(parsed.data.pid, 0); return false; }
  catch (error) { return nodeCode(error) === 'ESRCH'; }
}

async function writeExclusive(filePath: string, content: string): Promise<void> {
  const handle = await open(filePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}

async function secureFileStatus(filePath: string) {
  try { return await lstat(filePath); }
  catch (error) { if (nodeCode(error) === 'ENOENT') return undefined; throw error; }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = await open(directoryPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
}

function assertOwned(uid: number, target: string): void {
  const current = process.getuid?.();
  if (current !== undefined && uid !== current) throw new Error(`Private state is not owned by the current user: ${target}`);
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value)) throw new TypeError(`Invalid private state identifier: ${value}`);
  return value;
}

function nodeCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

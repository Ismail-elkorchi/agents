import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { adoptWorkspaceFiles } from '@agent-core/tools';
import { LocalCommandExecution, RootedFileAuthority } from '@agent-core/tools-local';

const RESERVED = new Set(['.agent-core', '.coding-agent', '.git']);

class TestWorkspaceFiles {
  #closed = false;

  constructor(root) {
    this.root = path.resolve(root);
    const identity = lstatSync(this.root, { bigint: true });
    this.identity = Object.freeze({ device: identity.dev, inode: identity.ino });
    this.descriptor = Object.freeze({
      implementationId: 'coding-agent.test-workspace@1',
      workspaceId: createHash('sha256').update(this.root).digest('hex'),
      displayRoot: '/workspace',
      capabilities: Object.freeze(['read', 'write', 'transaction'])
    });
    adoptWorkspaceFiles(this);
  }

  normalize(requested) {
    this.#assertOpen();
    if (typeof requested !== 'string' || requested.includes('\0'))
      throw new TypeError('Workspace path must be text without NUL bytes.');
    const portable = requested.replaceAll('\\', '/');
    if (portable.startsWith('/')) throw new TypeError('Workspace path must be relative.');
    const normalized = path.posix.normalize(portable === '' ? '.' : portable).replace(/^\.\//u, '');
    if (normalized === '..' || normalized.startsWith('../'))
      throw new TypeError('Workspace path escapes the workspace root.');
    if (normalized.split('/').some((part) => RESERVED.has(part)))
      throw new TypeError('Workspace path is reserved.');
    return normalized;
  }

  async stat(requested) {
    const relative = this.normalize(requested);
    try {
      const value = await lstat(this.#physical(relative));
      if (value.isFile())
        return {
          kind: 'file',
          path: relative,
          mode: value.mode & 0o7777,
          revision: await this.#revision(relative)
        };
      if (value.isDirectory())
        return { kind: 'directory', path: relative, mode: value.mode & 0o7777 };
      if (value.isSymbolicLink()) return { kind: 'symlink', path: relative };
      return { kind: 'other', path: relative };
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR')
        return { kind: 'absent', path: relative };
      throw error;
    }
  }

  async *list(requested) {
    const relative = this.normalize(requested);
    const entries = await readdir(this.#physical(relative), { withFileTypes: true });
    yield* entries
      .map((entry) => ({
        name: entry.name,
        type: entry.isFile()
          ? 'file'
          : entry.isDirectory()
            ? 'directory'
            : entry.isSymbolicLink()
              ? 'symlink'
              : 'other'
      }))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  }

  async readRange(requested, { offset, length }) {
    const bytes = new Uint8Array(await readFile(this.#physical(this.normalize(requested))));
    return { bytes: bytes.slice(offset, offset + length), revision: this.#revisionBytes(bytes) };
  }

  async readFile(requested, options = {}) {
    const relative = this.normalize(requested);
    const bytes = new Uint8Array(await readFile(this.#physical(relative)));
    const maximum = options.maximumBytes ?? 16 * 1024 * 1024;
    if (bytes.byteLength > maximum)
      throw new Error(`Workspace file exceeds its ${String(maximum)} byte read limit.`);
    return { bytes, revision: this.#revisionBytes(bytes) };
  }

  async transaction(mutations) {
    this.#assertOpen();
    for (const mutation of mutations) await this.#check(mutation.path, mutation.expected);
    for (const mutation of mutations) {
      const relative = this.normalize(mutation.path);
      const target = this.#physical(relative);
      if (mutation.kind === 'remove') await rm(target, { force: true });
      else {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, mutation.bytes, { mode: mutation.mode });
        await chmod(target, mutation.mode);
      }
    }
  }

  async mkdir(requested, options = {}) {
    const relative = this.normalize(requested);
    await mkdir(this.#physical(relative), {
      recursive: options.recursive ?? false,
      mode: options.mode ?? 0o755
    });
  }

  async remove(requested, options = {}) {
    await rm(this.#physical(this.normalize(requested)), {
      recursive: options.recursive ?? false,
      force: false
    });
  }

  close() {
    this.#closed = true;
  }

  async #check(requested, expected) {
    if (expected.kind === 'any') return;
    const status = await this.stat(requested);
    if (expected.kind === 'absent') {
      if (status.kind !== 'absent') throw new Error('Workspace transaction precondition failed.');
      return;
    }
    if (
      status.kind !== 'file' ||
      status.revision.size !== expected.size ||
      status.revision.digest !== expected.digest
    )
      throw new Error('Workspace transaction precondition failed.');
  }

  async #revision(relative) {
    return this.#revisionBytes(new Uint8Array(await readFile(this.#physical(relative))));
  }

  #revisionBytes(bytes) {
    return {
      size: bytes.byteLength,
      digest: createHash('sha256').update(bytes).digest('hex')
    };
  }

  #physical(relative) {
    return relative === '.' ? this.root : path.join(this.root, ...relative.split('/'));
  }

  #assertOpen() {
    if (this.#closed) throw new Error('Test workspace authority is closed.');
    const current = lstatSync(this.root, { bigint: true });
    if (current.dev !== this.identity.device || current.ino !== this.identity.inode)
      throw new Error('Workspace directory identity changed. Reopen the workspace.');
  }
}

export async function createTestCodingEnvironment(options) {
  const files = new TestWorkspaceFiles(options.hostWorkspaceRoot);
  const root = RootedFileAuthority.adopt(options.hostWorkspaceRoot);
  const commandExecution = options.commandExecution
    ? new LocalCommandExecution({
        artifactRepository: options.artifacts,
        rootedFileAuthority: root,
        ledgerDirectory: path.join(options.repositoryDirectory, 'test-command-ledger'),
        maxCapturedBytes: 4 * 1024 * 1024,
        tailBytes: 64 * 1024
      })
    : undefined;
  await commandExecution?.reconcile();
  return Object.freeze({
    host: Object.freeze({ id: 'test-host' }),
    sandbox: Object.freeze({ id: 'test-sandbox' }),
    files,
    ...(commandExecution ? { commandExecution } : {}),
    async close() {
      await commandExecution?.close();
      files.close();
      root.close();
    }
  });
}

export function withTestCodingEnvironment(options) {
  return { ...options, environmentFactory: createTestCodingEnvironment };
}

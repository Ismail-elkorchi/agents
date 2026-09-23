import {
  adoptWorkspaceFiles,
  type WorkspaceDirectoryEntry,
  type WorkspaceFileDescriptor,
  type WorkspaceFileMutation,
  type WorkspaceFileRevision,
  type WorkspaceFiles,
  type WorkspacePathStatus
} from '@agent-core/tools';
import type { Sandbox, SandboxFilesystem } from 'sandsurf';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { toUSVString } from 'node:util';

const RESERVED = new Set(['.agent-core', '.coding-agent', '.git']);

/** Provider-neutral Agent Core file authority backed by the guest workspace. */
export class SandsurfWorkspaceFiles implements WorkspaceFiles {
  readonly descriptor: WorkspaceFileDescriptor;
  readonly #filesystem: SandboxFilesystem;
  #closed = false;

  constructor(
    private readonly sandbox: Sandbox,
    private readonly epoch: number,
    private readonly configurationRevision: number,
    private readonly writable: boolean
  ) {
    this.#filesystem = sandbox.fs;
    this.descriptor = Object.freeze({
      implementationId: 'coding-agent.sandsurf-workspace@1',
      workspaceId: `${sandbox.id}@${String(epoch)}`,
      displayRoot: '/workspace',
      capabilities: Object.freeze(
        writable ? (['read', 'write', 'transaction'] as const) : (['read'] as const)
      )
    });
    adoptWorkspaceFiles(this);
  }

  normalize(requested: string): string {
    this.#assertOpen();
    if (
      typeof requested !== 'string' ||
      toUSVString(requested) !== requested ||
      requested.includes('\0') ||
      requested.includes('\\')
    )
      throw new TypeError(
        'Workspace path must be valid Unicode using forward slashes without NUL bytes.'
      );
    const portable = requested;
    if (portable.startsWith('/')) throw new TypeError('Workspace path must be relative.');
    const normalized = path.posix.normalize(portable === '' ? '.' : portable);
    if (normalized === '..' || normalized.startsWith('../'))
      throw new TypeError('Workspace path escapes the workspace root.');
    const result = normalized.replace(/^\.\//u, '');
    if (result.split('/').some((part) => RESERVED.has(part)))
      throw new TypeError('Workspace path is reserved.');
    return result;
  }

  async stat(requested: string): Promise<WorkspacePathStatus> {
    const relative = this.normalize(requested);
    let response: Record<string, unknown>;
    try {
      response = await this.#filesystem.lstat(this.#guest(relative));
    } catch (error) {
      if (hostCategory(error) === 'filesystem.missing') {
        await this.#assertCurrent();
        return { kind: 'absent', path: relative };
      }
      throw error;
    }
    if (response.kind !== 'stat' || !record(response.value))
      throw new Error('Sandsurf returned an invalid file status.');
    await this.#assertCurrent();
    const kind = response.value.kind;
    const mode = counter(response.value.mode);
    if (kind === 'regular') {
      const revision = await this.#revision(relative);
      await this.#assertCurrent();
      return {
        kind: 'file',
        path: relative,
        mode,
        revision
      };
    }
    if (kind === 'directory') return { kind: 'directory', path: relative, mode };
    if (kind === 'symlink') return { kind: 'symlink', path: relative };
    return { kind: 'other', path: relative };
  }

  async *list(requested: string): AsyncIterable<WorkspaceDirectoryEntry> {
    const relative = this.normalize(requested);
    let after: Uint8Array | undefined;
    for (;;) {
      const response = await this.#filesystem.list(this.#guest(relative), {
        ...(after === undefined ? {} : { after }),
        maximum: 1024
      });
      if (
        response.kind !== 'list' ||
        !record(response.page) ||
        !Array.isArray(response.page.entries)
      )
        throw new Error('Sandsurf returned an invalid directory page.');
      await this.#assertCurrent();
      for (const supplied of response.page.entries) {
        if (!record(supplied) || !Array.isArray(supplied.name) || !record(supplied.stat))
          throw new Error('Sandsurf returned an invalid directory entry.');
        const name = new TextDecoder('utf-8', { fatal: true }).decode(byteArray(supplied.name));
        if (
          name.length === 0 ||
          name.includes('/') ||
          name.includes('\0') ||
          name === '.' ||
          name === '..'
        )
          throw new Error('Sandsurf returned an invalid directory entry name.');
        const kind = supplied.stat.kind;
        yield {
          name,
          type:
            kind === 'regular'
              ? 'file'
              : kind === 'directory'
                ? 'directory'
                : kind === 'symlink'
                  ? 'symlink'
                  : 'other'
        };
      }
      if (response.page.next === null) break;
      if (!Array.isArray(response.page.next))
        throw new Error('Sandsurf directory cursor is invalid.');
      const next = byteArray(response.page.next);
      if (next.length === 0 || (after && Buffer.compare(next, after) <= 0))
        throw new Error('Sandsurf directory cursor did not advance.');
      after = next;
    }
  }

  async readRange(
    requested: string,
    range: { readonly offset: number; readonly length: number }
  ): Promise<{ readonly bytes: Uint8Array; readonly revision: WorkspaceFileRevision }> {
    const relative = this.normalize(requested);
    if (!Number.isSafeInteger(range.offset) || range.offset < 0
      || !Number.isSafeInteger(range.length) || range.length < 1)
      throw new TypeError('Workspace range requires a nonnegative offset and positive length.');
    const response = await this.#filesystem.read(this.#guest(relative), range.offset, range.length);
    if (response.kind !== 'read' || !record(response.range))
      throw new Error('Sandsurf returned an invalid file range.');
    const supplied = response.range;
    const revision = fileRevision(supplied.revision);
    const bytes = byteArray(supplied.bytes);
    if (supplied.offset !== range.offset || bytes.length > range.length
      || range.offset + bytes.length > revision.size
      || typeof supplied.eof !== 'boolean'
      || supplied.eof !== (range.offset + bytes.length === revision.size)
      || (!supplied.eof && bytes.length === 0))
      throw new Error('Sandsurf returned invalid file range coverage.');
    await this.#assertCurrent();
    return { bytes, revision };
  }

  async readFile(
    requested: string,
    options: { readonly maximumBytes?: number } = {}
  ): Promise<{ readonly bytes: Uint8Array; readonly revision: WorkspaceFileRevision }> {
    const maximum = options.maximumBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(maximum) || maximum < 0)
      throw new TypeError('Workspace read limit must be a nonnegative safe integer.');
    let offset = 0;
    let revision: WorkspaceFileRevision | undefined;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const range = await this.readRange(requested, {
        offset,
        length: Math.min(64 * 1024, Math.max(1, maximum - offset))
      });
      if (range.revision.size > maximum)
        throw new Error(`Workspace file exceeds its ${String(maximum)} byte read limit.`);
      if (revision && (revision.size !== range.revision.size || revision.digest !== range.revision.digest))
        throw new Error('Workspace file changed while reading.');
      revision = range.revision;
      chunks.push(range.bytes);
      offset += range.bytes.length;
      if (offset === revision.size) break;
    }
    const bytes = Buffer.concat(chunks);
    if (createHash('sha256').update(bytes).digest('hex') !== revision.digest)
      throw new Error('Workspace file bytes do not match their revision.');
    return { bytes, revision };
  }

  async transaction(mutations: readonly WorkspaceFileMutation[]): Promise<void> {
    this.#assertWritable();
    await this.#filesystem.transaction(
      mutations.map((mutation) =>
        mutation.kind === 'write'
          ? {
              kind: 'write' as const,
              path: this.#guest(this.normalize(mutation.path)),
              bytes: mutation.bytes,
              mode: mutation.mode,
              expected: mutation.expected
            }
          : {
              kind: 'remove' as const,
              path: this.#guest(this.normalize(mutation.path)),
              expected: mutation.expected
            }
      ),
      this.#preconditions()
    );
  }

  async mkdir(
    requested: string,
    options: { readonly recursive?: boolean; readonly mode?: number } = {}
  ): Promise<void> {
    this.#assertWritable();
    const relative = this.normalize(requested);
    await this.#filesystem.mkdir(this.#guest(relative), {
      recursive: options.recursive ?? false,
      ...this.#preconditions()
    });
    if (options.mode !== undefined)
      await this.#filesystem.chmod(this.#guest(relative), options.mode, this.#preconditions());
  }

  async remove(requested: string, options: { readonly recursive?: boolean } = {}): Promise<void> {
    this.#assertWritable();
    await this.#filesystem.remove(this.#guest(this.normalize(requested)), {
      recursive: options.recursive ?? false,
      ...this.#preconditions()
    });
  }

  close(): void {
    this.#closed = true;
  }

  #guest(relative: string): string {
    return relative === '.' ? '/workspace' : `/workspace/${relative}`;
  }

  async #revision(relative: string): Promise<WorkspaceFileRevision> {
    const response = await this.#filesystem.read(this.#guest(relative), 0, 1);
    if (response.kind !== 'read' || !record(response.range) || !record(response.range.revision))
      throw new Error('Sandsurf returned an invalid file revision.');
    return fileRevision(response.range.revision);
  }

  async #assertCurrent(): Promise<void> {
    this.#assertOpen();
    const view = await this.sandbox.inspect();
    if (
      view.configurationRevision !== this.configurationRevision ||
      view.machine.kind !== 'current' ||
      !record(view.machine.value) ||
      view.machine.value.epoch !== this.epoch
    )
      throw new Error('Workspace authority changed during the operation. Reopen the environment.');
  }

  #preconditions() {
    return { expectedEpoch: this.epoch, expectedRevision: this.configurationRevision };
  }

  #assertWritable(): void {
    this.#assertOpen();
    if (!this.writable) throw new Error('Workspace authority is read-only.');
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Sandsurf workspace file authority is closed.');
  }
}

function fileRevision(value: unknown): WorkspaceFileRevision {
  if (!record(value) || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.digest))
    throw new Error('Sandsurf returned an invalid file revision.');
  return { size: counter(value.size), digest: value.digest };
}

function byteArray(value: unknown): Uint8Array {
  if (
    !Array.isArray(value) ||
    !value.every(
      (byte: unknown) =>
        typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255
    )
  )
    throw new Error('Sandsurf returned invalid file bytes.');
  return Uint8Array.from(value as number[]);
}

function counter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Sandsurf returned an invalid counter.');
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hostCategory(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'category' in error
    ? String(error.category)
    : undefined;
}

import { createHash } from 'node:crypto';
import { rootedFileIdentitiesEqual, type RootedFileAuthority } from '@agent-core/tools-local';
import * as z from 'zod';

export const TESTED_STATE_LIMITS = Object.freeze({
  files: 256,
  fileBytes: 1024 * 1024,
  totalBytes: 4 * 1024 * 1024,
  operations: 1024
});
const fileSchema = z.discriminatedUnion('state', [
  z
    .strictObject({
      path: z.string(),
      state: z.literal('file'),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      bytes: z.number().int().nonnegative()
    })
    .readonly(),
  z.strictObject({ path: z.string(), state: z.literal('absent') }).readonly(),
  z
    .strictObject({ path: z.string(), state: z.literal('unavailable'), reason: z.string() })
    .readonly()
]);
export const testedStateSchema = z
  .strictObject({
    rootIdentity: z.string(),
    files: z.array(fileSchema).max(TESTED_STATE_LIMITS.files).readonly(),
    completeness: z.enum(['complete', 'partial', 'undeclared']),
    observedBytes: z.number().int().nonnegative().max(TESTED_STATE_LIMITS.totalBytes),
    operations: z.number().int().nonnegative().max(TESTED_STATE_LIMITS.operations),
    unobservedPaths: z.number().int().nonnegative()
  })
  .readonly();
export interface TestedStateCaptureBudget {
  remainingFiles: number;
  remainingBytes: number;
  remainingOperations: number;
}
export function testedStateCaptureBudget(): TestedStateCaptureBudget {
  return {
    remainingFiles: TESTED_STATE_LIMITS.files,
    remainingBytes: TESTED_STATE_LIMITS.totalBytes,
    remainingOperations: TESTED_STATE_LIMITS.operations
  };
}
export type TestedState = z.infer<typeof testedStateSchema>;
export interface CheckApplicability {
  readonly status: 'current' | 'stale' | 'unknown';
  readonly reasons: readonly string[];
}

/** A bounded list of explicit files, including dirty/untracked and absent paths. No tree or dependency discovery. */
export async function captureTestedState(
  root: RootedFileAuthority,
  paths: readonly string[] | undefined,
  budget: TestedStateCaptureBudget = testedStateCaptureBudget()
): Promise<TestedState> {
  const files: TestedState['files'][number][] = [];
  let observedBytes = 0;
  const maxFiles = Math.min(TESTED_STATE_LIMITS.files, budget.remainingFiles);
  const maxBytes = Math.min(TESTED_STATE_LIMITS.totalBytes, budget.remainingBytes);
  const maxOperations = Math.min(TESTED_STATE_LIMITS.operations, budget.remainingOperations);
  let operations = 0;
  let unobservedPaths = 0;
  let rootIdentity: string;
  try {
    if (maxOperations < 1) throw new Error('operation_limit');
    operations += 1;
    rootIdentity = hash(JSON.stringify(root.identity));
  } catch {
    rootIdentity = 'unavailable';
  }
  for (const requested of paths ?? []) {
    if (files.length >= maxFiles || operations + 4 > maxOperations) {
      unobservedPaths += 1;
      continue;
    }
    let file;
    try {
      operations += 1;
      const path = root.canonicalPath(requested);
      const status = await root.inspectPath(path);
      if (status.kind === 'absent') {
        files.push({ path, state: 'absent' });
        continue;
      }
      if (status.kind !== 'file') throw new Error('not_regular_file');
      const remaining = Math.min(TESTED_STATE_LIMITS.fileBytes, maxBytes - observedBytes);
      if (status.size > remaining) throw new Error('byte_limit');
      operations += 1;
      file = await root.openFile(path);
      if (file.size > remaining) throw new Error('byte_limit');
      const bytes = Buffer.alloc(file.size);
      let offset = 0;
      while (offset < bytes.length) {
        if (operations + 2 > maxOperations) throw new Error('operation_limit');
        operations += 1;
        const read = await file.read(bytes, offset, bytes.length - offset, offset);
        observedBytes += read;
        if (read === 0) throw new Error('changed_during_read');
        offset += read;
      }
      operations += 1;
      if (!rootedFileIdentitiesEqual(file.identity, await file.identityNow()))
        throw new Error('changed_during_read');
      files.push({
        path,
        state: 'file',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.byteLength
      });
    } catch (error) {
      files.push({
        path: requested,
        state: 'unavailable',
        reason: error instanceof Error ? error.message : String(error)
      });
    } finally {
      try {
        await file?.close();
      } catch {
        files[files.length - 1] = { path: requested, state: 'unavailable', reason: 'close_failed' };
      }
    }
  }
  budget.remainingFiles -= files.length;
  budget.remainingBytes -= observedBytes;
  budget.remainingOperations -= operations;
  return Object.freeze({
    rootIdentity,
    files: Object.freeze(files.map((file) => Object.freeze(file))),
    completeness: !paths?.length
      ? 'undeclared'
      : rootIdentity === 'unavailable' ||
          unobservedPaths > 0 ||
          files.some((file) => file.state === 'unavailable')
        ? 'partial'
        : 'complete',
    observedBytes,
    operations,
    unobservedPaths
  });
}

export function testedStateChanged(before: TestedState, after: TestedState): boolean {
  if (
    before.rootIdentity !== 'unavailable' &&
    after.rootIdentity !== 'unavailable' &&
    before.rootIdentity !== after.rootIdentity
  )
    return true;
  const current = new Map(after.files.map((file) => [file.path, file]));
  return before.files.some((file) => {
    const next = current.get(file.path);
    return (
      next &&
      file.state !== 'unavailable' &&
      next.state !== 'unavailable' &&
      (file.state !== next.state ||
        (file.state === 'file' && next.state === 'file' && file.sha256 !== next.sha256))
    );
  });
}

export function checkApplicability(
  before: TestedState,
  after: TestedState,
  current?: TestedState
): CheckApplicability {
  if (testedStateChanged(before, after))
    return Object.freeze({
      status: 'stale',
      reasons: Object.freeze(['tested_inputs_changed_during_execution'])
    });
  if (current && testedStateChanged(after, current))
    return Object.freeze({
      status: 'stale',
      reasons: Object.freeze(['observed_tested_inputs_changed'])
    });
  return Object.freeze({
    status: 'unknown',
    reasons: Object.freeze([
      ...(before.completeness !== 'complete' ||
      after.completeness !== 'complete' ||
      (current && current.completeness !== 'complete')
        ? ['tested_scope_not_fully_observed']
        : []),
      'opaque_command_dependencies',
      'external_mutation_not_excluded'
    ])
  });
}
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

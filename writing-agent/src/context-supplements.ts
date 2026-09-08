import { hashJson } from '@agent-core/persistence';
import type {
  HistoryReader,
  HistoryReadResult,
  HistorySourceRef,
  HistorySearchResult,
  NoteQueryResult,
  NoteReadResult,
  NoteReference,
  NoteRepository,
  NoteScope
} from '@agent-core/runtime';
import { contentId, textSha256 } from './canonical.js';
import {
  writingContextSelectionSchema,
  writingContextSupplementSchema,
  type WritingContextSelection,
  type WritingContextSupplement,
  type WritingOperation
} from './domain.js';
import type { WritingProject } from './project.js';

const MAX_SUPPLEMENT_BYTES = 64 * 1024;
const MAX_SELECTION_SUPPLEMENT_BYTES = 512 * 1024;

export async function admitWritingHistorySupplement(input: {
  readonly project: WritingProject;
  readonly operation: WritingOperation;
  readonly history: HistoryReader;
  readonly source: HistorySourceRef;
  readonly offset?: number;
  readonly maxBytes?: number;
}): Promise<WritingContextSelection> {
  const result = await input.history.read({
    source: input.source,
    ...(input.offset === undefined ? {} : { offset: input.offset }),
    maxBytes: boundedBytes(input.maxBytes)
  });
  if (result.status !== 'available')
    throw new Error(`Writing history supplement is unavailable: ${result.reason}.`);
  return recordWritingHistoryDelivery(input.project, input.operation, result);
}

export async function admitWritingNoteSupplement(input: {
  readonly project: WritingProject;
  readonly operation: WritingOperation;
  readonly repository: NoteRepository;
  readonly scope: NoteScope;
  readonly reference: NoteReference;
  readonly offset?: number;
  readonly maxBytes?: number;
}): Promise<WritingContextSelection> {
  if (hashJson(input.scope) !== hashJson(input.reference.scope))
    throw new Error('Writing note supplement is outside its admitted note scope.');
  const result = await input.repository.read({
    ...input.reference,
    ...(input.offset === undefined ? {} : { offset: input.offset }),
    maxBytes: boundedBytes(input.maxBytes)
  });
  if (result.status !== 'available')
    throw new Error(`Writing note supplement is unavailable: ${result.status}.`);
  return recordWritingNoteDelivery(input.project, input.operation, result);
}

/** Called only with a result supplied by the host-bound Core reader. */
export async function recordWritingHistoryDelivery(
  project: WritingProject,
  operation: WritingOperation,
  result: Extract<HistoryReadResult, { status: 'available' }>
): Promise<WritingContextSelection> {
  if (result.cut.sessionId !== operation.sessionId || result.item.source.sessionId !== operation.sessionId)
    throw new Error('Writing history delivery is outside its operation session.');
  return appendSupplement(project, operation, {
    origin: { kind: 'history', source: result.item.source, sourceCut: result.cut },
    content: result.item.text,
    range: {
      kind: 'byte',
      offset: result.offset,
      nextOffset: result.nextOffset,
      totalBytes: result.totalBytes
    },
    truncated: result.item.truncated
  });
}

/** A committed note revision remains generated data, including when its text claims authority. */
export async function recordWritingNoteDelivery(
  project: WritingProject,
  operation: WritingOperation,
  result: Extract<NoteReadResult, { status: 'available' }>
): Promise<WritingContextSelection> {
  if (result.revision.scope.sessionId !== operation.sessionId)
    throw new Error('Writing note delivery is outside its operation session.');
  const { scope, noteId, revisionId } = result.revision;
  return appendSupplement(project, operation, {
    origin: { kind: 'note', reference: { scope, noteId, revisionId } },
    content: result.text,
    range: {
      kind: 'byte',
      offset: result.offset,
      nextOffset: result.nextOffset,
      totalBytes: result.totalBytes
    },
    truncated: result.truncated
  });
}

export async function recordWritingHistorySearchDelivery(
  project: WritingProject,
  operation: WritingOperation,
  result: Pick<HistorySearchResult, 'items' | 'cut'>
): Promise<void> {
  if (result.cut.sessionId !== operation.sessionId)
    throw new Error('Writing history search is outside its operation session.');
  for (const item of result.items) {
    if (item.source.sessionId !== operation.sessionId)
      throw new Error('Writing history search source is outside its operation session.');
    await appendSupplement(project, operation, {
      origin: { kind: 'history', source: item.source, sourceCut: result.cut },
      content: item.text,
      range: { kind: 'search-excerpt' },
      truncated: item.truncated
    });
  }
}

/** Search/list return generated titles and revision metadata, not the note body. */
export async function recordWritingNoteIndexDelivery(
  project: WritingProject,
  operation: WritingOperation,
  result: NoteQueryResult
): Promise<void> {
  for (const revision of result.items) {
    if (revision.scope.sessionId !== operation.sessionId)
      throw new Error('Writing note index is outside its operation session.');
    const { scope, noteId, revisionId } = revision;
    await appendSupplement(project, operation, {
      origin: { kind: 'note', reference: { scope, noteId, revisionId } },
      content: JSON.stringify(revision),
      range: { kind: 'search-excerpt' },
      truncated: false
    });
  }
}

async function appendSupplement(
  project: WritingProject,
  operation: WritingOperation,
  delivery: Pick<WritingContextSupplement, 'origin' | 'content' | 'range' | 'truncated'>
): Promise<WritingContextSelection> {
  if (Buffer.byteLength(delivery.content) > MAX_SUPPLEMENT_BYTES)
    throw new Error('Writing supplement exceeds its delivered byte bound.');
  const material = {
    ...delivery,
    operationId: operation.operationId,
    baseProjectRevisionId: operation.baseProjectRevisionId,
    contentSha256: textSha256(delivery.content),
    trust: 'untrusted-data' as const
  };
  const supplement = writingContextSupplementSchema.parse({
    supplementId: contentId('supplement', material),
    ...material
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const previous = await project.store.getContextSelectionForOperation(operation.operationId);
    if (previous === undefined)
      throw new Error('Writing supplement requires an admitted base context selection.');
    if (previous.supplements.some((item) => item.supplementId === supplement.supplementId)) return previous;
    if (
      previous.supplements.length >= 128 ||
      previous.supplements.reduce(
        (bytes, item) => bytes + Buffer.byteLength(item.content),
        Buffer.byteLength(supplement.content)
      ) > MAX_SELECTION_SUPPLEMENT_BYTES
    )
      throw new Error('Writing selection supplement quota is exhausted.');
    const { contextSelectionId: parentSelectionId, ...base } = previous;
    const nextMaterial = { ...base, parentSelectionId, supplements: [...previous.supplements, supplement] };
    const selection = writingContextSelectionSchema.parse({
      contextSelectionId: contentId('context', nextMaterial),
      ...nextMaterial
    });
    try {
      await project.store.appendContextSelection(selection, operation.baseProjectRevisionId);
      return selection;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== 'Writing selection has a stale parent revision.' ||
        attempt === 3
      )
        throw error;
    }
  }
  throw new Error('Writing supplement could not commit after concurrent updates.');
}

function boundedBytes(value = MAX_SUPPLEMENT_BYTES): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SUPPLEMENT_BYTES)
    throw new Error('Writing supplement read bound must be between 1 and 65536 bytes.');
  return value;
}

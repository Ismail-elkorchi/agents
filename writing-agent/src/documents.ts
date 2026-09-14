import type { ArtifactRepository } from '@agent-core/persistence';
import type { PromptContextItemInput } from '@agent-core/runtime';
import {
  readRootedText,
  type EditTextRange,
  type RootedFileAuthority
} from '@agent-core/tools-local';
import { collectMarkdownNodes, headingText, parseMarkdown } from 'markspan';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as z from 'zod';

/** Bounds apply before original reads/parsing, independently of model request accounting. */
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_EXCERPT = 64 * 1024;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const offset = z.int().nonnegative();
export const documentSpanSchema = z.strictObject({ start: offset, end: offset });
export const documentRevisionSchema = z.strictObject({
  path: z.string().min(1),
  expectedSha256: sha256,
  artifactId: z.string().min(1).optional()
});
export const documentSectionSchema = z.strictObject({
  path: z.string().min(1),
  expectedSha256: sha256.optional(),
  heading: z.string().optional(),
  headingStart: offset.optional(),
  offset: offset.default(0),
  maxChars: z
    .int()
    .min(1)
    .max(MAX_EXCERPT)
    .default(16 * 1024),
  retain: z.boolean().default(false)
});
export const documentPassageSchema = z.strictObject({
  revision: documentRevisionSchema,
  selector: z.union([
    z.strictObject({ range: documentSpanSchema }),
    z.strictObject({
      quote: z.string().min(1).max(MAX_EXCERPT),
      occurrence: z.int().min(1).optional()
    })
  ])
});
export const documentComparisonSchema = z.strictObject({
  before: documentRevisionSchema,
  after: documentRevisionSchema,
  beforeOffset: offset.default(0),
  afterOffset: offset.default(0),
  maxChars: z
    .int()
    .min(1)
    .max(MAX_EXCERPT)
    .default(16 * 1024)
});
export type DocumentRevision = z.infer<typeof documentRevisionSchema>;
export type DocumentSpan = z.infer<typeof documentSpanSchema>;
export type DocumentPassageInput = z.input<typeof documentPassageSchema>;
export interface WritingDocument {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
  readonly revision: DocumentRevision;
}
export class DocumentConflict extends Error {
  constructor(
    readonly reason:
      | 'stale_revision'
      | 'missing_revision'
      | 'ambiguous_passage'
      | 'missing_passage'
      | 'ambiguous_heading'
      | 'missing_heading'
      | 'invalid_range'
      | 'read_limit',
    message: string
  ) {
    super(message);
    this.name = 'DocumentConflict';
  }
}
const retainedSchema = z.strictObject({
  path: z.string(),
  expectedSha256: sha256,
  content: z.string(),
  root: z.strictObject({ device: z.string(), inode: z.string(), mountId: z.string() })
});

/** Original revisions are explicitly retained in the existing artifact repository; no document registry. */
export class WritingDocuments {
  constructor(
    private readonly root: RootedFileAuthority,
    private readonly artifacts: ArtifactRepository
  ) {}

  async read(
    requestedPath: string,
    retain = false,
    signal?: AbortSignal
  ): Promise<WritingDocument> {
    const snapshot = await readRootedText(
      this.root,
      this.root.canonicalPath(requestedPath),
      MAX_DOCUMENT_BYTES,
      signal
    );
    let revision: DocumentRevision = { path: snapshot.path, expectedSha256: snapshot.sha256 };
    if (retain) revision = await this.retain({ ...snapshot, revision });
    return { ...snapshot, revision };
  }

  async resolve(revision: DocumentRevision, signal?: AbortSignal): Promise<WritingDocument> {
    const canonical = this.root.canonicalPath(revision.path);
    signal?.throwIfAborted();
    if (revision.artifactId === undefined) {
      let snapshot: WritingDocument;
      try {
        snapshot = await this.read(canonical, false, signal);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
          throw new DocumentConflict(
            'missing_revision',
            `Document revision is unavailable: ${canonical}; no retained artifact was supplied.`
          );
        throw error;
      }
      if (snapshot.sha256 !== revision.expectedSha256)
        throw new DocumentConflict(
          'stale_revision',
          `Document changed: ${canonical}; expected ${revision.expectedSha256}, current ${snapshot.sha256}.`
        );
      return snapshot;
    }
    const ref = await this.artifacts.resolve(revision.artifactId);
    if (!ref)
      throw new DocumentConflict(
        'missing_revision',
        'The requested original revision is not retained. A digest cannot reconstruct its text.'
      );
    if (ref.size === 0)
      throw new DocumentConflict('missing_revision', 'The retained revision is empty.');
    if (ref.size > MAX_DOCUMENT_BYTES * 6 + 4096)
      throw new DocumentConflict(
        'read_limit',
        'Retained revision exceeds the document read bound.'
      );
    const bytes = await this.artifacts.readVerifiedRange(ref, { offset: 0, length: ref.size });
    const stored = retainedSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.bytes))
    );
    signal?.throwIfAborted();
    if (Buffer.byteLength(stored.content) > MAX_DOCUMENT_BYTES)
      throw new DocumentConflict('read_limit', 'Retained source exceeds the document read bound.');
    const { device, inode, mountId } = this.root.identity;
    if (
      stored.path !== canonical ||
      stored.expectedSha256 !== revision.expectedSha256 ||
      stored.root.device !== device ||
      stored.root.inode !== inode ||
      stored.root.mountId !== mountId ||
      hash(stored.content) !== revision.expectedSha256
    )
      throw new DocumentConflict(
        'missing_revision',
        'Retained source does not match this workspace, path, and revision.'
      );
    return {
      path: canonical,
      content: stored.content,
      sha256: stored.expectedSha256,
      revision: { ...revision, path: canonical }
    };
  }

  async section(input: z.infer<typeof documentSectionSchema>, signal?: AbortSignal) {
    let doc = await this.read(input.path, false, signal);
    if (input.expectedSha256 !== undefined && input.expectedSha256 !== doc.sha256)
      throw new DocumentConflict(
        'stale_revision',
        `Document changed: ${doc.path}; current ${doc.sha256}.`
      );
    const headings = /\.(md|markdown|mdown)$/iu.test(doc.path)
      ? collectMarkdownNodes(
          parseMarkdown(doc.content, {
            budgets: {
              maxInputCodeUnits: MAX_DOCUMENT_BYTES,
              maxNodes: 100_000,
              maxLines: 100_000,
              maxDepth: 128
            }
          }).tree,
          'heading'
        ).map((node) => ({ title: headingText(node), depth: node.depth, range: node.span }))
      : [];
    const selected = headings.filter(
      (heading) =>
        (input.heading === undefined || heading.title === input.heading) &&
        (input.headingStart === undefined || heading.range.start === input.headingStart)
    );
    const hasSelector = input.heading !== undefined || input.headingStart !== undefined;
    if (hasSelector && selected.length !== 1)
      throw new DocumentConflict(
        selected.length ? 'ambiguous_heading' : 'missing_heading',
        selected.length
          ? 'Heading is ambiguous; select its headingStart from a section read.'
          : 'Heading was not found at this revision.'
      );
    const heading = hasSelector ? selected[0] : undefined;
    const sectionStart = heading?.range.start ?? 0;
    const sectionEnd =
      heading === undefined
        ? doc.content.length
        : (headings.find((item) => item.range.start > sectionStart && item.depth <= heading.depth)
            ?.range.start ?? doc.content.length);
    if (input.offset > sectionEnd - sectionStart)
      throw new DocumentConflict('invalid_range', 'Section offset exceeds this section.');
    if (input.retain) {
      // Retain the exact bytes already read, avoiding a second, potentially different snapshot.
      doc = { ...doc, revision: await this.retain(doc) };
    }
    const start = sectionStart + input.offset;
    const end = boundedEnd(doc.content, start, Math.min(sectionEnd, start + input.maxChars));
    const surrounding = headings.filter(
      (item) => item.range.start >= start && item.range.start < end
    );
    const ancestors: typeof headings = [];
    for (const item of headings) {
      if (item.range.start >= start) break;
      while ((ancestors[ancestors.length - 1]?.depth ?? 0) >= item.depth) ancestors.pop();
      ancestors.push(item);
    }
    const structure = [...ancestors, ...surrounding].slice(0, 100);
    return {
      ...excerpt(doc, { start, end }),
      sectionRange: { start: sectionStart, end: sectionEnd },
      structure,
      structureTruncated: ancestors.length + surrounding.length > structure.length,
      ...(end < sectionEnd ? { nextOffset: end - sectionStart } : {})
    };
  }

  private async retain(doc: WritingDocument): Promise<DocumentRevision> {
    const { device, inode, mountId } = this.root.identity;
    const artifact = await this.artifacts.store({
      label: `Document revision: ${doc.path}`,
      mediaType: 'application/json',
      content: Buffer.from(
        JSON.stringify({
          path: doc.path,
          expectedSha256: doc.sha256,
          content: doc.content,
          root: { device, inode, mountId }
        })
      )
    });
    return { path: doc.path, expectedSha256: doc.sha256, artifactId: artifact.artifactId };
  }

  async passage(input: z.infer<typeof documentPassageSchema>, signal?: AbortSignal) {
    const doc = await this.resolve(input.revision, signal);
    let range: DocumentSpan;
    if ('range' in input.selector) range = input.selector.range;
    else {
      const { quote, occurrence } = input.selector;
      let found = -1;
      let count = 0;
      let chosen = -1;
      while ((found = doc.content.indexOf(quote, found + 1)) !== -1) {
        count++;
        if (occurrence === count || (occurrence === undefined && count === 1)) chosen = found;
        if (occurrence === undefined && count === 2)
          throw new DocumentConflict(
            'ambiguous_passage',
            'Passage occurs more than once; select an exact range or occurrence.'
          );
        if (occurrence === count) break;
      }
      if (chosen < 0)
        throw new DocumentConflict('missing_passage', 'Passage was not found at this revision.');
      range = { start: chosen, end: chosen + quote.length };
    }
    if (range.end - range.start > MAX_EXCERPT)
      throw new DocumentConflict('read_limit', 'Passage exceeds 65536 UTF-16 code units.');
    return excerpt(doc, range);
  }

  async compare(input: z.infer<typeof documentComparisonSchema>, signal?: AbortSignal) {
    const before = await this.resolve(input.before, signal);
    const after = await this.resolve(input.after, signal);
    let start = 0;
    while (
      start < before.content.length &&
      start < after.content.length &&
      before.content[start] === after.content[start]
    )
      start++;
    while (start > 0 && (!boundary(before.content, start) || !boundary(after.content, start)))
      start--;
    let left = before.content.length;
    let right = after.content.length;
    while (left > start && right > start && before.content[left - 1] === after.content[right - 1]) {
      left--;
      right--;
    }
    while (!boundary(before.content, left) || !boundary(after.content, right)) {
      left++;
      right++;
    }
    const page = (doc: WritingDocument, end: number, offset: number) => {
      if (offset > end - start)
        throw new DocumentConflict('invalid_range', 'Comparison offset exceeds the changed range.');
      const from = start + offset;
      const to = boundedEnd(doc.content, from, Math.min(end, from + input.maxChars));
      return {
        ...excerpt(doc, { start: from, end: to }),
        changedRange: { start, end },
        ...(to < end ? { nextOffset: to - start } : {})
      };
    };
    return {
      equal: before.sha256 === after.sha256,
      before: page(before, left, input.beforeOffset),
      after: page(after, right, input.afterOffset),
      comparison:
        'Exact common prefix/suffix comparison; each changed range includes all intervening changes.'
    };
  }

  async passageContext(
    input: z.infer<typeof documentPassageSchema>
  ): Promise<PromptContextItemInput> {
    const passage = await this.passage(input);
    const uri = pathToFileURL(path.join(this.root.identity.canonicalPath, passage.path));
    uri.hash = new URLSearchParams({
      sha256: passage.expectedSha256,
      start: String(passage.sourceRange.start),
      end: String(passage.sourceRange.end),
      ...(passage.revision.artifactId === undefined
        ? {}
        : { revision: passage.revision.artifactId })
    }).toString();
    return {
      id: `passage:${passage.expectedSha256}:${String(passage.sourceRange.start)}:${String(passage.sourceRange.end)}`,
      title: `${passage.path} (${passage.sourceState} revision ${passage.expectedSha256.slice(0, 12)})`,
      sourceUri: uri.href,
      sourceKind: 'user',
      integrity: 'verified',
      representation: 'excerpt',
      mediaType: 'text/plain',
      content: passage.originalText,
      range: { kind: 'byte', start: passage.byteRange.start, end: passage.byteRange.end },
      purpose:
        'User-selected original passage at the identified revision and half-open UTF-8 byte range. This quotation does not assert the current file is unchanged.'
    };
  }
}

function hash(text: string) {
  return createHash('sha256').update(text).digest('hex');
}
function boundary(text: string, offset: number): boolean {
  return !(
    offset > 0 &&
    offset < text.length &&
    ((/[\uD800-\uDBFF]/u.test(text.charAt(offset - 1)) &&
      /[\uDC00-\uDFFF]/u.test(text.charAt(offset))) ||
      (text[offset - 1] === '\r' && text[offset] === '\n'))
  );
}
function boundedEnd(text: string, start: number, end: number): number {
  if (end === start) return end;
  while (end > start && !boundary(text, end)) end--;
  if (end === start && end < text.length)
    throw new DocumentConflict(
      'read_limit',
      'Requested page cannot contain the next scalar or CRLF pair; increase maxChars.'
    );
  return end;
}
function excerpt(doc: WritingDocument, span: DocumentSpan) {
  if (
    span.start > span.end ||
    span.end > doc.content.length ||
    !boundary(doc.content, span.start) ||
    !boundary(doc.content, span.end)
  )
    throw new DocumentConflict(
      'invalid_range',
      'Range must be within the document on Unicode scalar and CRLF boundaries.'
    );
  const position = (offset: number) => {
    // edit_text counts LF-delimited lines (including CRLF) and Unicode-scalar
    // columns. CommonMark also treats a bare CR as a line ending, so its line
    // index cannot supply edit_text positions for that otherwise valid text.
    let line = 1;
    let start = 0;
    for (
      let next = doc.content.indexOf('\n');
      next >= 0 && next < offset;
      next = doc.content.indexOf('\n', start)
    ) {
      line++;
      start = next + 1;
    }
    return { line, column: Array.from(doc.content.slice(start, offset)).length + 1 };
  };
  const range: EditTextRange = { start: position(span.start), end: position(span.end) };
  return {
    path: doc.path,
    revision: doc.revision,
    expectedSha256: doc.sha256,
    sourceState:
      doc.revision.artifactId === undefined ? ('current_at_read' as const) : ('retained' as const),
    sourceRange: span,
    offsetUnit: 'utf16' as const,
    byteRange: {
      start: Buffer.byteLength(doc.content.slice(0, span.start)),
      end: Buffer.byteLength(doc.content.slice(0, span.end))
    },
    range,
    originalText: doc.content.slice(span.start, span.end),
    expectedText: doc.content.slice(span.start, span.end)
  };
}

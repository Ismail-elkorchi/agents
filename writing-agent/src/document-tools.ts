import type { ArtifactRepository } from '@agent-core/persistence';
import {
  artifactScope,
  defaultToolModelContent,
  defineTool,
  type ToolResultFact
} from '@agent-core/tools';
import { fileScope, type RootedFileAuthority } from '@agent-core/tools-local';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as z from 'zod';
import {
  DocumentConflict,
  WritingDocuments,
  documentComparisonSchema,
  documentPassageSchema,
  documentRevisionSchema,
  documentSectionSchema,
  documentSpanSchema
} from './documents.js';

const positionSchema = z.strictObject({ line: z.int().positive(), column: z.int().positive() });
const excerptSchema = z.strictObject({
  path: z.string(),
  revision: documentRevisionSchema,
  expectedSha256: documentRevisionSchema.shape.expectedSha256,
  sourceState: z.enum(['current_at_read', 'retained']),
  sourceRange: documentSpanSchema,
  offsetUnit: z.literal('utf16'),
  byteRange: documentSpanSchema,
  range: z.strictObject({ start: positionSchema, end: positionSchema }),
  originalText: z.string()
});
const sectionResultSchema = excerptSchema.extend({
  status: z.literal('success'),
  sectionRange: documentSpanSchema,
  structure: z.array(z.strictObject({
    title: z.string(), depth: z.int().positive(), range: documentSpanSchema
  })),
  structureTruncated: z.boolean(),
  nextOffset: z.int().nonnegative().optional()
});
const comparisonPageSchema = excerptSchema.extend({
  changedRange: documentSpanSchema,
  nextOffset: z.int().nonnegative().optional()
});
const conflictSchema = z.strictObject({
  status: z.literal('conflict'),
  reason: z.enum([
    'stale_revision', 'missing_revision', 'ambiguous_passage', 'missing_passage',
    'ambiguous_heading', 'missing_heading', 'invalid_range', 'read_limit'
  ]),
  message: z.string()
});
const sectionOutputSchema = z.discriminatedUnion('status', [sectionResultSchema, conflictSchema]);
const passageOutputSchema = z.discriminatedUnion('status', [
  excerptSchema.extend({ status: z.literal('success') }), conflictSchema
]);
const comparisonOutputSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('success'),
    equal: z.boolean(),
    before: comparisonPageSchema,
    after: comparisonPageSchema,
    comparison: z.string()
  }),
  conflictSchema
]);
type DocumentSourceResult = Awaited<ReturnType<WritingDocuments['section']>> |
  Awaited<ReturnType<WritingDocuments['passage']>> |
  Awaited<ReturnType<WritingDocuments['compare']>>;
type DocumentToolOutput = z.output<typeof sectionOutputSchema> |
  z.output<typeof passageOutputSchema> | z.output<typeof comparisonOutputSchema>;
type DocumentExcerpt = z.output<typeof excerptSchema>;

export function createWritingDocumentTools(
  root: RootedFileAuthority,
  artifacts: ArtifactRepository
) {
  const documents = new WritingDocuments(root, artifacts);
  function tool<Schema extends z.ZodType>(
    name: string,
    description: string,
    schema: Schema,
    outputSchema: z.ZodType<DocumentToolOutput>,
    canonicalize: (input: z.output<Schema>) => z.output<Schema>,
    resources: (input: z.output<Schema>) => string[],
    run: (input: z.output<Schema>, signal?: AbortSignal) => Promise<DocumentSourceResult>
  ) {
    return defineTool({
      name,
      implementationId: `writing-agent.${name}.v2`,
      description,
      schema,
      outputSchema,
      invocationModes: ['direct', 'programmatic'],
      buildModelContent: ({ observation }) =>
        observation.kind === 'failure'
          ? defaultToolModelContent(observation)
          : [{ type: 'text', text: documentContent(observation.output) }],
      effectEnvelope: {
        accesses: [
          { mode: 'read', scope: 'files' },
          { mode: 'read', scope: 'artifacts' }
        ],
        lockScopes: []
      },
      canonicalizeInput: canonicalize,
      deriveEffects: (input) => ({
        accesses: resources(input).map((scope) => ({ mode: 'read' as const, scope })),
        lockScopes: [],
        recovery: { kind: 'unknown' as const }
      }),
      async invoke(input, context) {
        let output: DocumentToolOutput;
        try {
          output = { status: 'success', ...await run(input, context.signal) };
        } catch (error) {
          if (!(error instanceof DocumentConflict)) throw error;
          output = { status: 'conflict', reason: error.reason, message: error.message };
        }
        if (output.status === 'conflict') {
          const summary = `${name}: ${output.reason}; no original source result returned.`;
          return {
            kind: 'result',
            summary,
            scope: {
              resources: resources(input), coverage: 'partial', causes: ['document_conflict']
            },
            observedFacts: { items: [{
              action: 'read', outcome: 'failure',
              scope: { coverage: 'absent', actuality: 'observed', filters: { reason: output.reason } },
              summary
            }] },
            output
          };
        }
        const partial = hasMore(output);
        const excerpts = 'before' in output ? [output.before, output.after] : [output];
        return {
          kind: 'result',
          summary: `${name}: ${partial ? 'partial' : 'complete'} original source result.`,
          scope: {
            resources: resources(input), coverage: partial ? 'partial' : 'complete',
            ...(partial ? { causes: ['bounded_source_result'] } : {})
          },
          observedFacts: { items: excerpts.map(excerpt => sourceFact(root, excerpt)) },
          output
        };
      }
    });
  }
  const revision = (value: z.infer<typeof documentPassageSchema>['revision']) => ({
    ...value,
    path: root.canonicalPath(value.path)
  });
  const sourceScopes = (value: z.infer<typeof documentPassageSchema>['revision']) =>
    value.artifactId === undefined
      ? [fileScope(value.path)]
      : [fileScope(value.path), artifactScope(value.artifactId)];
  return [
    tool(
      'read_document_section',
      'Read a bounded original document section and Markdown headings. Duplicate headings require headingStart. UTF-16 offsets page within the selected section. retain stores these exact original bytes for later comparison.',
      documentSectionSchema,
      sectionOutputSchema,
      (input) => ({ ...input, path: root.canonicalPath(input.path) }),
      (input) => [fileScope(input.path)],
      (input, signal) => documents.section(input, signal)
    ),
    tool(
      'read_document_passage',
      'Resolve an exact range or quotation at expectedSha256. Duplicate quotations require occurrence or a range. Returns original text and Unicode-scalar line/column ranges for edit_text. Retained artifact revisions are historical originals.',
      documentPassageSchema,
      passageOutputSchema,
      (input) => ({ ...input, revision: revision(input.revision) }),
      (input) => sourceScopes(input.revision),
      (input, signal) => documents.passage(input, signal)
    ),
    tool(
      'compare_document_revisions',
      'Compare two explicitly available document revisions. Historical text requires its retained artifactId; a digest alone is unavailable. Returns exact changed ranges and bounded original excerpts, with offsets for further pages.',
      documentComparisonSchema,
      comparisonOutputSchema,
      (input) => ({ ...input, before: revision(input.before), after: revision(input.after) }),
      (input) => [...new Set([...sourceScopes(input.before), ...sourceScopes(input.after)])],
      (input, signal) => documents.compare(input, signal)
    )
  ];
}

function sourceFact(root: RootedFileAuthority, excerpt: DocumentExcerpt): ToolResultFact {
  const uri = pathToFileURL(path.join(root.identity.canonicalPath, excerpt.path));
  // The range addresses original document bytes at this revision, never bytes of
  // the JSON retention container or an assertion about the current filesystem.
  uri.searchParams.set('sha256', excerpt.expectedSha256);
  const partial = hasMore(excerpt);
  return {
    action: 'read', outcome: 'success',
    resources: [{
      uri: uri.href,
      range: { kind: 'byte', ...excerpt.byteRange },
      sha256: createHash('sha256').update(excerpt.originalText).digest('hex'),
      fullSha256: excerpt.expectedSha256,
      mediaType: 'text/plain'
    }],
    scope: {
      actuality: 'observed', coverage: partial ? 'partial' : 'complete',
      filters: {
        sourceState: excerpt.sourceState,
        ...(excerpt.revision.artifactId ? { artifactId: excerpt.revision.artifactId } : {})
      }
    },
    summary: `Read ${excerpt.sourceState === 'retained' ? 'retained' : 'current-at-read'} original document bytes ${String(excerpt.byteRange.start)}-${String(excerpt.byteRange.end)}.`
  };
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function hasMore(value: unknown): boolean {
  return (
    isObject(value) &&
    ('nextOffset' in value ||
      value.structureTruncated === true ||
      hasMore(value.before) ||
      hasMore(value.after))
  );
}
function documentContent(value: unknown): string {
  if (!isObject(value)) return JSON.stringify(value);
  if ('before' in value && 'after' in value)
    return `${String(value.comparison)}\nEqual: ${String(value.equal)}\nBefore:\n${documentContent(value.before)}\nAfter:\n${documentContent(value.after)}`;
  const { originalText, ...details } = value;
  return typeof originalText === 'string'
    ? `${JSON.stringify(details)}\n\n${originalText}`
    : JSON.stringify(value);
}

import type { ArtifactRepository } from '@agent-core/persistence';
import { artifactScope, defaultToolModelContent, defineTool } from '@agent-core/tools';
import { fileScope, type RootedFileAuthority } from '@agent-core/tools-local';
import * as z from 'zod';
import {
  DocumentConflict,
  WritingDocuments,
  documentComparisonSchema,
  documentPassageSchema,
  documentSectionSchema
} from './documents.js';

export function createWritingDocumentTools(
  root: RootedFileAuthority,
  artifacts: ArtifactRepository
) {
  const documents = new WritingDocuments(root, artifacts);
  function tool<Schema extends z.ZodType>(
    name: string,
    description: string,
    schema: Schema,
    canonicalize: (input: z.output<Schema>) => z.output<Schema>,
    resources: (input: z.output<Schema>) => string[],
    run: (input: z.output<Schema>, signal?: AbortSignal) => Promise<unknown>
  ) {
    return defineTool({
      name,
      implementationId: `writing-agent.${name}.v1`,
      description,
      schema,
      outputSchema: z.unknown(),
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
        let output: unknown;
        try {
          output = await run(input, context.signal);
        } catch (error) {
          if (!(error instanceof DocumentConflict)) throw error;
          output = { conflict: error.reason, message: error.message };
        }
        const partial = hasMore(output);
        return {
          kind: 'result',
          summary: `${name}: ${isObject(output) && typeof output.conflict === 'string' ? output.conflict : 'original source result'}`,
          scope: { resources: resources(input), coverage: partial ? 'partial' : 'complete' },
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
      (input) => ({ ...input, path: root.canonicalPath(input.path) }),
      (input) => [fileScope(input.path)],
      (input, signal) => documents.section(input, signal)
    ),
    tool(
      'read_document_passage',
      'Resolve an exact range or quotation at expectedSha256. Duplicate quotations require occurrence or a range. Returns original text and Unicode-scalar line/column ranges for edit_text. Retained artifact revisions are historical originals.',
      documentPassageSchema,
      (input) => ({ ...input, revision: revision(input.revision) }),
      (input) => sourceScopes(input.revision),
      (input, signal) => documents.passage(input, signal)
    ),
    tool(
      'compare_document_revisions',
      'Compare two explicitly available document revisions. Historical text requires its retained artifactId; a digest alone is unavailable. Returns exact changed ranges and bounded original excerpts, with offsets for further pages.',
      documentComparisonSchema,
      (input) => ({ ...input, before: revision(input.before), after: revision(input.after) }),
      (input) => [...new Set([...sourceScopes(input.before), ...sourceScopes(input.after)])],
      (input, signal) => documents.compare(input, signal)
    )
  ];
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
  delete details.expectedText;
  return typeof originalText === 'string'
    ? `${JSON.stringify(details)}\n\n${originalText}`
    : JSON.stringify(value);
}

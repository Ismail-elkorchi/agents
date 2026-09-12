import { defineTool, ToolInputError } from '@agent-core/tools';
import { fileScope, rootedFileIdentitiesEqual, type RootedFileAuthority } from '@agent-core/tools-local';
import { MARKDOWN_WORD_CONVENTION, measureMarkdownWords } from '@agents/verification';
import * as z from 'zod';

const MAX_DOCUMENT_BYTES = 4_000_000;

export function createMarkdownWordCountTool(root: RootedFileAuthority) {
  return defineTool({
    name: 'count_markdown_words',
    implementationId: 'coding-agent.markdown-word-count@1',
    description: 'Count words in a saved Markdown file and return the measured content digest.',
    promptGuide: [
      'Use count_markdown_words to verify Markdown length requirements against the saved file.',
      'The count includes headings, prose, code, and image alternative text; it excludes Markdown syntax, link destinations, HTML markup, definitions, and front matter.',
      'Measurements describe one file revision. Measure again after edits; a previous count does not verify the new revision.'
    ].join('\n'),
    schema: z.strictObject({ path: z.string().min(1) }),
    outputSchema: z.strictObject({
      path: z.string(),
      convention: z.literal(MARKDOWN_WORD_CONVENTION),
      inputSha256: z.string(),
      words: z.number().int().nonnegative()
    }),
    effectEnvelope: { accesses: [{ mode: 'read', scope: fileScope() }], lockScopes: [] },
    canonicalizeInput: ({ path }) => ({ path: root.canonicalPath(path) }),
    deriveEffects: ({ path }) => ({
      accesses: [{ mode: 'read', scope: fileScope(path) }],
      lockScopes: [],
      recovery: { kind: 'unknown' }
    }),
    async invoke({ path }, context) {
      const file = await root.openFile(path);
      try {
        if (file.size > MAX_DOCUMENT_BYTES)
          throw new ToolInputError(`Markdown word counting accepts files up to ${String(MAX_DOCUMENT_BYTES)} bytes: ${path}`);
        const bytes = Buffer.alloc(file.size);
        let offset = 0;
        while (offset < bytes.length) {
          context.signal?.throwIfAborted();
          const read = await file.read(bytes, offset, bytes.length - offset, offset);
          if (read === 0) throw new ToolInputError(`File changed while it was being measured: ${path}`);
          offset += read;
        }
        if (
          !rootedFileIdentitiesEqual(file.identity, await file.identityNow()) ||
          !rootedFileIdentitiesEqual(file.identity, await root.fileIdentity(path))
        )
          throw new ToolInputError(`File changed while it was being measured: ${path}`);
        const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        const measurement = measureMarkdownWords(source);
        return {
          kind: 'result',
          ok: true,
          summary: `${path}: ${String(measurement.words)} words.`,
          scope: { resources: [fileScope(path)], coverage: 'complete' },
          output: { path, ...measurement }
        };
      } finally {
        await file.close();
      }
    }
  });
}

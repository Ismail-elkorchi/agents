import { createHash } from 'node:crypto';
import { countMarkdownDocumentWords, parseMarkdown } from 'markspan';

export const MARKDOWN_WORD_CONVENTION = 'markspan.gfm.text-code-image-alt@1';

export interface MarkdownWordMeasurement {
  readonly convention: typeof MARKDOWN_WORD_CONVENTION;
  readonly inputSha256: string;
  readonly words: number;
}

/**
 * Counts Unicode letter/number words in GFM headings, prose, code, and image alternative text.
 * Link labels and prose between inline HTML tags count. Link destinations, HTML markup,
 * definitions, and front matter do not count.
 */
export function measureMarkdownWords(source: string): MarkdownWordMeasurement {
  const document = parseMarkdown(source, {
    dialect: 'gfm',
    extensions: ['frontMatter'],
    sourceRetention: 'none'
  });
  return Object.freeze({
    convention: MARKDOWN_WORD_CONVENTION,
    inputSha256: createHash('sha256').update(source).digest('hex'),
    words: countMarkdownDocumentWords(document.tree, {
      code: 'include',
      image: 'alt',
      html: 'omit',
      linkDestination: 'omit',
      definitions: 'omit'
    })
  });
}

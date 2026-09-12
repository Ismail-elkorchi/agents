import assert from 'node:assert/strict';
import test from 'node:test';
import { MARKDOWN_WORD_CONVENTION, measureMarkdownWords } from '@agents/verification';

test('Markdown word measurement binds one documented GFM convention to the source digest', () => {
  const source = [
    '---',
    'title: ignored front matter',
    '---',
    '# Two words',
    '',
    'Prose with [linked text](https://ignored.example) and ![image words](image.png).',
    '',
    '```ts',
    'const café = 1',
    '```',
    '',
    '<span>ignored html</span>',
    '',
    '[reference]: https://ignored.example "ignored title"'
  ].join('\n');
  const measured = measureMarkdownWords(source);
  assert.equal(measured.convention, MARKDOWN_WORD_CONVENTION);
  assert.equal(measured.words, 14);
  assert.match(measured.inputSha256, /^[a-f0-9]{64}$/u);
  assert.equal(measureMarkdownWords(source).inputSha256, measured.inputSha256);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, submit, toolCall } from './helpers/runtime.js';

const integration = { skip: process.platform !== 'linux', timeout: 30_000 };
test(
  'bounded Markdown sections expose exact heading and edit ranges, with explicit duplicate conflicts',
  integration,
  async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    const source = '# Intro\r\nCafé 😀 العربية.\r\n## Repeat\r\nFirst.\r\n## Repeat\r\nSecond.\r\n';
    await writeFile(path.join(f.root, 'article.md'), source);
    const first = await f.application.readDocumentSection({ path: 'article.md', maxChars: 9 });
    assert.equal(first.originalText, '# Intro\r\n');
    assert.equal(first.nextOffset, 9);
    assert.deepEqual(first.range, { start: { line: 1, column: 1 }, end: { line: 2, column: 1 } });
    const full = await f.application.readDocumentSection({ path: 'article.md' });
    assert.deepEqual(
      full.structure.map((x) => x.title),
      ['Intro', 'Repeat', 'Repeat']
    );
    await assert.rejects(
      f.application.readDocumentSection({ path: 'article.md', heading: 'Repeat' }),
      { reason: 'ambiguous_heading' }
    );
    const second = await f.application.readDocumentSection({
      path: 'article.md',
      headingStart: full.structure[2].range.start
    });
    assert.equal(second.originalText, '## Repeat\r\nSecond.\r\n');
    assert.equal(second.structure[0].title, 'Intro');
    const passage = await f.application.readDocumentPassage({
      revision: full.revision,
      selector: { quote: '😀 العربية' }
    });
    assert.deepEqual(passage.range, {
      start: { line: 2, column: 6 },
      end: { line: 2, column: 15 }
    });
    assert.equal(passage.originalText, '😀 العربية');
    assert.equal(
      source.slice(passage.sourceRange.start, passage.sourceRange.end),
      passage.expectedText
    );
    assert.equal(
      Buffer.from(source).subarray(passage.byteRange.start, passage.byteRange.end).toString(),
      passage.originalText
    );
    await assert.rejects(
      f.application.readDocumentPassage({ revision: full.revision, selector: { quote: 'Repeat' } }),
      { reason: 'ambiguous_passage' }
    );
    assert.equal(
      (
        await f.application.readDocumentPassage({
          revision: full.revision,
          selector: { quote: 'Repeat', occurrence: 2 }
        })
      ).range.start.line,
      5
    );
    await assert.rejects(
      f.application.readDocumentPassage({
        revision: full.revision,
        selector: { range: { start: passage.sourceRange.start + 1, end: passage.sourceRange.end } }
      }),
      { reason: 'invalid_range' }
    );
  }
);

test(
  'retained revisions compare original bytes after external edits and bind historical passage input',
  integration,
  async (t) => {
    const f = await fixture('Opening.\r\nQuotation 😀.\r\n');
    t.after(() => f.close());
    const before = await f.application.readDocument('document.txt');
    const current = await f.application.readDocumentSection({ path: 'document.txt' });
    await writeFile(path.join(f.root, 'document.txt'), 'Opening.\r\nUser change.\r\n');
    await assert.rejects(
      f.application.readDocumentPassage({
        revision: current.revision,
        selector: { quote: 'Quotation' }
      }),
      { reason: 'stale_revision' }
    );
    const after = await f.application.readDocumentSection({ path: 'document.txt' });
    const comparison = await f.application.compareDocumentRevisions({
      before: before.revision,
      after: after.revision,
      maxChars: 4
    });
    assert.equal(comparison.equal, false);
    assert.equal(comparison.before.originalText, 'Quot');
    assert.equal(comparison.before.nextOffset, 4);
    assert.equal(comparison.after.originalText, 'User');
    const context = await f.application.readPassageContext({
      revision: before.revision,
      selector: { quote: 'Quotation 😀.' }
    });
    assert.equal(context.content, 'Quotation 😀.');
    assert.match(context.title, /retained revision/);
    assert.equal(
      new URLSearchParams(new URL(context.sourceUri).hash.slice(1)).get('sha256'),
      before.sha256
    );
    assert.equal(context.range.kind, 'byte');
    assert.equal(
      Buffer.from(before.content).subarray(context.range.start, context.range.end).toString(),
      context.content
    );
    await assert.rejects(
      f.application.compareDocumentRevisions({
        before: { ...before.revision, artifactId: '0'.repeat(64) + '.json' },
        after: after.revision
      }),
      { reason: 'missing_revision' }
    );
    await assert.rejects(
      f.application.readDocumentPassage({
        revision: { ...before.revision, path: 'another.txt' },
        selector: { quote: 'Quotation' }
      }),
      { reason: 'missing_revision' }
    );
    await assert.rejects(
      f.application.readDocumentPassage({
        revision: { ...before.revision, path: '.git/config' },
        selector: { quote: 'Quotation' }
      }),
      /reserved/
    );
    await rm(path.join(f.root, 'document.txt'));
    assert.equal(
      (
        await f.application.readPassageContext({
          revision: before.revision,
          selector: { quote: 'Quotation' }
        })
      ).content,
      'Quotation'
    );
  }
);

test(
  'plain text remains exact, comparison handles insertions and equal revisions, and original reads are bounded',
  integration,
  async (t) => {
    const f = await fixture('a😀z\r\n');
    t.after(() => f.close());
    const before = await f.application.readDocument('document.txt');
    assert.deepEqual(
      (await f.application.readDocumentSection({ path: 'document.txt' })).structure,
      []
    );
    assert.equal(
      (
        await f.application.compareDocumentRevisions({
          before: before.revision,
          after: before.revision
        })
      ).equal,
      true
    );
    await writeFile(path.join(f.root, 'document.txt'), 'aX😀z\r\n');
    const after = await f.application.readDocumentSection({ path: 'document.txt' });
    const difference = await f.application.compareDocumentRevisions({
      before: before.revision,
      after: after.revision
    });
    assert.equal(difference.before.originalText, '');
    assert.equal(difference.after.originalText, 'X');
    await writeFile(path.join(f.root, 'bare-cr.txt'), 'a\rb😀');
    const bare = await f.application.readDocumentSection({ path: 'bare-cr.txt' });
    const barePassage = await f.application.readDocumentPassage({
      revision: bare.revision,
      selector: { quote: 'b😀' }
    });
    assert.deepEqual(barePassage.range, {
      start: { line: 1, column: 3 },
      end: { line: 1, column: 5 }
    });
    await writeFile(path.join(f.root, 'large.txt'), 'a'.repeat(2 * 1024 * 1024 + 1));
    await assert.rejects(
      f.application.readDocumentSection({ path: 'large.txt', maxChars: 1 }),
      /read limit/
    );
  }
);

test(
  'writing rejects replacement of an admitted root before creating a run',
  integration,
  async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    await f.application.start();
    await rename(f.root, path.join(f.parent, 'original'));
    await mkdir(f.root);
    await writeFile(path.join(f.root, 'document.txt'), 'Replacement');
    await assert.rejects(
      submit(f.application, 'Read the document.'),
      /Workspace directory identity changed/
    );
    assert.equal(f.provider.requests.length, 0);
  }
);

test(
  'edit_text uses document source ranges and rejects stale hashes; review excludes both writers',
  integration,
  async (t) => {
    const f = await fixture('Café 😀 original.\r\n', { responses: [] });
    t.after(() => f.close());
    const doc = await f.application.readDocumentSection({ path: 'document.txt' });
    const passage = await f.application.readDocumentPassage({
      revision: doc.revision,
      selector: { quote: 'original' }
    });
    const edit = {
      files: [
        {
          path: passage.path,
          expectedSha256: passage.expectedSha256,
          edits: [
            { range: passage.range, expectedText: passage.expectedText, replacementText: 'revised' }
          ]
        }
      ]
    };
    f.provider.responses.push(toolCall('edit_text', edit), 'Revised.');
    await f.application.start();
    assert.equal(
      (await submit(f.application, 'Revise the passage.')).terminal.executionStatus,
      'completed'
    );
    assert.equal(
      (await f.application.readDocument('document.txt')).content,
      'Café 😀 revised.\r\n'
    );
    f.provider.responses.push(toolCall('edit_text', edit), 'Source changed.');
    const stale = await submit(f.application, 'Try the old range.');
    assert.equal(stale.state, 'ended', JSON.stringify(stale));
    assert.equal(stale.terminal.executionStatus, 'completed');
    assert.match(
      JSON.stringify(f.provider.requests.at(-1)),
      /sha256_mismatch|hash.*mismatch|revision|source.*changed/iu
    );
    assert.equal(
      (await f.application.readDocument('document.txt')).content,
      'Café 😀 revised.\r\n'
    );
    const review = await fixture('Café 😀 revised.\r\n', {
      mode: 'review',
      responses: [toolCall('edit_text', edit), 'Review only.']
    });
    t.after(() => review.close());
    await review.application.start();
    const reviewed = await submit(review.application, 'Review this.');
    assert.equal(reviewed.state, 'ended', JSON.stringify(reviewed));
    assert.equal(reviewed.terminal.executionStatus, 'completed');
    const names = review.provider.requests.at(-1).tools.map((x) => x.name ?? x.function?.name);
    assert(!names.includes('edit_text'));
    assert(!names.includes('apply_patch'));
    assert(names.includes('read_document_passage'));
    assert(names.includes('read_artifact'));
    assert.equal(
      (await review.application.readDocument('document.txt')).content,
      'Café 😀 revised.\r\n'
    );
  }
);

test(
  'writing model tools deliver original sections and explicit conflicts in read-only review',
  integration,
  async (t) => {
    const f = await fixture('A faithful quotation.\nA faithful quotation.\n', {
      mode: 'review',
      responses: []
    });
    t.after(() => f.close());
    const doc = await f.application.readDocumentSection({ path: 'document.txt' });
    f.provider.responses.push(
      toolCall('read_document_section', { path: 'document.txt', maxChars: 22, retain: true }),
      toolCall('read_document_passage', {
        revision: doc.revision,
        selector: { quote: 'A faithful quotation.' }
      }),
      'The quotation occurs twice.'
    );
    await f.application.start();
    const result = await submit(f.application, 'Inspect the original quotations.');
    assert.equal(result.terminal.executionStatus, 'completed');
    assert.match(JSON.stringify(f.provider.requests[1]), /A faithful quotation/);
    assert.match(JSON.stringify(f.provider.requests[1]), /expectedSha256/);
    assert.match(JSON.stringify(f.provider.requests[2]), /ambiguous_passage/);
    assert.equal(
      (await f.application.readDocument('document.txt')).content,
      'A faithful quotation.\nA faithful quotation.\n'
    );
  }
);


test('document passage edits preserve a BOM and can add paragraphs to a single-line original', integration, async (t) => {
  const f = await fixture('\ufeffOriginal', { responses: [] });
  t.after(() => f.close());
  const document = await f.application.readDocumentSection({ path: 'document.txt' });
  const passage = await f.application.readDocumentPassage({ revision: document.revision, selector: { quote: 'Original' } });
  f.provider.responses.push(toolCall('edit_text', {
    files: [{ path: passage.path, expectedSha256: passage.expectedSha256, edits: [{
      range: passage.range, expectedText: passage.originalText, replacementText: 'Revised.\n\nA second paragraph.'
    }] }]
  }), 'Revised.');
  await f.application.start();
  const result = await submit(f.application, 'Revise this and add a second paragraph.');
  assert.equal(result.terminal.executionStatus, 'completed');
  assert.equal((await f.application.readDocument('document.txt')).content, '\ufeffRevised.\n\nA second paragraph.');
});

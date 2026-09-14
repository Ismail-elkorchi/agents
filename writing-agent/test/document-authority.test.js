import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import { RootedFileAuthority } from '@agent-core/tools-local';
import {
  WritingDocuments,
  documentSectionSchema,
  documentPassageSchema,
  documentComparisonSchema,
  MAX_DOCUMENT_BYTES
} from '../dist/documents.js';
import { createWritingDocumentTools } from '../dist/document-tools.js';

async function authority(t, repository = new InMemoryArtifactRepository()) {
  const directory = await mkdtemp(path.join(tmpdir(), 'writing-document-authority-'));
  const root = RootedFileAuthority.adopt(directory, { additionalDeniedEntries: ['.git'] });
  t.after(async () => {
    root.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, root, repository, documents: new WritingDocuments(root, repository) };
}

test(
  'document operations bound original artifact reads before loading or decoding bytes',
  { skip: process.platform !== 'linux' },
  async (t) => {
    class MeasuredArtifacts extends InMemoryArtifactRepository {
      reads = 0;
      async resolve() {
        return {
          artifactId: 'retained',
          size: MAX_DOCUMENT_BYTES * 6 + 4097,
          sha256: '0'.repeat(64),
          visibility: 'public',
          mediaType: 'application/json'
        };
      }
      async readVerified(ref) {
        this.reads++;
        return super.readVerified(ref);
      }
    }
    const repository = new MeasuredArtifacts();
    const f = await authority(t, repository);
    await assert.rejects(
      f.documents.resolve({
        path: 'article.txt',
        expectedSha256: '0'.repeat(64),
        artifactId: 'retained'
      }),
      { reason: 'read_limit' }
    );
    assert.equal(repository.reads, 0);
  }
);

test(
  'source snapshots preserve bare CR and reject half scalars, split CRLF, and forged retained revisions',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const f = await authority(t);
    await writeFile(path.join(f.directory, 'article.txt'), 'a\rb😀\r\n');
    const doc = await f.documents.read('article.txt', true);
    const passage = await f.documents.passage(
      documentPassageSchema.parse({ revision: doc.revision, selector: { quote: 'b😀' } })
    );
    assert.deepEqual(passage.range, { start: { line: 1, column: 3 }, end: { line: 1, column: 5 } });
    for (const start of [4, 6])
      await assert.rejects(
        f.documents.passage(
          documentPassageSchema.parse({
            revision: doc.revision,
            selector: { range: { start, end: 7 } }
          })
        ),
        { reason: 'invalid_range' }
      );
    const wrong = await f.repository.store({
      label: 'fake',
      mediaType: 'application/json',
      content: Buffer.from(
        JSON.stringify({
          path: 'article.txt',
          expectedSha256: doc.sha256,
          content: 'forged',
          root: {
            device: f.root.identity.device,
            inode: f.root.identity.inode,
            mountId: f.root.identity.mountId
          }
        })
      )
    });
    await assert.rejects(f.documents.resolve({ ...doc.revision, artifactId: wrong.artifactId }), {
      reason: 'missing_revision'
    });
    await writeFile(path.join(f.directory, 'article.txt'), 'a\rb🦊\r\n');
    const after = await f.documents.read('article.txt');
    const comparison = await f.documents.compare(
      documentComparisonSchema.parse({ before: doc.revision, after: after.revision, maxChars: 2 })
    );
    assert.equal(comparison.before.originalText, '😀');
    assert.equal(comparison.after.originalText, '🦊');
    await rm(path.join(f.directory, 'article.txt'));
    await assert.rejects(f.documents.resolve(after.revision), { reason: 'missing_revision' });
    assert.equal((await f.documents.resolve(doc.revision)).content, doc.content);
  }
);

test(
  'document model tools return originals with bounded coverage and do not invent a success flag',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const f = await authority(t);
    await writeFile(path.join(f.directory, 'article.md'), '# Heading\nAn exact quotation.\n');
    const tool = createWritingDocumentTools(f.root, f.repository).find(
      (tool) => tool.name === 'read_document_section'
    );
    const input = documentSectionSchema.parse({ path: 'article.md', maxChars: 10 });
    const binding = await tool.bindExecution(input, {});
    const result = await binding.invoke({ policy: {} });
    assert.equal(result.kind, 'result');
    assert(!('ok' in result));
    assert.equal(result.scope.coverage, 'partial');
    assert.equal(result.output.nextOffset, 10);
    assert.equal(result.output.originalText, '# Heading\n');
    const content = tool.buildModelContent({ input, observation: result });
    assert(content[0].text.endsWith('\n\n# Heading\n'));
    assert.equal(result.content, undefined);
    assert(!('presentObservation' in tool));
  }
);

import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { finalResponse, scriptedOllama } from '../../coding-agent/test/fixtures/scripted-cli.js';
import { fixture } from './helpers/runtime.js';

test(
  'CLI passage input uses the same retained revision and exact source as RPC and TUI',
  { skip: process.platform !== 'linux', timeout: 30_000 },
  async (t) => {
    const f = await fixture('Original quotation 😀.\n');
    const provider = await scriptedOllama([finalResponse('Reviewed the original quotation.')]);
    t.after(async () => {
      await provider.close();
      await f.close();
    });
    const doc = await f.application.readDocument('document.txt');
    await f.application.close();
    await writeFile(path.join(f.root, 'document.txt'), 'Changed by the user.\n');
    const request = { revision: doc.revision, selector: { quote: 'Original quotation 😀.' } };
    const args = [
      'writing-agent/dist/cli.js',
      'review',
      'Discuss the attached quotation.',
      '--root',
      f.root,
      '--state-root',
      f.stateRoot,
      '--provider',
      'ollama',
      '--model',
      'v0-scripted',
      '--endpoint',
      provider.endpoint,
      '--max-output-tokens',
      '777',
      '--passage',
      JSON.stringify(request)
    ];
    const result = await promisify(execFile)(process.execPath, args);
    assert.match(result.stdout, /Reviewed the original/);
    assert.equal(provider.chatRequests[0].options.num_predict, 777);
    const sent = JSON.stringify(provider.chatRequests);
    assert.match(sent, /Original quotation 😀/);
    assert(sent.includes(doc.sha256));
    assert(!sent.includes('Changed by the user'));
  }
);


test('CLI rejects an invalid generation allowance before opening a workspace', async () => {
  await assert.rejects(promisify(execFile)(process.execPath, ['writing-agent/dist/cli.js', 'review', 'Review this.', '--max-output-tokens', '0']), /must be a positive integer/);
});

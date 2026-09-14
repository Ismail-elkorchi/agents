import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { openCodingApplication } from '@ismail-elkorchi/coding-agent';
import { createWorkspace, finalResponse, scriptedOllama, trust } from './fixtures/scripted-cli.js';

test(
  'coding run creation rejects a replacement of the originally admitted workspace',
  { skip: process.platform !== 'linux', timeout: 30_000 },
  async (t) => {
    const provider = await scriptedOllama([finalResponse('Must not reach inference.')]);
    const fixture = await createWorkspace({
      endpoint: provider.endpoint,
      tools: ['read_files'],
      checks: []
    });
    let application;
    t.after(async () => {
      await application?.close();
      await provider.close();
      await fixture.close();
    });
    await trust(fixture);
    application = await openCodingApplication({
      root: fixture.root,
      stateRoot: fixture.stateRoot,
      providerEndpoint: provider.endpoint
    });
    await application.start();
    await rename(fixture.root, `${fixture.root}-original`);
    await mkdir(fixture.root);
    await writeFile(`${fixture.root}/replacement.txt`, 'Not admitted');
    await assert.rejects(async () => {
      const submission = await application.submit({ task: 'Read replacement.txt.' });
      assert.notEqual(submission.kind, 'rejected');
      await submission.completion;
    }, /Workspace directory identity changed/);
    assert.equal(provider.chatRequests.length, 0);
  }
);

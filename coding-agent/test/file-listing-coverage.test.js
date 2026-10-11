import test from 'node:test';
import assert from 'node:assert/strict';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { openCodingApplication } from '@ismail-elkorchi/coding-agent';
import { createWorkspace, scriptedOllama, trust } from './fixtures/scripted-cli.js';

test('file listing distinguishes complete matches, omitted matches, and unscanned entries', {
  skip: process.platform !== 'linux', timeout: 30000
}, async (t) => {
  const provider = await scriptedOllama([]);
  const fixture = await createWorkspace({
    endpoint: provider.endpoint, tools: ['read_files'], checks: [],
    files: Object.fromEntries([
      ...Array.from({ length: 257 }, (_, index) => [`matches/file-${index}`, '']),
      ...Array.from({ length: 4097 }, (_, index) => [`scan/file-${index}`, ''])
    ])
  });
  let application;
  t.after(async () => {
    await application?.close();
    await provider.close();
    await fixture.close();
  });
  await trust(fixture);
  application = await openCodingApplication({
    permissionMode: 'read_only', root: fixture.root, stateRoot: fixture.stateRoot,
    providerEndpoint: provider.endpoint
  });
  await application.start();
  const omitted = await application.listFiles('matches');
  assert.equal(omitted.coverage, 'partial');
  assert.equal(omitted.entries.length, 256);
  await unlink(path.join(fixture.root, 'matches/file-256'));
  const complete = await application.listFiles('matches');
  assert.equal(complete.coverage, 'complete');
  assert.equal(complete.entries.length, 256);
  const absent = await application.listFiles('matches', 'absent');
  assert.equal(absent.coverage, 'complete');
  assert.deepEqual(absent.entries, []);
  const unscanned = await application.listFiles('scan', 'absent');
  assert.equal(unscanned.coverage, 'partial');
  assert.deepEqual(unscanned.entries, []);
});

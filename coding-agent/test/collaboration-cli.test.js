import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
for (const application of ['coding-agent', 'writing-agent'])
  test(`${application} CLI rejects invalid collaboration policy before opening a provider`, async () => {
    await assert.rejects(execute(process.execPath, [`${application}/dist/cli.js`, 'rpc',
      '--collaboration', '{"maxParticipants":0}'], { timeout: 30_000 }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /maxParticipants/);
      return true;
    });
  });

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export async function assertClosedProcessLedger(directory, { processId, runId, status }) {
  assert.match(processId, /^proc_[a-f0-9-]+$/u);
  assert.deepEqual((await readdir(directory)).sort(), ['.manager', `${processId}.terminal.json`],
    'Closing the sole owner retains one exact terminal receipt and only canonical manager metadata.');
  assert.deepEqual(await readdir(path.join(directory, '.manager')), [],
    'The closed manager must release its lifetime owner lock and leave no pending lock candidates.');
  const receipt = JSON.parse(await readFile(path.join(directory, `${processId}.terminal.json`), 'utf8'));
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.processId, processId);
  assert.equal(receipt.owner.runId, runId);
  assert.equal(receipt.status, status);
  return receipt;
}

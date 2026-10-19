import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertClosedProcessLedger } from './fixtures/process-ledger.js';

async function ledger(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'closed-process-ledger-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const expected = { processId: 'proc_12345678-abcd', runId: 'exact-run', status: 'stopped' };
  await mkdir(path.join(directory, '.manager'));
  const receipt = { schemaVersion: 1, processId: expected.processId, owner: { runId: expected.runId }, status: expected.status };
  const file = path.join(directory, `${expected.processId}.terminal.json`);
  await writeFile(file, JSON.stringify(receipt));
  return { directory, expected, receipt, file };
}

test('closed process ledger assertions allow only released manager metadata and the exact terminal receipt', async t => {
  const { directory, expected, receipt } = await ledger(t);
  assert.deepEqual(await assertClosedProcessLedger(directory, expected), receipt);
});

test('closed process ledger assertions reject arbitrary files and unacknowledged supervisor state', async t => {
  const { directory, expected } = await ledger(t);
  for (const name of [`${expected.processId}.json`, `${expected.processId}.auth.json`, `${expected.processId}.state.json`,
    'sockets', 'other.terminal.json', '.unexpected']) {
    const file = path.join(directory, name);
    await writeFile(file, 'unacknowledged');
    await assert.rejects(assertClosedProcessLedger(directory, expected), /exact terminal receipt/u);
    await rm(file);
  }
  await mkdir(path.join(directory, '.manager', 'owner.lock'));
  await assert.rejects(assertClosedProcessLedger(directory, expected), /lifetime owner lock/u);
});

test('closed process ledger assertions reject terminal receipts belonging to a different run', async t => {
  const { directory, expected, receipt, file } = await ledger(t);
  await writeFile(file, JSON.stringify({ ...receipt, owner: { runId: 'other-run' } }));
  await assert.rejects(assertClosedProcessLedger(directory, expected), /other-run/u);
});

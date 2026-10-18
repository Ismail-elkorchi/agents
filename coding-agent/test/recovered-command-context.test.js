import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveredCommandContext } from '../src/execution/recovered-command-context.ts';

function page() {
  return { reports: [{ processId: 'process-1', owner: { ownerId: 'session-1', runId: 'run-1' },
    status: 'exited', finalizationPending: false, handoffPending: true, details: { exitCode: 0 } }],
  next: 'opaque-cursor', complete: false, scanned: 16 };
}
test('repeated request assembly is read-only and preserves bounded pending coverage', () => {
  const source = page();
  const before = JSON.stringify(source);
  for (let index = 0; index < 100; index++) {
    const [item] = recoveredCommandContext(source);
    assert.deepEqual(JSON.parse(item.content), source);
    assert.equal(item.sourceUri, 'runtime://command-reports/pending');
    assert.equal(item.sourceUri.startsWith('artifact:'), false);
    assert.ok(Buffer.byteLength(JSON.stringify(item)) <= 16_384);
    assert.match(item.purpose, /resource_reports_read/);
  }
  assert.equal(JSON.stringify(source), before);
});
test('pending handoff does not imply failed terminal record finalization', () => {
  const source = page();
  source.reports[0].finalizationPending = true;
  const content = JSON.parse(recoveredCommandContext(source)[0].content);
  assert.equal(content.reports[0].finalizationPending, true);
  assert.equal(content.reports[0].handoffPending, true);
});
test('complete empty pending page adds no request contribution', () => {
  assert.deepEqual(recoveredCommandContext({ reports: [], next: 'opaque-cursor', complete: true, scanned: 0 }), []);
});
test('complete contribution envelope is budgeted, including metadata and escaped content', () => {
  const source = page();
  source.reports[0].details.diagnostic = '"'.repeat(12_000);
  assert.throws(() => recoveredCommandContext(source), /complete envelope budget/);
});

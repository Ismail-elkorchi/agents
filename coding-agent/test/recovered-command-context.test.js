import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import { recoveredCommandContext } from '../src/execution/recovered-command-context.ts';

function report(index, ownerId = 'session-1') {
  return { result: {
    processId: `process-${index}`, owner: { ownerId, runId: `run-${index}` },
    status: 'exited', exitCode: index
  } };
}

test('more than sixteen recovered receipts have explicit coverage and complete immutable retrieval', async () => {
  const artifacts = new InMemoryArtifactRepository();
  const reports = [...Array.from({ length: 23 }, (_, index) => report(index)), report(99, 'other-session')];
  const [item] = await recoveredCommandContext(reports, 'session-1', artifacts);
  const content = JSON.parse(item.content);
  assert.deepEqual(content.coverage, { total: 23, included: 16, omitted: 7,
    order: 'recovery-enumeration', complete: false });
  const complete = JSON.parse(new TextDecoder().decode(await artifacts.readVerified(content.completeReports)));
  assert.equal(complete.length, 23);
  assert.equal(complete[22].processId, 'process-22');
  assert.equal(complete[22].exitCode, 22);
  assert.equal(complete.some(item => item.owner.ownerId === 'other-session'), false);
  assert.equal(content.reports[2].processId, 'process-2');
});

test('blocked terminal reports remain visibly pending instead of claiming a committed completion', async () => {
  const pending = report(1);
  pending.result.finalizationPending = true;
  const [item] = await recoveredCommandContext([pending], 'session-1', new InMemoryArtifactRepository());
  const content = JSON.parse(item.content);
  assert.equal(content.reports[0].finalizationPending, true);
  assert.equal(content.coverage.complete, true);
});

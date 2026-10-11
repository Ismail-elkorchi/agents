import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, submit } from './helpers/runtime.js';

test('context inspection and unchanged application preserve ordinary history; fresh context honors an explicit selection', { skip: process.platform !== 'linux', timeout: 30_000 }, async (t) => {
  const f = await fixture('', { responses: ['First answer.', 'Second answer.', 'Third answer.', 'Fresh answer.'] });
  t.after(() => f.close());
  await f.application.start();
  await submit(f.application, 'Remember ORIGINAL-MARKER-493.');
  await submit(f.application, 'Second question.');
  const inspected = await f.application.inspectContext();
  assert.equal(inspected.window, null);
  assert.equal(inspected.activeSelection.selection.retained.length, 4);
  await f.application.renewContext(inspected.activeSelection.selection);
  await submit(f.application, 'Third question.');
  assert.match(JSON.stringify(f.provider.requests.at(-1).messages), /ORIGINAL-MARKER-493/);
  const current = await f.application.inspectContext();
  assert.equal(current.activeSelection.selection.retained.length, 6, 'the selected window includes subsequent originals');
  await f.application.freshContext([]);
  await submit(f.application, 'Independent question.');
  const request = JSON.stringify(f.provider.requests.at(-1).messages);
  assert.doesNotMatch(request, /ORIGINAL-MARKER-493|Second question|Third question/);
  assert.match(request, /Independent question/);
});

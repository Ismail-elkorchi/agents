import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, submit, toolCall } from './helpers/runtime.js';

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


test('review mode exposes protected live context without acquiring document edit authority',
  { skip: process.platform !== 'linux', timeout: 30_000 }, async (t) => {
    const f = await fixture('Original document.\n', { mode: 'review', responses: [
      toolCall('context_inspect', { limit: 10, maxBytes: 8192 }),
      request => {
        const inspection = JSON.parse(request.messages.find(item => item.role === 'tool').content);
        assert.equal(inspection.committedWindow, null);
        assert.equal(inspection.selection.status, 'available');
        assert(inspection.selection.items.some(item => item.type === 'input' && item.group.release === 'protected'));
        assert(inspection.admission.inputIdentity);
        assert(!request.tools.some(tool => ['apply_patch', 'edit_text'].includes(tool.type === 'function' ? tool.function.name : tool.name)));
        return 'Review context is available.';
      }
    ] });
    t.after(() => f.close());
    await f.application.start();
    const result = await submit(f.application, 'Inspect the current context for this review.');
    assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
    assert.equal(await readFile(path.join(f.root, 'document.txt'), 'utf8'), 'Original document.\n');
  }
);

import assert from 'node:assert/strict';
import test from 'node:test';
import { contentId } from '../dist/canonical.js';
import { structuralChangeSchema, textRangeSchema } from '../dist/domain.js';

test('domain admission captures children even when the caller has frozen their parent', () => {
  const start = { line: 1, column: 1 };
  const input = Object.freeze({ start, end: { line: 2, column: 1 } });
  const range = textRangeSchema.parse(input);
  start.line = 100;
  assert.equal(range.start.line, 1);
  assert.throws(() => { range.start.line = 200; }, TypeError);
  assert.throws(() => { range.end.column = 2; }, TypeError);
});

test('structural changes capture exact immutable JSON and reject data that would be lost', () => {
  const input = {
    changeId: 'change', intentIds: ['intent'], kind: 'purpose', targetIds: ['node'],
    value: { nested: { text: 'x'.repeat(20_000) + 'complete' } }
  };
  const change = structuralChangeSchema.parse(input);
  input.value.nested.text = 'changed';
  assert.equal(change.value.nested.text, 'x'.repeat(20_000) + 'complete');
  assert.throws(() => { change.value.nested.text = 'changed'; }, TypeError);
  assert.throws(() => { change.intentIds.push('another'); }, TypeError);
  assert.throws(() => structuralChangeSchema.parse({ ...input, value: { invalid: 1n } }));
});

test('writing identities include complete content and require explicit optional-field construction', () => {
  const text = 'x'.repeat(20_000);
  assert.notEqual(contentId('proposal', { text: text + 'a' }), contentId('proposal', { text: text + 'b' }));
  assert.throws(() => contentId('proposal', { missing: undefined }), TypeError);
});

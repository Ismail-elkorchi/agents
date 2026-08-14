import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
test('coding agent owns its CLI and TUI without legacy application packages', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, '@ismail-elkorchi/coding-agent');
  assert.equal(manifest.bin['coding-agent'], './dist/index.js');
  assert.equal(manifest.exports['./tui'], './dist/tui/index.js');
  assert.deepEqual(Object.keys(manifest.dependencies).filter((name) => name.endsWith('/cli') || name.endsWith('/tui')), []);
});

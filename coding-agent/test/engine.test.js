import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
for (const name of ['coding-agent', 'writing-agent', 'research-agent']) test(`${name} declares the supported Node engine`, async () => { const manifest = JSON.parse(await readFile(new URL(`../../${name}/package.json`, import.meta.url), 'utf8')); assert.equal(manifest.engines.node, '>=24.8.0'); });

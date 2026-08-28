import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

for (const [label, source] of [['Agent Core', manifest.agentCore], ['Sandbox', manifest.sandbox]]) {
  if (typeof source?.path !== 'string' || typeof source.commit !== 'string') {
    throw new Error(`${label} source dependency is not declared with a path and commit.`);
  }
  const checkout = path.resolve(root, source.path);
  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: checkout });
  const actual = stdout.trim();
  if (actual !== source.commit) throw new Error(`${label} checkout mismatch: expected ${source.commit}, received ${actual}.`);
}

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const sourceRoot = path.resolve(import.meta.dirname, '..', 'src');
const sources = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
  .map((entry) => path.join(entry.parentPath, entry.name));

test('Writing Agent reserves evidence for claim and source support', () => {
  const violations = [];
  const prohibitedExport = /export\s+(?:interface|type|class|function|const)\s+[A-Za-z0-9_]*(?:Projection|Prepare|Prepared|Evaluation|Candidate)[A-Za-z0-9_]*/gu;
  const prohibitedPersistedTag = /(?:kind|type):\s*(?:z\.literal\()?['"][^'"]*(?:projection|prepared|candidate|evaluation)[^'"]*['"]/gu;
  for (const file of sources) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(prohibitedExport)) violations.push(`${file}: ${match[0]}`);
    for (const match of source.matchAll(prohibitedPersistedTag)) violations.push(`${file}: ${match[0]}`);
    if (/\b(?:projection|projected|projecting|prepare|prepared|preparing|preparation|operationStatus)\b/iu.test(source)) violations.push(`${file}: prohibited lifecycle term`);
    if (/\bprovider\.(?:complete|stream)\s*\(/u.test(source)) violations.push(`${file}: provider invocation bypasses InferenceGateway`);
  }
  assert.deepEqual(violations, []);
});

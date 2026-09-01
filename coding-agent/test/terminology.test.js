import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const sourceRoot = path.resolve(import.meta.dirname, '..', 'src');
const sources = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
  .map((entry) => path.join(entry.parentPath, entry.name));
const sandboxWireAdapters = new Set([
  path.join(sourceRoot, 'execution', 'sandbox-command-execution.ts'),
  path.join(sourceRoot, 'workspace', 'git', 'sandbox-git-observer.ts')
]);
const providerBoundaryAdapters = new Set([
  path.join(sourceRoot, 'security', 'provider-egress.ts')
]);

test('Coding Agent public and persisted contracts use the shared glossary', () => {
  const violations = [];
  const prohibitedExport = /export\s+(?:interface|type|class|function|const)\s+([A-Za-z0-9_]*(?:Projection|Prepare|Prepared|Evaluation|Evidence|Candidate)[A-Za-z0-9_]*)/gu;
  const prohibitedPersistedTag = /(?:kind|type):\s*(?:z\.literal\()?['"][^'"]*(?:projection|candidate|evaluation)[^'"]*['"]/gu;
  for (const file of sources) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(prohibitedExport)) {
      if (match[1] !== 'createCandidateAcceptanceChecks') violations.push(`${file}: ${match[0]}`);
    }
    for (const match of source.matchAll(prohibitedPersistedTag)) violations.push(`${file}: ${match[0]}`);
    if (!sandboxWireAdapters.has(file) && /\b(?:projection|projected|projecting|prepare|prepared|preparing|preparation|operationStatus|evidence)\b/iu.test(source)) {
      violations.push(`${file}: prohibited domain term outside its owning boundary`);
    }
    if (!providerBoundaryAdapters.has(file) && /\bprovider\.(?:complete|stream)\s*\(/u.test(source)) {
      violations.push(`${file}: provider invocation bypasses InferenceGateway`);
    }
  }
  assert.deepEqual(violations, []);
});

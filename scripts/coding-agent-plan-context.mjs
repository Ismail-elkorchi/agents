import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const planRoot = path.join(repositoryRoot, '.coding-agent-plan');
const manifest = JSON.parse(await readFile(path.join(planRoot, 'manifest.json'), 'utf8'));
const requested = process.argv[2];
const node = manifest.nodes.find((entry) => entry.id === requested);
if (node === undefined) throw new Error(`Unknown plan node: ${String(requested)}`);

const repositoryPaths = {
  agents: repositoryRoot,
  'agent-core': path.resolve(repositoryRoot, '../agent-core'),
  'terminal-ui': path.resolve(repositoryRoot, '../terminal-ui'),
};
const repositories = new Set(node.ownedPaths.map((entry) => entry.slice(0, entry.indexOf(':'))));
const dependencies = node.dependencies.map((id) => manifest.nodes.find((entry) => entry.id === id));
const incomplete = dependencies.filter((dependency) => dependency.status !== 'done');
if (incomplete.length > 0 && node.status !== 'current') {
  throw new Error(`Dependencies are not done: ${incomplete.map((entry) => entry.id).join(', ')}`);
}

const output = [];
output.push(`# Context for ${node.id}`, '');
output.push(await readFile(path.resolve(repositoryRoot, manifest.architecture), 'utf8'));
output.push('', await readFile(path.resolve(repositoryRoot, node.specification), 'utf8'));
for (const decision of node.decisions) {
  output.push('', await readFile(path.resolve(repositoryRoot, decision), 'utf8'));
}
for (const dependency of dependencies) {
  output.push('', `## Dependency ${dependency.id}`, '');
  output.push(await readFile(path.resolve(repositoryRoot, dependency.specification), 'utf8'));
  try {
    output.push(await readFile(path.resolve(repositoryRoot, dependency.evidence), 'utf8'));
  } catch {
    output.push('Dependency evidence is missing.');
  }
}
output.push('', '## Current repository heads', '');
for (const [name, repositoryPath] of Object.entries(repositoryPaths)) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryPath, encoding: 'utf8' }).trim();
  output.push(`- ${name}: ${head}`);
  if (!repositories.has(name)) continue;
  let cursor = repositoryPath;
  while (true) {
    const instructionPath = path.join(cursor, 'AGENTS.md');
    try {
      output.push('', `## Instructions: ${instructionPath}`, '', await readFile(instructionPath, 'utf8'));
    } catch {
      // No instructions at this level.
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
output.push('');
process.stdout.write(output.join('\n'));

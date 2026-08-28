import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const statuses = new Set([
  'not_started',
  'current',
  'blocked',
  'done',
  'rejected',
  'deferred',
]);

const shaPattern = /^[0-9a-f]{40}$/u;
const nodeIdPattern = /^(?:L|R|C|SEC|T|E|A|D|S|G|V|F|Q)\d+$/u;

function fail(message) {
  throw new Error(`Coding-agent plan is invalid: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string.`);
  return value;
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    fail(`${label} must be an array of non-empty strings.`);
  }
  return value;
}

function pathParts(specification) {
  const separator = specification.indexOf(':');
  if (separator <= 0 || separator === specification.length - 1) fail(`invalid owned path ${specification}.`);
  return {
    repository: specification.slice(0, separator),
    pattern: specification.slice(separator + 1).replace(/\*\*$/u, ''),
  };
}

function pathsOverlap(left, right) {
  const a = pathParts(left);
  const b = pathParts(right);
  if (a.repository !== b.repository) return false;
  return a.pattern.startsWith(b.pattern) || b.pattern.startsWith(a.pattern);
}

function dependsOn(nodes, candidate, prerequisite, seen = new Set()) {
  if (candidate.dependencies.includes(prerequisite)) return true;
  if (seen.has(candidate.id)) return false;
  seen.add(candidate.id);
  return candidate.dependencies.some((dependency) => dependsOn(nodes, nodes.get(dependency), prerequisite, seen));
}

export function validateManifest(value) {
  if (!isRecord(value)) fail('manifest must be an object.');
  if (value.schemaVersion !== 1) fail('schemaVersion must be 1.');
  requireString(value.coordinator, 'coordinator');
  requireString(value.authoritativeRepository, 'authoritativeRepository');
  requireString(value.authoritativeBranch, 'authoritativeBranch');
  requireString(value.generatedSummary, 'generatedSummary');
  requireString(value.architecture, 'architecture');
  if (!isRecord(value.reviewedHeads)) fail('reviewedHeads must be an object.');
  for (const [repository, sha] of Object.entries(value.reviewedHeads)) {
    if (!shaPattern.test(String(sha))) fail(`reviewedHeads.${repository} must be a full commit SHA.`);
  }
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) fail('nodes must be a non-empty array.');

  const nodes = new Map();
  const specifications = new Set();
  const evidenceRecords = new Set();
  for (const candidate of value.nodes) {
    if (!isRecord(candidate)) fail('every node must be an object.');
    const id = requireString(candidate.id, 'node.id');
    if (!nodeIdPattern.test(id)) fail(`${id} is not a valid node ID.`);
    if (nodes.has(id)) fail(`duplicate node ID ${id}.`);
    requireString(candidate.title, `${id}.title`);
    requireString(candidate.owner, `${id}.owner`);
    requireStringArray(candidate.dependencies, `${id}.dependencies`);
    requireStringArray(candidate.ownedPaths, `${id}.ownedPaths`);
    requireStringArray(candidate.decisions, `${id}.decisions`);
    requireString(candidate.specification, `${id}.specification`);
    requireString(candidate.evidence, `${id}.evidence`);
    if (specifications.has(candidate.specification)) fail(`${id} shares a specification file.`);
    if (evidenceRecords.has(candidate.evidence)) fail(`${id} shares an evidence file.`);
    specifications.add(candidate.specification);
    evidenceRecords.add(candidate.evidence);
    if (!Number.isSafeInteger(candidate.wave) || candidate.wave < 0) fail(`${id}.wave must be a non-negative integer.`);
    if (!statuses.has(candidate.status)) fail(`${id} has unknown status ${String(candidate.status)}.`);
    if (candidate.status === 'current') {
      requireString(candidate.currentOwner, `${id}.currentOwner`);
    } else if (candidate.currentOwner !== null) {
      fail(`${id}.currentOwner must be null unless status is current.`);
    }
    if (candidate.lastVerifiedCommit !== null && !shaPattern.test(String(candidate.lastVerifiedCommit))) {
      fail(`${id}.lastVerifiedCommit must be null or a full commit SHA.`);
    }
    nodes.set(id, candidate);
  }

  for (const node of nodes.values()) {
    for (const dependency of node.dependencies) {
      if (!nodes.has(dependency)) fail(`${node.id} depends on missing node ${dependency}.`);
      if (dependency === node.id) fail(`${node.id} depends on itself.`);
      if (nodes.get(dependency).wave >= node.wave) fail(`${node.id} is not scheduled after ${dependency}.`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) fail(`dependency cycle reaches ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of nodes.get(id).dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of nodes.keys()) visit(id);

  const activeByOwner = new Map();
  const current = [...nodes.values()].filter((node) => node.status === 'current');
  for (const node of current) {
    const prior = activeByOwner.get(node.currentOwner);
    if (prior !== undefined) fail(`${node.currentOwner} owns current nodes ${prior} and ${node.id}.`);
    activeByOwner.set(node.currentOwner, node.id);
  }
  for (let leftIndex = 0; leftIndex < current.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < current.length; rightIndex += 1) {
      const left = current[leftIndex];
      const right = current[rightIndex];
      if (left.ownedPaths.some((a) => right.ownedPaths.some((b) => pathsOverlap(a, b)))) {
        fail(`current nodes ${left.id} and ${right.id} have overlapping path authority.`);
      }
    }
  }
  for (const left of nodes.values()) {
    for (const right of nodes.values()) {
      if (left.id >= right.id || left.wave !== right.wave) continue;
      if (dependsOn(nodes, left, right.id) || dependsOn(nodes, right, left.id)) continue;
      if (left.ownedPaths.some((a) => right.ownedPaths.some((b) => pathsOverlap(a, b)))) {
        fail(`parallel nodes ${left.id} and ${right.id} claim overlapping paths.`);
      }
    }
  }

  if (!isRecord(value.stopGo) || !nodes.has(value.stopGo.node)) fail('stopGo must reference a node.');
  if (!['pending', 'go', 'revise', 'stop'].includes(value.stopGo.decision)) fail('stopGo.decision is invalid.');
  requireStringArray(value.deferred, 'deferred');
  return { nodes };
}

export function validateSourceChanges(repository, expectedHead, currentHead, changedPaths, allowedPaths = []) {
  if (!shaPattern.test(expectedHead) || !shaPattern.test(currentHead)) fail(`${repository} has an invalid source head.`);
  if (expectedHead === currentHead) return;
  const allowed = (candidate) => allowedPaths.some((prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`));
  const unexpected = changedPaths.filter((candidate) => !allowed(candidate));
  if (unexpected.length > 0) {
    fail(`${repository} source head is stale; unreviewed paths: ${unexpected.join(', ')}.`);
  }
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function validateFiles(planRoot, manifest) {
  const repositoryRoot = path.dirname(planRoot);
  const { nodes } = validateManifest(manifest);
  const required = [manifest.architecture, manifest.generatedSummary];
  for (const node of nodes.values()) {
    required.push(node.specification, ...node.decisions);
    if (node.status === 'done' || node.status === 'current') required.push(node.evidence);
    if (node.status === 'done' && node.lastVerifiedCommit === null) {
      fail(`${node.id} is done without lastVerifiedCommit.`);
    }
  }
  for (const relative of new Set(required)) {
    const target = path.resolve(repositoryRoot, relative);
    if (!target.startsWith(`${repositoryRoot}${path.sep}`)) fail(`path escapes repository: ${relative}.`);
    if (!(await exists(target))) fail(`required file is missing: ${relative}.`);
    if ((await readFile(target, 'utf8')).trim().length === 0) fail(`required file is empty: ${relative}.`);
  }
}

async function main() {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const planRoot = path.join(repositoryRoot, '.coding-agent-plan');
  const manifest = JSON.parse(await readFile(path.join(planRoot, 'manifest.json'), 'utf8'));
  await validateFiles(planRoot, manifest);
  const applicationPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  if (applicationPackage.agentCore?.commit !== manifest.reviewedHeads['agent-core']) {
    fail('package.json Agent Core revision does not match the reviewed head.');
  }
  const codingAgentPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'coding-agent/package.json'), 'utf8'));
  const terminalUiDependency = codingAgentPackage.dependencies?.['@ismail-elkorchi/terminal-ui'];
  if (typeof terminalUiDependency !== 'string' || terminalUiDependency.split('#')[1] !== manifest.reviewedHeads['terminal-ui']) {
    fail('Coding Agent Terminal UI revision does not match the reviewed head.');
  }
  const repositories = {
    agents: {
      path: repositoryRoot,
      allowedPlanPaths: [
        '.coding-agent-implementation-plan.md',
        '.coding-agent-plan',
        'scripts/check-coding-agent-plan.mjs',
        'scripts/check-coding-agent-plan.test.mjs',
        'scripts/coding-agent-plan-context.mjs',
        'scripts/generate-coding-agent-plan-summary.mjs',
        'package.json',
      ],
    },
    'agent-core': { path: path.resolve(repositoryRoot, '../agent-core'), allowedPlanPaths: [] },
    'terminal-ui': { path: path.resolve(repositoryRoot, '../terminal-ui'), allowedPlanPaths: [] },
  };
  for (const [name, repository] of Object.entries(repositories)) {
    const expected = manifest.reviewedHeads[name];
    const current = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository.path, encoding: 'utf8' }).trim();
    let changed = [];
    if (current !== expected) {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', expected, current], { cwd: repository.path });
      } catch {
        fail(`${name} current head does not descend from its reviewed head.`);
      }
      changed = execFileSync('git', ['diff', '--name-only', `${expected}..${current}`], { cwd: repository.path, encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean);
    }
    validateSourceChanges(name, expected, current, changed, repository.allowedPlanPaths);
  }
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  if (branch !== manifest.authoritativeBranch) fail(`ledger branch is ${branch}, expected ${manifest.authoritativeBranch}.`);
  process.stdout.write(`Coding-agent plan valid: ${manifest.nodes.length} nodes.\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}

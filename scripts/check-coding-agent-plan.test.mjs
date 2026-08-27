import assert from 'node:assert/strict';
import test from 'node:test';
import { validateManifest, validateSourceChanges } from './check-coding-agent-plan.mjs';

function manifest(nodes) {
  return {
    schemaVersion: 1,
    coordinator: 'coordinator',
    authoritativeRepository: 'agents',
    authoritativeBranch: 'main',
    generatedSummary: '.coding-agent-implementation-plan.md',
    architecture: '.coding-agent-plan/architecture.md',
    reviewedHeads: { agents: 'a'.repeat(40) },
    nodes,
    deferred: [],
    stopGo: { node: nodes.at(-1)?.id, decision: 'pending' },
  };
}

function node(id, dependencies = [], wave = 0, overrides = {}) {
  return {
    id,
    title: id,
    owner: 'owner',
    dependencies,
    wave,
    status: 'not_started',
    currentOwner: null,
    ownedPaths: [`agents:${id.toLowerCase()}/**`],
    specification: `.coding-agent-plan/nodes/${id}.md`,
    decisions: ['.coding-agent-plan/decisions/review.md'],
    evidence: `.coding-agent-plan/evidence/${id}.md`,
    lastVerifiedCommit: null,
    ...overrides,
  };
}

test('accepts an ordered plan', () => {
  assert.doesNotThrow(() => validateManifest(manifest([node('L0'), node('R0', ['L0'], 1)])));
});

for (const [name, nodes, message] of [
  ['duplicates', [node('L0'), node('L0', [], 1)], /duplicate node/u],
  ['missing dependency', [node('L0', ['R0'], 1)], /missing node/u],
  ['impossible wave', [node('L0'), node('R0', ['L0'], 0)], /not scheduled after/u],
  ['unknown status', [node('L0', [], 0, { status: 'working' })], /unknown status/u],
  ['current without owner', [node('L0', [], 0, { status: 'current' })], /currentOwner/u],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => validateManifest(manifest(nodes)), message);
  });
}

test('rejects an ownership conflict between parallel nodes', () => {
  const first = node('L0', [], 0, { ownedPaths: ['agents:shared/**'] });
  const second = node('R0', [], 0, { ownedPaths: ['agents:shared/file.ts'] });
  assert.throws(() => validateManifest(manifest([first, second])), /overlapping paths/u);
});

test('rejects two current nodes owned by one coordinator', () => {
  const active = { status: 'current', currentOwner: 'same' };
  assert.throws(() => validateManifest(manifest([node('L0', [], 0, active), node('R0', [], 1, active)])), /owns current nodes/u);
});

test('requires disjoint per-node evidence records', () => {
  const shared = '.coding-agent-plan/evidence/shared.md';
  assert.throws(() => validateManifest(manifest([
    node('L0', [], 0, { evidence: shared }),
    node('R0', [], 1, { evidence: shared }),
  ])), /shares an evidence file/u);
});

test('rejects stale source while allowing ledger-only descendants', () => {
  const expected = 'a'.repeat(40);
  const current = 'b'.repeat(40);
  assert.doesNotThrow(() => validateSourceChanges('agents', expected, current, ['.coding-agent-plan/evidence/L0.md'], ['.coding-agent-plan']));
  assert.throws(() => validateSourceChanges('agents', expected, current, ['coding-agent/src/main.ts'], ['.coding-agent-plan']), /source head is stale/u);
});

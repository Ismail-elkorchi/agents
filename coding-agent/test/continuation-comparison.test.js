import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { comparisonFixtures, prepareComparison, primaryTaskScenario, baseline, mechanicsCases }
  from '../../validation/continuation-comparison.mjs';

const fixtures = comparisonFixtures();
const configuration = () => ({
  builds: {
    A: { ...baseline, directory: '/comparison/A', qualified: true, schema: 'original', policy: 'reset-on-state-update' },
    B: { core: 'b'.repeat(40), agents: 'd'.repeat(40), directory: '/comparison/B', qualified: true, schema: 'original', policy: 'selective-continuation' },
    C: { core: 'c'.repeat(40), agents: 'e'.repeat(40), directory: '/comparison/C', qualified: true, schema: 'narrative-blocks', policy: 'selective-continuation' }
  },
  settings: { provider: 'offline-test-only', modelVersion: 'scripted-fixed-version', reasoning: 'disabled',
    toolConfigurationHash: 'test-tools', maxInputTokens: 16000, maxOutputTokens: 2000,
    maxTotalTokens: 18000, maxPreparationCalls: 8, deadlineMs: 300000, maxChargeUsd: 1, maxTotalChargeUsd: 20 },
  repetitions: 2, fixtures: [primaryTaskScenario(), ...fixtures]
});
async function materialize(fixture, directory) {
  for (const [file, text] of Object.entries(fixture.files)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), text);
  }
}
const answer = fixture => JSON.stringify({ answer: fixture.expected, citations: fixture.citations });

test('shipped sources retain exact original citations and scenarios have executable existing-runner steps', async () => {
  assert.equal(fixtures.length, 5);
  for (const fixture of fixtures) {
    assert.equal(fixture.intervention, undefined, 'No inactive intervention DSL');
    const directory = await mkdtemp(path.join(tmpdir(), 'comparison-oracle-'));
    try {
      await materialize(fixture, directory);
      for (const citation of fixture.citations) {
        assert.equal(citation.revision, baseline.agents);
        assert(fixture.files[citation.path].split('\n').slice(citation.startLine - 1, citation.endLine).join('\n').includes(citation.quote));
      }
      const final = fixture.steps.at(-1);
      await final.before?.(directory);
      assert(Object.values(await final.check(directory, fixture, answer(fixture))).every(Boolean));
      assert.equal((await final.check(directory, fixture, '{}')).taskCorrectness, false);
      assert.equal((await final.check(directory, fixture, 'not JSON')).validJson, false);
      await writeFile(path.join(directory, fixture.immutableFiles.at(-1)), 'changed');
      assert.equal((await final.check(directory, fixture, answer(fixture))).constraintCompliance, false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('valid expanded/reordered evidence is accepted; unsupported quotes are rejected', async () => {
  const fixture = fixtures.find(f => f.citations.length > 1);
  const directory = await mkdtemp(path.join(tmpdir(), 'comparison-citations-'));
  try {
    await materialize(fixture, directory);
    const citations = structuredClone(fixture.citations).reverse();
    const citation = citations[0];
    citation.startLine--;
    citation.endLine++;
    citation.quote = fixture.files[citation.path].split('\n').slice(citation.startLine - 1, citation.endLine).join('\n');
    citations.push(structuredClone(citation));
    const check = fixture.steps.at(-1).check;
    assert.equal((await check(directory, fixture, JSON.stringify({ answer: fixture.expected, citations }))).evidenceAccuracy, true);
    citations[0].quote = 'fabricated';
    assert.equal((await check(directory, fixture, JSON.stringify({ answer: fixture.expected, citations }))).evidenceAccuracy, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('paired preparation separates ordinary live tasks from existing deterministic mechanics', () => {
  const input = configuration();
  const plan = prepareComparison(input);
  assert.equal(plan.liveApprovalRequired, true);
  assert.equal(plan.trials.length, 24);
  assert(plan.trials.every(trial => trial.pressure === 'ordinary'));
  for (let i = 0; i < plan.trials.length; i += 2)
    assert.deepEqual(plan.trials[i].order, [...plan.trials[i + 1].order].reverse());
  assert.equal(plan.mechanics.length, 8);
  assert(plan.mechanics.every(entry => entry.revision === input.builds[entry.build][entry.repository]));
  assert.equal(mechanicsCases.find(entry => entry.id === 'repeated-state-growth').builds.includes('A'), false);
  for (const mutate of [
    c => { c.builds.B.core = 'pending'; }, c => { c.builds.B.qualified = false; },
    c => { c.builds.C.directory = c.builds.B.directory; }, c => { c.builds.B.schema = 'narrative-blocks'; },
    c => { delete c.settings.modelVersion; }, c => { delete c.settings.maxPreparationCalls; },
    c => { c.settings.maxChargeUsd = 0; }, c => { delete c.settings.maxTotalChargeUsd; }
  ]) {
    const configurationToReject = configuration(); mutate(configurationToReject);
    assert.throws(() => prepareComparison(configurationToReject));
  }
});

test('fixture preparation requires no Git or provider access in shallow checkouts', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'comparison-no-git-'));
  try {
    await mkdir(path.join(directory, 'fixtures'));
    await copyFile(new URL('../../validation/continuation-comparison.mjs', import.meta.url), path.join(directory, 'comparison.mjs'));
    await copyFile(new URL('../../validation/fixtures/continuation-baseline.json', import.meta.url), path.join(directory, 'fixtures/continuation-baseline.json'));
    const output = execFileSync(process.execPath, ['--input-type=module', '-e',
      "globalThis.fetch = () => { throw new Error('Network forbidden'); }; const m = await import('./comparison.mjs'); console.log(m.comparisonFixtures().length, m.primaryTaskScenario().steps.length);"],
      { cwd: directory, env: { ...process.env, PATH: '' }, encoding: 'utf8' });
    assert.equal(output.trim(), '5 3');
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('suite routes only real rooted-file host scenarios to Linux and keeps preparation portable', () => {
  const runner = new URL('../../scripts/run-test-suite.mjs', import.meta.url).href;
  // Execute the actual discovery/filter code, intercepting only its final spawn.
  // No test suite or provider is launched by this enumeration check.
  const mockSpawn = `import { EventEmitter } from 'node:events';
    export function spawn(command, args) {
      process.stdout.write(JSON.stringify(args));
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    }`;
  const mockUrl = `data:text/javascript,${encodeURIComponent(mockSpawn)}`;
  for (const platform of ['linux', 'darwin', 'win32']) {
    const program = `import { registerHooks } from 'node:module';
      Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
      registerHooks({ resolve(specifier, context, next) {
        return specifier === 'node:child_process'
          ? { url: ${JSON.stringify(mockUrl)}, shortCircuit: true } : next(specifier, context);
      } });
      await import(${JSON.stringify(runner)});`;
    const args = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' })).map(value => value.replaceAll('\\', '/'));
    assert(args.some(file => file.endsWith('/coding-agent/test/continuation-comparison.test.js')));
    assert.equal(args.some(file => file.endsWith('/coding-agent/test/continuation-comparison-host.test.js')), platform === 'linux');
    for (const existing of ['project.test.js', 'resilience.test.js', 'tool-composition.test.js'])
      assert.equal(args.some(file => file.endsWith(`/coding-agent/test/${existing}`)), platform === 'linux');
  }
});

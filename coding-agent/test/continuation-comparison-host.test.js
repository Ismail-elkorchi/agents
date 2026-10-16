import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { comparisonFixtures, primaryTaskScenario } from '../../validation/continuation-comparison.mjs';
import { scriptedOllama, toolResponse, finalResponse } from './fixtures/scripted-cli.js';

// Uses the real Linux RootedFileAuthority. The suite runner routes this file;
// never substitute weaker host access on unsupported platforms.
const execute = promisify(execFile);
const fixtures = comparisonFixtures();
const root = fileURLToPath(new URL('../../', import.meta.url));
const answer = fixture => JSON.stringify({ answer: fixture.expected, citations: fixture.citations });

for (const scenario of [primaryTaskScenario(), ...fixtures]) test(`existing evaluator executes ${scenario.id} against scripted local model`,
  { timeout: 30000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'comparison-evaluator-'));
    const script = [];
    if (scenario.kind === 'primary-project-task') {
      script.push(toolResponse('read_files', { files: [{ path: 'math.mjs', startLine: 1, lineCount: 5 }] }), finalResponse('Empty input throws.'),
        toolResponse('apply_patch', { patch: '*** Begin Patch\n*** Update File: settings.json\n@@\n-{"port":3000,"theme":"dark"}\n+{"port":9090}\n*** End Patch' }),
        finalResponse('Updated the settings.'), finalResponse('The port is 9090.'));
    } else {
      for (let index = 0; index < scenario.steps.length; index++) {
        const file = scenario.id === 'changed-external-resource' ? 'resource.json'
          : scenario.id === 'deep-tool-evidence' ? 'diagnostic.txt' : scenario.immutableFiles[0];
        script.push(toolResponse('read_files', { files: [{ path: file, startLine: scenario.id === 'deep-tool-evidence' ? 4097 : 1, lineCount: 100 }] }),
          finalResponse(index === scenario.steps.length - 1 ? answer(scenario) : 'Initial inspection complete.'));
      }
    }
    const provider = await scriptedOllama(script);
    let report;
    try {
      const output = path.join(directory, 'report.json');
      await execute(process.execPath, ['validation/coding-agent-evaluation.mjs', '--live', '--provider', 'ollama', '--model', 'v0-scripted',
        '--endpoint', provider.endpoint, '--max-output-tokens', '4096', '--output', output, '--scenario', scenario.id], { cwd: root, timeout: 25000, maxBuffer: 1024 * 1024 });
      report = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(report.passed, true);
      assert.equal(report.trials[0].steps.length, scenario.steps.length);
      assert.deepEqual(report.trials[0].measurementErrors, []);
      const allRequests = JSON.stringify(provider.chatRequests);
      for (const step of scenario.steps) assert(allRequests.includes(JSON.stringify(step.task).slice(1, -1)));
      if (scenario.id === 'changed-external-resource') {
        assert(allRequests.includes('v0-scripted-next'), 'Actual changed file bytes reached the model through read_files');
        assert(allRequests.includes('old'), 'Initial resource was also observed');
      }
      if (scenario.id === 'deep-tool-evidence') assert(allRequests.includes('requiredBytes'));
      assert(Object.values(report.trials[0].runMetrics).every(metrics => metrics.generationRequests > 0));
    } catch (error) {
      try { report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')); } catch {}
      throw error;
    } finally {
      await provider.close();
      if (report?.directory) await rm(report.directory, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });

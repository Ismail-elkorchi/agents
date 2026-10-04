import assert from 'node:assert/strict';
import test from 'node:test';
import { openCodingApplication } from '@ismail-elkorchi/coding-agent';
import { offlineCodex } from '../../test-helpers/codex.js';
import { createWorkspace, trust } from './fixtures/scripted-cli.js';

test('bounded history retrieval and invalid read budgets let Coding Agent continue',
  { skip: process.platform !== 'linux', timeout: 30_000 }, async (t) => {
    let attempts = 0;
    const call = (id, name, input) => [{
      type: 'function_call', call_id: id, name, arguments: JSON.stringify(input)
    }];
    const provider = await offlineCodex(t, (request) => {
      attempts++;
      if (attempts === 1)
        return call('read', 'read_files', { files: [{ path: 'source.txt' }] });
      if (attempts === 2) return call('search', 'history_search', {
        query: 'needle', filter: { sourceType: 'observation' }, limit: 2, maxBytes: 2200
      });
      const outputs = request.input.filter((item) => item.type === 'function_call_output');
      if (attempts === 3) {
        const search = outputs.find((item) => item.call_id === 'search');
        assert.match(search.output, /needle/);
        assert.match(search.output, /"truncated":true/);
        assert.doesNotMatch(search.output, /cannot fit one source reference/);
        return call('invalid-budget', 'history_search', { query: 'needle', maxBytes: 1 });
      }
      if (attempts === 4) {
        const failure = outputs.find((item) => item.call_id === 'invalid-budget');
        assert.match(failure.output, /invalid_arguments/);
        assert.match(failure.output, /requiredBytes/);
        return 'Inspection complete; the insufficient read budget was handled.';
      }
      assert.equal(attempts, 5);
      return 'Ready for another request.';
    });
    const fixture = await createWorkspace({
      tools: ['read_files'], checks: [], files: { 'source.txt': `needle ${'"\\\t改正😀'.repeat(1000)}` }
    });
    let application;
    t.after(async () => {
      await application?.close();
      await fixture.close();
    });
    await trust(fixture);
    application = await openCodingApplication({
      root: fixture.root, stateRoot: fixture.stateRoot, providerEndpoint: provider.endpoint,
      provider: 'openai-codex', model: 'gpt-6-astra', permissionMode: 'read_only'
    });
    const observations = [];
    application.subscribe((event) => {
      if (event.type === 'run.progress' && event.event.type === 'tool.ended')
        observations.push(event.event.observation);
    });
    await application.start();
    const submitted = await application.submit({ task: 'Inspect the source and retrieve its original history.' });
    const result = await submitted.completion;
    assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
    assert.equal(attempts, 4);
    assert.equal(observations.length, 3);
    assert.equal(observations[1].kind, 'result');
    assert.equal(observations[2].kind, 'failure');
    assert.equal(observations[2].execution.state, 'settled');
    const next = await application.submit({ task: 'Continue.' });
    assert.equal(next.kind, 'started');
    assert.equal((await next.completion).terminal.executionStatus, 'completed');
  }
);

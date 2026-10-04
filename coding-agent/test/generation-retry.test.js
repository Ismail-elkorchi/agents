import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { openCodingApplication } from '@ismail-elkorchi/coding-agent';
import { providerFailureText } from '@agent-core/tui';
import { offlineCodex } from '../../test-helpers/codex.js';
import { createWorkspace, trust } from './fixtures/scripted-cli.js';

test('a failed Codex fetch retries generation without repeating completed commands',
  { skip: process.platform !== 'linux', timeout: 30_000 }, async (t) => {
    const reasoning = {
      type: 'reasoning', id: 'reasoning-original', encrypted_content: 'original-opaque+/=', summary: []
    };
    let attempts = 0;
    let recordedResult;
    const provider = await offlineCodex(t, (request) => {
      attempts++;
      if (attempts === 1) return [reasoning, {
        type: 'function_call', call_id: 'command-once', name: 'exec_command',
        arguments: JSON.stringify({
          command: "printf 'once\\n' >> invocation-count.txt; printf inspected", workdir: '.'
        })
      }];
      const result = request.input.find((item) => item.type === 'function_call_output');
      assert.equal(result.call_id, 'command-once');
      assert.deepEqual(request.input.filter((item) => item.type === 'reasoning'), [reasoning]);
      if (attempts === 2) {
        recordedResult = result;
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
        });
      }
      assert.equal(attempts, 3);
      assert.deepEqual(result, recordedResult);
      return 'Inspection complete.';
    });
    const fixture = await createWorkspace({ tools: ['exec_command'], checks: [] });
    let application;
    t.after(async () => {
      await application?.close();
      await fixture.close();
    });
    await trust(fixture);
    application = await openCodingApplication({
      root: fixture.root, stateRoot: fixture.stateRoot, providerEndpoint: provider.endpoint,
      provider: 'openai-codex', model: 'gpt-6-astra', permissionMode: 'full_host'
    });
    const progress = [];
    application.subscribe((event) => {
      if (event.type === 'run.progress') progress.push(event.event);
    });
    await application.start();
    const submitted = await application.submit({ task: 'Inspect the workspace.' });
    const completed = await submitted.completion;
    assert.equal(completed.terminal?.executionStatus, 'completed', JSON.stringify(completed));
    assert.equal(attempts, 3);
    assert.equal(await readFile(path.join(fixture.root, 'invocation-count.txt'), 'utf8'), 'once\n');
    const observations = (await application.readSession()).history.entries.filter(
      (entry) => entry.type === 'observation'
    );
    assert.equal(observations.length, 1);
    const failure = progress.find((event) => event.type === 'model.failed');
    assert.equal(failure.diagnostic.causeSummary.rootCauseCode, 'UND_ERR_SOCKET');
    assert.match(providerFailureText(failure.diagnostic), /UND_ERR_SOCKET: other side closed/);
    assert(progress.some((event) => event.type === 'assistant.status' && event.message.includes('Retrying')));
  }
);

test('exhausted Codex generation retries end the run and allow a new message',
  { skip: process.platform !== 'linux', timeout: 30_000 }, async (t) => {
    let attempts = 0;
    const provider = await offlineCodex(t, () => {
      if (++attempts <= 3) throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
      });
      return 'Response available again.';
    });
    const fixture = await createWorkspace({ tools: [], checks: [] });
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
    const failures = [];
    application.subscribe((event) => {
      if (event.type === 'run.progress' && event.event.type === 'model.failed')
        failures.push(event.event);
    });
    await application.start();
    const failed = await application.submit({ task: 'Answer this question.' });
    const result = await failed.completion;
    assert.equal(result.state, 'ended');
    assert.equal(result.terminal.executionStatus, 'failed');
    assert.equal(result.terminal.terminationReason, 'provider_error');
    assert.equal(attempts, 3);
    assert.equal(failures.length, 3);
    const next = await application.submit({ task: 'Try again.' });
    assert.equal(next.kind, 'started');
    assert.equal((await next.completion).terminal.executionStatus, 'completed');
    assert.equal(attempts, 4);
  }
);

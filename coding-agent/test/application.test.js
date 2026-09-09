import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';
import { openCodingApplication } from '@ismail-elkorchi/coding-agent';
import { createWorkspace, finalResponse, scriptedOllama, trust } from './fixtures/scripted-cli.js';

test('headless package imports do not load executable or terminal adapters', async () => {
  await promisify(execFile)(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      const adapter = ['coding-agent', 'writing-agent'].some(agent =>
        ['cli.js', 'tui/', 'rpc/'].some(entry => result.url.includes('/' + agent + '/dist/' + entry)));
      if (adapter || result.url.includes('/terminal-ui/')) {
        throw new Error('Headless import loaded an adapter: ' + result.url);
      }
      return result;
    } });
    await import('@ismail-elkorchi/coding-agent');
    await import('@ismail-elkorchi/writing-agent');
  `
  ]);
});

test(
  'unconfigured applications reject input and isolate failing observers',
  { skip: process.platform !== 'linux' },
  async () => {
    const fixture = await createWorkspace({ tools: ['read_files'], checks: [] });
    const application = await openCodingApplication({ root: fixture.root, stateRoot: fixture.stateRoot });
    const events = [];
    let failedCalls = 0;
    application.subscribe(() => {
      failedCalls++;
      throw new Error('observer disconnected');
    });
    application.subscribe((event) => events.push(event));
    try {
      await application.start();
      assert.equal(application.state().status, 'setup_required');
      assert.deepEqual(await application.submit('Retain this as a draft'), {
        kind: 'rejected',
        reason: 'setup_required',
        requirements: ['workspace_trust', 'provider', 'model']
      });
      assert.equal(failedCalls, 1);
      assert(events.some((event) => event.type === 'delivery.failed'));
      assert.equal(application.state().session, undefined);
    } finally {
      await application.close();
      await fixture.close();
    }
  }
);

test(
  'application acceptance, completion, and restored conversation use durable identities',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const provider = await scriptedOllama([finalResponse('No files need changing.')]);
    const fixture = await createWorkspace({ endpoint: provider.endpoint, tools: ['read_files'], checks: [] });
    t.after(async () => {
      await provider.close();
      await fixture.close();
    });
    await trust(fixture);
    const options = { root: fixture.root, stateRoot: fixture.stateRoot, providerEndpoint: provider.endpoint };
    const application = await openCodingApplication(options);
    const events = [];
    application.subscribe((event) => events.push(event));
    let sessionId;
    try {
      await application.start();
      sessionId = application.state().session.sessionId;
      const acceptance = await application.submit('Explain whether any changes are necessary.');
      assert.equal(acceptance.kind, 'started');
      assert(acceptance.completion instanceof Promise);
      const result = await acceptance.completion;
      assert.equal(result.state, 'ended');
      assert.equal(result.terminal.runId, acceptance.runId);
      const view = await application.readSession();
      assert(
        view.history.entries.some(
          (entry) => entry.type === 'assistant' && entry.content === 'No files need changing.'
        )
      );
    } finally {
      await application.close();
    }
    const restored = await openCodingApplication({
      ...options,
      sessionSelection: { kind: 'existing', id: sessionId }
    });
    try {
      await restored.start();
      const view = await restored.readSession();
      assert.equal(view.session.sessionId, sessionId);
      assert(view.history.entries.some((entry) => entry.type === 'input'));
      assert(events.some((event) => event.type === 'run.completed'));
    } finally {
      await restored.close();
    }
  }
);

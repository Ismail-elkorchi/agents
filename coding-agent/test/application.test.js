import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';
import path from 'node:path';
import { openCodingApplication } from '@ismail-elkorchi/coding-agent';
import {
  createWorkspace,
  finalResponse,
  toolResponse,
  scriptedOllama,
  trust
} from './fixtures/scripted-cli.js';

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
    const application = await openCodingApplication({
      permissionMode: 'full_host',
      root: fixture.root,
      stateRoot: fixture.stateRoot
    });
    const events = [];
    let failedCalls = 0;
    let observerFailure;
    application.subscribe(
      () => {
        failedCalls++;
        throw new Error('observer disconnected');
      },
      (error) => {
        observerFailure = error;
      }
    );
    application.subscribe(
      (event) => events.push(event),
      (error) => assert.fail(error)
    );
    try {
      await application.start();
      assert.equal(application.state().status, 'setup_required');
      assert.deepEqual(await application.submit({ task: 'Retain this as a draft' }), {
        kind: 'rejected',
        reason: 'setup_required',
        requirements: ['workspace_trust', 'provider', 'model']
      });
      assert.equal(failedCalls, 1);
      assert.equal(observerFailure?.message, 'observer disconnected');
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
    const fixture = await createWorkspace({
      endpoint: provider.endpoint,
      tools: ['read_files'],
      checks: []
    });
    t.after(async () => {
      await provider.close();
      await fixture.close();
    });
    await trust(fixture);
    const options = {
      root: fixture.root,
      stateRoot: fixture.stateRoot,
      providerEndpoint: provider.endpoint
    };
    const application = await openCodingApplication({ permissionMode: 'full_host', ...options });
    const events = [];
    application.subscribe(
      (event) => events.push(event),
      (error) => assert.fail(error)
    );
    let sessionId;
    try {
      await application.start();
      sessionId = application.state().session.sessionId;
      const acceptance = await application.submit({
        task: 'Explain whether any changes are necessary.',
        instructions: ['Answer in one sentence.'],
        contextItems: [
          {
            sourceUri: 'test://request/context',
            sourceKind: 'user',
            integrity: 'verified',
            representation: 'full',
            mediaType: 'text/plain',
            title: 'Request context',
            content: 'No implementation change is requested.',
            purpose: 'Context supplied with this request.'
          }
        ],
        relationship: { kind: 'side_question' }
      });
      assert.equal(acceptance.kind, 'started');
      assert(acceptance.completion instanceof Promise);
      const result = await acceptance.completion;
      assert.equal(result.state, 'ended', JSON.stringify(result));
      assert.equal(result.terminal.runId, acceptance.runId);
      const view = await application.readSession();
      assert(
        view.history.entries.some(
          (entry) => entry.type === 'assistant' && entry.content === 'No files need changing.'
        )
      );
      const input = view.history.entries.find((entry) => entry.type === 'input');
      assert.deepEqual(input.originalInput.instructions, ['Answer in one sentence.']);
      assert.equal(input.originalInput.contextItems[0].sourceUri, 'test://request/context');
      assert.equal(input.originalInput.relationship.kind, 'side_question');
      const configuration = application.modelSelection();
      await assert.rejects(application.transitionContext({
        expectedWindowId: (await application.inspectContext()).window?.windowId ?? null,
        expectedSourceRevision: (await application.inspectContext()).cut.sourceRevision,
        idempotencyKey: 'renew-inspected-context',
        reason: 'Continue with the inspected originals.',
        selection: (await application.inspectContext()).activeSelection.selection
      }), /compiled next-request admission/);
      assert.deepEqual(application.modelSelection(), configuration);
      assert.equal((await application.inspectContext()).window, null);
    } finally {
      await application.close();
    }
    const restored = await openCodingApplication({
      permissionMode: 'full_host',
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

test(
  'the default Codex application composition completes its first prompt without recovery',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const { offlineCodex } = await import('../../test-helpers/codex.js');
    const provider = await offlineCodex(t, 'No changes are necessary.');
    const fixture = await createWorkspace({ tools: ['read_files'], checks: [] });
    await trust(fixture);
    const app = await openCodingApplication({
      permissionMode: 'full_host',
      root: fixture.root,
      stateRoot: fixture.stateRoot,
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      providerEndpoint: provider.endpoint
    });
    t.after(async () => {
      await app.close();
      await fixture.close();
    });
    await app.start();
    const submission = await app.submit({ task: 'Say whether a change is needed.' });
    assert.equal(submission.kind, 'started');
    const result = await submission.completion;
    assert.equal(result.state, 'ended', JSON.stringify(result));
    assert.equal(result.terminal.executionStatus, 'completed', JSON.stringify(result));
    assert.equal(provider.requests.length, 1);
    assert.equal(app.state().session.suspension, undefined);
    const next = await app.submit({ task: 'Thank you.' });
    assert.equal((await next.completion).terminal.executionStatus, 'completed');
    assert.equal(provider.requests.length, 2);
  }
);

test(
  'model configuration preserves the coding session and selected original constraints',
  { skip: process.platform !== 'linux', timeout: 30000 },
  async (t) => {
    const provider = await scriptedOllama([
      finalResponse('The original answer.'),
      finalResponse('Continuing the same work.')
    ]);
    const fixture = await createWorkspace({ endpoint: provider.endpoint, tools: [], checks: [] });
    await trust(fixture);
    const application = await openCodingApplication({
      permissionMode: 'full_host',
      root: fixture.root,
      stateRoot: fixture.stateRoot,
      provider: 'ollama',
      model: 'v0-scripted',
      providerEndpoint: provider.endpoint
    });
    t.after(async () => {
      await application.close();
      await provider.close();
      await fixture.close();
    });
    await application.start();
    const first = await application.submit({ task: 'Keep the original constraint: café.' });
    assert.equal((await first.completion).terminal.executionStatus, 'completed');
    const sessionId = application.state().session.sessionId;
    const selection = { provider: 'ollama', model: 'v0-scripted', endpoint: provider.endpoint };
    await application.configureModel(
      selection,
      application.connectProvider(selection.provider, selection.endpoint)
    );
    assert.equal(application.state().session.sessionId, sessionId);
    const next = await application.submit({ task: 'Continue.' });
    assert.equal((await next.completion).terminal.executionStatus, 'completed');
    assert(
      (await application.readHistory()).history.entries.some(
        (entry) => entry.type === 'input' && entry.task.includes('café')
      )
    );
  }
);

test(
  'read-only coding retains interpretation across prompts and reopen without editing files',
  { skip: process.platform !== 'linux', timeout: 30000 },
  async (t) => {
    const text = 'Change intent: explain first. Unresolved: verify repository guidance.';
    const provider = await scriptedOllama([
      toolResponse('context_transition', {
        sessionState: { understanding: [{ id: 'interpretation', text }] }, reason: 'Preserve the current interpretation.'
      }),
      finalResponse('Explained.'),
      finalResponse('Continued.')
    ]);
    const fixture = await createWorkspace({
      endpoint: provider.endpoint,
      tools: ['read_files'],
      checks: [],
      files: { 'original.txt': 'Original.' }
    });
    await trust(fixture);
    const options = {
      permissionMode: 'read_only',
      root: fixture.root,
      stateRoot: fixture.stateRoot,
      provider: 'ollama',
      model: 'v0-scripted',
      providerEndpoint: provider.endpoint
    };
    let app = await openCodingApplication(options);
    t.after(async () => {
      await app.close();
      await provider.close();
      await fixture.close();
    });
    await app.start();
    const first = await app.submit({ task: 'Explain the change intent without changing files.' });
    const completed = await first.completion;
    assert.equal(completed.terminal?.executionStatus, 'completed', JSON.stringify(completed));
    const state = await app.inspectContext();
    assert.equal(state.sessionState.content.understanding?.[0]?.text, text, JSON.stringify(state.sessionState));
    assert.equal(state.sessionState.complete, true);
    assert.ok(state.sessionState.revisionId);
    const original = await app.readHistorySource({
      source: state.sessionState.source,
      maxBytes: 16
    });
    assert.equal(original.status, 'available');
    assert.equal(original.item.generated, true);
    assert.equal(original.item.truncated, true);
    await app.close();
    app = await openCodingApplication({ ...options, sessionSelection: { kind: 'existing', id: state.cut.sessionId } });
    await app.start();
    assert.equal(
      (await app.inspectContext()).sessionState.revisionId,
      state.sessionState.revisionId
    );
    const next = await app.submit({ task: 'What remains uncertain?' });
    assert.equal((await next.completion).terminal.executionStatus, 'completed');
    assert.ok(JSON.stringify(provider.chatRequests.at(-1)).includes(text));
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(path.join(fixture.root, 'original.txt'), 'utf8'), 'Original.');
  }
);

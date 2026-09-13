import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { openCodingApplication } from '@ismail-elkorchi/coding-agent';
import { offlineCodex } from '../../test-helpers/codex.js';
import { createWorkspace, trust } from './fixtures/scripted-cli.js';

test(
  'a broken response preserves committed edits and partial text through reopen, reconciliation and stop',
  {
    skip: process.platform !== 'linux',
    timeout: 30_000
  },
  async (t) => {
    const provider = await offlineCodex(t);
    const fixture = await createWorkspace({
      tools: ['apply_patch'],
      checks: [],
      files: { 'draft.md': 'Before.\n' }
    });
    const options = {
      root: fixture.root,
      stateRoot: fixture.stateRoot,
      providerEndpoint: provider.endpoint,
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      reasoning: { strategy: 'effort', effort: 'low' },
      permissionMode: 'edit'
    };
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(String(url), provider.endpoint);
      const body = JSON.parse(init.body);
      assert.equal(body.reasoning.effort, 'low');
      requests++;
      if (requests === 2) {
        let delivered = false;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (delivered) controller.error(new Error('Injected stream disconnection'));
              else {
                delivered = true;
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({
                      type: 'response.output_text.delta',
                      delta: 'The draft was changed, but'
                    })}\n\n`
                  )
                );
              }
            }
          }),
          { headers: { 'Content-Type': 'text/event-stream' } }
        );
      }
      assert(
        requests === 1 || requests === 3,
        'An uncertain provider request must not be silently repeated.'
      );
      const output =
        requests === 1
          ? [
              {
                type: 'custom_tool_call',
                id: 'patch-item',
                call_id: 'patch-call',
                name: 'apply_patch',
                input: '*** Begin Patch\n*** Update File: draft.md\n@@\n-Before.\n+After.\n*** End Patch'
              }
            ]
          : [];
      return new Response(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: `response-${requests}`,
            model: body.model,
            status: 'completed',
            output,
            output_text: requests === 3 ? 'Ready for the next request.' : ''
          }
        })}\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } }
      );
    });
    let application;
    t.after(async () => {
      await application?.close();
      await fixture.close();
    });
    await trust(fixture);
    application = await openCodingApplication(options);
    const progress = [];
    application.subscribe(
      (event) => {
        if (event.type === 'run.progress') progress.push(event.event);
      },
      (error) => assert.fail(error)
    );
    await application.start();
    const submission = await application.submit({ task: 'Change Before to After in draft.md.' });
    assert.equal(submission.kind, 'started');
    const interrupted = await submission.completion;
    assert.equal(interrupted.state, 'suspended');
    assert.equal(interrupted.reason, 'provider_outcome_unknown');
    assert.equal(requests, 2);
    assert.equal(await readFile(path.join(fixture.root, 'draft.md'), 'utf8'), 'After.\n');
    assert(
      progress.some(
        (event) => event.type === 'assistant.interrupted' && event.content === 'The draft was changed, but'
      )
    );
    const sessionId = application.state().session.sessionId;
    await application.close();

    application = await openCodingApplication({
      ...options,
      sessionSelection: { kind: 'existing', id: sessionId }
    });
    await application.start();
    const restored = await application.readSession();
    assert(
      restored.history.entries.some(
        (entry) => entry.type === 'assistant' && entry.content === 'The draft was changed, but'
      )
    );
    assert.equal(
      restored.history.entries.filter(
        (entry) => entry.type === 'tool_call' && entry.call.name === 'apply_patch'
      ).length,
      1
    );
    const reconciled = await application.resumeSuspension(submission.runId);
    assert.equal(reconciled.state, 'suspended');
    assert.equal(requests, 2);
    assert.equal(await application.abort('Stop the interrupted response.', submission.runId), true);
    await application.waitForIdle();
    const next = await application.submit({ task: 'Are you ready for the next request?' });
    assert.equal(next.kind, 'started');
    const result = await next.completion;
    assert.equal(result.state, 'ended');
    assert.equal(result.terminal.executionStatus, 'completed');
    assert.equal(requests, 3);
    assert.equal(await readFile(path.join(fixture.root, 'draft.md'), 'utf8'), 'After.\n');
  }
);

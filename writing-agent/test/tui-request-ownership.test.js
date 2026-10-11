import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { createWritingAgentTuiApp } from '@ismail-elkorchi/writing-agent/tui';
import { waitForState } from '../../test-helpers/tui-runtime.js';
import { fixture } from './helpers/runtime.js';

async function open(t, settle = () => {}) {
  const f = await fixture('Original document.\n');
  const runtime = createTuiRuntime({
    host: createMemoryTerminalHost({ terminalSize: { columns: 120, rows: 32 } }),
    app: createWritingAgentTuiApp(f.application)
  });
  t.after(async () => {
    settle();
    await runtime.dispose();
    await f.close();
  });
  await runtime.start();
  await waitForState(runtime, t.signal, () => runtime.state().history.length > 0);
  return { ...f, runtime };
}

async function choose(runtime, t, id) {
  await runtime.dispatch({ type: 'picker.open', subject: 'resources' });
  await waitForState(runtime, t.signal, () => runtime.state().overlay.kind === 'picker');
  await runtime.dispatch({ type: 'picker.accept', id });
}

test(
  'unrelated feedback cannot settle a pending submission or allow duplicate input',
  { skip: process.platform !== 'linux', timeout: 20000 },
  async (t) => {
    const gate = Promise.withResolvers();
    const { application, runtime } = await open(t, () => gate.resolve());
    let calls = 0;
    application.submit = async () => {
      calls++;
      await gate.promise;
      throw new Error('Submission refused.');
    };
    await runtime.dispatch({
      type: 'composer.edit',
      transition: { kind: 'edit', operation: { kind: 'insert', text: 'Review this.' } }
    });
    await runtime.dispatch({ type: 'submit' });
    await waitForState(runtime, t.signal, () => calls === 1);
    await runtime.dispatch({ type: 'notice', message: 'Source copied.' });
    assert.equal(runtime.state().submitting, true);
    await runtime.dispatch({ type: 'submit' });
    assert.equal(calls, 1);
    gate.resolve();
    await waitForState(runtime, t.signal, () => !runtime.state().submitting);
    assert.match(runtime.state().notice, /Submission refused/);
  }
);

test(
  'closing a document open cancels its presentation even if the read settles later',
  { skip: process.platform !== 'linux', timeout: 20000 },
  async (t) => {
    const gate = Promise.withResolvers();
    let document;
    const { application, runtime } = await open(t, () => gate.resolve(document));
    document = await application.readDocument('document.txt');
    const started = Promise.withResolvers();
    application.readDocument = async () => {
      started.resolve();
      return gate.promise;
    };
    await choose(runtime, t, 'document.txt');
    await started.promise;
    await runtime.dispatch({ type: 'overlay.close' });
    gate.resolve(document);
    await waitForState(runtime, t.signal, () => runtime.metrics().effects.owned === 0);
    assert.equal(runtime.state().document, undefined);
    assert.equal(runtime.state().overlay.kind, 'none');
  }
);

for (const failure of [false, true])
  test(
    `a delayed document refresh ${failure ? 'failure' : 'result'} cannot replace a newly opened document`,
    { skip: process.platform !== 'linux', timeout: 20000 },
    async (t) => {
      const gate = Promise.withResolvers();
      let first;
      const { application, runtime, root } = await open(t, () => gate.resolve(first));
      await writeFile(path.join(root, 'second.txt'), 'Second document.\n');
      await choose(runtime, t, 'document.txt');
      await waitForState(runtime, t.signal, () => runtime.state().document !== undefined);
      const read = application.readDocument.bind(application);
      first = runtime.state().document.value;
      const started = Promise.withResolvers();
      application.readDocument = async (id) => {
        if (id === 'document.txt') {
          started.resolve();
          return gate.promise;
        }
        return read(id);
      };
      await runtime.dispatch({ type: 'document.refresh' });
      await started.promise;
      await choose(runtime, t, 'second.txt');
      await waitForState(
        runtime,
        t.signal,
        () => runtime.state().document?.value.path === 'second.txt'
      );
      if (failure) gate.reject(new Error('Old document removed.'));
      else gate.resolve(first);
      await waitForState(runtime, t.signal, () => runtime.metrics().effects.owned === 0);
      assert.equal(runtime.state().document?.value.path, 'second.txt');
      assert.equal(runtime.state().document.value.content, 'Second document.\n');
    }
  );

test(
  'switching sessions retires an in-flight document open and its loading view',
  { skip: process.platform !== 'linux', timeout: 20000 },
  async (t) => {
    const gate = Promise.withResolvers();
    let document;
    const { application, runtime } = await open(t, () => gate.resolve(document));
    document = await application.readDocument('document.txt');
    const started = Promise.withResolvers();
    application.readDocument = async () => {
      started.resolve();
      return gate.promise;
    };
    await choose(runtime, t, 'document.txt');
    await started.promise;
    await application.newSession();
    await runtime.dispatch({ type: 'application', state: application.state() });
    assert.equal(runtime.state().overlay.kind, 'none');
    gate.resolve(document);
    await waitForState(runtime, t.signal, () => runtime.metrics().effects.owned === 0);
    assert.equal(runtime.state().document, undefined);
  }
);

test(
  'a delayed receipt releases admission after switching sessions without clearing the new draft',
  { skip: process.platform !== 'linux', timeout: 20000 },
  async (t) => {
    const gate = Promise.withResolvers();
    const { application, runtime } = await open(t, () => gate.resolve());
    const original = application.submit.bind(application);
    const recorded = Promise.withResolvers();
    application.submit = async (input) => {
      const receipt = await original(input);
      await receipt.completion;
      recorded.resolve();
      await gate.promise;
      return receipt;
    };
    await runtime.dispatch({
      type: 'composer.edit',
      transition: { kind: 'edit', operation: { kind: 'insert', text: 'Review the first session.' } }
    });
    await runtime.dispatch({ type: 'submit' });
    await recorded.promise;
    const firstId = application.state().sessionId;
    await application.newSession();
    await runtime.dispatch({ type: 'refresh' });
    await waitForState(runtime, t.signal, () => runtime.state().application.sessionId !== firstId);
    await runtime.dispatch({
      type: 'composer.edit',
      transition: { kind: 'edit', operation: { kind: 'insert', text: 'New session draft.' } }
    });
    const draft = runtime.state().composer;
    gate.resolve();
    await waitForState(runtime, t.signal, () => runtime.metrics().effects.owned === 0);
    assert.equal(runtime.state().submitting, false);
    assert.equal(runtime.state().composer, draft);
    assert.equal(runtime.state().liveConversation.length, 0);
  }
);

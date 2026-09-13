import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { createCodingAgentTuiApp, runCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';
import { latestFramePlain, waitFor } from './coding-agent-tui-test-helpers.js';

test('Ctrl+P opens the concise command picker and executes a selected command', async () => {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 90, rows: 16 } });
  const run = runCodingAgentTuiApp(fakeController(), { host });

  await waitFor(() => host.frames().length > 0);
  host.input('\x10');
  await waitFor(() => /\/model/u.test(latestFramePlain(host)));
  assert.match(latestFramePlain(host), /\/provider/u);
  assert.doesNotMatch(latestFramePlain(host), /\/state\b/u);
  host.input('status\r');
  await waitFor(() => /Application status/u.test(latestFramePlain(host)));
  assert.match(latestFramePlain(host), /test-model/u);
  host.input('\x03');
  await waitFor(() => !/Application status/u.test(latestFramePlain(host)));
  host.input('/exit\r');
  const result = await run;

  assert.equal(result.exit.status, 'completed');
  assert.equal(result.exit.state.composer.submitting, false);
});

test('Escape closes the command picker without cancelling the app', async () => {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 18 } });
  const runtime = createTuiRuntime({
    app: createCodingAgentTuiApp('', { commandHandler: { execute: () => ({ message: 'done' }) } }),
    host,
    initialFocus: { kind: 'element', elementId: 'composer' }
  });
  await runtime.start();
  await runtime.handleInput(key('p', { ctrl: true }));
  assert.equal(runtime.state().overlay.kind, 'commands');
  await runtime.handleInput(key('escape'));
  assert.equal(runtime.state().overlay.kind, 'none');
  assert.ok(runtime.frame().focusPath.includes('composer'));
  assert.equal(runtime.exit(), undefined);
  await runtime.dispose();
});

test('raw command and empty-notes gestures close locally and restore the exact composer', async (t) => {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 80, rows: 24 } });
  const runtime = createTuiRuntime({
    host,
    app: createCodingAgentTuiApp('Keep this draft 文', {
      navigation: {
        async listNotes() {
          return { items: [], coverage: 'complete' };
        }
      }
    })
  });
  t.after(() => runtime.dispose());
  await runtime.start();
  const draft = runtime.state().composer.input;
  const raw = async (data) => {
    const batch = await runtime.handleInputChunk({ data });
    host.clock.advance(100);
    await batch.pending;
  };
  for (const opening of ['\x10', '\x1bn']) {
    for (const closing of [opening, '\x03', '\x1b']) {
      await raw(opening);
      assert.notEqual(runtime.state().overlay.kind, 'none');
      await raw(closing);
      assert.equal(runtime.state().overlay.kind, 'none');
      assert.equal(runtime.state().composer.input, draft);
      assert.ok(runtime.frame().focusPath.includes('composer'));
      assert.equal(runtime.exit(), undefined);
    }
  }
});

test('commands with finite domain values open a second picker and submit the exact selection', async () => {
  const submitted = [];
  const host = createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 18 } });
  const runtime = createTuiRuntime({
    app: createCodingAgentTuiApp('', {
      commandHandler: {
        execute(line) {
          submitted.push(line);
          return { message: 'selected' };
        }
      }
    }),
    host,
    initialFocus: { kind: 'element', elementId: 'composer' }
  });
  await runtime.start();
  await runtime.handleInput(key('p', { ctrl: true }));
  await runtime.handleInput({ kind: 'text', text: '/permissions', paste: false });
  await runtime.handleInput(key('enter'));
  assert.equal(runtime.state().overlay.kind, 'command_values');
  assert.equal(runtime.state().overlay.command, '/permissions');
  await runtime.handleInput({ kind: 'text', text: 'develop', paste: false });
  await runtime.handleInput(key('enter'));
  await waitFor(() => submitted.length === 1);
  assert.deepEqual(submitted, ['/permissions develop']);
  await runtime.dispose();
});

test('setup state remains usable and explains the required domain decisions', async () => {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 110, rows: 18 } });
  const controller = setupController();
  const running = runCodingAgentTuiApp(controller, { host, initialTask: 'inspect the workspace' });
  await waitFor(
    () =>
      /inspect the workspace/u.test(latestFramePlain(host)) &&
      /Setup required/u.test(latestFramePlain(host))
  );
  assert.match(latestFramePlain(host), /Set up/u);
  assert.match(latestFramePlain(host), /inspect the workspace/u);
  assert.deepEqual(controller.tasks, []);
  host.input('\x10');
  await waitFor(() => /Commands/u.test(latestFramePlain(host)));
  host.input('exit\r');
  await running;
});

test('the normal frame contains conversation, composer, and compact chrome only', async () => {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 96, rows: 18 } });
  const run = runCodingAgentTuiApp(fakeController(), { host });

  await waitFor(() => host.frames().length > 0);
  const output = latestFramePlain(host);
  assert.match(output, /Coding Agent/u);
  assert.match(output, /Send a message/u);
  assert.doesNotMatch(output, /Run activity|Work log|Inspector|Session replay/u);
  host.input('/exit\r');
  await run;
});

test('permission details remain inspectable without crowding the default status line', async () => {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 150, rows: 18 } });
  const run = runCodingAgentTuiApp(
    fakeController({
      modelId: 'test-model',
      permissions: {
        mode: 'develop',
        trust: 'restricted',
        workspaceRead: 'root_bound',
        workspaceWrite: 'structured',
        commandExecution: 'sandboxed',
        network: 'denied',
        hostEscape: 'denied',
        tools: ['read_files', 'apply_patch', 'exec_command']
      }
    }),
    { host }
  );
  await waitFor(() => host.frames().length > 0);
  const output = latestFramePlain(host);
  assert.match(output, /develop/u);
  assert.doesNotMatch(output, /driver|net\/escape|3 tools/u);
  host.input('/status\r');
  await waitFor(() => /Application status/u.test(latestFramePlain(host)));
  host.input('\x03');
  await waitFor(() => !/Application status/u.test(latestFramePlain(host)));
  host.input('/exit\r');
  await run;
});

function fakeController(runtimeDetails = { providerId: 'test', modelId: 'test-model' }) {
  const directory = mkdtempSync(path.join(tmpdir(), 'tui-controller-'));
  const session = {
    sessionId: 'test-session',
    phase: 'idle',
    configuration: {
      provider: runtimeDetails.providerId ?? 'test',
      model: runtimeDetails.modelId ?? 'test-model'
    },
    queuedInputs: 0
  };
  return {
    state() {
      return {
        status: 'ready',
        requirements: [],
        runtimeDetails,
        session
      };
    },
    subscribe() {
      return () => {};
    },
    async start() {},
    async submit() {
      throw new Error('fake controller does not execute runs');
    },
    async resolveApproval() {
      throw new Error('unexpected approval');
    },
    presentationPath: () => path.join(directory, 'preferences.json'),
    draftDirectory: () => path.join(directory, 'drafts'),
    modelSelection: () => undefined,
    async close() {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function setupController() {
  const directory = mkdtempSync(path.join(tmpdir(), 'tui-setup-'));
  const listeners = new Set();
  const state = {
    status: 'setup_required',
    requirements: ['workspace_trust', 'provider', 'model'],
    runtimeDetails: { workspaceTrust: 'untrusted' }
  };
  return {
    tasks: [],
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start() {
      for (const listener of listeners) await listener({ type: 'application.state.changed', state });
    },
    async submit(task) {
      this.tasks.push(task);
      return { kind: 'rejected', reason: 'setup_required', requirements: state.requirements };
    },
    async resolveApproval() {
      throw new Error('unexpected approval');
    },
    presentationPath: () => path.join(directory, 'preferences.json'),
    draftDirectory: () => path.join(directory, 'drafts'),
    modelSelection: () => undefined,
    async close() {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function key(name, modifiers = {}) {
  return {
    kind: 'key',
    key: name,
    eventType: 'press',
    location: 'standard',
    modifiers: { ctrl: false, alt: false, shift: false, meta: false, ...modifiers }
  };
}

test('closing a pending context inspection keeps the composer and rejects its late result', async (t) => {
  const result = Promise.withResolvers();
  const host = createMemoryTerminalHost();
  const runtime = createTuiRuntime({
    host,
    app: createCodingAgentTuiApp('Exact draft 文', {
      inspectContext: () => result.promise
    })
  });
  t.after(() => runtime.dispose());
  await runtime.start();
  const draft = runtime.state().composer.input;
  await runtime.dispatch({ type: 'context.open' });
  assert.equal(runtime.state().overlay.kind, 'context-loading');
  const requestId = runtime.state().overlay.requestId;
  await runtime.dispatch({ type: 'overlay.close' });
  result.resolve({ sources: [] });
  await runtime.dispatch({
    type: 'context.loaded',
    requestId,
    sessionId: ':new',
    content: 'Retired response'
  });
  assert.equal(runtime.state().overlay.kind, 'none');
  assert.equal(runtime.state().composer.input, draft);
  assert.ok(runtime.frame().focusPath.includes('composer'));
});

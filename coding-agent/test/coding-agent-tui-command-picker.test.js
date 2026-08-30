import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { createCodingAgentTuiApp, runCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';
import { plainOutput, waitFor } from './coding-agent-tui-test-helpers.js';

test('Ctrl+P opens the concise command picker and executes a selected command', async () => {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 90, rows: 16 } });
  const run = runCodingAgentTuiApp(fakeController(), { host });

  await waitFor(() => host.frames().length > 0);
  host.input('\x10');
  await waitFor(() => /Commands/u.test(plainOutput(host)));
  assert.match(plainOutput(host), /\/provider/u);
  assert.doesNotMatch(plainOutput(host), /\/state\b/u);
  host.input('status\r');
  await waitFor(() => /Idle · test-model/u.test(plainOutput(host)));
  host.input('/exit\r');
  const result = await run;

  assert.equal(result.exit.status, 'completed');
  assert.ok(result.exit.state.conversation.items.some((item) => item.kind === 'notice' && item.text.includes('test-model')));
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
  assert.equal(runtime.exit(), undefined);
  await runtime.dispose();
});

test('commands with finite domain values open a second picker and submit the exact selection', async () => {
  const submitted = [];
  const host = createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 18 } });
  const runtime = createTuiRuntime({
    app: createCodingAgentTuiApp('', {
      commandHandler: { execute(line) { submitted.push(line); return { message: 'selected' }; } }
    }),
    host,
    initialFocus: { kind: 'element', elementId: 'composer' }
  });
  await runtime.start();
  await runtime.handleInput(key('p', { ctrl: true }));
  await runtime.handleInput({ kind: 'text', text: '/provider', paste: false });
  await runtime.handleInput(key('enter'));
  assert.equal(runtime.state().overlay.kind, 'command_values');
  assert.equal(runtime.state().overlay.command, '/provider');
  await runtime.handleInput({ kind: 'text', text: 'openai-codex', paste: false });
  await runtime.handleInput(key('enter'));
  await waitFor(() => submitted.length === 1);
  assert.deepEqual(submitted, ['/provider openai-codex']);
  await runtime.dispose();
});

test('setup state remains usable and explains the required domain decisions', async () => {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 110, rows: 18 } });
  const controller = setupController();
  const running = runCodingAgentTuiApp(controller, { host, initialTask: 'inspect the workspace' });
  await waitFor(() => controller.tasks.length === 1 && /Setup required/u.test(plainOutput(host)));
  assert.match(plainOutput(host), /workspace trust, provider, model/u);
  assert.match(plainOutput(host), /inspect the workspace/u);
  assert.deepEqual(controller.tasks, ['inspect the workspace']);
  host.input('/exit\r');
  await running;
});

test('the normal frame contains conversation, composer, and compact chrome only', async () => {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 96, rows: 18 } });
  const run = runCodingAgentTuiApp(fakeController(), { host });

  await waitFor(() => host.frames().length > 0);
  const output = plainOutput(host);
  assert.match(output, /Coding Agent/u);
  assert.match(output, /Send a message/u);
  assert.doesNotMatch(output, /Run activity|Work log|Inspector|Session replay/u);
  host.input('/exit\r');
  await run;
});

test('TUI permission labels expose trust, structured writes, sandboxing, and denied egress', async () => {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 150, rows: 18 } });
  const run = runCodingAgentTuiApp(fakeController({
    modelId: 'test-model', permissions: {
      mode: 'develop', trust: 'restricted', workspaceRead: 'root_bound', workspaceWrite: 'structured',
      commandExecution: 'sandboxed', network: 'denied', hostEscape: 'denied', tools: ['read_files', 'apply_patch', 'exec_command']
    }
  }), { host });
  await waitFor(() => host.frames().length > 0);
  const output = plainOutput(host);
  assert.match(output, /develop\/restricted · write structured · exec sandboxed · net\/escape denied · 3 tools/u);
  host.input('/exit\r');
  await run;
});

function fakeController(runtimeDetails = { providerId: 'test', modelId: 'test-model' }) {
  const session = {
    sessionId: 'test-session', phase: 'idle',
    configuration: { provider: runtimeDetails.providerId ?? 'test', model: runtimeDetails.modelId ?? 'test-model' },
    queuedInputs: 0
  };
  return {
    state() {
      return {
        status: 'ready', requirements: [], runtimeDetails, session
      };
    },
    subscribe() { return () => {}; },
    async start() {},
    async submit() { throw new Error('fake controller does not execute runs'); },
    execute(line) {
      if (line === '/status') return { message: `Idle · ${runtimeDetails.modelId ?? 'test-model'}` };
      throw new Error(`unexpected command: ${line}`);
    },
    async resolveApproval() { throw new Error('unexpected approval'); },
    async close() {}
  };
}

function setupController() {
  const listeners = new Set();
  const state = {
    status: 'setup_required',
    requirements: ['workspace_trust', 'provider', 'model'],
    runtimeDetails: { workspaceTrust: 'untrusted' }
  };
  return {
    tasks: [],
    state: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async start() {
      for (const listener of listeners) await listener({ type: 'interactive.state.changed', state });
    },
    async submit(task) { this.tasks.push(task); return { message: 'Message retained.' }; },
    execute(line) { throw new Error(`unexpected command: ${line}`); },
    async resolveApproval() { throw new Error('unexpected approval'); },
    async close() {}
  };
}

function key(name, modifiers = {}) {
  return {
    kind: 'key', key: name, eventType: 'press', location: 'standard',
    modifiers: { ctrl: false, alt: false, shift: false, meta: false, ...modifiers }
  };
}

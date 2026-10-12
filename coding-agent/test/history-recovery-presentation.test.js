import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { runCodingRpc } from '@ismail-elkorchi/coding-agent/rpc';
import { runWritingRpc } from '@ismail-elkorchi/writing-agent/rpc';
import { createCodingAgentTuiApp, runCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';
import { createWritingAgentTuiApp, runWritingAgentTuiApp } from '@ismail-elkorchi/writing-agent/tui';
import { applicationEventSource } from '@agent-core/tui';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';

for (const [agent, runTui, runRpc] of [
  ['coding', runCodingAgentTuiApp, runCodingRpc],
  ['writing', runWritingAgentTuiApp, runWritingRpc]
]) {
  for (const [action, columns] of [['escape', 48], ['escape', 130], ['close', 130]]) {
    test(`${agent} TUI shows startup recovery at ${columns} columns before a model exists and ${action} cancels it`, { timeout: 10_000 }, async (t) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'history-recovery-tui-'));
      const application = recoveringApplication(agent, directory);
      const host = createMemoryTerminalHost({ terminalSize: { columns, rows: 24 } });
      const running = runTui(application, { host });
      t.after(async () => {
        host.endInput();
        await running;
        await rm(directory, { recursive: true, force: true });
      });
      const frame = () => {
        const latest = host.frames().at(-1);
        return latest === undefined ? '' : renderFramePlain(latest);
      };
      await until(() => /Restoring history index|History recovery/u.test(frame()), t.signal);
      assert.equal(application.startCalls, 1);
      assert.match(frame(), /Esc stop/u);
      await application.emit({ type: 'history.recovery', progress: {
        phase: 'progress', sessionId: 'recovering', records: 40, bytes: 512, totalBytes: 2048
      } });
      await until(() => columns < 90 ? /40 records/u.test(frame()) : /40 records, 512\/2048 bytes/u.test(frame()), t.signal);
      assert.match(frame(), /Esc stop/u);
      if (action === 'escape') {
        host.input('Keep this draft');
        await until(() => /Keep this draft/u.test(frame()), t.signal);
        host.input('\x1b');
        // A standalone Escape is resolved after the input decoder's ambiguity window.
        await setTimeout(10);
        host.clock.advance(100);
        await until(() => application.cancelled, t.signal);
        await until(() => !/Esc stop/u.test(frame()), t.signal);
        assert.match(frame(), /Keep this draft/u);
        assert.equal(application.closed, false);
        assert.equal(application.abortCalls, 1);
        host.input('\x10');
        await until(() => /Commands/u.test(frame()), t.signal);
        host.input('exit\r');
      } else {
        host.input('\x04');
      }
      await running;
      assert.equal(application.cancelled, true);
      assert.equal(application.closed, true);
    });
  }

  for (const columns of [48, 130]) {
    test(`${agent} keeps unavailable sessions visible through later recoveries at ${columns} columns`, { timeout: 10_000 }, async (t) => {
      const application = recoveringApplication(agent, '/unused');
      const idleEvents = applicationEventSource('idle-test-events', {
        subscribe: () => () => {}, replacementKey: () => undefined,
        failureMessage: (message) => ({ type: 'notice', message })
      });
      const runtime = createTuiRuntime({
        host: createMemoryTerminalHost({ terminalSize: { columns, rows: 24 } }),
        app: agent === 'coding'
          ? createCodingAgentTuiApp('')
          : createWritingAgentTuiApp(application, { events: idleEvents })
      });
      t.after(() => runtime.dispose());
      await runtime.start();
      const progress = (value) => runtime.dispatch({ type: 'history.recovery', progress: value });
      const frame = () => renderFramePlain(runtime.frame());
      const failure = { phase: 'failed', sessionId: 'bad', message: 'Original history is invalid.' };
      await progress(failure);
      assert.match(frame(), /Unavailable session "bad"/u);
      assert.ok(runtime.frame().focusPath.includes(agent === 'coding' ? 'composer' : 'writing-composer'));
      for (let index = 0; index < 6; index++) {
        const sessionId = `healthy-${index}`;
        await progress({ phase: 'started', sessionId, totalBytes: 100 });
        assert.match(frame(), /Unavailable session "bad"/u);
        await progress({ phase: 'completed', sessionId, records: 3, bytes: 100, totalBytes: 100 });
        assert.match(frame(), /Unavailable session "bad"/u);
      }
      await progress(failure);
      assert.equal((frame().match(/Unavailable session "bad"/gu) ?? []).length, 1);
      if (agent === 'coding')
        assert.equal(runtime.state().conversation.items.filter((item) => item.kind === 'notice' && item.text.includes(failure.message)).length, 0);
      else {
        await runtime.dispatch({ type: 'notice.dismiss' });
        assert.match(frame(), /Unavailable session "bad"/u);
      }
      const state = { ...application.state(), historyRecoveryFailures: { bad: failure.message, other: 'Another invalid original.' } };
      await runtime.dispatch(agent === 'coding'
        ? { type: 'application.state.changed', state }
        : { type: 'application', state });
      await progress({ phase: 'completed', sessionId: 'bad', records: 3, bytes: 100, totalBytes: 100 });
      assert.doesNotMatch(frame(), /Unavailable session "bad"/u);
      assert.match(frame(), /Unavailable session "other"/u);
      // A fresh authoritative listing can remove a session that no longer exists.
      await runtime.dispatch(agent === 'coding'
        ? { type: 'application.state.changed', state: application.state() }
        : { type: 'application', state: application.state() });
      assert.doesNotMatch(frame(), /Unavailable session/u);
    });
  }

  for (const action of ['shutdown', 'EOF']) {
    test(`${agent} RPC reports recovery and ${action} cancels startup without activating a session`, { timeout: 10_000 }, async (t) => {
      const application = recoveringApplication(agent, '/unused');
      const input = new PassThrough();
      const output = new PassThrough();
      const diagnostics = [];
      let delivered = '';
      output.on('data', (chunk) => { delivered += chunk.toString(); });
      const running = runRpc(application, { input, output, diagnostic: (message) => diagnostics.push(message) });
      t.after(async () => { input.end(); await running; output.destroy(); });
      await until(() => delivered.includes('history.recovery'), t.signal);
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'read', method: 'session.read' })}\n`);
      if (action === 'shutdown')
        input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'stop', method: 'application.shutdown' })}\n`);
      else input.end();
      await running;
      assert.equal(application.cancelled, true);
      assert.equal(application.closed, true);
      assert.equal(application.reads, 0);
      assert.equal(application.listeners.size, 0);
      const frames = delivered.trim().split('\n').map((line) => JSON.parse(line));
      assert.ok(frames.some((frame) => frame.method === 'history.recovery' && frame.params.progress.phase === 'cancelled'));
      if (action === 'shutdown') assert.ok(frames.some((frame) => frame.id === 'stop' && frame.result === null));
      assert.deepEqual(diagnostics, []);
    });
  }
}

function recoveringApplication(agent, directory) {
  const pending = Promise.withResolvers();
  const application = {
    listeners: new Set(),
    cancelled: false,
    closed: false,
    startCalls: 0,
    abortCalls: 0,
    reads: 0,
    state: () => agent === 'coding'
      ? { status: 'initializing', runtimeDetails: {}, requirements: [] }
      : { workspace: directory, mode: 'edit', status: 'configuration_required' },
    presentationPath: () => path.join(directory, 'presentation.json'),
    draftDirectory: () => path.join(directory, 'drafts'),
    modelSelection: () => undefined,
    subscribe(listener) {
      application.listeners.add(listener);
      return () => application.listeners.delete(listener);
    },
    async emit(event) {
      await Promise.all([...application.listeners].map((listener) => listener(event)));
    },
    async start() {
      application.startCalls++;
      assert.ok(application.listeners.size > 0, 'startup must begin after subscribing');
      await application.emit({ type: 'history.recovery', progress: { phase: 'started', sessionId: 'recovering', totalBytes: 2048 } });
      await pending.promise;
    },
    async readSession() {
      application.reads++;
      throw new Error('Session must not activate during recovery.');
    },
    async abort() {
      application.abortCalls++;
      if (application.cancelled) return false;
      application.cancelled = true;
      await application.emit({ type: 'history.recovery', progress: {
        phase: 'cancelled', sessionId: 'recovering', message: 'History index recovery cancelled.'
      } });
      pending.reject(new DOMException('History index recovery cancelled.', 'AbortError'));
      return true;
    },
    async close() {
      if (application.closed) return;
      application.closed = true;
      await application.abort();
    }
  };
  return application;
}

async function until(condition, signal) {
  while (!condition()) await setTimeout(5, undefined, { signal });
}

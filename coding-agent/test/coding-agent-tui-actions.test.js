import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { createTuiRuntime, runTui } from '@ismail-elkorchi/terminal-ui/tui';
import { createCodingAgentTuiApp, parseInteractiveCommandLine } from '@ismail-elkorchi/coding-agent/tui';
import { waitFor } from './coding-agent-tui-test-helpers.js';

const key = (name, modifiers = {}) => ({
  kind: 'key',
  key: name,
  eventType: 'press',
  location: 'standard',
  modifiers: { ctrl: false, alt: false, shift: false, meta: false, ...modifiers }
});
const draft = (runtime) => textDocumentText(runtime.state().composer.input.document);

async function open(t, options) {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 80, rows: 24 } });
  const runtime = createTuiRuntime({
    host,
    app: createCodingAgentTuiApp('', options),
    initialFocus: { kind: 'element', elementId: 'composer' }
  });
  t.after(() => runtime.dispose());
  await runtime.start();
  return { host, runtime };
}

test('rejected input remains editable and never becomes an accepted conversation entry', async (t) => {
  const { runtime } = await open(t, {
    commandHandler: {
      execute() {
        throw new Error('Setup incomplete');
      }
    }
  });
  assert.match(renderFramePlain(runtime.frame()), /Enter send.*Ctrl\+P commands.*F1 help/);
  await runtime.handleInput({ kind: 'paste', text: 'Keep this\nexact draft', bracketed: true });
  await runtime.handleInput(key('enter'));
  await waitFor(() => !runtime.state().composer.submitting);
  assert.equal(draft(runtime), 'Keep this\nexact draft');
  assert.equal(
    runtime.state().conversation.items.some((entry) => entry.kind === 'user'),
    false
  );
});

test('direct steering preserves multiline content and records the durable acceptance once', async (t) => {
  const calls = [];
  const { runtime } = await open(t, {
    commandHandler: {
      execute(line) {
        calls.push(line);
        const parsed = parseInteractiveCommandLine(line);
        return {
          message: 'Steering accepted.',
          submission: {
            text: parsed.value,
            acceptance: {
              kind: 'steered',
              submissionId: 'accepted',
              runId: 'active',
              completion: Promise.resolve()
            }
          }
        };
      }
    }
  });
  await runtime.handleInput({
    kind: 'paste',
    text: 'Use this instead:\n  const value = 2;',
    bracketed: true
  });
  await runtime.handleInput(key('enter', { alt: true }));
  await waitFor(() => !runtime.state().composer.submitting);
  assert.equal(calls[0], '/steer Use this instead:\n  const value = 2;');
  assert.equal(draft(runtime), '');
  assert.equal(
    runtime.state().conversation.items.filter((entry) => entry.id === 'steering:accepted').length,
    1
  );
});

test('external editing restores ownership and returns its draft to the composer', async (t) => {
  let editorCalls = 0;
  const host = createMemoryTerminalHost({ terminalSize: { columns: 80, rows: 24 } });
  const running = runTui(
    createCodingAgentTuiApp('', {
      externalEditor: async (text) => {
        editorCalls++;
        return `${text}\nEdited externally`;
      },
      commandHandler: {
        execute() {
          return { message: 'Exit', exit: true };
        }
      }
    }),
    { host }
  );
  t.after(() => host.endInput());
  await waitFor(() => host.frames().length > 0);
  host.input('Draft\x1bOS');
  await waitFor(() => host.output().includes('Edited externally'));
  assert.equal(editorCalls, 1);
  host.input(' continued\x10');
  await waitFor(() => host.output().includes('Commands'));
  host.input('exit\r');
  const exit = await running;
  assert.equal(textDocumentText(exit.state.composer.input.document), 'Draft\nEdited externally continued');
  assert(host.restores().length > 0);
});

test('workspace completion inserts an authorized path without replacing surrounding text', async (t) => {
  const calls = [];
  const { runtime } = await open(t, {
    listFiles: async (...args) => {
      calls.push(args);
      return [{ path: 'src/main.ts', kind: 'file' }];
    }
  });
  await runtime.handleInput({ kind: 'text', text: 'Inspect @src/ma', paste: false });
  await runtime.handleInput(key('space', { ctrl: true }));
  await waitFor(() => runtime.state().overlay.kind === 'files');
  await runtime.handleInput(key('enter'));
  assert.deepEqual(calls, [['src', 'ma']]);
  assert.equal(draft(runtime), 'Inspect @src/main.ts ');
});

test('palette commands and interrupted setup commands preserve the instruction draft', async (t) => {
  const { runtime } = await open(t, {
    commandHandler: {
      execute() {
        return { message: 'Idle' };
      }
    }
  });
  await runtime.handleInput({ kind: 'text', text: 'My instruction', paste: false });
  await runtime.handleInput(key('p', { ctrl: true }));
  await runtime.dispatch({ type: 'commands.accept', event: { id: '/status' } });
  await waitFor(() => runtime.state().overlay.kind === 'none');
  assert.equal(draft(runtime), 'My instruction');
  await runtime.handleInput(key('p', { ctrl: true }));
  await runtime.dispatch({ type: 'commands.accept', event: { id: '/model' } });
  assert.equal(draft(runtime), '/model ');
  await runtime.handleInput(key('escape'));
  assert.equal(draft(runtime), 'My instruction');
});

test('keyboard source selection copies Unicode exactly and reports source-changing clipboard normalization', async (t) => {
  const { host, runtime } = await open(t, {});
  const source = '# Source\n\nUnicode 文 👩🏽‍💻\n';
  await runtime.dispatch({ type: 'panel.source-loaded', title: 'Original source', content: source });
  await runtime.handleInput(key('a', { ctrl: true }));
  await runtime.handleInput(key('c', { ctrl: true }));
  await waitFor(() => runtime.state().overlay.notice === 'Source sent to clipboard.');
  assert(host.output().includes(`\x1b]52;c;${Buffer.from(source).toString('base64')}\x07`));
  const exact = '\tIndented\r\n';
  await runtime.dispatch({ type: 'panel.source-loaded', title: 'Original source', content: exact });
  await runtime.handleInput(key('a', { ctrl: true }));
  await runtime.handleInput(key('c', { ctrl: true }));
  await waitFor(() => runtime.state().overlay.notice?.includes('Exact copy is unavailable'));
  assert.equal(textDocumentText(runtime.state().overlay.input.document), exact);
});

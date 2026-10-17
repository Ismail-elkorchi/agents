import test from 'node:test';
import assert from 'node:assert/strict';
import { execCommandTool } from '@agent-core/tools-local';
import { checkedCommandScript } from './fixtures/checked-command-script.js';
import { scriptedOllama, toolResponse } from './fixtures/scripted-cli.js';

function processMessage(toolName, facts) {
  const combined = { segments: ['isolated\n'], observedBytes: 9, capturedBytes: 9,
    omittedBytes: 0, startsAtOutputStart: true, endsAtOutputEnd: true };
  const content = execCommandTool.buildModelContent({ observation: {
    kind: 'result', execution: { state: 'settled' }, scope: { coverage: 'complete' },
    output: { processId: 'process-1', cursorStart: 0, cursorEnd: 9, combined, ...facts }
  } }).map(item => item.text).join('\n\n');
  // Ollama's toOllamaMessage maps the canonical toolName to this wire field.
  return { role: 'tool', tool_name: toolName, content };
}

test('scripted evaluator consumes actual process presentation and waits for finalization', async t => {
  const patch = toolResponse('apply_patch', { patch: 'test patch' });
  const provider = await scriptedOllama(checkedCommandScript('echo isolated', /isolated/u, patch));
  t.after(() => provider.close());
  const chat = async message => {
    const response = await fetch(`${provider.endpoint}/api/chat`, { method: 'POST',
      body: JSON.stringify({ messages: [message] }) });
    assert.equal(response.status, 200, await response.clone().text());
    return JSON.parse((await response.text()).trim());
  };
  assert.equal((await chat({ role: 'user', content: 'Run command' })).message.tool_calls[0].function.name, 'exec_command');
  for (const facts of [{ status: 'running' }, { status: 'exited', exitCode: 0, finalizationPending: true }]) {
    const message = processMessage('write_stdin', facts);
    assert.equal(JSON.parse(message.content.split('\n\n')[0]).combined, undefined);
    const response = await chat(message);
    assert.deepEqual(response.message.tool_calls[0].function, { name: 'write_stdin',
      arguments: { processId: 'process-1', afterCursor: 0, yieldMs: 1000 } });
  }
  assert.deepEqual(await chat(processMessage('write_stdin', { status: 'exited', exitCode: 0 })), patch);
  assert.equal((await chat({ role: 'tool', tool_name: 'apply_patch', content: 'applied' })).message.content, 'Done');
});

test('scripted evaluator refuses failed, partial, or missing expected command output', () => {
  const next = checkedCommandScript('echo isolated', /isolated/u, toolResponse('apply_patch', {}))[1];
  for (const facts of [{ status: 'exited', exitCode: 1 }, { status: 'timed_out' },
    { status: 'exited', exitCode: 0, combined: { segments: ['isolated'], observedBytes: 9,
      capturedBytes: 8, omittedBytes: 1, startsAtOutputStart: true, endsAtOutputEnd: true } },
    { status: 'exited', exitCode: 0, combined: { segments: ['wrong'], observedBytes: 5,
      capturedBytes: 5, omittedBytes: 0, startsAtOutputStart: true, endsAtOutputEnd: true } }])
    assert.throws(() => next({ messages: [processMessage('exec_command', facts)] }));
});

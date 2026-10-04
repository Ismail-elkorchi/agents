import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openCodingApplication, loadWorkspace } from '@ismail-elkorchi/coding-agent';
import { JsonlEventRepository } from '@agent-core/persistence/node';
import { agentEventCodec } from '@agent-core/runtime';
import {
  createWorkspace,
  finalResponse,
  scriptedOllama,
  toolResponse,
  trust
} from './fixtures/scripted-cli.js';

for (const action of ['poll', 'stop', 'settle'])
  test(
    `a running host process allows ${action} and subsequent workspace access`,
    {
      skip: process.platform !== 'linux',
      timeout: 30_000
    },
    async (t) => {
      const command =
        action === 'poll'
          ? `node -e 'process.stdin.once("data", data => require("node:fs").writeFileSync("sentinel.txt", data))'`
          : action === 'stop'
            ? `node -e 'setInterval(() => {}, 1000)'`
            : `node -e 'const fs=require("node:fs"); const timer=setInterval(()=>{if(fs.existsSync("finish")){clearInterval(timer);console.log("finished")}},25)'`;
      let sawRunning = false;
      let polls = 0;
      const readWorkspace = () =>
        toolResponse('read_files', {
          files: [{ path: 'sentinel.txt', startLine: 1, lineCount: 1 }]
        });
      const next = async (request) => {
        if (request.messages.at(-1).tool_name === 'read_files')
          return finalResponse('Process control completed.');
        const result = JSON.parse(request.messages.at(-1).content.split('\n\n', 1)[0]);
        if (result.status !== 'running') return readWorkspace();
        sawRunning = true;
        if (action === 'settle') {
          await writeFile(path.join(fixture.root, 'finish'), 'finish');
          return readWorkspace();
        }
        if (action === 'stop') return toolResponse('stop_process', { processId: result.processId });
        const poll = toolResponse('write_stdin', {
          processId: result.processId,
          yieldMs: 1000,
          afterCursor: 0,
          ...(polls++ === 0 ? { text: 'finish\n', closeStdin: true } : {})
        });
        return poll;
      };
      const provider = await scriptedOllama([
        toolResponse('exec_command', { command, workdir: '.', background: true, timeoutMs: 20_000 }),
        ...Array.from({ length: 8 }, () => next)
      ]);
      const fixture = await createWorkspace({
        endpoint: provider.endpoint,
        tools: ['exec_command', 'write_stdin', 'stop_process', 'read_files'],
        checks: [],
        files: { 'sentinel.txt': 'Workspace remains accessible.\n' }
      });
      let application;
      t.after(async () => {
        await application?.close();
        await provider.close();
        await fixture.close();
      });
      await trust(fixture);
      application = await openCodingApplication(
        {
          root: fixture.root,
          stateRoot: fixture.stateRoot,
          providerEndpoint: provider.endpoint,
          permissionMode: 'full_host'
        }
      );
      await application.start();
      const submitted = await application.submit({ task: `Start the process and ${action} it.` });
      assert.equal(submitted.kind, 'started');
      const abort = () => void application.abort('Process control deadline.', submitted.runId);
      t.signal.addEventListener('abort', abort, { once: true });
      let completed;
      try {
        completed = await submitted.completion;
      } finally {
        t.signal.removeEventListener('abort', abort);
      }
      assert.equal(
        completed.state,
        'ended',
        JSON.stringify(provider.chatRequests.at(-1).messages.at(-1))
      );
      assert.equal(
        completed.terminal.executionStatus,
        'completed',
        JSON.stringify(completed.terminal)
      );
      assert(sawRunning, 'The test must exercise a transferred lease.');
      const { history } = await application.readSession();
      const observations = history.entries.filter((entry) => entry.type === 'observation');
      assert(
        observations.some((entry) => entry.toolName === 'read_files' && entry.kind === 'result')
      );
      if (action === 'settle') return;
      const result = observations.filter((entry) => entry.toolName !== 'read_files').at(-1).output;
      assert.equal(result.status, action === 'poll' ? 'exited' : 'stopped');
      if (action === 'poll') {
        assert.equal(result.exitCode, 0);
        assert.equal(await readFile(path.join(fixture.root, 'sentinel.txt'), 'utf8'), 'finish\n');
      }
    }
  );

test(
  'foreground host commands report completion and deadlines without process-control turns',
  { skip: process.platform !== 'linux', timeout: 45_000 },
  async (t) => {
    const provider = await scriptedOllama([
      toolResponse('exec_command', {
        command: 'printf first; sleep 1; printf last',
        timeoutMs: 20_000
      }),
      toolResponse('exec_command', { command: 'sleep 2', timeoutMs: 500 }),
      finalResponse('The command timed out.')
    ]);
    const fixture = await createWorkspace({
      endpoint: provider.endpoint,
      tools: ['exec_command'],
      checks: [],
      files: {}
    });
    let application;
    t.after(async () => {
      await application?.close();
      await provider.close();
      await fixture.close();
    });
    await trust(fixture);
    application = await openCodingApplication(
      {
        root: fixture.root,
        stateRoot: fixture.stateRoot,
        providerEndpoint: provider.endpoint,
        permissionMode: 'full_host'
      }
    );
    await application.start();
    const submitted = await application.submit({ task: 'Run both commands and report their outcomes.' });
    assert.equal(submitted.kind, 'started');
    const completed = await submitted.completion;
    assert.equal(completed.state, 'ended');
    const { history } = await application.readSession();
    const commands = history.entries.filter(
      (entry) => entry.type === 'observation' && entry.toolName === 'exec_command'
    );
    assert.equal(commands.length, 2);
    assert.equal(commands[0].output.status, 'exited');
    assert.match(commands[0].output.combined.segments.join(''), /firstlast/u);
    assert.equal(commands[1].output.status, 'timed_out');
  }
);

for (const background of [false, true]) test(`closing a local session durably acknowledges its ${background ? 'background' : 'foreground'} command`, { skip: process.platform !== 'linux' }, async (t) => {
  const provider = await scriptedOllama([
    toolResponse('exec_command', { command: background ? 'sleep 30' : 'printf done', background }),
    finalResponse('Command started.')
  ]);
  const fixture = await createWorkspace({ endpoint: provider.endpoint, tools: ['exec_command'], checks: [] });
  let application;
  t.after(async () => { try { await application?.close(); } finally { await provider.close(); await fixture.close(); } });
  await trust(fixture);
  application = await openCodingApplication({ root: fixture.root, stateRoot: fixture.stateRoot,
    providerEndpoint: provider.endpoint, permissionMode: 'full_host' });
  await application.start();
  const submitted = await application.submit({ task: 'Run the command.' });
  assert.equal(submitted.kind, 'started');
  assert.equal((await submitted.completion).state, 'ended');
  await application.close();
  const layout = await loadWorkspace(fixture.root, { stateRoot: fixture.stateRoot });
  assert((await readdir(path.join(layout.runtimeDir, 'host-processes'))).every(name => name.endsWith('.terminal.json')));
  const events = new JsonlEventRepository({ rootDir: layout.runsDir, codec: agentEventCodec });
  const released = [];
  for await (const { event } of events.read(submitted.runId)) if (event.type === 'resource.released') released.push(event);
  assert.equal(released.length, 1);
  assert.equal(released[0].outcome, 'released');
  assert.equal(released[0].details.status, background ? 'stopped' : 'exited');
});

test('a refused process lookup is recorded and the coding session continues', { skip: process.platform !== 'linux' }, async (t) => {
  const provider = await scriptedOllama([
    toolResponse('stop_process', { processId: 'missing-process' }),
    finalResponse('The process is unavailable; work can continue.')
  ]);
  const fixture = await createWorkspace({ endpoint: provider.endpoint, tools: ['stop_process'], checks: [] });
  let application;
  t.after(async () => { await application?.close(); await provider.close(); await fixture.close(); });
  await trust(fixture);
  application = await openCodingApplication({ root: fixture.root, stateRoot: fixture.stateRoot,
    providerEndpoint: provider.endpoint, permissionMode: 'full_host' });
  await application.start();
  const submitted = await application.submit({ task: 'Stop the missing process and continue.' });
  assert.equal(submitted.kind, 'started');
  const result = await submitted.completion;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  const view = await application.readSession();
  const failure = view.history.entries.find(entry => entry.type === 'observation' && entry.toolName === 'stop_process');
  assert.equal(failure.kind, 'failure');
  assert.equal(failure.output.details.cause, 'not_found');
  const layout = await loadWorkspace(fixture.root, { stateRoot: fixture.stateRoot });
  const events = new JsonlEventRepository({ rootDir: layout.runsDir, codec: agentEventCodec });
  for await (const { event } of events.read(submitted.runId))
    if (event.type === 'tool.ended' && event.toolName === 'stop_process')
      assert.equal(event.observation.execution.state, 'not_started');
});

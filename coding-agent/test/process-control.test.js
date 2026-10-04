import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openCodingApplication, loadWorkspace } from '@ismail-elkorchi/coding-agent';
import { Sandsurf } from 'sandsurf';
import { JsonlEventRepository } from '@agent-core/persistence/node';
import { agentEventCodec } from '@agent-core/runtime';
import {
  createWorkspace,
  finalResponse,
  scriptedOllama,
  toolResponse,
  trust
} from './fixtures/scripted-cli.js';
import { createTestCodingEnvironment, withTestCodingEnvironment } from './fixtures/test-environment.js';

for (const action of ['poll', 'stop', 'settle'])
  test(
    `a running sandbox process allows ${action} and subsequent workspace access`,
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
        withTestCodingEnvironment({
          root: fixture.root,
          stateRoot: fixture.stateRoot,
          providerEndpoint: provider.endpoint,
          permissionMode: 'sandbox'
        })
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
  'foreground sandbox commands report completion and deadlines without process-control turns',
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
      withTestCodingEnvironment({
        root: fixture.root,
        stateRoot: fixture.stateRoot,
        providerEndpoint: provider.endpoint,
        permissionMode: 'sandbox'
      })
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

test(
  'session jobs stop on close and retain their original owner and evidence after restart',
  { skip: process.env.SANDSURF_KVM_TEST !== '1', timeout: 1_200_000 },
  async (t) => {
    const provider = await scriptedOllama([
      toolResponse('exec_command', {
        command: `while IFS= read -r line; do printf '%s\\n' "$line"; done`,
        background: true,
        timeoutMs: 35000
      }),
      finalResponse('The command is still available.')
    ]);
    const fixture = await createWorkspace({
      endpoint: provider.endpoint,
      tools: ['exec_command', 'write_stdin', 'stop_process'],
      checks: [],
      files: {}
    });
    let application;
    let target;
    t.after(async () => {
      if (application && target)
        await application.controlProcess(target, { kind: 'terminate' }).catch(() => undefined);
      await application?.close();
      await provider.close();
      const layout = await loadWorkspace(fixture.root, { stateRoot: fixture.stateRoot });
      const cleanup = await Sandsurf.open({
        directory: path.join(layout.runtimeDir, 'sandsurf', 'host'),
        authorizer: (change) => change.kind === 'lifecycle'
      });
      try {
        for (const sandbox of await cleanup.sandboxes.list()) await sandbox.destroy();
      } finally {
        await cleanup.close();
      }
      await fixture.close();
    });
    await trust(fixture);
    const options = {
      root: fixture.root,
      stateRoot: fixture.stateRoot,
      providerEndpoint: provider.endpoint,
      permissionMode: 'sandbox'
    };
    application = await openCodingApplication(options);
    await application.start();
    const submitted = await application.submit({ task: 'Start a continuing command.' });
    assert.equal(submitted.kind, 'started');
    const completed = await submitted.completion;
    assert.equal(completed.terminal?.executionStatus, 'completed', JSON.stringify(completed));
    [target] = await application.listProcesses();
    assert.equal(target.status, 'running');
    assert.equal(
      (await application.controlProcess(target, { kind: 'input', text: 'before restart\n' }))
        .status,
      'running'
    );
    await application.close();
    application = await openCodingApplication({
      ...options,
      sessionSelection: { kind: 'existing', id: target.sessionId }
    });
    await application.start();
    const [restored] = await application.listProcesses();
    assert.equal(restored.processId, target.processId);
    assert.deepEqual(restored.owner, target.owner);
    assert.equal(restored.status, 'stopped');
    target = restored;
    await assert.rejects(application.controlProcess(target, { kind: 'input', text: 'after restart\n' }));
    const result = await application.controlProcess(target, { kind: 'inspect', afterCursor: 0 });
    assert.equal(result.status, 'stopped');
    assert.match(result.stdout.segments.join(''), /before restart\n/);
    assert.equal(provider.chatRequests.length, 2);
  }
);


for (const background of [false, true]) test(`closing a local session durably acknowledges its ${background ? 'background' : 'foreground'} command`, async (t) => {
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
  assert.deepEqual(await readdir(path.join(layout.runtimeDir, 'host-processes')), []);
  const events = new JsonlEventRepository({ rootDir: layout.runsDir, codec: agentEventCodec });
  const released = [];
  for await (const { event } of events.read(submitted.runId)) if (event.type === 'resource.released') released.push(event);
  assert.equal(released.length, 1);
  assert.equal(released[0].outcome, 'released');
  assert.equal(released[0].details.status, background ? 'stopped' : 'exited');
});

test('reopening after a committed terminal handoff acknowledges retained evidence without rewriting settlement', async (t) => {
  const provider = await scriptedOllama([
    toolResponse('exec_command', { command: 'printf original' }), finalResponse('Done.')
  ]);
  const fixture = await createWorkspace({ endpoint: provider.endpoint, tools: ['exec_command'], checks: [] });
  let application;
  let sessionId;
  let ledgerDirectory;
  t.after(async () => { try { await application?.close(); } finally { await provider.close(); await fixture.close(); } });
  await trust(fixture);
  const options = { root: fixture.root, stateRoot: fixture.stateRoot, providerEndpoint: provider.endpoint,
    permissionMode: 'sandbox' };
  application = await openCodingApplication({ ...options, async environmentFactory(input) {
    ledgerDirectory = path.join(input.repositoryDirectory, 'test-command-ledger');
    const environment = await createTestCodingEnvironment(input);
    environment.commandExecution.acknowledgeTerminalReport = async () => { throw new Error('Crash before acknowledgement'); };
    return environment;
  } });
  await application.start();
  const submitted = await application.submit({ task: 'Run the command.' });
  assert.equal(submitted.kind, 'started');
  assert.equal((await submitted.completion).state, 'ended');
  sessionId = application.state().session.sessionId;
  await assert.rejects(application.close(), (error) =>
    error instanceof AggregateError && error.errors.some((cause) => cause.message === 'Crash before acknowledgement'));
  assert((await readdir(ledgerDirectory)).some((name) => /^proc_[a-f0-9-]+\.json$/u.test(name)));
  application = await openCodingApplication(withTestCodingEnvironment({ ...options,
    sessionSelection: { kind: 'existing', id: sessionId } }));
  await application.start();
  await application.close();
  assert.deepEqual(await readdir(ledgerDirectory), []);
  const layout = await loadWorkspace(fixture.root, { stateRoot: fixture.stateRoot });
  const events = new JsonlEventRepository({ rootDir: layout.runsDir, codec: agentEventCodec });
  let released = 0;
  for await (const { event } of events.read(submitted.runId)) if (event.type === 'resource.released') released++;
  assert.equal(released, 1);
});

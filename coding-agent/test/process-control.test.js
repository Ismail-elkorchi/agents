import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openCodingApplication, loadWorkspace } from '@ismail-elkorchi/coding-agent';
import { Sandsurf } from 'sandsurf';
import {
  createWorkspace,
  finalResponse,
  scriptedOllama,
  toolResponse,
  trust
} from './fixtures/scripted-cli.js';
import { withTestCodingEnvironment } from './fixtures/test-environment.js';

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
        toolResponse('exec_command', { command, workdir: '.', yieldMs: 0, timeoutMs: 20_000 }),
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
          permissionMode: 'develop'
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
  'session command controls remain available while idle and after restart before a prompt',
  { skip: process.env.SANDSURF_KVM_TEST !== '1', timeout: 1_200_000 },
  async (t) => {
    const provider = await scriptedOllama([
      toolResponse('exec_command', {
        command: `while IFS= read -r line; do printf '%s\\n' "$line"; done`,
        yieldMs: 0,
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
      permissionMode: 'develop'
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
    assert.equal(restored.status, 'running');
    target = restored;
    await application.controlProcess(target, { kind: 'input', text: 'after restart\n' });
    await application.controlProcess(target, { kind: 'close-input' });
    let result;
    for (let attempt = 0; attempt < 40; attempt++) {
      result = await application.controlProcess(target, { kind: 'inspect', afterCursor: 0 });
      if (result.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(result.status, 'exited');
    assert.match(result.stdout.text, /before restart\nafter restart\n/);
    assert.equal(provider.chatRequests.length, 2);
  }
);

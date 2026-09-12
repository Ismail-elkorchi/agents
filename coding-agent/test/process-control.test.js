import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openCodingApplication } from '@ismail-elkorchi/coding-agent';
import { createWorkspace, finalResponse, scriptedOllama, toolResponse, trust } from './fixtures/scripted-cli.js';

for (const action of ['poll', 'stop', 'settle']) test(`a running sandbox process allows ${action} and subsequent workspace access`, {
  skip: process.platform !== 'linux', timeout: 30_000
}, async (t) => {
  const command = action === 'poll'
    ? `node -e 'process.stdin.once("data", data => require("node:fs").writeFileSync("sentinel.txt", data))'`
    : action === 'stop'
      ? `node -e 'setInterval(() => {}, 1000)'`
      : `node -e 'const fs=require("node:fs"); const timer=setInterval(()=>{if(fs.existsSync("finish")){clearInterval(timer);console.log("finished")}},25)'`;
  let sawRunning = false;
  let polls = 0;
  const readWorkspace = () => toolResponse('read_files', {
    files: [{ path: 'sentinel.txt', startLine: 1, lineCount: 1 }]
  });
  const next = async (request) => {
    if (request.messages.at(-1).tool_name === 'read_files') return finalResponse('Process control completed.');
    const observation = JSON.parse(request.messages.at(-1).content);
    const result = observation.results;
    assert(result, JSON.stringify(observation));
    if (result.status !== 'running') return readWorkspace();
    sawRunning = true;
    if (action === 'settle') {
      await writeFile(path.join(fixture.root, 'finish'), 'finish');
      return readWorkspace();
    }
    if (action === 'stop') return toolResponse('stop_process', { processId: result.processId });
    const poll = toolResponse('write_stdin', {
      processId: result.processId, yieldMs: 1000, afterCursor: 0,
      ...(polls++ === 0 ? { text: 'finish\n', closeStdin: true } : {})
    });
    return poll;
  };
  const provider = await scriptedOllama([
    toolResponse('exec_command', { command, workdir: '.', yieldMs: 0, timeoutMs: 20_000 }),
    ...Array.from({ length: 8 }, () => next)
  ]);
  const fixture = await createWorkspace({
    endpoint: provider.endpoint, tools: ['exec_command', 'write_stdin', 'stop_process', 'read_files'],
    checks: [], files: { 'sentinel.txt': 'Workspace remains accessible.\n' }
  });
  let application;
  t.after(async () => {
    await application?.close();
    await provider.close();
    await fixture.close();
  });
  await trust(fixture);
  application = await openCodingApplication({
    root: fixture.root, stateRoot: fixture.stateRoot, providerEndpoint: provider.endpoint, permissionMode: 'develop'
  });
  await application.start();
  const submitted = await application.submit({ task: `Start the process and ${action} it.` });
  assert.equal(submitted.kind, 'started');
  const abort = () => void application.abort('Process control deadline.', submitted.runId);
  t.signal.addEventListener('abort', abort, { once: true });
  let completed;
  try { completed = await submitted.completion; }
  finally { t.signal.removeEventListener('abort', abort); }
  assert.equal(completed.state, 'ended', JSON.stringify(provider.chatRequests.at(-1).messages.at(-1)));
  assert.equal(completed.terminal.executionStatus, 'completed', JSON.stringify(completed.terminal));
  assert(sawRunning, 'The test must exercise a transferred lease.');
  const { history } = await application.readSession();
  const observations = history.entries.filter((entry) => entry.type === 'observation');
  assert(observations.some((entry) => entry.toolName === 'read_files' && entry.ok));
  if (action === 'settle') return;
  const result = observations.filter((entry) => entry.toolName !== 'read_files').at(-1).output;
  assert.equal(result.status, action === 'poll' ? 'exited' : 'stopped');
  if (action === 'poll') {
    assert.equal(result.exitCode, 0);
    assert.equal(await readFile(path.join(fixture.root, 'sentinel.txt'), 'utf8'), 'finish\n');
  }
});

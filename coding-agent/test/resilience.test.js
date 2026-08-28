import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSandbox } from '@ismail-elkorchi/sandbox';

const cli = path.resolve('coding-agent/dist/index.js');
const sandboxAvailable = process.platform === 'linux' && await (async () => {
  const sandbox = await createSandbox();
  try {
    return (await sandbox.probe()).backends.some((backend) => backend.id === 'linux-namespace-v1' && backend.available);
  } catch {
    return false;
  } finally {
    await sandbox.dispose();
  }
})();

test('taskless exec resume rejects a session without unfinished work', async () => {
  const provider = await scriptedOllama([finalResponse('Inspection complete.')]);
  const fixture = await createWorkspace({ tools: [], checks: [], endpoint: provider.endpoint });
  try {
    await trust(fixture);
    const completed = await runCli(fixture, ['exec', 'Inspect the workspace.']);
    assert.equal(completed.code, 0, completed.stderr);
    const output = await runCli(fixture, ['exec', '--resume']);
    assert.equal(output.code, 1);
    assert.match(output.stderr, /no unfinished operation/u);
  } finally {
    await provider.close();
    await fixture.close();
  }
});

test('taskless exec resume preserves an unknown provider outcome without replay', { timeout: 60_000 }, async () => {
  const provider = await scriptedOllama([]);
  const fixture = await createWorkspace({ tools: [], checks: [], endpoint: provider.endpoint });
  try {
    await trust(fixture);
    provider.blockNextChat();
    const first = spawnCli(fixture, ['exec', 'Inspect the repository without changing it.']);
    await provider.waitForBlockedChat();
    first.killAbruptly();
    const killed = await first.result;
    assertAbruptTermination(killed);
    provider.releaseBlockedChat(finalResponse('This response arrived after caller loss.'));

    const resumed = await runCli(fixture, ['exec', '--resume']);
    assert.equal(resumed.code, 7, resumed.stderr);
    assert.match(resumed.stdout, /Execution: Waiting for recovery decision/u);
    assert.match(resumed.stdout, /Reason: Provider outcome unknown/u);
    assert.equal(provider.chatRequests.length, 1, 'the unknown provider request must not be replayed');
  } finally {
    await provider.close();
    await fixture.close();
  }
});

test('resilient CLI recovery continues the accepted root-bound read and structured edit without a second task', { timeout: 60_000 }, async () => {
  const noteBefore = 'alpha\n';
  const noteHash = createHash('sha256').update(noteBefore).digest('hex');
  const provider = await scriptedOllama([
    toolResponse('read_files', { files: [{ path: 'src/note.txt' }] }),
    toolResponse('apply_patch', {
      patch: '*** Begin Patch\n*** Update File: src/note.txt\n@@\n-alpha\n+beta\n*** End Patch',
      expectedOldSha256: { 'src/note.txt': noteHash }
    }),
    finalResponse('Updated the requested file.')
  ]);
  const fixture = await createWorkspace({
    endpoint: provider.endpoint,
    tools: ['read_files', 'apply_patch'],
    checks: [],
    files: {
      'AGENTS.md': 'ROOT_V0_INSTRUCTION: inspect before editing and preserve unrelated files.\n',
      'src/AGENTS.md': 'SCOPED_V0_INSTRUCTION: only change src/note.txt from alpha to beta.\n',
      'src/note.txt': noteBefore,
      'untouched.txt': 'keep\n'
    }
  });
  try {
    await trust(fixture);
    provider.blockNextShow();
    const first = spawnCli(fixture, ['exec', 'Apply the scoped repository instruction.', '--permissions', 'edit']);
    await provider.waitForBlockedShow();
    first.killAbruptly();
    assertAbruptTermination(await first.result);
    provider.releaseBlockedShow();

    const resumed = await runCli(fixture, ['exec', '--resume', '--permissions', 'edit']);
    assert.equal(resumed.code, 0, `${resumed.stdout}\n${resumed.stderr}`);
    assert.equal(await readFile(path.join(fixture.root, 'src/note.txt'), 'utf8'), 'beta\n');
    assert.equal(await readFile(path.join(fixture.root, 'untouched.txt'), 'utf8'), 'keep\n');
    assert.match(resumed.stdout, /Workspace changes: 1 \(complete\)/u);
    assert.match(resumed.stdout, /- modified src\/note\.txt \[agent\]/u);
    assert.equal(provider.chatRequests.length, 3);
    const initialRequest = JSON.stringify(provider.chatRequests[0]);
    assert.match(initialRequest, /ROOT_V0_INSTRUCTION/u);
    assert.match(initialRequest, /SCOPED_V0_INSTRUCTION/u);
  } finally {
    await provider.close();
    await fixture.close();
  }
});

test('resilient CLI slice recovers before generation and completes one confined coding operation', { skip: !sandboxAvailable, timeout: 120_000 }, async () => {
  const noteBefore = 'alpha\n';
  const noteHash = createHash('sha256').update(noteBefore).digest('hex');
  const provider = await scriptedOllama([
    toolResponse('read_files', { files: [{ path: 'src/note.txt' }] }),
    toolResponse('apply_patch', {
      patch: '*** Begin Patch\n*** Update File: src/note.txt\n@@\n-alpha\n+beta\n*** End Patch',
      expectedOldSha256: { 'src/note.txt': noteHash }
    }),
    toolResponse('exec_command', { command: 'printf v0-command', yieldMs: 10_000 }),
    finalResponse('Updated the requested file and ran the required check.')
  ]);
  const fixture = await createWorkspace({
    endpoint: provider.endpoint,
    tools: ['read_files', 'apply_patch', 'exec_command'],
    checks: [{ id: 'note', command: "test \"$(cat src/note.txt)\" = beta", coverage: 'targeted' }],
    files: {
      'AGENTS.md': 'ROOT_V0_INSTRUCTION: inspect before editing and preserve unrelated files.\n',
      'src/AGENTS.md': 'SCOPED_V0_INSTRUCTION: only change src/note.txt from alpha to beta.\n',
      'src/note.txt': noteBefore,
      'untouched.txt': 'keep\n'
    }
  });
  try {
    await trust(fixture);
    provider.blockNextShow();
    const first = spawnCli(fixture, ['exec', 'Apply the scoped repository instruction.', '--permissions', 'develop']);
    await provider.waitForBlockedShow();
    first.killAbruptly();
    const killed = await first.result;
    assertAbruptTermination(killed);
    provider.releaseBlockedShow();

    const resumed = await runCli(fixture, ['exec', '--resume', '--permissions', 'develop']);
    assert.equal(resumed.code, 0, `${resumed.stdout}\n${resumed.stderr}`);
    assert.equal(await readFile(path.join(fixture.root, 'src/note.txt'), 'utf8'), 'beta\n');
    assert.equal(await readFile(path.join(fixture.root, 'untouched.txt'), 'utf8'), 'keep\n');
    assert.match(resumed.stdout, /Verification: Passed/u);
    assert.match(resumed.stdout, /- note: required\/passed/u);
    assert.match(resumed.stdout, /Workspace changes: 1 \(complete\)/u);
    assert.match(resumed.stdout, /- modified src\/note\.txt \[agent\]/u);
    assert.equal(provider.chatRequests.length, 4);
    const initialRequest = JSON.stringify(provider.chatRequests[0]);
    assert.match(initialRequest, /ROOT_V0_INSTRUCTION/u);
    assert.match(initialRequest, /SCOPED_V0_INSTRUCTION/u);
    assert.match(resumed.stderr, /read_files/u);
    assert.match(resumed.stderr, /apply_patch/u);
    assert.match(resumed.stderr, /exec_command/u);
    assert.match(resumed.stderr, /v0-command/u);
  } finally {
    await provider.close();
    await fixture.close();
  }
});

async function createWorkspace({ endpoint = 'http://127.0.0.1:1', tools, checks, files = {} }) {
  const parent = await mkdtemp(path.join(tmpdir(), 'coding-agent-v0-'));
  const root = path.join(parent, 'workspace');
  const stateRoot = path.join(parent, 'state');
  await mkdir(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await writeFile(path.join(root, 'coding-agent.config.json'), `${JSON.stringify({
    version: 1,
    provider: 'ollama',
    model: 'v0-scripted',
    instructions: [],
    tools: { enabled: tools },
    permissions: { maximumMode: 'develop', requireApprovalFor: [] },
    verification: { required: checks, advisory: [] }
  }, null, 2)}\n`);
  return {
    root,
    stateRoot,
    endpoint,
    async close() { await rm(parent, { recursive: true, force: true }); }
  };
}

async function trust(fixture) {
  const output = await runCli(fixture, ['trust', 'trusted']);
  assert.equal(output.code, 0, output.stderr);
}

function cliArguments(fixture, args) {
  return args[0] === 'trust'
    ? [cli, ...args, '--root', fixture.root, '--state-root', fixture.stateRoot]
    : [cli, ...args, '--root', fixture.root, '--state-root', fixture.stateRoot, '--provider-endpoint', fixture.endpoint];
}

function spawnCli(fixture, args) {
  const child = spawn(process.execPath, cliArguments(fixture, args), { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return {
    killAbruptly: () => child.kill(process.platform === 'win32' ? undefined : 'SIGKILL'),
    result
  };
}

function assertAbruptTermination(result) {
  if (process.platform === 'win32') assert.notEqual(result.code, 0);
  else assert.equal(result.signal, 'SIGKILL');
}

async function runCli(fixture, args) {
  return spawnCli(fixture, args).result;
}

function toolResponse(name, args) {
  return {
    model: 'v0-scripted',
    message: { content: '', tool_calls: [{ function: { name, arguments: args } }] },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 10,
    eval_count: 2
  };
}

function finalResponse(content) {
  return {
    model: 'v0-scripted',
    message: { content },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 10,
    eval_count: 4
  };
}

async function scriptedOllama(script) {
  const showWaiters = [];
  const chatWaiters = [];
  let blockedShow;
  let blockedChat;
  let blockShow = false;
  let blockChat = false;
  const responses = [...script];
  const chatRequests = [];
  const server = createServer(async (request, response) => {
    try {
      const body = await readRequestBody(request);
      if (request.url === '/api/show') {
        if (blockShow) {
          blockShow = false;
          const release = new Promise((resolve) => { blockedShow = resolve; });
          for (const waiter of showWaiters.splice(0)) waiter();
          await release;
        }
        sendJson(response, { capabilities: ['completion', 'tools'], model_info: { 'v0.context_length': 32_768 } });
        return;
      }
      if (request.url === '/api/chat') {
        chatRequests.push(JSON.parse(body));
        if (blockChat) {
          blockChat = false;
          const pending = new Promise((resolve) => { blockedChat = resolve; });
          for (const waiter of chatWaiters.splice(0)) waiter();
          const value = await pending;
          sendNdjson(response, value);
          return;
        }
        const value = responses.shift();
        if (!value) throw new Error('The scripted provider received an unexpected chat request.');
        sendNdjson(response, value);
        return;
      }
      response.writeHead(404).end();
    } catch (error) {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The scripted provider did not bind a TCP port.');
  return {
    endpoint: `http://127.0.0.1:${String(address.port)}`,
    chatRequests,
    blockNextShow() { blockShow = true; },
    waitForBlockedShow() { return blockedShow ? Promise.resolve() : new Promise((resolve) => showWaiters.push(resolve)); },
    releaseBlockedShow() { blockedShow?.(); blockedShow = undefined; },
    blockNextChat() { blockChat = true; },
    waitForBlockedChat() { return blockedChat ? Promise.resolve() : new Promise((resolve) => chatWaiters.push(resolve)); },
    releaseBlockedChat(value) { blockedChat?.(value); blockedChat = undefined; },
    async close() { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  };
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.once('error', reject);
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function sendJson(response, value) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function sendNdjson(response, value) {
  response.writeHead(200, { 'content-type': 'application/x-ndjson' });
  response.end(`${JSON.stringify(value)}\n`);
}

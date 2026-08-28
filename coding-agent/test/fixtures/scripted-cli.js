import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createSandbox } from '@ismail-elkorchi/sandbox';

const cli = path.resolve('coding-agent/dist/index.js');
const runFile = promisify(execFile);

export const sandboxAvailable = process.platform === 'linux' && await (async () => {
  const sandbox = await createSandbox();
  try {
    return (await sandbox.probe()).backends.some((backend) => backend.id === 'linux-namespace-v1' && backend.available);
  } catch {
    return false;
  } finally {
    await sandbox.dispose();
  }
})();

export async function createWorkspace({
  endpoint = 'http://127.0.0.1:1',
  tools,
  checks,
  files = {},
  trustLevel = 'trusted',
  requireApprovalFor = [],
  limits
}) {
  const parent = await mkdtemp(path.join(tmpdir(), 'coding-agent-product-'));
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
    permissions: { maximumMode: 'develop', requireApprovalFor },
    verification: { required: checks, advisory: [] },
    ...(limits === undefined ? {} : { limits })
  }, null, 2)}\n`);
  return {
    root,
    stateRoot,
    endpoint,
    trustLevel,
    async close() { await rm(parent, { recursive: true, force: true }); }
  };
}

export async function trust(fixture, level = fixture.trustLevel) {
  const output = await runCli(fixture, ['trust', level]);
  assert.equal(output.code, 0, output.stderr);
}

export async function initializeGitRepository(fixture) {
  await runFile('git', ['init', '--quiet'], { cwd: fixture.root });
  await runFile('git', ['config', 'user.email', 'coding-agent@example.invalid'], { cwd: fixture.root });
  await runFile('git', ['config', 'user.name', 'Coding Agent Test'], { cwd: fixture.root });
  await runFile('git', ['add', '.'], { cwd: fixture.root });
  await runFile('git', ['commit', '--quiet', '-m', 'fixture baseline'], { cwd: fixture.root });
}

export function spawnCli(fixture, args) {
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

export function assertAbruptTermination(result) {
  if (process.platform === 'win32') assert.notEqual(result.code, 0);
  else assert.equal(result.signal, 'SIGKILL');
}

export async function runCli(fixture, args) {
  return spawnCli(fixture, args).result;
}

export function toolResponse(name, args) {
  return {
    model: 'v0-scripted',
    message: { content: '', tool_calls: [{ function: { name, arguments: args } }] },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 10,
    eval_count: 2
  };
}

export function finalResponse(content) {
  return {
    model: 'v0-scripted',
    message: { content },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 10,
    eval_count: 4
  };
}

export async function scriptedOllama(script) {
  const showWaiters = [];
  const chatWaiters = [];
  const chatCountWaiters = [];
  let blockedShow;
  let blockedChat;
  let blockShow = false;
  let blockedChatIndex;
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
        for (const waiter of chatCountWaiters.splice(0)) {
          if (chatRequests.length >= waiter.count) waiter.resolve();
          else chatCountWaiters.push(waiter);
        }
        if (blockedChatIndex === chatRequests.length) {
          blockedChatIndex = undefined;
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
    enqueueResponses(...values) { responses.push(...values); },
    blockNextShow() { blockShow = true; },
    waitForBlockedShow() { return blockedShow ? Promise.resolve() : new Promise((resolve) => showWaiters.push(resolve)); },
    releaseBlockedShow() { blockedShow?.(); blockedShow = undefined; },
    blockNextChat() { blockedChatIndex = chatRequests.length + 1; },
    waitForChatCount(count) {
      return chatRequests.length >= count
        ? Promise.resolve()
        : new Promise((resolve) => chatCountWaiters.push({ count, resolve }));
    },
    waitForBlockedChat() { return blockedChat ? Promise.resolve() : new Promise((resolve) => chatWaiters.push(resolve)); },
    releaseBlockedChat(value) { blockedChat?.(value); blockedChat = undefined; },
    async close() { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  };
}

function cliArguments(fixture, args) {
  return args[0] === 'trust'
    ? [cli, ...args, '--root', fixture.root, '--state-root', fixture.stateRoot]
    : [cli, ...args, '--root', fixture.root, '--state-root', fixture.stateRoot, '--provider-endpoint', fixture.endpoint];
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

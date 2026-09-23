import { testResult } from './helpers/results.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveCodingAuthority } from '@ismail-elkorchi/coding-agent';
import { resultExitCode } from '@ismail-elkorchi/coding-agent/cli';
import { decodeAgentTerminalSnapshot } from '@agent-core/runtime';
import { rpcClient } from '../../test-helpers/rpc-client.js';

for (const [agent, flag] of [
  ['coding-agent', '--reasoning-effort'],
  ['writing-agent', '--reasoning']
])
  test(
    `${agent} CLI preserves provider-defined reasoning in configuration`,
    { skip: process.platform !== 'linux' },
    async (t) => {
      const parent = await mkdtemp(path.join(tmpdir(), `${agent}-reasoning-`));
      const root = path.join(parent, 'workspace');
      await mkdir(root);
      const client = rpcClient([
        `${agent}/dist/cli.js`,
        'rpc',
        '--root',
        root,
        '--state-root',
        path.join(parent, 'state'),
        '--provider',
        'openai-codex',
        '--model',
        'gpt-5.6',
        flag,
        'provider-defined-effort'
      ]);
      t.after(async () => {
        await client.close();
        await rm(parent, { recursive: true, force: true });
      });
      const selection = await client.request('configuration.read');
      assert.deepEqual(selection.reasoning, {
        strategy: 'effort',
        effort: 'provider-defined-effort'
      });
      await assert.rejects(
        client.request('configuration.set', selection),
        /reasoning effort provider-defined-effort is not supported/u
      );
      await client.request('application.shutdown');
      assert.equal((await client.exited).code, 0);
    }
  );

test('permission choices expose the same work tools with distinct execution authority', () => {
  const readOnly = resolveCodingAuthority({ requestedMode: 'read_only', hasVerificationChecks: true });
  const sandbox = resolveCodingAuthority({ requestedMode: 'sandbox', hasVerificationChecks: true });
  const host = resolveCodingAuthority({ requestedMode: 'full_host', hasVerificationChecks: true });
  assert.deepEqual(readOnly.toolPolicy.allowedRisks, ['read']);
  assert.equal(readOnly.enabledTools.includes('exec_command'), false);
  assert.equal(readOnly.enabledTools.includes('apply_patch'), false);
  assert.equal(readOnly.verificationCommands, false);
  assert.equal(readOnly.permissions.commandExecution, 'denied');
  assert.deepEqual(sandbox.enabledTools, host.enabledTools);
  assert.equal(sandbox.enabledTools.includes('exec_command'), true);
  assert.equal(sandbox.verificationCommands, true);
  assert.equal(sandbox.permissions.commandExecution, 'sandboxed');
  assert.equal(sandbox.permissions.network, 'denied');
  assert.equal(sandbox.permissions.hostEscape, 'denied');
  assert.equal(host.permissions.commandExecution, 'host');
  assert.equal(host.permissions.network, 'host');
  assert.equal(host.permissions.hostEscape, 'allowed');
});

test('CLI rejects retired presentation flags', async () => {
  for (const flag of ['--tui', '--plain']) {
    const output = await run(path.resolve('coding-agent/dist/cli.js'), [flag]);
    assert.equal(output.code, 1);
    assert.match(output.stderr, /Unknown option/u);
  }
});

test('CLI exit codes distinguish execution and model-output completeness', () => {
  assert.equal(resultExitCode(result()), 0);
  assert.equal(
    resultExitCode(
      result({
        modelOutput: { status: 'partial', message: 'part', source: 'content', turnIndex: 1 },
        terminationReason: 'model_output_limit',
        modelTerminationReason: 'output_limit'
      })
    ),
    2
  );
  assert.equal(resultExitCode(failed()), 1);
  assert.equal(resultExitCode(aborted()), 130);
});

test('CLI binary help works through the published executable', async () => {
  const output = await run(path.resolve('coding-agent/dist/cli.js'), ['--help']);
  assert.equal(output.code, 0);
  assert.match(output.stdout + output.stderr, /coding-agent/i);
  assert.match(
    output.stdout + output.stderr,
    /approval <allow\|deny> <run-id> <approval-id> <fingerprint>/u
  );
  assert.match(
    output.stdout + output.stderr,
    /--permissions <mode>\s+read_only, sandbox, or full_host/iu
  );
  assert.match(output.stdout + output.stderr, /--codex-transport <http_sse\|websocket>/u);
});

test(
  'CLI discards configured reasoning when provider or model identity changes',
  { skip: process.platform !== 'linux' },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'coding-agent-cli-provider-'));
    const home = path.join(root, 'home');
    const stateHome = `${root}-state`;
    await mkdir(home);
    await writeFile(
      path.join(root, 'coding-agent.config.json'),
      JSON.stringify({
        version: 1,
        provider: 'openai',
        model: 'gpt-5.6-sol',
        reasoning: { strategy: 'effort', effort: 'max', mode: 'standard' },
        instructions: [],
        tools: { enabled: [] },
        verification: { required: [], advisory: [] }
      })
    );
    const trust = await run(
      path.resolve('coding-agent/test/fixtures/scripted-cli-entry.js'),
      ['trust', 'trusted', '--root', root],
      {
        env: { ...process.env, HOME: home, USERPROFILE: home, XDG_STATE_HOME: stateHome }
      }
    );
    assert.equal(trust.code, 0, trust.stderr);
    const output = await run(
      path.resolve('coding-agent/test/fixtures/scripted-cli-entry.js'),
      ['exec', 'test', '--root', root, '--provider', 'openai-codex', '--model', 'gpt-5.6-luna'],
      {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: home,
          XDG_STATE_HOME: stateHome
        }
      }
    );
    assert.equal(output.code, 7);
    assert.doesNotMatch(output.stderr, /reasoning\.mode|reasoning mode/iu);
  }
);

test(
  'workspace trust and explicit model setup are enforced before provider I/O',
  { skip: process.platform !== 'linux' },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'coding-agent-cli-trust-'));
    const stateHome = `${root}-state`;
    const environment = { ...process.env, XDG_STATE_HOME: stateHome };
    const untrusted = await run(
      path.resolve('coding-agent/dist/cli.js'),
      ['exec', 'inspect', '--root', root, '--provider', 'ollama', '--model', 'test'],
      { env: environment }
    );
    assert.equal(untrusted.code, 1);
    assert.match(untrusted.stderr, /Workspace is untrusted/u);
    await assert.rejects(access(path.join(root, '.coding-agent')));

    await writeFile(
      path.join(root, 'coding-agent.config.json'),
      JSON.stringify({
        version: 1,
        provider: 'openai',
        model: 'gpt-5.6-sol',
        instructions: [],
        tools: { enabled: [] },
        verification: { required: [], advisory: [] }
      })
    );
    const trusted = await run(
      path.resolve('coding-agent/dist/cli.js'),
      ['trust', 'trusted', '--root', root],
      { env: environment }
    );
    assert.equal(trusted.code, 0, trusted.stderr);
    const status = await run(
      path.resolve('coding-agent/dist/cli.js'),
      ['trust', 'status', '--root', root],
      {
        env: environment
      }
    );
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /Trust: trusted/u);
    assert.equal(status.stdout.includes(root), true);
    const revoked = await run(
      path.resolve('coding-agent/dist/cli.js'),
      ['trust', 'revoke', '--root', root],
      {
        env: environment
      }
    );
    assert.equal(revoked.code, 0, revoked.stderr);
    const revokedStatus = await run(
      path.resolve('coding-agent/dist/cli.js'),
      ['trust', 'status', '--root', root],
      { env: environment }
    );
    assert.match(revokedStatus.stdout, /Trust: untrusted/u);
  }
);

function result(overrides = {}) {
  return testResult(decodeAgentTerminalSnapshot({ ...base(), ...overrides }));
}
function failed() {
  const { modelTerminationReason: _reason, ...input } = base();
  return {
    state: 'ended',
    terminal: decodeAgentTerminalSnapshot({
      ...input,
      executionStatus: 'failed',
      terminationReason: 'runtime_error',
      errorMessage: 'failed',
      modelOutput: { status: 'absent' }
    }),
    deliveryDiagnostics: []
  };
}
function aborted() {
  const { modelTerminationReason: _reason, ...input } = base();
  return {
    state: 'ended',
    terminal: decodeAgentTerminalSnapshot({
      ...input,
      executionStatus: 'aborted',
      terminationReason: 'aborted',
      errorMessage: 'stopped',
      modelOutput: { status: 'absent' }
    }),
    deliveryDiagnostics: []
  };
}
function base() {
  return {
    runId: 'run',
    finalizationId: 'final',
    phase: 'ended',
    executionStatus: 'completed',
    terminationReason: 'model_completed',
    modelTerminationReason: 'stop',
    modelOutput: { status: 'complete', message: 'done', source: 'content', turnIndex: 1 },
    turnCount: 1,
    budget: {
      modelTurns: 1,
      totalToolCalls: 0,
      elapsedMs: 1,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      knownCosts: {},
      pricingStatus: 'unknown',
      unknownPricedTokens: 0
    }
  };
}
function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

for (const agent of ['coding-agent', 'writing-agent'])
  test(`${agent} CLI requires an explicit target and existing session for fresh continuation`, async () => {
    const child = spawn(process.execPath, [`${agent}/dist/cli.js`, 'rpc', '--fresh-continuation'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let diagnostic = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      diagnostic += chunk;
    });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 1);
    assert.match(diagnostic, /--fresh-continuation requires/u);
  });

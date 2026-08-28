import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveCodingAuthority, resultExitCode } from '@ismail-elkorchi/coding-agent';
import { decodeAgentTerminalSnapshot } from '@agent-core/runtime';

test('permission modes expose exact tools and authority', () => {
  const review = resolveCodingAuthority({ requestedMode: 'review', trust: 'trusted', hasVerificationChecks: false });
  assert.deepEqual(review.toolPolicy.allowedRisks, ['read']);
  assert.equal(review.enabledTools.includes('apply_patch'), false);
  assert.equal(review.enabledTools.includes('exec_command'), false);
  const edit = resolveCodingAuthority({ requestedMode: 'edit', trust: 'restricted', hasVerificationChecks: false });
  assert.deepEqual(edit.toolPolicy.allowedRisks, ['read', 'write', 'destructive']);
  assert.deepEqual(edit.requiredApprovals, ['write', 'delete']);
  const develop = resolveCodingAuthority({ requestedMode: 'develop', trust: 'trusted', hasVerificationChecks: true });
  assert.deepEqual(develop.toolPolicy.allowedRisks, ['read', 'write', 'destructive', 'execute']);
  assert.equal(develop.permissions.commandExecution, 'sandboxed');
  assert.equal(develop.permissions.network, 'denied');
});

test('permission mode and trust matrix never grants network or host escape', () => {
  for (const trust of ['restricted', 'trusted']) {
    for (const mode of ['review', 'edit', 'develop']) {
      const authority = resolveCodingAuthority({ requestedMode: mode, trust, hasVerificationChecks: true });
      assert.equal(authority.mode, mode);
      assert.equal(authority.permissions.network, 'denied');
      assert.equal(authority.permissions.hostEscape, 'denied');
      assert.equal(authority.enabledTools.includes('apply_patch'), mode !== 'review');
      assert.equal(authority.enabledTools.includes('exec_command'), mode === 'develop');
      assert.equal(authority.verificationCommands, mode === 'develop' ? 'sandboxed' : 'disabled');
      assert.equal(authority.requiredApprovals.includes('command'), trust === 'restricted' && mode === 'develop');
    }
  }
  const narrowed = resolveCodingAuthority({
    requestedMode: 'develop',
    trust: 'trusted',
    hasVerificationChecks: false,
    project: {
      permissions: { maximumMode: 'edit', requireApprovalFor: ['write'] },
      enabledTools: ['read_files', 'apply_patch', 'exec_command']
    }
  });
  assert.equal(narrowed.mode, 'edit');
  assert.deepEqual(narrowed.enabledTools, ['read_files', 'apply_patch']);
  assert.deepEqual(narrowed.requiredApprovals, ['write']);
});

test('CLI rejects retired presentation flags', async () => {
  for (const flag of ['--tui', '--plain']) {
    const output = await run(path.resolve('coding-agent/dist/index.js'), [flag]);
    assert.equal(output.code, 1);
    assert.match(output.stderr, /Unknown option/u);
  }
});

test('CLI exit codes distinguish success, candidate completeness, verification, failure, and abort', () => {
  assert.equal(resultExitCode(result()), 0);
  assert.equal(resultExitCode(result({ candidate: { status: 'partial', message: 'part', source: 'content', turnIndex: 1 }, terminationReason: 'model_output_limit', modelTerminationReason: 'output_limit' })), 2);
  assert.equal(resultExitCode(result({ verificationStatus: 'failed' })), 3);
  assert.equal(resultExitCode(result({ verificationStatus: 'inconclusive' })), 4);
  assert.equal(resultExitCode(failed()), 1);
  assert.equal(resultExitCode(aborted()), 130);
});

test('CLI binary help works through the published executable', async () => {
  const output = await run(path.resolve('coding-agent/dist/index.js'), ['--help']);
  assert.equal(output.code, 0);
  assert.match(output.stdout + output.stderr, /coding-agent/i);
  assert.match(output.stdout + output.stderr, /approval <allow\|deny> <run-id> <approval-id> <fingerprint>/u);
  assert.match(output.stdout + output.stderr, /review mode exposes root-bound read tools only/iu);
  assert.match(output.stdout + output.stderr, /Commands and verification run with no network/iu);
  assert.match(output.stdout + output.stderr, /--permissions <mode>\s+Authority ceiling: review, edit, or develop/iu);
  assert.match(output.stdout + output.stderr, /--codex-transport <http_sse\|websocket>/u);
});

test('CLI discards configured reasoning when provider or model identity changes', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'coding-agent-cli-provider-'));
  const home = path.join(root, 'home');
  const stateHome = `${root}-state`;
  await mkdir(home);
  await writeFile(path.join(root, 'coding-agent.config.json'), JSON.stringify({
    version: 1,
    provider: 'openai',
    model: 'gpt-5.6-sol',
    reasoning: { strategy: 'effort', effort: 'max', mode: 'standard' },
    instructions: [],
    tools: { enabled: [] },
    permissions: { maximumMode: 'review', requireApprovalFor: [] },
    verification: { required: [], advisory: [] }
  }));
  const trust = await run(path.resolve('coding-agent/dist/index.js'), ['trust', 'trusted', '--root', root], { env: { ...process.env, HOME: home, USERPROFILE: home, XDG_STATE_HOME: stateHome } });
  assert.equal(trust.code, 0, trust.stderr);
  const output = await run(path.resolve('coding-agent/dist/index.js'), [
    'exec', 'test', '--root', root,
    '--provider', 'openai-codex', '--model', 'gpt-5.6-luna'
  ], { env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_STATE_HOME: stateHome } });
  assert.equal(output.code, 7);
  assert.doesNotMatch(output.stderr, /reasoning\.mode|reasoning mode/iu);
});

test('workspace trust and explicit model setup are enforced before provider I/O', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'coding-agent-cli-trust-'));
  const stateHome = `${root}-state`;
  const environment = { ...process.env, XDG_STATE_HOME: stateHome };
  const untrusted = await run(path.resolve('coding-agent/dist/index.js'), ['exec', 'inspect', '--root', root, '--provider', 'ollama', '--model', 'test'], { env: environment });
  assert.equal(untrusted.code, 1);
  assert.match(untrusted.stderr, /Workspace is untrusted/u);
  await assert.rejects(access(path.join(root, '.coding-agent')));

  await writeFile(path.join(root, 'coding-agent.config.json'), JSON.stringify({
    version: 1,
    provider: 'openai',
    model: 'gpt-5.6-sol',
    instructions: [],
    tools: { enabled: [] },
    permissions: { maximumMode: 'review', requireApprovalFor: [] },
    verification: { required: [], advisory: [] }
  }));
  const restricted = await run(path.resolve('coding-agent/dist/index.js'), ['trust', 'restricted', '--root', root], { env: environment });
  assert.equal(restricted.code, 0, restricted.stderr);
  const noRepositorySelectedProvider = await run(path.resolve('coding-agent/dist/index.js'), ['exec', 'inspect', '--root', root], { env: { ...environment, CODING_AGENT_PROVIDER: '', CODING_AGENT_MODEL: '' } });
  assert.equal(noRepositorySelectedProvider.code, 1);
  assert.match(noRepositorySelectedProvider.stderr, /No model provider is configured/u);

  const trusted = await run(path.resolve('coding-agent/dist/index.js'), ['trust', 'trusted', '--root', root], { env: environment });
  assert.equal(trusted.code, 0, trusted.stderr);
  const status = await run(path.resolve('coding-agent/dist/index.js'), ['trust', 'status', '--root', root], { env: environment });
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /Trust: trusted/u);
  assert.equal(status.stdout.includes(root), true);
  const revoked = await run(path.resolve('coding-agent/dist/index.js'), ['trust', 'revoke', '--root', root], { env: environment });
  assert.equal(revoked.code, 0, revoked.stderr);
  const revokedStatus = await run(path.resolve('coding-agent/dist/index.js'), ['trust', 'status', '--root', root], { env: environment });
  assert.match(revokedStatus.stdout, /Trust: untrusted/u);
});

function result(overrides = {}) { return { state: 'ended', terminal: decodeAgentTerminalSnapshot({ ...base(), ...overrides }), deliveryDiagnostics: [] }; }
function failed() { const { modelTerminationReason: _reason, ...input } = base(); return { state: 'ended', terminal: decodeAgentTerminalSnapshot({ ...input, executionStatus: 'failed', verificationStatus: 'not_run', terminationReason: 'runtime_error', errorMessage: 'failed', candidate: { status: 'absent' } }), deliveryDiagnostics: [] }; }
function aborted() { const { modelTerminationReason: _reason, ...input } = base(); return { state: 'ended', terminal: decodeAgentTerminalSnapshot({ ...input, executionStatus: 'aborted', verificationStatus: 'not_run', terminationReason: 'aborted', errorMessage: 'stopped', candidate: { status: 'absent' } }), deliveryDiagnostics: [] }; }
function base() { return { runId: 'run', finalizationId: 'final', phase: 'ended', executionStatus: 'completed', verificationStatus: 'not_required', terminationReason: 'model_completed', modelTerminationReason: 'stop', candidate: { status: 'complete', message: 'done', source: 'content', turnIndex: 1 }, turnCount: 1, checkResults: [], budget: { modelTurns: 1, totalToolCalls: 0, repeatedIdenticalToolCalls: 0, elapsedMs: 1, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, knownCosts: {}, pricingStatus: 'unknown', unknownPricedTokens: 0, consecutiveProviderFailures: 0, consecutiveToolFailures: 0 } }; }
function run(file, args, options = {}) { return new Promise((resolve, reject) => { const child = spawn(process.execPath, [file, ...args], { stdio: ['ignore', 'pipe', 'pipe'], ...options }); let stdout = ''; let stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; }); child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); }); }

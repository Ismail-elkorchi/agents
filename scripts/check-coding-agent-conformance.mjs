import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  assertAbruptTermination,
  createWorkspace,
  finalResponse,
  runCli,
  sandboxAvailable,
  scriptedOllama,
  spawnCli,
  toolResponse,
  trust
} from '../coding-agent/test/fixtures/scripted-cli.js';
import {
  assertCodingAgentConformanceThresholds,
  evaluateCodingAgentConformance,
  hasPassedRequiredCandidateCheck
} from './coding-agent-conformance-metrics.mjs';
import { decodeCodingHandoff } from '../coding-agent/dist/changes/coding-handoff.js';

if (!sandboxAvailable) {
  process.stdout.write(`${JSON.stringify({
    status: 'unavailable',
    guarantee: 'linux-namespace-v1 coding conformance task',
    platform: process.platform,
    reason: process.platform === 'linux'
      ? 'The Linux namespace Sandbox backend is unavailable on this host.'
      : 'The Linux namespace Sandbox backend is not implemented on this platform.',
    metrics: 'not_measured'
  }, null, 2)}\n`);
  if (process.env.CODING_AGENT_REQUIRE_NATIVE_CONFORMANCE === '1') {
    throw new Error('Native Coding Agent conformance is required on this host.');
  }
  process.exit(0);
}

const cases = [];
cases.push(await runResilientMutationCase());
cases.push(await runClarificationCase());
const metrics = evaluateCodingAgentConformance(cases);
assertCodingAgentConformanceThresholds(metrics);
process.stdout.write(`${JSON.stringify({
  status: 'verified',
  guarantee: 'linux-namespace-v1 coding conformance task',
  platform: process.platform,
  metrics
}, null, 2)}\n`);

async function runResilientMutationCase() {
  const before = 'alpha\n';
  const provider = await scriptedOllama([
    toolResponse('read_files', { files: [{ path: 'src/note.txt' }] }),
    toolResponse('apply_patch', {
      patch: '*** Begin Patch\n*** Update File: src/note.txt\n@@\n-alpha\n+beta\n*** End Patch',
      expectedOldSha256: { 'src/note.txt': createHash('sha256').update(before).digest('hex') }
    }),
    finalResponse('Changed only src/note.txt from alpha to beta and preserved unrelated work.')
  ]);
  const fixture = await createWorkspace({
    endpoint: provider.endpoint,
    tools: ['read_files', 'apply_patch'],
    checks: [{ id: 'note-value', command: "test \"$(cat src/note.txt)\" = beta", coverage: 'targeted' }],
    requireApprovalFor: ['write'],
    files: {
      'AGENTS.md': 'Q0_ROOT: inspect before editing and preserve unrelated files.\n',
      'src/AGENTS.md': 'Q0_SCOPED: only change src/note.txt from alpha to beta.\n',
      'src/note.txt': before,
      'untouched.txt': 'preserve\n'
    }
  });
  try {
    await trust(fixture);
    provider.blockNextShow();
    const initial = spawnCli(fixture, ['exec', 'Apply the scoped note correction.', '--permissions', 'develop']);
    await provider.waitForBlockedShow();
    const processLossPoint = provider.chatRequests.length === 0 ? 'before_provider_generation' : 'after_provider_generation';
    initial.killAbruptly();
    assertAbruptTermination(await initial.result);
    provider.releaseBlockedShow();

    const suspended = await runCli(fixture, ['exec', '--resume', '--permissions', 'develop']);
    if (suspended.code !== 7) throw new Error(`Conformance task did not suspend for approval.\n${suspended.stdout}\n${suspended.stderr}`);
    const runId = match(suspended.stdout, /Run: (\S+)/u, 'run id');
    const approvalId = match(suspended.stdout, /Approval: (\S+) apply_patch/u, 'approval id');
    const fingerprint = match(suspended.stdout, /Fingerprint: (\S+)/u, 'approval fingerprint');
    const requestedApprovals = [...suspended.stdout.matchAll(/Approval: \S+ (\S+)/gu)].map((item) => item[1]);
    const ended = await runCli(fixture, [
      'approval', 'allow', runId, approvalId, fingerprint, '--permissions', 'develop'
    ]);
    if (ended.code !== 0) throw new Error(`Conformance task did not complete.\n${ended.stdout}\n${ended.stderr}`);
    const report = await readChangeReport(fixture, runId);
    const prompt = provider.chatRequests[0].messages.map((message) => message.content).join('\n');
    const target = await readFile(path.join(fixture.root, 'src/note.txt'), 'utf8');
    const untouched = await readFile(path.join(fixture.root, 'untouched.txt'), 'utf8');
    return {
      specification: {
        id: 'resilient-approved-confined-fix',
        instructions: ['root-instruction', 'scoped-instruction', 'target-result', 'preserve-unrelated'],
        expectedApprovals: ['apply_patch'],
        requiredChecks: ['note-value'],
        processLossPoint: 'before_provider_generation',
        allowedPaths: ['src/note.txt'],
        forbiddenPaths: ['untouched.txt'],
        underspecified: false,
        terminal: terminal('passed')
      },
      observation: {
        satisfiedInstructions: [
          ...(prompt.includes('Q0_ROOT') ? ['root-instruction'] : []),
          ...(prompt.includes('Q0_SCOPED') ? ['scoped-instruction'] : []),
          ...(target === 'beta\n' ? ['target-result'] : []),
          ...(untouched === 'preserve\n' ? ['preserve-unrelated'] : [])
        ],
        approvalsRequested: requestedApprovals,
        passedChecks: hasPassedRequiredCandidateCheck(ended.stdout, 'note-value') ? ['note-value'] : [],
        processLossPoint,
        changes: report.changes.map((change) => ({ path: change.path, bytes: change.afterBytes ?? change.beforeBytes ?? 0 })),
        clarificationRequested: false,
        summaryContradictions: summaryContradictions(ended.stdout, report),
        scopeViolations: scopeViolations(report, ['src/note.txt'], ['untouched.txt']),
        terminal: parseTerminal(ended.stdout)
      }
    };
  } finally {
    await provider.close();
    await fixture.close();
  }
}

async function runClarificationCase() {
  const provider = await scriptedOllama([
    finalResponse('Please identify the exact target and acceptable blast radius before I change anything.')
  ]);
  const fixture = await createWorkspace({
    endpoint: provider.endpoint,
    tools: ['read_files', 'apply_patch'],
    checks: [],
    files: { 'src/a.js': 'a\n', 'src/b.js': 'b\n' }
  });
  try {
    await trust(fixture);
    const ended = await runCli(fixture, ['exec', 'Fix the issue.', '--permissions', 'edit']);
    if (ended.code !== 0) throw new Error(`Clarification task did not complete.\n${ended.stdout}\n${ended.stderr}`);
    const runId = match(ended.stdout, /Run: (\S+)/u, 'run id');
    const report = await readChangeReport(fixture, runId);
    const clarificationRequested = /identify the exact target and acceptable blast radius/u.test(ended.stdout);
    return {
      specification: {
        id: 'underspecified-safe-clarification',
        instructions: ['clarify-before-mutation'],
        expectedApprovals: [],
        requiredChecks: [],
        processLossPoint: null,
        allowedPaths: [],
        forbiddenPaths: ['src/a.js', 'src/b.js'],
        underspecified: true,
        terminal: terminal('not_required')
      },
      observation: {
        satisfiedInstructions: clarificationRequested ? ['clarify-before-mutation'] : [],
        approvalsRequested: [],
        passedChecks: [],
        processLossPoint: null,
        changes: report.changes.map((change) => ({ path: change.path, bytes: change.afterBytes ?? change.beforeBytes ?? 0 })),
        clarificationRequested,
        summaryContradictions: summaryContradictions(ended.stdout, report),
        scopeViolations: scopeViolations(report, [], ['src/a.js', 'src/b.js']),
        terminal: parseTerminal(ended.stdout)
      }
    };
  } finally {
    await provider.close();
    await fixture.close();
  }
}

async function readChangeReport(fixture, runId) {
  const directory = path.join(fixture.stateRoot, 'coding-handoffs');
  const entries = (await readdir(directory)).filter((entry) => entry.endsWith('.json'));
  if (entries.length !== 1) throw new Error(`Expected one conformance coding handoff, found ${String(entries.length)}.`);
  return decodeCodingHandoff(JSON.parse(await readFile(path.join(directory, entries[0]), 'utf8')), runId).changeReport;
}

function summaryContradictions(output, report) {
  const contradictions = [];
  if (!output.includes(`Workspace changes: ${String(report.totalChanges)} (${report.coverage})`)) contradictions.push('change count or coverage');
  const verification = /Verification: ([^\n]+)/u.exec(output)?.[1]?.trim().toLowerCase().replaceAll(' ', '_');
  if (verification !== report.facts.verificationStatus) contradictions.push('verification status');
  for (const change of report.changes) {
    const origin = change.attribution === 'structured_mutation' ? 'agent' : 'external/concurrent';
    if (!output.includes(`- ${change.kind} ${change.path} [${origin}`)) contradictions.push(`change ${change.path}`);
  }
  if (report.coverage === 'complete' && report.facts.externalOrConcurrentPaths.length === 0 && !output.includes('Remaining uncertainty: none')) {
    contradictions.push('remaining uncertainty');
  }
  return contradictions;
}

function scopeViolations(report, allowedPaths, forbiddenPaths) {
  const allowed = new Set(allowedPaths);
  const forbidden = new Set(forbiddenPaths);
  return report.changes
    .filter((change) => !allowed.has(change.path) || forbidden.has(change.path) || change.attribution !== 'structured_mutation')
    .map((change) => change.path);
}

function parseTerminal(output) {
  return {
    executionStatus: match(output, /Execution: (\S+)/u, 'execution status').toLowerCase(),
    candidateStatus: match(output, /Candidate: (\S+)/u, 'candidate status').toLowerCase(),
    verificationStatus: match(output, /Verification: ([^\n]+)/u, 'verification status').trim().toLowerCase().replaceAll(' ', '_'),
    terminationReason: /Model termination: Stop/u.test(output) ? 'model_completed' : 'unexpected'
  };
}

function terminal(verificationStatus) {
  return {
    executionStatus: 'completed',
    candidateStatus: 'complete',
    verificationStatus,
    terminationReason: 'model_completed'
  };
}

function match(value, pattern, label) {
  const result = pattern.exec(value)?.[1];
  if (result === undefined) throw new Error(`Conformance output is missing ${label}: ${value}`);
  return result;
}

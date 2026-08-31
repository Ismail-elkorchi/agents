import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { EventRepository } from '@agent-core/evidence';
import {
  createAgentPreparedCheckEffect,
  type AgentCheckContext,
  type AgentCheckDefinition,
  type AgentCheckObservation,
  type AgentCheckResult,
  type AgentEvent
} from '@agent-core/runtime';
import {
  prepareCommandExecution,
  releasePreparedCommandExecution,
  startPreparedCommandExecution,
  type CommandExecutionOwner,
  type CommandExecutionResult,
  type PreparedCommandExecution
} from '@agent-core/tools';
import {
  RootedFileAuthority,
  captureWorkspaceSnapshot,
  changedWorkspacePaths,
  materializeWorkspaceSnapshot,
  type WorkspaceSnapshot
} from '@agent-core/tools-local';
import type { CodingAgentCheckConfiguration, CodingAgentConfiguration } from '../configuration.js';
import type { SandboxCommandExecution } from '../execution/sandbox-command-execution.js';

export interface AdmittedCodingCheck {
  readonly id: string;
  readonly command: string;
  readonly coverage: 'targeted' | 'full';
  readonly requirement: 'required' | 'advisory';
  readonly origin: 'project' | 'inferred';
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface AdmittedCodingCheckPlan {
  readonly implementationId: string;
  readonly checks: readonly AdmittedCodingCheck[];
  readonly requiredCoverage: 'admitted' | 'missing';
}

/** Freezes project checks and application-recognized manifest proposals into one run plan. */
export function deriveAdmittedCheckPlan(configuration: CodingAgentConfiguration | undefined, inferredCommands: readonly string[]): AdmittedCodingCheckPlan {
  const checks: AdmittedCodingCheck[] = [];
  const commands = new Set<string>();
  for (const [requirement, configured] of [
    ['required', configuration?.verification.required ?? []],
    ['advisory', configuration?.verification.advisory ?? []]
  ] as const) {
    for (const check of configured) {
      checks.push(admittedConfiguredCheck(check, requirement));
      commands.add(check.command);
    }
  }
  for (const command of inferredCommands) {
    if (commands.has(command)) continue;
    checks.push(Object.freeze({
      id: `inferred-${sha256(command).slice(0, 16)}`,
      command,
      coverage: 'full',
      requirement: 'required',
      origin: 'inferred',
      timeoutMs: 120_000,
      maxOutputBytes: 128_000
    }));
    commands.add(command);
  }
  const implementationId = `coding-agent.check-plan@2:${sha256(JSON.stringify(checks))}`;
  return Object.freeze({
    implementationId,
    checks: Object.freeze(checks),
    requiredCoverage: checks.some((check) => check.requirement === 'required') ? 'admitted' : 'missing'
  });
}

export function createAuthoritativeChecks(input: {
  readonly plan: AdmittedCodingCheckPlan;
  readonly sourceRoot: RootedFileAuthority;
  readonly candidateRoot: RootedFileAuthority;
  readonly baseline: WorkspaceSnapshot;
  readonly runtimeDirectory: string;
  readonly events: EventRepository<AgentEvent>;
  readonly createCommandExecution: (input: { readonly root: RootedFileAuthority; readonly repositoryDirectory: string }) => Promise<SandboxCommandExecution>;
  readonly commandYieldMs: number;
}): readonly AgentCheckDefinition[] {
  const checks: AgentCheckDefinition[] = [];
  for (const check of input.plan.checks) {
    checks.push(commandPhaseCheck(check, 'baseline', input));
    checks.push(commandPhaseCheck(check, 'candidate', input));
  }
  return Object.freeze(checks);
}

function commandPhaseCheck(check: AdmittedCodingCheck, phase: 'baseline' | 'candidate', input: Parameters<typeof createAuthoritativeChecks>[0]): AgentCheckDefinition {
  const id = phase === 'baseline' ? baselineCheckId(check.id) : candidateCheckId(check.id);
  return Object.freeze({
    id,
    implementationId: checkImplementationId(check, phase),
    kind: 'effect' as const,
    requirement: phase === 'baseline' ? 'advisory' as const : check.requirement,
    description: `${phase === 'baseline' ? 'Observe the pre-edit baseline with' : 'Verify the exact candidate with'}: ${check.command}`,
    timeoutMs: check.timeoutMs,
    async prepare(context: AgentCheckContext) {
      const baselineResult = phase === 'candidate' ? await readSettledCheck(input.events, context, baselineCheckId(check.id)) : undefined;
      if (phase === 'candidate' && (baselineResult === undefined || baselineResult.verdict === 'unknown')) {
        return unknownObservation(check, 'baseline_result_unavailable', 'The exact baseline command outcome is unavailable.');
      }
      const snapshot = phase === 'baseline' ? input.baseline : await captureWorkspaceSnapshot(input.candidateRoot, context.signal);
      if (snapshot.coverage !== 'complete' || input.baseline.coverage !== 'complete') {
        return unknownObservation(check, 'workspace_snapshot_incomplete', `The ${phase} workspace cannot be captured completely.`, { causes: snapshot.causes });
      }
      const changedDefinitions = phase === 'candidate' ? verifierDefinitionPaths(changedWorkspacePaths(input.baseline, snapshot)) : [];
      if (changedDefinitions.length > 0) {
        return unknownObservation(check, 'verifier_definition_changed', 'The candidate changed an admitted verifier definition, so its result is not comparable with the baseline oracle.', {
          changedVerifierDefinitions: boundedPaths(changedDefinitions)
        });
      }
      const source = phase === 'baseline' ? input.sourceRoot : input.candidateRoot;
      const materializationDirectory = path.join(input.runtimeDirectory, 'verification', sha256(context.runId), sha256(id), snapshot.digest);
      const workspaceDirectory = path.join(materializationDirectory, 'workspace');
      await materializeWorkspaceSnapshot(source, snapshot, workspaceDirectory);
      await mkdir(path.join(materializationDirectory, 'executions'), { recursive: true, mode: 0o700 });
      const workspaceRoot = RootedFileAuthority.adopt(workspaceDirectory);
      let commandExecution: SandboxCommandExecution;
      try {
        commandExecution = await input.createCommandExecution({ root: workspaceRoot, repositoryDirectory: path.join(materializationDirectory, 'executions') });
      } catch (error) { workspaceRoot.close(); throw error; }
      const owner = verificationOwner(context.runId, context.turnId, id);
      const outputTokenBudget = Math.max(64, Math.ceil(check.maxOutputBytes / 4));
      let prepared: PreparedCommandExecution;
      try {
        prepared = await prepareCommandExecution(commandExecution, {
          owner,
          command: check.command,
          rootedDirectory: '.',
          pty: false,
          timeoutMs: check.timeoutMs,
          yieldMs: input.commandYieldMs,
          outputTokenBudget
        });
      } catch (error) {
        await commandExecution.close();
        workspaceRoot.close();
        throw error;
      }
      const processId = commandExecution.executionId(owner);
      const expiresAt = prepared.authorization.expiresAt;
      if (typeof expiresAt !== 'string') {
        await releasePreparedCommandExecution(commandExecution, prepared);
        await commandExecution.close();
        workspaceRoot.close();
        throw new Error(`Sandbox preparation for ${id} has no recovery expiry.`);
      }
      const observe = async (result: CommandExecutionResult, signal: AbortSignal) => commandObservation({
        check,
        phase,
        ...(baselineResult === undefined ? {} : { baselineResult }),
        baseline: input.baseline,
        snapshot,
        result,
        after: await captureWorkspaceSnapshot(workspaceRoot, signal),
        materializationDirectory
      });
      return createAgentPreparedCheckEffect({
        authorization: {
          contract: 'coding-agent.authoritative-command-check@2',
          planImplementationId: input.plan.implementationId,
          checkId: check.id,
          phase,
          command: check.command,
          coverage: check.coverage,
          baselineDigest: input.baseline.digest,
          workspaceDigest: snapshot.digest,
          commandPreparation: prepared.authorization
        },
        recovery: { kind: 'queryable', service: commandExecution.descriptor.recoveryIdentity, reconcilerId: commandExecution.descriptor.implementationId, externalExecutionId: processId, expiresAt },
        start: async (signal) => observe(await completeCommand(commandExecution, prepared, owner, outputTokenBudget, input.commandYieldMs, signal), signal),
        reconcile: async (signal) => {
          if (signal.aborted) throw signal.reason;
          const recovered = await commandExecution.reconcileExecution(owner, outputTokenBudget, input.commandYieldMs);
          return recovered.status !== 'settled' ? recovered : Object.freeze({ status: 'settled' as const, observation: await observe(recovered.result, signal) });
        },
        release: async () => {
          try { await releasePreparedCommandExecution(commandExecution, prepared); }
          finally { try { await commandExecution.close(); } finally { workspaceRoot.close(); } }
        }
      });
    }
  });
}

async function completeCommand(authority: SandboxCommandExecution, prepared: PreparedCommandExecution, owner: CommandExecutionOwner, outputTokenBudget: number, yieldMs: number, signal: AbortSignal): Promise<CommandExecutionResult> {
  let result = await startPreparedCommandExecution(authority, prepared, { signal });
  while (result.status === 'running') {
    if (signal.aborted) throw signal.reason;
    result = await authority.query(result.processId, outputTokenBudget, yieldMs, 0, owner);
  }
  return result;
}

function commandObservation(input: {
  readonly check: AdmittedCodingCheck;
  readonly phase: 'baseline' | 'candidate';
  readonly baselineResult?: AgentCheckResult;
  readonly baseline: WorkspaceSnapshot;
  readonly snapshot: WorkspaceSnapshot;
  readonly result: CommandExecutionResult;
  readonly after: WorkspaceSnapshot;
  readonly materializationDirectory: string;
}): AgentCheckObservation {
  const verifierWorkspaceChanges = changedWorkspacePaths(input.snapshot, input.after);
  const changedDefinitions = verifierDefinitionPaths(verifierWorkspaceChanges);
  if (input.after.coverage !== 'complete' || changedDefinitions.length > 0) {
    return unknownObservation(input.check, 'verifier_self_modified', 'The verifier changed its own definition or its isolated workspace could not be observed completely.', {
      verifierWorkspaceChanges: boundedPaths(verifierWorkspaceChanges),
      changedVerifierDefinitions: boundedPaths(changedDefinitions),
      afterCoverage: input.after.coverage,
      afterCauses: input.after.causes
    });
  }
  if (input.result.status !== 'exited' || input.result.exitCode === undefined) {
    return unknownObservation(input.check, 'check_unavailable', `The ${input.phase} process ended without a trustworthy exit result (${commandTermination(input.result)}).`, { processId: input.result.processId, status: input.result.status });
  }
  const outcome = input.result.exitCode === 0 ? 'passed' : 'failed';
  const signature = failureSignature(input.result, input.materializationDirectory);
  const common = {
    phase: input.phase,
    command: input.check.command,
    coverage: input.check.coverage,
    baselineDigest: input.baseline.digest,
    workspaceDigest: input.snapshot.digest,
    outcome,
    exitCode: input.result.exitCode,
    failureSignature: signature,
    processId: input.result.processId,
    stdout: input.result.stdout.text,
    stderr: input.result.stderr.text,
    stdoutOmittedBytes: input.result.stdout.omittedBytes,
    stderrOmittedBytes: input.result.stderr.omittedBytes,
    outputComplete: input.result.stdout.omittedBytes === 0 && input.result.stderr.omittedBytes === 0,
    verifierWorkspaceChanges: boundedPaths(verifierWorkspaceChanges)
  };
  if (input.phase === 'baseline') {
    return Object.freeze({ verdict: 'passed' as const, summary: `${input.check.command} baseline outcome recorded as ${outcome}.`, output: Object.freeze({ classification: 'baseline_observed', ...common }) });
  }
  const baseline = parseBaselineOutcome(input.baselineResult);
  if (baseline === undefined) return unknownObservation(input.check, 'baseline_result_invalid', 'The baseline result cannot support regression classification.');
  if (outcome === 'passed') {
    return Object.freeze({
      verdict: 'passed' as const,
      summary: baseline.outcome === 'failed' ? `${input.check.command} passed and repairs its pre-existing baseline failure.` : `${input.check.command} passed for the exact candidate.`,
      output: Object.freeze({ classification: baseline.outcome === 'failed' ? 'pre_existing_failure_repaired' : 'candidate_verified', baselineOutcome: baseline.outcome, baselineExitCode: baseline.exitCode, baselineFailureSignature: baseline.failureSignature, ...common })
    });
  }
  if (!baseline.outputComplete || input.result.stdout.omittedBytes > 0 || input.result.stderr.omittedBytes > 0) {
    return unknownObservation(input.check, 'failure_comparison_incomplete', 'A failing baseline or candidate omitted command output, so failure equivalence cannot be established.', {
      baselineOutputComplete: baseline.outputComplete,
      candidateStdoutOmittedBytes: input.result.stdout.omittedBytes,
      candidateStderrOmittedBytes: input.result.stderr.omittedBytes
    });
  }
  const unchangedFailure = baseline.outcome === 'failed' && baseline.exitCode === input.result.exitCode && baseline.failureSignature === signature;
  return Object.freeze({
    verdict: unchangedFailure ? 'passed' as const : 'failed' as const,
    summary: unchangedFailure ? `${input.check.command} retains an evidence-equivalent pre-existing baseline failure.` : `${input.check.command} introduced or changed a failing verification outcome.`,
    output: Object.freeze({ classification: unchangedFailure ? 'pre_existing_failure' : 'candidate_regression', baselineOutcome: baseline.outcome, baselineExitCode: baseline.exitCode, baselineFailureSignature: baseline.failureSignature, ...common })
  });
}

async function readSettledCheck(events: EventRepository<AgentEvent>, context: AgentCheckContext, checkId: string): Promise<AgentCheckResult | undefined> {
  for await (const entry of events.read(context.runId)) {
    const event = entry.event;
    if (event.type === 'check.ended' && event.check === checkId && event.turnIndex === context.turnIndex && event.turnId === context.turnId && event.requestAttempt === context.requestAttempt) return event.result;
  }
  return undefined;
}

function parseBaselineOutcome(result: AgentCheckResult | undefined): { readonly outcome: 'passed' | 'failed'; readonly exitCode: number; readonly failureSignature: string; readonly outputComplete: boolean } | undefined {
  if (result?.verdict !== 'passed' || !record(result.output) || result.output.classification !== 'baseline_observed'
    || (result.output.outcome !== 'passed' && result.output.outcome !== 'failed')
    || typeof result.output.exitCode !== 'number' || !Number.isSafeInteger(result.output.exitCode)
    || typeof result.output.failureSignature !== 'string' || typeof result.output.outputComplete !== 'boolean') return undefined;
  return Object.freeze({ outcome: result.output.outcome, exitCode: result.output.exitCode, failureSignature: result.output.failureSignature, outputComplete: result.output.outputComplete });
}

function unknownObservation(check: Pick<AdmittedCodingCheck, 'command' | 'coverage'>, classification: string, message: string, details: Readonly<Record<string, unknown>> = {}): AgentCheckObservation {
  return Object.freeze({ verdict: 'unknown' as const, summary: `${check.command} is inconclusive: ${message}`, output: Object.freeze({ classification, command: check.command, coverage: check.coverage, ...details }), diagnostic: Object.freeze({ kind: 'unavailable' as const, message }) });
}
function admittedConfiguredCheck(check: CodingAgentCheckConfiguration, requirement: 'required' | 'advisory'): AdmittedCodingCheck {
  return Object.freeze({ id: check.id, command: check.command, coverage: check.coverage, requirement, origin: 'project', timeoutMs: check.timeoutMs ?? 120_000, maxOutputBytes: check.maxOutputBytes ?? 128_000 });
}
function checkImplementationId(check: AdmittedCodingCheck, phase: 'baseline' | 'candidate'): string { return `coding-agent.authoritative-command-check@2:${sha256(JSON.stringify({ ...check, phase }))}`; }
function baselineCheckId(id: string): string { return `${id}:baseline`; }
function candidateCheckId(id: string): string { return `${id}:candidate`; }
function verificationOwner(runId: string, turnId: string, checkId: string): CommandExecutionOwner { return Object.freeze({ runId, turnId, toolBatchId: `verification:${checkId}`, callIndex: 0 }); }
function commandTermination(result: CommandExecutionResult): string { return result.status === 'exited' ? `exit ${String(result.exitCode ?? 'unknown')}` : result.status.replaceAll('_', ' '); }
function boundedPaths(paths: readonly string[]): readonly string[] { return Object.freeze(paths.slice(0, 500)); }
function failureSignature(result: CommandExecutionResult, materializationDirectory: string): string {
  const ansiColorSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu');
  const text = `${result.stdout.text}\n${result.stderr.text}`
    .replaceAll(materializationDirectory, '<verification>')
    .replaceAll(ansiColorSequence, '')
    .replaceAll(/\b\d+(?:\.\d+)?\s*(?:ms|s|seconds?)\b/giu, '<duration>')
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .slice(-64_000);
  return sha256(`${String(result.exitCode)}\n${text}`);
}
export function verifierDefinitionPaths(paths: readonly string[]): readonly string[] { return Object.freeze(paths.filter(isVerifierDefinitionPath)); }
function isVerifierDefinitionPath(filePath: string): boolean {
  const name = filePath.split('/').at(-1) ?? filePath;
  return filePath === 'coding-agent.config.json'
    || filePath.startsWith('.github/workflows/')
    || /^(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|deno\.jsonc?|tsconfig(?:\.[^.]+)?\.json)$/u.test(name)
    || /^(?:eslint|jest|vitest|vite|webpack|rollup|biome|ava|mocha|playwright|cypress)(?:\.config)?\./u.test(name)
    || /(?:^|\/)(?:test|tests|spec|specs|__tests__)(?:\/|$)/u.test(filePath)
    || /(?:\.test|\.spec)\.[^/]+$/u.test(name);
}
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

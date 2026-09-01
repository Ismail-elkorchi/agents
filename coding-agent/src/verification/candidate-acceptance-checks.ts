import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseJsonValue } from '@agent-core/json';
import {
  createAgentCheckEffectPlan,
  type AgentCheckContext,
  type AgentCheckDefinition,
  type AgentCheckObservation
} from '@agent-core/runtime';
import {
  planCommandExecution,
  releaseCommandExecutionPlan,
  startCommandExecutionPlan,
  type CommandExecutionOwner,
  type CommandExecutionPlan,
  type CommandExecutionResult
} from '@agent-core/tools';
import {
  RootedFileAuthority,
  captureWorkspaceSnapshot,
  changedWorkspacePaths,
  type WorkspaceSnapshot
} from '@agent-core/tools-local';
import { restoreWorkspaceSnapshot } from '../changes/isolated-working-copy.js';
import type { SandboxCommandExecution } from '../execution/sandbox-command-execution.js';

export interface VerificationCheckProposal {
  readonly id: string;
  readonly command: string;
  readonly coverage: 'targeted' | 'full';
  readonly requirement: 'required' | 'advisory';
  readonly source: 'active-project-config' | 'manifest-inference';
  readonly sourceId: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export type AdmittedCodingCheck = VerificationCheckProposal;

export interface AdmittedCodingCheckPlan {
  readonly implementationId: string;
  readonly checks: readonly AdmittedCodingCheck[];
  readonly requiredCoverage: 'admitted' | 'missing';
}

export interface PreChangeCommandObservation {
  readonly checkId: string;
  readonly command: string;
  readonly preChangeSnapshotDigest: string;
  readonly outcome: 'passed' | 'failed' | 'unknown';
  readonly exitCode?: number;
  readonly failureSignature?: string;
  readonly outputComplete: boolean;
  readonly summary: string;
}

interface CommandRunnerInput {
  readonly runId: string;
  readonly root: RootedFileAuthority;
  readonly snapshot: WorkspaceSnapshot;
  readonly runtimeDirectory: string;
  readonly createCommandExecution: (input: { readonly root: RootedFileAuthority; readonly repositoryDirectory: string }) => Promise<SandboxCommandExecution>;
  readonly commandYieldMs: number;
}

/** Admits typed, already-authorized check proposals into one immutable run plan. */
export function deriveAdmittedCheckPlan(proposals: readonly VerificationCheckProposal[]): AdmittedCodingCheckPlan {
  const checks: AdmittedCodingCheck[] = [];
  const commands = new Set<string>();
  for (const proposal of proposals) {
    if (commands.has(proposal.command)) continue;
    checks.push(Object.freeze({ ...proposal }));
    commands.add(proposal.command);
  }
  const implementationId = `coding-agent.check-plan@2:${sha256(JSON.stringify(checks))}`;
  return Object.freeze({
    implementationId,
    checks: Object.freeze(checks),
    requiredCoverage: checks.some((check) => check.requirement === 'required') ? 'admitted' : 'missing'
  });
}

/** Runs immutable pre-change references. These observations are not acceptance checks. */
export async function observePreChangeCommands(input: CommandRunnerInput & {
  readonly plan: AdmittedCodingCheckPlan;
}): Promise<readonly PreChangeCommandObservation[]> {
  const observations: PreChangeCommandObservation[] = [];
  for (const check of input.plan.checks) {
    observations.push(await observePreChangeCommand(check, input));
  }
  return Object.freeze(observations);
}

/** Creates only checks whose verdict can accept or reject the changed working copy. */
export function createCandidateAcceptanceChecks(input: Omit<CommandRunnerInput, 'snapshot'> & {
  readonly plan: AdmittedCodingCheckPlan;
  readonly preChange: WorkspaceSnapshot;
  readonly preChangeObservations: readonly PreChangeCommandObservation[];
}): readonly AgentCheckDefinition[] {
  const references = new Map(input.preChangeObservations.map((observation) => [observation.checkId, observation]));
  return Object.freeze(input.plan.checks.map((check) => candidateAcceptanceCheck(check, references.get(check.id), input)));
}

async function observePreChangeCommand(
  check: AdmittedCodingCheck,
  input: CommandRunnerInput & { readonly plan: AdmittedCodingCheckPlan }
): Promise<PreChangeCommandObservation> {
  if (input.snapshot.coverage !== 'complete') {
    return unknownPreChange(check, input.snapshot.digest, `The pre-change snapshot is incomplete: ${input.snapshot.causes.join(', ')}.`);
  }
  let executed: Awaited<ReturnType<typeof executeCommand>>;
  try {
    executed = await executeCommand({
      check,
      phase: 'pre-change',
      runId: input.runId,
      root: input.root,
      snapshot: input.snapshot,
      runtimeDirectory: input.runtimeDirectory,
      createCommandExecution: input.createCommandExecution,
      commandYieldMs: input.commandYieldMs
    });
  } catch (error) {
    return unknownPreChange(check, input.snapshot.digest, `The pre-change command could not be observed: ${errorMessage(error)}`);
  }
  if (executed.after.coverage !== 'complete' || verifierDefinitionPaths(changedWorkspacePaths(input.snapshot, executed.after)).length > 0) {
    return unknownPreChange(check, input.snapshot.digest, 'The reference command changed its verifier definition or its isolated workspace could not be observed completely.');
  }
  if (executed.result.status !== 'exited' || typeof executed.result.exitCode !== 'number') {
    return unknownPreChange(check, input.snapshot.digest, `The reference command ended without a trustworthy exit result (${commandTermination(executed.result)}).`);
  }
  const outcome = executed.result.exitCode === 0 ? 'passed' : 'failed';
  return Object.freeze({
    checkId: check.id,
    command: check.command,
    preChangeSnapshotDigest: input.snapshot.digest,
    outcome,
    exitCode: executed.result.exitCode,
    failureSignature: failureSignature(executed.result, executed.materializationDirectory),
    outputComplete: outputComplete(executed.result),
    summary: `${check.command} pre-change outcome was ${outcome}.`
  });
}

function candidateAcceptanceCheck(
  check: AdmittedCodingCheck,
  reference: PreChangeCommandObservation | undefined,
  input: Parameters<typeof createCandidateAcceptanceChecks>[0]
): AgentCheckDefinition {
  const id = candidateAcceptanceCheckId(check.id);
  return Object.freeze({
    id,
    implementationId: checkImplementationId(check),
    kind: 'effect' as const,
    requirement: check.requirement,
    description: `Verify the changed working copy with: ${check.command}`,
    timeoutMs: check.timeoutMs,
    async planEffect(context: AgentCheckContext) {
      if (reference?.preChangeSnapshotDigest !== input.preChange.digest || reference.outcome === 'unknown') {
        return unknownObservation(check, 'pre_change_observation_unavailable', 'The exact pre-change command observation is unavailable.');
      }
      const snapshot = await captureWorkspaceSnapshot(input.root, context.signal);
      if (snapshot.coverage !== 'complete' || input.preChange.coverage !== 'complete') {
        return unknownObservation(check, 'workspace_snapshot_incomplete', 'The changed working copy cannot be captured completely.', { causes: snapshot.causes });
      }
      const changedDefinitions = verifierDefinitionPaths(changedWorkspacePaths(input.preChange, snapshot));
      if (changedDefinitions.length > 0) {
        return unknownObservation(check, 'verifier_definition_changed', 'The working copy changed an admitted verifier definition, so its result is not comparable with the pre-change observation.', {
          changedVerifierDefinitions: boundedPaths(changedDefinitions)
        });
      }
      const execution = await planExecution(check, context.runId, context.turnId, id, input.root, snapshot, input.runtimeDirectory, input.createCommandExecution, input.commandYieldMs);
      const observe = async (result: CommandExecutionResult, signal: AbortSignal) => candidateObservation({
        check,
        reference,
        preChange: input.preChange,
        snapshot,
        result,
        after: await captureWorkspaceSnapshot(execution.workspaceRoot, signal),
        materializationDirectory: execution.materializationDirectory
      });
      return createAgentCheckEffectPlan({
        authorization: parseJsonValue({
          contract: 'coding-agent.candidate-acceptance-command@1',
          planImplementationId: input.plan.implementationId,
          checkId: check.id,
          command: check.command,
          coverage: check.coverage,
          preChangeSnapshotDigest: input.preChange.digest,
          workingCopyDigest: snapshot.digest,
          preChangeObservation: { ...reference },
          commandPlan: execution.commandPlan.authorization
        }),
        recovery: {
          kind: 'queryable',
          service: execution.commandExecution.descriptor.recoveryIdentity,
          reconcilerId: execution.commandExecution.descriptor.implementationId,
          externalExecutionId: execution.processId,
          expiresAt: execution.expiresAt
        },
        start: async (signal) => observe(await completeCommand(execution.commandExecution, execution.commandPlan, execution.owner, execution.outputTokenBudget, input.commandYieldMs, signal), signal),
        reconcile: async (signal) => {
          if (signal.aborted) throw signal.reason;
          const recovered = await execution.commandExecution.reconcileExecution(execution.owner, execution.outputTokenBudget, input.commandYieldMs);
          return recovered.status !== 'settled' ? recovered : Object.freeze({ status: 'settled' as const, observation: await observe(recovered.result, signal) });
        },
        release: () => releaseExecution(execution)
      });
    }
  });
}

async function executeCommand(input: {
  readonly check: AdmittedCodingCheck;
  readonly phase: 'pre-change';
  readonly runId: string;
  readonly root: RootedFileAuthority;
  readonly snapshot: WorkspaceSnapshot;
  readonly runtimeDirectory: string;
  readonly createCommandExecution: CommandRunnerInput['createCommandExecution'];
  readonly commandYieldMs: number;
}) {
  const execution = await planExecution(input.check, input.runId, `pre-change-${sha256(input.check.id).slice(0, 16)}`, `${input.check.id}:pre-change`, input.root, input.snapshot, input.runtimeDirectory, input.createCommandExecution, input.commandYieldMs);
  try {
    const result = await completeCommand(execution.commandExecution, execution.commandPlan, execution.owner, execution.outputTokenBudget, input.commandYieldMs, new AbortController().signal);
    return Object.freeze({ result, after: await captureWorkspaceSnapshot(execution.workspaceRoot), materializationDirectory: execution.materializationDirectory });
  } finally {
    await releaseExecution(execution);
  }
}

async function planExecution(
  check: AdmittedCodingCheck,
  runId: string,
  turnId: string,
  executionKey: string,
  source: RootedFileAuthority,
  snapshot: WorkspaceSnapshot,
  runtimeDirectory: string,
  createCommandExecution: CommandRunnerInput['createCommandExecution'],
  commandYieldMs: number
) {
  const materializationDirectory = path.join(runtimeDirectory, 'verification', sha256(runId), sha256(executionKey), snapshot.digest);
  const workspaceDirectory = path.join(materializationDirectory, 'workspace');
  await restoreWorkspaceSnapshot(source, snapshot, workspaceDirectory);
  await mkdir(path.join(materializationDirectory, 'executions'), { recursive: true, mode: 0o700 });
  const workspaceRoot = RootedFileAuthority.adopt(workspaceDirectory);
  let commandExecution: SandboxCommandExecution;
  try {
    commandExecution = await createCommandExecution({ root: workspaceRoot, repositoryDirectory: path.join(materializationDirectory, 'executions') });
  } catch (error) {
    workspaceRoot.close();
    throw error;
  }
  const owner = verificationOwner(runId, turnId, executionKey);
  const outputTokenBudget = Math.max(64, Math.ceil(check.maxOutputBytes / 4));
  let commandPlan: CommandExecutionPlan;
  try {
    commandPlan = await planCommandExecution(commandExecution, {
      owner,
      command: check.command,
      rootedDirectory: '.',
      pty: false,
      timeoutMs: check.timeoutMs,
      yieldMs: commandYieldMs,
      outputTokenBudget
    });
  } catch (error) {
    await commandExecution.close();
    workspaceRoot.close();
    throw error;
  }
  const expiresAt = commandPlan.authorization.expiresAt;
  if (typeof expiresAt !== 'string') {
    await releaseCommandExecutionPlan(commandExecution, commandPlan);
    await commandExecution.close();
    workspaceRoot.close();
    throw new Error(`Sandbox command plan for ${executionKey} has no recovery expiry.`);
  }
  return Object.freeze({
    commandExecution,
    commandPlan,
    owner,
    outputTokenBudget,
    processId: commandExecution.executionId(owner),
    expiresAt,
    workspaceRoot,
    materializationDirectory
  });
}

async function releaseExecution(execution: Awaited<ReturnType<typeof planExecution>>): Promise<void> {
  try {
    await releaseCommandExecutionPlan(execution.commandExecution, execution.commandPlan);
  } finally {
    try { await execution.commandExecution.close(); }
    finally { execution.workspaceRoot.close(); }
  }
}

async function completeCommand(authority: SandboxCommandExecution, commandPlan: CommandExecutionPlan, owner: CommandExecutionOwner, outputTokenBudget: number, yieldMs: number, signal: AbortSignal): Promise<CommandExecutionResult> {
  let result = await startCommandExecutionPlan(authority, commandPlan, { signal });
  while (result.status === 'running') {
    if (signal.aborted) throw signal.reason;
    result = await authority.query(result.processId, outputTokenBudget, yieldMs, 0, owner);
  }
  return result;
}

function candidateObservation(input: {
  readonly check: AdmittedCodingCheck;
  readonly reference: PreChangeCommandObservation;
  readonly preChange: WorkspaceSnapshot;
  readonly snapshot: WorkspaceSnapshot;
  readonly result: CommandExecutionResult;
  readonly after: WorkspaceSnapshot;
  readonly materializationDirectory: string;
}): AgentCheckObservation {
  const changedDefinitions = verifierDefinitionPaths(changedWorkspacePaths(input.snapshot, input.after));
  if (input.after.coverage !== 'complete' || changedDefinitions.length > 0) {
    return unknownObservation(input.check, 'verifier_self_modified', 'The verifier changed its own definition or its isolated workspace could not be observed completely.', {
      changedVerifierDefinitions: boundedPaths(changedDefinitions),
      afterCoverage: input.after.coverage,
      afterCauses: input.after.causes
    });
  }
  if (input.result.status !== 'exited' || typeof input.result.exitCode !== 'number') {
    return unknownObservation(input.check, 'check_unavailable', `The acceptance command ended without a trustworthy exit result (${commandTermination(input.result)}).`);
  }
  const outcome = input.result.exitCode === 0 ? 'passed' : 'failed';
  const signature = failureSignature(input.result, input.materializationDirectory);
  const common = {
    command: input.check.command,
    coverage: input.check.coverage,
    preChangeSnapshotDigest: input.preChange.digest,
    workingCopyDigest: input.snapshot.digest,
    outcome,
    exitCode: input.result.exitCode,
    failureSignature: signature,
    processId: input.result.processId,
    stdout: input.result.stdout.text,
    stderr: input.result.stderr.text,
    stdoutOmittedBytes: input.result.stdout.omittedBytes,
    stderrOmittedBytes: input.result.stderr.omittedBytes,
    outputComplete: outputComplete(input.result),
    verifierWorkspaceChanges: boundedPaths(changedWorkspacePaths(input.snapshot, input.after))
  };
  if (outcome === 'passed') {
    return Object.freeze({
      verdict: 'passed' as const,
      summary: input.reference.outcome === 'failed' ? `${input.check.command} passed and repairs its pre-existing failure.` : `${input.check.command} passed for the changed working copy.`,
      output: Object.freeze({ classification: input.reference.outcome === 'failed' ? 'pre_existing_failure_repaired' : 'working_copy_verified', preChangeObservation: input.reference, ...common })
    });
  }
  if (!input.reference.outputComplete || !outputComplete(input.result)) {
    return unknownObservation(input.check, 'failure_comparison_incomplete', 'A failing pre-change or post-change command omitted output, so failure equivalence cannot be established.');
  }
  const unchangedFailure = input.reference.outcome === 'failed'
    && input.reference.exitCode === input.result.exitCode
    && input.reference.failureSignature === signature;
  return Object.freeze({
    verdict: unchangedFailure ? 'passed' as const : 'failed' as const,
    summary: unchangedFailure ? `${input.check.command} retains an equivalent pre-existing failure.` : `${input.check.command} introduced or changed a failing verification outcome.`,
    output: Object.freeze({ classification: unchangedFailure ? 'pre_existing_failure' : 'working_copy_regression', preChangeObservation: input.reference, ...common })
  });
}

function unknownPreChange(check: AdmittedCodingCheck, digest: string, message: string): PreChangeCommandObservation {
  return Object.freeze({ checkId: check.id, command: check.command, preChangeSnapshotDigest: digest, outcome: 'unknown', outputComplete: false, summary: message });
}

function unknownObservation(check: Pick<AdmittedCodingCheck, 'command' | 'coverage'>, classification: string, message: string, details: Readonly<Record<string, unknown>> = {}): AgentCheckObservation {
  return Object.freeze({ verdict: 'unknown' as const, summary: `${check.command} is inconclusive: ${message}`, output: Object.freeze({ classification, command: check.command, coverage: check.coverage, ...details }), diagnostic: Object.freeze({ kind: 'unavailable' as const, message }) });
}

function checkImplementationId(check: AdmittedCodingCheck): string {
  return `coding-agent.candidate-acceptance-command@1:${sha256(JSON.stringify(check))}`;
}
function candidateAcceptanceCheckId(id: string): string { return `${id}:working-copy`; }
function verificationOwner(runId: string, turnId: string, checkId: string): CommandExecutionOwner { return Object.freeze({ runId, turnId, toolBatchId: `verification:${checkId}`, callIndex: 0 }); }
function commandTermination(result: CommandExecutionResult): string { return result.status === 'exited' ? `exit ${String(result.exitCode ?? 'unknown')}` : result.status.replaceAll('_', ' '); }
function outputComplete(result: CommandExecutionResult): boolean { return result.stdout.omittedBytes === 0 && result.stderr.omittedBytes === 0; }
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
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
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

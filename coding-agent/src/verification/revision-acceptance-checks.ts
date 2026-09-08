import { NO_EFFECT_EXPOSURE, knownEffectExposure } from '@agent-core/effects';
import { parseJsonObject } from '@agent-core/json';
import { EffectExecutor } from '@agent-core/runtime';
import { CodingCommandUnavailableError } from '../execution/coding-command-authority.js';
import { decodePreChangeCommandObservation } from './pre-change-observation-codec.js';

import { parseJsonValue } from '@agent-core/json';
import { hashJson } from '@agent-core/persistence';
import {
  createCheckEffectPlan,
  type CheckContext,
  type CheckDefinition,
  type CheckObservation
} from '@agents/verification';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

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
  readonly verifierInputs?: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface CodingVerifierContract {
  readonly kind: 'independent';
  readonly implementationId: string;
  readonly environmentPolicyId: string;
  readonly observationReuse: 'invocation';
  readonly inputs: readonly { readonly path: string; readonly sha256: string }[];
}
export interface AdmittedCodingCheck extends VerificationCheckProposal {
  readonly verifier: CodingVerifierContract | { readonly kind: 'observational' };
}

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
  readonly outputSha256?: string;
  readonly checkImplementationId: string;
  readonly outputComplete: boolean;
  readonly summary: string;
}

interface CommandRunnerInput {
  readonly runId: string;
  readonly root: RootedFileAuthority;
  readonly snapshot: WorkspaceSnapshot;
  readonly runtimeDirectory: string;
  readonly createCommandExecution: (input: {
    readonly root: RootedFileAuthority;
    readonly repositoryDirectory: string;
  }) => Promise<SandboxCommandExecution>;
  readonly commandYieldMs: number;
}

/** Admits typed, already-authorized check proposals into one immutable work contract. */
export function deriveAdmittedCheckPlan(
  proposals: readonly VerificationCheckProposal[],
  admission?: { readonly snapshot: WorkspaceSnapshot; readonly environmentPolicyId: string }
): AdmittedCodingCheckPlan {
  const checks: AdmittedCodingCheck[] = [];
  const commands = new Set<string>();
  for (const proposal of proposals) {
    if (commands.has(proposal.command)) continue;
    const verifier =
      admission && proposal.verifierInputs !== undefined
        ? admitVerifier(proposal, admission)
        : Object.freeze({ kind: 'observational' as const });
    checks.push(Object.freeze({ ...proposal, verifier }));
    commands.add(proposal.command);
  }
  const implementationId = `coding-agent.check-plan@3:${hashJson(checks)}`;
  return Object.freeze({
    implementationId,
    checks: Object.freeze(checks),
    requiredCoverage: checks.some((check) => check.requirement === 'required') ? 'admitted' : 'missing'
  });
}

/** Runs immutable pre-change references. These observations are not acceptance checks. */
export async function observePreChangeCommands(
  input: CommandRunnerInput & {
    readonly effects: EffectExecutor;
    readonly ownerId: string;
    readonly signal?: AbortSignal;
    readonly plan: AdmittedCodingCheckPlan;
  }
): Promise<readonly PreChangeCommandObservation[]> {
  const observations: PreChangeCommandObservation[] = [];
  for (const check of input.plan.checks) {
    observations.push(await observePreChangeCommand(check, input));
  }
  return Object.freeze(observations);
}

/** Creates only checks whose verdict can accept or reject the changed working copy. */
export function createRevisionAcceptanceChecks(
  input: Omit<CommandRunnerInput, 'snapshot'> & {
    readonly plan: AdmittedCodingCheckPlan;
    readonly preChange: WorkspaceSnapshot;
    readonly preChangeObservations: readonly PreChangeCommandObservation[];
  }
): readonly CheckDefinition[] {
  const references = new Map(
    input.preChangeObservations.map((observation) => [observation.checkId, observation])
  );
  return Object.freeze(
    input.plan.checks.map((check) => revisionAcceptanceCheck(check, references.get(check.id), input))
  );
}

async function observePreChangeCommand(
  check: AdmittedCodingCheck,
  input: Parameters<typeof observePreChangeCommands>[0]
): Promise<PreChangeCommandObservation> {
  if (input.snapshot.coverage !== 'complete')
    return unknownPreChange(
      check,
      input.snapshot.digest,
      `The pre-change snapshot is incomplete: ${input.snapshot.causes.join(', ')}.`
    );
  let execution: Awaited<ReturnType<typeof planExecution>>;
  try {
    execution = await planExecution(
      check,
      input.runId,
      `pre-change-${sha256(check.id).slice(0, 16)}`,
      `${check.id}:pre-change`,
      input.root,
      input.snapshot,
      input.runtimeDirectory,
      input.createCommandExecution,
      input.commandYieldMs
    );
  } catch (error) {
    if (error instanceof CodingCommandUnavailableError)
      return unknownPreChange(check, input.snapshot.digest, error.message);
    throw error;
  }
  const observe = async (
    result: CommandExecutionResult,
    signal: AbortSignal
  ): Promise<PreChangeCommandObservation> => {
    const after = await captureWorkspaceSnapshot(execution.workspaceRoot, signal);
    if (after.coverage !== 'complete' || changedVerifierInputs(check, after).length > 0)
      return unknownPreChange(
        check,
        input.snapshot.digest,
        'The reference command changed an admitted verifier input or its workspace coverage is incomplete.'
      );
    if (result.status !== 'exited' || typeof result.exitCode !== 'number')
      return unknownPreChange(
        check,
        input.snapshot.digest,
        `The reference command has no trustworthy exit result (${commandTermination(result)}).`
      );
    const outcome = result.exitCode === 0 ? 'passed' : 'failed';
    return Object.freeze({
      checkId: check.id,
      command: check.command,
      preChangeSnapshotDigest: input.snapshot.digest,
      checkImplementationId: checkImplementationId(check),
      outcome,
      exitCode: result.exitCode,
      outputSha256: commandOutputIdentity(result),
      outputComplete: outputComplete(result),
      summary: `${check.command} pre-change outcome was ${outcome}.`
    });
  };
  try {
    const result = await input.effects.execute<PreChangeCommandObservation>(
      {
        intent: {
          effectId: `coding-baseline:${hashJson({ workOwner: input.ownerId, runId: input.runId, checkId: check.id })}`,
          ownerId: input.ownerId,
          implementationId: checkImplementationId(check),
          parametersDigest: hashJson({
            snapshot: input.snapshot.digest,
            command: execution.commandPlan.authorization
          }),
          recovery: {
            kind: 'queryable',
            service: execution.commandExecution.descriptor.recoveryIdentity,
            reconcilerId: execution.commandExecution.descriptor.implementationId,
            externalExecutionId: execution.processId,
            expiresAt: execution.expiresAt
          },
          exposure: NO_EFFECT_EXPOSURE
        },
        codec: {
          encode: parseJsonObject,
          decode: (value) => decodePreChangeCommandObservation(value, check, input.snapshot.digest)
        },
        exposure: () => knownEffectExposure([]),
        start: async (signal) =>
          observe(
            await completeCommand(
              execution.commandExecution,
              execution.commandPlan,
              execution.owner,
              execution.outputTokenBudget,
              input.commandYieldMs,
              signal
            ),
            signal
          ),
        reconcile: async (signal) => {
          const recovered = await execution.commandExecution.reconcileExecution(
            execution.owner,
            execution.outputTokenBudget,
            input.commandYieldMs
          );
          return recovered.status === 'settled'
            ? { status: 'settled', observation: await observe(recovered.result, signal) }
            : recovered;
        }
      },
      input.signal
    );
    return result.status === 'settled'
      ? result.observation
      : unknownPreChange(
          check,
          input.snapshot.digest,
          `Reference command requires reconciliation: ${result.status}.`
        );
  } finally {
    await releaseExecution(execution);
  }
}

function revisionAcceptanceCheck(
  check: AdmittedCodingCheck,
  reference: PreChangeCommandObservation | undefined,
  input: Parameters<typeof createRevisionAcceptanceChecks>[0]
): CheckDefinition {
  const id = revisionAcceptanceCheckId(check.id);
  return Object.freeze({
    id,
    implementationId: checkImplementationId(check),
    kind: 'effect' as const,
    requirement: check.requirement,
    description: `Verify the changed working copy with: ${check.command}`,
    timeoutMs: check.timeoutMs,
    async planEffect(context: CheckContext) {
      if (
        reference?.preChangeSnapshotDigest !== input.preChange.digest ||
        reference.checkImplementationId !== checkImplementationId(check) ||
        reference.outcome === 'unknown'
      ) {
        return unknownObservation(
          check,
          'pre_change_observation_unavailable',
          'The exact pre-change command observation is unavailable.'
        );
      }
      const snapshot = await captureWorkspaceSnapshot(input.root, context.signal);
      if (snapshot.coverage !== 'complete' || input.preChange.coverage !== 'complete') {
        return unknownObservation(
          check,
          'workspace_snapshot_incomplete',
          'The changed working copy cannot be captured completely.',
          { causes: snapshot.causes }
        );
      }
      const changedDefinitions = changedVerifierInputs(check, snapshot);
      if (changedDefinitions.length > 0) {
        return unknownObservation(
          check,
          'verifier_definition_changed',
          'The working copy changed an admitted verifier definition, so its result is not comparable with the pre-change observation.',
          {
            changedVerifierDefinitions: boundedPaths(changedDefinitions)
          }
        );
      }
      const execution = await planExecution(
        check,
        context.runId,
        context.turnId,
        id,
        input.root,
        snapshot,
        input.runtimeDirectory,
        input.createCommandExecution,
        input.commandYieldMs
      );
      const observe = async (result: CommandExecutionResult, signal: AbortSignal) =>
        revisionObservation({
          check,
          reference,
          preChange: input.preChange,
          snapshot,
          result,
          after: await captureWorkspaceSnapshot(execution.workspaceRoot, signal),
          materializationDirectory: execution.materializationDirectory
        });
      return createCheckEffectPlan({
        authorization: parseJsonValue({
          contract: 'coding-agent.revision-acceptance-command@1',
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
        start: async (signal) =>
          observe(
            await completeCommand(
              execution.commandExecution,
              execution.commandPlan,
              execution.owner,
              execution.outputTokenBudget,
              input.commandYieldMs,
              signal
            ),
            signal
          ),
        reconcile: async (signal) => {
          if (signal.aborted) throw signal.reason;
          const recovered = await execution.commandExecution.reconcileExecution(
            execution.owner,
            execution.outputTokenBudget,
            input.commandYieldMs
          );
          return recovered.status !== 'settled'
            ? recovered
            : Object.freeze({
                status: 'settled' as const,
                observation: await observe(recovered.result, signal)
              });
        },
        release: () => releaseExecution(execution)
      });
    }
  });
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
  const materializationDirectory = path.join(
    runtimeDirectory,
    'verification',
    sha256(runId),
    sha256(executionKey),
    snapshot.digest
  );
  const workspaceDirectory = path.join(materializationDirectory, 'workspace');
  await restoreWorkspaceSnapshot(source, snapshot, workspaceDirectory);
  await mkdir(path.join(materializationDirectory, 'executions'), { recursive: true, mode: 0o700 });
  const workspaceRoot = RootedFileAuthority.adopt(workspaceDirectory);
  let commandExecution: SandboxCommandExecution;
  try {
    commandExecution = await createCommandExecution({
      root: workspaceRoot,
      repositoryDirectory: path.join(materializationDirectory, 'executions')
    });
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
    try {
      await execution.commandExecution.close();
    } finally {
      execution.workspaceRoot.close();
    }
  }
}

async function completeCommand(
  authority: SandboxCommandExecution,
  commandPlan: CommandExecutionPlan,
  owner: CommandExecutionOwner,
  outputTokenBudget: number,
  yieldMs: number,
  signal: AbortSignal
): Promise<CommandExecutionResult> {
  let result = await startCommandExecutionPlan(authority, commandPlan, { signal });
  while (result.status === 'running') {
    if (signal.aborted) throw signal.reason;
    result = await authority.query(result.processId, outputTokenBudget, yieldMs, 0, owner);
  }
  return result;
}

function revisionObservation(input: {
  readonly check: AdmittedCodingCheck;
  readonly reference: PreChangeCommandObservation;
  readonly preChange: WorkspaceSnapshot;
  readonly snapshot: WorkspaceSnapshot;
  readonly result: CommandExecutionResult;
  readonly after: WorkspaceSnapshot;
  readonly materializationDirectory: string;
}): CheckObservation {
  const changedDefinitions = changedVerifierInputs(input.check, input.after);
  if (input.after.coverage !== 'complete' || changedDefinitions.length > 0) {
    return unknownObservation(
      input.check,
      'verifier_self_modified',
      'The verifier changed its own definition or its isolated workspace could not be observed completely.',
      {
        changedVerifierDefinitions: boundedPaths(changedDefinitions),
        afterCoverage: input.after.coverage,
        afterCauses: input.after.causes
      }
    );
  }
  if (input.result.status !== 'exited' || typeof input.result.exitCode !== 'number') {
    return unknownObservation(
      input.check,
      'check_unavailable',
      `The acceptance command ended without a trustworthy exit result (${commandTermination(input.result)}).`
    );
  }
  const outcome = input.result.exitCode === 0 ? 'passed' : 'failed';
  const outputSha256 = commandOutputIdentity(input.result);
  const common = {
    command: input.check.command,
    coverage: input.check.coverage,
    preChangeSnapshotDigest: input.preChange.digest,
    workingCopyDigest: input.snapshot.digest,
    outcome,
    exitCode: input.result.exitCode,
    outputSha256,
    verifier: input.check.verifier,
    processId: input.result.processId,
    stdout: input.result.stdout.text,
    stderr: input.result.stderr.text,
    stdoutOmittedBytes: input.result.stdout.omittedBytes,
    stderrOmittedBytes: input.result.stderr.omittedBytes,
    outputComplete: outputComplete(input.result),
    verifierWorkspaceChanges: boundedPaths(changedWorkspacePaths(input.snapshot, input.after))
  };
  const complete = outputComplete(input.result);
  const baselineComparison =
    input.reference.outputComplete && complete
      ? input.reference.outputSha256 === outputSha256
        ? 'identical_recorded_output'
        : 'different_recorded_output'
      : 'incomplete';
  const acceptance =
    outcome === 'passed' && complete && input.check.verifier.kind === 'independent'
      ? 'satisfied'
      : outcome === 'failed' && input.reference.outcome === 'passed'
        ? 'failed'
        : 'inconclusive';
  return Object.freeze({
    verdict:
      acceptance === 'satisfied'
        ? ('passed' as const)
        : acceptance === 'failed'
          ? ('failed' as const)
          : ('unknown' as const),
    summary: `${input.check.command} ${outcome}; application acceptance is ${acceptance}.`,
    output: Object.freeze({
      ...common,
      baselineComparison,
      observedCoverage: outcome === 'passed' && complete ? input.check.coverage : 'incomplete',
      acceptance,
      preChangeObservation: input.reference
    })
  });
}

function unknownPreChange(
  check: AdmittedCodingCheck,
  digest: string,
  message: string
): PreChangeCommandObservation {
  return Object.freeze({
    checkId: check.id,
    command: check.command,
    checkImplementationId: checkImplementationId(check),
    preChangeSnapshotDigest: digest,
    outcome: 'unknown',
    outputComplete: false,
    summary: message
  });
}

function unknownObservation(
  check: Pick<AdmittedCodingCheck, 'command' | 'coverage'>,
  classification: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {}
): CheckObservation {
  return Object.freeze({
    verdict: 'unknown' as const,
    summary: `${check.command} is inconclusive: ${message}`,
    output: Object.freeze({ classification, command: check.command, coverage: check.coverage, ...details }),
    diagnostic: Object.freeze({ kind: 'unavailable' as const, message })
  });
}

function checkImplementationId(check: AdmittedCodingCheck): string {
  return `coding-agent.revision-acceptance-command@1:${hashJson(check)}`;
}
function revisionAcceptanceCheckId(id: string): string {
  return `${id}:working-copy`;
}
function verificationOwner(runId: string, turnId: string, checkId: string): CommandExecutionOwner {
  return Object.freeze({
    ownerId: runId,
    runId,
    turnId,
    toolBatchId: `verification:${checkId}`,
    callIndex: 0
  });
}
function commandTermination(result: CommandExecutionResult): string {
  return result.status === 'exited'
    ? `exit ${String(result.exitCode ?? 'unknown')}`
    : result.status.replaceAll('_', ' ');
}
function outputComplete(result: CommandExecutionResult): boolean {
  return [result.stdout, result.stderr].every(
    (output) =>
      output.omittedBytes === 0 &&
      output.startsAtOutputStart &&
      output.endsAtOutputEnd &&
      output.observedBytes === output.capturedBytes
  );
}
function boundedPaths(paths: readonly string[]): readonly string[] {
  return Object.freeze(paths.slice(0, 500));
}
function commandOutputIdentity(result: CommandExecutionResult): string {
  return sha256(
    JSON.stringify({
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout.text,
      stderr: result.stderr.text,
      stdoutOmittedBytes: result.stdout.omittedBytes,
      stderrOmittedBytes: result.stderr.omittedBytes
    })
  );
}
function admitVerifier(
  proposal: VerificationCheckProposal,
  admission: { readonly snapshot: WorkspaceSnapshot; readonly environmentPolicyId: string }
): CodingVerifierContract {
  const paths = proposal.verifierInputs ?? [];
  if (paths.length === 0 || new Set(paths).size !== paths.length)
    throw new Error('Independent verification requires distinct, explicitly admitted verifier inputs.');
  const inputs = paths.map((path) => {
    const entry = admission.snapshot.entries.find((entry) => entry.path === path);
    if (!entry?.sha256) throw new Error(`Admitted verifier input is unavailable: ${path}`);
    return Object.freeze({ path, sha256: entry.sha256 });
  });
  return Object.freeze({
    kind: 'independent',
    implementationId: `coding-agent.verifier@1:${sha256(JSON.stringify({ command: proposal.command, inputs }))}`,
    environmentPolicyId: admission.environmentPolicyId,
    observationReuse: 'invocation',
    inputs: Object.freeze(inputs)
  });
}

function changedVerifierInputs(check: AdmittedCodingCheck, snapshot: WorkspaceSnapshot): readonly string[] {
  return check.verifier.kind === 'observational'
    ? []
    : check.verifier.inputs
        .filter(
          (input) => snapshot.entries.find((entry) => entry.path === input.path)?.sha256 !== input.sha256
        )
        .map((input) => input.path);
}
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

import { createHash } from 'node:crypto';
import { createAgentPreparedCheckEffect, type AgentCheckDefinition, type AgentCheckObservation } from '@agent-core/runtime';
import {
  prepareCommandExecution,
  releasePreparedCommandExecution,
  startPreparedCommandExecution,
  type CommandExecutionOwner,
  type CommandExecutionResult,
  type PreparedCommandExecution
} from '@agent-core/tools';
import type { RootedFileAuthority } from '@agent-core/tools-local';
import type { CodingAgentCheckConfiguration, CodingAgentConfiguration } from '../configuration.js';
import type { SandboxCommandExecution } from '../execution/sandbox-command-execution.js';
import { materializeVerificationCandidate } from './candidate-materialization.js';
import {
  captureWorkspaceSnapshot,
  changedWorkspacePaths,
  verifierDefinitionPaths,
  type WorkspaceSnapshot
} from './workspace-snapshot.js';

export function configuredCheckProposals(configuration: CodingAgentConfiguration | undefined): readonly {
  readonly check: CodingAgentCheckConfiguration;
  readonly requirement: 'required' | 'advisory';
}[] {
  if (!configuration) return Object.freeze([]);
  return Object.freeze([
    ...configuration.verification.required.map((check) => Object.freeze({ check, requirement: 'required' as const })),
    ...configuration.verification.advisory.map((check) => Object.freeze({ check, requirement: 'advisory' as const }))
  ]);
}

export function createConfiguredChecks(input: {
  readonly proposals: ReturnType<typeof configuredCheckProposals>;
  readonly root: RootedFileAuthority;
  readonly baseline: WorkspaceSnapshot;
  readonly runtimeDirectory: string;
  readonly createCommandExecution: (input: {
    readonly root: RootedFileAuthority;
    readonly repositoryDirectory: string;
  }) => Promise<SandboxCommandExecution>;
  readonly commandYieldMs: number;
}): readonly AgentCheckDefinition[] {
  return Object.freeze(input.proposals.map(({ check, requirement }) => configuredCommandCheck(check, requirement, input)));
}

function configuredCommandCheck(
  check: CodingAgentCheckConfiguration,
  requirement: 'required' | 'advisory',
  input: Pick<Parameters<typeof createConfiguredChecks>[0], 'root' | 'baseline' | 'runtimeDirectory' | 'createCommandExecution' | 'commandYieldMs'>
): AgentCheckDefinition {
  const definition: AgentCheckDefinition = {
    id: check.id,
    implementationId: commandCheckImplementationId(check, requirement),
    kind: 'effect',
    requirement,
    description: `Project verification command: ${check.command}`,
    ...(check.timeoutMs ? { timeoutMs: check.timeoutMs } : {}),
    async prepare(context) {
      const candidate = await captureWorkspaceSnapshot(input.root, context.signal);
      if (candidate.coverage !== 'complete' || input.baseline.coverage !== 'complete') {
        return unknownSnapshot(check.command, input.baseline, candidate, 'The verification candidate or its pre-edit baseline could not be captured completely.');
      }
      const candidateChanges = changedWorkspacePaths(input.baseline, candidate);
      const changedVerifierDefinitions = verifierDefinitionPaths(candidateChanges);
      if (changedVerifierDefinitions.length > 0) {
        return unknownSnapshot(check.command, input.baseline, candidate, 'Verifier definitions changed after the pre-edit oracle was captured.', candidateChanges, changedVerifierDefinitions);
      }
      const materialization = await materializeVerificationCandidate({
        source: input.root,
        snapshot: candidate,
        runtimeDirectory: input.runtimeDirectory,
        runId: context.runId,
        checkId: check.id
      });
      let commandExecution: SandboxCommandExecution;
      try {
        commandExecution = await input.createCommandExecution({
          root: materialization.workspaceRoot,
          repositoryDirectory: materialization.executionRepositoryDirectory
        });
      } catch (error) {
        materialization.workspaceRoot.close();
        throw error;
      }
      const owner = verificationOwner(context.runId, context.turnId, check.id);
      const outputTokenBudget = Math.max(64, Math.ceil((check.maxOutputBytes ?? 64_000) / 4));
      let prepared: PreparedCommandExecution;
      try {
        prepared = await prepareCommandExecution(commandExecution, {
          owner,
          command: check.command,
          rootedDirectory: '.',
          pty: false,
          timeoutMs: check.timeoutMs ?? 60_000,
          yieldMs: input.commandYieldMs,
          outputTokenBudget
        });
      } catch (error) {
        await commandExecution.close();
        materialization.workspaceRoot.close();
        throw error;
      }
      const processId = commandExecution.executionId(owner);
      const expiresAt = prepared.authorization.expiresAt;
      if (typeof expiresAt !== 'string') {
        await releasePreparedCommandExecution(commandExecution, prepared);
        await commandExecution.close();
        materialization.workspaceRoot.close();
        throw new Error(`Sandbox preparation for ${check.id} has no recovery expiry.`);
      }
      return createAgentPreparedCheckEffect({
        authorization: {
          contract: 'coding-agent.verification-command.v1',
          checkId: check.id,
          command: check.command,
          coverage: check.coverage,
          baselineDigest: input.baseline.digest,
          candidateDigest: candidate.digest,
          candidateChanges: boundedPaths(candidateChanges),
          commandPreparation: prepared.authorization
        },
        recovery: {
          kind: 'queryable',
          service: commandExecution.descriptor.recoveryIdentity,
          reconcilerId: commandExecution.descriptor.implementationId,
          externalExecutionId: processId,
          expiresAt
        },
        start: async (signal) => {
          const result = await completeCommand(commandExecution, prepared, owner, outputTokenBudget, input.commandYieldMs, signal);
          return commandObservation(check, input.baseline, candidate, candidateChanges, result, await captureWorkspaceSnapshot(materialization.workspaceRoot, signal));
        },
        reconcile: async (signal) => {
          if (signal.aborted) throw signal.reason;
          const recovered = await commandExecution.reconcileExecution(owner, outputTokenBudget, input.commandYieldMs);
          if (recovered.status !== 'settled') return recovered;
          const observation = commandObservation(check, input.baseline, candidate, candidateChanges, recovered.result, await captureWorkspaceSnapshot(materialization.workspaceRoot, signal));
          return Object.freeze({ status: 'settled' as const, observation });
        },
        release: async () => {
          try { await releasePreparedCommandExecution(commandExecution, prepared); }
          finally {
            try { await commandExecution.close(); }
            finally { materialization.workspaceRoot.close(); }
          }
        }
      });
    }
  };
  return Object.freeze(definition);
}

async function completeCommand(
  authority: SandboxCommandExecution,
  prepared: PreparedCommandExecution,
  owner: CommandExecutionOwner,
  outputTokenBudget: number,
  yieldMs: number,
  signal: AbortSignal
): Promise<CommandExecutionResult> {
  let result = await startPreparedCommandExecution(authority, prepared, { signal });
  while (result.status === 'running') {
    if (signal.aborted) throw signal.reason;
    result = await authority.query(result.processId, outputTokenBudget, yieldMs, 0, owner);
  }
  return result;
}

function commandObservation(
  check: CodingAgentCheckConfiguration,
  baseline: WorkspaceSnapshot,
  candidate: WorkspaceSnapshot,
  candidateChanges: readonly string[],
  result: CommandExecutionResult,
  after: WorkspaceSnapshot
): AgentCheckObservation {
  const verifierChanges = changedWorkspacePaths(candidate, after);
  const changedVerifierDefinitions = verifierDefinitionPaths(verifierChanges);
  if (after.coverage !== 'complete' || changedVerifierDefinitions.length > 0) {
    return unknownSnapshot(check.command, baseline, candidate, 'The verifier changed its own definition or its isolated workspace could not be observed completely.', candidateChanges, changedVerifierDefinitions, {
      verifierWorkspaceDigest: after.digest,
      verifierWorkspaceChanges: JSON.stringify(boundedPaths(verifierChanges))
    });
  }
  if (result.status !== 'exited') {
    return unknownSnapshot(check.command, baseline, after, `The verification process ended without a trustworthy exit result (${commandTermination(result)}).`, candidateChanges, [], {
      classification: 'check_unavailable',
      coverage: check.coverage,
      processId: result.processId,
      status: result.status
    });
  }
  const passed = result.exitCode === 0;
  return {
    verdict: passed ? 'passed' : 'failed',
    summary: passed ? `${check.command} passed (${check.coverage} coverage).` : `${check.command} failed; no pre-edit execution result is available to classify the failure as a candidate regression.`,
    output: {
      classification: passed ? 'candidate_verified' : 'check_failed_baseline_unknown',
      baselineDigest: baseline.digest,
      baselineOutcome: 'not_observed',
      candidateDigest: candidate.digest,
      candidateChanges: boundedPaths(candidateChanges),
      verifierWorkspaceChanges: boundedPaths(verifierChanges),
      coverage: check.coverage,
      processId: result.processId,
      status: result.status,
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      stdout: result.stdout.text,
      stderr: result.stderr.text,
      stdoutOmittedBytes: result.stdout.omittedBytes,
      stderrOmittedBytes: result.stderr.omittedBytes
    }
  };
}

function verificationOwner(runId: string, turnId: string, checkId: string): CommandExecutionOwner {
  return Object.freeze({ runId, turnId, toolBatchId: `verification:${checkId}`, callIndex: 0 });
}

function commandTermination(result: CommandExecutionResult): string {
  if (result.status === 'exited') return `exit ${String(result.exitCode ?? 'unknown')}`;
  return result.status.replaceAll('_', ' ');
}

function unknownSnapshot(
  command: string,
  baseline: WorkspaceSnapshot,
  candidate: WorkspaceSnapshot,
  message: string,
  candidateChanges: readonly string[] = [],
  changedVerifierDefinitions: readonly string[] = [],
  details: Readonly<Record<string, string>> = {}
) {
  return {
    verdict: 'unknown' as const,
    summary: `${command} is inconclusive: ${message}`,
    output: {
      classification: changedVerifierDefinitions.length > 0 ? 'verifier_definition_changed' : 'candidate_not_exact',
      baselineDigest: baseline.digest,
      baselineCoverage: baseline.coverage,
      baselineCauses: baseline.causes,
      candidateDigest: candidate.digest,
      candidateCoverage: candidate.coverage,
      candidateCauses: candidate.causes,
      candidateChanges: boundedPaths(candidateChanges),
      changedVerifierDefinitions: boundedPaths(changedVerifierDefinitions),
      ...details
    },
    diagnostic: { kind: 'invalid_result' as const, message }
  };
}

function commandCheckImplementationId(check: CodingAgentCheckConfiguration, requirement: 'required' | 'advisory'): string {
  const digest = createHash('sha256').update(JSON.stringify({
    contract: 'coding-agent.command-check.v1',
    id: check.id,
    requirement,
    command: check.command,
    coverage: check.coverage,
    timeoutMs: check.timeoutMs ?? 60_000,
    maxOutputBytes: check.maxOutputBytes ?? 64_000
  })).digest('hex');
  return `coding-agent.command-check.v1:${digest}`;
}

function boundedPaths(paths: readonly string[]): readonly string[] {
  return Object.freeze(paths.slice(0, 500));
}

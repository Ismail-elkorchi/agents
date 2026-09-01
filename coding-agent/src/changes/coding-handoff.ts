import type { ArtifactRef } from '@agent-core/persistence';
import { decodeOwnedArtifactRef } from '@agent-core/persistence';
import { parseJsonObject } from '@agent-core/json';
import {
  decodeAgentTerminalSnapshot,
  decodeAgentRunBudgetState,
  parseAgentCheckResult,
  type AgentCheckResult,
  type AgentEndedRunResult,
  type AgentRunBudgetState,
  type AgentTerminalSnapshot
} from '@agent-core/runtime';
import { codingRunUncertainties } from '../presentation/run-summary.js';
import { decodeRunChangeReport, type RunChangeReport } from './run-change-report.js';

export type CodingPublicationStatus = 'applied' | 'not_applied' | 'not_applicable';

/** One revision-bound application view for review, recovery hydration, and CLI/TUI handoff. */
export interface CodingHandoff {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly taskSummary: string;
  readonly modelSummary: string;
  readonly reviewedRevision: string;
  readonly changedFiles: readonly string[];
  readonly changeReport: RunChangeReport;
  readonly changeArtifact: ArtifactRef;
  readonly checks: readonly AgentCheckResult[];
  readonly usage: AgentRunBudgetState;
  readonly terminal: AgentTerminalSnapshot;
  readonly publication: {
    readonly status: CodingPublicationStatus;
    readonly revision: string;
    readonly reason?: string;
  };
  readonly unresolved: readonly string[];
  readonly effectsWithUnknownOutcome: readonly string[];
}

export function createCodingHandoff(input: {
  readonly task: string;
  readonly result: AgentEndedRunResult;
  readonly changeReport: RunChangeReport;
  readonly changeArtifact: ArtifactRef;
  readonly publication: CodingHandoff['publication'];
}): CodingHandoff {
  const terminal = input.result.terminal;
  if (terminal.runId !== input.changeReport.runId) {
    throw new Error('Coding handoff inputs do not identify one run.');
  }
  if (input.publication.revision !== input.changeReport.finalDigest) {
    throw new Error(`Publication revision does not match the reviewed working-copy revision for run ${terminal.runId}.`);
  }
  const effectsWithUnknownOutcome = unknownEffects(input.changeReport);
  const unresolved = new Set([
    ...codingRunUncertainties(terminal, input.changeReport),
    ...effectsWithUnknownOutcome.map((effect) => `Effect outcome is unknown: ${effect}.`),
    ...input.result.deliveryDiagnostics.map((diagnostic) => `Delivery diagnostic for ${diagnostic.eventType}: ${diagnostic.message}`),
    ...(input.publication.reason ? [input.publication.reason] : [])
  ]);
  return Object.freeze({
    schemaVersion: 1,
    runId: terminal.runId,
    taskSummary: bounded(input.task, 16_000),
    modelSummary: terminal.modelOutput.status === 'absent'
      ? ('errorMessage' in terminal ? terminal.errorMessage : 'Run ended without model output.')
      : terminal.modelOutput.message,
    reviewedRevision: input.changeReport.finalDigest,
    changedFiles: input.changeReport.facts.changedPaths,
    changeReport: input.changeReport,
    changeArtifact: input.changeArtifact,
    checks: terminal.checkResults,
    usage: terminal.budget,
    terminal,
    publication: Object.freeze({ ...input.publication }),
    unresolved: Object.freeze([...unresolved]),
    effectsWithUnknownOutcome
  });
}

export function decodeCodingHandoff(value: unknown, expectedRunId?: string): CodingHandoff {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.runId !== 'string'
    || Object.keys(value).some((key) => ![
      'schemaVersion', 'runId', 'taskSummary', 'modelSummary', 'reviewedRevision', 'changedFiles',
      'changeReport', 'changeArtifact', 'checks', 'usage', 'terminal', 'publication', 'unresolved',
      'effectsWithUnknownOutcome'
    ].includes(key))
    || (expectedRunId !== undefined && value.runId !== expectedRunId)
    || typeof value.taskSummary !== 'string' || typeof value.modelSummary !== 'string'
    || typeof value.reviewedRevision !== 'string' || !digest(value.reviewedRevision)
    || !stringList(value.changedFiles) || !stringList(value.unresolved) || !stringList(value.effectsWithUnknownOutcome)
    || !Array.isArray(value.checks)
    || !record(value.publication)) throw new Error('Persisted coding handoff is invalid.');
  const terminal = decodeAgentTerminalSnapshot(value.terminal);
  const checks = Object.freeze(value.checks.map((check) => parseAgentCheckResult(check)));
  const usage = decodeAgentRunBudgetState(value.usage);
  const changeReport = decodeRunChangeReport(value.changeReport, value.runId);
  const changeArtifact = decodeOwnedArtifactRef(parseJsonObject(value.changeArtifact));
  const publication = decodePublication(value.publication);
  if (terminal.runId !== value.runId || changeReport.finalDigest !== value.reviewedRevision
    || publication.revision !== value.reviewedRevision
    || !sameStrings(value.changedFiles, changeReport.facts.changedPaths)
    || JSON.stringify(checks) !== JSON.stringify(terminal.checkResults)
    || JSON.stringify(usage) !== JSON.stringify(terminal.budget)) {
    throw new Error('Persisted coding handoff does not bind one exact reviewed revision.');
  }
  return Object.freeze({
    schemaVersion: 1,
    runId: value.runId,
    taskSummary: value.taskSummary,
    modelSummary: value.modelSummary,
    reviewedRevision: value.reviewedRevision,
    changedFiles: Object.freeze([...value.changedFiles]),
    changeReport,
    changeArtifact,
    checks,
    usage,
    terminal,
    publication,
    unresolved: Object.freeze([...value.unresolved]),
    effectsWithUnknownOutcome: Object.freeze([...value.effectsWithUnknownOutcome])
  });
}

function decodePublication(value: Record<string, unknown>): CodingHandoff['publication'] {
  if (Object.keys(value).some((key) => !['status', 'revision', 'reason'].includes(key))
    || (value.status !== 'applied' && value.status !== 'not_applied' && value.status !== 'not_applicable')
    || typeof value.revision !== 'string' || !digest(value.revision)
    || (value.status === 'not_applied'
      ? typeof value.reason !== 'string' || value.reason.length === 0
      : value.reason !== undefined)) throw new Error('Persisted coding publication status is invalid.');
  return Object.freeze({ status: value.status, revision: value.revision, ...(typeof value.reason === 'string' ? { reason: value.reason } : {}) });
}

function unknownEffects(report: RunChangeReport): readonly string[] {
  const effects: string[] = [];
  if (report.causes.some((cause) => cause === 'mutation_receipts:unsettled_structured_mutation')) effects.push('structured repository mutation');
  if (report.causes.some((cause) => cause === 'mutation_receipts:uncertain_workspace_state')) effects.push('repository mutation with uncertain workspace state');
  return Object.freeze(effects);
}

function bounded(value: string, limit: number): string { return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`; }
function digest(value: string): boolean { return /^[a-f0-9]{64}$/u.test(value); }
function stringList(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === 'string'); }
function sameStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((item, index) => item === right[index]); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

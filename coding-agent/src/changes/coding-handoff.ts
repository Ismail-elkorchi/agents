import { parseJsonObject } from '@agent-core/json';
import { decodeOwnedArtifactRef, hashJson, type ArtifactRef } from '@agent-core/persistence';
import {
  decodeAgentTerminalSnapshot,
  type AgentDeliveryDiagnostic,
  type AgentTerminalSnapshot
} from '@agent-core/runtime';
import type { CodingEndedRunResult } from '../outcome.js';
import { decodeCodingWorkOutcome, type CodingWorkOutcome } from '../outcome.js';
import { decodeRunChangeReport, type RunChangeReport } from './run-change-report.js';

/** Revision-bound source records for review, recovery hydration, and CLI/TUI presentation. */
export interface CodingHandoff {
  readonly schemaVersion: 1;
  readonly changeReport: RunChangeReport;
  readonly changeArtifact: ArtifactRef;
  readonly outcome: CodingWorkOutcome;
  readonly terminal: AgentTerminalSnapshot;
  readonly deliveryDiagnostics: readonly AgentDeliveryDiagnostic[];
}

export function createCodingHandoff(input: {
  readonly result: CodingEndedRunResult;
  readonly changeReport: RunChangeReport;
  readonly changeArtifact: ArtifactRef;
}): CodingHandoff {
  const handoff: CodingHandoff = Object.freeze({
    schemaVersion: 1,
    changeReport: input.changeReport,
    changeArtifact: input.changeArtifact,
    outcome: input.result.outcome,
    terminal: input.result.terminal,
    deliveryDiagnostics: input.result.deliveryDiagnostics
  });
  assertHandoffBinding(handoff);
  return handoff;
}

export function decodeCodingHandoff(value: unknown, expectedRunId?: string): CodingHandoff {
  const object = parseJsonObject(value);
  if (
    object.schemaVersion !== 1 ||
    !Array.isArray(object.deliveryDiagnostics) ||
    Object.keys(object).some(
      (key) =>
        ![
          'schemaVersion',
          'changeReport',
          'changeArtifact',
          'outcome',
          'terminal',
          'deliveryDiagnostics'
        ].includes(key)
    )
  )
    throw new Error('Persisted coding handoff is invalid.');
  const terminal = decodeAgentTerminalSnapshot(object.terminal);
  if (expectedRunId !== undefined && terminal.runId !== expectedRunId)
    throw new Error('Persisted coding handoff identifies a different run.');
  const handoff: CodingHandoff = Object.freeze({
    schemaVersion: 1,
    changeReport: decodeRunChangeReport(object.changeReport, terminal.runId),
    changeArtifact: decodeOwnedArtifactRef(parseJsonObject(object.changeArtifact)),
    outcome: decodeCodingWorkOutcome(object.outcome),
    terminal,
    deliveryDiagnostics: Object.freeze(object.deliveryDiagnostics.map(decodeDeliveryDiagnostic))
  });
  assertHandoffBinding(handoff);
  return handoff;
}

function assertHandoffBinding({ terminal, changeReport, outcome }: CodingHandoff): void {
  if (
    changeReport.runId !== terminal.runId ||
    outcome.runId !== terminal.runId ||
    outcome.terminalSha256 !== hashJson(terminal) ||
    (outcome.revision !== undefined && outcome.revision !== changeReport.finalDigest)
  )
    throw new Error('Coding handoff does not bind one exact reviewed revision and execution result.');
}

function decodeDeliveryDiagnostic(value: unknown): AgentDeliveryDiagnostic {
  const object = parseJsonObject(value);
  if (
    Object.keys(object).some((key) => !['eventType', 'message', 'persisted'].includes(key)) ||
    typeof object.eventType !== 'string' ||
    object.eventType.length === 0 ||
    typeof object.message !== 'string' ||
    typeof object.persisted !== 'boolean'
  )
    throw new Error('Persisted coding delivery diagnostic is invalid.');
  return Object.freeze({
    eventType: object.eventType,
    message: object.message,
    persisted: object.persisted
  });
}

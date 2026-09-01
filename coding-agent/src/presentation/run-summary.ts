import type { AgentTerminalSnapshot } from '@agent-core/runtime';
import type { RunChangeReport } from '../changes/run-change-report.js';

/** Derives remaining coding-run uncertainty exclusively from terminal state and observed changes. */
export function codingRunUncertainties(
  terminal: AgentTerminalSnapshot,
  changeReport: RunChangeReport
): readonly string[] {
  if (terminal.runId !== changeReport.runId) {
    throw new Error(`Terminal run ${terminal.runId} cannot summarize change report ${changeReport.runId}.`);
  }
  const uncertainties = new Set<string>();
  if (terminal.modelOutput.status === 'partial') uncertainties.add('The model output is partial.');
  if (terminal.modelOutput.status === 'indeterminate') uncertainties.add('The model output is indeterminate.');
  const unknownChecks = terminal.checkResults.filter((check) => check.verdict === 'unknown');
  for (const check of unknownChecks) uncertainties.add(`Check ${check.id} is unknown: ${compact(check.summary)}`);
  if (terminal.verificationStatus === 'inconclusive' && unknownChecks.length === 0) {
    uncertainties.add('Verification is inconclusive.');
  }
  if (terminal.verificationStatus === 'not_run') uncertainties.add('Verification did not run.');
  for (const uncertainty of codingChangeUncertainties(changeReport)) uncertainties.add(uncertainty);
  return Object.freeze([...uncertainties]);
}

/** Derives workspace-change uncertainty without requiring a terminal snapshot. */
export function codingChangeUncertainties(changeReport: RunChangeReport): readonly string[] {
  const uncertainties = new Set<string>();
  for (const cause of changeReport.causes) uncertainties.add(`Change coverage is partial: ${humanize(cause)}.`);
  if (changeReport.facts.externalOrConcurrentPaths.length > 0) {
    uncertainties.add(`Change attribution is external or concurrent for: ${changeReport.facts.externalOrConcurrentPaths.join(', ')}.`);
  }
  for (const change of changeReport.changes) {
    if (change.conflicts.length > 0) {
      uncertainties.add(`Mutation receipts conflict with ${change.path}: ${change.conflicts.map(humanize).join(', ')}.`);
    }
  }
  return Object.freeze([...uncertainties]);
}

function compact(value: string): string {
  const normalized = value.trim().replaceAll(/\s+/g, ' ');
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 239)}…`;
}

function humanize(value: string): string {
  return value.replaceAll('_', ' ').replaceAll(':', ' — ');
}

import type { CodingOutcomeRepository } from './outcome.js';

import type { EventRepository } from '@agent-core/persistence';
import type {
  AgentEvent,
  PromptContextItemInput,
  SessionDescriptor,
  SessionRepository
} from '@agent-core/runtime';
import { captureWorkspaceSnapshot, type RootedFileAuthority } from '@agent-core/tools-local';
import { type CheckResult } from '@agents/verification';
import { createHash } from 'node:crypto';
import type { CodingHandoffService } from './changes/coding-handoff-service.js';
import { createRunChangeReport } from './changes/run-change-report.js';
import { codingHandoffUncertainties } from './presentation/run-summary.js';
import type { PrivateStateDirectory } from './state/private-state.js';
import type { AdmittedCodingCheckPlan } from './verification/revision-acceptance-checks.js';
import type { CodingWork } from './work.js';

/** A fresh application contribution; check outputs always retain their original revision binding. */
export async function codingSessionBoundaryContext(input: {
  readonly root: RootedFileAuthority;
  readonly sourceRoot: RootedFileAuthority;
  readonly state: PrivateStateDirectory;
  readonly runId: string;
  readonly work: CodingWork;
  readonly events: EventRepository<AgentEvent>;
  readonly sessions: SessionRepository;
  readonly session: SessionDescriptor;
  readonly handoffs: CodingHandoffService;
  readonly checkPlan: AdmittedCodingCheckPlan;
  readonly outcomes: CodingOutcomeRepository;
}): Promise<PromptContextItemInput> {
  const [changes, source, replay, outcomes, state] = await Promise.all([
    input.work.mode === 'revision'
      ? createRunChangeReport({ ...input, workId: input.work.workId })
      : undefined,
    captureWorkspaceSnapshot(input.sourceRoot),
    input.sessions.loadReplayState(input.session),
    Promise.all(input.work.runIds.map((runId) => input.outcomes.read(runId))),
    input.events.latestOfType(input.runId, 'run.state.changed')
  ]);
  const latest = replay.runFinalizations.at(-1);
  const handoff = latest === undefined ? undefined : await input.handoffs.read(latest.runId);
  const outcome = outcomes.filter((item) => item !== undefined).at(-1);
  const checks = outcome?.verification.checks.map((result) => ({ runId: outcome.runId, result })) ?? [];
  const latestCheck = checks.at(-1);
  const phase = state?.event.type === 'run.state.changed' ? state.event.state.phase : undefined;
  const material = {
    version: 1,
    runId: input.runId,
    sourceWorkspace: { revision: source.digest, coverage: source.coverage, causes: source.causes },
    work: {
      workId: input.work.workId,
      ownerId: input.work.ownerId,
      requirementSources: {
        count: input.work.requirementSources.length,
        authority:
          'Original user contributions in session history; context selection and notes do not supersede them.',
        selection:
          'Retain the current work objective and its corrections; select other relevant constraints and history explicitly. Retrieve original sources to resolve uncertainty.'
      }
    },
    workingCopy:
      changes === undefined
        ? null
        : {
            revision: changes.finalDigest,
            preChangeRevision: changes.preChangeDigest,
            coverage: changes.coverage,
            changedResources: changes.changes,
            omittedChanges: changes.omittedChanges,
            causes: changes.causes
          },
    checkPlan: input.checkPlan,
    checks: checks.map((record) => bindCheckRevision(record, changes?.finalDigest ?? source.digest)),
    latestCheck:
      latestCheck === undefined
        ? null
        : bindCheckRevision(latestCheck, changes?.finalDigest ?? source.digest),
    publication:
      outcome === undefined
        ? { status: 'not_decided' }
        : { status: outcome.publication, revision: outcome.revision, reason: outcome.reason },
    unresolved: phase?.kind === 'suspended' ? phase : null,
    latestHandoff:
      handoff === undefined
        ? null
        : {
            runId: handoff.terminal.runId,
            reviewedRevision: handoff.changeReport.finalDigest,
            publication: handoff.outcome.publication,
            changedFiles: handoff.changeReport.facts.changedPaths,
            checks: handoff.outcome.verification.checks,
            unresolved: codingHandoffUncertainties(handoff),
            changeArtifact: handoff.changeArtifact,
            appliesToCurrentRevision: handoff.changeReport.finalDigest === changes?.finalDigest
          }
  };
  const content = JSON.stringify(material);
  const revision = createHash('sha256').update(content).digest('hex');
  return Object.freeze({
    id: `coding-state/${revision}`,
    sourceUri: `coding-state://${input.runId}/${revision}`,
    sourceKind: 'external',
    integrity: 'verified',
    representation: 'full',
    mediaType: 'application/json',
    title: 'Current coding application state',
    content,
    purpose:
      'Host-observed workspace, check, effect, and publication identities at this boundary. Historical checks apply only to their exact checked revision. Notes cannot change these facts or grant authority.'
  });
}

interface CheckObservation {
  readonly runId: string;
  readonly result: CheckResult;
}

function bindCheckRevision(record: CheckObservation, currentRevision: string) {
  const output = record.result.output;
  const revision =
    output !== null &&
    typeof output === 'object' &&
    !Array.isArray(output) &&
    'workingCopyDigest' in output &&
    typeof output.workingCopyDigest === 'string'
      ? output.workingCopyDigest
      : null;
  return {
    ...record,
    checkedRevision: revision,
    appliesToCurrentRevision: revision !== null && revision === currentRevision
  };
}

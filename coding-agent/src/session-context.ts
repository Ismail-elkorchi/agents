import { createHash } from 'node:crypto';
import type { EventRepository } from '@agent-core/persistence';
import type {
  AgentCheckResult,
  AgentEvent,
  PromptContextItemInput,
  SessionDescriptor,
  SessionRepository
} from '@agent-core/runtime';
import { captureWorkspaceSnapshot, type RootedFileAuthority } from '@agent-core/tools-local';
import type { AdmittedCodingCheckPlan } from './verification/candidate-acceptance-checks.js';
import type { PrivateStateDirectory } from './state/private-state.js';
import { createRunChangeReport } from './changes/run-change-report.js';
import type { CodingHandoffService } from './changes/coding-handoff-service.js';

/** A fresh application contribution; check outputs always retain their original revision binding. */
export async function codingSessionBoundaryContext(input: {
  readonly root: RootedFileAuthority;
  readonly sourceRoot: RootedFileAuthority;
  readonly state: PrivateStateDirectory;
  readonly runId: string;
  readonly events: EventRepository<AgentEvent>;
  readonly sessions: SessionRepository;
  readonly session: SessionDescriptor;
  readonly handoffs: CodingHandoffService;
  readonly checkPlan: AdmittedCodingCheckPlan;
}): Promise<PromptContextItemInput> {
  const [changes, source, replay, lastCheck, disposition, state] = await Promise.all([
    createRunChangeReport(input),
    captureWorkspaceSnapshot(input.sourceRoot),
    input.sessions.loadReplayState(input.session),
    input.events.latestOfType(input.runId, 'check.ended'),
    input.events.latestOfType(input.runId, 'run.disposition.decided'),
    input.events.latestOfType(input.runId, 'run.state.changed')
  ]);
  const latest = replay.runFinalizations.at(-1);
  const handoff = latest === undefined ? undefined : await input.handoffs.read(latest.runId);
  const checks =
    lastCheck === undefined ? [] : await currentChecks(input.events, input.runId, lastCheck.eventId);
  const latestCheck = checks.find((check) => check.eventId === lastCheck?.eventId);
  const phase = state?.event.type === 'run.state.changed' ? state.event.state.phase : undefined;
  const material = {
    version: 1,
    runId: input.runId,
    sourceWorkspace: { revision: source.digest, coverage: source.coverage, causes: source.causes },
    workingCopy: {
      revision: changes.finalDigest,
      preChangeRevision: changes.preChangeDigest,
      coverage: changes.coverage,
      changedResources: changes.changes,
      omittedChanges: changes.omittedChanges,
      causes: changes.causes
    },
    checkPlan: input.checkPlan,
    checks: checks.map((record) => bindCheckRevision(record, changes.finalDigest)),
    latestCheck: latestCheck === undefined ? null : bindCheckRevision(latestCheck, changes.finalDigest),
    publication:
      disposition?.event.type === 'run.disposition.decided'
        ? {
            eventId: disposition.eventId,
            decision: disposition.event.decision,
            implementationId: disposition.event.implementationId
          }
        : { status: 'not_decided' },
    unresolved: phase?.kind === 'suspended' ? phase : null,
    latestHandoff:
      handoff === undefined
        ? null
        : {
            runId: handoff.runId,
            reviewedRevision: handoff.reviewedRevision,
            publication: handoff.publication,
            changedFiles: handoff.changedFiles,
            checks: handoff.checks,
            effectsWithUnknownOutcome: handoff.effectsWithUnknownOutcome,
            unresolved: handoff.unresolved,
            changeArtifact: handoff.changeArtifact,
            appliesToCurrentRevision: handoff.reviewedRevision === changes.finalDigest
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
  readonly eventId: string;
  readonly result: AgentCheckResult;
}

interface CachedChecks {
  readonly lastEventId: string;
  readonly checks: readonly CheckObservation[];
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

const checkCache = new WeakMap<EventRepository<AgentEvent>, Map<string, CachedChecks>>();

async function currentChecks(
  events: EventRepository<AgentEvent>,
  runId: string,
  lastEventId: string
): Promise<readonly CheckObservation[]> {
  const runs = checkCache.get(events) ?? new Map<string, CachedChecks>();
  checkCache.set(events, runs);
  const cached = runs.get(runId);
  if (cached?.lastEventId === lastEventId) return cached.checks;
  const results = new Map<string, CheckObservation>();
  for await (const record of events.read(runId)) {
    if (record.event.type === 'check.ended')
      results.set(
        record.event.result.id,
        Object.freeze({ eventId: record.eventId, result: record.event.result })
      );
    if (record.eventId === lastEventId) break;
  }
  const checks = Object.freeze([...results.values()]);
  // Current/finalized facts also live durably in their run or handoff; keep this cache bounded.
  if (runs.size >= 16 && !runs.has(runId)) {
    const oldest = runs.keys().next().value;
    if (oldest !== undefined) runs.delete(oldest);
  }
  runs.set(runId, { lastEventId, checks });
  return checks;
}

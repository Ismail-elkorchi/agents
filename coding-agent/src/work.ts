import { sourceRef, type HistoryView, type SessionBranchEntry } from '@agent-core/runtime';

import { parseJsonObject, type JsonObject } from '@agent-core/json';
import {
  hashJson,
  PersistenceConflictError,
  type EventRepository,
  type RuntimeCodec
} from '@agent-core/persistence';
import { randomUUID } from 'node:crypto';

export interface CodingRequirementSource {
  readonly submissionId: string;
  readonly runId: string;
  readonly sha256: string;
  readonly supersededBy?: string;
  readonly correctedBy?: readonly string[];
}

export interface CodingWork {
  readonly workId: string;
  readonly sessionId: string;
  readonly sourceId: string;
  readonly ownerId: string;
  readonly mode: 'revision' | 'review';
  readonly status: 'active' | 'published';
  readonly requirementSources: readonly CodingRequirementSource[];
  readonly runIds: readonly string[];
  readonly baselineDigest?: string;
  readonly checkPlanId?: string;
  readonly publishedRevision?: string;
}

export interface CodingWorkEvent {
  readonly type: 'coding.work.recorded';
  readonly work: CodingWork;
}

export const codingWorkEventCodec: RuntimeCodec<CodingWorkEvent> = {
  encode: (event) => parseJsonObject(event),
  decode(value) {
    const event = parseJsonObject(value);
    if (
      event.type !== 'coding.work.recorded' ||
      Object.keys(event).some((key) => key !== 'type' && key !== 'work')
    )
      throw new TypeError('Incompatible coding work record.');
    const work = parseJsonObject(event.work);
    exact(work, [
      'workId',
      'sessionId',
      'sourceId',
      'ownerId',
      'mode',
      'status',
      'requirementSources',
      'runIds',
      'baselineDigest',
      'checkPlanId',
      'publishedRevision'
    ]);
    if (
      (work.mode !== 'revision' && work.mode !== 'review') ||
      (work.status !== 'active' && work.status !== 'published') ||
      !Array.isArray(work.requirementSources) ||
      !Array.isArray(work.runIds)
    )
      throw new TypeError('Invalid coding work state.');
    const requirementSources = work.requirementSources.map((value) => {
      const entry = parseJsonObject(value);
      exact(entry, ['submissionId', 'runId', 'sha256', 'supersededBy', 'correctedBy']);
      if (entry.correctedBy !== undefined && !Array.isArray(entry.correctedBy))
        throw new TypeError('Coding source corrections must identify original contributions.');
      const requirement = {
        submissionId: text(entry.submissionId),
        runId: text(entry.runId),
        sha256: text(entry.sha256),
        ...(Array.isArray(entry.correctedBy)
          ? { correctedBy: Object.freeze(entry.correctedBy.map(text)) }
          : {}),
        ...(entry.supersededBy === undefined ? {} : { supersededBy: text(entry.supersededBy) })
      };
      if (!/^[a-f0-9]{64}$/u.test(requirement.sha256))
        throw new TypeError('Coding requirement source digest is invalid.');
      return Object.freeze(requirement);
    });
    const positions = new Map(requirementSources.map((source, index) => [source.submissionId, index]));
    if (positions.size !== requirementSources.length)
      throw new TypeError('Coding requirement source identities must be unique.');
    for (const [index, source] of requirementSources.entries()) {
      if (!work.runIds.includes(source.runId))
        throw new TypeError('Coding requirement source belongs to an unadmitted run.');
      const successors = [
        ...(source.correctedBy ?? []),
        ...(source.supersededBy === undefined ? [] : [source.supersededBy])
      ];
      if (new Set(source.correctedBy ?? []).size !== (source.correctedBy?.length ?? 0))
        throw new TypeError('Coding source corrections must be distinct.');
      if (successors.some((id) => (positions.get(id) ?? -1) <= index))
        throw new TypeError('Coding requirement source successor must be a later original contribution.');
    }
    return Object.freeze({
      type: 'coding.work.recorded',
      work: Object.freeze({
        workId: text(work.workId),
        sessionId: text(work.sessionId),
        sourceId: text(work.sourceId),
        ownerId: text(work.ownerId),
        mode: work.mode,
        status: work.status,
        requirementSources: Object.freeze(requirementSources),
        runIds: Object.freeze(work.runIds.map(text)),
        ...(work.baselineDigest === undefined ? {} : { baselineDigest: text(work.baselineDigest) }),
        ...(work.checkPlanId === undefined ? {} : { checkPlanId: text(work.checkPlanId) }),
        ...(work.publishedRevision === undefined ? {} : { publishedRevision: text(work.publishedRevision) })
      })
    });
  }
};

/** Application work survives attempts; run finalization never deletes its baseline or private revision. */
export class CodingWorkRepository {
  constructor(private readonly events: EventRepository<CodingWorkEvent>) {}

  async read(workId: string): Promise<CodingWork> {
    const latest = await this.events.latest(workId);
    if (!latest) throw new Error(`Coding work is unavailable: ${workId}`);
    return latest.event.work;
  }

  async forRun(runId: string): Promise<CodingWork | undefined> {
    for (const workId of await this.events.listRunIds()) {
      const work = await this.read(workId);
      if (work.runIds.includes(runId)) return work;
    }
    return undefined;
  }

  async admit(input: {
    readonly sessionId: string;
    readonly sourceId: string;
    readonly mode: CodingWork['mode'];
    readonly runId: string;
    readonly submissionId: string;
    readonly task: string;
    readonly selection?: { readonly kind: 'new' } | { readonly kind: 'continue'; readonly workId: string };
  }): Promise<CodingWork> {
    const existing = await this.forRun(input.runId);
    if (existing) {
      if (existing.sessionId !== input.sessionId || existing.sourceId !== input.sourceId)
        throw new PersistenceConflictError('Run is bound to different coding work.');
      const contribution = existing.requirementSources.find(
        (item) => item.submissionId === input.submissionId
      );
      if (
        existing.mode !== input.mode ||
        contribution?.runId !== input.runId ||
        contribution.sha256 !== hashJson(input.task)
      )
        throw new PersistenceConflictError('A run cannot replace its original coding contribution.');
      return existing;
    }
    let work: CodingWork | undefined;
    if (input.selection?.kind === 'continue') work = await this.read(input.selection.workId);
    else if (input.selection === undefined) {
      const active: CodingWork[] = [];
      for (const id of await this.events.listRunIds()) {
        const recorded = await this.read(id);
        if (
          recorded.sessionId === input.sessionId &&
          recorded.status === 'active' &&
          recorded.mode === input.mode
        )
          active.push(recorded);
      }
      if (active.length > 1)
        throw new PersistenceConflictError('Select which active coding work to continue.');
      work = active[0];
    }
    if (
      work &&
      (work.sessionId !== input.sessionId ||
        work.sourceId !== input.sourceId ||
        work.mode !== input.mode ||
        work.status !== 'active')
    )
      throw new PersistenceConflictError(
        'Coding work does not match the admitted session, source, mode or publication boundary.'
      );
    if (!work) {
      const workId = randomUUID();
      work = Object.freeze({
        workId,
        ownerId: `coding-work:${workId}`,
        sessionId: input.sessionId,
        sourceId: input.sourceId,
        mode: input.mode,
        status: 'active',
        requirementSources: [],
        runIds: []
      });
      await this.events.append(
        workId,
        { type: 'coding.work.recorded', work },
        { idempotencyKey: 'admission' }
      );
    }
    return this.update(work.workId, (current) => ({
      ...current,
      runIds: [...current.runIds, input.runId],
      requirementSources: [
        ...current.requirementSources,
        {
          submissionId: input.submissionId,
          runId: input.runId,
          sha256: hashJson(input.task)
        }
      ]
    }));
  }

  /** Records original contributions and explicit source relationships; selection never changes their authority. */
  async synchronizeHistory(workId: string, history: HistoryView): Promise<CodingWork> {
    return this.update(workId, (work) => {
      if (history.cut.sessionId !== work.sessionId)
        throw new PersistenceConflictError('Coding requirement sources cannot cross session authority.');
      let requirementSources = [...work.requirementSources];
      for (const entry of history.entries) {
        if (entry.type !== 'steering' || !work.runIds.includes(entry.runId)) continue;
        const submissionId = entry.deliveryId ?? entry.id;
        const existing = requirementSources.find((item) => item.submissionId === submissionId);
        if (existing) {
          if (existing.sha256 !== hashJson(entry.content) || existing.runId !== entry.runId)
            throw new PersistenceConflictError('A steering contribution changed its original identity.');
        } else
          requirementSources.push({
            submissionId,
            runId: entry.runId,
            sha256: hashJson(entry.content)
          });
      }
      for (const entry of history.entries) {
        const relationship =
          entry.type === 'steering'
            ? entry.relationship
            : entry.type === 'input'
              ? entry.originalInput?.relationship
              : undefined;
        if (!relationship || (relationship.kind !== 'correct' && relationship.kind !== 'replace')) continue;
        const correction = requirementSources.find(
          (item) =>
            codingRequirementSourceEntry(item, { ...work, requirementSources }, history.entries)?.id ===
            entry.id
        );
        if (!correction) continue;
        for (const reference of relationship.relatedSources ?? []) {
          const previous = requirementSources.find((item) => {
            const source = codingRequirementSourceEntry(
              item,
              { ...work, requirementSources },
              history.entries
            );
            return (
              source !== undefined &&
              hashJson(sourceRef(history.cut.sessionId, source)) === hashJson(reference)
            );
          });
          if (!previous || requirementSources.indexOf(previous) >= requirementSources.indexOf(correction))
            throw new PersistenceConflictError(
              'A correction must identify an earlier original requirement in the same work.'
            );
          if (
            relationship.kind === 'replace' &&
            previous.supersededBy !== undefined &&
            previous.supersededBy !== correction.submissionId
          )
            throw new PersistenceConflictError(
              'A requirement correction conflicts with its admitted successor.'
            );
          requirementSources = requirementSources.map((item) =>
            item !== previous
              ? item
              : relationship.kind === 'replace'
                ? { ...item, supersededBy: correction.submissionId }
                : {
                    ...item,
                    correctedBy: [...new Set([...(item.correctedBy ?? []), correction.submissionId])]
                  }
          );
        }
      }
      return { ...work, requirementSources };
    });
  }

  bindRevision(workId: string, baselineDigest: string, checkPlanId: string): Promise<CodingWork> {
    return this.update(workId, (work) => {
      if (
        (work.baselineDigest !== undefined && work.baselineDigest !== baselineDigest) ||
        (work.checkPlanId !== undefined && work.checkPlanId !== checkPlanId)
      )
        throw new PersistenceConflictError(
          'Continuing coding work cannot silently replace its baseline or acceptance contract.'
        );
      return { ...work, baselineDigest, checkPlanId };
    });
  }

  publish(workId: string, revision: string): Promise<CodingWork> {
    return this.update(workId, (work) => {
      if (work.publishedRevision !== undefined && work.publishedRevision !== revision)
        throw new PersistenceConflictError('Published coding work has an immutable revision.');
      return { ...work, status: 'published', publishedRevision: revision };
    });
  }

  private async update(workId: string, change: (current: CodingWork) => CodingWork): Promise<CodingWork> {
    const latest = await this.events.latest(workId);
    if (!latest) throw new Error(`Coding work is unavailable: ${workId}`);
    const event = codingWorkEventCodec.decode({
      type: 'coding.work.recorded',
      work: change(latest.event.work)
    });
    if (hashJson(event) === hashJson(latest.event)) return latest.event.work;
    const result = await this.events.appendConditional(workId, event, {
      expectedTail: {
        sequence: latest.sequence,
        hash: latest.hash,
        driverGeneration: latest.driverGeneration
      },
      driverGeneration: latest.driverGeneration,
      idempotencyKey: hashJson(event)
    });
    if (result.kind !== 'committed' && result.kind !== 'already_committed')
      throw new PersistenceConflictError(`Coding work update was not committed: ${result.kind}`);
    return event.work;
  }
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new TypeError('Coding work identity or source text is invalid.');
  return value;
}

function exact(value: JsonObject, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new TypeError('Incompatible coding work fields.');
}

export function codingRequirementSourceEntry(
  requirement: CodingRequirementSource,
  work: CodingWork,
  entries: readonly SessionBranchEntry[]
): SessionBranchEntry | undefined {
  const original = work.requirementSources.find((item) => item.runId === requirement.runId);
  return entries.find((entry) =>
    entry.type === 'input'
      ? original?.submissionId === requirement.submissionId &&
        entry.runId === requirement.runId &&
        hashJson(entry.task) === requirement.sha256
      : entry.type === 'steering' &&
        (entry.deliveryId ?? entry.id) === requirement.submissionId &&
        entry.runId === requirement.runId &&
        hashJson(entry.content) === requirement.sha256
  );
}

/** Corrections can change one clause; only explicit replacement supersedes a whole contribution. */
export function codingWorkContextAnchors(
  work: CodingWork,
  entries: readonly SessionBranchEntry[]
): readonly SessionBranchEntry[] {
  const objective = work.requirementSources[0];
  const selected = new Set(objective === undefined ? [] : [objective.submissionId]);
  const anchors: SessionBranchEntry[] = [];
  // Source relationships point forward, so one pass preserves original contribution order.
  for (const source of work.requirementSources) {
    if (!selected.has(source.submissionId)) continue;
    if (source.supersededBy !== undefined) selected.add(source.supersededBy);
    else {
      for (const correction of source.correctedBy ?? []) selected.add(correction);
      const entry = codingRequirementSourceEntry(source, work, entries);
      if (entry !== undefined) anchors.push(entry);
    }
  }
  return Object.freeze(anchors);
}

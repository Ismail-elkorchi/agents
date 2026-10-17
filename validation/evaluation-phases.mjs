import { createHash } from 'node:crypto';
import { validateToolEffects } from '@agent-core/tools';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const changed = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .sort().filter(file => JSON.stringify(before[file]) !== JSON.stringify(after[file]));
const identity = (event, runId) => JSON.stringify([runId, event.turnIndex, event.turnId, event.requestAttempt, event.toolBatchId,
  event.callIndex, event.callId, event.toolAttempt]);

/** Evidence for initial no-edit runs. Never classifies shell command strings.
 * Tool effects and observations are host-emitted evidence, not model claims.
 * Snapshot equality alone cannot exclude an edit followed by a revert.
 */
export class EvaluationPhases {
  #criteria;
  #before;
  #results = [];
  #calls = new Map();
  #gaps = [];
  #runIds = new Set();
  constructor(criteria, before) {
    this.#criteria = structuredClone(criteria);
    this.#before = structuredClone(before);
  }
  record(event, runId) {
    if (!this.#criteria[this.#results.length]) return;
    if (typeof runId !== 'string' || !runId) this.gap('Progress event has no run identity.');
    else this.#runIds.add(runId);
    if (event.type === 'tool.observation.unavailable') this.gap('Tool observation unavailable.');
    if (!['tool.started', 'tool.ended'].includes(event.type)) return;
    if (!['turnId', 'toolBatchId'].every(field => typeof event[field] === 'string' && event[field]) ||
        !['turnIndex', 'requestAttempt', 'callIndex', 'toolAttempt'].every(field =>
          Number.isInteger(event[field]) && event[field] >= 0))
      this.gap('Tool event has an incomplete canonical identity.');
    const key = identity(event, runId);
    const call = this.#calls.get(key) ?? { identity: key, toolName: event.toolName };
    if (call.toolName !== event.toolName) this.gap('Tool identity changed names between events.');
    if (event.type === 'tool.started') {
      if (call.started) this.gap('Duplicate tool start.');
      call.started = true;
      call.effects = structuredClone(event.effects);
      try {
        validateToolEffects(event.effects);
        call.effectsValid = true;
      } catch {
        call.effectsValid = false;
        this.gap('Tool start has missing or invalid canonical effects.');
      }
    } else {
      if (call.observation) this.gap('Duplicate tool end.');
      call.observation = structuredClone(event.observation);
    }
    this.#calls.set(key, call);
  }
  gap(reason) { this.#gaps.push(reason); }
  completeRun(runId, after, { complete = true } = {}) {
    const criterion = this.#criteria[this.#results.length];
    if (!criterion) return;
    const uncertainties = [...this.#gaps];
    if ([...this.#runIds].some(observedRunId => observedRunId !== runId))
      uncertainties.push('Progress evidence belongs to a different run.');
    if (!complete) uncertainties.push('Run boundary is incomplete.');
    const mutations = [], attempts = [], tools = [];
    for (const call of this.#calls.values()) {
      const observation = call.observation;
      const accesses = call.effectsValid ? call.effects.accesses : undefined;
      // Successful reads and patch results may omit Core's optional lifecycle.
      // Explicit active/unknown states remain uncertain; omission on a result
      // does not manufacture a settled receipt in the retained evidence.
      const completedResult = observation?.execution?.state === 'settled' ||
        (observation?.kind === 'result' && observation.execution === undefined);
      const writing = Array.isArray(accesses) && accesses.some(access => ['write', 'delete'].includes(access.mode));
      const mutationAttempt = writing || call.toolName === 'apply_patch';
      const evidence = { identity: call.identity, toolName: call.toolName,
        started: call.started === true, effects: call.effects,
        observationKind: observation?.kind, execution: observation?.execution,
        applicationStatus: observation?.output?.applicationStatus };
      tools.push(evidence);
      if (mutationAttempt) attempts.push(evidence);
      // A rejected request is an attempt, not a mutation. It may never emit a start.
      if (observation?.execution?.state === 'not_started') continue;
      if (!call.started || !observation) {
        uncertainties.push(`Missing tool start/end: ${call.identity}`);
        continue;
      }
      if (call.toolName === 'apply_patch' && observation.kind === 'result' &&
          observation.output?.applicationStatus === 'applied') {
        mutations.push({ ...evidence, changedPaths: observation.output.changedPaths ?? [] });
        continue;
      }
      // Only explicit host effect envelopes establish that executed work cannot
      // write. Execute/network/unknown access remains opaque even when it exits 0.
      if (Array.isArray(accesses) && accesses.every(access => access.mode === 'read') &&
          completedResult) continue;
      // A dry run/no-op is a structured tool result; rolled-back transactions are
      // deliberately excluded because transient changes cannot be ruled out.
      if (call.toolName === 'apply_patch' && observation.kind === 'result' &&
          ['dry_run', 'no_change'].includes(observation.output?.applicationStatus) &&
          completedResult) continue;
      uncertainties.push(`Executed tool does not prove absence of mutations: ${call.identity}`);
    }
    const changedFiles = changed(this.#before, after);
    const violated = changedFiles.length > 0 || mutations.length > 0 ||
      (criterion.mutationAttempts === 'forbidden' && attempts.length > 0);
    const result = {
      criterion, runId, status: violated ? 'violated' : uncertainties.length ? 'unproven' : 'passed',
      beforeSha256: digest(this.#before), afterSha256: digest(after),
      snapshots: { before: structuredClone(this.#before), after: structuredClone(after) }, changedFiles,
      mutations, attempts, tools, uncertainties
    };
    this.#results.push(result);
    // This is the immediately previous boundary, never the initial/final tree.
    this.#before = structuredClone(after);
    this.#calls.clear();
    this.#gaps = [];
    this.#runIds.clear();
    return result;
  }
  toJSON() {
    return structuredClone([...this.#results, ...this.#criteria.slice(this.#results.length).map(criterion => ({
      criterion, status: 'unproven', uncertainties: ['Required completed-run boundary was not observed.']
    }))]);
  }
}

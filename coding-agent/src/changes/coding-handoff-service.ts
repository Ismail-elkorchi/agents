import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import type { ArtifactRepository, EventRepository } from '@agent-core/persistence';
import type { AgentEndedRunResult, AgentEvent } from '@agent-core/runtime';
import { captureWorkspaceSnapshot, RootedFileAuthority } from '@agent-core/tools-local';
import { PrivateStateDirectory } from '../state/private-state.js';
import { deleteVerificationRunState } from '../verification/run-cleanup.js';
import { createCodingHandoff, decodeCodingHandoff, type CodingHandoff } from './coding-handoff.js';
import { isolatedWorkingCopyWorkspacePath } from './isolated-working-copy.js';
import { createRunChangeReport } from './run-change-report.js';

const MAX_PERSISTED_HANDOFF_BYTES = 4 * 1024 * 1024;

export class CodingHandoffService {
  readonly #state: PrivateStateDirectory;
  readonly #runtimeDirectory: string;
  readonly #sourceRoot: RootedFileAuthority;
  readonly #events: EventRepository<AgentEvent>;
  readonly #artifacts: ArtifactRepository;
  readonly #pending = new Map<string, Promise<CodingHandoff>>();
  readonly #failures = new Map<string, unknown>();

  constructor(input: {
    readonly state: PrivateStateDirectory;
    readonly runtimeDirectory: string;
    readonly root: RootedFileAuthority;
    readonly events: EventRepository<AgentEvent>;
    readonly artifacts: ArtifactRepository;
  }) {
    this.#state = input.state;
    this.#runtimeDirectory = input.runtimeDirectory;
    this.#sourceRoot = input.root;
    this.#events = input.events;
    this.#artifacts = input.artifacts;
  }

  async read(runId: string): Promise<CodingHandoff | undefined> {
    const value = await this.#state.read(handoffPath(runId));
    return value === undefined ? undefined : decodeCodingHandoff(JSON.parse(value), runId);
  }

  finalize(runId: string, result: AgentEndedRunResult): Promise<CodingHandoff> {
    const existing = this.#pending.get(runId);
    if (existing) return existing;
    const pending = this.#finalize(runId, result)
      .then((handoff) => { this.#failures.delete(runId); return handoff; })
      .catch((error: unknown) => { this.#failures.set(runId, error); throw error; })
      .finally(() => this.#pending.delete(runId));
    this.#pending.set(runId, pending);
    return pending;
  }

  async close(): Promise<void> {
    const pendingFailures = await Promise.all([...this.#pending.values()].map(async (pending): Promise<unknown> => {
      try { await pending; return undefined; }
      catch (error: unknown) { return error; }
    }));
    const failures = [...new Set<unknown>([
      ...pendingFailures.filter((failure) => failure !== undefined),
      ...this.#failures.values()
    ])];
    if (failures.length > 0) throw new AggregateError(failures, 'Coding handoff finalization failed.');
  }

  async #finalize(runId: string, result: AgentEndedRunResult): Promise<CodingHandoff> {
    const stored = await this.read(runId);
    if (stored) {
      await deleteVerificationRunState({ state: this.#state, runtimeDirectory: this.#runtimeDirectory, runId });
      return stored;
    }
    const facts = await runFacts(this.#events, runId);
    const workingCopyPath = isolatedWorkingCopyWorkspacePath(this.#runtimeDirectory, runId);
    const hasWorkingCopy = await realDirectoryExists(workingCopyPath);
    const reviewRoot = hasWorkingCopy ? RootedFileAuthority.adopt(workingCopyPath) : this.#sourceRoot;
    let report;
    try {
      report = await createRunChangeReport({ runId, root: reviewRoot, state: this.#state, events: this.#events, result });
    } finally {
      if (hasWorkingCopy) reviewRoot.close();
    }
    const publication = publicationStatus(facts.disposition, report.finalDigest);
    if (publication.status === 'applied') {
      const source = await captureWorkspaceSnapshot(this.#sourceRoot);
      if (source.coverage !== 'complete' || source.digest !== report.finalDigest) {
        throw new Error(`Applied run ${runId} does not match its reviewed working-copy revision.`);
      }
    }
    const changeArtifact = await this.#artifacts.store({
      label: `coding-handoff-${createHash('sha256').update(runId).digest('hex').slice(0, 16)}`,
      content: new TextEncoder().encode(JSON.stringify(report, null, 2)),
      mediaType: 'application/json; charset=utf-8',
      description: `Exact bounded change report for Coding Agent run ${runId}.`
    });
    const handoff = createCodingHandoff({ task: facts.task, result, changeReport: report, changeArtifact, publication });
    const encoded = JSON.stringify(handoff);
    if (Buffer.byteLength(encoded) > MAX_PERSISTED_HANDOFF_BYTES) throw new Error(`Coding handoff ${runId} exceeds its persistence budget.`);
    await this.#state.write(handoffPath(runId), encoded);
    await deleteVerificationRunState({ state: this.#state, runtimeDirectory: this.#runtimeDirectory, runId });
    return handoff;
  }
}

async function runFacts(events: EventRepository<AgentEvent>, runId: string): Promise<{
  readonly task: string;
  readonly disposition?: Extract<AgentEvent, { readonly type: 'run.disposition.decided' }>;
}> {
  let task: string | undefined;
  let disposition: Extract<AgentEvent, { readonly type: 'run.disposition.decided' }> | undefined;
  for await (const envelope of events.read(runId)) {
    if (envelope.event.type === 'run.started') task = envelope.event.task;
    else if (envelope.event.type === 'run.disposition.decided') disposition = envelope.event;
  }
  if (task === undefined) throw new Error(`Run ${runId} has no admitted task for its coding handoff.`);
  return Object.freeze({ task, ...(disposition ? { disposition } : {}) });
}

function publicationStatus(
  disposition: Extract<AgentEvent, { readonly type: 'run.disposition.decided' }> | undefined,
  revision: string
): CodingHandoff['publication'] {
  if (disposition?.decision.kind === 'accept') {
    return disposition.implementationId.startsWith('coding-agent.disposition.verify-and-apply@')
      ? Object.freeze({ status: 'applied' as const, revision })
      : Object.freeze({ status: 'not_applicable' as const, revision });
  }
  const reason = disposition?.decision.kind === 'fail' || disposition?.decision.kind === 'inconclusive'
    ? disposition.decision.reason
    : 'The run ended without an accepted publication decision.';
  return Object.freeze({ status: 'not_applied' as const, revision, reason });
}

async function realDirectoryExists(directory: string): Promise<boolean> {
  try {
    const status = await lstat(directory);
    return status.isDirectory() && !status.isSymbolicLink();
  } catch (error) {
    if (nodeCode(error) === 'ENOENT') return false;
    throw error;
  }
}

function handoffPath(runId: string): string { return `coding-handoffs/${createHash('sha256').update(runId).digest('hex')}.json`; }
function nodeCode(error: unknown): string | undefined { return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined; }

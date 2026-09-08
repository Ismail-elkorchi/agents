import type { ArtifactRepository, EventRepository } from '@agent-core/persistence';
import type { AgentEvent } from '@agent-core/runtime';
import { captureWorkspaceSnapshot, RootedFileAuthority } from '@agent-core/tools-local';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import type { CodingEndedRunResult } from '../outcome.js';
import { PrivateStateDirectory } from '../state/private-state.js';
import type { CodingWorkRepository } from '../work.js';
import { createCodingHandoff, decodeCodingHandoff, type CodingHandoff } from './coding-handoff.js';
import { isolatedWorkingCopyWorkspacePath } from './isolated-working-copy.js';
import { createRunChangeReport } from './run-change-report.js';

const MAX_PERSISTED_HANDOFF_BYTES = 4 * 1024 * 1024;

export class CodingHandoffService {
  readonly #work: CodingWorkRepository;
  readonly #state: PrivateStateDirectory;
  readonly #runtimeDirectory: string;
  readonly #sourceRoot: RootedFileAuthority;
  readonly #events: EventRepository<AgentEvent>;
  readonly #artifacts: ArtifactRepository;
  readonly #pending = new Map<string, Promise<CodingHandoff>>();
  readonly #failures = new Map<string, unknown>();

  constructor(input: {
    readonly state: PrivateStateDirectory;
    readonly work: CodingWorkRepository;
    readonly runtimeDirectory: string;
    readonly root: RootedFileAuthority;
    readonly events: EventRepository<AgentEvent>;
    readonly artifacts: ArtifactRepository;
  }) {
    this.#work = input.work;
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

  finalize(runId: string, result: CodingEndedRunResult): Promise<CodingHandoff> {
    const existing = this.#pending.get(runId);
    if (existing) return existing;
    const pending = this.#finalize(runId, result)
      .then((handoff) => {
        this.#failures.delete(runId);
        return handoff;
      })
      .catch((error: unknown) => {
        this.#failures.set(runId, error);
        throw error;
      })
      .finally(() => this.#pending.delete(runId));
    this.#pending.set(runId, pending);
    return pending;
  }

  async close(): Promise<void> {
    const pendingFailures = await Promise.all(
      [...this.#pending.values()].map(async (pending): Promise<unknown> => {
        try {
          await pending;
          return undefined;
        } catch (error: unknown) {
          return error;
        }
      })
    );
    const failures = [
      ...new Set<unknown>([
        ...pendingFailures.filter((failure) => failure !== undefined),
        ...this.#failures.values()
      ])
    ];
    if (failures.length > 0) throw new AggregateError(failures, 'Coding handoff finalization failed.');
  }

  async #finalize(runId: string, result: CodingEndedRunResult): Promise<CodingHandoff> {
    const stored = await this.read(runId);
    if (stored) {
      if (stored.publication.status === 'applied')
        await this.#work.publish(stored.outcome.workId, stored.reviewedRevision);
      return stored;
    }
    const work = await this.#work.forRun(runId);
    if (work?.mode !== 'revision')
      throw new Error('A coding change handoff requires admitted revision work.');
    const started = await this.#events.latestOfType(runId, 'run.started');
    if (started?.event.type !== 'run.started')
      throw new Error('Coding handoff requires its committed task.');
    const workingCopyPath = isolatedWorkingCopyWorkspacePath(this.#runtimeDirectory, work.workId);
    const hasWorkingCopy =
      result.outcome.publication !== 'applied' && (await realDirectoryExists(workingCopyPath));
    const reviewRoot = hasWorkingCopy ? RootedFileAuthority.adopt(workingCopyPath) : this.#sourceRoot;
    let report;
    try {
      report = await createRunChangeReport({
        runId,
        workId: work.workId,
        root: reviewRoot,
        state: this.#state,
        events: this.#events
      });
    } finally {
      if (hasWorkingCopy) reviewRoot.close();
    }
    const publication: CodingHandoff['publication'] = {
      status: result.outcome.publication,
      revision: report.finalDigest,
      ...(result.outcome.publication === 'not_applied'
        ? { reason: result.outcome.reason ?? 'The proposed revision was not published.' }
        : {})
    };
    if (result.outcome.revision !== undefined && result.outcome.revision !== report.finalDigest)
      throw new Error('Coding handoff revision differs from the application outcome.');
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
    const handoff = createCodingHandoff({
      task: started.event.task,
      result,
      changeReport: report,
      changeArtifact,
      publication
    });
    const encoded = JSON.stringify(handoff);
    if (Buffer.byteLength(encoded) > MAX_PERSISTED_HANDOFF_BYTES)
      throw new Error(`Coding handoff ${runId} exceeds its persistence budget.`);
    await this.#state.write(handoffPath(runId), encoded);
    if (publication.status === 'applied') await this.#work.publish(work.workId, report.finalDigest);
    return handoff;
  }
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

function handoffPath(runId: string): string {
  return `coding-handoffs/${createHash('sha256').update(runId).digest('hex')}.json`;
}
function nodeCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

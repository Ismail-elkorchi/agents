import { createHash } from 'node:crypto';
import type { EventRepository } from '@agent-core/persistence';
import type { AgentEndedRunResult, AgentEvent } from '@agent-core/runtime';
import type { RootedFileAuthority } from '@agent-core/tools-local';
import { PrivateStateDirectory } from '../state/private-state.js';
import { deleteVerificationRunState } from '../verification/run-cleanup.js';
import { createRunChangeReport, decodeRunChangeReport, type RunChangeReport } from './run-change-report.js';

const MAX_PERSISTED_REPORT_BYTES = 4 * 1024 * 1024;

export class RunChangeReportService {
  readonly #state: PrivateStateDirectory;
  readonly #runtimeDirectory: string;
  readonly #root: RootedFileAuthority;
  readonly #events: EventRepository<AgentEvent>;
  readonly #pending = new Map<string, Promise<RunChangeReport>>();
  readonly #failures = new Map<string, unknown>();

  constructor(input: {
    readonly state: PrivateStateDirectory;
    readonly runtimeDirectory: string;
    readonly root: RootedFileAuthority;
    readonly events: EventRepository<AgentEvent>;
  }) {
    this.#state = input.state;
    this.#runtimeDirectory = input.runtimeDirectory;
    this.#root = input.root;
    this.#events = input.events;
  }

  async read(runId: string): Promise<RunChangeReport | undefined> {
    const value = await this.#state.read(reportPath(runId));
    return value === undefined ? undefined : decodeRunChangeReport(JSON.parse(value), runId);
  }

  finalize(runId: string, result: AgentEndedRunResult): Promise<RunChangeReport> {
    const existing = this.#pending.get(runId);
    if (existing) return existing;
    const pending = this.#finalize(runId, result)
      .then((report) => { this.#failures.delete(runId); return report; })
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
    if (failures.length > 0) throw new AggregateError(failures, 'Run change report finalization failed.');
  }

  async #finalize(runId: string, result: AgentEndedRunResult): Promise<RunChangeReport> {
    const stored = await this.read(runId);
    if (stored) return stored;
    const report = await createRunChangeReport({ runId, root: this.#root, state: this.#state, events: this.#events, result });
    const encoded = JSON.stringify(report);
    if (Buffer.byteLength(encoded) > MAX_PERSISTED_REPORT_BYTES) throw new Error(`Run change report ${runId} exceeds its persistence budget.`);
    await this.#state.write(reportPath(runId), encoded);
    await deleteVerificationRunState({ state: this.#state, runtimeDirectory: this.#runtimeDirectory, runId });
    return report;
  }
}

function reportPath(runId: string): string {
  return `run-change-reports/${createHash('sha256').update(runId).digest('hex')}.json`;
}

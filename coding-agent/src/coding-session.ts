import {
  AgentSession,
  type AgentEndedRunResult,
  type AgentRunResult,
  type AgentSessionEvent,
  type AgentSessionSubmissionResult
} from '@agent-core/runtime';
import type { CodingEndedRunResult, CodingRunResult } from './outcome.js';

export type CodingSessionEvent =
  | Exclude<AgentSessionEvent, { readonly type: 'run.completed' }>
  | { readonly type: 'run.completed'; readonly runId: string; readonly result: CodingRunResult };

export type CodingSessionSubmissionResult =
  | Extract<AgentSessionSubmissionResult, { readonly kind: 'rejected' }>
  | {
      readonly kind: 'started' | 'steered';
      readonly submissionId: string;
      readonly runId: string;
      readonly completion: Promise<CodingRunResult>;
    }
  | {
      readonly kind: 'queued';
      readonly submissionId: string;
      readonly runId: string;
      readonly completion: Promise<CodingRunResult>;
    };

interface CodingSessionApplication {
  settle(result: AgentEndedRunResult, signal: AbortSignal): Promise<CodingEndedRunResult>;
  recover(): Promise<readonly AgentEndedRunResult[]>;
  readExecution(runId: string): Promise<AgentEndedRunResult>;
}

/** Owns acceptance and queue advancement; delivery listeners never execute application effects. */
export class CodingSession {
  private readonly completions = new WeakMap<Promise<AgentRunResult>, Promise<CodingRunResult>>();
  private readonly pending = new Set<Promise<CodingRunResult>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly blocked = new Map<string, string>();
  private readonly listeners = new Set<(event: CodingSessionEvent) => void | Promise<void>>();
  private closing = false;
  private scheduling: Promise<void> = Promise.resolve();

  constructor(
    private readonly session: AgentSession,
    private readonly application: CodingSessionApplication
  ) {
    session.subscribe((event) => (event.type === 'run.completed' ? undefined : this.deliver(event)));
  }

  state(): ReturnType<AgentSession['state']> & {
    readonly pendingSettlement?: { readonly runId: string; readonly reason: string };
  } {
    const state = this.session.state();
    const runId = this.controllers.keys().next().value;
    const blocked = this.blocked.entries().next().value;
    return {
      ...state,
      ...(state.phase === 'idle' && runId !== undefined
        ? { phase: 'running' as const, activeRunId: runId }
        : {}),
      ...(blocked ? { pendingSettlement: { runId: blocked[0], reason: blocked[1] } } : {})
    };
  }

  subscribe(listener: (event: CodingSessionEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async restore(): Promise<void> {
    await this.session.restore();
    for (const execution of await this.application.recover()) {
      const result = await this.settle(execution);
      await this.deliver({ type: 'run.completed', runId: execution.terminal.runId, result });
    }
  }

  async submit(...args: Parameters<AgentSession['submit']>): Promise<CodingSessionSubmissionResult> {
    const submission = await this.session.submit(...args);
    if (submission.kind === 'rejected') return submission;
    const completion = this.track(submission.completion);
    const started = await this.startNext();
    return started?.kind === 'started' && started.submissionId === submission.submissionId
      ? { ...started, completion }
      : { ...submission, completion };
  }

  inspect() {
    return this.session.inspect();
  }

  configure(...args: Parameters<AgentSession['configure']>) {
    return this.session.configure(...args);
  }
  updateQueuedSubmission(...args: Parameters<AgentSession['updateQueuedSubmission']>) {
    return this.session.updateQueuedSubmission(...args);
  }
  transitionContext(...args: Parameters<AgentSession['transitionContext']>) {
    return this.session.transitionContext(...args);
  }
  branchFrom(...args: Parameters<AgentSession['branchFrom']>) {
    return this.session.branchFrom(...args);
  }
  inspectSuspension() {
    return this.session.inspectSuspension();
  }

  reconcileExternal(runId: string) {
    return this.track(this.session.reconcileExternal(runId));
  }
  resumeImplementation(runId: string) {
    return this.track(this.session.resumeImplementation(runId));
  }
  resolveDecision(...args: Parameters<AgentSession['resolveDecision']>) {
    return this.track(this.session.resolveDecision(...args));
  }
  resolveApproval(...args: Parameters<AgentSession['resolveApproval']>) {
    return this.track(this.session.resolveApproval(...args));
  }

  async reconcileWork(runId: string): Promise<CodingEndedRunResult> {
    if (this.controllers.size > 0 || this.session.state().phase !== 'idle')
      throw new Error('Coding work reconciliation requires an idle execution boundary.');
    const result = await this.settle(await this.application.readExecution(runId));
    await this.deliver({ type: 'run.completed', runId, result });
    await this.startNext();
    return result;
  }

  async abort(reason?: string, expectedRunId?: string): Promise<boolean> {
    const runId = expectedRunId ?? this.controllers.keys().next().value;
    const controller = runId === undefined ? undefined : this.controllers.get(runId);
    if (controller) {
      controller.abort(new Error(reason ?? 'Coding work settlement cancelled.'));
      return true;
    }
    return this.session.abort(reason, expectedRunId);
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.scheduling;
    for (const controller of this.controllers.values())
      controller.abort(new Error('Coding application closed.'));
    if (this.session.state().phase === 'running') await this.session.abort('Coding application closed.');
    await this.session.waitForIdle();
    await Promise.all(this.pending);
  }

  async waitForIdle(): Promise<void> {
    for (;;) {
      await this.session.waitForIdle();
      await Promise.all(this.pending);
      if (this.blocked.size > 0 || this.session.state().phase === 'suspended') return;
      await this.startNext();
      if (this.session.state().phase === 'idle' && this.pending.size === 0) return;
    }
  }

  private track(completion: Promise<AgentRunResult>): Promise<CodingRunResult> {
    const existing = this.completions.get(completion);
    if (existing) return existing;
    const pending = completion
      .then(async (execution) => {
        this.pending.add(pending);
        const result = execution.state === 'ended' ? await this.settle(execution) : execution;
        const runId = result.state === 'ended' ? result.terminal.runId : result.runId;
        await this.deliver({ type: 'run.completed', runId, result });
        await this.startNext();
        return result;
      })
      .finally(() => this.pending.delete(pending));
    this.completions.set(completion, pending);
    // Callers receive the original rejection; ignored queued completions cannot become unhandled rejections.
    void pending.catch(() => undefined);
    return pending;
  }

  private async settle(execution: AgentEndedRunResult): Promise<CodingEndedRunResult> {
    const runId = execution.terminal.runId;
    if (this.controllers.has(runId)) throw new Error('Coding work settlement already has a live owner.');
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    if (this.closing) controller.abort(new Error('Coding application closed.'));
    try {
      const result = await this.application.settle(execution, controller.signal);
      if (result.outcome.stage === 'awaiting_reconciliation')
        this.blocked.set(runId, result.outcome.reason ?? 'Application effects require reconciliation.');
      else this.blocked.delete(runId);
      return result;
    } catch (error) {
      this.blocked.set(runId, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.controllers.delete(runId);
    }
  }

  private startNext(): Promise<AgentSessionSubmissionResult | undefined> {
    const action = this.scheduling.then(async () => {
      if (this.closing || this.controllers.size > 0 || this.blocked.size > 0) return undefined;
      const started = await this.session.startNextSubmission();
      if (started && started.kind !== 'rejected') void this.track(started.completion);
      return started;
    });
    this.scheduling = action.then(
      () => undefined,
      () => undefined
    );
    return action;
  }

  private async deliver(event: CodingSessionEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch {
        /* Delivery cannot change recorded execution or application outcomes. */
      }
    }
  }
}

import {
  reliableSourceMessage,
  replaceableSourceMessage
} from '@ismail-elkorchi/terminal-ui/tui';
import { ignoreMessage } from '@ismail-elkorchi/terminal-ui/interaction';
import type { MessageResolution } from '@ismail-elkorchi/terminal-ui/interaction';
import type {
  TuiEventSource,
  TuiSourceSink,
  TuiSourceEmission,
  TuiSubscriptionContext
} from '@ismail-elkorchi/terminal-ui/tui';
import type { CodingAgentTuiMessage } from './messages.js';

export class CodingAgentTuiEventSource implements TuiEventSource<CodingAgentTuiMessage> {
  readonly id = 'coding-agent-events';
  readonly generation = 0;
  readonly source = 'external';
  readonly channel = { capacity: 64 };

  private readonly attached = deferred<TuiSourceSink<CodingAgentTuiMessage>>();
  private readonly completion = deferred<undefined>();
  private admission: Promise<void> = Promise.resolve();
  private accepting = true;
  private running = false;
  private cancelled = false;
  private failed = false;

  enqueue(message: CodingAgentTuiMessage): Promise<void> {
    if (!this.accepting) return Promise.reject(new Error('Coding Agent TUI event source is closed.'));
    const admission = this.admission.then(async () => {
      const sink = await this.attached.promise;
      await sink.emit(sourceEmission(message));
    });
    this.admission = admission;
    void admission.catch((cause: unknown) => {
      this.failed = true;
      this.completion.reject(cause);
    });
    return admission;
  }

  async run(
    context: TuiSubscriptionContext,
    sink: TuiSourceSink<CodingAgentTuiMessage>
  ): Promise<void> {
    if (this.running) throw new Error('Coding Agent TUI event source is already running.');
    this.running = true;
    this.attached.resolve(sink);
    await Promise.race([this.completion.promise, aborted(context.signal)]);
    if (context.signal.aborted) {
      this.accepting = false;
      this.cancelled = true;
    }
  }

  onLifecycle(
    event: import('@ismail-elkorchi/terminal-ui/tui').TuiSourceLifecycle
  ): MessageResolution<CodingAgentTuiMessage> {
    return event.kind === 'failed'
      ? { type: 'delivery.failed', message: event.diagnostic.message }
      : ignoreMessage();
  }

  async dispose(): Promise<void> {
    if (this.cancelled || this.failed) {
      this.accepting = false;
      await this.admission.catch(() => undefined);
      return;
    }
    return this.close();
  }

  async close(): Promise<void> {
    if (this.cancelled) {
      await this.admission.catch(() => undefined);
      return;
    }
    if (!this.accepting) return this.admission;
    this.accepting = false;
    if (!this.running) this.attached.reject(new Error('Coding Agent TUI event source closed before attachment.'));
    try {
      await this.admission;
      this.completion.resolve(undefined);
    } catch (cause) {
      this.completion.reject(cause);
      throw cause;
    }
  }
}

function sourceEmission(message: CodingAgentTuiMessage): TuiSourceEmission<CodingAgentTuiMessage> {
  if (message.type !== 'progress') return reliableSourceMessage(message);
  const event = message.event;
  switch (event.type) {
    case 'assistant.delta':
      return replaceableSourceMessage(`assistant:${event.turnId}:content`, message);
    case 'assistant.reasoning':
      return replaceableSourceMessage(
        `assistant:${event.turnId}:reasoning:${event.channel ?? 'reasoning'}`,
        message
      );
    case 'assistant.status':
      return replaceableSourceMessage(`assistant:${event.turnId}:status`, message);
    case 'tool.updated':
      return replaceableSourceMessage(
        `tool:${event.turnId}:${event.toolBatchId}:${String(event.callIndex)}:${String(event.toolAttempt)}`,
        message
      );
    default:
      return reliableSourceMessage(message);
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve(); }, { once: true });
  });
}

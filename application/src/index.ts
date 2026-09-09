export { progressReplacementKey } from './progress.js';
export type ApplicationDeliveryEvent =
  | { readonly type: 'delivery.gap' }
  | { readonly type: 'delivery.failed'; readonly error: Error };

type Listener<Event> = (event: Event | ApplicationDeliveryEvent) => void | Promise<void>;
interface Subscription<Event> {
  readonly listener: Listener<Event>;
  readonly queue: (Event | ApplicationDeliveryEvent)[];
  active: boolean;
  delivering: boolean;
}

/** Delivery is bounded and independent of application execution and settlement. */
export class ApplicationEvents<Event> {
  private readonly subscriptions = new Set<Subscription<Event>>();

  constructor(
    private readonly replacementKey: (event: Event | ApplicationDeliveryEvent) => string | undefined = () =>
      undefined
  ) {}

  subscribe(listener: Listener<Event>): () => void {
    const subscription: Subscription<Event> = { listener, queue: [], active: true, delivering: false };
    this.subscriptions.add(subscription);
    return () => {
      this.detach(subscription);
    };
  }

  publish(event: Event | ApplicationDeliveryEvent): void {
    for (const subscription of this.subscriptions) {
      const key = this.replacementKey(event);
      if (key !== undefined) {
        let replaced = false;
        for (let index = subscription.queue.length - 1; index >= 0; index--) {
          const queued = subscription.queue[index];
          if (queued === undefined) break;
          const previousKey = this.replacementKey(queued);
          if (previousKey === undefined) break;
          if (previousKey === key) {
            subscription.queue[index] = event;
            replaced = true;
            break;
          }
        }
        if (replaced) continue;
      }
      if (subscription.queue.length === 64) {
        subscription.queue.length = 0;
        subscription.queue.push({ type: 'delivery.gap' });
      }
      subscription.queue.push(event);
      if (!subscription.delivering) void this.deliver(subscription);
    }
  }

  close(): void {
    for (const subscription of this.subscriptions) this.detach(subscription);
  }

  private detach(subscription: Subscription<Event>): void {
    subscription.active = false;
    subscription.queue.length = 0;
    this.subscriptions.delete(subscription);
  }

  private async deliver(subscription: Subscription<Event>): Promise<void> {
    subscription.delivering = true;
    try {
      while (subscription.active && subscription.queue.length > 0) {
        const event = subscription.queue.shift();
        if (event !== undefined) await subscription.listener(event);
      }
    } catch (cause) {
      this.detach(subscription);
      this.publish({
        type: 'delivery.failed',
        error: cause instanceof Error ? cause : new Error(String(cause))
      });
    } finally {
      subscription.delivering = false;
    }
  }
}

export {
  sessionBranchBoundary,
  sessionBranchPageParameters,
  sessionBranchSearchParameters
} from './session-parameters.js';

export { findBranchMatches } from './history-search.js';
export { noteListParameters, noteReadParameters } from './note-parameters.js';
export { SessionNotes, type SessionNoteRead } from './session-notes.js';

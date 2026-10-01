import { progressReplacementKey } from '@agent-core/runtime';
import { applicationEventSource } from '@agent-core/tui';

/** Test producer: attach to the same runtime-owned source used by applications. */
export function createTestEventSource() {
  let emit;
  let reject;
  let failure;
  const source = applicationEventSource('coding-agent-events', {
    replacementKey: (message) =>
      message.type === 'progress' ? progressReplacementKey(message.event) : undefined,
    failureMessage: (message) => ({ type: 'delivery.failed', message }),
    subscribe(deliver, failed) {
      emit = deliver;
      reject = failed;
      return () => {
        emit = undefined;
        reject = undefined;
      };
    }
  });
  return {
    ...source,
    async enqueue(message) {
      if (emit === undefined) throw new Error('Test event source is closed.');
      try {
        await emit(message);
      } catch (cause) {
        failure = cause;
        reject?.(cause);
        throw cause;
      }
    },
    fail(cause) {
      failure = cause;
      reject?.(cause);
    },
    async close() {
      if (failure !== undefined) throw failure;
    }
  };
}

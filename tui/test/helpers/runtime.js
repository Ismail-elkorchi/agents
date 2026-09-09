import { setTimeout } from 'node:timers/promises';

/** Functional state assertions share the scenario deadline; latency has a separate measured workload. */
export async function waitForState(runtime, signal, condition) {
  while (!condition()) {
    if (runtime.exit() !== undefined) throw new Error('Terminal exited before the expected state.');
    await setTimeout(5, undefined, { signal });
  }
}

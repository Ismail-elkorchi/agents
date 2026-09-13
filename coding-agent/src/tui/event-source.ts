import { progressReplacementKey } from '@agent-core/runtime';
import { TuiEventChannel } from '@agent-core/tui';
import type { CodingAgentTuiMessage } from './messages.js';

export function createCodingTuiEventSource() {
  return new TuiEventChannel<CodingAgentTuiMessage>('coding-agent-events', {
    replacementKey: (message) =>
      message.type === 'progress' ? progressReplacementKey(message.event) : undefined,
    failureMessage: (message) => ({ type: 'delivery.failed', message })
  });
}

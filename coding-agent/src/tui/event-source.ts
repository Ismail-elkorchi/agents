import { progressReplacementKey } from '@agents/application';
import { TuiEventChannel } from '@agents/tui';
import type { CodingAgentTuiMessage } from './messages.js';

export function createCodingTuiEventSource() {
  return new TuiEventChannel<CodingAgentTuiMessage>('coding-agent-events', {
    replacementKey: (message) =>
      message.type === 'progress' ? progressReplacementKey(message.event) : undefined,
    failureMessage: (message) => ({ type: 'delivery.failed', message })
  });
}

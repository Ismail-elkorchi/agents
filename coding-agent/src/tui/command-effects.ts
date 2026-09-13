import { diagnosticMessage } from '@agent-core/tui';
import type { TuiEffect } from '@ismail-elkorchi/terminal-ui/tui';
import type { CodingAgentTuiCommandHandler, CodingAgentTuiCommandRequest } from './command-surface.js';
import type { CodingAgentTuiMessage } from './messages.js';

export function commandEffect(
  request: CodingAgentTuiCommandRequest,
  handler: CodingAgentTuiCommandHandler | undefined
): TuiEffect<CodingAgentTuiMessage> {
  return {
    id: request.id,
    concurrency: 'parallel',
    async run(context) {
      if (context.signal.aborted) return { kind: 'none' };
      if (handler === undefined) throw new Error('No command handler is attached.');
      const execution = await (request.kind === 'command'
        ? handler.execute(request.value)
        : handler.submit(request.input, request.delivery));
      return {
        kind: 'message',
        message: { type: 'command.completed', execution, request }
      };
    },
    onError: ({ diagnostic }) => ({
      kind: 'message',
      message: { type: 'command.failed', request, message: diagnosticMessage(diagnostic) }
    })
  };
}

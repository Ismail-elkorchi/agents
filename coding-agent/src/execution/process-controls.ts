import { hashJson } from '@agent-core/persistence';
import type { CommandExecutionResult } from '@agent-core/tools';
import type { CodingCommandAuthority, CodingProcess } from './coding-command-authority.js';

export interface CodingProcessTarget extends CodingProcess {
  readonly sessionId: string;
}

export type CodingProcessAction =
  | { readonly kind: 'inspect'; readonly afterCursor: number }
  | { readonly kind: 'input'; readonly text: string }
  | { readonly kind: 'close-input' }
  | { readonly kind: 'terminate' };

export interface CodingProcessOperations {
  listProcesses(): Promise<readonly CodingProcessTarget[]>;
  reconcileProcesses(acknowledge?: CodingProcessTarget): Promise<readonly CodingProcessTarget[]>;
  controlProcess(
    target: CodingProcessTarget,
    action: CodingProcessAction
  ): Promise<CommandExecutionResult>;
}

/** The application binds controls to the session and original resource owner. */
export function processControls(
  sessionId: string,
  authority: CodingCommandAuthority | undefined
): CodingProcessOperations {
  return {
    async listProcesses() {
      return ((await authority?.listProcesses()) ?? []).map((process) => ({
        ...process,
        sessionId
      }));
    },
    async reconcileProcesses(acknowledge) {
      if (!authority) return [];
      if (acknowledge) {
        if (acknowledge.sessionId !== sessionId)
          throw new Error('The command belongs to another session.');
        const current = (await authority.listProcesses()).find(
          (item) => item.processId === acknowledge.processId
        );
        if (current?.revision !== acknowledge.revision || current.status !== 'unknown')
          throw new Error(
            'Command evidence changed. Refresh Processes before accepting uncertainty.'
          );
        if (hashJson(current.owner) !== hashJson(acknowledge.owner))
          throw new Error('Command owner does not match.');
        await authority.acknowledgeUnresolved([
          { processId: current.processId, revision: acknowledge.revision }
        ]);
      }
      await authority.retryReconciliation();
      return (await authority.listProcesses()).map((item) => ({ ...item, sessionId }));
    },
    async controlProcess(target, action) {
      if (target.sessionId !== sessionId)
        throw new Error('This process belongs to another session.');
      if (authority) {
        const current = (await authority.listProcesses()).find(
          (process) => process.processId === target.processId
        );
        if (current === undefined)
          throw new Error('Process identity is unavailable. Refresh the process list.');
        const left = current.owner;
        const right = target.owner;
        if (
          left.ownerId !== right.ownerId ||
          left.runId !== right.runId ||
          left.turnId !== right.turnId ||
          left.toolBatchId !== right.toolBatchId ||
          left.callIndex !== right.callIndex
        )
          throw new Error('The process owner changed. Refresh the process list.');
        if (action.kind === 'terminate')
          return authority.terminate(current.processId, current.owner);
        if (action.kind === 'input')
          await authority.writeInput(current.processId, action.text, current.owner);
        if (action.kind === 'close-input')
          await authority.closeInput(current.processId, current.owner);
        return authority.query(
          current.processId,
          4_000,
          0,
          action.kind === 'inspect' ? action.afterCursor : 0,
          current.owner
        );
      }
      throw new Error(
        'This process authority has closed. Recorded tool output remains available in the conversation.'
      );
    }
  };
}

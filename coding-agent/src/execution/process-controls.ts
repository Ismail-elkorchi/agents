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
  controlProcess(target: CodingProcessTarget, action: CodingProcessAction): Promise<CommandExecutionResult>;
}

/** The application binds controls to the session and original resource owner. */
export function processControls(
  sessionId: string,
  authorities: ReadonlySet<CodingCommandAuthority>
): CodingProcessOperations {
  return {
    async listProcesses() {
      const groups = await Promise.all([...authorities].map((authority) => authority.listProcesses()));
      return [
        ...new Map(groups.flat().map((process) => [process.processId, { ...process, sessionId }])).values()
      ];
    },
    async controlProcess(target, action) {
      if (target.sessionId !== sessionId) throw new Error('This process belongs to another session.');
      for (const authority of authorities) {
        const current = (await authority.listProcesses()).find(
          (process) => process.processId === target.processId
        );
        if (current === undefined) continue;
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
        if (action.kind === 'terminate') return authority.terminate(current.processId, current.owner);
        if (action.kind === 'input')
          await authority.writeInput(current.processId, action.text, current.owner);
        if (action.kind === 'close-input') await authority.closeInput(current.processId, current.owner);
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

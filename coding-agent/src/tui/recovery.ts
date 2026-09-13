import type { AgentRunSuspension } from '@agent-core/runtime';
import { diagnosticMessage, suspensionPresentation } from '@agent-core/tui';
import { button, dialog, richText, type Element } from '@ismail-elkorchi/terminal-ui/components';
import { column, viewport } from '@ismail-elkorchi/terminal-ui/layout';
import type { TuiContext, TuiEffect } from '@ismail-elkorchi/terminal-ui/tui';
import type { CodingAgentTuiMessage } from './messages.js';
import type { CodingAgentTuiRunState } from './state.js';

export type RecoveryAction = 'stop' | 'resume';
export type RecoveryHandler = (suspension: AgentRunSuspension, action: RecoveryAction) => Promise<string>;

export function recoveryEffect(
  suspension: AgentRunSuspension,
  action: RecoveryAction,
  handler: RecoveryHandler | undefined
): TuiEffect<CodingAgentTuiMessage> {
  return {
    id: 'run-recovery',
    concurrency: 'keep-first',
    async run() {
      if (handler === undefined) throw new Error('Recovery actions are unavailable in this interface.');
      return {
        kind: 'message',
        message: {
          type: 'recovery.finished',
          runId: suspension.runId,
          message: await handler(suspension, action)
        }
      };
    },
    onError: ({ diagnostic }) => ({
      kind: 'message',
      message: {
        type: 'recovery.finished',
        runId: suspension.runId,
        message: diagnosticMessage(diagnostic)
      }
    })
  };
}

export function recoveryDialog(
  run: Extract<CodingAgentTuiRunState, { readonly kind: 'waiting_for_recovery' }>,
  context: TuiContext,
  offsetRow: number
): Element<CodingAgentTuiMessage> {
  const { suspension } = run;
  const presentation = suspensionPresentation(suspension.reason);
  const actions: Element<CodingAgentTuiMessage>[] = [
    button({ id: 'recovery-close', label: 'Close', onPress: () => ({ type: 'overlay.close' }) }),
    button({
      id: 'recovery-stop',
      label: 'Stop this run',
      tone: 'destructive',
      ...(run.operation === undefined
        ? { onPress: (): CodingAgentTuiMessage => ({ type: 'recovery.act', action: 'stop' }) }
        : { disabled: true })
    })
  ];
  if (suspension.reason !== 'user_decision')
    actions.push(
      button({
        id: 'recovery-resume',
        label: suspension.reason === 'missing_implementation' ? 'Continue' : 'Check for a recorded result',
        ...(run.operation === undefined
          ? { onPress: (): CodingAgentTuiMessage => ({ type: 'recovery.act', action: 'resume' }) }
          : { disabled: true })
      })
    );
  const message =
    run.operation === 'stop' ? 'Stopping…' : run.operation === 'resume' ? 'Checking…' : (run.message ?? '');
  return dialog({
    id: 'recovery-dialog',
    title: presentation.title,
    modal: true,
    dismissal: { dismissOnEscape: true, dismissOnOutsidePress: false },
    onDismiss: () => ({ type: 'overlay.close' }),
    focusPolicy: { initialFocus: { kind: 'element', elementId: 'recovery-close' }, returnFocus: 'restore' },
    slots: {
      content: viewport(
        paragraph(
          [
            message,
            suspension.decisionRequest?.reason ?? suspension.cleanupDiagnostic?.message,
            presentation.explanation
          ]
            .filter(Boolean)
            .join('\n\n')
        ),
        {
          id: 'recovery-content',
          offset: { row: offsetRow },
          scrollbar: { axis: 'vertical', visible: 'auto' },
          onScroll: (event): CodingAgentTuiMessage => ({
            type: 'modal.scrolled',
            offsetRow: event.nextState.offsetRow
          })
        }
      ),
      actions: column(actions)
    },
    width: Math.max(5, Math.min(88, context.terminalSize.columns - 4)),
    height: Math.max(4, Math.min(16, context.terminalSize.rows - 4)),
    padding: 1
  });
}

function paragraph(content: string): Element<CodingAgentTuiMessage> {
  return richText({ segments: [{ kind: 'text', text: content }], wrap: { preserveWords: true } });
}

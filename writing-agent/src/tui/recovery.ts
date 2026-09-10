import { suspensionPresentation } from '@agents/tui';
import { button, text, richText, type Element } from '@ismail-elkorchi/terminal-ui/components';
import { column } from '@ismail-elkorchi/terminal-ui/layout';
import type { WritingTuiMessage, WritingTuiState } from './state.js';

export function recoveryView(state: WritingTuiState): Element<WritingTuiMessage> {
  const session = state.sessionView;
  const suspension = session?.session.suspension;
  const children: Element<WritingTuiMessage>[] = [
    text({
      content:
        suspension === undefined
          ? 'No suspended run in this session.'
          : `${suspensionPresentation(suspension.reason).title}\n${suspensionPresentation(suspension.reason).explanation}`
    })
  ];
  if (suspension !== undefined) {
    if (state.notice) children.push(richText({ segments: [{ kind: 'text', text: state.notice }], wrap: true }));
    if (suspension.actions.includes('resume') || suspension.actions.includes('reconcile'))
      children.push(
        button({
          id: 'writing-recovery-resume',
          label: suspension.actions.includes('reconcile')
            ? 'Check for a recorded result'
            : 'Continue',
          onPress: () => ({ type: 'recovery.resume' })
        })
      );
    const decision = suspension.decisionRequest;
    if (decision !== undefined) {
      children.push(text({ content: decision.reason }));
      for (const choice of decision.choices)
        children.push(
          button({
            id: `writing-decision:${choice}`,
            label: choice,
            onPress: () => ({ type: 'recovery.choice', choice })
          })
        );
    }
    children.push(
      button({
        id: 'writing-recovery-abort',
        label: 'Stop this run',
        onPress: () => ({ type: 'recovery.abort' })
      })
    );
  }
  for (const run of session?.runs ?? [])
    for (const batch of run.state.toolBatches)
      for (const call of batch.callStates) {
        if (call.stage !== 'approval') continue;
        const approval = call.approval;
        children.push(
          text({
            content: `${approval.reason}\n${approval.toolName}\n${JSON.stringify(approval.input, null, 2)}\nFingerprint ${approval.fingerprint}`
          })
        );
        for (const decision of ['deny', 'allow'] as const)
          children.push(
            button({
              id: `writing-approval:${approval.approvalId}:${decision}`,
              label: decision === 'deny' ? 'Deny' : 'Allow exact operation',
              onPress: () => ({
                type: 'recovery.approval',
                runId: run.state.runId,
                approvalId: approval.approvalId,
                fingerprint: approval.fingerprint,
                decision
              })
            })
          );
      }
  children.push(
    button({
      id: 'writing-recovery-refresh',
      label: 'Refresh',
      onPress: () => ({ type: 'recovery.open' })
    })
  );
  return column(children);
}

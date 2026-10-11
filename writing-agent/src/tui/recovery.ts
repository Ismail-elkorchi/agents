import { diagnosticMessage, suspensionPresentation, suspensionMessage } from '@agent-core/tui';
import { button, richText, text, type Element } from '@ismail-elkorchi/terminal-ui/components';
import { column } from '@ismail-elkorchi/terminal-ui/layout';
import type { WritingTuiMessage, WritingTuiState } from './state.js';
import type { WritingApplication } from '../application/service.js';
import type { TuiUpdateResult } from '@ismail-elkorchi/terminal-ui/tui';

type RecoveryMessage = Extract<WritingTuiMessage, { readonly type: `recovery.${string}` }>;

export function updateRecovery(
  state: WritingTuiState,
  message: RecoveryMessage,
  app: WritingApplication
): TuiUpdateResult<WritingTuiState, WritingTuiMessage> {
  const sessionId = app.state().sessionId;
  if (message.type === 'recovery.open') {
    if (sessionId === undefined) return { state: { ...state, notice: 'Open a session first.' } };
    const id = crypto.randomUUID();
    return {
      state: { ...state, overlay: { kind: 'recovery', id, sessionId, loading: true } },
      effects: [
        {
          id: 'writing-recovery-read',
          concurrency: 'replace',
          async run({ signal }) {
            if (app.state().sessionId !== sessionId)
              throw new Error('The selected session changed.');
            const session = await app.readSession();
            signal.throwIfAborted();
            return {
              kind: 'message',
              message: { type: 'recovery.loaded', requestId: id, session }
            };
          },
          onError: ({ diagnostic }) => ({
            kind: 'message',
            message: {
              type: 'recovery.failed',
              requestId: id,
              message: diagnosticMessage(diagnostic)
            }
          })
        }
      ]
    };
  }
  if (message.type === 'recovery.settled') {
    const operation = state.recoveryOperation;
    if (operation?.id !== message.operationId) return { state };
    const next = { ...state };
    delete next.recoveryOperation;
    if (message.error !== undefined)
      return {
        state: { ...next, notice: `Recovery for session ${operation.sessionId}: ${message.error}` }
      };
    return next.overlay.kind === 'recovery' &&
      next.overlay.sessionId === operation.sessionId &&
      sessionId === operation.sessionId
      ? updateRecovery(next, { type: 'recovery.open' }, app)
      : { state: next };
  }
  const overlay = state.overlay;
  if (overlay.kind !== 'recovery' || overlay.sessionId !== sessionId) return { state };
  if (message.type === 'recovery.loaded' || message.type === 'recovery.failed') {
    if (message.requestId !== overlay.id) return { state };
    if (message.type === 'recovery.failed')
      return {
        state: {
          ...state,
          overlay: { ...overlay, loading: false },
          notice: message.message
        }
      };
    if (message.session.session.sessionId !== sessionId) return { state };
    return {
      state: {
        ...state,
        sessionView: message.session,
        overlay:
          message.session.session.suspension === undefined
            ? { kind: 'none' }
            : { ...overlay, loading: false }
      }
    };
  }
  if (state.recoveryOperation !== undefined || overlay.loading) return { state };
  const session = state.sessionView;
  if (session?.session.sessionId !== sessionId) return { state };
  const suspension = session.session.suspension;
  if (message.type !== 'recovery.approval' && suspension === undefined) return { state };
  const id = crypto.randomUUID();
  return {
    state: { ...state, recoveryOperation: { id, sessionId } },
    effects: [
      {
        id: 'writing-recovery-command',
        concurrency: 'keep-first',
        async run() {
          if (app.state().sessionId !== sessionId) throw new Error('The selected session changed.');
          if (message.type === 'recovery.approval')
            await app.resolveApproval({
              runId: message.runId,
              approvalId: message.approvalId,
              fingerprint: message.fingerprint,
              decision: message.decision
            });
          else if (suspension !== undefined) {
            if (message.type === 'recovery.abort') await app.abort(suspension.runId);
            else await app.resume(suspension.runId);
          }
          return { kind: 'message', message: { type: 'recovery.settled', operationId: id } };
        },
        onError: ({ diagnostic }) => ({
          kind: 'message',
          message: {
            type: 'recovery.settled',
            operationId: id,
            error: diagnosticMessage(diagnostic)
          }
        })
      }
    ]
  };
}

export function recoveryView(state: WritingTuiState): Element<WritingTuiMessage> {
  const session =
    state.sessionView?.session.sessionId === state.application.sessionId
      ? state.sessionView
      : undefined;
  const pending =
    state.recoveryOperation !== undefined ||
    (state.overlay.kind === 'recovery' && state.overlay.loading);
  const suspension = session?.session.suspension;
  const presentation = suspension ? suspensionPresentation(suspension.reason) : undefined;
  const children: Element<WritingTuiMessage>[] = [
    text({
      content:
        state.overlay.kind === 'recovery' && state.overlay.loading
          ? 'Loading recorded run…'
          : state.recoveryOperation !== undefined
            ? 'Applying recovery decision…'
            : suspension === undefined
              ? 'No suspended run in this session.'
              : [presentation?.title, suspensionMessage(suspension), presentation?.explanation]
                  .filter(
                    (value, index, values) => Boolean(value) && values.indexOf(value) === index
                  )
                  .join('\n')
    })
  ];
  if (suspension !== undefined) {
    if (state.notice)
      children.push(richText({ segments: [{ kind: 'text', text: state.notice }], wrap: true }));
    if (suspension.actions.includes('resume') || suspension.actions.includes('reconcile'))
      children.push(
        button({
          id: 'writing-recovery-resume',
          disabled: pending,
          label: suspensionPresentation(suspension.reason).resumeLabel ?? 'Continue',
          onPress: () => ({ type: 'recovery.resume' })
        })
      );
    if (suspension.actions.includes('context'))
      children.push(
        button({
          id: 'writing-recovery-context',
          label: 'Inspect context',
          onPress: () => ({ type: 'context.open' })
        })
      );
    children.push(
      button({
        id: 'writing-recovery-abort',
        disabled: pending,
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
              disabled: pending,
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
      disabled: pending,
      label: 'Refresh',
      onPress: () => ({ type: 'recovery.open' })
    })
  );
  return column(children);
}

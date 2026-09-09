import type { SessionPendingSubmission } from '@agent-core/runtime';
import { diagnosticMessage } from '@agents/tui';
import type { TextAreaState, TextAreaTransition } from '@ismail-elkorchi/terminal-ui/behavior';
import {
  createSearchPickerIndex,
  createSearchPickerState,
  createTextAreaState,
  searchPickerReducer,
  searchPickerView,
  textAreaReducer
} from '@ismail-elkorchi/terminal-ui/behavior';
import type { Element } from '@ismail-elkorchi/terminal-ui/components';
import { button, dialog, searchPicker, text, textArea } from '@ismail-elkorchi/terminal-ui/components';
import { column, row } from '@ismail-elkorchi/terminal-ui/layout';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import type { TuiUpdateResult } from '@ismail-elkorchi/terminal-ui/tui';
import type { CodingApplication } from '../application/service.js';
import type { WorkspaceChange } from '../changes/run-change-report.js';
import { appendNotice } from './conversation.js';
import type { CodingAgentTuiMessage } from './messages.js';
import type { CodingAgentTuiPickerState, CodingAgentTuiState } from './state.js';

export type CodingNavigationOperations = Pick<
  CodingApplication,
  | 'listNotes'
  | 'readNote'
  | 'listSessions'
  | 'selectSession'
  | 'branchFrom'
  | 'readPendingSubmissions'
  | 'updateQueuedSubmission'
  | 'readChange'
>;
export type PanelKind = 'sessions' | 'branches' | 'queue' | 'changes' | 'source';
export type PanelItem = { readonly id: string; readonly label: string } & (
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'branch'; readonly entryId: string }
  | { readonly kind: 'queued'; readonly submission: SessionPendingSubmission }
  | { readonly kind: 'change'; readonly change: WorkspaceChange; readonly runId: string }
);
export type CodingPanel =
  | { readonly kind: 'panel_loading'; readonly id: string; readonly panel: PanelKind }
  | {
      readonly kind: 'panel';
      readonly panel: PanelKind;
      readonly items: readonly PanelItem[];
      readonly picker: CodingAgentTuiPickerState;
    }
  | {
      readonly kind: 'source';
      readonly title: string;
      readonly input: TextAreaState;
      readonly notice?: string;
    }
  | {
      readonly kind: 'queue_edit';
      readonly submission: SessionPendingSubmission;
      readonly input: TextAreaState;
      readonly saving: boolean;
      readonly error?: string;
    }
  | { readonly kind: 'branch_review'; readonly entryId: string };
type Update = TuiUpdateResult<CodingAgentTuiState, CodingAgentTuiMessage>;

const panelTitles: Record<PanelKind, string> = {
  sessions: 'Sessions',
  branches: 'Branch from history',
  queue: 'Accepted queued input',
  changes: 'Workspace changes',
  source: 'Original Markdown'
};
const index = (items: readonly PanelItem[]) =>
  createSearchPickerIndex(items, (item) => ({ id: item.id, label: item.label, value: item }));

export function openPanel(
  state: CodingAgentTuiState,
  panel: PanelKind,
  operations: CodingNavigationOperations | undefined
): Update {
  if (panel === 'source') {
    const latest = [...state.conversation.items].reverse().find((entry) => entry.kind === 'assistant');
    return latest === undefined
      ? { state: appendNotice(state, 'No assistant source is loaded.') }
      : sourcePanel(state, 'Original Markdown · select and copy', latest.text);
  }
  const id = `panel:${String(state.nextLocalId)}`;
  return {
    state: { ...state, nextLocalId: state.nextLocalId + 1, overlay: { kind: 'panel_loading', id, panel } },
    effects: [
      {
        id: 'navigation-panel',
        concurrency: 'replace',
        async run() {
          let items: readonly PanelItem[];
          if (panel === 'branches')
            items = state.debug.branchPoints.map((point) => ({
              kind: 'branch',
              id: point.entryId,
              entryId: point.entryId,
              label: `${point.timestamp} · ${point.kind.replaceAll('_', ' ')} · ${point.runId ?? point.entryId}`
            }));
          else if (panel === 'changes')
            items = state.debug.handoffs.flatMap((handoff) =>
              handoff.changeReport.changes.map((change) => ({
                kind: 'change' as const,
                id: `${handoff.terminal.runId}:${change.path}`,
                label: `${change.kind} · ${change.path} · ${change.attribution.replaceAll('_', ' ')}`,
                change,
                runId: handoff.terminal.runId
              }))
            );
          else {
            if (operations === undefined) throw new Error('Session operations are unavailable.');
            items =
              panel === 'sessions'
                ? (await operations.listSessions()).map((session) => ({
                    kind: 'session',
                    id: session.id,
                    sessionId: session.id,
                    label: `${session.updatedAt} · ${session.model ?? 'No model'} · ${session.id}`
                  }))
                : (await operations.readPendingSubmissions())
                    .filter((submission) => submission.state === 'queued')
                    .map((submission) => ({
                      kind: 'queued',
                      id: submission.submissionId,
                      submission,
                      label: submission.input.task
                    }));
          }
          return { kind: 'message', message: { type: 'panel.loaded', requestId: id, panel, items } };
        },
        onError: ({ diagnostic }) => ({
          kind: 'message',
          message: { type: 'panel.failed', requestId: id, message: diagnosticMessage(diagnostic) }
        })
      }
    ]
  };
}

export function updatePanel(
  state: CodingAgentTuiState,
  message: Exclude<Extract<CodingAgentTuiMessage, { type: `panel.${string}` }>, { type: 'panel.open' }>,
  operations: CodingNavigationOperations | undefined
): Update {
  switch (message.type) {
    case 'panel.loaded':
      if (state.overlay.kind !== 'panel_loading' || state.overlay.id !== message.requestId) return { state };
      return {
        state: {
          ...state,
          overlay: {
            kind: 'panel',
            panel: message.panel,
            items: message.items,
            picker: createSearchPickerState({ query: { text: '', mode: 'fuzzy' } }, index(message.items))
          }
        },
        focus: { kind: 'element', elementId: 'navigation-picker' }
      };
    case 'panel.failed':
      return state.overlay.kind !== 'panel_loading' || state.overlay.id !== message.requestId
        ? { state }
        : { state: appendNotice({ ...state, overlay: { kind: 'none' } }, message.message, 'error') };
    case 'panel.transition':
      return state.overlay.kind !== 'panel'
        ? { state }
        : {
            state: {
              ...state,
              overlay: {
                ...state.overlay,
                picker: searchPickerReducer(state.overlay.picker, message.transition, {
                  searchPickerIndex: index(state.overlay.items)
                })
              }
            }
          };
    case 'panel.accept': {
      if (state.overlay.kind !== 'panel') return { state };
      const item = state.overlay.items.find((item) => item.id === message.id);
      if (item === undefined) return { state };
      return acceptPanelItem(state, item, operations);
    }
    case 'panel.source-loaded':
      return sourcePanel(state, message.title, message.content);
    case 'panel.text': {
      if (state.overlay.kind !== 'source' && state.overlay.kind !== 'queue_edit') return { state };
      return {
        state: {
          ...state,
          overlay: { ...state.overlay, input: textAreaReducer(state.overlay.input, message.transition).state }
        }
      };
    }
    case 'panel.queue-save':
    case 'panel.queue-cancel': {
      if (state.overlay.kind !== 'queue_edit' || state.overlay.saving) return { state };
      const { submission, input } = state.overlay;
      const task = textDocumentText(input.document);
      if (message.type === 'panel.queue-save' && !task.trim())
        return { state: appendNotice(state, 'Queued input cannot be empty.', 'error') };
      return operation(
        { ...state, overlay: { ...state.overlay, saving: true } },
        operations,
        (service) =>
          service.updateQueuedSubmission(
            submission.submissionId,
            message.type === 'panel.queue-cancel'
              ? { kind: 'cancel', expectedInput: submission.input }
              : { kind: 'replace', expectedInput: submission.input, input: { ...submission.input, task } }
          ),
        message.type === 'panel.queue-cancel' ? 'Queued input cancelled.' : 'Queued input updated.'
      );
    }
    case 'panel.branch':
      return state.overlay.kind !== 'branch_review'
        ? { state }
        : operation(state, operations, (service) => service.branchFrom(message.entryId), 'Branch selected.');
    case 'panel.done':
      return {
        state: appendNotice({ ...state, overlay: { kind: 'none' } }, message.message),
        focus: { kind: 'element', elementId: 'composer' }
      };
    case 'panel.operation-failed':
      return {
        state: appendNotice(
          {
            ...state,
            overlay:
              state.overlay.kind === 'queue_edit'
                ? { ...state.overlay, saving: false, error: message.message }
                : state.overlay
          },
          message.message,
          'error'
        )
      };
  }
}

function sourcePanel(state: CodingAgentTuiState, title: string, value: string): Update {
  return {
    state: {
      ...state,
      overlay: {
        kind: 'source',
        title,
        input: createTextAreaState({ value, caret: { position: { offset: 0, affinity: 'downstream' } } })
      }
    },
    focus: { kind: 'element', elementId: 'source-text' }
  };
}

function operation(
  state: CodingAgentTuiState,
  service: CodingNavigationOperations | undefined,
  act: (service: CodingNavigationOperations) => Promise<void>,
  message: string
): Update {
  return {
    state,
    effects: [
      {
        id: 'session-operation',
        concurrency: 'keep-first',
        async run() {
          if (service === undefined) throw new Error('Session operations are unavailable.');
          await act(service);
          return { kind: 'message', message: { type: 'panel.done', message } };
        },
        onError: ({ diagnostic }) => ({
          kind: 'message',
          message: { type: 'panel.operation-failed', message: diagnosticMessage(diagnostic) }
        })
      }
    ]
  };
}

export function panelView(panel: CodingPanel, width: number, height: number): Element<CodingAgentTuiMessage> {
  const content = (): Element<CodingAgentTuiMessage> => {
    switch (panel.kind) {
      case 'panel_loading':
        return text({ id: 'panel-loading-text', content: 'Loading…' });
      case 'panel':
        return searchPicker({
          id: 'navigation-picker',
          title: panelTitles[panel.panel],
          view: searchPickerView(panel.picker),
          searchPickerIndex: index(panel.items),
          maxVisible: Math.max(1, height - 5),
          emptyText: 'No entries available',
          onTransition: (transition) => ({ type: 'panel.transition', transition }),
          onAccept: (event) => ({ type: 'panel.accept', id: event.id })
        });
      case 'source':
        return column(
          [
            textArea<CodingAgentTuiMessage>({
              id: 'source-text',
              meta: { accessibleName: panel.title },
              state: panel.input,
              readOnly: true,
              wrap: true,
              scrollbar: { axis: 'vertical', visible: 'auto' },
              onTransition: (transition: TextAreaTransition): CodingAgentTuiMessage => ({
                type: 'panel.text',
                transition
              })
            }),
            text({ content: panel.notice ?? 'Ctrl+C copies selected source' })
          ],
          {
            sizes: [
              { kind: 'fill', weight: 1 },
              { kind: 'fixed', cells: 2 }
            ]
          }
        );
      case 'queue_edit':
        return column(
          [
            text({ content: panel.error ?? `Queued run ${panel.submission.runId}` }),
            textArea<CodingAgentTuiMessage>({
              id: 'queue-editor',
              meta: { accessibleName: 'Queued input' },
              state: panel.input,
              wrap: true,
              onTransition: (transition: TextAreaTransition): CodingAgentTuiMessage => ({
                type: 'panel.text',
                transition
              })
            }),
            row([
              button({ id: 'queue-save', label: 'Save', onPress: () => ({ type: 'panel.queue-save' }) }),
              button({
                id: 'queue-cancel',
                label: 'Cancel queued input',
                onPress: () => ({ type: 'panel.queue-cancel' })
              })
            ])
          ],
          {
            sizes: [
              { kind: 'fixed', cells: 2 },
              { kind: 'fill', weight: 1 },
              { kind: 'fixed', cells: 1 }
            ]
          }
        );
      case 'branch_review':
        return column([
          text({
            content: `Continue from ${panel.entryId}\nRequires an idle session. Existing history remains stored.`
          }),
          button({
            id: 'branch-continue',
            label: 'Create branch',
            onPress: () => ({ type: 'panel.branch', entryId: panel.entryId })
          })
        ]);
    }
  };
  return dialog({
    id: 'navigation-dialog',
    title:
      panel.kind === 'source'
        ? panel.title
        : panel.kind === 'queue_edit'
          ? 'Queued input · Tab actions · Esc close'
          : panel.kind === 'branch_review'
            ? 'Branch continuation'
            : panelTitles[panel.panel],
    modal: true,
    width,
    height,
    focusPolicy: {
      initialFocus: {
        kind: 'element',
        elementId:
          panel.kind === 'source'
            ? 'source-text'
            : panel.kind === 'queue_edit'
              ? 'queue-editor'
              : panel.kind === 'branch_review'
                ? 'branch-continue'
                : panel.kind === 'panel_loading'
                  ? 'panel-loading-text'
                  : 'navigation-picker'
      },
      returnFocus: 'restore'
    },
    dismissal: { dismissOnEscape: true, dismissOnOutsidePress: false },
    onDismiss: () => ({ type: 'overlay.close' }),
    slots: { content: content() }
  });
}

function describeChange(item: Extract<PanelItem, { kind: 'change' }>): string {
  const change = item.change;
  return `${change.path}\n${change.kind} · ${change.content}\nRun: ${item.runId}\nAttribution: ${change.attribution}\nBefore: ${change.beforeSha256 ?? change.initial}\nAfter: ${change.afterSha256 ?? 'absent'}\nBytes: ${String(change.beforeBytes ?? 0)} → ${String(change.afterBytes ?? 0)}\n${change.conflicts.join('\n')}`;
}

function acceptPanelItem(
  state: CodingAgentTuiState,
  item: PanelItem,
  operations: CodingNavigationOperations | undefined
): Update {
  switch (item.kind) {
    case 'session':
      return operation(
        state,
        operations,
        (service) => service.selectSession(item.sessionId),
        'Session selected.'
      );
    case 'branch':
      return {
        state: { ...state, overlay: { kind: 'branch_review', entryId: item.entryId } },
        focus: { kind: 'element', elementId: 'branch-continue' }
      };
    case 'queued':
      return {
        state: {
          ...state,
          overlay: {
            kind: 'queue_edit',
            submission: item.submission,
            input: createTextAreaState({ value: item.submission.input.task }),
            saving: false
          }
        },
        focus: { kind: 'element', elementId: 'queue-editor' }
      };
    case 'change':
      return {
        state,
        effects: [
          {
            id: 'change-source',
            concurrency: 'replace',
            async run() {
              if (operations === undefined) throw new Error('Change inspection is unavailable.');
              const inspection = await operations.readChange(item.runId, item.change.path);
              const patches = inspection.patches
                .map(
                  ({ receipt, patch }) =>
                    `Working-copy patch · ${receipt.applicationStatus} · ${receipt.patchSha256}\n${patch}`
                )
                .join('\n\n');
              return {
                kind: 'message',
                message: {
                  type: 'panel.source-loaded',
                  title: item.change.path,
                  content: `${describeChange(item)}\nAcceptance: ${inspection.outcome.acceptance}\nPublication: ${inspection.outcome.publication}\n${inspection.outcome.reason ?? ''}\n\n${patches || 'No structured patch is recorded for this change. The report identifies the observed hashes; it does not retain a text comparison for external changes.'}`
                }
              };
            },
            onError: ({ diagnostic }) => ({
              kind: 'message',
              message: { type: 'interactive.notice', tone: 'error', message: diagnosticMessage(diagnostic) }
            })
          }
        ]
      };
  }
}

import { diagnosticMessage, panel as dismissiblePanel } from '@agent-core/tui';
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
import { button, searchPicker, text, textArea } from '@ismail-elkorchi/terminal-ui/components';
import { column } from '@ismail-elkorchi/terminal-ui/layout';
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
  | 'newSession'
  | 'selectSession'
  | 'branchFrom'
  | 'readPendingSubmissions'
  | 'updateQueuedSubmission'
  | 'readChange'
>;
export type PanelKind = 'sessions' | 'branches' | 'changes';
export type PanelItem = { readonly id: string; readonly label: string } & (
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'branch'; readonly entryId: string }
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
  | { readonly kind: 'branch_review'; readonly entryId: string };
type Update = TuiUpdateResult<CodingAgentTuiState, CodingAgentTuiMessage>;

const panelTitles: Record<PanelKind, string> = {
  sessions: 'Sessions',
  branches: 'Branch from history',
  changes: 'Workspace changes'
};
const index = (items: readonly PanelItem[]) =>
  createSearchPickerIndex(items, (item) => ({ id: item.id, label: item.label, value: item }));

export function openPanel(
  state: CodingAgentTuiState,
  panel: PanelKind,
  operations: CodingNavigationOperations | undefined,
  names?: import('@agent-core/tui').SessionNames
): Update {
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
            items = state.debug.changes.flatMap((report) =>
              report.changes.map((change) => ({
                kind: 'change' as const,
                id: `${report.runId}:${change.path}`,
                label: `${change.kind} · ${change.path} · ${change.state}`,
                change,
                runId: report.runId
              }))
            );
          else {
            if (operations === undefined) throw new Error('Session operations are unavailable.');
            items = await Promise.all(
              (await operations.listSessions()).map(
                async (session): Promise<PanelItem> => ({
                  kind: 'session',
                  id: session.id,
                  sessionId: session.id,
                  label: `${session.id === state.debug.sessionId ? '✓ ' : ''}${(await names?.read(session.id)) ?? session.preview ?? session.id} · ${session.updatedAt}`
                })
              )
            );
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
      if (state.overlay.kind !== 'panel_loading' || state.overlay.id !== message.requestId)
        return { state };
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
      if (state.overlay.kind !== 'source') return { state };
      return {
        state: {
          ...state,
          overlay: {
            ...state.overlay,
            input: textAreaReducer(state.overlay.input, message.transition).state
          }
        }
      };
    }
    case 'panel.branch':
      return state.overlay.kind !== 'branch_review'
        ? { state }
        : operation(
            state,
            operations,
            (service) => service.branchFrom(message.entryId),
            'Branch selected.'
          );
    case 'panel.done':
      return {
        state: appendNotice({ ...state, overlay: { kind: 'none' } }, message.message),
        focus: { kind: 'element', elementId: 'composer' }
      };
    case 'panel.operation-failed':
      return { state: appendNotice(state, message.message, 'error') };
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
    }
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

export function panelView(
  panel: CodingPanel,
  width: number,
  height: number
): Element<CodingAgentTuiMessage> {
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
  return dismissiblePanel({
    id: 'navigation-dialog',
    title:
      panel.kind === 'source'
        ? panel.title
        : panel.kind === 'branch_review'
          ? 'Branch conversation'
          : panelTitles[panel.panel],
    width,
    height,
    ...(panel.kind === 'panel_loading'
      ? {}
      : {
          focusId:
            panel.kind === 'source'
              ? 'source-text'
              : panel.kind === 'branch_review'
                ? 'branch-continue'
                : 'navigation-picker'
        }),
    onClose: () => ({ type: 'overlay.close' }),
    slots: { content: content() }
  });
}

function describeChange(item: Extract<PanelItem, { kind: 'change' }>): string {
  const change = item.change;
  return `${change.path}${change.destinationPath ? ` → ${change.destinationPath}` : ''}\nSource: ${change.absolutePath}${change.destinationAbsolutePath ? ` → ${change.destinationAbsolutePath}` : ''}\n${change.kind} · ${change.state}\nRun: ${item.runId}\nBefore: ${change.beforeSha256 ?? 'absent'}\nAfter: ${change.afterSha256 ?? 'absent'}\nBytes: ${String(change.beforeBytes)} → ${String(change.afterBytes)}`;
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
                    `Workspace patch · ${receipt.applicationStatus} · ${receipt.patchSha256}\n${patch}`
                )
                .join('\n\n');
              return {
                kind: 'message',
                message: {
                  type: 'panel.source-loaded',
                  title: item.change.path,
                  content: `${describeChange(item)}\n\n${patches || 'No structured patch is recorded for this change.'}`
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

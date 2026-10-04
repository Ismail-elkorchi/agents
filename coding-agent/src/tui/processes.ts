import { renderCommandOutput, type CommandExecutionResult } from '@agent-core/tools';
import { diagnosticMessage, panel } from '@agent-core/tui';
import {
  createSearchPickerIndex,
  createSearchPickerState,
  createTextAreaState,
  querySearchPickerIndex,
  searchPickerReducer,
  searchPickerQueryPosition,
  searchPickerView,
  textAreaReducer,
  type SearchPickerControlTransition,
  type SearchPickerIndex,
  type SearchPickerQueryResult,
  type TextAreaState,
  type TextAreaTransition,
  type UnscrolledSearchPickerState
} from '@ismail-elkorchi/terminal-ui/behavior';
import {
  button,
  searchPicker,
  text,
  textArea,
  type Element
} from '@ismail-elkorchi/terminal-ui/components';
import { column, row } from '@ismail-elkorchi/terminal-ui/layout';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import type { TuiUpdateResult } from '@ismail-elkorchi/terminal-ui/tui';
import type {
  CodingProcessAction,
  CodingProcessOperations,
  CodingProcessTarget
} from '../execution/process-controls.js';

export interface ProcessPanel {
  readonly id: string;
  readonly processes: readonly CodingProcessTarget[];
  readonly picker: UnscrolledSearchPickerState;
  readonly pickerIndex: SearchPickerIndex;
  readonly pickerQueryResult: SearchPickerQueryResult;
  readonly pending: boolean;
  readonly selected?: {
    readonly target: CodingProcessTarget;
    readonly result?: CommandExecutionResult;
    readonly output: TextAreaState;
    readonly input: TextAreaState;
  };
  readonly error?: string;
}

export type ProcessMessage =
  | { readonly type: 'processes.open' | 'processes.refresh' | 'processes.back' }
  | { readonly type: 'processes.reconcile'; readonly acknowledge: boolean }
  | { readonly type: 'processes.transition'; readonly transition: SearchPickerControlTransition }
  | { readonly type: 'processes.select'; readonly processId: string }
  | {
      readonly type: 'processes.edit';
      readonly field: 'input' | 'output';
      readonly transition: TextAreaTransition;
    }
  | {
      readonly type: 'processes.action';
      readonly action: CodingProcessAction['kind'];
      readonly more?: boolean;
    }
  | {
      readonly type: 'processes.listed';
      readonly id: string;
      readonly processes: readonly CodingProcessTarget[];
    }
  | {
      readonly type: 'processes.observed';
      readonly id: string;
      readonly result: CommandExecutionResult;
      readonly sentInput?: TextAreaState;
    }
  | {
      readonly type: 'processes.failed';
      readonly operation: 'list' | CodingProcessAction['kind'];
      readonly id: string;
      readonly message: string;
    };

const processIndex = (processes: readonly CodingProcessTarget[]) =>
  createSearchPickerIndex(processes, (process) => ({
    id: process.processId,
    label: `${process.status} · ${process.command ?? process.processId}`,
    value: process.processId
  }));

export function createProcessPanel(): ProcessPanel {
  const pickerIndex = processIndex([]);
  const pickerQueryResult = querySearchPickerIndex(pickerIndex);
  return {
    id: crypto.randomUUID(),
    processes: [],
    pickerIndex,
    pickerQueryResult,
    picker: createSearchPickerState({ queryResult: pickerQueryResult }, pickerIndex),
    pending: false
  };
}

export function updateProcesses(
  state: ProcessPanel,
  message: ProcessMessage,
  operations: CodingProcessOperations
): TuiUpdateResult<ProcessPanel, ProcessMessage> {
  switch (message.type) {
    case 'processes.reconcile': {
      if (state.pending || (message.acknowledge && !state.selected)) return { state };
      return {
        state: { ...state, pending: true },
        effects: [
          {
            id: 'process-reconciliation',
            concurrency: 'keep-first',
            async run() {
              return {
                kind: 'message',
                message: {
                  type: 'processes.listed',
                  id: state.id,
                  processes: await operations.reconcileProcesses(
                    message.acknowledge ? state.selected?.target : undefined
                  )
                }
              };
            },
            onError: ({ diagnostic }) => ({
              kind: 'message',
              message: {
                type: 'processes.failed',
                operation: 'list',
                id: state.id,
                message: diagnosticMessage(diagnostic)
              }
            })
          }
        ]
      };
    }
    case 'processes.open':
    case 'processes.refresh': {
      if (state.pending) return { state };
      const next = { ...state };
      delete next.error;
      return {
        state: { ...next, pending: true },
        effects: [
          {
            id: 'process-list',
            concurrency: 'replace',
            async run() {
              return {
                kind: 'message',
                message: {
                  type: 'processes.listed',
                  id: state.id,
                  processes: await operations.listProcesses()
                }
              };
            },
            onError: ({ diagnostic }) => ({
              kind: 'message',
              message: {
                type: 'processes.failed',
                operation: 'list',
                id: state.id,
                message: diagnosticMessage(diagnostic)
              }
            })
          }
        ]
      };
    }
    case 'processes.listed': {
      if (message.id !== state.id) return { state };
      const pickerIndex = message.processes === state.processes ? state.pickerIndex : processIndex(message.processes);
      const pickerQueryResult = querySearchPickerIndex(pickerIndex, {
        text: state.picker.editor.input.text, mode: state.picker.mode, caseSensitive: state.picker.caseSensitive
      });
      const position = state.picker.editor.activeId === undefined
        ? undefined
        : searchPickerQueryPosition(pickerQueryResult, state.picker.editor.activeId);
      const active = pickerQueryResult.entryAt(position ?? 0);
      const picker = searchPickerReducer(state.picker, { kind: 'setActive', ...(active === undefined ? {} : { id: active.id }) },
        { searchPickerIndex: pickerIndex, queryResult: pickerQueryResult });
      return { state: {
        ...state,
        pending: false,
        processes: message.processes,
        pickerIndex,
        pickerQueryResult,
        picker,
        ...(state.selected ? { selected: {
          ...state.selected,
          target: message.processes.find((item) => item.processId === state.selected?.target.processId) ?? state.selected.target
        } } : {})
      } };
    }
    case 'processes.failed':
      return message.id !== state.id
        ? { state }
        : { state: { ...state, pending: false, error: message.message } };
    case 'processes.transition': {
      const next = searchPickerReducer(state.picker, message.transition, {
        searchPickerIndex: state.pickerIndex, queryResult: state.pickerQueryResult
      });
      const pickerQueryResult = querySearchPickerIndex(state.pickerIndex, {
        text: next.editor.input.text, mode: next.mode, caseSensitive: next.caseSensitive
      });
      const picker = pickerQueryResult === state.pickerQueryResult ? next
        : searchPickerReducer(next, { kind: 'firstActive' }, { searchPickerIndex: state.pickerIndex, queryResult: pickerQueryResult });
      return { state: { ...state, picker, pickerQueryResult } };
    }
    case 'processes.select': {
      const target = state.processes.find((process) => process.processId === message.processId);
      if (target?.status === 'unknown' || target?.status === 'acknowledged-unknown')
        return {
          state: {
            ...state,
            selected: {
              target,
              input: createTextAreaState({ value: '' }),
              output: createTextAreaState({
                value:
                  target.diagnostic ??
                  'The command outcome is unknown. Acknowledgement accepts uncertainty and does not replay the command.'
              })
            }
          }
        };
      return target === undefined || state.pending
        ? { state }
        : updateProcesses(
            {
              ...state,
              selected: {
                target,
                input: createTextAreaState({ value: '' }),
                output: createTextAreaState({ value: '' })
              }
            },
            { type: 'processes.action', action: 'inspect' },
            operations
          );
    }
    case 'processes.edit':
      return state.selected === undefined
        ? { state }
        : {
            state: {
              ...state,
              selected: {
                ...state.selected,
                [message.field]: textAreaReducer(state.selected[message.field], message.transition)
                  .state
              }
            }
          };
    case 'processes.back': {
      if (state.pending) return { state };
      const next = { ...state };
      delete next.selected;
      return { state: next };
    }
    case 'processes.observed': {
      if (message.id !== state.id || state.selected?.target.processId !== message.result.processId)
        return { state };
      return {
        state: {
          ...state,
          pending: false,
          selected: {
            ...state.selected,
            target: { ...state.selected.target, status: message.result.status, owner: message.result.owner },
            result: message.result,
            output: createTextAreaState({ value: renderCommandOutput(message.result.combined) }),
            input:
              message.sentInput === state.selected.input
                ? createTextAreaState({ value: '' })
                : state.selected.input
          }
        }
      };
    }
    case 'processes.action': {
      const selected = state.selected;
      if (selected === undefined || state.pending || selected.target.status === 'unknown' || selected.target.status === 'acknowledged-unknown') return { state };
      const action: CodingProcessAction =
        message.action === 'input'
          ? { kind: 'input', text: textDocumentText(selected.input.document) }
          : message.action === 'inspect'
            ? { kind: 'inspect', afterCursor: message.more ? (selected.result?.cursorEnd ?? 0) : 0 }
            : { kind: message.action };
      if (action.kind === 'input' && action.text.length === 0) return { state };
      const next = { ...state, pending: true };
      delete next.error;
      return {
        state: next,
        effects: [
          {
            id: 'process-control',
            concurrency: 'keep-first',
            async run() {
              return {
                kind: 'message',
                message: {
                  type: 'processes.observed',
                  id: state.id,
                  result: await operations.controlProcess(selected.target, action),
                  ...(action.kind === 'input' ? { sentInput: selected.input } : {})
                }
              };
            },
            onError: ({ diagnostic }) => ({
              kind: 'message',
              message: {
                type: 'processes.failed',
                operation: action.kind,
                id: state.id,
                message: diagnosticMessage(diagnostic)
              }
            })
          }
        ]
      };
    }
  }
}

export function processesView(
  state: ProcessPanel,
  width: number,
  height: number
): Element<ProcessMessage | { readonly type: 'overlay.close' }> {
  type Message = ProcessMessage | { readonly type: 'overlay.close' };
  const selected = state.selected;
  const control = (id: string, label: string, message: ProcessMessage, disabled = false) =>
    button<Message>({
      id,
      label,
      disabled: state.pending || disabled,
      onPress: () => message
    });
  const body =
    selected === undefined
      ? searchPicker<string, Message, Message>({
          id: 'process-picker',
          title: 'Processes from open command authority',
          view: searchPickerView(state.picker),
          searchPickerIndex: state.pickerIndex,
          queryResult: state.pickerQueryResult,
          maxVisible: Math.max(1, height - 7),
          onTransition: (transition): Message => ({ type: 'processes.transition', transition }),
          onAccept: (event): Message => ({ type: 'processes.select', processId: event.id })
        })
      : column(
          [
            text({
              content: `${selected.target.command ?? selected.target.processId}\n${selected.target.owner ? `Run ${selected.target.owner.runId}` : 'Authority-wide recovery'} · ${selected.target.status}`
            }),
            textArea<Message>({
              id: 'process-output',
              meta: { accessibleName: 'Process output; select to copy' },
              state: selected.output,
              readOnly: true,
              wrap: false,
              scrollbar: { axis: 'both', visible: 'auto' },
              onTransition: (transition: TextAreaTransition): Message => ({
                type: 'processes.edit',
                field: 'output',
                transition
              })
            }),
            text({
              content:
                selected.result === undefined
                  ? (selected.target.diagnostic ?? 'No command output is available.')
                  : `Output bytes ${String(selected.result.cursorStart)}–${String(selected.result.cursorEnd)} · ${String(selected.result.combined.omittedBytes)} bytes omitted${selected.result.cursorExpired ? ' · earlier output expired' : ''}${selected.result.diagnostic === undefined ? '' : ` · ${selected.result.diagnostic}`}`
            }),
            row([
              control('process-inspect', 'Refresh', {
                type: 'processes.action',
                action: 'inspect'
              }, selected.target.status === 'unknown' || selected.target.status === 'acknowledged-unknown'),
              control('process-more', 'Next output', {
                type: 'processes.action',
                action: 'inspect',
                more: true
              }, selected.target.status === 'unknown' || selected.target.status === 'acknowledged-unknown')
            ]),
            ...(selected.target.status !== 'running'
              ? []
              : [
                  textArea<Message>({
                    id: 'process-input',
                    meta: { accessibleName: 'Exact process input, including newlines' },
                    state: selected.input,
                    placeholder: 'Input; include a newline when the process requires it',
                    onTransition: (transition: TextAreaTransition): Message => ({
                      type: 'processes.edit',
                      field: 'input',
                      transition
                    })
                  }),
                  column([
                    control('process-send', 'Send input', {
                      type: 'processes.action',
                      action: 'input'
                    }),
                    control('process-close-input', 'Close stdin', {
                      type: 'processes.action',
                      action: 'close-input'
                    }),
                    control('process-stop', 'Terminate process', {
                      type: 'processes.action',
                      action: 'terminate'
                    })
                  ])
                ])
          ],
          {
            sizes: [
              { kind: 'content' },
              { kind: 'fill' },
              { kind: 'content' },
              { kind: 'content' },
              ...(selected.target.status !== 'running'
                ? []
                : [{ kind: 'fixed' as const, cells: 3 }, { kind: 'content' as const }])
            ]
          }
        );
  return panel<Message>({
    id: 'process-panel',
    title: 'Processes',
    width,
    height,
    onClose: () => ({ type: 'overlay.close' }),
    slots: {
      content: column(
        [
          text({
            content:
              state.error ??
              (state.pending
                ? 'Waiting for process authority…'
                : state.processes.length === 0
                  ? 'No open command processes. Earlier output remains in the conversation.'
                  : 'Inspecting does not send input or stop a process.')
          }),
          body
        ],
        { sizes: [{ kind: 'content' }, { kind: 'fill' }] }
      ),
      actions:
        selected === undefined
          ? control('process-list-refresh', 'Refresh', { type: 'processes.refresh' })
          : row([
              control('process-back', 'Back', { type: 'processes.back' }),
              control('process-reconcile', 'Retry observation', {
                type: 'processes.reconcile',
                acknowledge: false
              }),
              ...(selected.target.status === 'unknown'
                ? [
                    control('process-acknowledge', 'Accept unknown outcome', {
                      type: 'processes.reconcile',
                      acknowledge: true
                    })
                  ]
                : [])
            ])
    }
  });
}

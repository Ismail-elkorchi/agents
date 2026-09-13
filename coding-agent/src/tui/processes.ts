import type { CommandExecutionResult } from '@agent-core/tools';
import { diagnosticMessage, panel } from '@agent-core/tui';
import {
  createSearchPickerIndex,
  createSearchPickerState,
  createTextAreaState,
  searchPickerReducer,
  searchPickerView,
  textAreaReducer,
  type SearchPickerControlTransition,
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
    label: `${process.status} · ${process.processId}`,
    value: process.processId
  }));

export function createProcessPanel(): ProcessPanel {
  return {
    id: crypto.randomUUID(),
    processes: [],
    picker: createSearchPickerState({}, processIndex([])),
    pending: false
  };
}

export function updateProcesses(
  state: ProcessPanel,
  message: ProcessMessage,
  operations: CodingProcessOperations
): TuiUpdateResult<ProcessPanel, ProcessMessage> {
  switch (message.type) {
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
    case 'processes.listed':
      return message.id !== state.id
        ? { state }
        : { state: { ...state, pending: false, processes: message.processes } };
    case 'processes.failed':
      return message.id !== state.id
        ? { state }
        : { state: { ...state, pending: false, error: message.message } };
    case 'processes.transition':
      return {
        state: {
          ...state,
          picker: searchPickerReducer(state.picker, message.transition, {
            searchPickerIndex: processIndex(state.processes)
          })
        }
      };
    case 'processes.select': {
      const target = state.processes.find((process) => process.processId === message.processId);
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
                [message.field]: textAreaReducer(state.selected[message.field], message.transition).state
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
            target: { ...state.selected.target, status: message.result.status },
            result: message.result,
            output: createTextAreaState({ value: message.result.combined.text }),
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
      if (selected === undefined || state.pending) return { state };
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
      ...(state.pending || disabled ? { disabled: true } : { onPress: () => message })
    });
  const body =
    selected === undefined
      ? searchPicker<string, Message, Message>({
          id: 'process-picker',
          title: 'Processes from open command authority',
          view: searchPickerView(state.picker),
          searchPickerIndex: processIndex(state.processes),
          maxVisible: Math.max(1, height - 7),
          onTransition: (transition): Message => ({ type: 'processes.transition', transition }),
          onAccept: (event): Message => ({ type: 'processes.select', processId: event.id })
        })
      : column(
          [
            text({
              content: `${selected.target.processId}\nRun ${selected.target.owner.runId} · ${selected.target.status}`
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
                  ? 'Inspecting output…'
                  : `Output bytes ${String(selected.result.cursorStart)}–${String(selected.result.cursorEnd)} · ${String(selected.result.combined.omittedBytes)} bytes omitted${selected.result.cursorExpired ? ' · earlier output expired' : ''}${selected.result.diagnostic === undefined ? '' : ` · ${selected.result.diagnostic}`}`
            }),
            row([
              control('process-inspect', 'Refresh', { type: 'processes.action', action: 'inspect' }),
              control('process-more', 'Next output', {
                type: 'processes.action',
                action: 'inspect',
                more: true
              })
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
                    control('process-send', 'Send input', { type: 'processes.action', action: 'input' }),
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
          : control('process-back', 'Back', { type: 'processes.back' })
    }
  });
}

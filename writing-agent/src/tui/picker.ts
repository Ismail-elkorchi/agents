import {
  createSearchPickerIndex,
  createSearchPickerState,
  prepareSearchPickerQuery,
  querySearchPickerIndex,
  searchPickerReducer,
  type SearchPickerControlTransition,
  type SearchPickerIndex,
  type SearchPickerQueryResult,
  type UnscrolledSearchPickerState
} from '@ismail-elkorchi/terminal-ui/behavior';
import {
  createTuiPreparedQuery,
  type TuiChildResult,
  type TuiPreparedQueryMessage,
  type TuiPreparedQueryState
} from '@ismail-elkorchi/terminal-ui/tui';

export interface WritingPicker {
  readonly kind: 'picker';
  readonly id: string;
  readonly subject: 'resources' | 'outline' | 'sessions' | 'commands';
  readonly entries: readonly { readonly id: string; readonly label: string }[];
  readonly picker: UnscrolledSearchPickerState;
  readonly searchPickerIndex: SearchPickerIndex;
  readonly query: TuiPreparedQueryState<SearchPickerQueryResult>;
}
export interface WritingPickerQueryMessage {
  readonly type: 'picker.query';
  readonly id: string;
  readonly message: TuiPreparedQueryMessage<SearchPickerQueryResult>;
}
type Update = TuiChildResult<WritingPicker, WritingPickerQueryMessage>;
const queryInput = (picker: UnscrolledSearchPickerState) => ({
  text: picker.editor.input.text,
  mode: picker.mode,
  caseSensitive: picker.caseSensitive
});
function prepared(id: string) {
  return createTuiPreparedQuery({
    id: 'writing-picker-query',
    prepare: (input: WritingPicker, context) =>
      prepareSearchPickerQuery(input.searchPickerIndex, queryInput(input.picker), {
        signal: context.signal,
        yield: async () => {
          await context.clock.sleep(0, context.signal);
        }
      }),
    toMessage: (message): WritingPickerQueryMessage => ({ type: 'picker.query', id, message })
  });
}
function request(state: WritingPicker): Update {
  if (state.subject === 'commands') {
    const result = querySearchPickerIndex(state.searchPickerIndex, queryInput(state.picker));
    return { state: reconcile({ ...state, query: { ...state.query, result } }) };
  }
  const update = prepared(state.id).request(state.query, state);
  return { ...update, state: { ...state, query: update.state } };
}
function reconcile(state: WritingPicker): WritingPicker {
  const text = state.picker.editor.input.text;
  const name = text.startsWith('/') ? text : `/${text}`;
  const activeId =
    state.subject === 'commands' && state.entries.some((entry) => entry.id === name)
      ? name
      : state.picker.editor.activeId;
  return {
    ...state,
    picker: searchPickerReducer(
      state.picker,
      activeId === undefined ? { kind: 'firstActive' } : { kind: 'setActive', id: activeId },
      {
        searchPickerIndex: state.searchPickerIndex,
        queryResult: state.query.result
      }
    )
  };
}
export function createWritingPicker(
  subject: WritingPicker['subject'],
  entries: WritingPicker['entries']
): Update {
  const searchPickerIndex = createSearchPickerIndex(
    entries.map((entry) => ({ ...entry, value: entry.id }))
  );
  const id = crypto.randomUUID();
  return request({
    kind: 'picker',
    id,
    subject,
    entries,
    searchPickerIndex,
    query: prepared(id).init(),
    picker: createSearchPickerState({ queryResult: null }, searchPickerIndex)
  });
}
export function transitionWritingPicker(
  state: WritingPicker,
  transition: SearchPickerControlTransition
): Update {
  const picker = searchPickerReducer(state.picker, transition, {
    searchPickerIndex: state.searchPickerIndex,
    queryResult: state.query.result
  });
  const next = { ...state, picker };
  return picker.editor.input.text === state.picker.editor.input.text &&
    picker.mode === state.picker.mode &&
    picker.caseSensitive === state.picker.caseSensitive
    ? { state: next }
    : request(next);
}
export function receiveWritingPickerQuery(
  state: WritingPicker,
  message: WritingPickerQueryMessage
): Update {
  if (message.id !== state.id) return { state };
  const result = prepared(state.id).update(state.query, message.message);
  return result.state === state.query
    ? { state }
    : { ...result, state: reconcile({ ...state, query: result.state }) };
}

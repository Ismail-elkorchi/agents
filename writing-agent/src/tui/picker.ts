import { createSearchPickerIndex } from '@ismail-elkorchi/terminal-ui/behavior';
export function pickerIndex(entries: readonly { readonly id: string; readonly label: string }[]) {
  return createSearchPickerIndex(entries, (entry) => ({ ...entry, value: entry.id }));
}

import { notesView } from '@agents/tui';
import type { TextAreaTransition } from '@ismail-elkorchi/terminal-ui/behavior';
import { searchPickerView } from '@ismail-elkorchi/terminal-ui/behavior';
import type { Element } from '@ismail-elkorchi/terminal-ui/components';
import {
  button,
  dialog,
  divider,
  richText,
  searchPicker,
  text,
  textArea
} from '@ismail-elkorchi/terminal-ui/components';
import { column, grid, overlay, row, viewport } from '@ismail-elkorchi/terminal-ui/layout';
import type { TuiContext } from '@ismail-elkorchi/terminal-ui/tui';
import { historyViewport } from './history.js';
import { pickerIndex } from './picker.js';
import { recoveryView } from './recovery.js';
import { historySearchView } from './search.js';
import type { WritingTuiMessage, WritingTuiState } from './state.js';

type View = Element<WritingTuiMessage>;
const plain = (content: string): View => text({ content });
const action = (id: string, label: string, message: WritingTuiMessage): View =>
  button({ id, label, onPress: () => message });

export function writingView(state: WritingTuiState, context: TuiContext, composerHeight: number): View {
  const { columns, rows } = context.terminalSize;
  const title = `${state.document?.value.path ?? 'Writing Agent'} · ${state.application.model ?? 'Select a model'} · ${state.application.mode} · ${state.application.status}`;
  const main = grid(
    [
      text({ id: 'writing-status', content: title }),
      row(
        (['conversation', 'document'] as const).map((view) =>
          action(`view-${view}`, view === state.view ? `[${view}]` : view, {
            type: 'view',
            view
          })
        )
      ),
      columns >= 100 && state.view !== 'document'
        ? row(
            [
              documentView(state, Math.floor(columns * 0.6)),
              sectionView(state, columns - Math.floor(columns * 0.6), rows - composerHeight - 7, context)
            ],
            { sizes: [{ kind: 'percent', value: 60 }, { kind: 'fill' }] }
          )
        : sectionView(state, columns, rows - composerHeight - 7, context),
      text({
        id: 'writing-notice',
        content: state.notice || 'F1 Help · F2 Files · F7 Edit/review · F10 Model · F11 Sessions'
      }),
      divider({ id: 'writing-divider' }),
      textArea<WritingTuiMessage>({
        id: 'writing-composer',
        meta: { accessibleName: 'Writing instruction' },
        state: state.composer,
        placeholder:
          state.application.mode === 'review'
            ? 'Ask for a review or discuss the text'
            : 'Describe what you want to write or change',
        wrap: true,
        scrollbar: { axis: 'vertical', visible: 'auto' },
        onTransition: (transition: TextAreaTransition): WritingTuiMessage => ({
          type: 'composer.edit',
          transition
        })
      }),
      row([
        action('writing-send', state.submitting ? 'Accepting…' : 'Send', {
          type: 'submit'
        }),
        action('writing-files', 'Files', {
          type: 'picker.open',
          subject: 'resources'
        }),
        action('writing-mode', state.application.mode === 'edit' ? 'Switch to review' : 'Enable editing', {
          type: 'mode.toggle'
        }),
        action('writing-exit', 'Exit', { type: 'exit' })
      ])
    ],
    {
      id: 'writing-workspace',
      rows: [
        { kind: 'fixed', cells: 1 },
        { kind: 'fixed', cells: 1 },
        { kind: 'fill' },
        { kind: 'fixed', cells: 2 },
        { kind: 'fixed', cells: 1 },
        { kind: 'fixed', cells: composerHeight },
        { kind: 'fixed', cells: 1 }
      ],
      columns: [{ kind: 'fill' }]
    }
  );
  const modal = modalView(
    state,
    Math.max(12, Math.min(84, columns - 4)),
    Math.max(6, Math.min(24, rows - 4))
  );
  return overlay(modal === undefined ? [main] : [main, modal]);
}

function sectionView(state: WritingTuiState, width: number, height: number, context: TuiContext): View {
  switch (state.view) {
    case 'document':
      return documentView(state, width);
    case 'conversation':
      return conversationView(state, width, height, context);
  }
}

function documentView(state: WritingTuiState, width: number): View {
  const document = state.document;
  if (document === undefined)
    return column([
      plain('Open a workspace file to read or select a passage.'),
      action('select-resource', 'Select document', {
        type: 'picker.open',
        subject: 'resources'
      })
    ]);
  const content = document.source
    ? textArea<WritingTuiMessage>({
        id: 'writing-document-source',
        meta: { accessibleName: 'Document source and passage selection' },
        state: document.input,
        readOnly: true,
        wrap: true,
        lineNumbers: true,
        scrollbar: { axis: 'vertical', visible: 'auto' },
        onTransition: (transition: TextAreaTransition): WritingTuiMessage => ({
          type: 'document.edit',
          transition
        })
      })
    : viewport(
        richText({
          id: 'writing-document-rendered',
          segments: document.markdown.render(width - 2).segments,
          wrap: true
        }),
        {
          id: 'writing-document',
          offset: { row: document.offsetRow },
          scrollbar: { axis: 'vertical', visible: 'auto' },
          onScroll: (request) => ({ type: 'document.scroll', request })
        }
      );
  return column(
    [
      content,
      row([
        action('document-source-toggle', document.source ? 'Rendered' : 'Source / select', {
          type: 'document.toggle-source'
        }),
        action('document-use-passage', 'Use passage', {
          type: 'document.use-passage'
        })
      ])
    ],
    { sizes: [{ kind: 'fill' }, { kind: 'fixed', cells: 1 }] }
  );
}

function conversationView(state: WritingTuiState, width: number, height: number, context: TuiContext): View {
  return column(
    [
      historyViewport(state, width, Math.max(1, height - 1), context),
      row([
        action('writing-history-older', 'Older', {
          type: 'history.load',
          direction: 'older'
        }),
        action('writing-history-newer', 'Newer', {
          type: 'history.load',
          direction: 'newer'
        }),
        action('writing-history-tail', state.unread ? 'Latest •' : 'Latest', {
          type: 'history.load',
          direction: 'tail'
        })
      ])
    ],
    { sizes: [{ kind: 'fill' }, { kind: 'fixed', cells: 1 }] }
  );
}

function modalView(state: WritingTuiState, width: number, height: number): View | undefined {
  const modal = state.overlay;
  const close = action('writing-modal-close', 'Close', {
    type: 'overlay.close'
  });
  let content: View, focusId: string, title: string;
  switch (modal.kind) {
    case 'loading':
      title = 'Loading';
      focusId = 'writing-modal-close';
      content = plain('Reading…');
      break;
    case 'notes':
      return notesView(modal.state, width, height, (message) => message);
    case 'none':
      return undefined;
    case 'search':
      title = 'Search recorded conversation';
      focusId = 'writing-history-search';
      content = scrollable(state, 'writing-search-results', historySearchView(state));
      break;
    case 'source':
      title = state.source?.title ?? 'Original source';
      focusId = state.source === undefined ? 'writing-modal-close' : 'writing-source-reader';
      content =
        state.source === undefined
          ? plain('Source is unavailable.')
          : textArea<WritingTuiMessage>({
              id: focusId,
              meta: { accessibleName: state.source.title },
              state: state.source.input,
              readOnly: true,
              wrap: true,
              lineNumbers: true,
              scrollbar: { axis: 'vertical', visible: 'auto' },
              onTransition: (transition: TextAreaTransition): WritingTuiMessage => ({
                type: 'source.edit',
                transition
              })
            });
      break;
    case 'recovery':
      title = 'Run recovery and decisions';
      focusId = 'writing-modal-close';
      content = scrollable(state, 'writing-recovery', recoveryView(state));
      break;
    case 'picker':
      title = modal.subject;
      focusId = 'writing-picker';
      content = searchPicker({
        id: focusId,
        title,
        view: searchPickerView(modal.picker),
        searchPickerIndex: pickerIndex(modal.entries),
        maxVisible: Math.max(1, height - 5),
        emptyText: 'No entries available.',
        onTransition: (transition) => ({
          type: 'picker.transition',
          transition
        }),
        onAccept: (event) => ({ type: 'picker.accept', id: event.id })
      });
      break;
    case 'form':
      title = 'Model configuration';
      focusId = 'writing-field-0';
      content = column([
        ...modal.fields.flatMap((field, index) => [
          plain(field.name),
          textArea<WritingTuiMessage>({
            id: `writing-field-${String(index)}`,
            meta: { accessibleName: field.name },
            state: field.input,
            onTransition: (transition: TextAreaTransition): WritingTuiMessage => ({
              type: 'form.edit',
              index,
              transition
            })
          })
        ]),
        action('writing-form-submit', 'Save', { type: 'form.submit' })
      ]);
      break;
  }
  return dialog({
    id: 'writing-modal',
    title,
    modal: true,
    width,
    height,
    padding: 1,
    focusPolicy: {
      initialFocus: { kind: 'element', elementId: focusId },
      returnFocus: 'restore'
    },
    dismissal: { dismissOnEscape: true, dismissOnOutsidePress: false },
    onDismiss: () => ({ type: 'overlay.close' }),
    slots: {
      actions: close,
      content: column([content, plain(state.notice)], {
        sizes: [{ kind: 'fill' }, { kind: 'fixed', cells: 2 }]
      })
    }
  });
}

function scrollable(state: WritingTuiState, id: string, content: View): View {
  return viewport(content, {
    id,
    offset: { row: state.offsets[id] ?? 0 },
    scrollbar: { axis: 'vertical', visible: 'auto' },
    onScroll: (request) => ({ type: 'section.scroll', id, request })
  });
}

import {
  attachmentsView,
  commandSuggestions,
  composerControls,
  configurationView,
  conversationFrame,
  notesView,
  preferencesView,
  progressStatusFields,
  promptRecallView,
  queueView,
  reasoningLabel,
  resourceCompletionRows,
  resourceSuggestions,
  sessionNameView,
  sourceInspectorView,
  statusline,
  type ConfigurationOperations,
  type StatusField
} from '@agent-core/tui';
import type { TextAreaTransition } from '@ismail-elkorchi/terminal-ui/behavior';
import { searchPickerView } from '@ismail-elkorchi/terminal-ui/behavior';
import type { Element } from '@ismail-elkorchi/terminal-ui/components';
import {
  button,
  dialog,
  richText,
  searchPicker,
  text,
  textArea
} from '@ismail-elkorchi/terminal-ui/components';
import { column, overlay, row, viewport } from '@ismail-elkorchi/terminal-ui/layout';
import type { TuiContext } from '@ismail-elkorchi/terminal-ui/tui';
import { WRITING_COMMANDS, WRITING_SHORTCUTS } from './commands.js';
import { historyViewport } from './history.js';
import { pickerIndex } from './picker.js';
import { recoveryView } from './recovery.js';
import { historySearchView } from './search.js';
import type { WritingTuiMessage, WritingTuiState } from './state.js';

type View = Element<WritingTuiMessage>;
const plain = (content: string): View => text({ content });
const action = (id: string, label: string, message: WritingTuiMessage): View =>
  button({ id, label, onPress: () => message });

export function writingView(
  state: WritingTuiState,
  context: TuiContext,
  composerHeight: number,
  configuration?: ConfigurationOperations
): View {
  const { columns, rows } = context.terminalSize;
  composerHeight += (rows >= 8 ? 1 : 0) + resourceCompletionRows(state.resourceCompletion);
  composerHeight += state.completion === undefined ? 0 : Math.min(5, state.completion.names.length) + 1;
  const fields = writingStatusFields(state);
  const preferences =
    columns < 80
      ? {
          ...state.preferences,
          statusline: ['status', ...state.preferences.statusline.filter((id) => id !== 'status')]
        }
      : state.preferences;
  const title = `Writing · ${statusline(preferences, fields)}`;
  const main = conversationFrame({
    id: 'writing-workspace',
    terminalRows: rows,
    composerRows: composerHeight,
    slots: {
      status: text({ id: 'writing-status', content: title }),
      conversation:
        columns >= 100 && state.document !== undefined && state.view !== 'document'
          ? row(
              [
                documentView(state, Math.floor(columns * 0.6)),
                sectionView(state, columns - Math.floor(columns * 0.6), rows - composerHeight - 3, context)
              ],
              { sizes: [{ kind: 'percent', value: 60 }, { kind: 'fill' }] }
            )
          : sectionView(state, columns, rows - composerHeight - 3, context),
      composer: column(
        [
          ...(rows < 8
            ? []
            : [
                composerControls({
                  attachments: state.composer.attachments,
                  queued: state.sessionView?.session.queuedInputs ?? 0,
                  delivery: state.application.status === 'running' ? 'follow_up' : 'input',
                  onAttachments: (): WritingTuiMessage => ({ type: 'attachments.open' }),
                  onQueue: (): WritingTuiMessage => ({ type: 'queue.open' })
                })
              ]),
          ...(state.resourceCompletion === undefined
            ? []
            : [resourceSuggestions(state.resourceCompletion)]),
          ...(state.completion === undefined
            ? []
            : [
                commandSuggestions(
                  state.completion,
                  WRITING_COMMANDS,
                  (name): WritingTuiMessage => ({ type: 'completion.accept', open: true, name })
                )
              ]),
          textArea<WritingTuiMessage>({
            id: 'writing-composer',
            meta: { accessibleName: 'Writing instruction' },
            state: state.composer.input,
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
          })
        ],
        {
          sizes: [
            ...(rows < 8 ? [] : [{ kind: 'fixed' as const, cells: 1 }]),
            ...(state.resourceCompletion === undefined
              ? []
              : [{ kind: 'fixed' as const, cells: resourceCompletionRows(state.resourceCompletion) }]),
            ...(state.completion === undefined
              ? []
              : [{ kind: 'fixed' as const, cells: Math.min(5, state.completion.names.length) + 1 }]),
            { kind: 'fill' }
          ]
        }
      ),
      footer: [
        ...(state.sessionView?.session.suspension === undefined
          ? []
          : [action('writing-pending-decision', 'Review pending decision', { type: 'recovery.open' })]),
        action('writing-commands', 'Commands', { type: 'commands.open' }),
        ...(state.application.status === 'running'
          ? [action('writing-stop', 'Stop', { type: 'interrupt' })]
          : []),
        action(
          'writing-send',
          state.submitting
            ? 'Accepting…'
            : state.application.status === 'running'
              ? 'Queue follow-up'
              : 'Send',
          {
            type: 'submit'
          }
        ),
        action('writing-exit', 'Exit', { type: 'exit' })
      ]
    }
  });
  const modal = modalView(
    state,
    Math.max(12, Math.min(84, columns - 4)),
    Math.max(6, Math.min(24, rows - 4)),
    configuration
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

function conversationView(
  state: WritingTuiState,
  width: number,
  height: number,
  context: TuiContext
): View {
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

function modalView(
  state: WritingTuiState,
  width: number,
  height: number,
  configuration?: ConfigurationOperations
): View | undefined {
  const modal = state.overlay;
  const close = action('writing-modal-close', 'Close', {
    type: 'overlay.close'
  });
  let content: View, focusId: string, title: string;
  switch (modal.kind) {
    case 'session-name':
      return sessionNameView(modal.state, width, height);
    case 'inspector':
      return sourceInspectorView(modal.state, width, height);
    case 'attachments':
      return attachmentsView(modal.state, state.composer.attachments, width, height);
    case 'recall':
      return promptRecallView(modal.state, width, height);
    case 'queue':
      return queueView(modal.state, width, height);
    case 'preferences':
      return preferencesView(
        modal.preferences,
        writingStatusFields(state),
        width,
        height,
        state.offsets.preferences,
        {
          actions: WRITING_SHORTCUTS,
          ...(modal.capture === undefined ? {} : { capturing: modal.capture }),
          ...(modal.error === undefined ? {} : { error: modal.error })
        }
      );
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
    case 'configuration':
      return configuration === undefined
        ? undefined
        : configurationView(modal.state, configuration, width, height);
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

function writingStatusFields(state: WritingTuiState): readonly StatusField[] {
  const field = (id: string, label: string, value: string | undefined): StatusField => ({
    id,
    label,
    ...(value === undefined ? {} : { value })
  });
  const queued = state.sessionView?.session.queuedInputs;
  return [
    ...progressStatusFields(state.progress),
    field('session', 'Session', state.application.sessionId),
    field(
      'reasoning',
      'Reasoning configuration',
      reasoningLabel(state.sessionView?.session.configuration.reasoning)
    ),
    field('model', 'Model', state.application.model),
    field('provider', 'Provider', state.application.provider),
    field('mode', 'Edit or review', state.application.mode),
    field(
      'status',
      'Run status',
      state.application.status === 'running' ? state.progress.label : state.application.status
    ),
    field(
      'queue',
      'Queued inputs',
      queued === undefined || queued === 0 ? undefined : `${String(queued)} queued`
    ),
    field('document', 'Document', state.document?.value.path)
  ];
}

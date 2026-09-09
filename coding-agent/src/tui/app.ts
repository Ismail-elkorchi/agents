import type { AgentApprovalRequest, AgentApprovalSuspension } from '@agent-core/runtime';
import {
  composerRows,
  copySource,
  editTextExternally,
  notesView,
  selectedSource,
  updateNotes
} from '@agents/tui';
import type { SearchPickerIndex } from '@ismail-elkorchi/terminal-ui/behavior';
import {
  applyScrollRequest,
  createSearchPickerIndex,
  createSearchPickerState,
  normalizeScrollState,
  scrollReducer,
  searchPickerReducer,
  searchPickerView
} from '@ismail-elkorchi/terminal-ui/behavior';
import { measuredWindow, type MeasuredCollection } from '@ismail-elkorchi/terminal-ui/collection';
import type { Element, InlineContent } from '@ismail-elkorchi/terminal-ui/components';
import {
  button,
  dialog,
  disclosure,
  divider,
  richText,
  searchPicker,
  text,
  textArea
} from '@ismail-elkorchi/terminal-ui/components';
import type { InputTrigger } from '@ismail-elkorchi/terminal-ui/input';
import type { ScrollGeometry } from '@ismail-elkorchi/terminal-ui/interaction';
import { formatKeyboardBinding } from '@ismail-elkorchi/terminal-ui/interaction';
import { column, grid, measuredViewport, overlay, row, viewport } from '@ismail-elkorchi/terminal-ui/layout';
import { textDocumentText, wrapTextCells } from '@ismail-elkorchi/terminal-ui/text';
import type {
  TuiContext,
  TuiEventSource,
  TuiInputBindingContext,
  TuiUpdateResult
} from '@ismail-elkorchi/terminal-ui/tui';
import { defineTui, tuiBindingHelp } from '@ismail-elkorchi/terminal-ui/tui';
import type {
  CodingApplicationState,
  CodingRuntimeDetails,
  CodingSessionView
} from '../application/contracts.js';
import { hintBar, statusChrome } from './chrome.js';
import { commandEffect } from './command-effects.js';
import type { CodingAgentTuiCommandHandler } from './command-surface.js';
import {
  COMMAND_INDEX,
  applyCommandExecution,
  applyCommandFailure,
  editComposer,
  navigateComposerHistory,
  setComposerText,
  submitComposer
} from './command-surface.js';
import type { CodingAgentTuiActivityEntry, CodingAgentTuiConversationEntry } from './conversation-model.js';
import { appendNotice, appendUser, toggleActivity, upsertConversationEntry } from './conversation.js';
import {
  applyCodingHandoff,
  applyFailure,
  applyProgress,
  applyResult,
  applySessionState
} from './event-reducer.js';
import { failHistory, loadHistory, receiveHistory, type CodingHistoryReader } from './history.js';
import { hydrateCodingAgentTuiState } from './hydration.js';
import { INTERACTIVE_COMMANDS } from './interactive-commands.js';
import type { CodingAgentTuiMessage } from './messages.js';
import { openPanel, panelView, updatePanel, type CodingNavigationOperations } from './panels.js';
import {
  historySearchIndex,
  jumpToSearchResult,
  openHistorySearch,
  receiveSearch,
  receiveSearchJump,
  searchHistory,
  transitionHistorySearch,
  type HistorySearcher
} from './search.js';
import { restoreSessionView } from './session-view.js';
import type { CodingAgentTuiSetupState, CodingAgentTuiState } from './state.js';
import { createInitialCodingAgentTuiState } from './state.js';

export interface CodingAgentTuiAppOptions {
  readonly navigation?: CodingNavigationOperations;
  readonly historyReader?: CodingHistoryReader;
  readonly historySearcher?: HistorySearcher;
  readonly externalEditor?: (text: string, signal: AbortSignal) => Promise<string>;
  readonly listFiles?: (
    directory: string,
    prefix: string
  ) => Promise<readonly { readonly path: string; readonly kind: 'file' | 'directory' }[]>;
  readonly showReasoning?: boolean;
  readonly eventSource?: TuiEventSource<CodingAgentTuiMessage>;
  readonly commandHandler?: CodingAgentTuiCommandHandler;
  readonly runtimeDetails?: CodingRuntimeDetails;
  readonly setup?: CodingAgentTuiSetupState;
  readonly initialHydration?: CodingSessionView;
  readonly approvalHandler?: (
    suspension: AgentApprovalSuspension,
    decision: 'allow' | 'deny'
  ) => Promise<void>;
}

export function createCodingAgentTuiApp(task: string, options: CodingAgentTuiAppOptions = {}) {
  const eventSource = options.eventSource;
  let helpText = '';
  let hints: readonly { readonly label: string; readonly keys: string }[] = [];
  const app = defineTui<CodingAgentTuiState, CodingAgentTuiMessage>({
    id: 'coding-agent',
    init: () => ({
      state: initialState(task, options),
      focus: { kind: 'element', elementId: 'composer' }
    }),
    update: (state, message, context) => {
      const result = updateCodingAgentTui(state, message, context, options);
      if (
        message.type === 'result' &&
        options.historyReader !== undefined &&
        result.state.conversation.scroll.followTail
      ) {
        const history = loadHistory(result.state, 'tail', options.historyReader);
        return { ...result, ...history, effects: [...(result.effects ?? []), ...(history.effects ?? [])] };
      }
      return result;
    },
    inputBindings: [
      binding(
        'copy-selected-source',
        'c',
        { ctrl: true },
        { type: 'source.copy' },
        ({ state }) => selectedSource(copyInput(state)) !== undefined
      ),
      binding('Model notes', 'n', { alt: true }, { type: 'notes.open' }, ({ state }) =>
        canOpenOverlay(state)
      ),
      binding('commands', 'p', { ctrl: true }, { type: 'overlay.open', overlay: 'commands' }, ({ state }) =>
        canOpenOverlay(state)
      ),
      ...(
        [
          { key: 'f2', panel: 'sessions' },
          { key: 'f5', panel: 'branches' },
          { key: 'f6', panel: 'queue' },
          { key: 'f7', panel: 'changes' },
          { key: 'f8', panel: 'source' }
        ] as const
      ).map(({ key, panel }) =>
        binding(panel, key, {}, { type: 'panel.open', panel }, ({ state }) => canOpenOverlay(state))
      ),
      binding('search', 'f', { ctrl: true }, { type: 'overlay.open', overlay: 'search' }, ({ state }) =>
        canOpenOverlay(state)
      ),
      binding(
        'more-search-results',
        'f3',
        {},
        { type: 'search.more' },
        ({ state }) => state.overlay.kind === 'search'
      ),
      binding('help', 'f1', {}, { type: 'overlay.open', overlay: 'help' }, ({ state }) =>
        canOpenOverlay(state)
      ),
      binding(
        'page-up',
        'pageUp',
        {},
        { type: 'conversation.scroll', transition: { kind: 'scrollPages', rows: -1 } },
        ({ state }) => canScroll(state)
      ),
      binding(
        'page-down',
        'pageDown',
        {},
        { type: 'conversation.scroll', transition: { kind: 'scrollPages', rows: 1 } },
        ({ state }) => canScroll(state)
      ),
      binding(
        'composer-history-previous',
        'arrowUp',
        {},
        { type: 'composer.history', direction: 'previous' },
        composerHistoryPreviousEnabled
      ),
      binding(
        'composer-history-next',
        'arrowDown',
        {},
        { type: 'composer.history', direction: 'next' },
        composerHistoryNextEnabled
      ),
      binding('composer-submit', 'enter', {}, { type: 'composer.submit' }, composerBindingEnabled),
      binding(
        'steer-active-run',
        'enter',
        { alt: true },
        { type: 'composer.submit', delivery: 'steer' },
        composerBindingEnabled
      ),
      binding(
        'queue-follow-up',
        'enter',
        { ctrl: true },
        { type: 'composer.submit', delivery: 'follow_up' },
        composerBindingEnabled
      ),
      binding('external-editor', 'f4', {}, { type: 'composer.external-editor' }, composerBindingEnabled),
      binding(
        'complete-command-or-path',
        'space',
        { ctrl: true },
        { type: 'composer.complete' },
        composerBindingEnabled
      ),
      binding(
        'restore-instruction-draft',
        'escape',
        {},
        { type: 'composer.cancel-command' },
        (context) =>
          composerBindingEnabled(context) && context.state.composer.commandReturnDraft !== undefined
      ),
      binding(
        'interrupt-work',
        'c',
        { ctrl: true },
        { type: 'work.interrupt' },
        ({ state }) => canOpenOverlay(state) && state.composer.input.selection === undefined
      ),
      binding(
        'copy-original-markdown',
        'y',
        { ctrl: true },
        { type: 'conversation.copy', format: 'original' },
        ({ state }) => canOpenOverlay(state)
      ),
      binding(
        'copy-displayed-text',
        'y',
        { alt: true },
        { type: 'conversation.copy', format: 'displayed' },
        ({ state }) => canOpenOverlay(state)
      ),
      binding(
        'copy-code',
        'y',
        { ctrl: true, shift: true },
        { type: 'conversation.copy', format: 'code' },
        ({ state }) => canOpenOverlay(state)
      ),
      binding(
        'older-history',
        'pageUp',
        { ctrl: true },
        { type: 'history.load', direction: 'older' },
        ({ state }) => canScroll(state)
      ),
      binding(
        'newer-history',
        'pageDown',
        { ctrl: true },
        { type: 'history.load', direction: 'newer' },
        ({ state }) => canScroll(state)
      ),
      binding(
        'follow-latest-output',
        'end',
        { ctrl: true },
        { type: 'history.load', direction: 'tail' },
        ({ state }) => canScroll(state)
      ),
      binding(
        'composer-newline-shift-enter',
        'enter',
        { shift: true },
        composerNewlineMessage(),
        composerBindingEnabled
      ),
      binding(
        'composer-newline-control-o',
        'o',
        { ctrl: true },
        composerNewlineMessage(),
        composerBindingEnabled
      )
    ],
    ...(eventSource === undefined
      ? {}
      : { subscriptions: (): readonly TuiEventSource<CodingAgentTuiMessage>[] => [eventSource] }),
    resizeMessage: (): CodingAgentTuiMessage => ({ type: 'terminal.resized' }),
    view: (state, context) => agentTuiView(state, context, helpText, hints)
  });
  hints = tuiBindingHelp(app).map((item) => ({
    label: item.label,
    keys: item.bindings.map((binding) => formatKeyboardBinding(binding.binding)).join(' / ')
  }));
  helpText = hints.map((item) => `${item.keys}  ${item.label}`).join('\n');
  return app;
}

function initialState(task: string, options: CodingAgentTuiAppOptions): CodingAgentTuiState {
  const initial = createInitialCodingAgentTuiState(
    options.runtimeDetails,
    options.setup,
    options.showReasoning
  );
  const hydrated =
    options.initialHydration === undefined
      ? initial
      : hydrateCodingAgentTuiState(initial, options.initialHydration);
  const normalizedTask = task.trim();
  return normalizedTask.length === 0 ? hydrated : appendUser(hydrated, normalizedTask);
}

function updateCodingAgentTui(
  state: CodingAgentTuiState,
  message: CodingAgentTuiMessage,
  context: TuiContext,
  options: CodingAgentTuiAppOptions
): TuiUpdateResult<CodingAgentTuiState, CodingAgentTuiMessage> {
  switch (message.type) {
    case 'source.copy': {
      const source = selectedSource(copyInput(state));
      return source === undefined
        ? { state }
        : { state, effects: [copySource(source, (message) => ({ type: 'interactive.notice', message }))] };
    }
    case 'notes.open':
    case 'notes.listed':
    case 'notes.read':
    case 'notes.loaded':
    case 'notes.failed':
    case 'notes.edit':
    case 'notes.scroll': {
      if (
        options.navigation === undefined ||
        (message.type !== 'notes.open' && state.overlay.kind !== 'notes')
      )
        return { state };
      const result = updateNotes(
        state.overlay.kind === 'notes' ? state.overlay.state : { offset: 0 },
        message,
        options.navigation
      );
      return {
        state: { ...state, overlay: { kind: 'notes', state: result.state } },
        ...(result.effects === undefined ? {} : { effects: result.effects })
      };
    }

    case 'progress':
      return updated(livePresentation(state, applyProgress(state, message.event)), context);
    case 'result':
      return updated(livePresentation(state, applyResult(state, message.result)), context);
    case 'panel.open':
      return openPanel(state, message.panel, options.navigation);
    case 'panel.source-loaded':
    case 'panel.loaded':
    case 'panel.failed':
    case 'panel.transition':
    case 'panel.accept':
    case 'panel.text':
    case 'panel.queue-save':
    case 'panel.queue-cancel':
    case 'panel.branch':
    case 'panel.done':
    case 'panel.operation-failed':
      return updatePanel(state, message, options.navigation);
    case 'submissions.changed': {
      let next: CodingAgentTuiState = {
        ...state,
        debug: { ...state.debug, pendingSubmissions: message.pending },
        conversation: {
          ...state.conversation,
          items: state.conversation.items.filter(
            (item) => message.cancelledRunId === undefined || item.id !== `input:${message.cancelledRunId}`
          )
        }
      };
      for (const submission of message.pending)
        if (submission.state === 'queued')
          next = upsertConversationEntry(next, {
            id: `input:${submission.runId}`,
            kind: 'user',
            text: submission.input.task
          });
      return updated(next, context);
    }
    case 'history.load':
      return loadHistory(state, message.direction, options.historyReader);
    case 'history.loaded':
      return updated(receiveHistory(state, message.requestId, message.pages), context);
    case 'history.failed':
      return updated(failHistory(state, message.requestId, message.message), context);
    case 'failure':
      return updated(applyFailure(state, message.message), context);
    case 'delivery.failed':
      return {
        state: reconcileConversationLayout(applyFailure(state, message.message), context),
        exit: { reason: 'event-delivery-failed' }
      };
    case 'context.transitioned':
      return updated(
        upsertConversationEntry(state, {
          id: `session:${message.window.windowId}`,
          kind: 'notice',
          tone: 'info',
          text: `Context changed · ${message.window.selection.strategy} · ${message.window.windowId}\n${message.window.reason}`
        }),
        context
      );
    case 'handoff.ready':
      return updated(livePresentation(state, applyCodingHandoff(state, message.handoff)), context);
    case 'application.state.changed':
      return updated(applyInteractiveState(state, message.state), context);
    case 'interactive.notice':
      if (state.overlay.kind === 'source')
        return { state: { ...state, overlay: { ...state.overlay, notice: message.message } } };
      if (state.overlay.kind === 'notes')
        return {
          state: {
            ...state,
            overlay: { ...state.overlay, state: { ...state.overlay.state, error: message.message } }
          }
        };
      return updated(appendNotice(state, message.message, message.tone ?? 'info'), context);
    case 'session.hydrated':
      return restoreSessionView(state, message.hydration, options.historyReader);
    case 'approval.required':
      return updated(
        {
          ...state,
          run: { kind: 'waiting_for_approval', suspension: message.suspension },
          overlay: { kind: 'none' },
          modalOffsetRow: 0
        },
        context,
        { kind: 'element', elementId: 'approval-deny' }
      );
    case 'run.suspended':
      return updated(
        {
          ...state,
          run: { kind: 'waiting_for_recovery', suspension: message.suspension },
          overlay: { kind: 'none' }
        },
        context
      );
    case 'approval.decide': {
      if (state.run.kind !== 'waiting_for_approval') return { state };
      return {
        state,
        effects: [approvalEffect(state.run.suspension, message.decision, options.approvalHandler)]
      };
    }
    case 'composer.edit':
      return updated(editComposer(state, message.transition), context);
    case 'composer.restore':
      return updated(setComposerText(state, message.text), context);
    case 'composer.history':
      return updated(navigateComposerHistory(state, message.direction), context);
    case 'composer.submit':
      return submit(state, context, options.commandHandler, message.delivery);
    case 'composer.cancel-command': {
      const { commandReturnDraft, ...composer } = state.composer;
      return updated(
        commandReturnDraft === undefined
          ? state
          : setComposerText({ ...state, composer }, commandReturnDraft),
        context
      );
    }
    case 'composer.complete': {
      const original = textDocumentText(state.composer.input.document);
      const end = state.composer.input.caret.position.offset;
      const before = original.slice(0, end);
      if (before.startsWith('/'))
        return {
          state: {
            ...state,
            overlay: {
              kind: 'commands',
              picker: createSearchPickerState(
                { query: { text: before.slice(1), mode: 'fuzzy' } },
                COMMAND_INDEX
              )
            }
          },
          focus: { kind: 'element', elementId: 'command-picker' }
        };
      const match = /(?:^|\s)@([^\s]*)$/u.exec(before);
      if (match?.[1] === undefined)
        return updated(appendNotice(state, 'Type @ followed by a workspace path, then Ctrl+Space.'), context);
      const prefix = match[1];
      const request = {
        id: `files:${String(state.nextLocalId)}`,
        original,
        end,
        start: end - prefix.length - 1,
        prefix
      };
      return {
        state: { ...state, nextLocalId: state.nextLocalId + 1, overlay: { kind: 'files_loading', request } },
        effects: [
          {
            id: 'file-completion',
            concurrency: 'replace',
            async run() {
              if (options.listFiles === undefined) throw new Error('Workspace file listing is unavailable.');
              const slash = prefix.lastIndexOf('/');
              const files = await options.listFiles(
                slash < 0 ? '.' : prefix.slice(0, slash) || '.',
                prefix.slice(slash + 1)
              );
              return {
                kind: 'message',
                message: {
                  type: 'files.loaded',
                  request,
                  paths: files.map((file) => (file.kind === 'directory' ? `${file.path}/` : file.path))
                }
              };
            },
            onError: ({ diagnostic }) => ({
              kind: 'message',
              message: { type: 'files.failed', requestId: request.id, message: diagnostic.message }
            })
          }
        ]
      };
    }
    case 'files.loaded':
      if (state.overlay.kind !== 'files_loading' || state.overlay.request.id !== message.request.id)
        return { state };
      return {
        state: {
          ...state,
          overlay: {
            kind: 'files',
            request: message.request,
            paths: message.paths,
            picker: createSearchPickerState({ query: { text: '', mode: 'fuzzy' } }, fileIndex(message.paths))
          }
        },
        focus: { kind: 'element', elementId: 'file-picker' }
      };
    case 'files.failed':
      return state.overlay.kind !== 'files_loading' || state.overlay.request.id !== message.requestId
        ? { state }
        : updated(appendNotice({ ...state, overlay: { kind: 'none' } }, message.message, 'error'), context, {
            kind: 'element',
            elementId: 'composer'
          });
    case 'files.transition':
      return state.overlay.kind !== 'files'
        ? { state }
        : {
            state: {
              ...state,
              overlay: {
                ...state.overlay,
                picker: searchPickerReducer(state.overlay.picker, message.transition, {
                  searchPickerIndex: fileIndex(state.overlay.paths)
                })
              }
            }
          };
    case 'files.accept': {
      if (state.overlay.kind !== 'files') return { state };
      const selected = state.overlay.paths.find((path) => path === message.event.id);
      if (selected === undefined) return { state };
      const { original, start, end } = state.overlay.request;
      const path = /\s/u.test(selected) ? JSON.stringify(selected) : selected;
      return updated(
        setComposerText(
          { ...state, overlay: { kind: 'none' } },
          `${original.slice(0, start)}@${path}${selected.endsWith('/') ? '' : ' '}${original.slice(end)}`
        ),
        context,
        { kind: 'element', elementId: 'composer' }
      );
    }
    case 'composer.external-editor': {
      const original = textDocumentText(state.composer.input.document);
      return {
        state,
        effects: [
          {
            id: 'external-editor',
            concurrency: 'keep-first',
            async run(effectContext) {
              const text = await effectContext.withTerminalSuspended(() =>
                (options.externalEditor ?? editTextExternally)(original, effectContext.signal)
              );
              return { kind: 'message', message: { type: 'composer.external-edited', original, text } };
            },
            onError: ({ diagnostic }) => ({
              kind: 'message',
              message: { type: 'interactive.notice', tone: 'error', message: diagnostic.message }
            })
          }
        ]
      };
    }
    case 'composer.external-edited':
      return updated(
        textDocumentText(state.composer.input.document) === message.original
          ? setComposerText(state, message.text)
          : appendNotice(
              {
                ...state,
                composer: { ...state.composer, history: [...state.composer.history, message.text] }
              },
              'The draft changed while editing; the editor result is available in composer history.'
            ),
        context,
        { kind: 'element', elementId: 'composer' }
      );
    case 'work.interrupt':
      if (state.run.kind === 'working' || state.run.kind === 'waiting_for_recovery')
        return executeCommand(state, '/abort', options.commandHandler);
      if (textDocumentText(state.composer.input.document).length === 0)
        return { state, exit: { reason: 'interrupt' } };
      return updated(
        appendNotice(state, 'No active work. Your draft is preserved; use the exit command to close.'),
        context
      );
    case 'conversation.copy': {
      const latest = [...state.conversation.items].reverse().find((entry) => entry.kind === 'assistant');
      if (latest?.kind !== 'assistant')
        return updated(appendNotice(state, 'No assistant output to copy.'), context);
      const document = state.presentation.markdown(latest.id, latest.text);
      const text =
        message.format === 'original'
          ? document.copyOriginal()
          : message.format === 'displayed'
            ? document.copyDisplayed(context.terminalSize.columns)
            : document
                .codeBlocks()
                .map((code) => code.value)
                .join('\n');
      if (text.length === 0) return updated(appendNotice(state, 'No code block to copy.'), context);
      return { state, effects: [copySource(text, (message) => ({ type: 'interactive.notice', message }))] };
    }
    case 'command.completed': {
      const result = applyCommandExecution(state, message.execution, message.request);
      const next =
        message.execution.view === 'debug'
          ? {
              ...result.state,
              overlay: { kind: 'debug' as const, text: debugText(result.state, message.execution.message) },
              modalOffsetRow: 0
            }
          : result.state;
      return result.exit === true ? { state: next, exit: { reason: 'command' } } : updated(next, context);
    }
    case 'command.failed':
      return updated(applyCommandFailure(state, message.message), context);
    case 'conversation.scroll': {
      const layout = conversationLayout(state, context);
      if (
        message.transition.kind === 'scrollPages' &&
        (message.transition.rows ?? 0) < 0 &&
        layout.scroll.offsetRow === 0 &&
        state.conversation.pages[0]?.history.older !== undefined
      )
        return loadHistory(state, 'older', options.historyReader);
      if (
        message.transition.kind === 'scrollPages' &&
        (message.transition.rows ?? 0) > 0 &&
        layout.scroll.offsetRow >= layout.geometry.contentRows - layout.geometry.viewportRows &&
        state.conversation.pages.at(-1)?.history.newer !== undefined
      )
        return loadHistory(state, 'newer', options.historyReader);
      return updated(
        {
          ...state,
          conversation: {
            ...state.conversation,
            scroll: scrollReducer(layout.scroll, message.transition, layout.geometry)
          }
        },
        context
      );
    }
    case 'conversation.scrolled':
      return updated(
        {
          ...state,
          conversation: {
            ...state.conversation,
            scroll: applyScrollRequest(state.conversation.scroll, message.request)
          }
        },
        context
      );
    case 'activity.toggle':
      return updated(toggleActivity(state, message.id), context);
    case 'overlay.open':
      return openOverlay(state, message.overlay, context);
    case 'overlay.close':
      return updated({ ...state, overlay: { kind: 'none' } }, context, {
        kind: 'element',
        elementId: 'composer'
      });
    case 'modal.scrolled':
      return { state: { ...state, modalOffsetRow: message.offsetRow } };
    case 'commands.transition':
      return transitionCommands(state, message.transition);
    case 'commands.accept':
      return acceptCommand(state, message.event.id, context, options.commandHandler);
    case 'command-values.transition':
      return transitionCommandValues(state, message.transition);
    case 'command-values.accept':
      return acceptCommandValue(state, message.event.id, options.commandHandler);
    case 'search.more':
      return searchHistory(state, options.historySearcher, true);
    case 'search.loaded':
    case 'search.failed':
      return { state: receiveSearch(state, message) };
    case 'search.jumped':
      return updated(receiveSearchJump(state, message), context, { kind: 'element', elementId: 'composer' });
    case 'search.transition':
      return transitionHistorySearch(state, message.transition, options.historySearcher);
    case 'search.accept':
      return jumpToSearchResult(state, message.event.id, options.historyReader);
    case 'terminal.resized':
      return updated(state, context);
    case 'app.exit':
      return {
        state,
        exit: message.reason === undefined ? {} : { reason: message.reason }
      };
  }
}

function submit(
  state: CodingAgentTuiState,
  context: TuiContext,
  handler: CodingAgentTuiCommandHandler | undefined,
  delivery?: 'steer' | 'follow_up'
): TuiUpdateResult<CodingAgentTuiState, CodingAgentTuiMessage> {
  if (state.run.kind === 'waiting_for_approval') return { state };
  const submission = submitComposer(state, delivery);
  return submission.request === undefined
    ? { state: submission.state }
    : {
        state: reconcileConversationLayout(submission.state, context),
        effects: [commandEffect(submission.request, handler)]
      };
}

function executeCommand(
  state: CodingAgentTuiState,
  value: string,
  handler: CodingAgentTuiCommandHandler | undefined
): TuiUpdateResult<CodingAgentTuiState, CodingAgentTuiMessage> {
  const count = state.composer.submissionCount + 1;
  return {
    state: { ...state, composer: { ...state.composer, submissionCount: count } },
    effects: [commandEffect({ id: `command:${String(count)}`, value, recordResult: true }, handler)]
  };
}

function applyInteractiveState(
  state: CodingAgentTuiState,
  interactive: CodingApplicationState
): CodingAgentTuiState {
  let next: CodingAgentTuiState = {
    ...state,
    setup: {
      status: interactive.status,
      requirements: interactive.requirements
    },
    runtimeDetails: interactive.runtimeDetails,
    debug: {
      ...state.debug,
      ...(interactive.runtimeDetails.sessionLocation === undefined
        ? {}
        : { sessionLocation: interactive.runtimeDetails.sessionLocation }),
      ...(interactive.session === undefined
        ? {}
        : {
            sessionId: interactive.session.sessionId,
            session: interactive.session
          })
    }
  };
  if (interactive.status === 'initializing') {
    return upsertConversationEntry(next, {
      id: 'interactive:setup',
      kind: 'notice',
      tone: 'info',
      text: 'Initializing workspace and session state…'
    });
  }
  if (interactive.status === 'setup_required') {
    const commands = interactive.requirements.map((requirement) => {
      switch (requirement) {
        case 'workspace_trust':
          return '/trust restricted or /trust trusted';
        case 'provider':
          return '/provider <ollama|openrouter|openai|openai-codex>';
        case 'model':
          return '/model <model-id>';
      }
    });
    return upsertConversationEntry(next, {
      id: 'interactive:setup',
      kind: 'notice',
      tone: 'warning',
      text: `Setup required. Configure ${interactive.requirements.map((item) => item.replaceAll('_', ' ')).join(', ')}.\n${commands.join('\n')}\nMessages are retained until setup is complete.`
    });
  }
  next = upsertConversationEntry(next, {
    id: 'interactive:setup',
    kind: 'notice',
    tone: 'info',
    text: `Ready · ${interactive.runtimeDetails.providerId ?? 'provider'}/${interactive.runtimeDetails.modelId ?? 'model'}`
  });
  return interactive.session === undefined ? next : applySessionState(next, interactive.session);
}

function transitionCommands(
  state: CodingAgentTuiState,
  transition: Extract<CodingAgentTuiMessage, { type: 'commands.transition' }>['transition']
): TuiUpdateResult<CodingAgentTuiState, CodingAgentTuiMessage> {
  if (state.overlay.kind !== 'commands') return { state };
  return {
    state: {
      ...state,
      overlay: {
        kind: 'commands',
        picker: searchPickerReducer(state.overlay.picker, transition, { searchPickerIndex: COMMAND_INDEX })
      }
    }
  };
}

function acceptCommand(
  state: CodingAgentTuiState,
  id: string,
  context: TuiContext,
  handler: CodingAgentTuiCommandHandler | undefined
): TuiUpdateResult<CodingAgentTuiState, CodingAgentTuiMessage> {
  if (state.overlay.kind !== 'commands') return { state };
  const command = INTERACTIVE_COMMANDS.find((candidate) => candidate.name === id);
  if (command === undefined) return { state };
  if (command.choices !== undefined) {
    const picker = createSearchPickerState(
      { query: { text: '', mode: 'fuzzy' } },
      commandValueIndex(command)
    );
    return updated(
      {
        ...state,
        overlay: { kind: 'command_values', command: command.name, picker },
        modalOffsetRow: 0
      },
      context,
      { kind: 'element', elementId: 'command-value-picker' }
    );
  }
  if (command.value === 'required') {
    const draft = state.composer.commandReturnDraft ?? textDocumentText(state.composer.input.document);
    return updated(
      setComposerText(
        { ...state, composer: { ...state.composer, commandReturnDraft: draft }, overlay: { kind: 'none' } },
        `${command.name} `
      ),
      context,
      {
        kind: 'element',
        elementId: 'composer'
      }
    );
  }
  return executeCommand({ ...state, overlay: { kind: 'none' } }, command.name, handler);
}

function transitionCommandValues(
  state: CodingAgentTuiState,
  transition: Extract<CodingAgentTuiMessage, { type: 'command-values.transition' }>['transition']
): TuiUpdateResult<CodingAgentTuiState, CodingAgentTuiMessage> {
  if (state.overlay.kind !== 'command_values') return { state };
  const commandOverlay = state.overlay;
  const commandEntry = INTERACTIVE_COMMANDS.find((candidate) => candidate.name === commandOverlay.command);
  if (commandEntry?.choices === undefined) return { state };
  return {
    state: {
      ...state,
      overlay: {
        ...commandOverlay,
        picker: searchPickerReducer(commandOverlay.picker, transition, {
          searchPickerIndex: commandValueIndex(commandEntry)
        })
      }
    }
  };
}

function acceptCommandValue(
  state: CodingAgentTuiState,
  value: string,
  handler: CodingAgentTuiCommandHandler | undefined
): TuiUpdateResult<CodingAgentTuiState, CodingAgentTuiMessage> {
  if (state.overlay.kind !== 'command_values') return { state };
  const commandOverlay = state.overlay;
  const commandEntry = INTERACTIVE_COMMANDS.find((candidate) => candidate.name === commandOverlay.command);
  if (commandEntry?.choices?.some((choice) => choice.value === value) !== true) return { state };
  return {
    ...executeCommand({ ...state, overlay: { kind: 'none' } }, `${commandEntry.name} ${value}`, handler),
    focus: { kind: 'element', elementId: 'composer' }
  };
}

function commandValueIndex(commandEntry: (typeof INTERACTIVE_COMMANDS)[number]): SearchPickerIndex {
  return createSearchPickerIndex(
    (commandEntry.choices ?? []).map((choice) => ({
      id: choice.value,
      label: choice.value,
      value: choice.value,
      description: choice.description,
      keywords: [choice.value, choice.description]
    }))
  );
}

function openOverlay(
  state: CodingAgentTuiState,
  kind: 'commands' | 'search' | 'help' | 'debug',
  context: TuiContext
): TuiUpdateResult<CodingAgentTuiState, CodingAgentTuiMessage> {
  if (!canOpenOverlay(state)) return { state };
  if (kind === 'help') return { state: { ...state, overlay: { kind: 'help' }, modalOffsetRow: 0 } };
  if (kind === 'debug')
    return { state: { ...state, overlay: { kind: 'debug', text: debugText(state) }, modalOffsetRow: 0 } };
  if (kind === 'search') return openHistorySearch(state);
  return updated(
    {
      ...state,
      overlay: {
        kind: 'commands',
        picker: createSearchPickerState({ query: { text: '', mode: 'fuzzy' } }, COMMAND_INDEX)
      },
      modalOffsetRow: 0
    },
    context,
    { kind: 'element', elementId: 'command-picker' }
  );
}

function updated(
  state: CodingAgentTuiState,
  context: TuiContext,
  focus?: TuiUpdateResult<CodingAgentTuiState, CodingAgentTuiMessage>['focus']
): TuiUpdateResult<CodingAgentTuiState, CodingAgentTuiMessage> {
  return {
    state: reconcileConversationLayout(state, context),
    ...(focus === undefined ? {} : { focus })
  };
}

function reconcileConversationLayout(state: CodingAgentTuiState, context: TuiContext): CodingAgentTuiState {
  const layout = conversationLayout(state, context);
  const { anchor, ...conversation } = state.conversation;
  if (layout.scroll === state.conversation.scroll && anchor === undefined) return state;
  return { ...state, conversation: { ...conversation, scroll: layout.scroll } };
}

function agentTuiView(
  state: CodingAgentTuiState,
  context: TuiContext,
  helpText: string,
  hints: readonly { readonly label: string; readonly keys: string }[]
): Element<CodingAgentTuiMessage> {
  const workspace = grid(
    [
      statusChrome(state),
      conversationView(state, context),
      divider({ id: 'composer-divider' }),
      composerView(state),
      hintBar(state, context.terminalSize.columns, hints)
    ],
    {
      id: 'coding-agent-tui',
      rows: [
        { kind: 'fixed', cells: 1 },
        { kind: 'fill' },
        { kind: 'fixed', cells: 1 },
        {
          kind: 'fixed',
          cells: composerRows(
            state.composer.input.document,
            context.terminalSize.columns,
            context.terminalSize.rows
          )
        },
        { kind: 'fixed', cells: 1 }
      ],
      columns: [{ kind: 'fill' }]
    }
  );
  if (state.run.kind === 'waiting_for_approval') {
    return overlay([workspace, approvalDialog(state, context)], { id: 'coding-agent-overlay' });
  }
  const modal = overlayView(state, context, helpText);
  return modal === undefined
    ? overlay([workspace], { id: 'coding-agent-overlay' })
    : overlay([workspace, modal], { id: 'coding-agent-overlay' });
}

function composerView(state: CodingAgentTuiState): Element<CodingAgentTuiMessage> {
  const placeholder =
    state.setup.status === 'setup_required'
      ? 'Send a message or open commands to finish setup'
      : state.run.kind === 'working'
        ? 'Queue a follow-up'
        : 'Send a message';
  return textArea({
    id: 'composer',
    meta: { accessibleName: 'Message composer' },
    state: state.composer.input,
    placeholder,
    wrap: true,
    scrollbar: { axis: 'vertical', visible: 'auto' },
    onTransition: (
      transition: Extract<CodingAgentTuiMessage, { type: 'composer.edit' }>['transition']
    ): CodingAgentTuiMessage => ({ type: 'composer.edit', transition })
  });
}

function conversationView(state: CodingAgentTuiState, context: TuiContext): Element<CodingAgentTuiMessage> {
  const layout = conversationLayout(state, context);
  if (layout.collection.itemCount === 0) {
    return viewport(
      text({ content: 'Start with a message.', id: 'conversation-empty', textRole: 'caption' }),
      {
        id: 'conversation',
        offset: { row: 0 },
        onScroll: (request): CodingAgentTuiMessage => ({ type: 'conversation.scrolled', request })
      }
    );
  }
  const window = measuredWindow(layout.collection, {
    viewportRows: layout.geometry.viewportRows,
    offsetRow: layout.scroll.offsetRow
  });
  return measuredViewport(
    window,
    (entry) => conversationEntryView(entry.item.value, state, layout.geometry.viewportColumns),
    {
      id: 'conversation',
      scrollbar: { axis: 'vertical', visible: 'always' },
      onScroll: (request): CodingAgentTuiMessage => ({ type: 'conversation.scrolled', request })
    }
  );
}

function conversationEntryView(
  entry: CodingAgentTuiConversationEntry,
  state: CodingAgentTuiState,
  width: number
): Element<CodingAgentTuiMessage> {
  if (entry.kind === 'activity' && entry.details !== undefined) {
    return disclosure({
      id: entry.id,
      label: activityLabel(entry),
      ...(entry.summary === undefined ? {} : { summary: body(entry.summary) }),
      expanded: state.conversation.expandedIds.includes(entry.id),
      slots: {
        content: richText({
          id: `${entry.id}:details`,
          segments: body(entry.details),
          wrap: { preserveWords: true }
        })
      },
      onTransition: (): CodingAgentTuiMessage => ({ type: 'activity.toggle', id: entry.id })
    });
  }
  return richText({
    id: entry.id,
    segments: conversationSegments(entry, state, width),
    wrap: { preserveWords: true }
  });
}

function overlayView(
  state: CodingAgentTuiState,
  context: TuiContext,
  helpText: string
): Element<CodingAgentTuiMessage> | undefined {
  const width = Math.max(5, Math.min(84, context.terminalSize.columns - 4));
  const height = Math.max(4, Math.min(20, context.terminalSize.rows - 4));
  switch (state.overlay.kind) {
    case 'notes':
      return notesView(state.overlay.state, width, height, (message) => message);
    case 'none':
      return undefined;
    case 'panel_loading':
    case 'panel':
    case 'source':
    case 'queue_edit':
    case 'branch_review':
      return panelView(state.overlay, width, height);
    case 'files_loading':
      return dialog({
        ...modalOptions('file-loading', 'Workspace paths', 'file-loading-text', width, 5),
        slots: { content: text({ id: 'file-loading-text', content: 'Reading directory…' }) }
      });
    case 'files':
      return dialog({
        ...modalOptions('files-dialog', 'Insert workspace path', 'file-picker', width, height),
        slots: {
          content: searchPicker({
            id: 'file-picker',
            title: 'Workspace paths',
            view: searchPickerView(state.overlay.picker),
            searchPickerIndex: fileIndex(state.overlay.paths),
            maxVisible: Math.max(3, height - 5),
            helpText: 'Enter insert · Esc close',
            onTransition: (transition): CodingAgentTuiMessage => ({ type: 'files.transition', transition }),
            onAccept: (event): CodingAgentTuiMessage => ({ type: 'files.accept', event })
          })
        }
      });
    case 'commands':
      return dialog({
        ...modalOptions('commands-dialog', 'Commands', 'command-picker', width, height),
        slots: {
          content: searchPicker<string, CodingAgentTuiMessage, CodingAgentTuiMessage>({
            id: 'command-picker',
            title: 'Commands',
            view: searchPickerView(state.overlay.picker),
            searchPickerIndex: COMMAND_INDEX,
            maxVisible: Math.max(3, height - 5),
            helpText: 'Enter choose · Esc close',
            onTransition: (transition): CodingAgentTuiMessage => ({
              type: 'commands.transition',
              transition
            }),
            onAccept: (event): CodingAgentTuiMessage => ({ type: 'commands.accept', event })
          })
        }
      });
    case 'command_values': {
      const commandOverlay = state.overlay;
      const commandEntry = INTERACTIVE_COMMANDS.find(
        (candidate) => candidate.name === commandOverlay.command
      );
      const index: SearchPickerIndex =
        commandEntry === undefined ? createSearchPickerIndex([]) : commandValueIndex(commandEntry);
      return dialog({
        ...modalOptions(
          'command-value-dialog',
          commandEntry?.name ?? 'Command value',
          'command-value-picker',
          width,
          height
        ),
        slots: {
          content: searchPicker<string, CodingAgentTuiMessage, CodingAgentTuiMessage>({
            id: 'command-value-picker',
            title: commandEntry?.description ?? 'Choose a value',
            view: searchPickerView(commandOverlay.picker),
            searchPickerIndex: index,
            maxVisible: Math.max(3, height - 5),
            helpText: 'Enter choose · Esc close',
            onTransition: (transition): CodingAgentTuiMessage => ({
              type: 'command-values.transition',
              transition
            }),
            onAccept: (event): CodingAgentTuiMessage => ({ type: 'command-values.accept', event })
          })
        }
      });
    }
    case 'search':
      return dialog({
        ...modalOptions('search-dialog', 'Find', 'conversation-search', width, height),
        slots: {
          content: searchPicker<string, CodingAgentTuiMessage, CodingAgentTuiMessage>({
            id: 'conversation-search',
            title:
              state.overlay.loading !== undefined
                ? 'Searching stored history…'
                : state.overlay.result?.older !== undefined
                  ? 'Find · more history remains'
                  : 'Find in stored history',
            view: searchPickerView(state.overlay.picker),
            searchPickerIndex: historySearchIndex(state.overlay),
            maxVisible: Math.max(3, height - 5),
            emptyText:
              state.overlay.error ??
              (state.overlay.loading !== undefined
                ? 'Searching…'
                : state.overlay.result === undefined
                  ? 'Type exact text to search this branch'
                  : 'No matches in remaining history'),
            helpText: 'Enter jump · F3 next matches · Esc close',
            onTransition: (transition): CodingAgentTuiMessage => ({
              type: 'search.transition',
              transition
            }),
            onAccept: (event): CodingAgentTuiMessage => ({ type: 'search.accept', event })
          })
        }
      });
    case 'help':
      return dialog({
        ...modalOptions('help-dialog', 'Keyboard shortcuts', 'help-content', width, Math.min(13, height)),
        slots: {
          content: richText({
            id: 'help-content',
            segments: body(helpText),
            wrap: true
          })
        }
      });
    case 'debug':
      return dialog({
        ...modalOptions('debug-dialog', 'Runtime details', 'debug-content', width, height),
        slots: {
          content: modalViewport(
            richText({ id: 'debug-details', segments: body(state.overlay.text), wrap: true }),
            state,
            'debug-content'
          )
        }
      });
  }
}

function approvalDialog(state: CodingAgentTuiState, context: TuiContext): Element<CodingAgentTuiMessage> {
  if (state.run.kind !== 'waiting_for_approval') return text({ content: '' });
  const suspension = state.run.suspension;
  const approval = suspension.pendingApprovals[0];
  const width = Math.max(5, Math.min(88, context.terminalSize.columns - 4));
  const bodyElement =
    approval === undefined
      ? richText({
          id: 'approval-missing',
          segments: errorText('The runtime suspended without an approval request.'),
          wrap: true
        })
      : approvalContent(approval, suspension.pendingApprovals.length, state);
  return dialog({
    id: 'approval-dialog',
    title: 'Approval required',
    modal: true,
    focusPolicy: { initialFocus: { kind: 'element', elementId: 'approval-deny' }, returnFocus: 'restore' },
    dismissal: { dismissOnEscape: true, dismissOnOutsidePress: false },
    onDismiss: (): CodingAgentTuiMessage => ({ type: 'approval.decide', decision: 'deny' }),
    slots: {
      content: modalViewport(bodyElement, state, 'approval-content-scroll'),
      actions: row(
        [
          button({
            id: 'approval-deny',
            label: 'Deny',
            tone: 'destructive',
            onPress: (): CodingAgentTuiMessage => ({ type: 'approval.decide', decision: 'deny' })
          }),
          button({
            id: 'approval-allow',
            label: 'Allow once',
            tone: 'primary',
            onPress: (): CodingAgentTuiMessage => ({ type: 'approval.decide', decision: 'allow' })
          })
        ],
        { id: 'approval-actions', gap: 2 }
      )
    },
    width,
    height: Math.max(4, Math.min(18, context.terminalSize.rows - 4)),
    padding: 1
  });
}

function modalViewport(
  child: Element<CodingAgentTuiMessage>,
  state: CodingAgentTuiState,
  id: string
): Element<CodingAgentTuiMessage> {
  return viewport(child, {
    id,
    offset: { row: state.modalOffsetRow },
    scrollbar: { axis: 'vertical', visible: 'auto' },
    onScroll: (event): CodingAgentTuiMessage => ({
      type: 'modal.scrolled',
      offsetRow: event.nextState.offsetRow
    })
  });
}

function approvalContent(
  approval: AgentApprovalRequest,
  pendingCount: number,
  state: CodingAgentTuiState
): Element<CodingAgentTuiMessage> {
  const summary = [
    `${approval.toolName} · 1 of ${String(pendingCount)}`,
    approvalSubject(approval),
    approval.reason,
    effectSummary(approval)
  ]
    .filter((line) => line.length > 0)
    .join('\n');
  const details = JSON.stringify({ input: approval.input, effects: approval.effects }, null, 2);
  return column(
    [
      richText({ id: 'approval-summary', segments: body(summary), wrap: true }),
      disclosure({
        id: 'approval-details',
        label: 'Exact input and effects',
        expanded: state.conversation.expandedIds.includes('approval-details'),
        slots: {
          content: richText({ id: 'approval-raw', segments: body(details), wrap: true })
        },
        onTransition: (): CodingAgentTuiMessage => ({ type: 'activity.toggle', id: 'approval-details' })
      })
    ],
    { id: 'approval-content', gap: 1 }
  );
}

function approvalEffect(
  suspension: AgentApprovalSuspension,
  decision: 'allow' | 'deny',
  handler: CodingAgentTuiAppOptions['approvalHandler']
) {
  return {
    id: `approval:${suspension.runId}:${suspension.pendingApprovals[0]?.approvalId ?? 'missing'}`,
    concurrency: 'keep-first' as const,
    async run() {
      if (handler === undefined) throw new Error('No approval handler is attached.');
      await handler(suspension, decision);
      return { kind: 'none' as const };
    },
    onError: ({ diagnostic }: { readonly diagnostic: { readonly message: string } }) => ({
      kind: 'message' as const,
      message: { type: 'command.failed' as const, message: diagnostic.message }
    })
  };
}

interface ConversationLayout {
  readonly collection: MeasuredCollection<CodingAgentTuiConversationEntry>;
  readonly scroll: CodingAgentTuiState['conversation']['scroll'];
  readonly geometry: ScrollGeometry;
}

function conversationLayout(state: CodingAgentTuiState, context: TuiContext): ConversationLayout {
  // Reserve the visible vertical scrollbar so content width stays stable while streaming.
  const width = Math.max(1, context.terminalSize.columns - 1);
  const viewportRows = Math.max(
    0,
    context.terminalSize.rows -
      3 -
      composerRows(state.composer.input.document, context.terminalSize.columns, context.terminalSize.rows)
  );
  const collection = state.presentation.measure(
    state.conversation.items,
    state.conversation.expandedIds,
    `${String(width)}:${JSON.stringify(context.capabilities.unicode.widthProfile)}`,
    (entry) => conversationEntryRows(entry, state, width, context)
  );
  const geometry: ScrollGeometry = {
    contentRows: collection.totalRows,
    contentColumns: width,
    viewportRows,
    viewportColumns: width
  };
  const anchored =
    state.conversation.anchor === undefined
      ? state.conversation.scroll
      : {
          ...state.conversation.scroll,
          offsetRow: measuredWindow(collection, { viewportRows, anchor: state.conversation.anchor }).offsetRow
        };
  const scroll = normalizeScrollState(anchored, geometry);
  return { collection, scroll, geometry };
}

function conversationEntryRows(
  entry: CodingAgentTuiConversationEntry,
  state: CodingAgentTuiState,
  width: number,
  context: TuiContext
): number {
  if (entry.kind === 'activity' && entry.details !== undefined) {
    if (!state.conversation.expandedIds.includes(entry.id)) return 1;
    return 1 + wrappedRows(entry.details, width, context);
  }
  const content = conversationSegments(entry, state, width)
    .map((part) => (part.kind === 'text' ? part.text : part.unicode))
    .join('');
  return wrappedRows(content, width, context);
}

function wrappedRows(value: string, width: number, context: TuiContext): number {
  return Math.max(
    1,
    wrapTextCells(value, width, {
      widthProfile: context.capabilities.unicode.widthProfile,
      preserveWords: true
    }).length
  );
}

function conversationSegments(
  entry: CodingAgentTuiConversationEntry,
  state: CodingAgentTuiState,
  width: number
): InlineContent {
  switch (entry.kind) {
    case 'user':
      return [{ kind: 'text', text: 'You\n', style: { bold: true } }, ...body(`${entry.text}\n`)];
    case 'assistant':
      return [
        { kind: 'text', text: 'Assistant\n', style: { bold: true } },
        ...state.presentation.markdown(entry.id, entry.text.length === 0 ? '…' : entry.text).render(width)
          .segments
      ];
    case 'reasoning':
      return [
        { kind: 'text', text: 'Reasoning summary\n', style: { bold: true, dim: true } },
        { kind: 'text', text: `${entry.text}\n`, style: { dim: true } }
      ];
    case 'notice':
      return [
        {
          kind: 'text',
          text: `${entry.text}\n`,
          style: entry.tone === 'error' ? { bold: true } : { dim: true }
        }
      ];
    case 'activity':
      return [
        activitySymbol(entry.status),
        {
          kind: 'text',
          text: ` ${entry.label}${entry.summary === undefined ? '' : ` — ${entry.summary}`}`,
          ...(entry.status === 'running' ? { style: { dim: true } } : {})
        }
      ];
  }
}

function activityLabel(entry: CodingAgentTuiActivityEntry): string {
  return `${activityGlyph(entry.status)} ${entry.label}`;
}

function activityGlyph(status: CodingAgentTuiActivityEntry['status']): string {
  switch (status) {
    case 'running':
      return '•';
    case 'success':
      return '✓';
    case 'warning':
      return '!';
    case 'failed':
      return '✗';
  }
}

function activitySymbol(status: CodingAgentTuiActivityEntry['status']): InlineContent[number] {
  return {
    kind: 'symbol',
    unicode: activityGlyph(status),
    ascii: status === 'success' ? '+' : status === 'failed' ? 'x' : status === 'warning' ? '!' : '*',
    accessibleText: status
  };
}

function modalOptions(id: string, title: string, focusId: string, width: number, height: number) {
  return {
    id,
    title,
    modal: true as const,
    focusPolicy: {
      initialFocus: { kind: 'element' as const, elementId: focusId },
      returnFocus: 'restore' as const
    },
    dismissal: {
      dismissOnEscape: true as const,
      dismissOnOutsidePress: false as const
    },
    onDismiss: (): CodingAgentTuiMessage => ({ type: 'overlay.close' }),
    width,
    height,
    padding: 1
  };
}

function binding(
  id: string,
  key: Extract<InputTrigger, { readonly kind: 'key' }>['key'],
  modifiers: NonNullable<Extract<InputTrigger, { readonly kind: 'key' }>['modifiers']>,
  message: CodingAgentTuiMessage,
  enabled: (context: TuiInputBindingContext<CodingAgentTuiState>) => boolean
) {
  return {
    id,
    label: id.replaceAll('-', ' '),
    triggers: [{ kind: 'key' as const, key, modifiers }],
    phase: 'beforeFocus' as const,
    message,
    enabled
  };
}

function composerBindingEnabled({ state, focusPath }: TuiInputBindingContext<CodingAgentTuiState>): boolean {
  return (
    state.overlay.kind === 'none' &&
    state.run.kind !== 'waiting_for_approval' &&
    focusPath?.includes('composer') === true
  );
}

function composerHistoryPreviousEnabled(context: TuiInputBindingContext<CodingAgentTuiState>): boolean {
  if (!composerBindingEnabled(context) || context.state.composer.history.length === 0) return false;
  if (context.state.composer.historyIndex !== null) return true;
  const input = context.state.composer.input;
  return !textDocumentText(input.document).slice(0, input.caret.position.offset).includes('\n');
}

function composerHistoryNextEnabled(context: TuiInputBindingContext<CodingAgentTuiState>): boolean {
  if (!composerBindingEnabled(context) || context.state.composer.historyIndex === null) return false;
  const input = context.state.composer.input;
  return !textDocumentText(input.document).slice(input.caret.position.offset).includes('\n');
}

function composerNewlineMessage(): CodingAgentTuiMessage {
  return {
    type: 'composer.edit',
    transition: { kind: 'edit', operation: { kind: 'insert', text: '\n' } }
  };
}

function canOpenOverlay(state: CodingAgentTuiState): boolean {
  return state.overlay.kind === 'none' && state.run.kind !== 'waiting_for_approval';
}

function canScroll(state: CodingAgentTuiState): boolean {
  return state.overlay.kind === 'none' && state.run.kind !== 'waiting_for_approval';
}

function body(value: string): InlineContent {
  return [{ kind: 'text', text: value }];
}

function errorText(value: string): InlineContent {
  return [{ kind: 'text', text: value, style: { bold: true } }];
}

function effectSummary(approval: AgentApprovalRequest): string {
  const accesses = approval.effects.accesses;
  if (accesses.length === 0) return 'tool run';
  const summary = accesses
    .map((access) => `${access.mode.replaceAll('_', ' ')} · ${access.scope}`)
    .join(', ');
  const execution = sandboxExecutionSummary(approval.input);
  return execution ? `${summary}. ${execution}` : summary;
}

function sandboxExecutionSummary(input: AgentApprovalRequest['input']): string | undefined {
  if (!jsonObject(input)) return undefined;
  const execution = input.execution;
  if (!jsonObject(execution)) return undefined;
  const policyDigest = typeof execution.policyDigest === 'string' ? execution.policyDigest : undefined;
  const executionDigest =
    typeof execution.executionDigest === 'string' ? execution.executionDigest : undefined;
  if (!policyDigest || !executionDigest) return undefined;
  return `Sandboxed command; network denied; host escape denied; policy ${policyDigest}; execution ${executionDigest}.`;
}

function jsonObject(value: unknown): value is import('@agent-core/json').JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function approvalSubject(approval: AgentApprovalRequest): string {
  if (typeof approval.input !== 'object' || approval.input === null || Array.isArray(approval.input))
    return '';
  const input = approval.input as import('@agent-core/json').JsonObject;
  const candidates = [
    ['Command', input.command],
    ['Path', input.path],
    ['Query', input.query],
    ['Pattern', input.pattern]
  ] as const;
  for (const [label, value] of candidates) {
    if (typeof value === 'string' && value.trim().length > 0) {
      const compact = value.trim().replaceAll(/\s+/g, ' ');
      return `${label}: ${compact.length <= 180 ? compact : `${compact.slice(0, 179)}…`}`;
    }
  }
  return '';
}

function debugText(state: CodingAgentTuiState, runtimeState?: string): string {
  return JSON.stringify(
    {
      runtimeDetails: state.runtimeDetails,
      eventState: state.debug,
      ...(runtimeState === undefined ? {} : { runtimeState: parseDebugRuntimeState(runtimeState) })
    },
    null,
    2
  );
}

function parseDebugRuntimeState(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return value;
  }
}

function fileIndex(paths: readonly string[]): SearchPickerIndex {
  return createSearchPickerIndex(paths.map((path) => ({ id: path, label: path, value: path })));
}

function livePresentation(previous: CodingAgentTuiState, next: CodingAgentTuiState): CodingAgentTuiState {
  return previous.conversation.scroll.followTail || previous.conversation.pages.length === 0
    ? next
    : { ...next, conversation: { ...previous.conversation, unread: true } };
}

function copyInput(state: CodingAgentTuiState) {
  const overlay = state.overlay;
  return overlay.kind === 'source' || overlay.kind === 'queue_edit'
    ? overlay.input
    : overlay.kind === 'notes'
      ? overlay.state.source?.input
      : overlay.kind === 'none'
        ? state.composer.input
        : undefined;
}

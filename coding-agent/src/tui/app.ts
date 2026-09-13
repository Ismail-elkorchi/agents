import type { AgentApprovalRequest, AgentApprovalSuspension } from '@agent-core/runtime';
import type { ConversationActivityEntry, ConversationEntry } from '@agent-core/tui';
import {
  acceptResource,
  activityDetails,
  appendRecalledDrafts,
  attachmentsView,
  commandSuggestions,
  completeCommand,
  completeResource,
  composerControls,
  composerRows,
  configurationState,
  configurationView,
  conversationFrame,
  copySource,
  createAttachments,
  createDraft,
  createPromptRecall,
  createQueue,
  createSessionName,
  createSourceInspector,
  diagnosticMessage,
  draftFromSubmission,
  insertCommand,
  inspectedSource,
  loadDraft,
  loadRecoveredPrompts,
  loadSessionName,
  moveCommand,
  notesView,
  observeAttention,
  panel,
  preferencesView,
  promptRecallView,
  promptsFromHistory,
  queueView,
  readSourceEntry,
  recoverDraft,
  rememberPrompt,
  resourceCompletionRows,
  resourceSuggestions,
  sameDraft,
  savePreferences,
  searchResources,
  selectedSource,
  sessionNameView,
  shortcutBindings,
  shortcutHelp,
  sourceInspectorView,
  transitionCommandPicker,
  updateAttachments,
  updateConfiguration,
  updateNotes,
  updatePreferences,
  updatePromptRecall,
  updateQueue,
  updateResourceCompletion,
  updateSessionName,
  updateSourceInspector,
  type ComposerDraft,
  type ConfigurationOperations
} from '@agent-core/tui';
import { editTextExternally } from '@agent-core/tui/node';
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
  richText,
  searchPicker,
  text,
  textArea
} from '@ismail-elkorchi/terminal-ui/components';
import type { InputTrigger } from '@ismail-elkorchi/terminal-ui/input';
import type { ScrollGeometry } from '@ismail-elkorchi/terminal-ui/interaction';
import { formatKeyboardBinding } from '@ismail-elkorchi/terminal-ui/interaction';
import { column, measuredViewport, overlay, row, viewport } from '@ismail-elkorchi/terminal-ui/layout';
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
import { codingStatusFields, hintBar, statusChrome } from './chrome.js';
import { commandEffect } from './command-effects.js';
import type { CodingAgentTuiCommandHandler } from './command-surface.js';
import {
  COMMAND_INDEX,
  applyCommandExecution,
  applyCommandFailure,
  composerWithDraft,
  editComposer,
  navigateComposerHistory,
  setComposerText,
  submitComposer
} from './command-surface.js';
import { appendNotice, toggleActivity, upsertConversationEntry } from './conversation.js';
import {
  applyConfiguredChecks,
  applyFailure,
  applyProgress,
  applyResult,
  applySessionState
} from './event-reducer.js';
import { failHistory, loadHistory, receiveHistory, type CodingHistoryReader } from './history.js';
import { hydrateCodingAgentTuiState } from './hydration.js';
import { CODING_SHORTCUTS, INTERACTIVE_COMMANDS } from './interactive-commands.js';
import type { CodingAgentTuiMessage } from './messages.js';
import { openPanel, panelView, updatePanel, type CodingNavigationOperations } from './panels.js';
import { createProcessPanel, processesView, updateProcesses } from './processes.js';
import { recoveryDialog, recoveryEffect, type RecoveryHandler } from './recovery.js';
import {
  historySearchIndex,
  jumpToAdjacentMatch,
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
  readonly inspectContext?: () => Promise<unknown>;
  readonly processes?: import('../execution/process-controls.js').CodingProcessOperations;
  readonly historyEntryReader?: import('@agent-core/tui').HistoryEntryReader;
  readonly sessionNames?: import('@agent-core/tui').SessionNames;
  readonly exportConversation?: (
    pages: readonly import('@agent-core/runtime').SessionBranchPage[],
    signal: AbortSignal
  ) => Promise<string>;
  readonly drafts?: import('@agent-core/tui').DraftStorage;
  readonly notify?: (signal: AbortSignal) => Promise<void>;
  readonly configuration?: ConfigurationOperations & {
    current(): import('@agent-core/model').ModelSelection | undefined;
  };
  readonly recoveryHandler?: RecoveryHandler;
  readonly navigation?: CodingNavigationOperations;
  readonly historyReader?: CodingHistoryReader;
  readonly historySearcher?: HistorySearcher;
  readonly externalEditor?: (text: string, signal: AbortSignal) => Promise<string>;
  readonly attachments?: import('@agent-core/tui').AttachmentOperations;
  readonly resources?: import('@agent-core/tui').ResourceSearch;
  readonly presentation?: import('@agent-core/tui').PresentationOptions;
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

export function createCodingAgentTuiApp(initialDraft: string, options: CodingAgentTuiAppOptions = {}) {
  const eventSource = options.eventSource;
  const app: import('@ismail-elkorchi/terminal-ui/tui').TuiApp<CodingAgentTuiState, CodingAgentTuiMessage> =
    defineTui<CodingAgentTuiState, CodingAgentTuiMessage>({
      id: 'coding-agent',
      onExit: async (state) => {
        if (options.drafts === undefined) return;
        const drafts = new Map<string, ComposerDraft>();
        for (const [sessionId, view] of Object.entries(state.sessionViews))
          drafts.set(sessionId, view.composer);
        drafts.set(state.debug.sessionId ?? ':new', state.composer);
        for (const [sessionId, draft] of drafts) await options.drafts.write(sessionId, draft);
      },

      init: () => {
        const state = initialState(initialDraft, options);
        const sessionId = state.debug.sessionId ?? ':new';
        return {
          state: { ...state, draftRestoreSession: sessionId },
          focus: { kind: 'element', elementId: 'composer' },
          ...(options.drafts === undefined || initialDraft.length > 0
            ? {}
            : { effects: [loadDraft(options.drafts, sessionId, state.composer)] })
        };
      },
      update: (state, message, context) => {
        const result = withAttention(
          updateCodingAgentTui(state, message, context, options),
          message,
          options
        );
        if (
          message.type === 'result' &&
          options.historyReader !== undefined &&
          result.state.conversation.scroll.followTail
        ) {
          const history = loadHistory(result.state, 'tail', options.historyReader);
          return {
            ...result,
            ...history,
            effects: [...(result.effects ?? []), ...(history.effects ?? [])]
          };
        }
        return context.terminalSize.rows < 12
          ? { ...result, state: { ...result.state, completion: undefined, resourceCompletion: undefined } }
          : result;
      },
      inputBindings: shortcutBindings<CodingAgentTuiState, CodingAgentTuiMessage>(
        [
          ...[true, false].map((focused) => ({
            id: `terminal-focus:${String(focused)}`,
            triggers: [{ kind: 'focus' as const, focused }],
            phase: 'beforeFocus' as const,
            message: { type: 'terminal.focus' as const, focused }
          })),
          ...[
            { key: 'arrowDown' as const, message: { type: 'resource.move' as const, delta: 1 } },
            { key: 'arrowUp' as const, message: { type: 'resource.move' as const, delta: -1 } },
            { key: 'enter' as const, message: { type: 'resource.accept' as const } },
            { key: 'tab' as const, message: { type: 'resource.accept' as const } },
            { key: 'escape' as const, message: { type: 'resource.close' as const } },
            { key: 'c' as const, modifiers: { ctrl: true }, message: { type: 'resource.close' as const } }
          ].map(({ key, message, modifiers }) =>
            binding(
              `resource-${key}`,
              key,
              modifiers ?? {},
              message,
              ({ state }) => state.overlay.kind === 'none' && state.resourceCompletion !== undefined
            )
          ),
          ...[
            { key: 'arrowDown' as const, message: { type: 'completion.move' as const, delta: 1 } },
            { key: 'arrowUp' as const, message: { type: 'completion.move' as const, delta: -1 } },
            { key: 'enter' as const, message: { type: 'completion.accept' as const, open: true } },
            { key: 'tab' as const, message: { type: 'completion.accept' as const, open: false } },
            { key: 'escape' as const, message: { type: 'completion.close' as const } }
          ].map(({ key, message }) =>
            binding(
              `completion-${key}`,
              key,
              {},
              message,
              ({ state }) => state.overlay.kind === 'none' && state.completion !== undefined
            )
          ),
          binding(
            'completion-cancel',
            'c',
            { ctrl: true },
            { type: 'completion.close' },
            ({ state }) =>
              state.overlay.kind === 'none' &&
              state.completion !== undefined &&
              selectedSource(copyInput(state)) === undefined
          ),
          binding(
            'copy-selected-source',
            'c',
            { ctrl: true },
            { type: 'source.copy' },
            ({ state }) => selectedSource(copyInput(state)) !== undefined
          ),
          binding(
            'close-popup',
            'c',
            { ctrl: true },
            { type: 'overlay.close' },
            ({ state }) => state.overlay.kind !== 'none'
          ),
          binding(
            'close-commands',
            'p',
            { ctrl: true },
            { type: 'overlay.close' },
            ({ state }) => state.overlay.kind === 'commands'
          ),
          binding(
            'close-notes',
            'n',
            { alt: true },
            { type: 'overlay.close' },
            ({ state }) => state.overlay.kind === 'notes'
          ),
          binding('Model notes', 'n', { alt: true }, { type: 'notes.open' }, ({ state }) =>
            canOpenOverlay(state)
          ),
          binding(
            'commands',
            'p',
            { ctrl: true },
            { type: 'overlay.open', overlay: 'commands' },
            ({ state }) => canOpenOverlay(state)
          ),
          binding('tool-output', 'o', { ctrl: true }, { type: 'tools.toggle' }, ({ state }) =>
            canOpenOverlay(state)
          ),
          binding('reasoning', 't', { ctrl: true }, { type: 'reasoning.toggle' }, ({ state }) =>
            canOpenOverlay(state)
          ),
          binding(
            'exit',
            'd',
            { ctrl: true },
            { type: 'application.exit' },
            ({ state }) =>
              canOpenOverlay(state) && textDocumentText(state.composer.input.document).length === 0
          ),
          binding(
            'interrupt',
            'escape',
            {},
            { type: 'work.interrupt' },
            ({ state }) => canOpenOverlay(state) && state.run.kind === 'working'
          ),
          ...(
            [
              { key: 'f2', panel: 'sessions' },
              { key: 'f5', panel: 'branches' },

              { key: 'f7', panel: 'changes' }
            ] as const
          ).map(({ key, panel }) =>
            binding(panel, key, {}, { type: 'panel.open', panel }, ({ state }) => canOpenOverlay(state))
          ),
          binding('search', 'f', { ctrl: true }, { type: 'overlay.open', overlay: 'search' }, ({ state }) =>
            canOpenOverlay(state)
          ),
          ...(['previous', 'next'] as const).map((direction) =>
            binding(
              `${direction}-message`,
              direction === 'previous' ? 'pageUp' : 'pageDown',
              { alt: true },
              { type: 'conversation.message', direction },
              ({ state }) => canOpenOverlay(state)
            )
          ),
          ...(['previous', 'next'] as const).map((direction) =>
            binding(
              `${direction}-match`,
              'f3',
              direction === 'previous' ? { shift: true } : {},
              { type: 'search.adjacent', direction },
              ({ state }) => canOpenOverlay(state) && state.historyMatch !== undefined
            )
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
            's',
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
          binding(
            'external-editor',
            'f4',
            {},
            { type: 'composer.external-editor' },
            composerBindingEnabled
          ),
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
            ({ state }) =>
              state.run.kind === 'waiting_for_recovery' ||
              (canOpenOverlay(state) && state.composer.input.selection === undefined)
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
            'composer-newline-alt-enter',
            'enter',
            { alt: true },
            composerNewlineMessage(),
            composerBindingEnabled
          )
        ],
        {
          actions: CODING_SHORTCUTS,
          overrides: (state) => state.preferences.shortcuts,
          capturing: (state) => (state.overlay.kind === 'preferences' ? state.overlay.capture : undefined),
          captured: (action, shortcut) => ({ type: 'preferences.captured', action, shortcut }),
          cancelled: () => ({ type: 'preferences.capture-cancel' }),
          failed: (message) => ({ type: 'preferences.capture-failed', message })
        }
      ),
      ...(eventSource === undefined
        ? {}
        : { subscriptions: (): readonly TuiEventSource<CodingAgentTuiMessage>[] => [eventSource] }),
      resizeMessage: (): CodingAgentTuiMessage => ({ type: 'terminal.resized' }),
      view: (state, context) => {
        const hints = shortcutHelp(tuiBindingHelp(app), state.preferences.shortcuts, CODING_SHORTCUTS).map(
          (item) => ({
            label: item.label,
            keys: item.bindings.map((binding) => formatKeyboardBinding(binding.binding)).join(' / ')
          })
        );
        return agentTuiView(
          state,
          context,
          hints.map((item) => `${item.keys}  ${item.label}`).join('\n'),
          hints,
          options.configuration
        );
      }
    });
  return app;
}

function initialState(initialDraft: string, options: CodingAgentTuiAppOptions): CodingAgentTuiState {
  const initial = createInitialCodingAgentTuiState(
    options.runtimeDetails,
    options.setup,
    options.presentation?.preferences
  );
  const hydrated =
    options.initialHydration === undefined
      ? initial
      : hydrateCodingAgentTuiState(initial, options.initialHydration);
  return initialDraft.length === 0 ? hydrated : setComposerText(hydrated, initialDraft);
}

function updateCodingAgentTui(
  state: CodingAgentTuiState,
  message: CodingAgentTuiMessage,
  context: TuiContext,
  options: CodingAgentTuiAppOptions
): TuiUpdateResult<CodingAgentTuiState, CodingAgentTuiMessage> {
  switch (message.type) {
    case 'context.open': {
      const requestId = crypto.randomUUID();
      return {
        state: { ...state, overlay: { kind: 'context-loading', requestId } },
        effects: [
          {
            id: 'context-inspection',
            concurrency: 'replace',
            async run({ signal }) {
              if (options.inspectContext === undefined)
                throw new Error('Context inspection is unavailable.');
              const inspected = await options.inspectContext();
              signal.throwIfAborted();
              return {
                kind: 'message',
                message: {
                  type: 'context.loaded',
                  requestId,
                  sessionId: state.debug.sessionId ?? ':new',
                  content: JSON.stringify(
                    {
                      context: inspected,
                      unsentDraft: {
                        attachments: state.composer.attachments,
                        instructions: state.composer.instructions
                      },
                      latestAdmittedRequest: state.progress.request
                    },
                    null,
                    2
                  )
                }
              };
            },
            onError: ({ diagnostic }) => ({
              kind: 'message',
              message: { type: 'context.failed', requestId, message: diagnostic.message }
            })
          }
        ]
      };
    }
    case 'context.loaded':
      return state.overlay.kind !== 'context-loading' ||
        state.overlay.requestId !== message.requestId ||
        message.sessionId !== (state.debug.sessionId ?? ':new')
        ? { state }
        : updatePanel(
            state,
            {
              type: 'panel.source-loaded',
              title: 'Available context and admitted sources',
              content: message.content
            },
            options.navigation
          );
    case 'context.failed':
      return state.overlay.kind !== 'context-loading' || state.overlay.requestId !== message.requestId
        ? { state }
        : { state: appendNotice({ ...state, overlay: { kind: 'none' } }, message.message, 'error') };
    case 'processes.open':
    case 'processes.refresh':
    case 'processes.back':
    case 'processes.transition':
    case 'processes.select':
    case 'processes.edit':
    case 'processes.action':
    case 'processes.listed':
    case 'processes.observed':
    case 'processes.failed': {
      if (options.processes === undefined)
        return { state: appendNotice(state, 'Process controls are unavailable.') };
      const processes =
        message.type === 'processes.open'
          ? createProcessPanel()
          : state.overlay.kind === 'processes'
            ? state.overlay.state
            : undefined;
      if (processes === undefined)
        return {
          state:
            message.type === 'processes.failed' && !['list', 'inspect'].includes(message.operation)
              ? appendNotice(state, message.message, 'error')
              : state
        };
      const result = updateProcesses(processes, message, options.processes);
      return { ...result, state: { ...state, overlay: { kind: 'processes', state: result.state } } };
    }
    case 'session-name.open': {
      const sessionId = state.debug.sessionId;
      if (sessionId === undefined || options.sessionNames === undefined)
        return { state: appendNotice(state, 'Start a conversation before naming it.') };
      const name = createSessionName(sessionId);
      return {
        state: { ...state, overlay: { kind: 'session-name', state: name } },
        effects: [loadSessionName(name, options.sessionNames)]
      };
    }
    case 'session-name.saved':
      return {
        state:
          state.overlay.kind === 'session-name' && state.overlay.state.id === message.id
            ? { ...state, overlay: { kind: 'none' } }
            : state
      };
    case 'session-name.loaded':
    case 'session-name.edit':
    case 'session-name.save': {
      if (state.overlay.kind !== 'session-name' || options.sessionNames === undefined) return { state };
      const result = updateSessionName(state.overlay.state, message, options.sessionNames);
      return { ...result, state: { ...state, overlay: { kind: 'session-name', state: result.state } } };
    }

    case 'session-name.failed': {
      if (state.overlay.kind !== 'session-name' || state.overlay.state.id !== message.id)
        return {
          state: message.operation === 'write' ? appendNotice(state, message.error, 'error') : state
        };
      if (options.sessionNames === undefined) return { state };
      const result = updateSessionName(state.overlay.state, message, options.sessionNames);
      return { ...result, state: { ...state, overlay: { kind: 'session-name', state: result.state } } };
    }
    case 'queue.failed': {
      if (state.overlay.kind !== 'queue' || state.overlay.state.id !== message.id)
        return {
          state: message.operation === 'change' ? appendNotice(state, message.error, 'error') : state
        };
      if (options.navigation === undefined) return { state };
      const result = updateQueue(state.overlay.state, message, options.navigation);
      return { ...result, state: { ...state, overlay: { kind: 'queue', state: result.state } } };
    }
    case 'resource.accept': {
      const completion = state.resourceCompletion;
      if (completion === undefined) return { state };
      return updated(
        {
          ...state,
          resourceCompletion: undefined,
          composer: {
            ...state.composer,
            input: acceptResource(completion, state.composer.input, message.id)
          }
        },
        context
      );
    }
    case 'resource.loaded':
    case 'resource.failed':
    case 'resource.move':
    case 'resource.close':
      return state.resourceCompletion === undefined
        ? { state }
        : {
            ...updated(
              { ...state, resourceCompletion: updateResourceCompletion(state.resourceCompletion, message) },
              context
            ),
            ...(message.type === 'resource.close' ? { cancelEffects: ['resource-search'] } : {})
          };
    case 'conversation.export':
      return {
        state,
        effects: [
          {
            id: 'conversation-export',
            concurrency: 'keep-first',
            async run({ signal }) {
              if (options.exportConversation === undefined)
                throw new Error('Local export is unavailable in this application.');
              const file = await options.exportConversation(
                state.conversation.pages.map((page) => page.history),
                signal
              );
              const message = `Exported the loaded history pages to ${file}. Load older pages to extend coverage.`;
              return { kind: 'message', message: { type: 'interactive.notice', message } };
            },
            onError: ({ diagnostic }) => ({
              kind: 'message',
              message: { type: 'interactive.notice', message: diagnostic.message }
            })
          }
        ]
      };
    case 'inspector.open':
      return {
        state: {
          ...state,
          overlay: { kind: 'inspector', state: createSourceInspector(state.conversation.items) }
        }
      };
    case 'inspector.copy': {
      if (state.overlay.kind !== 'inspector') return { state };
      const source = inspectedSource(state.overlay.state);
      return source === undefined
        ? { state }
        : { state, effects: [copySource(source, (message) => ({ type: 'inspector.notice', message }))] };
    }
    case 'history.inspect': {
      if (message.reference.boundary.sessionId !== state.debug.sessionId) return { state };
      const inspector = updateSourceInspector(createSourceInspector([message.reference]), {
        type: 'inspector.pick',
        id: message.reference.id
      });
      return { state: { ...state, overlay: { kind: 'inspector', state: inspector } } };
    }
    case 'inspector.read': {
      if (state.overlay.kind !== 'inspector' || state.overlay.state.selected?.entry.kind !== 'reference')
        return { state };
      if (options.historyEntryReader === undefined)
        return { state: appendNotice(state, 'Explicit history reads are unavailable.', 'error') };
      return {
        state,
        effects: [
          readSourceEntry(
            state.overlay.state,
            state.overlay.state.selected.entry,
            options.historyEntryReader
          )
        ]
      };
    }
    case 'inspector.loaded':
    case 'inspector.read-failed':
    case 'inspector.pick':
    case 'inspector.transition':
    case 'inspector.edit':
    case 'inspector.format':
    case 'inspector.back':
    case 'inspector.notice':
      return state.overlay.kind !== 'inspector'
        ? { state }
        : {
            state: {
              ...state,
              overlay: { kind: 'inspector', state: updateSourceInspector(state.overlay.state, message) }
            }
          };
    case 'draft.failed':
      return { state: appendNotice(state, `Draft restoration failed: ${message.message}`, 'error') };
    case 'draft.loaded': {
      if (message.sessionId !== state.draftRestoreSession || message.draft === undefined) return { state };
      const original = state.composer;
      if (!sameDraft(original, message.original)) return { state };
      return { state: { ...state, composer: composerWithDraft(state.composer, message.draft) } };
    }
    case 'attachments.open':
      return { state: { ...state, overlay: { kind: 'attachments', state: createAttachments() } } };
    case 'attachments.inspect': {
      const attachment = state.composer.attachments.find((item) => item.id === message.id);
      if (attachment === undefined) return { state };
      const entry: ConversationEntry = {
        kind: 'user',
        id: attachment.id,
        text:
          attachment.kind === 'context'
            ? `${attachment.item.sourceUri}\n${attachment.item.representation} · ${attachment.item.mediaType}\n\n${attachment.item.content}`
            : `${attachment.label}\n${JSON.stringify(attachment.image, null, 2)}`
      };
      const inspector = updateSourceInspector(createSourceInspector([entry]), {
        type: 'inspector.pick',
        id: entry.id
      });
      return { state: { ...state, overlay: { kind: 'inspector', state: inspector } } };
    }
    case 'attachments.remove':
      return {
        state: {
          ...state,
          composer: {
            ...state.composer,
            attachments: state.composer.attachments.filter((item) => item.id !== message.id)
          }
        }
      };
    case 'attachments.loaded': {
      if (state.overlay.kind !== 'attachments' || state.overlay.state.id !== message.id) return { state };
      return {
        state: {
          ...state,
          composer: { ...state.composer, attachments: [...state.composer.attachments, message.attachment] },
          overlay: { kind: 'attachments', state: createAttachments() }
        }
      };
    }
    case 'attachments.add-image':
    case 'attachments.add-context':
    case 'attachments.path':
    case 'attachments.failed': {
      if (state.overlay.kind !== 'attachments') return { state };
      const result = updateAttachments(state.overlay.state, message, options.attachments);
      return { ...result, state: { ...state, overlay: { kind: 'attachments', state: result.state } } };
    }
    case 'recall.open': {
      const recall = createPromptRecall({
        ...state.composer.history,
        entries: [
          ...promptsFromHistory(state.conversation.pages.flatMap((page) => page.history.entries)),
          ...state.composer.history.entries
        ]
      });
      return {
        state: { ...state, overlay: { kind: 'recall', state: recall } },
        ...(options.drafts === undefined
          ? {}
          : { effects: [loadRecoveredPrompts(options.drafts, state.debug.sessionId ?? ':new', recall.id)] })
      };
    }
    case 'recall.loaded': {
      if (state.overlay.kind !== 'recall' || state.overlay.state.id !== message.id) return { state };
      const recall = appendRecalledDrafts(state.overlay.state, message.drafts);
      return { state: { ...state, overlay: { kind: 'recall', state: recall } } };
    }
    case 'recall.transition':
      return state.overlay.kind !== 'recall'
        ? { state }
        : {
            state: {
              ...state,
              overlay: {
                kind: 'recall',
                state: updatePromptRecall(state.overlay.state, message.transition)
              }
            }
          };
    case 'recall.accept': {
      if (state.overlay.kind !== 'recall') return { state };
      const draft = state.overlay.state.entries[Number(message.id)];
      if (draft === undefined) return { state };
      return {
        state: { ...state, overlay: { kind: 'none' }, composer: composerWithDraft(state.composer, draft) },
        focus: { kind: 'element', elementId: 'composer' }
      };
    }
    case 'queue.open': {
      if (options.navigation === undefined)
        return { state: appendNotice(state, 'Queue operations are unavailable.', 'error') };
      const result = createQueue(options.navigation, state.debug.sessionId ?? ':new');
      return { ...result, state: { ...state, overlay: { kind: 'queue', state: result.state } } };
    }
    case 'queue.withdrawn': {
      const draft = draftFromSubmission(message.input);
      return {
        state: {
          ...state,
          overlay:
            state.overlay.kind === 'queue' && state.overlay.state.id === message.id
              ? { kind: 'none' }
              : state.overlay,
          composer: {
            ...(message.sessionId === state.debug.sessionId &&
            textDocumentText(state.composer.input.document).length === 0 &&
            state.composer.attachments.length === 0
              ? composerWithDraft(state.composer, draft)
              : state.composer),
            history: rememberPrompt(state.composer.history, draft)
          }
        },
        effects: [
          recoverDraft(
            options.drafts,
            message.sessionId,
            draft,
            (message): CodingAgentTuiMessage => ({ type: 'interactive.notice', message, tone: 'error' })
          )
        ]
      };
    }
    case 'queue.refresh':
    case 'queue.loaded':
    case 'queue.select':
    case 'queue.edit':
    case 'queue.save':
    case 'queue.cancel':
    case 'queue.withdraw':
    case 'queue.scroll': {
      if (state.overlay.kind !== 'queue' || options.navigation === undefined) return { state };
      const result = updateQueue(state.overlay.state, message, options.navigation);
      return { ...result, state: { ...state, overlay: { kind: 'queue', state: result.state } } };
    }
    case 'terminal.focus':
      return { state: { ...state, attention: { ...state.attention, focused: message.focused } } };
    case 'setup.open':
      return state.setup.requirements.includes('workspace_trust')
        ? acceptCommand(state, '/trust', context, options)
        : updateCodingAgentTui(state, { type: 'configuration.open' }, context, options);
    case 'session.new':
      return {
        state,
        effects: [
          {
            id: 'session-new',
            concurrency: 'keep-first',
            async run() {
              if (options.navigation === undefined) throw new Error('Session navigation is unavailable.');
              await options.navigation.newSession();
              return { kind: 'none' };
            },
            onError: ({ diagnostic }) => ({
              kind: 'message',
              message: { type: 'interactive.notice', message: diagnostic.message, tone: 'error' }
            })
          }
        ]
      };
    case 'configuration.open':
      return options.configuration === undefined
        ? { state }
        : {
            state: {
              ...state,
              overlay: {
                kind: 'configuration',
                state: configurationState(options.configuration.current(), options.configuration.providers)
              }
            }
          };
    case 'configuration.saved':
      return state.overlay.kind === 'configuration' && state.overlay.state.id === message.id
        ? { state: { ...state, overlay: { kind: 'none' } } }
        : { state };
    case 'configuration.connected':
    case 'configuration.secret':
    case 'configuration.scroll':
    case 'configuration.open-browser':
    case 'configuration.copy':
    case 'configuration.notice':
    case 'configuration.login':
    case 'configuration.logout':
    case 'configuration.challenge':
    case 'configuration.authenticated':
    case 'configuration.stage':
    case 'configuration.pick':
    case 'configuration.transition':
    case 'configuration.edit':
    case 'configuration.input':
    case 'configuration.refresh':
    case 'configuration.save':
    case 'configuration.catalog':
    case 'configuration.profile':
    case 'configuration.failed': {
      if (state.overlay.kind !== 'configuration' || options.configuration === undefined) return { state };
      const result = updateConfiguration(state.overlay.state, message, options.configuration);
      return { ...result, state: { ...state, overlay: { kind: 'configuration', state: result.state } } };
    }
    case 'application.exit':
      return { state, exit: { reason: 'requested' } };
    case 'preferences.scroll':
      return { state: { ...state, modalOffsetRow: message.offset } };
    case 'preferences.open':
      return { state: { ...state, overlay: { kind: 'preferences', preferences: state.preferences } } };
    case 'preferences.capture':
      return state.overlay.kind !== 'preferences'
        ? { state }
        : {
            state: {
              ...state,
              overlay: {
                kind: 'preferences',
                preferences: state.overlay.preferences,
                capture: message.action
              }
            }
          };
    case 'preferences.capture-cancel':
      return state.overlay.kind !== 'preferences'
        ? { state }
        : { state: { ...state, overlay: { kind: 'preferences', preferences: state.overlay.preferences } } };
    case 'preferences.capture-failed':
      return state.overlay.kind !== 'preferences'
        ? { state }
        : { state: { ...state, overlay: { ...state.overlay, error: message.message } } };
    case 'preferences.captured':
    case 'preferences.reset-shortcut':
    case 'preferences.field':
    case 'preferences.move':
    case 'preferences.theme':
    case 'preferences.toggle':
      return state.overlay.kind !== 'preferences'
        ? { state }
        : {
            state: {
              ...state,
              overlay: {
                kind: 'preferences',
                preferences: updatePreferences(state.overlay.preferences, message)
              }
            }
          };
    case 'preferences.save':
      return state.overlay.kind !== 'preferences'
        ? { state }
        : {
            state: { ...state, preferences: state.overlay.preferences, overlay: { kind: 'none' } },
            effects: [
              savePreferences(
                state.overlay.preferences,
                options.presentation,
                (message): CodingAgentTuiMessage => ({ type: 'interactive.notice', message, tone: 'error' })
              )
            ]
          };
    case 'reasoning.toggle':
    case 'tools.toggle': {
      const key = message.type === 'reasoning.toggle' ? 'showReasoning' : 'showTools';
      const preferences = { ...state.preferences, [key]: !state.preferences[key] };
      return {
        ...updated(
          { ...state, preferences, conversation: { ...state.conversation, expandedIds: [] } },
          context
        ),
        effects: [
          savePreferences(
            preferences,
            options.presentation,
            (message): CodingAgentTuiMessage => ({ type: 'interactive.notice', message, tone: 'error' })
          )
        ]
      };
    }
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
      return updated(livePresentation(state, applyProgress(state, message.event, message.runId)), context);
    case 'result':
      return updated(livePresentation(state, applyResult(state, message.result)), context);
    case 'panel.open':
      return openPanel(state, message.panel, options.navigation, options.sessionNames);
    case 'panel.source-loaded':
    case 'panel.loaded':
    case 'panel.failed':
    case 'panel.transition':
    case 'panel.accept':
    case 'panel.text':
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
    case 'history.loaded': {
      const refreshTail =
        state.conversation.loading?.id === message.requestId &&
        state.conversation.loading.refreshTail === true;
      const received = receiveHistory(state, message.requestId, message.pages);
      if (!refreshTail) return updated(received, context);
      const refresh = loadHistory(received, 'tail', options.historyReader);
      return {
        ...updated(refresh.state, context),
        ...(refresh.effects === undefined ? {} : { effects: refresh.effects })
      };
    }
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
    case 'verification.updated':
      return updated(applyConfiguredChecks(state, message.verification), context);
    case 'application.state.changed': {
      const next = applyInteractiveState(state, message.state);
      return message.state.status === 'setup_required' &&
        state.setup.status === 'initializing' &&
        state.overlay.kind === 'none' &&
        textDocumentText(state.composer.input.document).length === 0
        ? updateCodingAgentTui(next, { type: 'setup.open' }, context, options)
        : updated(next, context);
    }
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
    case 'session.hydrated': {
      const result = restoreSessionView(state, message.hydration, options.historyReader);
      const sessionId = message.hydration.session.sessionId;
      if (
        options.drafts === undefined ||
        state.draftRestoreSession === sessionId ||
        state.sessionViews[sessionId] !== undefined
      )
        return result;
      const draft = result.state.composer;
      if (textDocumentText(draft.input.document).length > 0 || draft.attachments.length > 0) return result;
      return {
        ...result,
        state: { ...result.state, draftRestoreSession: sessionId },
        effects: [...(result.effects ?? []), loadDraft(options.drafts, sessionId, draft)]
      };
    }
    case 'approval.required':
      return updated(
        { ...state, run: { kind: 'waiting_for_approval', suspension: message.suspension } },
        context
      );
    case 'run.suspended':
      return updated(
        { ...state, run: { kind: 'waiting_for_recovery', suspension: message.suspension } },
        context
      );
    case 'recovery.open':
      return state.run.kind === 'waiting_for_approval' || state.run.kind === 'waiting_for_recovery'
        ? { state: { ...state, overlay: { kind: 'decision' }, completion: undefined, modalOffsetRow: 0 } }
        : updated(appendNotice(state, 'No pending decision in this session.'), context);
    case 'recovery.act': {
      if (state.run.kind !== 'waiting_for_recovery' || state.run.operation !== undefined) return { state };
      return {
        state: { ...state, run: { ...state.run, operation: message.action } },
        effects: [recoveryEffect(state.run.suspension, message.action, options.recoveryHandler)]
      };
    }
    case 'recovery.finished': {
      if (state.run.kind !== 'waiting_for_recovery' || state.run.suspension.runId !== message.runId)
        return { state };
      return {
        state: {
          ...state,
          run: { kind: 'waiting_for_recovery', suspension: state.run.suspension, message: message.message }
        }
      };
    }
    case 'approval.decide': {
      if (state.run.kind !== 'waiting_for_approval') return { state };
      return {
        state,
        effects: [approvalEffect(state.run.suspension, message.decision, options.approvalHandler)]
      };
    }
    case 'completion.close':
      return updated({ ...state, completion: undefined }, context);
    case 'completion.move':
      return state.completion === undefined
        ? { state }
        : updated({ ...state, completion: moveCommand(state.completion, message.delta) }, context);
    case 'completion.accept': {
      const name = message.name ?? state.completion?.names[state.completion.selected];
      const completion = state.completion;
      if (
        name === undefined ||
        completion === undefined ||
        !completion.names.includes(name) ||
        completion.input !== state.composer.input
      )
        return { state };
      const composer = {
        ...state.composer,
        input: insertCommand(completion, state.composer.input, message.open ? '' : name)
      };
      if (!message.open) return updated({ ...state, composer, completion: undefined }, context);
      const next = {
        ...state,
        composer,
        completion: undefined,
        overlay: {
          kind: 'commands' as const,
          picker: createSearchPickerState({ query: { text: '', mode: 'fuzzy' } }, COMMAND_INDEX)
        }
      };
      return updateCodingAgentTui(
        next,
        { type: 'commands.accept', event: { kind: 'accept', id: name } },
        context,
        options
      );
    }
    case 'composer.edit': {
      const next = editComposer(state, message.transition);
      const resourceCompletion =
        options.resources === undefined
          ? undefined
          : completeResource(next.composer.input, message.transition, state.resourceCompletion);
      return {
        ...updated(
          {
            ...next,
            resourceCompletion,
            completion: completeCommand(next.composer.input, message.transition, INTERACTIVE_COMMANDS)
          },
          context
        ),
        ...(resourceCompletion === undefined || options.resources === undefined
          ? { cancelEffects: ['resource-search'] }
          : { effects: [searchResources(resourceCompletion, options.resources)] })
      };
    }
    case 'composer.restore':
      return updated(setComposerText(state, message.text), context);
    case 'composer.history':
      return updated(navigateComposerHistory(state, message.direction), context);
    case 'composer.submit': {
      if (state.setup.status === 'setup_required')
        return updateCodingAgentTui(state, { type: 'setup.open' }, context, options);
      const source = textDocumentText(state.composer.input.document);
      if (!source.includes('\n')) {
        const command = INTERACTIVE_COMMANDS.find((entry) => entry.name === source.trim());
        if (command !== undefined)
          return acceptCommand(
            { ...setComposerText(state, ''), completion: undefined },
            command.name,
            context,
            options
          );
      }
      if (state.run.kind === 'waiting_for_approval' || state.run.kind === 'waiting_for_recovery')
        return updateCodingAgentTui(state, { type: 'recovery.open' }, context, options);
      return submit(state, context, options.commandHandler, message.delivery);
    }
    case 'composer.cancel-command': {
      const { commandReturnDraft, ...composer } = state.composer;
      return updated(
        commandReturnDraft === undefined
          ? state
          : { ...state, composer: composerWithDraft(composer, commandReturnDraft) },
        context
      );
    }
    case 'composer.complete': {
      if (textDocumentText(state.composer.input.document).startsWith('/'))
        return openOverlay(state, 'commands', context);
      const resourceCompletion = completeResource(
        state.composer.input,
        undefined,
        state.resourceCompletion
      );
      return {
        state: { ...state, resourceCompletion },
        ...(resourceCompletion === undefined || options.resources === undefined
          ? {}
          : { effects: [searchResources(resourceCompletion, options.resources)] })
      };
    }
    case 'composer.external-editor': {
      const draft = state.composer;
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
              return {
                kind: 'message',
                message: {
                  type: 'composer.external-edited',
                  sessionId: state.debug.sessionId ?? ':new',
                  draft,
                  text
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
    case 'composer.external-edited': {
      const draft = { ...message.draft, input: createDraft(message.text).input };
      const current =
        message.sessionId === (state.debug.sessionId ?? ':new') && sameDraft(state.composer, message.draft);
      return {
        ...updated(
          current
            ? { ...state, composer: composerWithDraft(state.composer, draft) }
            : appendNotice(
                {
                  ...state,
                  composer: { ...state.composer, history: rememberPrompt(state.composer.history, draft) }
                },
                'External edit retained in /drafts; the current input was preserved.'
              ),
          context
        ),
        ...(current
          ? {}
          : {
              effects: [
                recoverDraft(
                  options.drafts,
                  message.sessionId,
                  draft,
                  (message): CodingAgentTuiMessage => ({
                    type: 'interactive.notice',
                    message,
                    tone: 'error'
                  })
                )
              ]
            })
      };
    }
    case 'work.interrupt':
      if (state.run.kind === 'waiting_for_recovery')
        return updateCodingAgentTui(state, { type: 'recovery.act', action: 'stop' }, context, options);
      if (state.run.kind === 'working') return executeCommand(state, '/stop', options.commandHandler);
      return updated(
        appendNotice(state, 'No active work. Your draft is preserved; use the exit command to close.'),
        context
      );
    case 'command.completed': {
      const result = applyCommandExecution(state, message.execution, message.request);
      if (
        message.execution.action !== undefined &&
        message.request.sessionId === (state.debug.sessionId ?? ':new')
      )
        return updateCodingAgentTui(result.state, message.execution.action, context, options);
      return result.exit === true
        ? { state: result.state, exit: { reason: 'command' } }
        : updated(result.state, context);
    }
    case 'command.failed':
      return updated(applyCommandFailure(state, message.message, message.request), context);
    case 'search.adjacent':
      return jumpToAdjacentMatch(state, message.direction, options.historyReader);
    case 'conversation.message': {
      const layout = conversationLayout(state, context);
      const anchor = state.presentation.adjacentMessage(layout.scroll.offsetRow, message.direction);
      return anchor === undefined
        ? loadHistory(state, message.direction === 'previous' ? 'older' : 'newer', options.historyReader)
        : updated(
            {
              ...state,
              conversation: {
                ...state.conversation,
                anchor,
                scroll: { ...layout.scroll, followTail: false }
              }
            },
            context
          );
    }
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
      return {
        state: { ...state, overlay: { kind: 'none' } },
        cancelEffects: [
          'model-configuration',
          'configuration-browser',
          'model-notes-read',
          'context-inspection',
          'history-jump',
          'source-entry-read',
          'attachment-read',
          'session-name-load',
          'process-list'
        ]
      };
    case 'modal.scrolled':
      return { state: { ...state, modalOffsetRow: message.offsetRow } };
    case 'commands.transition':
      return transitionCommands(state, message.transition);
    case 'commands.accept':
      return acceptCommand(state, message.event.id, context, options);
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
      return updated(receiveSearchJump(state, message), context, {
        kind: 'element',
        elementId: 'composer'
      });
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
  if (state.run.kind === 'waiting_for_approval' || state.run.kind === 'waiting_for_recovery')
    return { state };
  const submission = submitComposer(state, delivery);
  const next = followCurrentConversation(submission.state);
  return submission.request === undefined
    ? { state: next }
    : {
        state: reconcileConversationLayout(next, context),
        effects: [commandEffect(submission.request, handler)]
      };
}

function followCurrentConversation(state: CodingAgentTuiState): CodingAgentTuiState {
  const conversation = { ...state.conversation };
  delete conversation.anchor;
  return {
    ...state,
    conversation: {
      ...conversation,
      unread: false,
      scroll: { ...conversation.scroll, followTail: true }
    }
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
    effects: [
      commandEffect(
        {
          kind: 'command',
          id: `command:${String(count)}`,
          sessionId: state.debug.sessionId ?? ':new',
          value,
          recordResult: true
        },
        handler
      )
    ]
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
    return upsertConversationEntry(next, {
      id: 'interactive:setup',
      kind: 'notice',
      tone: 'warning',
      text: `Choose ${interactive.requirements.includes('workspace_trust') ? 'workspace trust' : 'a provider and model'} to begin. Your draft is preserved.`
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
        picker: transitionCommandPicker(
          state.overlay.picker,
          transition,
          COMMAND_INDEX,
          INTERACTIVE_COMMANDS
        )
      }
    }
  };
}

function acceptCommand(
  state: CodingAgentTuiState,
  id: string,
  context: TuiContext,
  options: CodingAgentTuiAppOptions
): TuiUpdateResult<CodingAgentTuiState, CodingAgentTuiMessage> {
  const command = INTERACTIVE_COMMANDS.find((candidate) => candidate.name === id);
  if (command === undefined) return { state };
  if (command.kind === 'interface')
    return updateCodingAgentTui({ ...state, overlay: { kind: 'none' } }, command.message, context, options);
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
    const draft = state.composer.commandReturnDraft ?? state.composer;
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
  return executeCommand({ ...state, overlay: { kind: 'none' } }, command.name, options.commandHandler);
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
    context
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
  hints: readonly { readonly label: string; readonly keys: string }[],
  configuration?: ConfigurationOperations
): Element<CodingAgentTuiMessage> {
  const workspace = conversationFrame({
    id: 'coding-agent-tui',
    terminalRows: context.terminalSize.rows,
    composerRows:
      resourceCompletionRows(state.resourceCompletion) +
      (state.completion === undefined ? 0 : Math.min(5, state.completion.names.length) + 1) +
      (context.terminalSize.rows >= 8 ? 1 : 0) +
      composerRows(state.composer.input.document, context.terminalSize.columns, context.terminalSize.rows),
    slots: {
      status: statusChrome(state, context.terminalSize.columns),
      conversation: conversationView(state, context),
      composer:
        context.terminalSize.rows < 8
          ? composerView(state)
          : column(
              [
                composerControls({
                  attachments: state.composer.attachments,
                  queued: state.debug.session?.queuedInputs ?? 0,
                  delivery: state.run.kind === 'working' ? 'follow_up' : 'input',
                  onAttachments: (): CodingAgentTuiMessage => ({ type: 'attachments.open' }),
                  onQueue: (): CodingAgentTuiMessage => ({ type: 'queue.open' })
                }),
                composerView(state)
              ],
              { sizes: [{ kind: 'fixed', cells: 1 }, { kind: 'fill' }] }
            ),
      footer: [
        ...(state.setup.status === 'setup_required'
          ? [
              button<CodingAgentTuiMessage>({
                id: 'setup-continue',
                label: 'Set up',
                onPress: () => ({ type: 'setup.open' })
              })
            ]
          : []),
        ...(state.run.kind === 'waiting_for_approval' || state.run.kind === 'waiting_for_recovery'
          ? [
              button<CodingAgentTuiMessage>({
                id: 'review-decision',
                label: 'Review pending decision',
                onPress: () => ({ type: 'recovery.open' })
              })
            ]
          : []),
        button<CodingAgentTuiMessage>({
          id: 'open-commands',
          label: 'Commands',
          onPress: () => ({ type: 'overlay.open', overlay: 'commands' })
        }),
        ...(state.run.kind === 'working'
          ? [
              button<CodingAgentTuiMessage>({
                id: 'stop-work',
                label: 'Stop',
                onPress: () => ({ type: 'work.interrupt' })
              })
            ]
          : []),
        button<CodingAgentTuiMessage>({
          id: 'exit-application',
          label: 'Exit',
          onPress: () => ({ type: 'application.exit' })
        }),
        hintBar(context.terminalSize.columns, hints)
      ]
    }
  });
  if (state.overlay.kind === 'decision' && state.run.kind === 'waiting_for_approval') {
    return overlay([workspace, approvalDialog(state, context)], { id: 'coding-agent-overlay' });
  }
  if (state.overlay.kind === 'decision' && state.run.kind === 'waiting_for_recovery') {
    return overlay([workspace, recoveryDialog(state.run, context, state.modalOffsetRow)], {
      id: 'coding-agent-overlay'
    });
  }
  const modal = overlayView(state, context, helpText, configuration);
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
        : state.run.kind === 'waiting_for_recovery'
          ? 'Resolve the paused run to send a message'
          : 'Send a message';
  const input: Element<CodingAgentTuiMessage> = textArea({
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
  if (state.resourceCompletion !== undefined)
    return column([resourceSuggestions(state.resourceCompletion), input], {
      sizes: [{ kind: 'fixed', cells: resourceCompletionRows(state.resourceCompletion) }, { kind: 'fill' }]
    });
  return state.completion === undefined
    ? input
    : column(
        [
          commandSuggestions(
            state.completion,
            INTERACTIVE_COMMANDS,
            (name): CodingAgentTuiMessage => ({ type: 'completion.accept', open: true, name })
          ),
          input
        ],
        {
          sizes: [
            { kind: 'fixed', cells: Math.min(5, state.completion.names.length) + 1 },
            { kind: 'fill' }
          ]
        }
      );
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
  entry: ConversationEntry,
  state: CodingAgentTuiState,
  width: number
): Element<CodingAgentTuiMessage> {
  if (entry.kind === 'reference')
    return button<CodingAgentTuiMessage>({
      id: entry.id,
      label: `Read recorded entry · ${String(entry.bytes)} bytes`,
      onPress: () => ({ type: 'history.inspect', reference: entry })
    });
  if (entry.kind === 'activity' && entry.details !== undefined) {
    return disclosure({
      id: entry.id,
      label: activityLabel(entry),
      ...(entry.summary === undefined ? {} : { summary: body(entry.summary) }),
      expanded: activityExpanded(state, entry.id),
      slots: {
        content: richText({
          id: `${entry.id}:details`,
          segments: body(activityDetails(entry)),
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
  helpText: string,
  configuration?: ConfigurationOperations
): Element<CodingAgentTuiMessage> | undefined {
  const width = Math.max(5, Math.min(84, context.terminalSize.columns - 4));
  const height = Math.max(4, Math.min(20, context.terminalSize.rows - 4));
  switch (state.overlay.kind) {
    case 'processes':
      return processesView(state.overlay.state, width, height);
    case 'session-name':
      return sessionNameView(state.overlay.state, width, height);
    case 'inspector':
      return sourceInspectorView(state.overlay.state, width, height);
    case 'decision':
      return undefined;
    case 'preferences':
      return preferencesView(
        state.overlay.preferences,
        codingStatusFields(state),
        width,
        height,
        state.modalOffsetRow,
        {
          actions: CODING_SHORTCUTS,
          ...(state.overlay.capture === undefined ? {} : { capturing: state.overlay.capture }),
          ...(state.overlay.error === undefined ? {} : { error: state.overlay.error })
        }
      );
    case 'configuration':
      return configuration === undefined
        ? undefined
        : configurationView(state.overlay.state, configuration, width, height);
    case 'notes':
      return notesView(state.overlay.state, width, height, (message) => message);
    case 'none':
      return undefined;
    case 'attachments':
      return attachmentsView(state.overlay.state, state.composer.attachments, width, height);
    case 'recall':
      return promptRecallView(state.overlay.state, width, height);
    case 'queue':
      return queueView(state.overlay.state, width, height);
    case 'context-loading':
      return panel({
        id: 'context-loading',
        title: 'Inspect context',
        width,
        height,
        onClose: (): CodingAgentTuiMessage => ({ type: 'overlay.close' }),
        slots: { content: text({ content: 'Reading authorized context…' }) }
      });
    case 'panel_loading':
    case 'panel':
    case 'source':
    case 'branch_review':
      return panelView(state.overlay, width, height);
    case 'commands':
      return panel({
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
      return panel({
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
      return panel({
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
                  : state.overlay.result.oversizedEntry !== undefined
                    ? 'An oversized entry was not searched. Inspect it explicitly.'
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
      return panel({
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
      return panel({
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
    focusPolicy: { initialFocus: { kind: 'element', elementId: 'approval-close' }, returnFocus: 'restore' },
    dismissal: { dismissOnEscape: true, dismissOnOutsidePress: false },
    onDismiss: (): CodingAgentTuiMessage => ({ type: 'overlay.close' }),
    slots: {
      content: modalViewport(bodyElement, state, 'approval-content-scroll'),
      actions: row(
        [
          button({
            id: 'approval-close',
            label: 'Close',
            onPress: (): CodingAgentTuiMessage => ({ type: 'overlay.close' })
          }),
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
      message: { type: 'interactive.notice' as const, tone: 'error' as const, message: diagnostic.message }
    })
  };
}

interface ConversationLayout {
  readonly collection: MeasuredCollection<ConversationEntry>;
  readonly scroll: CodingAgentTuiState['conversation']['scroll'];
  readonly geometry: ScrollGeometry;
}

function activityExpanded(state: CodingAgentTuiState, id: string): boolean {
  return state.preferences.showTools !== state.conversation.expandedIds.includes(id);
}

function conversationLayout(state: CodingAgentTuiState, context: TuiContext): ConversationLayout {
  // Reserve the visible vertical scrollbar so content width stays stable while streaming.
  const width = Math.max(1, context.terminalSize.columns - 1);
  const viewportRows = Math.max(
    0,
    context.terminalSize.rows -
      3 -
      (resourceCompletionRows(state.resourceCompletion) +
        (state.completion === undefined ? 0 : Math.min(5, state.completion.names.length) + 1)) -
      ((context.terminalSize.rows >= 8 ? 1 : 0) +
        composerRows(
          state.composer.input.document,
          context.terminalSize.columns,
          context.terminalSize.rows
        ))
  );
  const collection = state.presentation.measure(
    state.conversation.items.filter((item) => item.kind !== 'reasoning' || state.preferences.showReasoning),
    state.conversation.items
      .filter((entry) => entry.kind === 'activity' && activityExpanded(state, entry.id))
      .map((entry) => entry.id),
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
          offsetRow: measuredWindow(collection, { viewportRows, anchor: state.conversation.anchor })
            .offsetRow
        };
  const scroll = normalizeScrollState(anchored, geometry);
  return { collection, scroll, geometry };
}

function conversationEntryRows(
  entry: ConversationEntry,
  state: CodingAgentTuiState,
  width: number,
  context: TuiContext
): number {
  if (entry.kind === 'reference') return 1;
  if (entry.kind === 'activity' && entry.details !== undefined) {
    if (!activityExpanded(state, entry.id)) return 1;
    return 1 + wrappedRows(activityDetails(entry), width, context);
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
  entry: ConversationEntry,
  state: CodingAgentTuiState,
  width: number
): InlineContent {
  switch (entry.kind) {
    case 'reference':
      return [{ kind: 'text', text: `Read recorded entry · ${String(entry.bytes)} bytes` }];
    case 'user':
      return [{ kind: 'text', text: 'You\n', style: { bold: true } }, ...body(`${entry.text}\n`)];
    case 'assistant':
      return [
        { kind: 'text', text: 'Assistant\n', style: { bold: true } },
        ...state.presentation.markdown(entry.id, entry.text).render(width).segments
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

function activityLabel(entry: ConversationActivityEntry): string {
  return `${activityGlyph(entry.status)} ${entry.label}`;
}

function activityGlyph(status: ConversationActivityEntry['status']): string {
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

function activitySymbol(status: ConversationActivityEntry['status']): InlineContent[number] {
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
    width,
    height,
    ...(['file-loading-text', 'help-content', 'debug-content'].includes(focusId) ? {} : { focusId }),
    onClose: (): CodingAgentTuiMessage => ({ type: 'overlay.close' })
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

function composerBindingEnabled({
  state,
  focusPath
}: TuiInputBindingContext<CodingAgentTuiState>): boolean {
  return state.overlay.kind === 'none' && focusPath?.includes('composer') === true;
}

function composerHistoryPreviousEnabled(context: TuiInputBindingContext<CodingAgentTuiState>): boolean {
  if (!composerBindingEnabled(context) || context.state.composer.history.entries.length === 0) return false;
  if (context.state.composer.history.index !== null) return true;
  const input = context.state.composer.input;
  return !textDocumentText(input.document).slice(0, input.caret.position.offset).includes('\n');
}

function composerHistoryNextEnabled(context: TuiInputBindingContext<CodingAgentTuiState>): boolean {
  if (!composerBindingEnabled(context) || context.state.composer.history.index === null) return false;
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
  return state.overlay.kind === 'none';
}

function canScroll(state: CodingAgentTuiState): boolean {
  return state.overlay.kind === 'none';
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

function livePresentation(previous: CodingAgentTuiState, next: CodingAgentTuiState): CodingAgentTuiState {
  return previous.conversation.scroll.followTail || previous.conversation.pages.length === 0
    ? next
    : { ...next, conversation: { ...next.conversation, unread: true } };
}

function copyInput(state: CodingAgentTuiState) {
  const overlay = state.overlay;
  if (overlay.kind === 'processes') return overlay.state.selected?.output;
  if (overlay.kind === 'inspector') return overlay.state.selected?.input;
  return overlay.kind === 'source'
    ? overlay.input
    : overlay.kind === 'notes'
      ? overlay.state.source?.input
      : overlay.kind === 'none'
        ? state.composer.input
        : undefined;
}

function withAttention(
  result: TuiUpdateResult<CodingAgentTuiState, CodingAgentTuiMessage>,
  message: CodingAgentTuiMessage,
  options: CodingAgentTuiAppOptions
): TuiUpdateResult<CodingAgentTuiState, CodingAgentTuiMessage> {
  const event =
    message.type === 'result'
      ? `${message.result.terminal.runId}:ended`
      : message.type === 'approval.required'
        ? `${message.suspension.runId}:approval:${message.suspension.pendingApprovals[0]?.fingerprint ?? ''}`
        : message.type === 'run.suspended'
          ? `${message.suspension.runId}:${message.suspension.reason}:${message.suspension.decisionRequest?.id ?? message.suspension.effectId ?? ''}`
          : message.type === 'progress' && message.event.type === 'run.ended'
            ? `${message.event.terminal.runId}:ended`
            : undefined;
  if (event === undefined) return result;
  const attention = observeAttention(result.state.attention, event, result.state.preferences.notify);
  const notify = options.notify;
  return {
    ...result,
    state: { ...result.state, attention: attention.state },
    ...(attention.notify && notify !== undefined
      ? {
          effects: [
            ...(result.effects ?? []),
            {
              id: 'terminal-attention',
              concurrency: 'enqueue',
              async run({ signal }) {
                await notify(signal);
                return { kind: 'none' };
              },
              onError: ({ diagnostic }) => ({
                kind: 'message',
                message: { type: 'interactive.notice', tone: 'warning', message: diagnostic.message }
              })
            }
          ]
        }
      : {})
  };
}

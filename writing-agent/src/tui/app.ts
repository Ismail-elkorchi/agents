import type { ConversationEntry } from '@agent-core/tui';
import {
  MarkdownDocument,
  acceptResource,
  appendRecalledDrafts,
  completeCommand,
  completeResource,
  composerRows,
  configurationState,
  copySource,
  createAttachments,
  createDraft,
  createPromptRecall,
  createQueue,
  createSessionName,
  createSourceInspector,
  diagnosticMessage,
  draftFromSubmission,
  draftSubmission,
  historyBookmark,
  insertAcceptedInput,
  insertCommand,
  inspectedSource,
  loadDraft,
  loadRecoveredPrompts,
  loadSessionName,
  mergeConversationEntries,
  moveCommand,
  navigatePromptHistory,
  observeAttention,
  presentProgress,
  projectProgress,
  promptsFromHistory,
  providerFailureText,
  readSourceEntry,
  recoverDraft,
  rememberPrompt,
  sameDraft,
  savePreferences,
  searchResources,
  selectedSource,
  sessionConversationId,
  shortcutBindings,
  shortcutHelp,
  suspensionPresentation,
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
import { editTextExternally, openBrowser } from '@agent-core/tui/node';
import {
  createSearchPickerState,
  createTextAreaState,
  searchPickerReducer,
  textAreaReducer
} from '@ismail-elkorchi/terminal-ui/behavior';
import type { InputTrigger } from '@ismail-elkorchi/terminal-ui/input';
import { formatKeyboardBinding, ignoreMessage } from '@ismail-elkorchi/terminal-ui/interaction';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import type {
  TuiEffect,
  TuiEventSource,
  TuiInputBindingContext,
  TuiUpdateResult
} from '@ismail-elkorchi/terminal-ui/tui';
import { defineTui, tuiBindingHelp } from '@ismail-elkorchi/terminal-ui/tui';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WritingApplication, WritingDocument } from '../application/service.js';
import { WRITING_PROVIDER_IDS } from '../provider.js';
import { WRITING_COMMANDS, WRITING_SHORTCUTS } from './commands.js';
import { historyMessages } from './history.js';
import { pickerIndex } from './picker.js';
import { updateHistorySearch } from './search.js';
import { initialWritingState, type WritingTuiMessage, type WritingTuiState } from './state.js';
import { writingView } from './view.js';

type Update = TuiUpdateResult<WritingTuiState, WritingTuiMessage>;
export interface WritingTuiOptions {
  readonly sessionNames?: import('@agent-core/tui').SessionNames;
  readonly exportConversation?: (
    pages: readonly import('@agent-core/runtime').SessionBranchPage[],
    signal: AbortSignal
  ) => Promise<string>;
  readonly drafts?: import('@agent-core/tui').DraftStorage;
  readonly notify?: (signal: AbortSignal) => Promise<void>;
  readonly presentation?: import('@agent-core/tui').PresentationOptions;
  readonly events?: TuiEventSource<WritingTuiMessage>;
  readonly externalEditor?: (text: string, signal: AbortSignal) => Promise<string>;
}

export function createWritingAgentTuiApp(application: WritingApplication, options: WritingTuiOptions = {}) {
  const events = options.events;
  const app: import('@ismail-elkorchi/terminal-ui/tui').TuiApp<WritingTuiState, WritingTuiMessage> =
    defineTui<WritingTuiState, WritingTuiMessage>({
      id: 'writing-agent',
      onExit: async (state) => {
        if (options.drafts === undefined) return;
        const drafts = new Map<string, ComposerDraft>();
        for (const [sessionId, view] of Object.entries(state.sessionViews))
          drafts.set(sessionId, view.composer);
        drafts.set(state.application.sessionId ?? ':new', state.composer);
        for (const [sessionId, draft] of drafts) await options.drafts.write(sessionId, draft);
      },

      init: () => {
        const initial = initialWritingState(application.state(), options.presentation?.preferences);
        const sessionId = initial.application.sessionId ?? ':new';
        return {
          state: {
            ...initial,
            draftRestoreSession: sessionId,
            ...(application.state().status === 'configuration_required'
              ? {
                  overlay: {
                    kind: 'configuration' as const,
                    state: configurationState(
                      application.modelSelection(),
                      writingConfigurationOperations(application).providers
                    )
                  }
                }
              : {})
          },
          effects: [
            refresh(application),
            ...(options.drafts === undefined
              ? []
              : [loadDraft(options.drafts, sessionId, initial.composer)])
          ],
          focus: { kind: 'element', elementId: 'writing-composer' }
        };
      },
      update: (state, message, context) => {
        const result = withAttention(update(state, message, application, options), message, options);
        return context.terminalSize.rows < 12
          ? { ...result, state: { ...result.state, completion: undefined, resourceCompletion: undefined } }
          : result;
      },
      resizeMessage: () => ({ type: 'terminal.resized' }),
      ...(events === undefined ? {} : { subscriptions: () => [events] }),
      inputBindings: shortcutBindings<WritingTuiState, WritingTuiMessage>(
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
          ].map(({ key, message, modifiers }) => ({
            ...binding(`Resource ${key}`, key, message, modifiers),
            enabled: ({ state }: TuiInputBindingContext<WritingTuiState>) =>
              state.overlay.kind === 'none' && state.resourceCompletion !== undefined
          })),
          ...[
            { key: 'arrowDown' as const, message: { type: 'completion.move' as const, delta: 1 } },
            { key: 'arrowUp' as const, message: { type: 'completion.move' as const, delta: -1 } },
            { key: 'enter' as const, message: { type: 'completion.accept' as const, open: true } },
            { key: 'tab' as const, message: { type: 'completion.accept' as const, open: false } },
            { key: 'escape' as const, message: { type: 'completion.close' as const } }
          ].map(({ key, message }) => ({
            ...binding(`Completion ${key}`, key, message),
            enabled: ({ state }: TuiInputBindingContext<WritingTuiState>) =>
              state.overlay.kind === 'none' && state.completion !== undefined
          })),
          {
            ...binding('Close commands', 'p', { type: 'overlay.close' }, { ctrl: true }),
            enabled: ({ state }: TuiInputBindingContext<WritingTuiState>) =>
              state.overlay.kind === 'picker' && state.overlay.subject === 'commands'
          },
          binding('Queue follow-up', 'enter', { type: 'submit', delivery: 'follow_up' }, { ctrl: true }),
          binding('Steer active run', 's', { type: 'submit', delivery: 'steer' }, { alt: true }),
          binding('Commands', 'p', { type: 'commands.open' }, { ctrl: true }),
          binding('Tool output', 'o', { type: 'tools.toggle' }, { ctrl: true }),
          binding('Reasoning', 't', { type: 'reasoning.toggle' }, { ctrl: true }),
          {
            id: 'Copy selected source',
            label: 'Copy selected source',
            triggers: [{ kind: 'key', key: 'c', modifiers: { ctrl: true } }],
            phase: 'beforeFocus',
            toMessage: ({ state, focusPath }) => {
              const text = selectedSource(copyInput(state, focusPath));
              return text === undefined ? ignoreMessage() : { type: 'source.copy', text };
            }
          },
          {
            ...binding('Close popup', 'c', { type: 'overlay.close' }, { ctrl: true }),
            enabled: ({ state }: TuiInputBindingContext<WritingTuiState>) => state.overlay.kind !== 'none'
          },
          {
            ...binding('Close notes', 'n', { type: 'overlay.close' }, { alt: true }),
            enabled: ({ state }: TuiInputBindingContext<WritingTuiState>) => state.overlay.kind === 'notes'
          },
          {
            ...binding('Exit', 'd', { type: 'exit' }, { ctrl: true }),
            enabled: ({ state }: TuiInputBindingContext<WritingTuiState>) =>
              state.overlay.kind === 'none' && textDocumentText(state.composer.input.document).length === 0
          },
          binding('Model notes', 'n', { type: 'notes.open' }, { alt: true }),
          {
            id: 'Help',
            label: 'Help',
            triggers: [{ kind: 'key', key: 'f1' }],
            phase: 'beforeFocus',
            enabled: ({ state }: TuiInputBindingContext<WritingTuiState>) => state.overlay.kind === 'none',
            toMessage: ({ state }) => ({
              type: 'source.loaded',
              title: 'Keyboard controls',
              content: shortcutHelp(tuiBindingHelp(app), state.preferences.shortcuts, WRITING_SHORTCUTS)
                .map(
                  (item) =>
                    `${item.bindings.map((binding) => formatKeyboardBinding(binding.binding)).join(' / ')}  ${item.label}`
                )
                .join('\n')
            })
          },
          binding('Resources', 'f2', { type: 'picker.open', subject: 'resources' }),
          binding('Outline', 'f3', { type: 'picker.open', subject: 'outline' }, { alt: true }),
          binding('Document source', 'f4', { type: 'document.toggle-source' }),
          binding('Conversation', 'f5', { type: 'view', view: 'conversation' }),
          binding('New conversation', 'f6', { type: 'session.new' }),
          binding('Edit or review', 'f7', { type: 'mode.toggle' }),
          binding('Use selected passage', 'f8', { type: 'document.use-passage' }),
          binding('Model configuration', 'f10', { type: 'configuration.open' }),
          binding('Sessions', 'f11', { type: 'picker.open', subject: 'sessions' }),
          binding('Recovery', 'f12', { type: 'recovery.open' }),
          {
            ...binding('Find matches', 'enter', {
              type: 'search.submit',
              more: false
            }),
            enabled: ({ state }: TuiInputBindingContext<WritingTuiState>) => state.overlay.kind === 'search'
          },
          binding('Search history', 'f', { type: 'search.open' }, { ctrl: true }),
          ...(['previous', 'next'] as const).map((direction) => ({
            ...binding(
              `${direction} match`,
              'f3',
              { type: 'search.adjacent', direction },
              direction === 'previous' ? { shift: true } : {}
            ),
            enabled: ({ state }: TuiInputBindingContext<WritingTuiState>) =>
              state.overlay.kind === 'none' && state.historyMatch !== undefined
          })),
          ...(['previous', 'next'] as const).map((direction) =>
            binding(
              `${direction} message`,
              direction === 'previous' ? 'pageUp' : 'pageDown',
              { type: 'conversation.message', direction },
              { alt: true }
            )
          ),
          binding('Recall prompt', 'r', { type: 'recall.open' }, { ctrl: true }),
          ...(['older', 'newer'] as const).map((direction) => ({
            ...binding(`${direction} prompt`, direction === 'older' ? 'arrowUp' : 'arrowDown', {
              type: 'prompt.navigate',
              direction
            }),
            enabled: ({ state, focusPath }: TuiInputBindingContext<WritingTuiState>) =>
              state.overlay.kind === 'none' &&
              state.completion === undefined &&
              (focusPath?.includes('writing-composer') ?? false) &&
              state.composer.input.caret.position.offset ===
                (direction === 'older' ? 0 : textDocumentText(state.composer.input.document).length)
          })),
          binding('Saved drafts', 'd', { type: 'recall.open' }, { alt: true }),
          binding('External instruction editor', 'g', { type: 'external-editor' }, { ctrl: true }),
          binding('Older history', 'pageUp', { type: 'history.load', direction: 'older' }, { ctrl: true }),
          binding(
            'Newer history',
            'pageDown',
            { type: 'history.load', direction: 'newer' },
            { ctrl: true }
          ),
          binding('Latest history', 'end', { type: 'history.load', direction: 'tail' }, { ctrl: true }),
          {
            ...binding('Interrupt', 'c', { type: 'interrupt' }, { ctrl: true }),
            enabled: ({ state, focusPath }: TuiInputBindingContext<WritingTuiState>) => {
              const input = focusPath?.includes('writing-composer')
                ? state.composer.input
                : focusPath?.includes('writing-document-source')
                  ? state.document?.input
                  : focusPath?.includes('writing-source-reader')
                    ? state.source?.input
                    : undefined;
              return (
                state.overlay.kind === 'none' &&
                (input?.selection === undefined ||
                  input.selection.anchor.offset === input.selection.focus.offset)
              );
            }
          },
          {
            ...binding('Send instruction', 'enter', { type: 'submit' }),
            enabled: ({ state, focusPath }: TuiInputBindingContext<WritingTuiState>) =>
              state.overlay.kind === 'none' && (focusPath?.includes('writing-composer') ?? false)
          },
          ...(
            [
              { key: 'enter', modifiers: { shift: true } },
              { key: 'enter', modifiers: { alt: true } }
            ] as const
          ).map(({ key, modifiers }) => ({
            ...binding(
              `New line (${'shift' in modifiers ? 'Shift' : 'Alt'}+${key})`,
              key,
              {
                type: 'composer.edit',
                transition: {
                  kind: 'edit',
                  operation: { kind: 'insert', text: '\n' }
                }
              },
              modifiers
            ),
            enabled: ({ state, focusPath }: TuiInputBindingContext<WritingTuiState>) =>
              state.overlay.kind === 'none' && (focusPath?.includes('writing-composer') ?? false)
          }))
        ],
        {
          actions: WRITING_SHORTCUTS,
          overrides: (state) => state.preferences.shortcuts,
          capturing: (state) => (state.overlay.kind === 'preferences' ? state.overlay.capture : undefined),
          captured: (action, shortcut) => ({ type: 'preferences.captured', action, shortcut }),
          cancelled: () => ({ type: 'preferences.capture-cancel' }),
          failed: (message) => ({ type: 'preferences.capture-failed', message })
        }
      ),
      view: (state, context) =>
        writingView(
          state,
          context,
          composerRows(
            state.composer.input.document,
            context.terminalSize.columns,
            context.terminalSize.rows
          ),
          writingConfigurationOperations(application)
        )
    });
  return app;
}

function update(
  state: WritingTuiState,
  message: WritingTuiMessage,
  app: WritingApplication,
  options: WritingTuiOptions
): Update {
  switch (message.type) {
    case 'terminal.resized':
      return { state };
    case 'session-name.open': {
      const sessionId = state.application.sessionId;
      if (sessionId === undefined || options.sessionNames === undefined)
        return { state: { ...state, notice: 'Start a conversation before naming it.' } };
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
        return { state: message.operation === 'write' ? { ...state, notice: message.error } : state };
      if (options.sessionNames === undefined) return { state };
      const result = updateSessionName(state.overlay.state, message, options.sessionNames);
      return { ...result, state: { ...state, overlay: { kind: 'session-name', state: result.state } } };
    }
    case 'queue.failed': {
      if (state.overlay.kind !== 'queue' || state.overlay.state.id !== message.id)
        return { state: message.operation === 'change' ? { ...state, notice: message.error } : state };
      const result = updateQueue(state.overlay.state, message, app);
      return { ...result, state: { ...state, overlay: { kind: 'queue', state: result.state } } };
    }
    case 'resource.accept': {
      if (state.resourceCompletion === undefined) return { state };
      return {
        state: {
          ...state,
          resourceCompletion: undefined,
          composer: {
            ...state.composer,
            input: acceptResource(state.resourceCompletion, state.composer.input, message.id)
          }
        }
      };
    }
    case 'resource.loaded':
    case 'resource.failed':
    case 'resource.move':
    case 'resource.close':
      return state.resourceCompletion === undefined
        ? { state }
        : {
            state: {
              ...state,
              resourceCompletion: updateResourceCompletion(state.resourceCompletion, message)
            },
            ...(message.type === 'resource.close' ? { cancelEffects: ['resource-search'] } : {})
          };
    case 'status.open':
      return update(
        state,
        {
          type: 'source.loaded',
          title: 'Session status',
          content: JSON.stringify(
            {
              configuration: app.modelSelection(),
              session: state.sessionView?.session,
              application: state.application
            },
            null,
            2
          )
        },
        app,
        options
      );
    case 'context.open': {
      const requestId = crypto.randomUUID();
      return {
        state: { ...state, overlay: { kind: 'loading', requestId } },
        effects: [
          {
            id: 'writing-context',
            concurrency: 'replace',
            async run({ signal }) {
              const context = await app.inspectContext();
              signal.throwIfAborted();
              return {
                kind: 'message',
                message: {
                  type: 'context.loaded',
                  requestId,
                  sessionId: state.application.sessionId ?? ':new',
                  content: JSON.stringify(
                    {
                      ...context,
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
      return state.overlay.kind !== 'loading' ||
        state.overlay.requestId !== message.requestId ||
        message.sessionId !== (state.application.sessionId ?? ':new')
        ? { state }
        : update(
            state,
            {
              type: 'source.loaded',
              title: 'Available context and admitted sources',
              content: message.content
            },
            app,
            options
          );
    case 'context.failed':
      return state.overlay.kind !== 'loading' || state.overlay.requestId !== message.requestId
        ? { state }
        : { state: { ...state, overlay: { kind: 'none' }, notice: message.message } };
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
              const file = await options.exportConversation(state.history, signal);
              const message = `Exported the loaded history pages to ${file}. Load older pages to extend coverage.`;
              return { kind: 'message', message: { type: 'notice', message } };
            },
            onError: ({ diagnostic }) => ({
              kind: 'message',
              message: { type: 'notice', message: diagnostic.message }
            })
          }
        ]
      };
    case 'inspector.open':
      return {
        state: {
          ...state,
          overlay: { kind: 'inspector', state: createSourceInspector(historyMessages(state)) }
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
      if (message.reference.boundary.sessionId !== state.application.sessionId) return { state };
      const inspector = updateSourceInspector(createSourceInspector([message.reference]), {
        type: 'inspector.pick',
        id: message.reference.id
      });
      return { state: { ...state, overlay: { kind: 'inspector', state: inspector } } };
    }
    case 'inspector.read': {
      if (state.overlay.kind !== 'inspector' || state.overlay.state.selected?.entry.kind !== 'reference')
        return { state };
      return {
        state,
        effects: [
          readSourceEntry(state.overlay.state, state.overlay.state.selected.entry, (boundary, entryId) =>
            app.readHistoryEntry(boundary, entryId)
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
      return { state: { ...state, notice: `Draft restoration failed: ${message.message}` } };
    case 'draft.loaded': {
      if (message.sessionId !== state.draftRestoreSession || message.draft === undefined) return { state };
      const original = state.composer;
      if (!sameDraft(original, message.original)) return { state };
      return { state: { ...state, composer: message.draft } };
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
      const result = updateAttachments(state.overlay.state, message, app);
      return { ...result, state: { ...state, overlay: { kind: 'attachments', state: result.state } } };
    }
    case 'recall.open': {
      const recall = createPromptRecall({
        ...state.promptHistory,
        entries: [
          ...promptsFromHistory(state.history.flatMap((page) => page.entries)),
          ...state.promptHistory.entries
        ]
      });
      return {
        state: { ...state, overlay: { kind: 'recall', state: recall } },
        ...(options.drafts === undefined
          ? {}
          : {
              effects: [
                loadRecoveredPrompts(options.drafts, state.application.sessionId ?? ':new', recall.id)
              ]
            })
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
        state: { ...state, overlay: { kind: 'none' }, composer: draft },
        focus: { kind: 'element', elementId: 'writing-composer' }
      };
    }
    case 'queue.open': {
      const result = createQueue(app, state.application.sessionId ?? ':new');
      return { ...result, state: { ...state, overlay: { kind: 'queue', state: result.state } } };
    }
    case 'queue.withdrawn': {
      const draft = draftFromSubmission(message.input);
      return {
        state: {
          ...state,
          promptHistory: rememberPrompt(state.promptHistory, draft),
          overlay:
            state.overlay.kind === 'queue' && state.overlay.state.id === message.id
              ? { kind: 'none' }
              : state.overlay,
          ...(message.sessionId === state.application.sessionId &&
          textDocumentText(state.composer.input.document).length === 0 &&
          state.composer.attachments.length === 0
            ? { composer: draft }
            : {}),
          notice: 'Input removed from the queue. Its full draft is available in /drafts.'
        },
        effects: [
          recoverDraft(
            options.drafts,
            message.sessionId,
            draft,
            (message): WritingTuiMessage => ({ type: 'notice', message })
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
      if (state.overlay.kind !== 'queue') return { state };
      const result = updateQueue(state.overlay.state, message, app);
      return { ...result, state: { ...state, overlay: { kind: 'queue', state: result.state } } };
    }
    case 'terminal.focus':
      return { state: { ...state, attention: { ...state.attention, focused: message.focused } } };
    case 'commands.open': {
      const entries = WRITING_COMMANDS.map((command) => ({
        id: command.name,
        label: `${command.name}  ${command.description}`
      }));
      return {
        state: {
          ...state,
          overlay: {
            kind: 'picker',
            subject: 'commands',
            entries,
            picker: createSearchPickerState({ query: { text: '', mode: 'fuzzy' } }, pickerIndex(entries))
          }
        }
      };
    }
    case 'preferences.scroll':
      return { state: { ...state, offsets: { ...state.offsets, preferences: message.offset } } };
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
                (message): WritingTuiMessage => ({ type: 'notice', message })
              )
            ]
          };
    case 'tools.toggle':
    case 'reasoning.toggle': {
      const key = message.type === 'reasoning.toggle' ? 'showReasoning' : 'showTools';
      const preferences = { ...state.preferences, [key]: !state.preferences[key] };
      return {
        state: { ...state, preferences },
        effects: [
          savePreferences(
            preferences,
            options.presentation,
            (message): WritingTuiMessage => ({ type: 'notice', message })
          )
        ]
      };
    }
    case 'completion.close':
      return { state: { ...state, completion: undefined } };
    case 'completion.move':
      return state.completion === undefined
        ? { state }
        : { state: { ...state, completion: moveCommand(state.completion, message.delta) } };
    case 'completion.accept': {
      const name = message.name ?? state.completion?.names[state.completion.selected];
      const command = WRITING_COMMANDS.find((entry) => entry.name === name);
      const completion = state.completion;
      if (command === undefined || completion?.input !== state.composer.input) return { state };
      const next = {
        ...state,
        composer: {
          ...state.composer,
          input: insertCommand(completion, state.composer.input, message.open ? '' : command.name)
        },
        completion: undefined
      };
      return message.open ? update(next, command.message, app, options) : { state: next };
    }
    case 'source.copy':
      return {
        state,
        effects: [copySource(message.text, (message) => ({ type: 'notice', message }))]
      };
    case 'notes.open':
    case 'notes.listed':
    case 'notes.read':
    case 'notes.loaded':
    case 'notes.failed':
    case 'notes.edit':
    case 'notes.scroll': {
      if (message.type !== 'notes.open' && state.overlay.kind !== 'notes') return { state };
      const result = updateNotes(
        state.overlay.kind === 'notes' ? state.overlay.state : { offset: 0 },
        message,
        app
      );
      return {
        state: { ...state, overlay: { kind: 'notes', state: result.state } },
        ...(result.effects === undefined ? {} : { effects: result.effects })
      };
    }

    case 'search.open':
    case 'search.adjacent':
    case 'search.edit':
    case 'search.submit':
    case 'search.loaded':
    case 'search.failed':
    case 'search.jump':
    case 'search.jumped':
      return updateHistorySearch(state, message, app);
    case 'recovery.open':
      return {
        state,
        effects: [
          effect('writing-recovery-read', async () => ({
            type: 'recovery.loaded',
            session: await app.readSession()
          }))
        ]
      };
    case 'recovery.loaded':
      return {
        state: {
          ...state,
          sessionView: message.session,
          overlay: {
            kind: message.session.session.suspension === undefined ? 'none' : 'recovery'
          }
        }
      };
    case 'recovery.resume':
    case 'recovery.abort':
    case 'recovery.choice': {
      const suspension = state.sessionView?.session.suspension;
      if (suspension === undefined) return { state };
      const decision = suspension.decisionRequest;
      if (message.type === 'recovery.choice' && decision === undefined) return { state };
      return {
        state,
        effects: [
          effect('writing-recovery-command', async () => {
            if (message.type === 'recovery.abort') await app.abort(suspension.runId);
            else if (message.type === 'recovery.resume') await app.resume(suspension.runId);
            else if (decision !== undefined)
              await app.decide({
                runId: suspension.runId,
                decisionRequestId: decision.id,
                choice: message.choice,
                fingerprint: decision.fingerprint,
                expectedRunRevision: decision.runRevision
              });
            return {
              type: 'recovery.loaded',
              session: await app.readSession()
            };
          })
        ]
      };
    }
    case 'recovery.approval':
      return {
        state,
        effects: [
          effect('writing-approval', async () => {
            await app.resolveApproval({
              runId: message.runId,
              approvalId: message.approvalId,
              fingerprint: message.fingerprint,
              decision: message.decision
            });
            return {
              type: 'recovery.loaded',
              session: await app.readSession()
            };
          })
        ]
      };
    case 'configuration.saved':
      if (state.overlay.kind !== 'configuration' || state.overlay.state.id !== message.id) return { state };

      return {
        state: { ...state, overlay: { kind: 'none' } },
        effects: [refresh(app, state.document?.value.path)]
      };
    case 'section.scroll':
      return {
        state: {
          ...state,
          offsets: {
            ...state.offsets,
            [message.id]: message.request.nextState.offsetRow
          }
        }
      };
    case 'source.loaded':
      return {
        state: {
          ...state,
          source: {
            title: message.title,
            input: createTextAreaState({ value: message.content })
          },
          overlay: { kind: 'source' }
        }
      };
    case 'source.edit':
      return state.source === undefined
        ? { state }
        : {
            state: {
              ...state,
              source: {
                ...state.source,
                input: textAreaReducer(state.source.input, message.transition).state
              }
            }
          };
    case 'refresh':
      return { state, effects: [refresh(app, state.document?.value.path)] };
    case 'loaded': {
      const result = loadView(state, message, app);
      const sessionId = message.history.boundary.sessionId;
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
    case 'application':
      return { state: { ...state, application: message.state } };
    case 'notice':
      return {
        state: { ...state, notice: message.message, submitting: false }
      };
    case 'tool.toggle':
      return {
        state: {
          ...state,
          expandedTools: state.expandedTools.includes(message.id)
            ? state.expandedTools.filter((id) => id !== message.id)
            : [...state.expandedTools, message.id]
        }
      };
    case 'progress': {
      const event = message.event;
      const next = {
        ...state,
        progress: presentProgress(state.progress, event),
        liveConversation: mergeConversationEntries(
          state.liveConversation,
          projectProgress(message, state.liveConversation)
        ),
        unread: state.unread || !state.followTail
      };
      if (event.type === 'assistant.interrupted' || event.type === 'model.failed') {
        const failure =
          event.diagnostic === undefined ? 'Response interrupted.' : providerFailureText(event.diagnostic);
        return { state: { ...next, failure, notice: failure } };
      }
      return { state: next };
    }
    case 'result':
      return {
        state: {
          ...state,
          result: message.result,
          notice:
            message.result.state === 'suspended'
              ? (state.failure ?? suspensionPresentation(message.result.reason).explanation)
              : message.result.terminal.executionStatus === 'failed'
                ? message.result.terminal.errorMessage
                : `Run ${message.result.terminal.executionStatus}`
        },
        effects: [
          refresh(
            app,
            state.document?.value.path,
            message.result.state === 'ended' ? message.result.terminal.runId : undefined
          )
        ]
      };
    case 'mode.toggle':
      return {
        state,
        effects: [
          effect('writing-mode', async () => {
            await app.setMode(state.application.mode === 'edit' ? 'review' : 'edit');
            return { type: 'refresh' };
          })
        ]
      };
    case 'session.new':
      return {
        state,
        effects: [
          effect('writing-new-session', async () => {
            await app.newSession();
            return { type: 'refresh' };
          })
        ]
      };
    case 'prompt.navigate': {
      const result = navigatePromptHistory(
        state.promptHistory,
        state.composer,
        message.direction === 'older' ? 'previous' : 'next'
      );
      return {
        state: { ...state, promptHistory: result.history, composer: result.draft, completion: undefined }
      };
    }
    case 'composer.edit': {
      const composer = textAreaReducer(state.composer.input, message.transition).state;
      const resourceCompletion = completeResource(composer, message.transition, state.resourceCompletion);
      return {
        state: {
          ...state,
          composer: { ...state.composer, input: composer },
          resourceCompletion,
          completion: completeCommand(composer, message.transition, WRITING_COMMANDS)
        },
        ...(resourceCompletion === undefined
          ? { cancelEffects: ['resource-search'] }
          : {
              effects: [
                searchResources(resourceCompletion, {
                  async search(query, signal) {
                    signal.throwIfAborted();
                    const slash = query.lastIndexOf('/');
                    const documents = await app.listDocuments(
                      slash < 0 ? '.' : query.slice(0, slash) || '.'
                    );
                    signal.throwIfAborted();
                    return documents
                      .filter((item) => item.path.startsWith(query))
                      .map((item) => {
                        const target = item.type === 'directory' ? `${item.path}/` : item.path;
                        return {
                          id: target,
                          label: target,
                          insertion: `@${/\s/u.test(target) ? JSON.stringify(target) : target}${item.type === 'directory' ? '' : ' '}`
                        };
                      });
                  }
                })
              ]
            })
      };
    }
    case 'document.edit':
      return state.document === undefined
        ? { state }
        : {
            state: {
              ...state,
              document: {
                ...state.document,
                input: textAreaReducer(state.document.input, message.transition).state
              }
            }
          };
    case 'submit': {
      if (message.delivery === 'steer' && state.sessionView?.session.activeRunId === undefined)
        return {
          state: {
            ...state,
            notice: 'There is no active run to steer. Send this draft as a new input or follow-up.'
          }
        };
      const draft = state.composer;
      const original = textDocumentText(state.composer.input.document);
      const sessionId = state.application.sessionId ?? ':new';
      if (state.submitting || !original.trim()) return { state };
      if (state.application.status === 'configuration_required')
        return update(state, { type: 'configuration.open' }, app, options);
      const command = !original.includes('\n')
        ? WRITING_COMMANDS.find((entry) => entry.name === original.trim())
        : undefined;
      if (command !== undefined)
        return update(
          { ...state, composer: { ...state.composer, input: createDraft().input }, completion: undefined },
          command.message,
          app,
          options
        );
      if (state.sessionView?.session.suspension !== undefined)
        return { state: { ...state, overlay: { kind: 'recovery' } } };
      return {
        state: { ...withoutFailure(state), submitting: true },
        effects: [
          {
            ...effect('writing-submit', async () => {
              const result = await app.submit(
                draftSubmission(draft),
                message.delivery === undefined
                  ? {}
                  : {
                      delivery: message.delivery,
                      ...(message.delivery === 'steer' &&
                      state.sessionView?.session.activeRunId !== undefined
                        ? { expectedRunId: state.sessionView.session.activeRunId }
                        : {})
                    }
              );
              if (result.kind === 'rejected')
                return { type: 'submitted', sessionId, draft, receipt: result };
              const { completion, ...receipt } = result;
              void completion.catch(() => undefined);
              return { type: 'submitted', sessionId, draft, receipt };
            }),
            onError: ({ diagnostic }) => ({
              kind: 'message',
              message: { type: 'submission.failed', sessionId, message: diagnosticMessage(diagnostic) }
            })
          }
        ]
      };
    }
    case 'submission.failed': {
      if (message.sessionId !== (state.application.sessionId ?? ':new'))
        return { state: { ...state, notice: `Session ${message.sessionId}: ${message.message}` } };
      return { state: { ...state, submitting: false, notice: message.message } };
    }
    case 'submitted': {
      if (message.sessionId !== (state.application.sessionId ?? ':new')) {
        const saved = state.sessionViews[message.sessionId];
        return {
          state: {
            ...state,
            ...(message.receipt.kind === 'rejected'
              ? {
                  notice: `Session ${message.sessionId}: input rejected (${message.receipt.reason.replaceAll('_', ' ')}).`
                }
              : {}),
            ...(message.receipt.kind === 'rejected' ||
            saved === undefined ||
            !sameDraft(saved.composer, message.draft)
              ? {}
              : {
                  sessionViews: {
                    ...state.sessionViews,
                    [message.sessionId]: { ...saved, composer: createDraft() }
                  },
                  promptHistory: rememberPrompt(state.promptHistory, message.draft)
                })
          }
        };
      }
      const accepted = message.receipt.kind !== 'rejected';
      const receipt = message.receipt;
      const images = message.draft.attachments.flatMap((attachment) =>
        attachment.kind === 'image' ? [attachment.image] : []
      );
      const insert =
        receipt.kind === 'steered'
          ? (
              entries: readonly import('@agent-core/tui').ConversationEntry[],
              input: import('@agent-core/tui').ConversationUserEntry
            ) => mergeConversationEntries(entries, [input])
          : insertAcceptedInput;
      const liveConversation =
        receipt.kind === 'rejected' || receipt.kind === 'queued'
          ? state.liveConversation
          : insert(state.liveConversation, {
              kind: 'user',
              id:
                receipt.kind === 'steered' ? `steering:${receipt.submissionId}` : `input:${receipt.runId}`,
              runId: receipt.runId,
              text: textDocumentText(message.draft.input.document),
              ...(images.length === 0 ? {} : { images })
            });
      return {
        state: {
          ...state,
          submitting: false,
          liveConversation,
          promptHistory: accepted
            ? rememberPrompt(state.promptHistory, message.draft)
            : state.promptHistory,
          notice:
            state.failure ??
            (receipt.kind === 'rejected'
              ? `Input rejected: ${receipt.reason.replaceAll('_', ' ')}`
              : `Input ${receipt.kind}`),
          composer: accepted && sameDraft(state.composer, message.draft) ? createDraft() : state.composer
        }
      };
    }
    case 'view':
      return { state: { ...state, view: message.view } };
    case 'document.toggle-source':
      return state.document === undefined
        ? { state }
        : {
            state: {
              ...state,
              view: 'document',
              document: { ...state.document, source: !state.document.source }
            },
            focus: {
              kind: 'element',
              elementId: state.document.source ? 'writing-composer' : 'writing-document-source'
            }
          };
    case 'document.use-passage': {
      const selected = selectedSource(state.document?.input);
      if (selected === undefined || !state.document)
        return {
          state: {
            ...state,
            notice: 'Select text in the document source first.'
          }
        };
      const item: import('@agent-core/runtime').PromptContextItemInput = {
        id: `passage:${crypto.randomUUID()}`,
        title: state.document.value.path,
        sourceKind: 'user',
        sourceUri: pathToFileURL(path.join(state.application.workspace, state.document.value.path)).href,
        integrity: 'verified',
        representation: 'excerpt',
        mediaType: 'text/plain',
        content: selected,
        purpose: 'Document passage explicitly selected by the user.'
      };
      return {
        state: {
          ...state,
          view: 'conversation',
          composer: {
            ...state.composer,
            attachments: [
              ...state.composer.attachments,
              { kind: 'context', id: crypto.randomUUID(), label: item.title, item }
            ]
          }
        },
        focus: { kind: 'element', elementId: 'writing-composer' }
      };
    }
    case 'document.scroll':
      return state.document === undefined
        ? { state }
        : {
            state: {
              ...state,
              document: {
                ...state.document,
                offsetRow: message.request.nextState.offsetRow
              }
            }
          };
    case 'conversation.message': {
      const anchor = state.presentation.adjacentMessage(
        state.followTail ? 'end' : (state.conversationAnchor ?? state.conversationOffset),
        message.direction
      );
      return anchor === undefined
        ? update(
            state,
            { type: 'history.load', direction: message.direction === 'previous' ? 'older' : 'newer' },
            app,
            options
          )
        : { state: { ...state, view: 'conversation', followTail: false, conversationAnchor: anchor } };
    }
    case 'conversation.scroll': {
      const rest = { ...state };
      delete rest.conversationAnchor;
      return {
        state: {
          ...rest,
          conversationOffset: message.request.nextState.offsetRow,
          followTail: message.request.nextState.followTail
        }
      };
    }
    case 'picker.open':
      return openPicker(state, message.subject, app, options.sessionNames);
    case 'picker.loaded':
      if (state.overlay.kind !== 'loading' || state.overlay.requestId !== message.requestId)
        return { state };
      return {
        state: {
          ...state,
          overlay: {
            kind: 'picker',
            subject: message.subject,
            entries: message.entries,
            picker: createSearchPickerState(
              { query: { text: '', mode: 'fuzzy' } },
              pickerIndex(message.entries)
            )
          }
        },
        focus: { kind: 'element', elementId: 'writing-picker' }
      };
    case 'picker.transition':
      return state.overlay.kind !== 'picker'
        ? { state }
        : {
            state: {
              ...state,
              overlay: {
                ...state.overlay,
                picker:
                  state.overlay.subject === 'commands'
                    ? transitionCommandPicker(
                        state.overlay.picker,
                        message.transition,
                        pickerIndex(state.overlay.entries),
                        WRITING_COMMANDS
                      )
                    : searchPickerReducer(state.overlay.picker, message.transition, {
                        searchPickerIndex: pickerIndex(state.overlay.entries)
                      })
              }
            }
          };
    case 'picker.accept':
      return acceptPicker(state, message.id, app, options);
    case 'document.loaded':
      return {
        state: {
          ...state,
          document: documentState(message.document),
          view: 'document',
          overlay: { kind: 'none' },
          notice: ''
        }
      };
    case 'configuration.open':
      return {
        state: {
          ...state,
          overlay: {
            kind: 'configuration',
            state: configurationState(app.modelSelection(), writingConfigurationOperations(app).providers)
          }
        }
      };
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
      if (state.overlay.kind !== 'configuration') return { state };
      const result = updateConfiguration(state.overlay.state, message, writingConfigurationOperations(app));
      return { ...result, state: { ...state, overlay: { kind: 'configuration', state: result.state } } };
    }
    case 'history.load': {
      const cursor = message.direction === 'older' ? state.history[0]?.older : state.history.at(-1)?.newer;
      if (message.direction === 'older' && cursor === undefined) return { state };
      const direction = cursor === undefined ? 'tail' : message.direction;
      const requestId = crypto.randomUUID();
      return {
        state: { ...state, historyRequestId: requestId },
        effects: [
          {
            ...effect('writing-history', async () => ({
              type: 'history.loaded',
              requestId,
              pages: [
                await app.readHistory(
                  direction === 'tail' || cursor === undefined ? undefined : { cursor, direction }
                )
              ],
              direction
            })),
            concurrency: 'replace',
            onError: ({ diagnostic }) => ({
              kind: 'message',
              message: {
                type: 'history.failed',
                requestId,
                message: diagnosticMessage(diagnostic)
              }
            })
          }
        ]
      };
    }
    case 'history.failed': {
      if (message.requestId !== state.historyRequestId) return { state };
      const next = { ...state, notice: message.message };
      delete next.historyRequestId;
      return { state: next };
    }
    case 'history.loaded': {
      if (
        message.requestId !== state.historyRequestId ||
        message.pages[0]?.boundary.sessionId !== state.application.sessionId
      )
        return { state };
      const rest = { ...state };
      delete rest.conversationAnchor;
      delete rest.historyRequestId;
      const anchor =
        message.direction === 'tail'
          ? undefined
          : (state.conversationAnchor ?? state.presentation.anchor(state.conversationOffset));
      return {
        state: {
          ...rest,
          history:
            message.direction === 'tail' || message.direction === 'restore'
              ? message.pages
              : message.direction === 'older'
                ? [...message.pages, ...state.history].slice(0, 3)
                : [...state.history, ...message.pages].slice(-3),
          conversationOffset: 0,
          followTail: message.direction === 'tail',
          unread: message.direction === 'tail' ? false : state.unread,
          ...(anchor === undefined ? {} : { conversationAnchor: anchor }),
          view: message.direction === 'restore' ? state.view : 'conversation'
        }
      };
    }
    case 'external-editor': {
      const draft = state.composer;
      const original = textDocumentText(state.composer.input.document);
      return {
        state,
        effects: [
          {
            id: 'writing-external-editor',
            concurrency: 'keep-first',
            async run(context) {
              const text = await context.withTerminalSuspended(() =>
                (options.externalEditor ?? editTextExternally)(original, context.signal)
              );
              return {
                kind: 'message',
                message: {
                  type: 'external-edited',
                  sessionId: state.application.sessionId ?? ':new',
                  draft,
                  text
                }
              };
            },
            onError: ({ diagnostic }) => ({
              kind: 'message',
              message: {
                type: 'notice',
                message: diagnosticMessage(diagnostic)
              }
            })
          }
        ]
      };
    }
    case 'external-edited': {
      const draft = { ...message.draft, input: createDraft(message.text).input };
      const current =
        message.sessionId === (state.application.sessionId ?? ':new') &&
        sameDraft(state.composer, message.draft);
      return {
        state: current
          ? { ...state, composer: draft }
          : {
              ...state,
              promptHistory: rememberPrompt(state.promptHistory, draft),
              notice: 'External edit retained in /drafts; the current input was preserved.'
            },
        ...(current
          ? {}
          : {
              effects: [
                recoverDraft(
                  options.drafts,
                  message.sessionId,
                  draft,
                  (message): WritingTuiMessage => ({ type: 'notice', message })
                )
              ]
            }),
        focus: { kind: 'element', elementId: 'writing-composer' }
      };
    }
    case 'interrupt':
      return ['running', 'suspended'].includes(state.application.status)
        ? {
            state,
            effects: [
              effect('writing-interrupt', async () => {
                await app.abort();
                return { type: 'notice', message: 'Interruption requested.' };
              })
            ]
          }
        : {
            state: {
              ...state,
              notice: 'No active run. Your draft is preserved.'
            }
          };
    case 'overlay.close':
      return {
        state: { ...state, overlay: { kind: 'none' } },
        cancelEffects: [
          'model-configuration',
          'configuration-browser',
          'model-notes-read',
          'writing-picker',
          'writing-context',
          'writing-search-jump',
          'source-entry-read',
          'attachment-read',
          'session-name-load'
        ]
      };
    case 'exit':
      return { state, exit: { reason: 'user' } };
  }
}

function refresh(
  app: WritingApplication,
  resourceId?: string,
  recordedRunId?: string
): TuiEffect<WritingTuiMessage> {
  return {
    ...effect('writing-refresh', async () => ({
      ...(await readView(app, resourceId)),
      ...(recordedRunId === undefined ? {} : { recordedRunId })
    })),
    concurrency: 'enqueue'
  };
}
async function readView(
  app: WritingApplication,
  resourceId?: string
): Promise<Extract<WritingTuiMessage, { type: 'loaded' }>> {
  await app.start();
  const document =
    resourceId === undefined
      ? undefined
      : await app.readDocument(resourceId).then(
          (value) => ({ kind: 'available' as const, value }),
          (error: unknown) => ({
            kind: 'unavailable' as const,
            message: error instanceof Error ? error.message : String(error)
          })
        );
  const application = app.state();
  return {
    type: 'loaded',
    application,
    ...(document === undefined ? {} : { document }),
    history: await app.readHistory(),
    ...(application.status === 'configuration_required' ? {} : { session: await app.readSession() })
  };
}
function effect(id: string, action: () => Promise<WritingTuiMessage>): TuiEffect<WritingTuiMessage> {
  return {
    id,
    concurrency: 'keep-first',
    async run() {
      return { kind: 'message', message: await action() };
    },
    onError: ({ diagnostic }) => ({
      kind: 'message',
      message: { type: 'notice', message: diagnosticMessage(diagnostic) }
    })
  };
}
function documentState(
  value: WritingDocument,
  previous?: WritingTuiState['document']
): NonNullable<WritingTuiState['document']> {
  if (previous?.value.path === value.path && previous.value.sha256 === value.sha256)
    return { ...previous, value };
  return {
    value,
    input: createTextAreaState({ value: value.content }),
    markdown: new MarkdownDocument(value.content),
    source: previous?.source ?? false,
    offsetRow: previous?.offsetRow ?? 0
  };
}
function openPicker(
  state: WritingTuiState,
  subject: Extract<WritingTuiMessage, { type: 'picker.open' }>['subject'],
  app: WritingApplication,
  names?: import('@agent-core/tui').SessionNames
): Update {
  const requestId = crypto.randomUUID();
  return {
    state: { ...state, overlay: { kind: 'loading', requestId } },
    effects: [
      {
        ...effect('writing-picker', async () => {
          const entries: { id: string; label: string }[] =
            subject === 'resources'
              ? (await app.listDocuments(state.directory)).map((entry) => ({
                  id: entry.path + (entry.type === 'directory' ? '/' : ''),
                  label: entry.path + (entry.type === 'directory' ? '/' : '')
                }))
              : subject === 'outline'
                ? [...flattenOutline(state.document?.markdown.outline() ?? [])]
                : [
                    { id: ':new', label: 'New conversation' },
                    ...(await Promise.all(
                      (await app.listSessions()).map(async (session) => ({
                        id: session.id,
                        label: `${session.id === state.application.sessionId ? '✓ ' : ''}${(await names?.read(session.id)) ?? session.preview ?? session.id} · ${session.updatedAt}`
                      }))
                    ))
                  ];
          if (subject === 'resources' && state.directory !== '.')
            entries.unshift({
              id: state.directory.split('/').slice(0, -1).join('/') + '/',
              label: '../'
            });
          return { type: 'picker.loaded', requestId, subject, entries };
        }),
        concurrency: 'replace'
      }
    ]
  };
}
function flattenOutline(
  outline: ReturnType<MarkdownDocument['outline']>
): readonly { readonly id: string; readonly label: string }[] {
  return outline.flatMap((heading) => [
    {
      id: String(heading.span.start),
      label: `${'  '.repeat(heading.depth - 1)}${heading.text}`
    },
    ...flattenOutline(heading.children)
  ]);
}
function acceptPicker(
  state: WritingTuiState,
  id: string,
  app: WritingApplication,
  options: WritingTuiOptions
): Update {
  if (state.overlay.kind !== 'picker' || !state.overlay.entries.some((entry) => entry.id === id))
    return { state };
  switch (state.overlay.subject) {
    case 'commands': {
      const command = WRITING_COMMANDS.find((entry) => entry.name === id);
      return command === undefined
        ? { state }
        : update({ ...state, overlay: { kind: 'none' } }, command.message, app, options);
    }
    case 'outline':
      return state.document === undefined
        ? { state }
        : {
            state: {
              ...state,
              view: 'document',
              overlay: { kind: 'none' },
              document: {
                ...state.document,
                source: true,
                input: {
                  ...state.document.input,
                  caret: {
                    position: { offset: Number(id), affinity: 'downstream' }
                  },
                  revealCaret: true
                }
              }
            },
            focus: { kind: 'element', elementId: 'writing-document-source' }
          };
    case 'resources':
      if (id.endsWith('/'))
        return openPicker(
          { ...state, directory: id.slice(0, -1) || '.' },
          'resources',
          app,
          options.sessionNames
        );
      return {
        state,
        effects: [
          effect('writing-document', async () => ({
            type: 'document.loaded',
            document: await app.readDocument(id)
          }))
        ]
      };
    case 'sessions':
      return {
        state: { ...state, overlay: { kind: 'none' } },
        effects: [
          effect('writing-session', async () => {
            if (id === ':new') await app.newSession();
            else await app.selectSession(id);
            return { type: 'refresh' };
          })
        ]
      };
  }
}
export function writingConfigurationOperations(app: WritingApplication): ConfigurationOperations {
  return {
    providers: WRITING_PROVIDER_IDS.map((id) => ({ id, label: id })),
    openBrowser,
    connect: (provider, endpoint) => app.connectProvider(provider, endpoint),
    save: (selection, provider) => app.configureModel(selection, provider)
  };
}

function binding(
  label: string,
  key: Extract<InputTrigger, { kind: 'key' }>['key'],
  message: WritingTuiMessage,
  modifiers: Extract<InputTrigger, { kind: 'key' }>['modifiers'] = {}
) {
  return {
    id: label,
    label,
    triggers: [{ kind: 'key' as const, key, modifiers }],
    phase: 'beforeFocus' as const,
    message,
    enabled: ({ state }: { state: WritingTuiState }) => state.overlay.kind === 'none'
  };
}

function loadView(
  state: WritingTuiState,
  message: Extract<WritingTuiMessage, { type: 'loaded' }>,
  app: WritingApplication
): Update {
  if (message.application.sessionId !== app.state().sessionId) return { state };
  const previousSession = state.history.at(-1)?.boundary.sessionId;
  const switched = previousSession !== undefined && previousSession !== message.history.boundary.sessionId;
  let next = state;
  if (switched) {
    const sessionViews = {
      ...state.sessionViews,
      [previousSession]: {
        composer: state.composer,
        view: state.view,
        bookmark: historyBookmark(
          state.history,
          state.conversationAnchor ?? state.presentation.anchor(state.conversationOffset),
          state.followTail,
          sessionConversationId
        )
      }
    };
    const saved = sessionViews[message.history.boundary.sessionId];
    next = {
      ...state,
      sessionViews,
      composer: saved?.composer ?? createDraft(),
      view: saved?.view ?? 'conversation',
      history: [],
      liveConversation: [],
      progress: { label: 'Ready' },
      expandedTools: [],
      followTail: saved?.bookmark.followTail ?? true,
      conversationOffset: 0,
      unread: false
    };
    const cleared = { ...next };
    delete cleared.conversationAnchor;
    delete cleared.historyRequestId;
    delete cleared.result;
    delete cleared.sessionView;
    delete cleared.failure;
    next = cleared;
    if (saved?.bookmark.anchor !== undefined) next = { ...next, conversationAnchor: saved.bookmark.anchor };
  }
  next = {
    ...next,
    application: message.application,
    liveConversation:
      message.recordedRunId === undefined
        ? next.liveConversation
        : next.liveConversation.filter((entry) => entry.runId !== message.recordedRunId),
    ...(message.session === undefined ? {} : { sessionView: message.session }),
    history: next.followTail || switched || next.history.length === 0 ? [message.history] : next.history,
    unread:
      !next.followTail &&
      !switched &&
      (next.unread || next.history.at(-1)?.boundary.leafId !== message.history.boundary.leafId),
    ...(message.document?.kind === 'available'
      ? { document: documentState(message.document.value, next.document) }
      : {})
  };
  if (message.document?.kind === 'unavailable') {
    const updated = { ...next, notice: message.document.message };
    delete updated.document;
    next = updated;
  }
  const cursor = switched
    ? next.sessionViews[message.history.boundary.sessionId]?.bookmark.cursor
    : undefined;
  if (cursor === undefined) return { state: next };
  const requestId = crypto.randomUUID();
  return {
    state: { ...next, historyRequestId: requestId },
    effects: [
      {
        ...effect('writing-history', async () => {
          const pages = [await app.readHistory({ cursor, direction: 'newer' })];
          while (pages.length < 3) {
            const next = pages.at(-1)?.newer;
            if (next === undefined) break;
            pages.push(await app.readHistory({ cursor: next, direction: 'newer' }));
          }
          return {
            type: 'history.loaded',
            requestId,
            direction: 'restore',
            pages
          };
        }),
        concurrency: 'replace',
        onError: ({ diagnostic }) => ({
          kind: 'message',
          message: {
            type: 'history.failed',
            requestId,
            message: diagnosticMessage(diagnostic)
          }
        })
      }
    ]
  };
}

function copyInput(state: WritingTuiState, focusPath?: readonly string[]) {
  if (state.overlay.kind === 'inspector') return state.overlay.state.selected?.input;
  return state.overlay.kind === 'source'
    ? state.source?.input
    : state.overlay.kind === 'notes'
      ? state.overlay.state.source?.input
      : state.overlay.kind !== 'none'
        ? undefined
        : focusPath?.includes('writing-composer')
          ? state.composer.input
          : focusPath?.includes('writing-document-source')
            ? state.document?.input
            : selectedSource(state.composer.input) !== undefined
              ? state.composer.input
              : state.document?.input;
}

function withoutFailure(state: WritingTuiState): WritingTuiState {
  const updated = { ...state };
  delete updated.failure;
  return updated;
}

function withAttention(result: Update, message: WritingTuiMessage, options: WritingTuiOptions): Update {
  const event =
    message.type === 'result'
      ? message.result.state === 'ended'
        ? `${message.result.terminal.runId}:ended`
        : message.result.reason === 'approval_required'
          ? `${message.result.runId}:approval:${message.result.pendingApprovals.map((request) => request.approvalId).join(',')}`
          : `${message.result.runId}:${message.result.reason}:${message.result.decisionRequest?.id ?? message.result.effectId ?? ''}`
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
                message: { type: 'notice', message: diagnostic.message }
              })
            }
          ]
        }
      : {})
  };
}

import {
  MarkdownDocument,
  composerRows,
  copySource,
  diagnosticMessage,
  editTextExternally,
  historyBookmark,
  selectedSource,
  updateNotes
} from '@agents/tui';
import {
  createSearchPickerState,
  createTextAreaState,
  searchPickerReducer,
  textAreaReducer
} from '@ismail-elkorchi/terminal-ui/behavior';
import type { InputTrigger } from '@ismail-elkorchi/terminal-ui/input';
import { ignoreMessage } from '@ismail-elkorchi/terminal-ui/interaction';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import type {
  TuiEffect,
  TuiEventSource,
  TuiInputBindingContext,
  TuiUpdateResult
} from '@ismail-elkorchi/terminal-ui/tui';
import { defineTui, tuiBindingHelp } from '@ismail-elkorchi/terminal-ui/tui';
import { formatKeyboardBinding } from '@ismail-elkorchi/terminal-ui/interaction';
import type { WritingApplication, WritingDocument } from '../application/service.js';
import { writingOperationKindSchema } from '../domain.js';
import { createWritingProvider, parseWritingProviderId } from '../provider.js';
import { rangeFromOffsets } from '../text-ranges.js';
import { pickerIndex } from './picker.js';
import { updateHistorySearch } from './search.js';
import {
  initialWritingState,
  type WritingTuiMessage,
  type WritingTuiOverlay,
  type WritingTuiState
} from './state.js';
import { writingView } from './view.js';

type Update = TuiUpdateResult<WritingTuiState, WritingTuiMessage>;
export interface WritingTuiOptions {
  readonly events?: TuiEventSource<WritingTuiMessage>;
  readonly externalEditor?: (text: string, signal: AbortSignal) => Promise<string>;
}

export function createWritingAgentTuiApp(application: WritingApplication, options: WritingTuiOptions = {}) {
  let help = '';
  const events = options.events;
  const app = defineTui<WritingTuiState, WritingTuiMessage>({
    id: 'writing-agent',
    init: () => ({
      state: initialWritingState(application.state()),
      effects: [refresh(application)],
      focus: { kind: 'element', elementId: 'writing-composer' }
    }),
    update: (state, message) => update(state, message, application, options),
    ...(events === undefined ? {} : { subscriptions: () => [events] }),
    inputBindings: [
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
      binding('Model notes', 'n', { type: 'notes.open' }, { alt: true }),
      {
        id: 'Help',
        label: 'Help',
        triggers: [{ kind: 'key', key: 'f1' }],
        phase: 'beforeFocus',
        enabled: ({ state }: TuiInputBindingContext<WritingTuiState>) => state.overlay.kind === 'none',
        toMessage: () => ({ type: 'source.loaded', title: 'Keyboard controls', content: help })
      },
      binding('Resources', 'f2', { type: 'picker.open', subject: 'resources' }),
      binding('Outline', 'f3', { type: 'picker.open', subject: 'outline' }),
      binding('Document source', 'f4', { type: 'document.toggle-source' }),
      binding('Conversation', 'f5', { type: 'view', view: 'conversation' }),
      binding('Proposals', 'f6', { type: 'picker.open', subject: 'proposals' }),
      binding('Sources', 'f7', { type: 'view', view: 'sources' }),
      binding('Use selected passage', 'f8', { type: 'document.use-passage' }),
      binding('Operation kind', 'f9', { type: 'picker.open', subject: 'operation' }),
      binding('Model configuration', 'f10', { type: 'form.open', subject: 'configure' }),
      binding('Sessions', 'f11', { type: 'picker.open', subject: 'sessions' }),
      binding('Recovery', 'f12', { type: 'recovery.open' }),
      {
        ...binding('Find matches', 'enter', { type: 'search.submit', more: false }),
        enabled: ({ state }: TuiInputBindingContext<WritingTuiState>) => state.overlay.kind === 'search'
      },
      binding('Search history', 'f', { type: 'search.open' }, { ctrl: true }),
      binding('Saved drafts', 'd', { type: 'picker.open', subject: 'drafts' }, { alt: true }),
      binding('External instruction editor', 'e', { type: 'external-editor' }, { ctrl: true }),
      binding('Older history', 'pageUp', { type: 'history.load', direction: 'older' }, { ctrl: true }),
      binding('Newer history', 'pageDown', { type: 'history.load', direction: 'newer' }, { ctrl: true }),
      binding('Latest history', 'end', { type: 'history.load', direction: 'tail' }, { ctrl: true }),
      {
        ...binding('Interrupt', 'c', { type: 'interrupt' }, { ctrl: true }),
        enabled: ({ state, focusPath }: TuiInputBindingContext<WritingTuiState>) => {
          const input = focusPath?.includes('writing-composer')
            ? state.composer
            : focusPath?.includes('writing-document-source')
              ? state.document?.input
              : focusPath?.includes('writing-source-reader')
                ? state.source?.input
                : undefined;
          return (
            state.overlay.kind === 'none' &&
            (input?.selection === undefined || input.selection.anchor.offset === input.selection.focus.offset)
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
          { key: 'o', modifiers: { ctrl: true } }
        ] as const
      ).map(({ key, modifiers }) => ({
        ...binding(
          `New line (${key})`,
          key,
          { type: 'composer.edit', transition: { kind: 'edit', operation: { kind: 'insert', text: '\n' } } },
          modifiers
        ),
        enabled: ({ state, focusPath }: TuiInputBindingContext<WritingTuiState>) =>
          state.overlay.kind === 'none' && (focusPath?.includes('writing-composer') ?? false)
      }))
    ],
    view: (state, context) =>
      writingView(
        state,
        context,
        composerRows(state.composer.document, context.terminalSize.columns, context.terminalSize.rows)
      )
  });
  help = tuiBindingHelp(app)
    .map(
      (item) =>
        `${item.bindings.map((binding) => formatKeyboardBinding(binding.binding)).join(' / ')}  ${item.label}`
    )
    .join('\n');
  return app;
}

function update(
  state: WritingTuiState,
  message: WritingTuiMessage,
  app: WritingApplication,
  options: WritingTuiOptions
): Update {
  switch (message.type) {
    case 'source.copy':
      return { state, effects: [copySource(message.text, (message) => ({ type: 'notice', message }))] };
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
    case 'search.edit':
    case 'search.submit':
    case 'search.loaded':
    case 'search.failed':
    case 'search.jump':
    case 'search.jumped':
      return updateHistorySearch(state, message, app);
    case 'proposal.source': {
      const comparison = state.proposal?.comparisons.find(
        (comparison) => comparison.resourceId === message.resourceId
      );
      return comparison === undefined
        ? { state }
        : {
            state: {
              ...state,
              source: {
                title: `${comparison.path} · ${message.side}`,
                input: createTextAreaState({
                  value: message.side === 'original' ? comparison.before : comparison.after
                })
              },
              overlay: { kind: 'source' }
            }
          };
    }
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
      return { state: { ...state, sessionView: message.session, overlay: { kind: 'recovery' } } };
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
            return { type: 'recovery.loaded', session: await app.readSession() };
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
            return { type: 'recovery.loaded', session: await app.readSession() };
          })
        ]
      };
    case 'form.completed':
      return {
        state: { ...state, overlay: { kind: 'none' } },
        effects: [refresh(app, state.document?.value.resource.resourceId)]
      };
    case 'section.scroll':
      return {
        state: { ...state, offsets: { ...state.offsets, [message.id]: message.request.nextState.offsetRow } }
      };
    case 'source.loaded':
      return {
        state: {
          ...state,
          source: { title: message.title, input: createTextAreaState({ value: message.content }) },
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
      return { state, effects: [refresh(app, state.document?.value.resource.resourceId)] };
    case 'loaded':
      return loadView(state, message, app);
    case 'application':
      return { state: { ...state, application: message.state } };
    case 'notice':
      return { state: { ...state, notice: message.message, submitting: false } };
    case 'progress': {
      const event = message.event;
      if (event.type === 'assistant.delta')
        return { state: { ...state, live: { turnId: event.turnId, content: event.accumulated } } };
      if (event.type === 'assistant.ended')
        return { state: { ...state, live: { turnId: event.turnId, content: event.content } } };
      return { state };
    }
    case 'result':
      return {
        state: {
          ...state,
          result: message.result,
          notice:
            message.result.execution.state === 'suspended'
              ? `Suspended: ${message.result.execution.reason}`
              : `Operation ${message.result.disposition}`
        },
        effects: [refresh(app, state.document?.value.resource.resourceId)]
      };
    case 'composer.edit':
      return { state: { ...state, composer: textAreaReducer(state.composer, message.transition).state } };
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
      const original = textDocumentText(state.composer.document);
      if (state.submitting || !original.trim()) return { state };
      if (state.document === undefined)
        return { state: { ...state, notice: 'Select a managed document first.' } };
      const document = state.document;
      return {
        state: { ...state, submitting: true },
        effects: [
          effect('writing-submit', async () => {
            const result = await app.instruct({
              kind: state.instructionKind,
              instruction: original,
              selection: {
                ...document.value.selection,
                ...(document.selectedRange === undefined ? {} : { range: document.selectedRange })
              }
            });
            return {
              type: 'submitted',
              original,
              accepted: result.kind === 'accepted',
              message:
                result.kind === 'accepted'
                  ? `Accepted · ${result.operationId}`
                  : `Instruction rejected: ${result.reason.replaceAll('_', ' ')}`
            };
          })
        ]
      };
    }
    case 'submitted':
      return {
        state: {
          ...state,
          submitting: false,
          savedDrafts: message.accepted ? [...state.savedDrafts, message.original] : state.savedDrafts,
          notice: message.message,
          composer:
            message.accepted && textDocumentText(state.composer.document) === message.original
              ? createTextAreaState({ value: '' })
              : state.composer
        }
      };
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
      if (state.document?.input.selection === undefined)
        return {
          state: {
            ...state,
            notice:
              'Open document source, select text with Shift or the pointer, then use the passage control.'
          }
        };
      const selection = state.document.input.selection;
      const start = Math.min(selection.anchor.offset, selection.focus.offset),
        end = Math.max(selection.anchor.offset, selection.focus.offset);
      if (start === end) return { state: { ...state, notice: 'Select a nonempty passage.' } };
      return {
        state: {
          ...state,
          document: {
            ...state.document,
            selectedRange: rangeFromOffsets(state.document.value.content, start, end)
          },
          notice: 'The next instruction targets the selected passage.'
        },
        focus: { kind: 'element', elementId: 'writing-composer' }
      };
    }
    case 'document.clear-passage': {
      if (state.document === undefined) return { state };
      const document = { ...state.document };
      delete document.selectedRange;
      return { state: { ...state, document, notice: 'The next instruction targets the document.' } };
    }
    case 'document.scroll':
      return state.document === undefined
        ? { state }
        : {
            state: {
              ...state,
              document: { ...state.document, offsetRow: message.request.nextState.offsetRow }
            }
          };
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
      return openPicker(state, message.subject, app);
    case 'picker.loaded':
      if (state.overlay.kind !== 'loading' || state.overlay.requestId !== message.requestId) return { state };
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
                picker: searchPickerReducer(state.overlay.picker, message.transition, {
                  searchPickerIndex: pickerIndex(state.overlay.entries)
                })
              }
            }
          };
    case 'picker.accept':
      return acceptPicker(state, message.id, app);
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
    case 'proposal.loaded':
      return {
        state: {
          ...state,
          proposal: message.review,
          proposalView: 'comparison',
          view: 'proposal',
          overlay: { kind: 'none' }
        }
      };
    case 'revision.completed': {
      const loaded = loadView(state, message.refreshed, app);
      return {
        ...loaded,
        state: {
          ...loaded.state,
          busy: false,
          overlay: { kind: 'none' },
          ...(message.review === undefined ? {} : { proposal: message.review })
        }
      };
    }
    case 'revision.failed':
      return { state: { ...state, busy: false, notice: message.message } };
    case 'proposal.view':
      return { state: { ...state, proposalView: message.view } };
    case 'proposal.accept':
      return { state: { ...state, overlay: { kind: 'accept', selectedCriteria: [] } } };
    case 'criterion.toggle':
      return state.overlay.kind !== 'accept'
        ? { state }
        : {
            state: {
              ...state,
              overlay: {
                ...state.overlay,
                selectedCriteria: state.overlay.selectedCriteria.includes(message.id)
                  ? state.overlay.selectedCriteria.filter((id) => id !== message.id)
                  : [...state.overlay.selectedCriteria, message.id]
              }
            }
          };
    case 'proposal.confirm-accept': {
      if (state.proposal === undefined || state.overlay.kind !== 'accept') return { state };
      const selected = state.overlay.selectedCriteria;
      const proposalId = state.proposal.review.proposal.proposalId;
      return revise(state, app, () =>
        app.accept({
          proposalId,
          explanation: 'I accept this exact proposed revision.',
          humanCriterionDecisions: selected.map((criterionId) => ({
            criterionId,
            verdict: 'passed',
            explanation: 'Confirmed by the user during revision review.'
          }))
        })
      );
    }
    case 'proposal.reject':
    case 'proposal.authorize': {
      const proposal = state.proposal;
      if (proposal === undefined) return { state };
      const proposalId = proposal.review.proposal.proposalId;
      return revise(state, app, () =>
        message.type === 'proposal.reject'
          ? app.reject(proposalId, 'I reject this proposed revision.')
          : app.authorize(proposalId)
      );
    }
    case 'proposal.apply': {
      const review = state.proposal?.review;
      if (review?.authorization === undefined)
        return { state: { ...state, notice: 'Authorize this exact proposal before applying it.' } };
      const authorization = review.authorization;
      return revise(state, app, () => app.apply({ proposalId: review.proposal.proposalId, authorization }));
    }
    case 'revision.undo':
      return revise(state, app, () =>
        app.undo({ explanation: 'Undo requested through the document interface.' })
      );
    case 'form.open':
      return {
        state: {
          ...state,
          overlay: {
            kind: 'form',
            subject: message.subject,
            fields: (message.subject === 'configure'
              ? [
                  { name: 'Provider', value: state.application.provider ?? 'ollama' },
                  { name: 'Model', value: state.application.model ?? '' },
                  { name: 'Endpoint (optional)', value: '' }
                ]
              : [{ name: 'Existing project path', value: '' }]
            ).map((field) => ({ name: field.name, input: createTextAreaState({ value: field.value }) }))
          }
        }
      };
    case 'form.edit':
      return state.overlay.kind !== 'form'
        ? { state }
        : {
            state: {
              ...state,
              overlay: {
                ...state.overlay,
                fields: state.overlay.fields.map((field, index) =>
                  index !== message.index
                    ? field
                    : { ...field, input: textAreaReducer(field.input, message.transition).state }
                )
              }
            }
          };
    case 'form.submit': {
      if (state.overlay.kind !== 'form') return { state };
      const values = state.overlay.fields.map((field) => textDocumentText(field.input.document).trim());
      const subject = state.overlay.subject;
      return {
        state,
        effects: [
          effect('writing-form', async () => {
            if (subject === 'configure')
              await app.configure(
                createWritingProvider({
                  provider: parseWritingProviderId(values[0] ?? ''),
                  model: values[1] ?? '',
                  ...(!values[2] ? {} : { endpoint: values[2] })
                })
              );
            else
              await app.registerResource({
                relativePath: values[0] ?? '',
                mediaType: 'text/markdown',
                role: 'draft',
                ownership: 'user-owned'
              });
            return { type: 'form.completed' };
          })
        ],
        focus: { kind: 'element', elementId: 'writing-composer' }
      };
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
              message: { type: 'history.failed', requestId, message: diagnosticMessage(diagnostic) }
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
      const original = textDocumentText(state.composer.document);
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
              return { kind: 'message', message: { type: 'external-edited', original, text } };
            },
            onError: ({ diagnostic }) => ({
              kind: 'message',
              message: { type: 'notice', message: diagnosticMessage(diagnostic) }
            })
          }
        ]
      };
    }
    case 'external-edited':
      return {
        state:
          textDocumentText(state.composer.document) === message.original
            ? { ...state, composer: createTextAreaState({ value: message.text }) }
            : {
                ...state,
                savedDrafts: [...state.savedDrafts, message.text],
                notice: 'External edit saved in Drafts; the current draft was preserved.'
              },
        focus: { kind: 'element', elementId: 'writing-composer' }
      };
    case 'interrupt':
      return ['running', 'recovering', 'admitting'].includes(state.application.status)
        ? {
            state,
            effects: [
              effect('writing-interrupt', async () => {
                await app.abort();
                return { type: 'notice', message: 'Interruption requested.' };
              })
            ]
          }
        : { state: { ...state, notice: 'No active operation. Your draft is preserved.' } };
    case 'overlay.close':
      return {
        state: { ...state, overlay: { kind: 'none' } },
        focus: { kind: 'element', elementId: 'writing-composer' }
      };
    case 'exit':
      return { state, exit: { reason: 'user' } };
  }
}

function refresh(app: WritingApplication, resourceId?: string): TuiEffect<WritingTuiMessage> {
  return { ...effect('writing-refresh', () => readView(app, resourceId)), concurrency: 'enqueue' };
}
async function readView(
  app: WritingApplication,
  resourceId?: string
): Promise<Extract<WritingTuiMessage, { type: 'loaded' }>> {
  await app.start();
  const project = await app.readProject();
  const selected =
    project.snapshot.resources.find((resource) => resource.resourceId === resourceId) ??
    project.snapshot.resources[0];
  const document = selected === undefined ? undefined : await app.readDocument(selected.resourceId);
  return {
    type: 'loaded',
    application: app.state(),
    project,
    ...(document === undefined ? {} : { document }),
    history: await app.readHistory()
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
function revise(state: WritingTuiState, app: WritingApplication, action: () => Promise<unknown>): Update {
  if (state.busy) return { state };
  const proposalId = state.proposal?.review.proposal.proposalId;
  return {
    state: { ...state, busy: true },
    effects: [
      {
        id: 'writing-revision',
        concurrency: 'enqueue',
        async run() {
          await action();
          const review = proposalId === undefined ? undefined : await app.compareProposal(proposalId);
          return {
            kind: 'message',
            message: {
              type: 'revision.completed',
              refreshed: await readView(app, state.document?.value.resource.resourceId),
              ...(review === undefined ? {} : { review })
            }
          };
        },
        onError: ({ diagnostic }) => ({
          kind: 'message',
          message: { type: 'revision.failed', message: diagnosticMessage(diagnostic) }
        })
      }
    ]
  };
}
function documentState(
  value: WritingDocument,
  previous?: WritingTuiState['document']
): NonNullable<WritingTuiState['document']> {
  if (
    previous?.value.resource.resourceId === value.resource.resourceId &&
    previous.value.selection.resourceSha256 === value.selection.resourceSha256
  )
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
  subject: Extract<WritingTuiOverlay, { kind: 'picker' }>['subject'],
  app: WritingApplication
): Update {
  const requestId = crypto.randomUUID();
  return {
    state: { ...state, overlay: { kind: 'loading', requestId } },
    effects: [
      {
        ...effect('writing-picker', async () => {
          const entries =
            subject === 'proposal-sources'
              ? (state.proposal?.comparisons.flatMap((comparison) =>
                  ['original', 'proposed'].map((side) => ({
                    id: `${side}:${comparison.resourceId}`,
                    label: `${side} · ${comparison.path}`
                  }))
                ) ?? [])
              : subject === 'sources'
                ? (state.project?.snapshot.sources.map((source) => ({
                    id: source.sourceId,
                    label: source.title ?? source.sourceId
                  })) ?? [])
                : subject === 'drafts'
                  ? state.savedDrafts.map((draft, index) => ({ id: String(index), label: draft }))
                  : subject === 'resources'
                    ? (state.project?.snapshot.resources.map((resource) => ({
                        id: resource.resourceId,
                        label: resource.relativePath
                      })) ?? [])
                    : subject === 'proposals'
                      ? (state.project?.proposals.map((proposal) => ({
                          id: proposal.proposalId,
                          label: `${proposal.status} · ${proposal.proposalId}`
                        })) ?? [])
                      : subject === 'outline'
                        ? flattenOutline(state.document?.markdown.outline() ?? [])
                        : subject === 'operation'
                          ? writingOperationKindSchema.options.map((kind) => ({ id: kind, label: kind }))
                          : (await app.listSessions()).map((session) => ({
                              id: session.id,
                              label: `${session.updatedAt} · ${session.id}`
                            }));
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
    { id: String(heading.span.start), label: `${'  '.repeat(heading.depth - 1)}${heading.text}` },
    ...flattenOutline(heading.children)
  ]);
}
function acceptPicker(state: WritingTuiState, id: string, app: WritingApplication): Update {
  if (state.overlay.kind !== 'picker' || !state.overlay.entries.some((entry) => entry.id === id))
    return { state };
  switch (state.overlay.subject) {
    case 'operation':
      return {
        state: { ...state, instructionKind: writingOperationKindSchema.parse(id), overlay: { kind: 'none' } }
      };
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
                  caret: { position: { offset: Number(id), affinity: 'downstream' } },
                  revealCaret: true
                }
              }
            },
            focus: { kind: 'element', elementId: 'writing-document-source' }
          };
    case 'resources':
      return {
        state,
        effects: [
          effect('writing-document', async () => ({
            type: 'document.loaded',
            document: await app.readDocument(id)
          }))
        ]
      };
    case 'proposals':
      return {
        state,
        effects: [
          effect('writing-proposal', async () => ({
            type: 'proposal.loaded',
            review: await app.compareProposal(id)
          }))
        ]
      };
    case 'proposal-sources': {
      for (const comparison of state.proposal?.comparisons ?? [])
        for (const side of ['original', 'proposed'] as const)
          if (id === `${side}:${comparison.resourceId}`)
            return update(
              state,
              { type: 'proposal.source', resourceId: comparison.resourceId, side },
              app,
              {}
            );
      return { state };
    }
    case 'sources':
      return {
        state,
        effects: [
          effect('writing-source', async () => {
            const { source, content } = await app.readSource(id);
            return {
              type: 'source.loaded',
              title: `${source.title ?? source.sourceId} · ${source.exactSha256}`,
              content
            };
          })
        ]
      };
    case 'drafts': {
      const draft = state.savedDrafts[Number(id)];
      return draft === undefined
        ? { state }
        : {
            state: {
              ...state,
              savedDrafts: [...state.savedDrafts, textDocumentText(state.composer.document)],
              composer: createTextAreaState({ value: draft }),
              overlay: { kind: 'none' }
            }
          };
    }
    case 'sessions':
      return {
        state: { ...state, overlay: { kind: 'none' } },
        effects: [
          effect('writing-session', async () => {
            await app.selectSession(id);
            return { type: 'refresh' };
          })
        ]
      };
  }
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
          (entry) => (entry.type === 'assistant' ? `assistant:${entry.turnId}` : entry.id)
        )
      }
    };
    const saved = sessionViews[message.history.boundary.sessionId];
    next = {
      ...state,
      sessionViews,
      composer: saved?.composer ?? createTextAreaState({ value: '' }),
      view: saved?.view ?? 'document',
      history: [],
      followTail: saved?.bookmark.followTail ?? true,
      conversationOffset: 0,
      unread: false
    };
    const cleared = { ...next };
    delete cleared.conversationAnchor;
    delete cleared.historyRequestId;
    delete cleared.live;
    delete cleared.result;
    delete cleared.sessionView;
    next = cleared;
    if (saved?.bookmark.anchor !== undefined) next = { ...next, conversationAnchor: saved.bookmark.anchor };
  }
  next = {
    ...next,
    project: message.project,
    application: message.application,
    history: next.followTail || switched || next.history.length === 0 ? [message.history] : next.history,
    unread:
      !next.followTail &&
      !switched &&
      (next.unread || next.history.at(-1)?.boundary.leafId !== message.history.boundary.leafId),
    ...(message.document === undefined ? {} : { document: documentState(message.document, next.document) })
  };
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
          return { type: 'history.loaded', requestId, direction: 'restore', pages };
        }),
        concurrency: 'replace',
        onError: ({ diagnostic }) => ({
          kind: 'message',
          message: { type: 'history.failed', requestId, message: diagnosticMessage(diagnostic) }
        })
      }
    ]
  };
}

function copyInput(state: WritingTuiState, focusPath?: readonly string[]) {
  return state.overlay.kind === 'source'
    ? state.source?.input
    : state.overlay.kind === 'notes'
      ? state.overlay.state.source?.input
      : state.overlay.kind !== 'none'
        ? undefined
        : focusPath?.includes('writing-composer')
          ? state.composer
          : focusPath?.includes('writing-document-source')
            ? state.document?.input
            : selectedSource(state.composer) !== undefined
              ? state.composer
              : state.document?.input;
}

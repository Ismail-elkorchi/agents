import { diagnosticMessage, patchSegments, selectedSource, panel as dismissiblePanel } from '@agent-core/tui';
import type { SearchPickerControlTransition, TextAreaState, TextAreaTransition } from '@ismail-elkorchi/terminal-ui/behavior';
import {
  createSearchPickerIndex,
  createSearchPickerState,
  createTextAreaState,
  searchPickerReducer,
  prepareSearchPickerQuery,
  type SearchPickerIndex,
  type SearchPickerQueryResult,
  searchPickerView,
  textAreaReducer
} from '@ismail-elkorchi/terminal-ui/behavior';
import type { Element } from '@ismail-elkorchi/terminal-ui/components';
import {
  button,
  searchPicker,
  text,
  textArea,
  richText
} from '@ismail-elkorchi/terminal-ui/components';
import { column, flow, measuredViewport } from '@ismail-elkorchi/terminal-ui/layout';
import {
  createTuiPreparedQuery,
  liftTuiResult,
  type TuiUpdateResult,
  type TuiPreparedQueryMessage,
  type TuiPreparedQueryState
} from '@ismail-elkorchi/terminal-ui/tui';
import type { CodingApplication } from '../application/service.js';
import type { WorkspaceChange } from '../changes/run-change-report.js';
import { appendNotice } from './conversation.js';
import { branchPointPresentation } from './branch-presentation.js';
import { recordedChangeSource, reviewAttachment, type RecordedChangeSource } from './change-review.js';
import type { CodingAgentTuiMessage } from './messages.js';
import type { CodingAgentTuiPickerState, CodingAgentTuiState } from './state.js';

export type CodingNavigationOperations = Pick<
  CodingApplication,
  | 'listSessions'
  | 'newSession'
  | 'selectSession'
  | 'branchFrom'
  | 'readPendingSubmissions'
  | 'updateQueuedSubmission'
  | 'readChange'
>;
export type PanelKind = 'sessions' | 'branches' | 'changes';
export type PanelItem = { readonly id: string; readonly label: string } & (
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'branch'; readonly entryId: string; readonly title: string; readonly detail: string }
  | { readonly kind: 'change'; readonly change: WorkspaceChange; readonly runId: string }
);
type ChangeItem = Extract<PanelItem, { kind: 'change' }>;
export interface NavigationPanel {
  readonly kind: 'panel';
  readonly id: string;
  readonly sessionId: string | undefined;
  readonly searchPickerIndex: SearchPickerIndex<PanelItem>;
  readonly query: TuiPreparedQueryState<SearchPickerQueryResult<PanelItem>>;
  readonly panel: PanelKind;
  readonly items: readonly PanelItem[];
  readonly picker: CodingAgentTuiPickerState;
}
export interface ChangeReview {
  readonly requestId: string;
  readonly sessionId: string | undefined;
  readonly listing: NavigationPanel;
  readonly items: readonly ChangeItem[];
  readonly index: number;
  readonly loading: boolean;
  readonly evidence?: RecordedChangeSource;
  readonly hunk?: number;
  readonly error?: string;
}
export type CodingPanel =
  | { readonly kind: 'panel_loading'; readonly id: string; readonly panel: PanelKind; readonly sessionId: string | undefined }
  | NavigationPanel
  | {
      readonly kind: 'source';
      readonly patch?: string;
      readonly rendered: boolean;
      readonly offset: number;
      readonly title: string;
      readonly input: TextAreaState;
      readonly notice?: string;
      readonly review?: ChangeReview;
    }
  | { readonly kind: 'branch_review'; readonly entryId: string; readonly title: string; readonly detail: string; readonly sessionId: string | undefined };
export type PanelMessage =
  | PanelQueryMessage
  | { readonly type: 'panel.open'; readonly panel: PanelKind }
  | { readonly type: 'panel.loaded'; readonly requestId: string; readonly panel: PanelKind; readonly sessionId: string | undefined; readonly items: readonly PanelItem[] }
  | { readonly type: 'panel.failed'; readonly requestId: string; readonly message: string }
  | { readonly type: 'panel.transition'; readonly transition: SearchPickerControlTransition }
  | { readonly type: 'panel.accept'; readonly id: string }
  | { readonly type: 'panel.change-loaded'; readonly requestId: string; readonly sessionId: string | undefined; readonly evidence: RecordedChangeSource }
  | { readonly type: 'panel.change-failed'; readonly requestId: string; readonly sessionId: string | undefined; readonly message: string }
  | { readonly type: 'panel.source-loaded'; readonly title: string; readonly content: string }
  | { readonly type: 'panel.source-mode' }
  | { readonly type: 'panel.source-scroll'; readonly offset: number }
  | { readonly type: 'panel.text'; readonly transition: TextAreaTransition }
  | { readonly type: 'panel.branch'; readonly entryId: string }
  | { readonly type: 'panel.done' | 'panel.operation-failed'; readonly message: string; readonly sessionId?: string }
  | { readonly type: 'panel.review-file'; readonly requestId: string; readonly delta: -1 | 1 }
  | { readonly type: 'panel.review-hunk'; readonly requestId: string; readonly direction: 'previous' | 'next' | 'all' }
  | { readonly type: 'panel.review-list'; readonly requestId: string }
  | { readonly type: 'panel.review-attach'; readonly requestId: string; readonly hunk: number | undefined; readonly selection: boolean };
type Update = TuiUpdateResult<CodingAgentTuiState, CodingAgentTuiMessage>;

const panelTitles: Record<PanelKind, string> = {
  sessions: 'Sessions',
  branches: 'Branch from history',
  changes: 'Workspace changes'
};
export interface PanelQueryMessage {
  readonly type: 'panel.query';
  readonly id: string;
  readonly message: TuiPreparedQueryMessage<SearchPickerQueryResult<PanelItem>>;
}
function preparedPanel(id: string) {
  return createTuiPreparedQuery({
    id: 'navigation-query',
    prepare: (input: Extract<CodingPanel, { kind: 'panel' }>, context) =>
      prepareSearchPickerQuery(
        input.searchPickerIndex,
        {
          text: input.picker.editor.input.text,
          mode: input.picker.mode,
          caseSensitive: input.picker.caseSensitive
        },
        {
          signal: context.signal,
          yield: async () => {
            await context.clock.sleep(0, context.signal);
          }
        }
      ),
    toMessage: (message): CodingAgentTuiMessage => ({ type: 'panel.query', id, message })
  });
}
function requestPanelQuery(
  state: CodingAgentTuiState,
  overlay: Extract<CodingPanel, { kind: 'panel' }>
): Update {
  const result = preparedPanel(overlay.id).request(overlay.query, overlay);
  return liftTuiResult(state, 'overlay', liftTuiResult(overlay, 'query', result));
}

export function openPanel(
  state: CodingAgentTuiState,
  panel: PanelKind,
  operations: CodingNavigationOperations | undefined,
  names?: import('@agent-core/tui').SessionNames
): Update {
  const id = `panel:${String(state.nextLocalId)}`;
  return {
    state: {
      ...state,
      nextLocalId: state.nextLocalId + 1,
      overlay: { kind: 'panel_loading', id, panel, sessionId: state.debug.sessionId }
    },
    effects: [
      {
        id: 'navigation-panel',
        concurrency: 'replace',
        async run() {
          let items: readonly PanelItem[];
          if (panel === 'branches')
            items = state.debug.branchPoints.map((point, index) => {
              const presentation = branchPointPresentation(state, point);
              return { kind: 'branch', id: point.entryId, entryId: point.entryId,
                ...presentation, label: `${presentation.title} · ${point.timestamp} · checkpoint ${String(index + 1)}` };
            });
          else if (panel === 'changes')
            items = state.debug.changes.flatMap((report) =>
              report.changes.map((change) => ({
                kind: 'change' as const,
                id: `${report.runId}:${change.path}`,
                label: `${change.kind} · ${change.path} · ${change.state}`,
                change,
                runId: report.runId
              }))
            );
          else {
            if (operations === undefined) throw new Error('Session operations are unavailable.');
            let sessions: Awaited<ReturnType<CodingNavigationOperations['listSessions']>>;
            try {
              sessions = await operations.listSessions();
            } catch (error) {
              if (error instanceof Error && error.name === 'AbortError') return { kind: 'none' };
              throw error;
            }
            items = await Promise.all(
              sessions.map(
                async (session): Promise<PanelItem> => ({
                  kind: 'session',
                  id: session.id,
                  sessionId: session.id,
                  label: `${session.id === state.debug.sessionId ? '✓ ' : ''}${(await names?.read(session.id)) ?? session.preview ?? session.id} · ${session.updatedAt}`
                })
              )
            );
          }
          return {
            kind: 'message',
            message: { type: 'panel.loaded', requestId: id, panel, sessionId: state.debug.sessionId, items }
          };
        },
        onError: ({ diagnostic }) => ({
          kind: 'message',
          message: { type: 'panel.failed', requestId: id, message: diagnosticMessage(diagnostic) }
        })
      }
    ]
  };
}

export function updatePanel(
  state: CodingAgentTuiState,
  message: Exclude<
    Extract<CodingAgentTuiMessage, { type: `panel.${string}` }>,
    { type: 'panel.open' }
  >,
  operations: CodingNavigationOperations | undefined
): Update {
  switch (message.type) {
    case 'panel.loaded': {
      if (state.overlay.kind !== 'panel_loading' || state.overlay.id !== message.requestId || state.debug.sessionId !== state.overlay.sessionId || message.sessionId !== state.overlay.sessionId)
        return { state };
      const searchPickerIndex = createSearchPickerIndex(
        message.items.map((item) => ({ id: item.id, label: item.label, value: item }))
      );
      return {
        ...requestPanelQuery(state, {
          kind: 'panel',
          id: message.requestId,
          sessionId: message.sessionId,
          panel: message.panel,
          items: message.items,
          searchPickerIndex,
          query: preparedPanel(message.requestId).init(),
          picker: createSearchPickerState({ queryResult: null }, searchPickerIndex)
        }),
        focus: { kind: 'element', elementId: 'navigation-picker' }
      };
    }
    case 'panel.failed':
      return state.overlay.kind !== 'panel_loading' || state.overlay.id !== message.requestId
        ? { state }
        : {
            state: appendNotice({ ...state, overlay: { kind: 'none' } }, message.message, 'error')
          };
    case 'panel.transition': {
      if (state.overlay.kind !== 'panel') return { state };
      const overlay = state.overlay;
      const picker = searchPickerReducer(overlay.picker, message.transition, {
        searchPickerIndex: overlay.searchPickerIndex,
        queryResult: overlay.query.result
      });
      const next = { ...overlay, picker };
      return picker.editor.input.text === overlay.picker.editor.input.text &&
        picker.mode === overlay.picker.mode &&
        picker.caseSensitive === overlay.picker.caseSensitive
        ? { state: { ...state, overlay: next } }
        : requestPanelQuery(state, next);
    }
    case 'panel.query': {
      if (state.overlay.kind !== 'panel' || state.overlay.id !== message.id) return { state };
      const overlay = state.overlay;
      const result = preparedPanel(overlay.id).update(overlay.query, message.message);
      if (result.state === overlay.query) return { state };
      const activeId = overlay.picker.editor.activeId;
      return {
        ...result,
        state: {
          ...state,
          overlay: {
            ...overlay,
            query: result.state,
            picker: searchPickerReducer(
              overlay.picker,
              activeId === undefined
                ? { kind: 'firstActive' }
                : { kind: 'setActive', id: activeId },
              {
                searchPickerIndex: overlay.searchPickerIndex,
                queryResult: result.state.result
              }
            )
          }
        }
      };
    }
    case 'panel.accept': {
      if (state.overlay.kind !== 'panel' || state.overlay.sessionId !== state.debug.sessionId) return { state };
      const item = state.overlay.items.find((item) => item.id === message.id);
      if (item === undefined) return { state };
      return acceptPanelItem(state, item, operations);
    }
    case 'panel.change-loaded':
    case 'panel.change-failed': {
      if (state.overlay.kind !== 'source' || state.overlay.review?.requestId !== message.requestId ||
          state.overlay.review.sessionId !== message.sessionId || state.debug.sessionId !== message.sessionId)
        return { state };
      const review = state.overlay.review;
      if (message.type === 'panel.change-failed') return { state: { ...state, overlay: { ...state.overlay,
        input: createTextAreaState({ value: `Recorded change unavailable: ${message.message}` }),
        review: { ...review, loading: false, error: message.message } } } };
      return { state: { ...state, overlay: {
        kind: 'source', title: message.evidence.title, rendered: message.evidence.patch !== undefined,
        ...(message.evidence.patch === undefined ? {} : { patch: message.evidence.patch }), offset: 0,
        input: createTextAreaState({ value: message.evidence.content }),
        review: { ...review, loading: false, evidence: message.evidence }
      } }, focus: { kind: 'element', elementId: message.evidence.patch === undefined ? 'source-text' : 'change-source-mode' } };
    }
    case 'panel.review-file': {
      if (state.overlay.kind !== 'source' || state.overlay.review === undefined) return { state };
      const review = state.overlay.review;
      if (review.requestId !== message.requestId || review.sessionId !== state.debug.sessionId || review.loading) return { state };
      const index = review.index + message.delta;
      return index < 0 || index >= review.items.length ? { state }
        : readReviewFile(state, review.listing, review.items, index, operations);
    }
    case 'panel.review-list':
      return state.overlay.kind !== 'source' || state.overlay.review?.requestId !== message.requestId || state.overlay.review.sessionId !== state.debug.sessionId ? { state }
        : { state: { ...state, overlay: state.overlay.review.listing }, focus: { kind: 'element', elementId: 'navigation-picker' } };
    case 'panel.review-hunk': {
      if (state.overlay.kind !== 'source' || state.overlay.review?.requestId !== message.requestId || state.overlay.review.sessionId !== state.debug.sessionId) return { state };
      const source = state.overlay;
      const review = source.review;
      if (review === undefined || review.loading || review.evidence === undefined) return { state };
      const hunks = review.evidence.hunks;
      const index = message.direction === 'all' ? undefined : message.direction === 'next'
        ? Math.min(hunks.length - 1, (review.hunk ?? -1) + 1)
        : Math.max(0, (review.hunk ?? hunks.length) - 1);
      if (index !== undefined && hunks[index] === undefined) return { state };
      const base = { ...review };
      delete base.hunk;
      return { state: { ...state, overlay: { ...source, offset: 0,
        title: index === undefined ? review.evidence.title : hunks[index]?.label ?? review.evidence.title,
        input: createTextAreaState({ value: index === undefined ? review.evidence.content : hunks[index]?.content ?? '' }),
        review: { ...base, ...(index === undefined ? {} : { hunk: index }) }
      } } };
    }
    case 'panel.review-attach': {
      if (state.overlay.kind !== 'source' || state.overlay.review?.requestId !== message.requestId || state.overlay.review.sessionId !== state.debug.sessionId) return { state };
      const source = state.overlay;
      const review = source.review;
      if (review === undefined || review.loading || review.evidence === undefined) return { state };
      if (review.hunk !== message.hunk) return { state };
      const selection = message.selection ? selectedSource(source.input) : undefined;
      if (message.selection && (selection === undefined || source.rendered))
        return { state: { ...state, overlay: { ...source, notice: 'Switch to Original / select and select the exact text to attach.' } } };
      const attachment = reviewAttachment(review.evidence, selection,
        review.hunk === undefined ? undefined : review.evidence.hunks[review.hunk]);
      return { state: appendNotice({ ...state, overlay: { kind: 'none' }, composer: { ...state.composer,
        attachments: [...state.composer.attachments, attachment] } },
        `Attached ${attachment.label}. Inspect or remove it before sending your question.`),
        focus: { kind: 'element', elementId: 'composer' } };
    }
    case 'panel.source-loaded':
      return sourcePanel(state, message.title, message.content);
    case 'panel.source-mode':
      return state.overlay.kind !== 'source'
        ? { state }
        : {
            state: { ...state, overlay: { ...state.overlay, rendered: !state.overlay.rendered } },
            focus: { kind: 'element', elementId: state.overlay.rendered ? 'source-text' : 'change-source-mode' }
          };
    case 'panel.source-scroll':
      return state.overlay.kind !== 'source'
        ? { state }
        : {
            state: { ...state, overlay: { ...state.overlay, offset: message.offset } }
          };
    case 'panel.text': {
      if (state.overlay.kind !== 'source') return { state };
      return {
        state: {
          ...state,
          overlay: {
            ...state.overlay,
            input: textAreaReducer(state.overlay.input, message.transition).state
          }
        }
      };
    }
    case 'panel.branch':
      return state.overlay.kind !== 'branch_review' || state.overlay.entryId !== message.entryId || state.overlay.sessionId !== state.debug.sessionId
        ? { state }
        : operation(
            state,
            operations,
            (service) => service.branchFrom(message.entryId, undefined, state.debug.sessionId),
            'Branch selected.'
          );
    case 'panel.done':
      if (message.sessionId !== undefined && state.debug.sessionId !== message.sessionId) return { state };
      return {
        state: appendNotice({ ...state, overlay: { kind: 'none' } }, message.message),
        focus: { kind: 'element', elementId: 'composer' }
      };
    case 'panel.operation-failed':
      return message.sessionId !== undefined && message.sessionId !== state.debug.sessionId
        ? { state } : { state: appendNotice(state, message.message, 'error') };
  }
}

function sourcePanel(
  state: CodingAgentTuiState,
  title: string,
  value: string,
  patch?: string
): Update {
  return {
    state: {
      ...state,
      overlay: {
        kind: 'source',
        title,
        ...(patch === undefined ? {} : { patch }),
        rendered: patch !== undefined,
        offset: 0,
        input: createTextAreaState({
          value,
          caret: { position: { offset: 0, affinity: 'downstream' } }
        })
      }
    }
  };
}

function operation(
  state: CodingAgentTuiState,
  service: CodingNavigationOperations | undefined,
  act: (service: CodingNavigationOperations) => Promise<void>,
  message: string
): Update {
  return {
    state,
    effects: [
      {
        id: 'session-operation',
        concurrency: 'keep-first',
        async run() {
          if (service === undefined) throw new Error('Session operations are unavailable.');
          try {
            await act(service);
          } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') return { kind: 'none' };
            throw error;
          }
          return { kind: 'message', message: { type: 'panel.done', message, ...(state.debug.sessionId === undefined ? {} : { sessionId: state.debug.sessionId }) } };
        },
        onError: ({ diagnostic }) => ({
          kind: 'message',
          message: { type: 'panel.operation-failed', message: diagnosticMessage(diagnostic), ...(state.debug.sessionId === undefined ? {} : { sessionId: state.debug.sessionId }) }
        })
      }
    ]
  };
}

export function panelView(
  panel: CodingPanel,
  width: number,
  height: number,
  inspection: CodingAgentTuiState['inspection']
): Element<CodingAgentTuiMessage> {
  const content = (): Element<CodingAgentTuiMessage> => {
    switch (panel.kind) {
      case 'panel_loading':
        return text({ id: 'panel-loading-text', content: 'Loading…' });
      case 'panel':
        return column([
          searchPicker({
            id: 'navigation-picker',
            title: panelTitles[panel.panel],
            view: searchPickerView(panel.picker),
            searchPickerIndex: panel.searchPickerIndex,
            queryResult: panel.query.result,
            maxVisible: Math.max(1, height - 5 - (panel.query.error === null ? 0 : 1)),
            emptyText: 'No entries available',
            onTransition: (transition) => ({ type: 'panel.transition', transition }),
            onAccept: (event) => ({ type: 'panel.accept', id: event.id })
          }),
          ...(panel.query.error === null
            ? []
            : [
                text({
                  content: `Search failed. Edit the query to retry: ${diagnosticMessage(panel.query.error)}`
                })
              ])
        ]);
      case 'source':
        return sourceView(panel, width, height, inspection);
      case 'branch_review':
        return column([
          text({
            content: `${panel.title}\n\n${panel.detail}\nRequires an idle session.`
          }),
          button({
            id: 'branch-continue',
            label: 'Create branch',
            onPress: () => ({ type: 'panel.branch', entryId: panel.entryId })
          })
        ]);
    }
  };
  return dismissiblePanel({
    id: 'navigation-dialog',
    title:
      panel.kind === 'source'
        ? panel.title
        : panel.kind === 'branch_review'
          ? 'Branch conversation'
          : panelTitles[panel.panel],
    width,
    height,
    ...(panel.kind === 'panel_loading'
      ? {}
      : {
          focusId:
            panel.kind === 'source'
              ? panel.rendered
                ? 'change-source-mode'
                : 'source-text'
              : panel.kind === 'branch_review'
                ? 'branch-continue'
                : 'navigation-picker'
        }),
    onClose: () => ({ type: 'overlay.close' }),
    slots: { content: content() }
  });
}

function acceptPanelItem(
  state: CodingAgentTuiState,
  item: PanelItem,
  operations: CodingNavigationOperations | undefined
): Update {
  switch (item.kind) {
    case 'session':
      return operation(
        state,
        operations,
        (service) => service.selectSession(item.sessionId),
        'Session selected.'
      );
    case 'branch':
      return {
        state: { ...state, overlay: { kind: 'branch_review', entryId: item.entryId, title: item.title, detail: item.detail, sessionId: state.debug.sessionId } },
        focus: { kind: 'element', elementId: 'branch-continue' }
      };
    case 'change': {
      if (state.overlay.kind !== 'panel') return { state };
      const items = state.overlay.items.filter((item): item is ChangeItem => item.kind === 'change');
      return readReviewFile(state, state.overlay, items, items.findIndex((entry) => entry.id === item.id), operations);
    }
  }
}

function readReviewFile(state: CodingAgentTuiState, listing: NavigationPanel, items: readonly ChangeItem[], index: number,
  operations: CodingNavigationOperations | undefined): Update {
  const item = items[index];
  if (item === undefined || listing.sessionId !== state.debug.sessionId) return { state };
  const requestId = `review:${String(state.nextLocalId)}`;
  const sessionId = state.debug.sessionId;
  return {
    state: { ...state, nextLocalId: state.nextLocalId + 1, overlay: {
      kind: 'source', title: item.change.path, rendered: false, offset: 0,
      input: createTextAreaState({ value: 'Loading recorded change…' }),
      review: { requestId, sessionId, listing, items, index, loading: true }
    } },
    effects: [{ id: 'change-source', concurrency: 'replace', async run() {
      if (operations === undefined) throw new Error('Change inspection is unavailable.');
      const inspection = await operations.readChange(item.runId, item.change.path, sessionId);
      const evidence = recordedChangeSource(sessionId, item.runId, inspection);
      return { kind: 'message', message: { type: 'panel.change-loaded', requestId, sessionId, evidence } };
    }, onError: ({ diagnostic }) => ({ kind: 'message', message: {
      type: 'panel.change-failed', requestId, sessionId, message: diagnosticMessage(diagnostic)
    } }) }]
  };
}

function sourceView(panel: Extract<CodingPanel, { kind: 'source' }>, width: number, height: number, inspection: CodingAgentTuiState['inspection']): Element<CodingAgentTuiMessage> {
  const compact = width < 70 || height < 18;
  const review = panel.review;
  const hunk = review?.hunk === undefined ? undefined : review.evidence?.hunks[review.hunk];
  const patch = hunk?.content ?? panel.patch;
  const control = (id: string, label: string, message: CodingAgentTuiMessage, disabled = false) => button<CodingAgentTuiMessage>({
    id, label, ...(disabled ? { disabled: true } : { onPress: () => message })
  });
  const content: Element<CodingAgentTuiMessage>[] = [];
  if (review !== undefined) {
    content.push(text({ content: compact ? `Recorded ${String(review.index + 1)}/${String(review.items.length)} · live not compared` : `File ${String(review.index + 1)}/${String(review.items.length)} · Recorded run evidence${hunk === undefined ? '' : ` · Hunk ${String((review.hunk ?? 0) + 1)}/${String(review.evidence?.hunks.length ?? 0)}`}` }));
    if (!compact || review.error !== undefined || review.loading) content.push(text({ content: review.error ?? (review.loading ? 'Loading…' : hunk === undefined ? 'Current working tree not compared. Patches may include other files in the same mutation.' : hunk.label), textRole: 'caption' }));
    content.push(flow([
      control('review-files', compact ? 'List' : 'Files', { type: 'panel.review-list', requestId: review.requestId }),
      control('review-file-previous', compact ? 'F‹' : 'Prev file', { type: 'panel.review-file', requestId: review.requestId, delta: -1 }, review.loading || review.index === 0),
      control('review-file-next', compact ? 'F›' : 'Next file', { type: 'panel.review-file', requestId: review.requestId, delta: 1 }, review.loading || review.index === review.items.length - 1),
      control('review-hunk-previous', compact ? 'H‹' : 'Prev hunk', { type: 'panel.review-hunk', requestId: review.requestId, direction: 'previous' }, review.loading || !review.evidence?.hunks.length || review.hunk === 0),
      control('review-hunk-next', compact ? 'H›' : 'Next hunk', { type: 'panel.review-hunk', requestId: review.requestId, direction: 'next' }, review.loading || !review.evidence?.hunks.length || review.hunk === review.evidence.hunks.length - 1),
      control('review-hunk-all', compact ? 'All' : 'Whole patch', { type: 'panel.review-hunk', requestId: review.requestId, direction: 'all' }, review.hunk === undefined)
    ], { direction: 'horizontal', gap: compact ? 0 : 1 }));
  }
  const top = content.length;
  content.push(panel.rendered && patch !== undefined
    ? measuredViewport([richText({ segments: patchSegments(patch), wrap: true })], {
        onLayout: (layout) => { inspection.layout = layout; },
        id: 'change-preview', offset: { row: panel.offset }, scrollbar: { axis: 'vertical', visible: 'auto' },
        onScroll: (request): CodingAgentTuiMessage => ({ type: 'panel.source-scroll', offset: request.nextState.offsetRow })
      })
    : textArea<CodingAgentTuiMessage>({ id: 'source-text', meta: { accessibleName: panel.title }, state: panel.input,
        readOnly: true, wrap: true, scrollbar: { axis: 'vertical', visible: 'auto' },
        onTransition: (transition: TextAreaTransition): CodingAgentTuiMessage => ({ type: 'panel.text', transition })
      }));
  const actions: Element<CodingAgentTuiMessage>[] = [];
  if (panel.patch !== undefined) actions.push(control('change-source-mode', compact ? (panel.rendered ? 'Select' : 'Color') : panel.rendered ? 'Original / select' : 'Highlighted patch', { type: 'panel.source-mode' }));
  if (review !== undefined) actions.push(
    control('review-ask', compact ? 'Ask' : hunk === undefined ? 'Ask about change' : 'Ask about hunk', { type: 'panel.review-attach', requestId: review.requestId, hunk: review.hunk, selection: false }, review.loading || review.evidence === undefined),
    control('review-ask-selection', compact ? 'Ask selection' : 'Ask about selection', { type: 'panel.review-attach', requestId: review.requestId, hunk: review.hunk, selection: true }, review.loading || review.evidence === undefined || panel.rendered || selectedSource(panel.input) === undefined)
  );
  if (actions.length) content.push(flow(actions, { direction: 'horizontal', gap: compact ? 0 : 1 }));
  if (!compact || panel.notice !== undefined) content.push(text({ content: panel.notice ?? 'Ctrl+C copies selected source · Tab moves between review controls', textRole: 'caption' }));
  return column(content, { sizes: content.map((_, index) => index === top ? { kind: 'fill', weight: 1 } : { kind: 'content' }) });
}

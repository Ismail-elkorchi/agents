import { compareText, notesView } from '@agents/tui';
import type { TextAreaTransition } from '@ismail-elkorchi/terminal-ui/behavior';
import { searchPickerView } from '@ismail-elkorchi/terminal-ui/behavior';
import type { Element, InlineContent } from '@ismail-elkorchi/terminal-ui/components';
import {
  button,
  checkbox,
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
  const title = `${state.document?.value.resource.relativePath ?? 'Writing Agent'} · ${state.application.model ?? 'Select a model'} · ${state.application.status}`;
  const main = grid(
    [
      text({ id: 'writing-status', content: title }),
      row(
        (['document', 'conversation', 'proposal', 'sources', 'findings'] as const).map((view) =>
          action(`view-${view}`, view === state.view ? `[${view}]` : view, { type: 'view', view })
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
        content:
          state.notice ||
          (state.document?.selectedRange === undefined
            ? `${state.instructionKind} · document`
            : `${state.instructionKind} · selected passage`)
      }),
      divider({ id: 'writing-divider' }),
      textArea<WritingTuiMessage>({
        id: 'writing-composer',
        meta: { accessibleName: 'Writing instruction' },
        state: state.composer,
        placeholder: `Describe the ${state.instructionKind} request`,
        wrap: true,
        scrollbar: { axis: 'vertical', visible: 'auto' },
        onTransition: (transition: TextAreaTransition): WritingTuiMessage => ({
          type: 'composer.edit',
          transition
        })
      }),
      row([
        action('writing-send', state.submitting ? 'Accepting…' : 'Send', { type: 'submit' }),
        action('writing-register', 'Add file', { type: 'form.open', subject: 'register' }),
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
    case 'proposal':
      return proposalView(state);
    case 'sources':
      return column(
        [
          action('writing-open-source', 'Open original source', { type: 'picker.open', subject: 'sources' }),
          scrollable(
            state,
            'writing-sources',
            richText({
              segments: body(
                state.project?.snapshot.sources
                  .map(
                    (source) =>
                      `${source.title ?? source.sourceId}\n${source.authoritativeIdentifiers.map((identifier) => `${identifier.scheme}: ${identifier.value}`).join(' · ')}\n${source.excerpts.map((excerpt) => `Excerpt ${excerpt.excerptId} · resource ${excerpt.resourceId} · lines ${String(excerpt.range.start.line)}–${String(excerpt.range.end.line)}`).join('\n')}\n`
                  )
                  .join('\n') ?? 'No sources registered.'
              ),
              wrap: true
            })
          )
        ],
        { sizes: [{ kind: 'fixed', cells: 1 }, { kind: 'fill' }] }
      );
    case 'findings': {
      const verification = state.proposal?.review.verification;
      const findings = [
        ...(verification?.semanticPreservationFindings ?? state.result?.semanticPreservationFindings ?? []),
        ...(verification?.editorialFindings ?? state.result?.editorialFindings ?? [])
      ];
      const checks = verification?.deterministicChecks ?? state.result?.checkResults ?? [];
      return scrollable(
        state,
        'writing-findings',
        richText({
          segments: body(
            [
              ...findings.map((finding) => `${finding.verdict} · ${finding.explanation}`),
              ...checks.map((check) => `${check.verdict} · ${check.checkId}`)
            ].join('\n\n') || 'No findings available.'
          ),
          wrap: true
        })
      );
    }
  }
}

function documentView(state: WritingTuiState, width: number): View {
  const document = state.document;
  if (document === undefined)
    return column([
      plain('Select a managed document, or add an existing project file.'),
      action('select-resource', 'Select document', { type: 'picker.open', subject: 'resources' })
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
        action('document-use-passage', 'Use passage', { type: 'document.use-passage' }),
        action('document-clear-passage', 'Whole document', { type: 'document.clear-passage' })
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
        action('writing-history-older', 'Older', { type: 'history.load', direction: 'older' }),
        action('writing-history-newer', 'Newer', { type: 'history.load', direction: 'newer' }),
        action('writing-history-tail', state.unread ? 'Latest •' : 'Latest', {
          type: 'history.load',
          direction: 'tail'
        })
      ])
    ],
    { sizes: [{ kind: 'fill' }, { kind: 'fixed', cells: 1 }] }
  );
}

function proposalView(state: WritingTuiState): View {
  const proposal = state.proposal;
  if (proposal === undefined)
    return column([
      plain('Select a proposal to inspect its wording, sources, findings, and decisions.'),
      action('writing-select-proposal', 'Select proposal', { type: 'picker.open', subject: 'proposals' })
    ]);
  const review = proposal.review;
  let changes = state.comparisonCache.get(proposal);
  if (changes === undefined) {
    changes = proposal.comparisons.flatMap((comparison) => {
      const diff = compareText(comparison.before, comparison.after);
      return [
        ...body(`${comparison.path}\n`),
        ...(diff.failure === undefined ? diff.segments : body(diff.failure)),
        ...body('\n\n')
      ];
    });
    state.comparisonCache.set(proposal, changes);
  }
  const segments: InlineContent =
    state.proposalView === 'comparison'
      ? changes
      : proposal.comparisons.flatMap((comparison) => {
          const content =
            state.proposalView === 'original'
              ? body(comparison.before)
              : state.proposalView === 'proposed'
                ? body(comparison.after)
                : body(comparison.after);
          return [...body(`${comparison.path}\n`), ...content, ...body('\n\n')];
        });
  const controls: View[] = [
    action('proposal-original', 'Original', { type: 'proposal.view', view: 'original' }),
    action('proposal-proposed', 'Proposed', { type: 'proposal.view', view: 'proposed' }),
    action('proposal-comparison', 'Changes', { type: 'proposal.view', view: 'comparison' })
  ];
  controls.push(
    action('proposal-exact-source', 'Inspect / copy source', {
      type: 'picker.open',
      subject: 'proposal-sources'
    })
  );
  if (review.status === 'proposed')
    controls.push(
      action('proposal-accept', 'Accept', { type: 'proposal.accept' }),
      action('proposal-reject', 'Reject', { type: 'proposal.reject' })
    );
  if (review.status === 'accepted')
    controls.push(
      review.authorization === undefined
        ? action('proposal-authorize', 'Authorize writing', { type: 'proposal.authorize' })
        : action('proposal-apply', 'Apply', { type: 'proposal.apply' })
    );
  if (review.status === 'applied') controls.push(action('proposal-undo', 'Undo', { type: 'revision.undo' }));
  const stale =
    review.currentProjectRevisionId !== review.proposal.baseProjectRevisionId && review.status !== 'applied';
  return column(
    [
      plain(
        `${review.status}${review.authorization === undefined ? '' : ' · authorized'}${stale ? ' · stale base revision' : ''}\n${review.proposal.proposalId}`
      ),
      scrollable(
        state,
        'proposal-content',
        richText({
          segments:
            segments.length === 0
              ? body(JSON.stringify(review.proposal.structuralChanges, null, 2))
              : segments,
          wrap: true
        })
      ),
      scrollable(state, 'writing-proposal-actions', column(controls))
    ],
    {
      sizes: [
        { kind: 'fixed', cells: 2 },
        { kind: 'fill' },
        { kind: 'fixed', cells: Math.min(6, controls.length) }
      ]
    }
  );
}

function modalView(state: WritingTuiState, width: number, height: number): View | undefined {
  const modal = state.overlay;
  const close = action('writing-modal-close', 'Close', { type: 'overlay.close' });
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
        onTransition: (transition) => ({ type: 'picker.transition', transition }),
        onAccept: (event) => ({ type: 'picker.accept', id: event.id })
      });
      break;
    case 'accept': {
      title = 'Accept this exact proposal';
      focusId = 'confirm-accept';
      const criteria =
        state.project?.snapshot.brief.acceptanceCriteria.filter(
          (criterion) => criterion.verificationKind === 'human'
        ) ?? [];
      content = scrollable(
        state,
        'writing-acceptance-criteria',
        column([
          richText({
            segments: body(
              'Confirm only criteria you have reviewed. Acceptance does not write the document.'
            ),
            wrap: true
          }),
          ...criteria.flatMap((criterion) => [
            richText({ segments: body(criterion.statement), wrap: true }),
            checkbox<WritingTuiMessage>({
              id: `criterion:${criterion.criterionId}`,
              label: 'I reviewed this criterion',
              checked: modal.selectedCriteria.includes(criterion.criterionId),
              onTransition: () => ({ type: 'criterion.toggle', id: criterion.criterionId })
            })
          ]),
          action('confirm-accept', 'Accept proposal', { type: 'proposal.confirm-accept' })
        ])
      );
      break;
    }
    case 'form':
      title = modal.subject === 'configure' ? 'Model configuration' : 'Register an existing document';
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
    focusPolicy: { initialFocus: { kind: 'element', elementId: focusId }, returnFocus: 'restore' },
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
function body(content: string): InlineContent {
  return [{ kind: 'text', text: content }];
}

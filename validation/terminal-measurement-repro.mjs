import { defineSemanticLeafComponent } from '@ismail-elkorchi/terminal-ui/component';
import { createMeasuredCollection, measuredWindow } from '@ismail-elkorchi/terminal-ui/collection';
import { text } from '@ismail-elkorchi/terminal-ui/components';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { grid, measuredViewport } from '@ismail-elkorchi/terminal-ui/layout';
import { createTuiRuntime, defineTui } from '@ismail-elkorchi/terminal-ui/tui';

let measurements = 0;
const item = defineSemanticLeafComponent({
  name: 'validation/components/measurement-probe',
  identity: 'required',
  accessibleRole: 'text',
  createModel: () => ({}),
  measure() {
    measurements++;
    return { minWidth: 0, minHeight: 0, preferredWidth: 9, preferredHeight: 1 };
  },
  render: ({ target }) => target.write(0, 0, [{ text: 'Unchanged' }]),
  accessibility: ({ id }) => ({ id, role: 'text', label: 'Unchanged' })
})({ id: 'unchanged' });
const collection = createMeasuredCollection([{ id: 'row', value: null, rows: 1 }]);
const window = measuredWindow(collection, { viewportRows: 20, offsetRow: 0 });
const retained = measuredViewport(window, () => item, {
  id: 'history',
  scrollbar: { axis: 'vertical', visible: 'always' },
  onScroll: () => ({})
});
const runtime = createTuiRuntime({
  host: createMemoryTerminalHost({ terminalSize: { columns: 48, rows: 24 } }),
  app: defineTui({
    id: 'measurement-reproduction',
    init: () => ({ state: 0 }),
    update: (state) => ({ state: state + 1 }),
    view: (state) =>
      grid([retained, text({ content: String(state) })], {
        rows: [{ kind: 'fixed', cells: 20 }, { kind: 'fill' }]
      })
  })
});
try {
  await runtime.start();
  const afterStart = measurements;
  for (let i = 0; i < 10; i++) await runtime.dispatch({});
  console.log(
    JSON.stringify(
      {
        scope: 'Same element, measured collection, window, width, content and theme; only a sibling changes.',
        afterStart,
        afterTenSiblingUpdates: measurements,
        frameCommits: runtime.metrics().frameCommits
      },
      null,
      2
    )
  );
} finally {
  await runtime.dispose();
}

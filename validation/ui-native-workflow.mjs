// Run in a real terminal emulator, then exercise help, review, navigation and approval controls.
// This is UI qualification with synthetic evidence, not a live-model or execution benchmark.
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { createTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { runTui, TuiRunError } from '@ismail-elkorchi/terminal-ui/tui';
import { createUiWorkflowFixture } from './ui-workflow-fixture.mjs';

const [evidence, outputMode = 'visual'] = process.argv.slice(2);
if (!evidence || !path.isAbsolute(evidence) || !['visual', 'accessible'].includes(outputMode))
  throw new Error('Usage: node validation/ui-native-workflow.mjs /absolute/evidence-prefix [visual|accessible]');
mkdirSync(path.dirname(evidence), { recursive: true });
const native = createTerminalHost({ runtime: 'node' });
const fixture = await createUiWorkflowFixture();
let frames = 0;
const host = { ...native,
  stdin: { release: native.stdin.release?.bind(native.stdin), async *read(options) {
    for await (const chunk of native.stdin.read(options)) {
      appendFileSync(`${evidence}.input.jsonl`, `${JSON.stringify({ hex: Buffer.from(chunk.data).toString('hex') })}\n`);
      yield chunk;
    }
  } },
  observer: { recordFrame(frame) {
    frames++;
    writeFileSync(`${evidence}.frame.txt`, renderFramePlain(frame));
    writeFileSync(`${evidence}.focus.json`, JSON.stringify(frame.focusPath));
    appendFileSync(`${evidence}.frames.jsonl`, `${JSON.stringify({ sequence: frames, text: renderFramePlain(frame), focus: frame.focusPath })}\n`);
  } }
};
try {
  writeFileSync(`${evidence}.capabilities.json`, JSON.stringify({ term: process.env.TERM, outputMode,
    capabilities: await native.getCapabilities({ signal: new AbortController().signal }) }, null, 2));
  const result = await runTui(fixture.app, { host, outputMode });
  writeFileSync(`${evidence}.result.json`, JSON.stringify({ scope: 'Native terminal UI with deterministic presentation fixture; no model calls or tool execution.',
    reason: result.reason, frames, draft: textDocumentText(result.state.composer.input.document),
    overlay: result.state.overlay.kind, decisions: fixture.decisions, submissions: fixture.submissions,
    diagnostics: result.diagnostics }, null, 2));
} catch (error) {
  writeFileSync(`${evidence}.error.txt`, error.stack ?? String(error));
  if (error instanceof TuiRunError) writeFileSync(`${evidence}.diagnostics.json`, JSON.stringify(error.exit.diagnostics, null, 2));
  process.exitCode = 1;
} finally {
  await fixture.close();
  await native.dispose();
}

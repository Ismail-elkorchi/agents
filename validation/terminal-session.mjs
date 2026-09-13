import { TuiRunError } from '@ismail-elkorchi/terminal-ui/tui';import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
// Run inside a real terminal emulator. All product data is isolated in temporary fixtures.
import { writeFileSync, appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { openCodingApplication } from '@ismail-elkorchi/coding-agent';
import { runCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';
import { runWritingAgentTuiApp } from '@ismail-elkorchi/writing-agent/tui';
import { fixture, patchResponse } from '../writing-agent/test/helpers/runtime.js';
import {
  createWorkspace,
  scriptedOllama,
  finalResponse,
  trust
} from '../coding-agent/test/fixtures/scripted-cli.js';
const [agent, evidence] = process.argv.slice(2);
if (!['coding', 'writing'].includes(agent) || evidence === undefined)
  throw new Error('Usage: node validation/terminal-session.mjs coding|writing /absolute/evidence-prefix');
const native = createTerminalHost({ runtime: 'node' });
writeFileSync(
  `${evidence}.capabilities.json`,
  JSON.stringify(
    {
      term: process.env.TERM,
      multiplexer: process.env.TMUX !== undefined,
      capabilities: await native.getCapabilities({ signal: new AbortController().signal })
    },
    null,
    2
  )
);
const host = {
  ...native,
  stdin: {
    release: native.stdin.release?.bind(native.stdin),
    async *read(options) {
      for await (const chunk of native.stdin.read(options)) {
        appendFileSync(
          `${evidence}.input.jsonl`,
          `${JSON.stringify({ hex: Buffer.from(chunk.data).toString('hex') })}\n`
        );
        yield chunk;
      }
    }
  },
  observer: {
    recordFrame(frame) {
      writeFileSync(`${evidence}.frame.txt`, renderFramePlain(frame));
      writeFileSync(`${evidence}.focus.json`, JSON.stringify(frame.focusPath));
    }
  }
};
try {
  if (agent === 'coding') {
    const provider = await scriptedOllama([
      finalResponse('# Result\n\nUnicode café 世界 👩🏽‍💻.\n\n```ts\nconst value = 2;\n```\n')
    ]);
    const f = await createWorkspace({ endpoint: provider.endpoint, tools: ['read_files'], checks: [] });
    try {
      await trust(f);
      const application = await openCodingApplication({
        root: f.root,
        stateRoot: f.stateRoot,
        providerEndpoint: provider.endpoint
      });
      const result = await runCodingAgentTuiApp(application, { host });
      writeFileSync(
        `${evidence}.result.json`,
        JSON.stringify({
          reason: result.exit.reason,
          draft: textDocumentText(result.exit.state.composer.input.document),
          diagnostics: result.exit.diagnostics
        })
      );
    } finally {
      await provider.close();
      await f.close();
    }
  } else {
    const f = await fixture('# Document\n\nOld line.\n\nClosing.\n', {
      responses: [
        patchResponse(
          '*** Begin Patch\n*** Update File: document.txt\n@@\n-Old line.\n+New line.\n*** End Patch'
        ),
        'Updated.'
      ]
    });
    try {
      const result = await runWritingAgentTuiApp(f.application, { host });
      writeFileSync(
        `${evidence}.result.json`,
        JSON.stringify({
          reason: result.reason,
          document: await readFile(path.join(f.root, 'document.txt'), 'utf8'),
          draft: textDocumentText(result.state.composer.input.document),
          diagnostics: result.diagnostics
        })
      );
    } finally {
      await f.close();
    }
  }
} catch (error) {
  writeFileSync(`${evidence}.error.txt`, error.stack);
  if (error instanceof TuiRunError)
    writeFileSync(`${evidence}.diagnostics.json`, JSON.stringify(error.exit.diagnostics, null, 2));
  process.exitCode = 1;
} finally {
  await host.dispose();
}

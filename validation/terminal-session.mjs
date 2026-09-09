import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
// Run inside a real terminal emulator. All product data is isolated in temporary fixtures.
import { writeFileSync } from 'node:fs';
import { rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { openCodingApplication } from '@ismail-elkorchi/coding-agent';
import { runCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';
import { WritingApplication } from '@ismail-elkorchi/writing-agent';
import { runWritingAgentTuiApp } from '@ismail-elkorchi/writing-agent/tui';
import {
  fixture,
  passingChecker,
  ScriptedWritingProvider,
  revisionResponse
} from '../writing-agent/test/helpers/runtime.js';
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
const host = {
  ...native,
  observer: {
    recordFrame(frame) {
      writeFileSync(`${evidence}.frame.txt`, renderFramePlain(frame));
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
    const f = await fixture('# Document\n\nOld line.\n\nClosing.\n');
    try {
      const provider = new ScriptedWritingProvider([
        revisionResponse(f.resource.resourceId, 'New line.'),
        'Proposal ready.'
      ]);
      const application = new WritingApplication(f.project, {
        configuration: { provider, model: 'writing-test', editorialChecker: passingChecker }
      });
      const result = await runWritingAgentTuiApp(application, { host });
      writeFileSync(
        `${evidence}.result.json`,
        JSON.stringify({
          reason: result.reason,
          document: await readFile(path.join(f.root, f.resource.relativePath), 'utf8'),
          draft: textDocumentText(result.state.composer.document),
          diagnostics: result.diagnostics
        })
      );
    } finally {
      await rm(f.parent, { recursive: true, force: true });
    }
  }
} catch (error) {
  writeFileSync(`${evidence}.error.txt`, error.stack);
  process.exitCode = 1;
} finally {
  await host.dispose();
}

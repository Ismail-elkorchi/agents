import { openWritingApplication } from '@ismail-elkorchi/writing-agent';
import { runWritingRpc } from '@ismail-elkorchi/writing-agent/rpc';
import { ScriptedWritingProvider, patchResponse } from './runtime.js';
const [rootDirectory, stateRoot] = process.argv.slice(2);
const application = await openWritingApplication({ rootDirectory, stateRoot, configuration: {
  provider: new ScriptedWritingProvider([
    patchResponse('*** Begin Patch\n*** Update File: document.txt\n@@\n-Old line.\n+New line.\n*** End Patch'),
    'Updated.', 'The revised wording is concise.'
  ]), model: 'writing-test'
} });
await runWritingRpc(application, { input: process.stdin, output: process.stdout,
  diagnostic: (message) => process.stderr.write(`${message}\n`) });

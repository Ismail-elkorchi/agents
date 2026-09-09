import { openWritingApplication } from '@ismail-elkorchi/writing-agent';
import { runWritingRpc } from '@ismail-elkorchi/writing-agent/rpc';
import { ScriptedWritingProvider, passingChecker, revisionResponse } from './runtime.js';
const [rootDirectory, stateRoot, resourceId, scenario] = process.argv.slice(2);
const response = revisionResponse(resourceId, 'New line.');
const application = await openWritingApplication({
  rootDirectory,
  stateRoot,
  configuration: {
    provider: new ScriptedWritingProvider([
      response,
      'Proposed.',
      response,
      'Proposed again.',
      response,
      'Further proposal.'
    ]),
    model: 'writing-test',
    editorialChecker:
      scenario === 'verification-failure'
        ? {
            ...passingChecker,
            async verify() {
              throw new Error('Editorial service failed after acceptance.');
            }
          }
        : passingChecker
  }
});
await runWritingRpc(application, {
  input: process.stdin,
  output: process.stdout,
  diagnostic: (message) => process.stderr.write(`${message}\n`)
});

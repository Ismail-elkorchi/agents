import assert from 'node:assert/strict';
import { toolResponse, finalResponse } from './scripted-cli.js';

// Consume the model-facing presentation: metadata JSON followed by rendered
// output text. It deliberately differs from the structured tool observation.
export function checkedCommandScript(command, expectedOutput, afterCommand) {
  const next = request => {
    const message = request.messages.at(-1);
    if (message.tool_name === 'apply_patch') return finalResponse('Done');
    assert(['exec_command', 'write_stdin'].includes(message.tool_name));
    const [metadata, ...output] = message.content.split('\n\n');
    const process = JSON.parse(metadata);
    if (process.status === 'running' || process.finalizationPending) {
      assert.equal(typeof process.processId, 'string');
      return toolResponse('write_stdin', {
        processId: process.processId, afterCursor: 0, yieldMs: 1000
      });
    }
    assert.equal(process.status, 'exited', metadata);
    assert.equal(process.exitCode, 0, metadata);
    assert.equal(process.outputCoverage, 'complete', metadata);
    assert.match(output.join('\n\n'), expectedOutput);
    return afterCommand;
  };
  return [toolResponse('exec_command', { command, yieldMs: 1 }),
    ...Array.from({ length: 22 }, () => next)];
}

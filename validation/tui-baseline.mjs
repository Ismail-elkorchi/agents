import { cpus, platform, release } from 'node:os';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { createCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';

const measurements = [];
for (const columns of [48, 120]) {
  const host = createMemoryTerminalHost({ terminalSize: { columns, rows: 32 } });
  const runtime = createTuiRuntime({ app: createCodingAgentTuiApp(''), host });
  const started = performance.now();
  await runtime.start();
  const startupMs = performance.now() - started;
  const times = [];
  for (let index = 0; index < 80; index++) {
    const content = `## Response ${index}\n\nA paragraph with **emphasis**, Unicode café 世界, and a [reference](https://example.com).\n\n\`\`\`ts\nconst value = ${index};\n\`\`\``;
    const before = performance.now();
    await runtime.dispatch({
      type: 'progress',
      event: {
        type: 'assistant.ended',
        turnIndex: index + 1,
        turnId: `turn-${index}`,
        requestAttempt: 1,
        content,
        modelOutput: { status: 'complete', message: content, source: 'content', turnIndex: index + 1 }
      }
    });
    times.push(performance.now() - before);
  }
  const beforeInput = performance.now();
  await runtime.handleInput({ kind: 'paste', text: 'A multiline\nprompt with Unicode 👋', bracketed: true });
  const inputMs = performance.now() - beforeInput;
  times.sort((left, right) => left - right);
  measurements.push({
    columns,
    rows: 32,
    startupMs,
    appendP95Ms: times[Math.floor(times.length * 0.95)],
    inputMs
  });
  await runtime.dispose();
}
console.log(
  JSON.stringify(
    {
      environment: {
        runtime: process.version,
        platform: platform(),
        release: release(),
        cpu: cpus()[0]?.model
      },
      scope: 'Memory-host application rendering; no physical terminal or model latency measurement.',
      workload: { messages: 80, markdown: true, unicode: true, multilinePaste: true },
      budgets: { inputP95Ms: 50, appendP95Ms: 50, historyPageP95Ms: 100 },
      measurements
    },
    null,
    2
  )
);

import { cpus, loadavg, platform, release, tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { createCodingAgentTuiApp } from '@ismail-elkorchi/coding-agent/tui';
import { createWritingAgentTuiApp } from '@ismail-elkorchi/writing-agent/tui';
import { waitForState } from '../tui/test/helpers/runtime.js';

const p95 = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)];
const measurements = [];
const hostSample = () => ({ cpuSpeedsMHz: cpus().map((cpu) => cpu.speed), loadAverage: loadavg() });
const hostBefore = hostSample();
const directory = await mkdtemp(path.join(tmpdir(), 'agents-history-measure-'));
try {
  const repository = new JsonlSessionRepository({ rootDir: directory });
  const descriptor = await repository.create({
    binding: { schemaId: 'validation/history', schemaVersion: 1, subject: {} }
  });
  for (let i = 0; i < 700; i++)
    await repository.appendInput(descriptor, {
      runId: `run-${i}`,
      task: `Instruction ${i}\n${'文 '.repeat(1500)}`
    });
  const coldReader = new JsonlSessionRepository({ rootDir: directory });
  const coldStart = performance.now();
  const latest = await coldReader.readBranchPage(descriptor);
  const coldPageMs = performance.now() - coldStart;
  const beforeReads = coldReader.historyReadMetrics(descriptor.id);
  const pageTimes = [];
  let page = latest;
  for (let i = 0; i < 40; i++) {
    const start = performance.now();
    page = await coldReader.readBranchPage(
      descriptor,
      page.older === undefined ? undefined : { cursor: page.older }
    );
    pageTimes.push(performance.now() - start);
  }
  const afterReads = coldReader.historyReadMetrics(descriptor.id);
  const sourceReads = { coldPageMs, warmPageP95Ms: p95(pageTimes), beforeReads, afterReads };
  for (const agent of ['coding', 'writing'])
    for (const columns of [48, 120]) {
      global.gc?.();
      const heapBefore = process.memoryUsage().heapUsed;
      const host = createMemoryTerminalHost({ terminalSize: { columns, rows: 32 } });
      const service = {
        state: () => ({ workspace: '/workspace', mode: 'edit', sessionId: descriptor.id, status: 'ready' }),
        start: async () => {},
        readSession: async () => ({ session: { sessionId: descriptor.id, phase: 'idle' }, runs: [] }),
        readHistory: (request) => coldReader.readBranchPage(descriptor, request)
      };
      const runtime = createTuiRuntime({
        host,
        app: agent === 'coding' ? createCodingAgentTuiApp('') : createWritingAgentTuiApp(service)
      });
      await runtime.start();
      if (agent === 'writing') {
        await runtime.dispatch({ type: 'view', view: 'conversation' });
        await waitForState(runtime, AbortSignal.timeout(30_000), () => runtime.state().history.length > 0);
      }
      const appendTimes = [];
      for (let index = 0; index < 80; index++) {
        const content = `## Response ${index}\n\nA paragraph with **emphasis**, Unicode café 世界, and a [reference](https://example.com).\n\n\`\`\`ts\nconst value = ${index};\n\`\`\``;
        const start = performance.now();
        await runtime.dispatch({
          type: 'progress',
          event: {
            type: 'assistant.delta',
            turnId: agent === 'coding' ? `turn-${index}` : 'turn',
            turnIndex: index + 1,
            requestAttempt: 1,
            delta: content,
            accumulated: content
          }
        });
        appendTimes.push(performance.now() - start);
      }
      const inputTimes = [];
      for (let i = 0; i < 60; i++) {
        const start = performance.now();
        await runtime.dispatch({
          type: 'composer.edit',
          transition: {
            kind: 'edit',
            operation: { kind: 'insert', text: i === 0 ? 'A multiline\nprompt with Unicode 👋' : 'a' }
          }
        });
        inputTimes.push(performance.now() - start);
      }
      global.gc?.();
      const heapWithRecordedFrames = process.memoryUsage().heapUsed;
      measurements.push({
        agent,
        columns,
        rows: 32,
        inputP95Ms: p95(inputTimes),
        appendP95Ms: p95(appendTimes),
        heapBefore,
        heapWithRecordedFrames,
        retainedFrames: host.frames().length,
        metrics: runtime.metrics()
      });
      await runtime.dispose();
    }
  const budgets = { inputP95Ms: 50, appendP95Ms: 50, historyPageP95Ms: 100 };
  const passed =
    measurements.every(
      (item) => item.inputP95Ms <= budgets.inputP95Ms && item.appendP95Ms <= budgets.appendP95Ms
    ) && sourceReads.warmPageP95Ms <= budgets.historyPageP95Ms;
  console.log(
    JSON.stringify(
      {
        environment: {
          runtime: process.version,
          platform: platform(),
          release: release(),
          cpu: cpus()[0]?.model,
          hostBefore,
          hostAfter: hostSample(),
          cpuProfiling: process.execArgv.includes('--cpu-prof')
        },
        scope:
          'Memory-host latency includes update, layout and rendering. Heap includes the host recording all frames; it is not a live terminal steady-state heap estimate. Cold index creation and bounded warm body reads measured from JSONL.',
        workload: {
          historyEntries: 700,
          historySourceTextBytes: 700 * Buffer.byteLength('文 '.repeat(1500)),
          appendUpdates: 80,
          inputUpdates: 60
        },
        budgets,
        sourceReads,
        measurements,
        passed
      },
      null,
      2
    )
  );
  if (!passed) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}

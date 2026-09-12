import { mkdir, mkdtemp, open as openFile, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { openCodingApplication } from '@ismail-elkorchi/coding-agent';
import { measureMarkdownWords } from '@agents/verification';

const { values } = parseArgs({ options: {
  live: { type: 'boolean' }, model: { type: 'string' }, reasoning: { type: 'string' },
  output: { type: 'string' }, trials: { type: 'string', default: '2' },
  'commands-only': { type: 'boolean' }
} });
const trials = Number(values.trials);
if (!values.live || !values.model || !values.reasoning || !values.output || !Number.isSafeInteger(trials) || trials < 1)
  throw new Error('Usage: node validation/coding-agent-reliability.mjs --live --model MODEL --reasoning EFFORT --output FILE [--trials 2] [--commands-only]');

const directory = await mkdtemp(path.join(tmpdir(), 'coding-agent-reliability-'));
const settings = {
  provider: 'openai-codex', model: values.model,
  reasoning: { strategy: 'effort', effort: values.reasoning },
  permissionMode: 'develop', maxOutputTokens: 4096
};
const revisionTrials = values['commands-only'] ? 0 : trials;
const report = {
  startedAt: new Date().toISOString(), settings, evidenceDirectory: directory,
  scenario: values['commands-only'] ? 'commands' : 'revisions-and-commands', trials: [], commands: undefined
};
await mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
const reportFile = await openFile(values.output, 'wx', 0o600);
async function saveReport() {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  await reportFile.write(text, 0, 'utf8');
  await reportFile.truncate(Buffer.byteLength(text));
}
const original = '# A quieter morning\n\nI started waking up earlier. It gave me more time to read and think before work.\n';
const prompts = [
  'what is in draft.md ?',
  'compelete it and make it 1000 words',
  'what do you think of the changed draft.md ?',
  'tighten those ideas, and a small complication to make the narrator feel even more specific'
];

async function open(name, files) {
  const root = path.join(directory, name, 'workspace');
  await mkdir(root, { recursive: true });
  for (const [file, content] of Object.entries(files)) await writeFile(path.join(root, file), content);
  const application = await openCodingApplication({
    ...settings, root, stateRoot: path.join(directory, name, 'state'), sessionSelection: { kind: 'new' }
  });
  await application.start();
  await application.selectWorkspaceTrust('trusted');
  return { application, root };
}

async function run(application, task) {
  const acceptance = await application.submit({ task });
  if (acceptance.kind !== 'started') throw new Error(`Submission was ${acceptance.kind}.`);
  const deadline = setTimeout(() => void application.abort('Live evaluation deadline.', acceptance.runId), 300_000);
  let result;
  try { result = await acceptance.completion; }
  finally { clearTimeout(deadline); }
  const { history } = await application.readSession();
  const entries = history.entries.filter((entry) => entry.runId === acceptance.runId);
  const observations = entries.filter((entry) => entry.type === 'observation');
  const terminal = result.state === 'ended' ? result.terminal : undefined;
  return {
    task, runId: acceptance.runId, state: result.state,
    ...(terminal ? {
      executionStatus: terminal.executionStatus, terminationReason: terminal.terminationReason,
      elapsedMs: terminal.budget.elapsedMs, modelTurns: terminal.budget.modelTurns,
      promptTokens: terminal.budget.promptTokens, completionTokens: terminal.budget.completionTokens,
      response: terminal.modelOutput.message
    } : { reason: result.reason }),
    tools: entries.filter((entry) => entry.type === 'tool_call').map((entry) => entry.call.name),
    measurements: observations.filter((entry) => entry.toolName === 'count_markdown_words' && entry.ok).map((entry) => entry.output),
    commandResults: observations.filter((entry) => entry.toolName === 'exec_command' || entry.toolName === 'write_stdin').map((entry) => entry.output),
    failures: observations.filter((entry) => !entry.ok).map(({ toolName, summary }) => ({ toolName, summary })),
    records: application.persistenceLocations(acceptance.runId)
  };
}

try {
  for (let trial = 1; trial <= revisionTrials; trial++) {
    const { application, root } = await open(`trial-${trial}`, { 'draft.md': original });
    const steps = [];
    report.trials.push({ trial, steps });
    try {
      let previous = original;
      for (const [index, task] of prompts.entries()) {
        const result = await run(application, task);
        const saved = await readFile(path.join(root, 'draft.md'), 'utf8');
        const measured = measureMarkdownWords(saved);
        const readOnly = index === 0 || index === 2;
        const verified = result.measurements.some((measurement) =>
          measurement.inputSha256 === measured.inputSha256 && measurement.words === measured.words);
        const checks = {
          completed: result.executionStatus === 'completed',
          requestedResult: readOnly ? saved === previous : measured.words === 1000,
          verifiedSavedRevision: readOnly || verified,
          replyAddressesUser: !/workspace context (?:noted|received)/iu.test(result.response ?? '')
        };
        steps.push({ ...result, measured, checks, passed: Object.values(checks).every(Boolean) });
        await saveReport();
        previous = saved;
        console.log(JSON.stringify({ trial, step: index + 1, words: measured.words, tools: result.tools, checks }));
        if (result.state !== 'ended') break;
      }
    } finally { await application.close(); }
  }

  const { application, root } = await open('commands', { 'draft.md': original });
  try {
    const result = await run(application,
      'Run node --version, npm --version, and wc -w draft.md. Then use a shell command to create command-check.txt containing sandbox works. Report the observed outputs.');
    const output = result.commandResults.map((item) => item?.stdout?.text ?? '').join('\n');
    const checks = {
      completed: result.executionStatus === 'completed',
      commandSucceeded: result.commandResults.some((output) => output?.status === 'exited' && output.exitCode === 0),
      versionsObserved: /v\d+\.\d+\.\d+/u.test(output) && /^\d+\.\d+\.\d+$/mu.test(output),
      wordCountObserved: /20\s+draft\.md/u.test(output),
      workspaceWrite: (await readFile(path.join(root, 'command-check.txt'), 'utf8').catch(() => '')).trim() === 'sandbox works'
    };
    report.commands = { ...result, checks, passed: Object.values(checks).every(Boolean) };
    console.log(JSON.stringify({ scenario: 'commands', checks }));
  } finally { await application.close(); }
} finally {
  report.finishedAt = new Date().toISOString();
  report.passed = report.trials.length === revisionTrials && report.trials.every(({ steps }) =>
    steps.length === prompts.length && steps.every((step) => step.passed)) && report.commands?.passed === true;
  await saveReport();
  await reportFile.close();
  console.log(`Report: ${path.resolve(values.output)}`);
  if (!report.passed) process.exitCode = 1;
}

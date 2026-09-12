import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { openCodingApplication } from '@ismail-elkorchi/coding-agent';

const execute = promisify(execFile);
const { values } = parseArgs({
  options: {
    live: { type: 'boolean' },
    provider: { type: 'string' },
    model: { type: 'string' },
    reasoning: { type: 'string' },
    endpoint: { type: 'string' },
    output: { type: 'string' },
    scenario: { type: 'string' },
    trials: { type: 'string', default: '1' }
  }
});

// These are evaluation fixtures, never application tools or instructions.
const scenarios = [
  {
    id: 'module-repair',
    files: {
      'math.mjs':
        'export const sum = (values) => values.reduce((total, value) => total + value);\nexport const label = "unchanged";\n',
      'check.mjs':
        'import assert from "node:assert/strict"; import { sum, label } from "./math.mjs"; assert.equal(sum([]), 0); assert.equal(sum([2, -3, 4]), 3); assert.equal(label, "unchanged");\n',
      'unrelated.txt': 'User-owned content.\n'
    },
    steps: [
      {
        task: 'Fix sum in math.mjs so it handles an empty array and preserves existing behavior. Run check.mjs. Leave other files unchanged.',
        async check(root, scenario) {
          await execute(process.execPath, ['check.mjs'], { cwd: root });
          return {
            behavior: true,
            unrelated: await unchanged(root, scenario, [
              'check.mjs',
              'unrelated.txt'
            ])
          };
        }
      }
    ]
  },
  {
    id: 'changing-requirements',
    files: {
      'settings.json': '{"port":3000,"theme":"dark","languages":["en","fr"]}\n'
    },
    steps: [
      {
        task: 'Set the port in settings.json to 8080 and theme to light. Preserve the languages.',
        async check(root) {
          return {
            settings: equal(await json(root, 'settings.json'), {
              port: 8080,
              theme: 'light',
              languages: ['en', 'fr']
            })
          };
        }
      },
      {
        task: 'Actually, use port 9090 and remove the theme setting. Keep the languages.',
        async check(root) {
          return {
            settings: equal(await json(root, 'settings.json'), {
              port: 9090,
              languages: ['en', 'fr']
            })
          };
        }
      }
    ]
  },
  {
    id: 'read-only-review',
    files: {
      'notes.md': '# Notes\n\nThe cache expires after one hour.\n',
      'cache.json': '{"ttlSeconds":3600}\n',
      'style.css': 'body { color: navy; }\n'
    },
    steps: [
      {
        task: 'Explain what these three files contain and whether the cache duration agrees. Do not edit files.',
        async check(root, scenario) {
          return {
            filesUnchanged: await unchanged(
              root,
              scenario,
              Object.keys(scenario.files)
            )
          };
        }
      }
    ]
  },
  {
    id: 'process-lifecycle',
    files: {},
    steps: [
      {
        task: 'Use a Node shell command that waits one second, writes ready.txt containing ready, and exits. Wait for it to finish, then read the saved file and report the result.',
        async check(root) {
          return {
            savedResult:
              (await readFile(path.join(root, 'ready.txt'), 'utf8')) === 'ready'
          };
        }
      }
    ]
  }
];

const selected = values.scenario
  ? scenarios.filter(({ id }) => id === values.scenario)
  : scenarios;
const trials = Number(values.trials);
if (
  !values.live ||
  !values.provider ||
  !values.model ||
  !values.output ||
  selected.length === 0 ||
  !Number.isSafeInteger(trials) ||
  trials < 1
)
  throw new Error(
    `Usage: node validation/coding-agent-evaluation.mjs --live --provider PROVIDER --model MODEL --output FILE [--reasoning EFFORT] [--endpoint URL] [--trials N] [--scenario ${scenarios.map(({ id }) => id).join('|')}]`
  );

await mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
const output = await open(values.output, 'wx', 0o600);
const directory = await mkdtemp(
  path.join(tmpdir(), 'coding-agent-evaluation-')
);
const settings = {
  provider: values.provider,
  model: values.model,
  permissionMode: 'develop',
  ...(values.reasoning
    ? {
        reasoning:
          values.reasoning === 'none'
            ? { strategy: 'disabled' }
            : { strategy: 'effort', effort: values.reasoning }
      }
    : {}),
  ...(values.endpoint ? { providerEndpoint: values.endpoint } : {})
};
const report = {
  startedAt: new Date().toISOString(),
  settings,
  directory,
  trials: []
};
try {
  for (const scenario of selected)
    for (let trial = 1; trial <= trials; trial++) {
      const root = path.join(directory, `${scenario.id}-${trial}`, 'workspace');
      await mkdir(root, { recursive: true });
      for (const [file, content] of Object.entries(scenario.files))
        await writeFile(path.join(root, file), content);
      const app = await openCodingApplication({
        ...settings,
        root,
        stateRoot: path.join(root, '..', 'state'),
        sessionSelection: { kind: 'new' }
      });
      const steps = [];
      report.trials.push({ scenario: scenario.id, trial, steps });
      try {
        await app.start();
        await app.selectWorkspaceTrust('trusted');
        for (const step of scenario.steps) {
          const accepted = await app.submit({ task: step.task });
          if (accepted.kind !== 'started')
            throw new Error(`Submission was ${accepted.kind}.`);
          const deadline = setTimeout(() => {
            void app
              .abort('Evaluation deadline.', accepted.runId)
              .catch((error) => {
                console.error(String(error));
              });
          }, 300_000);
          let result;
          try {
            result = await accepted.completion;
          } finally {
            clearTimeout(deadline);
          }
          let checks;
          try {
            checks = await step.check(root, scenario);
          } catch (error) {
            checks = { fixtureCheck: false, diagnostic: error.message };
          }
          const terminal =
            result.state === 'ended' ? result.terminal : undefined;
          const history = await app.readSession();
          const record = {
            task: step.task,
            runId: accepted.runId,
            state: result.state,
            response: terminal?.modelOutput.message,
            budget: terminal?.budget,
            terminationReason: terminal?.terminationReason,
            tools: history.history.entries
              .filter(
                (entry) =>
                  entry.runId === accepted.runId && entry.type === 'tool_call'
              )
              .map((entry) => entry.call.name),
            checks,
            passed:
              terminal?.executionStatus === 'completed' &&
              Object.values(checks).every((value) => value === true)
          };
          steps.push(record);
          console.log(
            JSON.stringify({ scenario: scenario.id, trial, ...record })
          );
          if (result.state !== 'ended') break;
        }
      } catch (error) {
        steps.push({
          passed: false,
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        await app.close();
      }
      await saveReport();
    }
  report.finishedAt = new Date().toISOString();
  report.passed =
    report.trials.length === selected.length * trials &&
    report.trials.every(
      (trial) =>
        trial.steps.length ===
          selected.find(({ id }) => id === trial.scenario).steps.length &&
        trial.steps.every(({ passed }) => passed)
    );
  if (!report.passed) process.exitCode = 1;
} finally {
  try {
    await saveReport();
  } finally {
    await output.close();
  }
}

async function saveReport() {
  await output.truncate(0);
  const data = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  let offset = 0;
  while (offset < data.length)
    offset += (await output.write(data, offset, data.length - offset, offset))
      .bytesWritten;
}

async function json(root, file) {
  return JSON.parse(await readFile(path.join(root, file), 'utf8'));
}
function equal(actual, expected) {
  return (
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(
      ([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value)
    )
  );
}
async function unchanged(root, scenario, files) {
  return (
    await Promise.all(
      files.map(
        async (file) =>
          (await readFile(path.join(root, file), 'utf8')) ===
          scenario.files[file]
      )
    )
  ).every(Boolean);
}

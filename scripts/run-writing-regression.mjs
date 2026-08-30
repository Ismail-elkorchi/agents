import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WRITING_REGRESSION_LOCK_SHA256,
  assertWritingRegressionLock,
  validateWritingEvaluationCorpus,
  writingEvaluationTasks,
  writingRegressionCorpusSha256
} from '../writing-agent/dist/index.js';

validateWritingEvaluationCorpus();
assertWritingRegressionLock();
const tasks = writingEvaluationTasks('regression');
if (tasks.length === 0 || tasks.some((task) => task.set !== 'regression')) throw new Error('Writing regression discovery did not remain a distinct task set.');
if (tasks.some((task) => task.graders.every((grader) => grader.requirement !== 'required'))) throw new Error('Every writing regression task requires at least one required grader.');
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execution = spawnSync(process.execPath, ['--test', 'writing-agent/test/writing-agent.test.js'], { cwd: repositoryRoot, stdio: 'inherit' });
if (execution.error !== undefined) throw execution.error;
if (execution.status !== 0) throw new Error(`Writing regression behavior suite failed with status ${String(execution.status)}.`);
process.stdout.write(`writing regression corpus executed: ${String(tasks.length)} tasks, sha256 ${writingRegressionCorpusSha256()} (lock ${WRITING_REGRESSION_LOCK_SHA256})\n`);

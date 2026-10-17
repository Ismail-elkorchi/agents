import { run } from 'node:test';
import path from 'node:path';

// Copied into the immutable verifier archive. Candidate stdout is not a receipt.
export function reportAcceptance(status, evidence) {
  console.log(JSON.stringify({ format: 'agents.acceptance/1', status, evidence }));
  process.exitCode = status === 'passed' ? 0 : status === 'failed' ? 1 : 2;
}

export async function checkTests(files) {
  const failures = [];
  let summary, declaredTests = 0;
  for await (const event of run({ files: files.map(file => path.resolve(file)), concurrency: false })) {
    if (event.type === 'test:stderr' || event.type === 'test:stdout')
      process.stderr.write(event.data.message);
    if (['test:pass', 'test:fail'].includes(event.type) &&
        event.data.name !== event.data.file && event.data.details.type === 'test') declaredTests++;
    if (event.type === 'test:fail') {
      const error = event.data.details.error;
      // Container failures are accounted for by their failing descendants.
      if (error.failureType !== 'subtestsFailed')
        failures.push({ name: event.data.name, assertion: error.cause?.code === 'ERR_ASSERTION',
          message: error.message });
    }
    if (event.type === 'test:summary' && event.data.file === undefined) summary = event.data;
  }
  const complete = summary && declaredTests > 0 && summary.counts.tests > 0 &&
    summary.counts.cancelled === 0 && summary.counts.skipped === 0 && summary.counts.todo === 0;
  const status = !complete || failures.some(item => !item.assertion) ? 'error'
    : summary.counts.failed === 0 ? 'passed' : failures.length ? 'failed' : 'error';
  reportAcceptance(status, JSON.stringify({ summary, failures }));
}

// A compiler rejecting candidate source is a failed criterion. Runtime/spawn
// failures are evaluator errors, even when they happen to exit with code 1.
export function compilationStatus(result) {
  if (result.error || result.signal || result.stopped) return 'error';
  if (result.status === 0) return 'passed';
  return [1, 2].includes(result.status) && /\berror TS\d+:/.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    ? 'failed' : 'error';
}

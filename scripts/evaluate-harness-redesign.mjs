import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const coreDirectory = path.resolve(root, manifest.agentCore.path);
const { parseArguments, loadProvider } = await import(
  pathToFileURL(path.join(coreDirectory, 'scripts/evaluate-context-policies.mjs'))
);
const argv = process.argv.slice(2);
const workloadFlag = argv.indexOf('--workloads');
const workloads =
  workloadFlag < 0 ? ['coding-review', 'writing-correction'] : (argv[workloadFlag + 1] ?? '').split(',');
if (
  workloads.length === 0 ||
  workloads.some((name) => !['coding-review', 'writing-correction'].includes(name)) ||
  new Set(workloads).size !== workloads.length
)
  throw new Error('Select distinct coding-review or writing-correction workloads.');
if (workloadFlag >= 0) argv.splice(workloadFlag, 2);
const options = parseArguments(argv);
const report = {
  format: 'agents.redesign-evaluation/1',
  createdAt: new Date().toISOString(),
  measurement: options.mode === 'live' ? 'live-application-workloads' : 'not-measured',
  source: await sourceIdentity(),
  configuration: {
    workloads,
    provider: options.provider ?? null,
    model: options.model ?? null,
    modelVersion: options.modelVersion ?? null,
    trials: options.trials,
    timeoutMs: options.timeoutMs,
    maxInvocations: options.maxInvocations,
    maxPromptTokens: options.maxPromptTokens,
    maxCompletionTokens: options.maxCompletionTokens
  },
  trials: [],
  limitations: [
    'These authored workloads measure application behavior separately from scripted invariant tests and the Core memory-policy comparison.',
    'The caller-selected endpoint may expose only a deployment alias; no immutable model revision or subscription price is invented.',
    'Coding uses review authority. Sandboxed mutation, baseline command cost and publication are unmeasured on hosts without the required backend.',
    'Writing measures exact proposal correction and separate read/edit grants. Suggest mode grants no publication authority.',
    'Concurrent steering, crash recovery, non-process resource leases, stale revisions, verifier weakening and unknown-effect publication are covered by deterministic fault tests; this runner does not claim live measurements for them.',
    'Small samples and incomplete trials do not select a default memory policy or establish general agent quality.'
  ]
};
if (options.mode === 'live') {
  const loaded = await loadProvider(options, process.env, {
    requests: 0,
    maxRequests: options.maxTotalInvocations,
    costStatus: 'unknown'
  });
  if (!loaded.provider) report.availability = { status: 'unavailable', reason: loaded.reason };
  else {
    report.availability = {
      status: 'available',
      implementationId: loaded.provider.implementationId,
      profile: loaded.profile
    };
    for (let trial = 0; trial < options.trials; trial++) {
      for (const [name, run] of trial % 2 === 0
        ? [
            ['coding-review', codingReview],
            ['writing-correction', writingCorrection]
          ]
        : [
            ['writing-correction', writingCorrection],
            ['coding-review', codingReview]
          ]) {
        if (!workloads.includes(name)) continue;
        const started = performance.now();
        try {
          report.trials.push({
            name,
            trial,
            ...(await run(loaded.provider, loaded.profile)),
            latencyMs: performance.now() - started
          });
        } catch (error) {
          report.trials.push({
            name,
            trial,
            status: 'failed',
            diagnostic: error instanceof Error ? error.message : String(error),
            errorType: error instanceof Error ? error.name : 'unknown',
            latencyMs: performance.now() - started
          });
        }
      }
    }
  }
}
report.summary = {
  completed: report.trials.filter((item) => item.status === 'completed').length,
  successful: report.trials.filter((item) => item.success).length,
  measured: report.trials.length,
  qualityGate: 'inconclusive',
  costUSD: null
};
const output = options.output ?? 'harness-redesign-evaluation.json';
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`Wrote ${report.measurement}: ${report.trials.length} application trials.\n`);

function budget() {
  return {
    maxInvocations: options.maxInvocations,
    maxPromptTokens: options.maxPromptTokens,
    maxCompletionTokens: options.maxCompletionTokens
  };
}
async function codingReview(provider, profile) {
  const { createCodingSession, closeCodingSession, openCodingWorkspace, createTrustDecision } =
    await import('@ismail-elkorchi/coding-agent');
  const { sourceRef } = await import('@agent-core/runtime');
  const parent = await mkdtemp(path.join(tmpdir(), 'coding-redesign-evaluation-'));
  const workspaceRoot = path.join(parent, 'workspace');
  await mkdir(workspaceRoot);
  const source = 'export function total(values) { return values.length - 1; }\n';
  await writeFile(path.join(workspaceRoot, 'total.js'), source);
  let workspace = await openCodingWorkspace(workspaceRoot, { stateRoot: path.join(parent, 'state') });
  await workspace.trustStore.write(
    createTrustDecision({
      workspace: workspace.layout.identity,
      level: 'trusted',
      actorKind: 'user',
      actor: 'offline-workload-owner'
    })
  );
  workspace.fileRoot.close();
  workspace = await openCodingWorkspace(workspaceRoot, { stateRoot: path.join(parent, 'state') });
  let composition;
  try {
    composition = await createCodingSession({
      workspace,
      provider,
      settings: { provider: provider.id, model: profile.id },
      permissionMode: 'review',
      maxOutputTokens: options.maxOutputTokens,
      inferenceBudget: budget()
    });
    const signal = AbortSignal.timeout(options.timeoutMs);
    const abort = () => {
      void composition.agent.abort('Offline trial deadline.').catch(() => undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    const runs = [];
    const submit = async (task, relationship) => {
      signal.throwIfAborted();
      const submission = await composition.agent.submit({ task }, relationship ? { relationship } : {});
      if (submission.kind !== 'started' && submission.kind !== 'queued')
        throw new Error('Input was not admitted.');
      const result = await submission.completion;
      if (result.state !== 'ended') throw new Error('Execution requires external continuation.');
      runs.push(result);
      return result;
    };
    try {
      const original =
        'Review total.js without editing files. Continuing requirements: database SQLite, preserve public interface total(values). Explain the defect when requested. Acknowledge these requirements briefly.';
      await submit(original);
      const originalEntry = (await composition.history.view()).entries.find(
        (entry) => entry.type === 'input' && entry.task === original
      );
      if (!originalEntry) throw new Error('Original contribution is unavailable.');
      await submit('Side question: briefly define an off-by-one error. This does not replace the review.', {
        kind: 'side_question'
      });
      await submit(
        'Correction: use PostgreSQL instead of SQLite. Preserve total(values) and the review objective.',
        { kind: 'correct', relatedSources: [sourceRef(composition.session.id, originalEntry)] }
      );
      for (let i = 0; i < options.delay; i++)
        await submit(
          `Progress check ${i + 1}: acknowledge without changing the objective or requirements.`
        );
      const result = await submit(
        'Return only JSON with database, interface, and defect. Describe the actual defect from total.js; retain the corrected database and original public interface.'
      );
      const answer =
        result.terminal.modelOutput.status === 'absent' ? '' : result.terminal.modelOutput.message;
      let parsed;
      try {
        parsed = JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/gu, ''));
      } catch {
        parsed = undefined;
      }
      const unchanged = (await readFile(path.join(workspaceRoot, 'total.js'), 'utf8')) === source;
      return {
        status: 'completed',
        success:
          unchanged &&
          parsed?.database === 'PostgreSQL' &&
          parsed?.interface === 'total(values)' &&
          /subtract|off.by.one|length\s*-\s*1/i.test(parsed?.defect ?? ''),
        unchanged,
        answer,
        acceptance: result.outcome.acceptance,
        runs: runs.map((item) => ({
          runId: item.terminal.runId,
          workId: item.outcome.workId,
          executionStatus: item.terminal.executionStatus,
          budget: item.terminal.budget
        }))
      };
    } finally {
      signal.removeEventListener('abort', abort);
    }
  } finally {
    if (composition) await closeCodingSession(composition);
    workspace.fileRoot.close();
    await rm(parent, { recursive: true, force: true });
  }
}
async function writingCorrection(provider, profile) {
  const {
    createWritingProject,
    createManagedTextResource,
    createSingleIntent,
    runWritingOperation,
    continueWritingOperation
  } = await import('@ismail-elkorchi/writing-agent');
  const parent = await mkdtemp(path.join(tmpdir(), 'writing-redesign-evaluation-'));
  const projectRoot = path.join(parent, 'project');
  await mkdir(projectRoot);
  const project = await createWritingProject({
    rootDirectory: projectRoot,
    stateRoot: path.join(parent, 'state'),
    brief: 'Format supplied text without adding facts.'
  });
  try {
    const node = (await project.store.view()).current.nodes[0];
    const resource = await createManagedTextResource(project, {
      relativePath: 'draft.md',
      initialContent: 'Alpha. Beta.\n',
      mediaType: 'text/markdown',
      role: 'draft',
      nodeId: node.nodeId
    });
    const reference = await createManagedTextResource(project, {
      relativePath: 'reference.md',
      initialContent: 'Keep Alpha before Beta.\n',
      mediaType: 'text/markdown',
      role: 'other'
    });
    const common = {
      project,
      provider,
      model: profile.id,
      signal: AbortSignal.timeout(options.timeoutMs),
      inferenceBudget: budget()
    };
    const first = await runWritingOperation({
      ...common,
      kind: 'revise',
      instruction:
        'Format Alpha and Beta as a two-item Markdown list. Consult the readable reference. Do not change the reference or apply files. A later attempt may correct the selected proposal while preserving the same list content.',
      readableResourceIds: [resource.resourceId, reference.resourceId],
      intents: [
        createSingleIntent({
          intentId: 'format-list',
          kind: 'text.revise',
          instruction: 'Use a two-item Markdown list containing Alpha and Beta in that order.',
          targetResourceIds: [resource.resourceId],
          verification: 'deterministic'
        })
      ]
    });
    const second = await continueWritingOperation({
      ...common,
      operationId: first.operationId,
      instruction:
        'Submit a corrected successor proposal using a numbered Markdown list instead of bullets. Keep Alpha before Beta and preserve the original edit scope. Do not apply either file.'
    });
    const view = await project.store.view();
    const selected = second.proposalId ? view.proposals.get(second.proposalId)?.proposal : undefined;
    const replacement =
      selected?.textEdits
        .flatMap((edit) => edit.edits.map((change) => change.replacementText))
        .join('\n') ?? '';
    const unchanged =
      (await readFile(path.join(projectRoot, 'draft.md'), 'utf8')) === 'Alpha. Beta.\n' &&
      (await readFile(path.join(projectRoot, 'reference.md'), 'utf8')) === 'Keep Alpha before Beta.\n';
    const confined =
      selected !== undefined && selected.textEdits.every((edit) => edit.resourceId === resource.resourceId);
    return {
      status: 'completed',
      success:
        unchanged &&
        confined &&
        first.operationId === second.operationId &&
        first.proposalId !== second.proposalId &&
        /1\.\s+Alpha[\s\S]*2\.\s+Beta/u.test(replacement),
      unchanged,
      confined,
      first: {
        operationId: first.operationId,
        runId: first.runId,
        proposalId: first.proposalId,
        disposition: first.disposition,
        budget: first.execution.state === 'ended' ? first.execution.terminal.budget : null
      },
      second: {
        operationId: second.operationId,
        runId: second.runId,
        proposalId: second.proposalId,
        disposition: second.disposition,
        budget: second.execution.state === 'ended' ? second.execution.terminal.budget : null
      },
      replacement,
      verificationHistory: [...view.verificationHistory.values()].map((item) => ({
        verificationId: item.verificationId,
        deterministicImplementationId: item.deterministicImplementationId,
        semanticExecution: item.semanticExecution
      }))
    };
  } finally {
    project.close();
    await rm(parent, { recursive: true, force: true });
  }
}
async function sourceIdentity() {
  const git = promisify(execFile);
  const sources = [];
  for (const directory of [coreDirectory, root]) {
    const { stdout: files } = await git(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: directory }
    );
    for (const filename of [
      ...new Set(
        files
          .split('\0')
          .filter((name) => /\.(?:ts|js|mjs|json)$/u.test(name) && !name.startsWith('docs/validation/'))
      )
    ].sort()) {
      try {
        sources.push([
          path.basename(directory),
          filename,
          createHash('sha256')
            .update(await readFile(path.join(directory, filename)))
            .digest('hex')
        ]);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  return {
    sourceTreeSha256: createHash('sha256').update(JSON.stringify(sources)).digest('hex'),
    declaredCoreCommit: manifest.agentCore.commit,
    applicationCommit: (await git('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  };
}

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  WRITING_CONTEXT_POLICY_ID,
  WRITING_EVALUATION_TASK_SET_ID,
  WRITING_EVALUATION_TASK_SET_VERSION,
  WRITING_INTENT_REGISTRY_IMPLEMENTATION_ID,
  applyLocalizedTextEdits,
  createEvaluationTrialRecord,
  createManagedTextResource,
  createSingleIntent,
  createWritingProject,
  createWritingProvider,
  createWritingReasoningRequest,
  runTransientWriting,
  runWritingOperation
} from '../writing-agent/dist/index.js';

const providerId = process.env.WRITING_EVAL_PROVIDER?.trim() || 'openai-codex';
const model = process.env.WRITING_EVAL_MODEL?.trim() || 'gpt-5.6-luna';
const reasoningEffort = process.env.WRITING_EVAL_REASONING_EFFORT?.trim() || 'medium';
const outputRoot = path.resolve(process.env.WRITING_EVAL_OUTPUT?.trim() || path.join('writing-evaluation-artifacts', new Date().toISOString().replaceAll(/[:.]/gu, '-')));
const projectRoot = path.join(outputRoot, 'project');
const stateRoot = path.join(outputRoot, 'state');
await Promise.all([outputRoot, projectRoot, stateRoot].map((directory) => mkdir(directory, { recursive: true })));

const requests = [];
const startedAt = new Date().toISOString();
const results = [];
let provider;
let reasoning;
let commits = { agents: 'unavailable', agentCore: 'unavailable' };
let sourceStates;
let project;
let trial;
let campaignStatus = 'completed';
let harnessError;

try {
  const binding = createWritingProvider({ provider: providerId, model });
  provider = recordingProvider(binding.provider, requests);
  reasoning = createWritingReasoningRequest(reasoningEffort);
  if (reasoning === undefined) throw new Error('Live evaluation requires an explicit reasoning effort.');
  commits = {
    agents: gitRevision(process.cwd()),
    agentCore: gitRevision(path.resolve(process.cwd(), '../agent-core'))
  };
  sourceStates = {
    agents: gitWorkspaceState(process.cwd()),
    agentCore: gitWorkspaceState(path.resolve(process.cwd(), '../agent-core'))
  };
  await recordProductTask(results, 'transient-long-memo', async () => {
    const transient = await runTransientWriting({
      provider,
      model,
      reasoning,
      brief: scenarioInstruction(1_800, 2_200)
    });
    const transientText = completeCandidateText(transient);
    if (transientText !== undefined) await harnessStep('write transient artifact', () => writeFile(path.join(outputRoot, 'transient-memo.md'), transientText, 'utf8'));
    return {
      outcome: transientText !== undefined && transient.terminal.executionStatus === 'completed' && withinWordRange(transientText, 1_800, 2_200) ? 'completed' : 'product-failure',
      execution: executionSummary(transient),
      ...(transientText === undefined ? {} : { output: textMetrics(transientText), sha256: digest(transientText) })
    };
  });

  project = await createWritingProject({
    rootDirectory: projectRoot,
    stateRoot,
    brief: {
      artifactKind: { value: 'internal board decision memo', origin: 'user' },
      subject: { value: 'Fictional Northbridge Community Archive digitization decision', origin: 'user' },
      rhetoricalContext: {
        purpose: { value: 'Enable a board decision among three supplied operating options.', origin: 'user' },
        audience: { value: 'Board members', origin: 'user' },
        medium: { value: 'Markdown decision memo', origin: 'user' },
        language: { value: 'English', origin: 'user' }
      },
      lengthConstraints: [{ constraintId: 'brief-words', unit: 'words', minimum: 1_000, maximum: 1_200, requirement: 'required', criterionIds: ['criterion-length'], origin: 'user' }],
      exactConstraints: [{
        constraintId: 'brief-numbers', matcher: 'number', allowedValues: ['3', '42', '600', '18', '$240,000', '$210,000', '$95,000', '$165,000'],
        baselinePolicy: 'exclude', requirement: 'required', criterionIds: ['criterion-numbers'], origin: 'user'
      }],
      contentConstraints: [
        { constraintId: 'recommendation', statement: 'Recommend the hybrid option and distinguish supplied facts from judgments, assumptions, and proposed measures.', origin: 'user' },
        { constraintId: 'fictional', statement: 'Label the document as a fictional scenario.', origin: 'user' }
      ],
      excludedContent: [],
      structuralConstraints: [{ constraintId: 'sections', statement: 'Include recommendation, context, options, risks, implementation, measures, and decision requested.', origin: 'user' }],
      terminologyConstraints: [],
      voiceConstraints: [{ constraintId: 'voice', statement: 'Use a precise, candid, non-promotional board-memo voice.', origin: 'user' }],
      evidencePolicy: [{ constraintId: 'evidence', statement: 'Use no external facts, citations, or real organizations.', origin: 'user' }],
      deliveryRequirements: [{ constraintId: 'markdown', statement: 'Deliver valid Markdown.', origin: 'user' }],
      acceptanceCriteria: [
        { criterionId: 'criterion-length', statement: 'The candidate satisfies the effective word bound.', scope: 'whole document', requirement: 'required', verificationKind: 'deterministic', origin: 'user' },
        { criterionId: 'criterion-numbers', statement: 'The candidate introduces no numeric value outside the supplied closed world.', scope: 'whole document', requirement: 'required', verificationKind: 'deterministic', origin: 'user' },
        { criterionId: 'criterion-editorial', statement: 'The memo is decision-ready and preserves factual and rhetorical intent.', scope: 'whole document', requirement: 'required', verificationKind: 'human', origin: 'user' }
      ],
      assumptions: []
    }
  });
  const view = await project.store.view();
  const rootNode = view.current.nodes.find((node) => node.parentId === null);
  if (rootNode === undefined) throw new Error('Live evaluation project has no document root.');
  const marker = '<!-- empty draft -->\n';
  const resource = await createManagedTextResource(project, {
    relativePath: 'decision-memo.md', initialContent: marker, mediaType: 'text/markdown', role: 'draft', ownership: 'user-owned', nodeId: rootNode.nodeId
  });
  const instruction = scenarioInstruction(1_000, 1_100);
  const intent = createSingleIntent({
    intentId: 'live-eval-draft', kind: 'text.draft', instruction, targetNodeIds: [rootNode.nodeId], targetResourceIds: [resource.resourceId],
    lengthConstraints: [{ constraintId: 'operation-words', unit: 'words', minimum: 1_000, maximum: 1_100, requirement: 'required', criterionIds: ['criterion-length'], origin: 'user' }]
  });
  await recordProductTask(results, 'project-draft-proposal', async () => {
    const operation = await runWritingOperation({ project, provider, model, reasoning, kind: 'draft', instruction, intents: [intent] });
    const operationView = await project.store.view();
    const proposal = operation.proposalId === undefined ? undefined : operationView.proposals.get(operation.proposalId)?.proposal;
    let candidate;
    if (proposal !== undefined) {
      const edit = proposal.textEdits.find((item) => item.resourceId === resource.resourceId);
      if (edit !== undefined) {
        candidate = await harnessStep('materialize project proposal', () => applyLocalizedTextEdits(marker, edit).content);
        await harnessStep('write project proposal artifact', () => writeFile(path.join(outputRoot, 'project-proposal.md'), candidate, 'utf8'));
      }
    }
    trial = await harnessStep('create evaluation trial record', () => createEvaluationTrialRecord({
      taskSetId: WRITING_EVALUATION_TASK_SET_ID,
      taskSetVersion: WRITING_EVALUATION_TASK_SET_VERSION,
      taskId: 'provider-neutral-operation',
      taskVersion: 1,
      set: 'development',
      trialIndex: 1,
      seed: 'live-fictional-northbridge-v1',
      nondeterminismControls: { reasoningEffort, temperature: null, repeatedTrial: false },
      bindings: {
        productId: `writing-agent@${sourceIdentity(sourceStates.agents)}`,
        promptId: 'writing-agent.project-operation@2',
        policyId: 'writing-agent.operation-authority@2',
        intentRegistryImplementationId: WRITING_INTENT_REGISTRY_IMPLEMENTATION_ID,
        contextPolicyId: WRITING_CONTEXT_POLICY_ID,
        toolImplementationIds: operationView.operations.get(operation.operationId)?.snapshot.toolImplementationIds ?? [],
        checkImplementationIds: operationView.operations.get(operation.operationId)?.snapshot.checkImplementationIds ?? [],
        verifierImplementationIds: proposal?.semanticPreservationFindings.map((finding) => finding.evaluatorId) ?? [],
        calibrationIds: proposal?.semanticPreservationFindings.flatMap((finding) => finding.calibrationId === undefined ? [] : [finding.calibrationId]) ?? [],
        dispositionImplementationId: 'writing-agent.disposition.proposal@2',
        providerId: provider.id,
        providerImplementationId: provider.implementationId,
        modelId: model
      },
      identities: {
        baseProjectRevisionId: operation.baseRevisionId,
        briefRevisionId: operationView.operations.get(operation.operationId)?.briefRevisionId ?? view.current.brief.briefRevisionId,
        operationId: operation.operationId,
        contextReceiptId: operation.contextReceipt.contextReceiptId,
        ...(proposal === undefined ? {} : { proposalId: proposal.proposalId }),
        sourceIds: [],
        evidenceRelationIds: []
      },
      firstAttempt: true
    }));
    return {
      outcome: proposal !== undefined && operation.execution.state === 'ended' && operation.execution.terminal.executionStatus === 'completed' && operation.disposition === 'valid' ? 'completed' : 'product-failure',
      operation: operationSummary(operation),
      ...(candidate === undefined ? {} : { output: textMetrics(candidate), sha256: digest(candidate) }),
      ...(proposal === undefined ? {} : {
        proposalId: proposal.proposalId,
        canonicalProposalSha256: proposal.canonicalProposalSha256,
        deterministicChecks: proposal.deterministicChecks,
        criterionCoverage: proposal.criterionCoverage,
        semanticPreservationFindings: proposal.semanticPreservationFindings
      })
    };
  });
} catch (error) {
  campaignStatus = 'harness-error';
  harnessError = errorSummary(error);
} finally {
  project?.close();
  const manifest = {
    schemaVersion: 2,
    campaignStatus,
    ...(harnessError === undefined ? {} : { harnessError }),
    startedAt,
    completedAt: new Date().toISOString(),
    commits,
    ...(sourceStates === undefined ? {} : { sourceStates }),
    environment: { node: process.version, platform: process.platform, architecture: process.arch },
    provider: provider?.id ?? providerId,
    providerImplementationId: provider?.implementationId ?? 'unavailable',
    model,
    reasoning: reasoning ?? null,
    requests,
    results,
    ...(trial === undefined ? {} : { trial })
  };
  await writeFile(path.join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(path.join(outputRoot, 'RESULTS.md'), markdownReport(manifest), 'utf8');
  process.stdout.write(`${outputRoot}\n`);
  if (harnessError !== undefined) process.exitCode = 1;
}

function scenarioInstruction(minimum, maximum) {
  return [
    `Write a ${String(minimum)} to ${String(maximum)} word internal decision memo for the board of the fictional Northbridge Community Archive.`,
    'Put “Fictional scenario” beneath the title. Use only these facts: three branches, 42 volunteers, 600 recordings, an 18-month horizon, a $240,000 envelope, a $210,000 vendor option, a $95,000 volunteer option, and a $165,000 hybrid option.',
    'Recommend the hybrid option. Distinguish supplied facts, judgments, assumptions, and proposed measures. Include recommendation, context, options, risks, implementation, measures, and decision requested.',
    'Do not add numeric values, citations, external facts, or real organizations.'
  ].join(' ');
}

function recordingProvider(base, records) {
  const record = (request, transport) => {
    const messages = request.messages.map((message) => ({ role: message.role, contentSha256: digest(message.content), characters: message.content.length }));
    const tools = request.tools ?? [];
    records.push({
      sequence: records.length + 1,
      recordedAt: new Date().toISOString(),
      transport,
      model: request.model,
      reasoning: request.reasoning ?? null,
      messageCount: messages.length,
      messageCharacters: request.messages.reduce((total, message) => total + message.content.length, 0),
      messages,
      toolNames: tools.map((tool) => tool.type === 'function' ? tool.function.name : tool.name),
      toolsSha256: digest(JSON.stringify(tools)),
      requestInputSha256: modelRequestSha256(request)
    });
  };
  const wrap = (session) => {
    const wrapped = { complete: async (request) => { record(request, 'complete'); return session.complete(request); } };
    if (session.stream) wrapped.stream = async function* (request) { record(request, 'stream'); yield* session.stream(request); };
    if (session.restoreProviderState) wrapped.restoreProviderState = (state) => session.restoreProviderState(state);
    if (session.resetContinuation) wrapped.resetContinuation = (reason) => session.resetContinuation(reason);
    if (session.close) wrapped.close = () => session.close();
    return wrapped;
  };
  return {
    id: base.id,
    implementationId: base.implementationId,
    describe: () => base.describe(),
    describeModel: (selected) => base.describeModel(selected),
    createSession: () => wrap(base.createSession()),
    complete: async (request) => { record(request, 'complete'); return base.complete(request); },
    stream: async function* (request) { record(request, 'stream'); yield* base.stream(request); },
    ...(base.requestRecovery ? { requestRecovery: (request) => base.requestRecovery(request) } : {})
  };
}

async function recordProductTask(records, taskId, run) {
  const started = performance.now();
  try {
    const result = await run();
    records.push({ taskId, durationMs: Math.round(performance.now() - started), ...result });
    return result;
  } catch (error) {
    if (error instanceof EvaluationHarnessError) throw error;
    const result = { outcome: 'product-error', error: errorSummary(error) };
    records.push({ taskId, durationMs: Math.round(performance.now() - started), ...result });
    return result;
  }
}

class EvaluationHarnessError extends Error {
  constructor(step, cause) {
    super(`Evaluation harness failed to ${step}: ${errorSummary(cause).message}`, { cause });
    this.name = 'EvaluationHarnessError';
  }
}

async function harnessStep(step, run) {
  try { return await run(); }
  catch (error) { throw new EvaluationHarnessError(step, error); }
}

function completeCandidateText(result) {
  if (result.state !== 'ended' || result.terminal.candidate.status !== 'complete') return undefined;
  return result.terminal.candidate.message;
}

function errorSummary(error) {
  if (error instanceof Error) return { name: error.name, message: error.message.slice(0, 4_000) };
  return { name: 'NonErrorThrow', message: String(error).slice(0, 4_000) };
}

function executionSummary(result) {
  if (result.state !== 'ended') return { state: result.state, reason: result.reason };
  return {
    state: result.state,
    executionStatus: result.terminal.executionStatus,
    terminationReason: result.terminal.terminationReason,
    modelTerminationReason: result.terminal.modelTerminationReason ?? null,
    verificationStatus: result.terminal.verificationStatus,
    turnCount: result.terminal.turnCount,
    budget: result.terminal.budget,
    candidateStatus: result.terminal.candidate.status
  };
}

function operationSummary(operation) {
  return {
    projectId: operation.projectId,
    operationId: operation.operationId,
    runId: operation.runId,
    baseRevisionId: operation.baseRevisionId,
    proposalId: operation.proposalId ?? null,
    disposition: operation.disposition,
    reviewStatus: operation.reviewStatus,
    remainingUncertainty: operation.remainingUncertainty,
    execution: executionSummary(operation.execution),
    context: {
      contextReceiptId: operation.contextReceipt.contextReceiptId,
      coverage: operation.contextReceipt.coverage,
      truncated: operation.contextReceipt.truncated,
      targetDescriptors: operation.contextReceipt.targetDescriptors.length
    }
  };
}

function textMetrics(text) {
  return { words: text.trim().length === 0 ? 0 : text.trim().split(/\s+/u).length, characters: text.length, lines: text.split(/\r\n|\r|\n/u).length };
}

function withinWordRange(text, minimum, maximum) {
  const words = textMetrics(text).words;
  return words >= minimum && words <= maximum;
}

function markdownReport(manifest) {
  const lines = [
    '# Writing Agent live evaluation',
    '',
    `- Started: ${manifest.startedAt}`,
    `- Completed: ${manifest.completedAt}`,
    `- Campaign status: ${manifest.campaignStatus}`,
    `- Agents commit: \`${manifest.commits.agents}\``,
    `- Agent Core commit: \`${manifest.commits.agentCore}\``,
    ...(manifest.sourceStates === undefined ? [] : [
      `- Agents source identity: \`${sourceIdentity(manifest.sourceStates.agents)}\``,
      `- Agent Core source identity: \`${sourceIdentity(manifest.sourceStates.agentCore)}\``
    ]),
    `- Provider: \`${manifest.provider}\``,
    `- Model: \`${manifest.model}\``,
    `- Reasoning: \`${JSON.stringify(manifest.reasoning)}\``,
    `- Recorded model requests: ${String(manifest.requests.length)}`,
    '',
    '## Results',
    ''
  ];
  if (manifest.harnessError) lines.push(`Harness error: ${manifest.harnessError.name}: ${manifest.harnessError.message}`, '');
  for (const result of manifest.results) {
    lines.push(`### ${result.taskId}`, '', `- Outcome: ${result.outcome}`, `- Duration: ${String(result.durationMs)} ms`);
    if (result.error) lines.push(`- Product error: ${result.error.name}: ${result.error.message}`);
    if (result.output) lines.push(`- Output: ${String(result.output.words)} words, SHA-256 \`${result.sha256}\``);
    if (result.operation) lines.push(`- Disposition: ${result.operation.disposition}`, `- Review status: ${result.operation.reviewStatus}`, `- Context coverage: ${result.operation.context.coverage}`);
    if (result.deterministicChecks) lines.push(`- Non-passing deterministic checks: ${String(result.deterministicChecks.filter((check) => check.verdict !== 'passed').length)}`);
    if (result.criterionCoverage) lines.push(`- Non-passing or incomplete criteria: ${String(result.criterionCoverage.filter((coverage) => coverage.verdict !== 'passed' || coverage.coverage !== 'complete').length)}`);
    lines.push('');
  }
  lines.push('The JSON manifest contains exact bindings, identities, token budgets, checks, criterion coverage, hashes, and request metadata. It intentionally contains no credentials or hidden reasoning text.', '');
  return `${lines.join('\n')}\n`;
}

function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function modelRequestSha256(request) {
  const { signal: _signal, ...requestWithoutSignal } = request;
  return digest(JSON.stringify(requestWithoutSignal));
}
function gitRevision(directory) { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim(); }
function gitWorkspaceState(directory) {
  const revision = gitRevision(directory);
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: directory, encoding: 'utf8' });
  const trackedDiff = execFileSync('git', ['diff', '--binary', 'HEAD', '--'], { cwd: directory });
  const untrackedPaths = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: directory, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
  const material = {
    statusSha256: digest(status),
    trackedDiffSha256: digest(trackedDiff),
    untracked: untrackedPaths.map((relativePath) => ({ relativePath, sha256: digest(readFileSync(path.join(directory, relativePath))) }))
  };
  return { revision, dirty: status.length > 0, workingTreeSha256: digest(JSON.stringify(material)), ...material };
}
function sourceIdentity(state) { return state.dirty ? `${state.revision}+dirty.${state.workingTreeSha256}` : state.revision; }

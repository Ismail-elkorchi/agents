import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelReasoningEffort } from '@agent-core/model';
import { randomId } from './canonical.js';
import { createSingleIntent } from './operations.js';
import { amendProjectBriefInstruction, createManagedTextResource, createWritingProject, openWritingProject, type WritingProject } from './project.js';
import { createWritingProvider, createWritingReasoningRequest, parseWritingProviderId, type WritingProviderConfiguration } from './provider.js';
import { abortWritingOperation, decideWritingSuspension, inspectWritingSuspension, resolveWritingApproval, resumeWritingSuspension, runTransientWriting, runWritingOperation } from './runtime.js';
import { acceptRevisionProposal, applyRevisionProposal, rejectRevisionProposal, undoWritingRevision } from './revisions.js';
import { addManualSource } from './sources.js';

interface CliOptions {
  readonly root: string;
  readonly stateRoot?: string;
  readonly sessionId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly endpoint?: string;
  readonly reasoningEffort?: ModelReasoningEffort;
  readonly minimumWords?: number;
  readonly maximumWords?: number;
  readonly allowedNumbers: readonly string[];
  readonly allowedEntities: readonly string[];
  readonly humanCriterionIds: readonly string[];
  readonly preserveExistingNumbers: boolean;
  readonly forbidNewCitations: boolean;
  readonly positionals: readonly string[];
}

export async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 0 || argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) { printHelp(); return; }
  const options = parseOptions(argv);
  const [command, subcommand, ...rest] = options.positionals;
  if (command === 'write') {
    const brief = await requiredInput([subcommand, ...rest].filter((value): value is string => value !== undefined));
    const runtime = providerRuntime(options);
    printAgentResult(await runTransientWriting({ brief, provider: runtime.provider, model: runtime.model, ...(runtime.reasoning === undefined ? {} : { reasoning: runtime.reasoning }) }));
    return;
  }
  if (command === 'init') {
    const brief = await requiredInput([subcommand, ...rest].filter((value): value is string => value !== undefined));
    const project = await createWritingProject({ rootDirectory: options.root, brief, ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }) });
    try { print({ projectId: project.store.identity.projectId, revisionId: (await project.store.view()).current.revision.revisionId }); }
    finally { project.close(); }
    return;
  }
  const project = await openWritingProject({ rootDirectory: options.root, ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }) });
  try { await runProjectCommand(project, command, subcommand, rest, options); }
  finally { project.close(); }
}

async function runProjectCommand(project: WritingProject, command: string | undefined, subcommand: string | undefined, rest: readonly string[], options: CliOptions): Promise<void> {
  if (command === 'status') {
    const view = await project.store.view();
    const suspension = options.provider && options.model ? await inspectWritingSuspension({ project, ...providerRuntime(options), ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) }) : undefined;
    print({ projectId: view.identity.projectId, projectRevisionId: view.current.revision.revisionId, briefRevisionId: view.current.brief.briefRevisionId, resources: view.current.resources.length, nodes: view.current.nodes.length, proposals: [...view.proposals].map(([proposalId, entry]) => ({ proposalId, status: entry.status })), suspension });
    return;
  }
  if (command === 'brief' && subcommand === 'show') { print((await project.store.view()).current.brief); return; }
  if (command === 'brief' && subcommand === 'amend') {
    const snapshot = await amendProjectBriefInstruction(project, await requiredInput(rest));
    print({ briefRevisionId: snapshot.brief.briefRevisionId, projectRevisionId: snapshot.revision.revisionId }); return;
  }
  if (command === 'source' && subcommand === 'list') { print((await project.store.view()).current.sources); return; }
  if (command === 'source' && subcommand === 'add') {
    const resourceId = requiredArgument(rest[0], 'source add requires a managed resource ID');
    print(await addManualSource(project, { kind: 'manual', localResourceId: resourceId, ...(rest[1] === undefined ? {} : { title: rest.slice(1).join(' ') }) })); return;
  }
  if (command === 'diff') {
    const view = await project.store.view();
    const id = subcommand;
    if (id === undefined) { print({ revision: view.current.revision, pendingProposals: [...view.proposals.values()].filter((entry) => entry.status === 'proposed') }); return; }
    const proposal = view.proposals.get(id);
    if (proposal !== undefined) { print(proposal); return; }
    const revision = view.records.find((record) => record.payload.kind === 'revision.committed' && record.payload.snapshot.revision.revisionId === id);
    if (revision?.payload.kind !== 'revision.committed') throw new Error(`Unknown proposal or revision: ${id}`);
    print({ selected: revision.payload.snapshot.revision, current: view.current.revision, resourceHashChanges: changedResourceHashes(revision.payload.snapshot.revision.resourceHashes, view.current.revision.resourceHashes) }); return;
  }
  if (command === 'apply') {
    const proposalId = requiredArgument(subcommand, 'apply requires a proposal ID');
    const explanation = rest.join(' ').trim() || 'Direct user requested application of this exact proposal.';
    const proposalView = (await project.store.view()).proposals.get(proposalId);
    if (proposalView?.status === 'proposed') {
      const evaluation = (await project.store.view()).qualityEvaluations.get(proposalId);
      if (evaluation === undefined) throw new Error(`Proposal has no durable Agent Core quality evaluation: ${proposalId}`);
      const humanCriterionIds = new Set(evaluation.criterionCoverage
        .filter((criterion) => criterion.verificationKind === 'human')
        .map((criterion) => criterion.criterionId));
      const invalidCriterionIds = options.humanCriterionIds.filter((criterionId) => !humanCriterionIds.has(criterionId));
      if (invalidCriterionIds.length > 0) throw new Error(`--human-criterion must identify a human-verified criterion on this proposal: ${invalidCriterionIds.join(', ')}.`);
      await acceptRevisionProposal(project, {
        proposalId,
        explanation,
        humanCriterionDecisions: options.humanCriterionIds
          .map((criterionId) => ({ criterionId, verdict: 'passed' as const, explanation }))
      });
    }
    print(await applyRevisionProposal(project, { proposalId })); return;
  }
  if (command === 'reject') {
    const proposalId = requiredArgument(subcommand, 'reject requires a proposal ID');
    print(await rejectRevisionProposal(project, proposalId, rest.join(' ').trim() || 'Direct user rejected this exact proposal.')); return;
  }
  if (command === 'undo') {
    print(await undoWritingRevision(project, { ...(subcommand === undefined ? {} : { revisionId: subcommand }), explanation: rest.join(' ').trim() || 'Direct user requested this compensating revision.' })); return;
  }
  if (command === 'suspension') {
    const runtime = providerRuntime(options);
    print(await inspectWritingSuspension({ project, ...runtime, ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) }) ?? { suspended: false }); return;
  }
  if (command === 'resume') {
    const runtime = providerRuntime(options);
    print(await resumeWritingSuspension({ project, ...runtime, ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) })); return;
  }
  if (command === 'decide') {
    const decisionRequestId = requiredArgument(subcommand, 'decide requires a decision-request ID');
    const choice = requiredArgument(rest[0], 'decide requires an exact choice');
    const guards = exactFlags(rest.slice(1), ['run-id', 'fingerprint', 'operation-revision']);
    const runId = requiredArgument(guards['run-id'], 'Missing exact guard --run-id.');
    const fingerprint = requiredArgument(guards.fingerprint, 'Missing exact guard --fingerprint.');
    const operationRevision = requiredArgument(guards['operation-revision'], 'Missing exact guard --operation-revision.');
    const runtime = providerRuntime(options);
    print(await decideWritingSuspension({ project, ...runtime, decisionRequestId, choice, runId, fingerprint, expectedOperationRevision: positiveInteger(operationRevision, 'operation revision'), ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) })); return;
  }
  if (command === 'approval') {
    const approvalId = requiredArgument(subcommand, 'approval requires an approval ID');
    const decision = rest[0];
    if (decision !== 'allow' && decision !== 'deny') throw new Error('approval decision must be allow or deny.');
    const guards = exactFlags(rest.slice(1), ['run-id', 'fingerprint']);
    const runId = requiredArgument(guards['run-id'], 'Missing exact guard --run-id.');
    const fingerprint = requiredArgument(guards.fingerprint, 'Missing exact guard --fingerprint.');
    const runtime = providerRuntime(options);
    print(await resolveWritingApproval({ project, ...runtime, approvalId, decision, runId, fingerprint, ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) })); return;
  }
  if (command === 'abort') {
    const runtime = providerRuntime(options);
    const runId = requiredArgument(subcommand, 'abort requires the exact run ID');
    print(await abortWritingOperation({ project, ...runtime, runId, reason: rest.join(' ').trim() || 'Direct user requested abort.', ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) })); return;
  }
  if (command === 'plan' || command === 'draft' || command === 'revise' || command === 'review') { await runModelCommand(project, command, subcommand, rest, options); return; }
  throw new Error(`Unknown or incomplete Writing Agent command: ${[command, subcommand].filter(Boolean).join(' ')}`);
}

async function runModelCommand(project: WritingProject, command: 'plan' | 'draft' | 'revise' | 'review', target: string | undefined, instructionParts: readonly string[], options: CliOptions): Promise<void> {
  const runtime = providerRuntime(options);
  const view = await project.store.view();
  const instruction = instructionParts.join(' ').trim() || `${command} the selected writing target according to the current brief.`;
  let intent;
  if (command === 'plan') {
    if (hasTextOperationConstraints(options)) throw new Error('Plan does not accept text operation constraints.');
    const root = view.current.nodes.find((node) => node.parentId === null && node.status !== 'removed');
    if (root === undefined) throw new Error('Writing project has no active document root.');
    intent = createSingleIntent({ intentId: randomId('intent'), kind: 'structure.purpose', instruction, targetNodeIds: [root.nodeId] });
  } else {
    const operationConstraints = cliOperationConstraints(options);
    const targetId = requiredArgument(target, `${command} requires a node or resource ID`);
    let resource = view.current.resources.find((candidate) => candidate.resourceId === targetId);
    const node = view.current.nodes.find((candidate) => candidate.nodeId === targetId && candidate.status !== 'removed');
    if (command === 'draft' && node !== undefined && node.resourceId === undefined) {
      resource = await createManagedTextResource(project, { relativePath: `${node.nodeId}.md`, initialContent: '<!-- draft target -->\n', mediaType: 'text/markdown', role: 'draft', nodeId: node.nodeId });
    } else if (node?.resourceId !== undefined) resource = view.current.resources.find((candidate) => candidate.resourceId === node.resourceId);
    if (resource === undefined) throw new Error(`${command} target has no managed text resource: ${targetId}`);
    const intentKind = command === 'draft' ? 'text.draft' : command === 'revise' ? 'text.revise' : 'review.editorial';
    intent = createSingleIntent({ intentId: randomId('intent'), kind: intentKind, instruction, targetNodeIds: node === undefined ? [] : [node.nodeId], targetResourceIds: [resource.resourceId], ...operationConstraints });
  }
  print(await runWritingOperation({ project, provider: runtime.provider, model: runtime.model, kind: command, instruction, intents: [intent], ...(runtime.reasoning === undefined ? {} : { reasoning: runtime.reasoning }), ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) }));
}

function providerRuntime(options: CliOptions) {
  const provider = parseWritingProviderId(options.provider ?? process.env.WRITING_AGENT_PROVIDER ?? '');
  const model = (options.model ?? process.env.WRITING_AGENT_MODEL ?? '').trim();
  if (model.length === 0) throw new Error('Select a model with --model or WRITING_AGENT_MODEL.');
  const configuration: WritingProviderConfiguration = { provider, model, ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }) };
  const binding = createWritingProvider(configuration);
  const effort = options.reasoningEffort ?? parseReasoningEffort(process.env.WRITING_AGENT_REASONING_EFFORT);
  const reasoning = createWritingReasoningRequest(effort);
  return { ...binding, ...(reasoning === undefined ? {} : { reasoning }) };
}

function parseOptions(argv: readonly string[]): CliOptions {
  let root = process.cwd(); let stateRoot: string | undefined; let sessionId: string | undefined; let provider: string | undefined; let model: string | undefined; let endpoint: string | undefined; let reasoningEffort: ModelReasoningEffort | undefined; let minimumWords: number | undefined; let maximumWords: number | undefined;
  const allowedNumbers: string[] = []; const allowedEntities: string[] = []; const humanCriterionIds: string[] = [];
  let preserveExistingNumbers = false; let forbidNewCitations = false;
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]; if (value === undefined) continue;
    if (value === '--preserve-existing-numbers') { preserveExistingNumbers = true; continue; }
    if (value === '--forbid-new-citations') { forbidNewCitations = true; continue; }
    if (value === '--root' || value === '--state-root' || value === '--session' || value === '--provider' || value === '--model' || value === '--endpoint' || value === '--reasoning-effort' || value === '--min-words' || value === '--max-words' || value === '--allow-number' || value === '--allow-entity' || value === '--human-criterion') {
      const selected = argv[++index]; if (selected === undefined || selected.startsWith('--')) throw new Error(`${value} requires a value.`);
      if (value === '--root') root = path.resolve(selected); else if (value === '--state-root') stateRoot = path.resolve(selected); else if (value === '--session') sessionId = selected; else if (value === '--provider') provider = selected; else if (value === '--model') model = selected; else if (value === '--reasoning-effort') reasoningEffort = parseReasoningEffort(selected); else if (value === '--min-words') minimumWords = positiveInteger(selected, 'minimum words'); else if (value === '--max-words') maximumWords = positiveInteger(selected, 'maximum words'); else if (value === '--allow-number') allowedNumbers.push(selected); else if (value === '--allow-entity') allowedEntities.push(selected); else if (value === '--human-criterion') humanCriterionIds.push(selected); else endpoint = selected;
    } else if (value.startsWith('--')) throw new Error(`Unknown option: ${value}`); else positionals.push(value);
  }
  if (minimumWords !== undefined && maximumWords !== undefined && minimumWords > maximumWords) throw new Error('Minimum words cannot exceed maximum words.');
  if (new Set(humanCriterionIds).size !== humanCriterionIds.length) throw new Error('Human criterion IDs must be unique.');
  return { root, ...(stateRoot === undefined ? {} : { stateRoot }), ...(sessionId === undefined ? {} : { sessionId }), ...(provider === undefined ? {} : { provider }), ...(model === undefined ? {} : { model }), ...(endpoint === undefined ? {} : { endpoint }), ...(reasoningEffort === undefined ? {} : { reasoningEffort }), ...(minimumWords === undefined ? {} : { minimumWords }), ...(maximumWords === undefined ? {} : { maximumWords }), allowedNumbers, allowedEntities, humanCriterionIds, preserveExistingNumbers, forbidNewCitations, positionals };
}

function cliOperationConstraints(options: CliOptions): Pick<Parameters<typeof createSingleIntent>[0], 'lengthConstraints' | 'exactConstraints'> {
  const lengthConstraints = options.minimumWords === undefined && options.maximumWords === undefined ? [] : [{
    constraintId: randomId('operation-length'),
    unit: 'words' as const,
    ...(options.minimumWords === undefined ? {} : { minimum: options.minimumWords }),
    ...(options.maximumWords === undefined ? {} : { maximum: options.maximumWords }),
    requirement: 'required' as const,
    criterionIds: [],
    origin: 'user' as const
  }];
  const exactConstraints = [];
  if (options.allowedNumbers.length > 0 || options.preserveExistingNumbers) exactConstraints.push({
    constraintId: randomId('operation-numbers'), matcher: 'number' as const, allowedValues: [...options.allowedNumbers],
    baselinePolicy: options.preserveExistingNumbers ? 'include' as const : 'exclude' as const, requirement: 'required' as const, criterionIds: [], origin: 'user' as const
  });
  if (options.forbidNewCitations) exactConstraints.push({
    constraintId: randomId('operation-citations'), matcher: 'citation' as const, allowedValues: [], baselinePolicy: 'include' as const,
    requirement: 'required' as const, criterionIds: [], origin: 'user' as const
  });
  if (options.allowedEntities.length > 0) exactConstraints.push({
    constraintId: randomId('operation-entities'), matcher: 'named-entity' as const, allowedValues: [...options.allowedEntities], baselinePolicy: 'exclude' as const,
    requirement: 'required' as const, criterionIds: [], origin: 'user' as const
  });
  return { lengthConstraints, exactConstraints };
}

function hasTextOperationConstraints(options: CliOptions): boolean {
  return options.minimumWords !== undefined || options.maximumWords !== undefined || options.allowedNumbers.length > 0
    || options.allowedEntities.length > 0 || options.preserveExistingNumbers || options.forbidNewCitations;
}

function parseReasoningEffort(value: string | undefined): ModelReasoningEffort | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const effort = value.trim();
  if (['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return effort as ModelReasoningEffort;
  throw new Error(`Unsupported reasoning effort: ${effort}. Expected none, minimal, low, medium, high, xhigh, or max.`);
}

function exactFlags(values: readonly string[], names: readonly string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]; const value = values[index + 1];
    if (key === undefined || value === undefined || !key.startsWith('--') || !names.includes(key.slice(2))) throw new Error(`Required exact guards: ${names.map((name) => `--${name} <value>`).join(' ')}.`);
    output[key.slice(2)] = value;
  }
  for (const name of names) if (output[name] === undefined) throw new Error(`Missing exact guard --${name}.`);
  return output;
}

function changedResourceHashes(selected: Record<string, string>, current: Record<string, string>) { return [...new Set([...Object.keys(selected), ...Object.keys(current)])].sort().flatMap((resourceId) => selected[resourceId] === current[resourceId] ? [] : [{ resourceId, selectedSha256: selected[resourceId] ?? null, currentSha256: current[resourceId] ?? null }]); }
function positiveInteger(value: string, label: string): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a nonnegative integer.`); return parsed; }
function requiredArgument(value: string | undefined, message: string): string { if (value === undefined || value.trim().length === 0) throw new Error(message); return value; }
async function requiredInput(parts: readonly string[]): Promise<string> { let value = parts.join(' ').trim(); if (value.length === 0 && !process.stdin.isTTY) value = (await readStandardInput()).trim(); if (value.length === 0) throw new Error('Command requires text or piped stdin.'); return value; }
async function readStandardInput(): Promise<string> { let input = ''; process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) input += String(chunk); return input; }
function print(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function printAgentResult(result: import('@agent-core/runtime').AgentRunResult): void { if (result.state === 'suspended') { print(result); process.exitCode = 2; return; } const candidate = result.terminal.candidate; process.stdout.write(`${candidate.status === 'absent' ? result.terminal.errorMessage ?? 'Writing run ended without output.' : candidate.message}\n`); if (result.terminal.executionStatus !== 'completed') process.exitCode = 1; }

function printHelp(): void {
  process.stdout.write(`Writing Agent\n\nCommands:\n  write <brief>\n  init <brief>\n  status\n  brief show\n  brief amend <instruction>\n  plan [instruction]\n  draft <node> [instruction]\n  revise <node-or-resource> [instruction]\n  review <node-or-resource> [instruction]\n  diff [proposal-or-revision]\n  apply <proposal> [explanation]\n  reject <proposal> [explanation]\n  undo [revision] [explanation]\n  suspension\n  resume\n  decide <request> <choice> --run-id <id> --fingerprint <hash> --operation-revision <n>\n  approval <id> <allow|deny> --run-id <id> --fingerprint <hash>\n  abort <run-id> [reason]\n  source add <resource-id> [title]\n  source list\n\nGlobal options: --root <dir> --state-root <dir> --session <id> --provider <id> --model <id> --endpoint <url> --reasoning-effort <level>\nAcceptance options: --human-criterion <criterion-id> (repeat for every criterion explicitly passed)\nOperation constraints: --min-words <n> --max-words <n> --allow-number <value> --preserve-existing-numbers --forbid-new-citations --allow-entity <value>\n`);
}

export function isDirectRun(moduleUrl: string, argvEntry = process.argv[1]): boolean {
  if (argvEntry === undefined) return false;
  const modulePath = fileURLToPath(moduleUrl);
  try { return realpathSync(argvEntry) === realpathSync(modulePath); }
  catch { return path.resolve(argvEntry) === modulePath; }
}

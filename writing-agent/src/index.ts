#!/usr/bin/env node
import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/evidence';
import { JsonlEventRepository as NodeJsonlEventRepository, LocalArtifactRepository } from '@agent-core/evidence/node';
import type { ModelProvider, ModelReasoningRequest } from '@agent-core/model';
import { OpenAICodexProvider } from '@agent-core/provider-openai-codex';
import {
  AgentRuntime,
  AgentSession,
  agentEventCodec,
  type AgentEvent,
  type AgentProgressEvent,
  type AgentRunResult
} from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
import { validateResourceScope } from '@agent-core/tools';
import { createLocalToolHost, TextPatchJournal, WorkspaceFileRoot } from '@agent-core/tools-local';

const WRITING_INSTRUCTION = [
  'Produce a finished draft that directly satisfies the brief.',
  'Preserve the intended audience, purpose, constraints, and voice.',
  'Do not invent external facts or claim actions that were not supplied in the brief.',
  'Return the draft itself unless the brief explicitly asks for commentary.'
].join(' ');

const DOCUMENT_REVISION_INSTRUCTION = [
  'Revise the one authorized document according to the user request.',
  'Read the document before changing it and use apply_patch for the revision.',
  'Do not attempt to inspect or modify any other resource.',
  'After the change, report what was revised without reproducing the complete document.'
].join(' ');

const DOCUMENT_TOOLS = Object.freeze(['read_files', 'apply_patch']);

export interface WritingTaskOptions {
  readonly brief: string;
  readonly provider: ModelProvider;
  readonly model: string;
  readonly reasoning?: ModelReasoningRequest;
  readonly onProgress?: (event: AgentProgressEvent) => void | Promise<void>;
}

export interface DocumentRevisionOptions {
  readonly instruction: string;
  readonly documentPath: string;
  readonly rootDirectory: string;
  readonly stateDirectory: string;
  readonly provider: ModelProvider;
  readonly model: string;
  readonly sessionId?: string;
  readonly reasoning?: ModelReasoningRequest;
  readonly onProgress?: (event: AgentProgressEvent) => void | Promise<void>;
}

export interface DocumentRevisionResult {
  readonly sessionId: string;
  readonly result: AgentRunResult;
}

export async function runWritingTask(options: WritingTaskOptions): Promise<AgentRunResult> {
  const brief = requiredText(options.brief, 'The writing brief');
  const runtime = new AgentRuntime({
    provider: options.provider,
    model: options.model,
    toolBoundary: {
      authorizationPolicyId: 'writing-agent/no-tools@1',
      executionTargetId: 'writing-agent/ephemeral'
    },
    repositories: {
      events: new InMemoryEventRepository(agentEventCodec),
      artifacts: new InMemoryArtifactRepository()
    },
    instructions: [{ id: 'writing-agent/drafting@1', role: 'developer', content: WRITING_INSTRUCTION }],
    ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress })
  });
  return runtime.run({ task: brief }).result;
}

export async function runDocumentRevision(options: DocumentRevisionOptions): Promise<DocumentRevisionResult> {
  const instruction = requiredText(options.instruction, 'The revision instruction');
  const rootDirectory = await fs.realpath(path.resolve(options.rootDirectory));
  const documentPath = await ownedDocumentPath(rootDirectory, options.documentPath);
  const stateDirectory = path.resolve(options.stateDirectory);
  const sessions = new JsonlSessionRepository({ rootDir: path.join(stateDirectory, 'sessions') });
  const descriptor = options.sessionId === undefined
    ? await sessions.create({ provider: options.provider.id, model: options.model })
    : await sessions.open(options.sessionId);
  if (descriptor.header.provider !== undefined && descriptor.header.provider !== options.provider.id) throw new Error(`Session ${descriptor.id} belongs to provider ${descriptor.header.provider}.`);
  if (descriptor.header.model !== undefined && descriptor.header.model !== options.model) throw new Error(`Session ${descriptor.id} belongs to model ${descriptor.header.model}.`);
  const events = new NodeJsonlEventRepository<AgentEvent>({ rootDir: path.join(stateDirectory, 'runs'), codec: agentEventCodec });
  const artifactDirectory = path.join(stateDirectory, 'artifacts');
  const patchJournalPath = path.join(stateDirectory, 'transactions');
  await fs.mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  await fs.mkdir(patchJournalPath, { recursive: true, mode: 0o700 });
  const stateEntry = path.relative(rootDirectory, stateDirectory).split(path.sep)[0];
  const workspaceFileRoot = WorkspaceFileRoot.adopt(rootDirectory,
    stateEntry && stateEntry !== '..' ? { additionalDeniedEntries: [stateEntry] } : {});
  const localHost = createLocalToolHost({
    workspaceFileRoot,
    artifactRepository: new LocalArtifactRepository({ rootDir: artifactDirectory }),
    patchJournal: TextPatchJournal.adopt(patchJournalPath),
    enabledTools: DOCUMENT_TOOLS
  });
  await localHost.ready();
  try {
    const documentScope = validateResourceScope(`workspace/files/${documentPath}`);
    const session = new AgentSession({
      descriptor,
      repository: sessions,
      configuration: {
        provider: options.provider.id,
        model: options.model,
        ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning })
      },
      createRuntime(configuration, sessionProgress) {
        return new AgentRuntime({
          provider: options.provider,
          model: configuration.model,
          tools: localHost.tools,
          toolBoundary: {
            authorizationPolicyId: `writing-agent/document-revision@1:${documentScope}`,
            executionTargetId: rootDirectory
          },
          toolContext: { services: localHost.services },
          toolPolicy: { allowedRisks: ['read', 'write'] },
          toolAuthorizer: request => request.effects.accesses.length > 0 && request.effects.accesses.every((access) => access.scope === documentScope && (access.mode === 'read' || access.mode === 'write'))
            ? { decision: 'allow', reason: 'The operation is confined to the authorized document.' }
            : { decision: 'deny', reason: 'The writing workflow authorizes only the selected document.' },
          repositories: {
            events,
            session: { repository: sessions, sessionId: descriptor.id },
            artifacts: localHost.artifactRepository
          },
          instructions: [{ id: 'writing-agent/document-revision@1', role: 'developer', content: DOCUMENT_REVISION_INSTRUCTION }],
          ...(configuration.reasoning === undefined ? {} : { reasoning: configuration.reasoning }),
          onProgress: async event => {
            await sessionProgress(event);
            await options.onProgress?.(event);
          }
        });
      }
    });
    await session.restore();
    const submission = await session.submit({ task: `Revise ${JSON.stringify(documentPath)}. ${instruction}` });
    if (submission.kind === 'rejected' || submission.kind === 'steered') throw new Error('Document revision was not admitted as durable work.');
    return Object.freeze({ sessionId: descriptor.id, result: await submission.completion });
  } finally {
    await localHost.close();
  }
}

export async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }
  let model = process.env.WRITING_AGENT_MODEL ?? 'gpt-5.6-luna';
  let showReasoning = false;
  let documentPath: string | undefined;
  let rootDirectory = process.cwd();
  let stateDirectory: string | undefined;
  let sessionId: string | undefined;
  const briefParts: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    if (value === '--model' || value === '--document' || value === '--root' || value === '--state' || value === '--session') {
      const selected = argv[index + 1];
      if (!selected || selected.startsWith('--')) throw new Error(`${value} requires a value.`);
      if (value === '--model') model = selected;
      else if (value === '--document') documentPath = selected;
      else if (value === '--root') rootDirectory = selected;
      else if (value === '--state') stateDirectory = selected;
      else sessionId = selected;
      index += 1;
    } else if (value === '--show-reasoning') {
      showReasoning = true;
    } else if (value.startsWith('--')) {
      throw new Error(`Unknown option: ${value}`);
    } else {
      briefParts.push(value);
    }
  }
  let brief = briefParts.join(' ').trim();
  if (brief.length === 0 && !process.stdin.isTTY) brief = (await readStandardInput()).trim();
  if (brief.length === 0) throw new Error('Provide a writing brief or pipe one through stdin.');
  const provider = new OpenAICodexProvider({ model });
  const progress = showReasoning ? showReasoningProgress : undefined;
  const execution = documentPath === undefined
    ? { result: await runWritingTask({ brief, provider, model, reasoning: { strategy: 'effort', effort: 'medium' }, ...(progress ? { onProgress: progress } : {}) }) }
    : await runDocumentRevision({
        instruction: brief,
        documentPath,
        rootDirectory,
        stateDirectory: stateDirectory ?? path.join(path.resolve(rootDirectory), '.writing-agent'),
        provider,
        model,
        ...(sessionId === undefined ? {} : { sessionId }),
        reasoning: { strategy: 'effort', effort: 'medium' },
        ...(progress ? { onProgress: progress } : {})
      });
  if ('sessionId' in execution) process.stderr.write(`[writing session ${execution.sessionId}]\n`);
  const result = execution.result;
  if (result.state === 'suspended') throw new Error('Writing workflows do not request interactive approval.');
  const message = result.terminal.candidate.status === 'absent'
    ? ('errorMessage' in result.terminal ? result.terminal.errorMessage : 'Writing run ended without a draft.')
    : result.terminal.candidate.message;
  process.stdout.write(`${message}\n`);
  process.exitCode = result.terminal.executionStatus === 'completed' ? 0 : 1;
}

function showReasoningProgress(event: AgentProgressEvent): void {
  if (event.type === 'assistant.reasoning' && event.channel === 'summary' && event.delta.length > 0) process.stderr.write(event.delta);
}

async function ownedDocumentPath(rootDirectory: string, value: string): Promise<string> {
  const requested = requiredText(value, 'The document path').replaceAll('\\', '/').replace(/^\.\//u, '');
  if (path.posix.isAbsolute(requested) || path.win32.isAbsolute(requested) || requested.split('/').includes('..')) throw new Error('The document path must be relative to the writing root.');
  const absolute = path.resolve(rootDirectory, requested);
  if (absolute !== rootDirectory && !absolute.startsWith(`${rootDirectory}${path.sep}`)) throw new Error('The document path escapes the writing root.');
  const stat = await fs.lstat(absolute);
  if (!stat.isFile()) throw new Error('The document path must identify an existing regular file.');
  return path.relative(rootDirectory, absolute).replaceAll('\\', '/');
}

function requiredText(value: string, label: string): string {
  const text = value.trim();
  if (text.length === 0) throw new Error(`${label} must not be empty.`);
  return text;
}

async function readStandardInput(): Promise<string> {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += String(chunk);
  return input;
}

function printHelp(): void {
  process.stdout.write(`Writing Agent\n\nUsage:\n  writing-agent <brief> [--model gpt-5.6-luna] [--show-reasoning]\n  writing-agent --document <relative-path> [--root .] [--state .writing-agent] [--session <id>] <revision instruction>\n  printf '%s\\n' <brief> | writing-agent\n`);
}

function isDirectRun(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try { return realpathSync(entrypoint) === realpathSync(modulePath); }
  catch { return path.resolve(entrypoint) === modulePath; }
}

if (isDirectRun()) main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

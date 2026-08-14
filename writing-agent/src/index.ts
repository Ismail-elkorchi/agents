#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/evidence';
import type { ModelProvider, ModelReasoningRequest } from '@agent-core/model';
import { OpenAICodexProvider } from '@agent-core/provider-openai-codex';
import {
  AgentRuntime,
  agentEventCodec,
  type AgentProgressEvent,
  type AgentRunResult
} from '@agent-core/runtime';

const WRITING_INSTRUCTION = [
  'Produce a finished draft that directly satisfies the brief.',
  'Preserve the intended audience, purpose, constraints, and voice.',
  'Do not invent external facts or claim actions that were not supplied in the brief.',
  'Return the draft itself unless the brief explicitly asks for commentary.'
].join(' ');

export interface WritingTaskOptions {
  readonly brief: string;
  readonly provider: ModelProvider;
  readonly model: string;
  readonly reasoning?: ModelReasoningRequest;
  readonly onProgress?: (event: AgentProgressEvent) => void | Promise<void>;
}

export async function runWritingTask(options: WritingTaskOptions): Promise<AgentRunResult> {
  const brief = options.brief.trim();
  if (brief.length === 0) throw new Error('The writing brief must not be empty.');
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

export async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }
  let model = process.env.WRITING_AGENT_MODEL ?? 'gpt-5.6-luna';
  let showReasoning = false;
  const briefParts: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    if (value === '--model') {
      const selected = argv[index + 1];
      if (!selected || selected.startsWith('--')) throw new Error('--model requires a value.');
      model = selected;
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
  const result = await runWritingTask({
    brief,
    provider: new OpenAICodexProvider({ model }),
    model,
    reasoning: { strategy: 'effort', effort: 'medium' },
    ...(showReasoning ? { onProgress: showReasoningProgress } : {})
  });
  if (result.state === 'suspended') throw new Error('A tool-free writing run cannot require approval.');
  const message = result.terminal.candidate.status === 'absent'
    ? ('errorMessage' in result.terminal ? result.terminal.errorMessage : 'Writing run ended without a draft.')
    : result.terminal.candidate.message;
  process.stdout.write(`${message}\n`);
  process.exitCode = result.terminal.executionStatus === 'completed' ? 0 : 1;
}

function showReasoningProgress(event: AgentProgressEvent): void {
  if (event.type === 'assistant.reasoning' && event.channel === 'summary' && event.delta.length > 0) process.stderr.write(event.delta);
}

async function readStandardInput(): Promise<string> {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += String(chunk);
  return input;
}

function printHelp(): void {
  process.stdout.write(`Writing Agent\n\nUsage:\n  writing-agent <brief> [--model gpt-5.6-luna] [--show-reasoning]\n  printf '%s\\n' <brief> | writing-agent\n`);
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

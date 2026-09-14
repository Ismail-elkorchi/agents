#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openWritingApplication } from './application/service.js';
import {
  createWritingProvider,
  createWritingReasoningRequest,
  parseWritingProviderId
} from './provider.js';

export async function main(argv: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      'state-root': { type: 'string' },
      session: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      'fresh-continuation': { type: 'boolean' },
      endpoint: { type: 'string' },
      reasoning: { type: 'string' },
      mode: { type: 'string' },
      passage: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' }
    }
  });
  if (values.help || positionals[0] === 'help') {
    printHelp();
    return;
  }
  const command = positionals[0] ?? (process.stdin.isTTY ? 'tui' : 'write');
  if (!['tui', 'rpc', 'write', 'review'].includes(command))
    throw new Error(`Unknown command: ${command}`);
  if (values.passage?.length && command !== 'write' && command !== 'review')
    throw new Error('--passage requires a write or review instruction.');
  if (command === 'tui' && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new Error(
      'Interactive mode requires a terminal. Use writing-agent write or review with piped input.'
    );
  let instruction = positionals.slice(1).join(' ');
  if (command === 'write' || command === 'review') {
    if (!instruction && !process.stdin.isTTY) {
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) instruction += String(chunk);
    }
    if (!instruction.trim())
      throw new Error('Provide an instruction as an argument or on standard input.');
  }
  const mode = command === 'review' ? 'review' : (values.mode ?? 'edit');
  if (mode !== 'edit' && mode !== 'review') throw new Error('Mode must be edit or review.');
  const provider = values.provider ?? process.env.WRITING_AGENT_PROVIDER;
  const model = values.model ?? process.env.WRITING_AGENT_MODEL;
  const reasoning = createWritingReasoningRequest(values.reasoning);
  if (
    values['fresh-continuation'] &&
    (values.session === undefined || values.provider === undefined || values.model === undefined)
  )
    throw new Error('--fresh-continuation requires --session and explicit --provider and --model.');
  const application = await openWritingApplication({
    ...(values['fresh-continuation'] ? { freshContinuation: true } : {}),
    rootDirectory: path.resolve(values.root ?? process.cwd()),
    mode,
    ...(values['state-root'] === undefined ? {} : { stateRoot: values['state-root'] }),
    ...(values.session === undefined ? {} : { sessionId: values.session }),
    ...(provider === undefined || model === undefined
      ? {}
      : {
          configuration: {
            ...createWritingProvider({
              provider: parseWritingProviderId(provider),
              model,
              ...(values.endpoint === undefined ? {} : { endpoint: values.endpoint })
            }),
            ...(reasoning === undefined ? {} : { reasoning })
          }
        })
  });
  try {
    await application.start();
    if (command === 'tui') {
      const { runWritingAgentTuiApp } = await import('./tui/index.js');
      await runWritingAgentTuiApp(application);
    } else if (command === 'rpc') {
      const { runWritingRpc } = await import('./rpc/index.js');
      await runWritingRpc(application, {
        input: process.stdin,
        output: process.stdout,
        diagnostic: (message) => {
          process.stderr.write(`${message}\n`);
        }
      });
    } else {
      const contextItems = await Promise.all(
        (values.passage ?? []).map((encoded) => {
          const input: unknown = JSON.parse(encoded);
          return application.readPassageContext(input);
        })
      );
      const submission = await application.submit({
        task: instruction,
        ...(contextItems.length ? { contextItems } : {})
      });
      if (submission.kind === 'rejected')
        throw new Error(`Instruction rejected: ${submission.reason}`);
      const result = await submission.completion;
      process.stdout.write(
        `${result.state === 'ended' ? (result.terminal.modelOutput.status === 'absent' ? '' : result.terminal.modelOutput.message) : result.reason}\n`
      );
      if (result.state !== 'ended' || result.terminal.executionStatus !== 'completed') {
        process.stderr.write(
          `Run ${result.state === 'ended' ? result.terminal.executionStatus : 'suspended'}. Open the TUI to inspect recorded results and recovery actions.\n`
        );
        process.exitCode = 1;
      }
    }
  } finally {
    await application.close();
  }
}
function printHelp() {
  process.stdout.write(
    `Writing Agent\n\nwriting-agent [tui|rpc|write|review] [instruction]\n\n--root PATH          Workspace directory (default: current directory)\n--provider ID        ollama, openai, openai-codex, or openrouter\n--model ID           Provider model\n--fresh-continuation Explicitly continue the same session from portable originals\n--endpoint URL       Provider endpoint\n--reasoning EFFORT   Requested model reasoning effort\n--mode edit|review   File editing or read-only review (default: edit)\n--state-root PATH    Private state outside the workspace\n--session ID         Resume a recorded conversation\n--passage JSON       Attach a revision-bound passage (repeatable)\n\nNo arguments opens the TUI in an interactive terminal.\nWRITING_AGENT_PROVIDER and WRITING_AGENT_MODEL supply provider defaults.\n`
  );
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

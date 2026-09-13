#!/usr/bin/env node
import { FileCredentialStore } from '@agent-core/auth';

import { loginOpenAICodexDeviceCode, type OpenAICodexTransport } from '@agent-core/provider-openai-codex';

import { type AgentProgressEvent, type AgentRunResult } from '@agent-core/runtime';

import { type ToolCall, type ToolObservation, type ToolProgress } from '@agent-core/tools';

import { realpathSync } from 'node:fs';

import path from 'node:path';

import type { Writable } from 'node:stream';

import { fileURLToPath } from 'node:url';

import { parseCodingPermissionMode } from './security/permission-mode.js';

import { createTrustDecision } from './security/workspace-trust.js';

import { parseReasoningEffort } from './application/input.js';
import {
  parseProviderId,
  reasoningFromEffort,
  type CodingApplicationOptions,
  type SessionSelection
} from './application/runtime.js';
import { CodingApplication } from './application/service.js';
import type { CodingRunVerification } from './verification/configured-check-tool.js';
import { openCodingWorkspace } from './workspace.js';

type CliAuthProviderId = 'openai' | 'openai-codex';

export async function main(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h')) {
    printHelp();
    return;
  }
  if (argv[0] === 'auth') {
    await runAuthCommand(argv.slice(1));
    return;
  }
  if (argv[0] === 'approval') {
    await runApprovalCommand(argv.slice(1));
    return;
  }
  if (argv[0] === 'trust') {
    await runTrustCommand(argv.slice(1));
    return;
  }

  const rpc = argv[0] === 'rpc';
  const exec = argv[0] === 'exec';
  if (exec && argv.length === 2 && (argv[1] === 'help' || argv[1] === '--help' || argv[1] === '-h')) {
    printHelp();
    return;
  }
  const parsed = parseOptions(exec || rpc ? argv.slice(1) : argv);
  let task = parsed.positionals.join(' ');
  if (exec && (task === '-' || (task.length === 0 && !process.stdin.isTTY)))
    task = await readStandardInput();
  const resumeOnly = exec && task.length === 0 && parsed.options.sessionSelection.kind !== 'new';
  if (exec && task.length === 0 && !resumeOnly)
    throw new Error(
      'coding-agent exec requires a task string, piped stdin, or an existing session selected with --resume or --session.'
    );
  if (!exec && !rpc && !process.stdin.isTTY)
    throw new Error('Interactive mode requires a terminal. Use coding-agent exec with piped input.');
  const root = path.resolve(parsed.options.root);
  const workspace = await openCodingWorkspace(
    root,
    parsed.options.stateRoot ? { stateRoot: parsed.options.stateRoot } : {}
  );
  if (rpc) {
    if (parsed.positionals.length > 0) {
      workspace.fileRoot.close();
      throw new Error('RPC mode does not accept a task argument.');
    }
    const { runCodingRpc } = await import('./rpc/index.js');
    await runCodingRpc(new CodingApplication(parsed.options, workspace), {
      input: process.stdin,
      output: process.stdout,
      diagnostic: (message) => process.stderr.write(`${message}\n`)
    });
    return;
  }
  if (exec) {
    const application = new CodingApplication(parsed.options, workspace);
    const progress = new CodingAgentProgressRenderer({ showReasoning: parsed.options.showReasoning });
    let completed: AgentRunResult | undefined;
    let failure: Error | undefined;
    const unsubscribe = application.subscribe(
      (event) => {
        if (event.type === 'run.progress') progress.handle(event.event);
        else if (event.type === 'run.completed') completed = event.result;
        else if (event.type === 'run.failed') failure = event.error;
      },
      (error) => {
        failure = error;
      }
    );
    try {
      await application.start();
      const state = application.state();
      if (state.status !== 'ready')
        throw new Error(
          `Coding application requires setup: ${state.requirements.join(', ')}. Workspace is ${state.runtimeDetails.workspaceTrust ?? 'untrusted'}.`
        );
      let result: AgentRunResult;
      if (resumeOnly) {
        const view = await application.readSession();
        if (view.session.phase === 'suspended') result = await application.resumeSuspension();
        else {
          await application.waitForIdle();
          if (failure !== undefined) throw failure;
          if (completed === undefined)
            throw new Error(
              'The selected session has no unfinished run to resume. Supply a new task to continue the session.'
            );
          result = completed;
        }
      } else {
        const accepted = await application.submit({ task });
        if (accepted.kind === 'rejected') throw new Error(`Task was rejected: ${accepted.reason}.`);
        result = await accepted.completion;
      }
      printResult(result, progress, process.stdout, await application.readVerification(runIdOf(result)));
      printPersistenceLocations(application, result);
      process.exitCode = resultExitCode(result);
    } finally {
      unsubscribe();
      await application.close();
    }
    return;
  }

  const controller = new CodingApplication(parsed.options, workspace);
  const { runCodingAgentTuiApp } = await import('./tui/index.js');
  await runCodingAgentTuiApp(controller, {
    ...(task.length > 0 ? { initialTask: task } : {})
  });
}

function parseOptions(args: string[]): { options: CliOptions; positionals: string[] } {
  const options: CliOptions = {
    root: process.cwd(),
    permissionMode: 'review',
    showReasoning: false,
    sessionSelection: { kind: 'new' }
  };
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const [key = '', inlineValue] = arg.split('=', 2);
    const spec = cliOptionSpec(key);
    if (!spec) throw new Error(`Unknown option: ${key}`);
    const value = spec.takesValue ? requireValue(key, inlineValue ?? args[index + 1]) : undefined;
    spec.apply(options, value, key);
    if (spec.takesValue && inlineValue === undefined) index += 1;
  }
  if (options.branch && options.sessionSelection.kind === 'new')
    throw new Error('--branch requires --resume or --session.');
  return { options, positionals };
}

interface CliOptionSpec {
  readonly takesValue: boolean;
  apply(options: CliOptions, value: string | undefined, key: string): void;
}

const CLI_OPTION_SPECS = {
  '--root': valued((options, value) => {
    options.root = value;
  }),
  '--state-root': valued((options, value) => {
    options.stateRoot = value;
  }),
  '--model': valued((options, value) => {
    options.model = value;
  }),
  '--provider': valued((options, value) => {
    options.provider = parseProviderId(value);
  }),
  '--provider-endpoint': valued((options, value) => {
    options.providerEndpoint = value;
  }),
  '--codex-transport': valued((options, value) => {
    options.codexTransport = parseCodexTransport(value);
  }),
  '--max-output-tokens': valued((options, value, key) => {
    options.maxOutputTokens = parsePositiveIntegerOption(key, value);
  }),
  '--temperature': valued((options, value) => {
    const temperature = Number(value);
    if (!Number.isFinite(temperature)) throw new Error('--temperature must be a finite number.');
    options.temperature = temperature;
  }),
  '--reasoning-effort': valued((options, value, key) => {
    options.reasoning = reasoningFromEffort(parseReasoningEffort(value, key));
  }),
  '--permissions': valued((options, value) => {
    options.permissionMode = parseCodingPermissionMode(value, '--permissions');
  }),
  '--show-reasoning': flagged((options) => {
    options.showReasoning = true;
  }),
  '--resume': flagged((options) => {
    setSessionSelection(options, { kind: 'latest' }, '--resume');
  }),
  '--session': valued((options, value) => {
    setSessionSelection(options, { kind: 'existing', id: value }, '--session');
  }),
  '--branch': valued((options, value) => {
    options.branch = value;
  }),
  '--config': valued((options, value) => {
    options.config = value;
  })
} satisfies Record<string, CliOptionSpec>;

function valued(apply: (options: CliOptions, value: string, key: string) => void): CliOptionSpec {
  return {
    takesValue: true,
    apply(options, value, key) {
      apply(options, value ?? '', key);
    }
  };
}

function flagged(apply: (options: CliOptions) => void): CliOptionSpec {
  return { takesValue: false, apply };
}

function cliOptionSpec(key: string): CliOptionSpec | undefined {
  return isCliOptionKey(key) ? CLI_OPTION_SPECS[key] : undefined;
}

function isCliOptionKey(key: string): key is keyof typeof CLI_OPTION_SPECS {
  return Object.hasOwn(CLI_OPTION_SPECS, key);
}

function setSessionSelection(options: CliOptions, selection: SessionSelection, option: string): void {
  if (options.sessionSelection.kind !== 'new')
    throw new Error(`${option} conflicts with another session selector.`);
  options.sessionSelection = selection;
}

function parseCodexTransport(value: string): OpenAICodexTransport {
  if (value === 'http_sse' || value === 'websocket') return value;
  throw new Error('--codex-transport must be http_sse or websocket.');
}

async function runApprovalCommand(args: string[]): Promise<void> {
  const [decisionValue, runId, approvalId, fingerprint, ...optionArgs] = args;
  if ((decisionValue !== 'allow' && decisionValue !== 'deny') || !runId || !approvalId || !fingerprint) {
    throw new Error(
      'Usage: coding-agent approval <allow|deny> <run-id> <approval-id> <fingerprint> [options]'
    );
  }
  const parsed = parseOptions(optionArgs);
  if (parsed.positionals.length > 0)
    throw new Error(`Unexpected approval arguments: ${parsed.positionals.join(' ')}`);
  if (parsed.options.sessionSelection.kind !== 'new' || parsed.options.branch)
    throw new Error(
      'Approval resolution uses the session persisted with the run; session selectors are not allowed.'
    );
  const workspace = await openCodingWorkspace(
    path.resolve(parsed.options.root),
    parsed.options.stateRoot ? { stateRoot: parsed.options.stateRoot } : {}
  );
  if (workspace.security.trustLevel === 'untrusted') {
    workspace.fileRoot.close();
    throw new Error('Cannot resolve an approval for an untrusted workspace.');
  }
  const application = new CodingApplication(parsed.options, workspace);
  const progress = new CodingAgentProgressRenderer({ showReasoning: parsed.options.showReasoning });
  let deliveryFailure: Error | undefined;
  const unsubscribe = application.subscribe(
    (event) => {
      if (event.type === 'run.progress') progress.handle(event.event);
    },
    (error) => {
      deliveryFailure = error;
    }
  );
  try {
    await application.restoreRun(runId);
    const result = await application.resolveApproval({
      runId,
      approvalId,
      fingerprint,
      decision: decisionValue
    });
    if (deliveryFailure !== undefined) throw deliveryFailure;
    printResult(result, progress, process.stdout, await application.readVerification(runIdOf(result)));
    printPersistenceLocations(application, result);
    process.exitCode = resultExitCode(result);
  } finally {
    unsubscribe();
    await application.close();
  }
}

async function runAuthCommand(args: string[]): Promise<void> {
  const [command, provider, ...extra] = args;
  if (!command || !provider || extra.length > 0) {
    throw new Error('Usage: coding-agent auth <login|logout|status> <provider>');
  }
  const providerId = parseAuthProviderId(provider);
  switch (command) {
    case 'status':
      await printAuthStatus(providerId);
      return;
    case 'logout':
      await logoutAuth(providerId);
      return;
    case 'login':
      await loginAuth(providerId);
      return;
    default:
      throw new Error(`Unknown auth command: ${command}. Supported commands: login, logout, status.`);
  }
}

async function runTrustCommand(args: string[]): Promise<void> {
  const [command, ...optionArgs] = args;
  if (command !== 'status' && command !== 'restricted' && command !== 'trusted' && command !== 'revoke') {
    throw new Error(
      'Usage: coding-agent trust <status|restricted|trusted|revoke> [--root <dir>] [--state-root <dir>]'
    );
  }
  const trustOptions = parseTrustOptions(optionArgs);
  const workspace = await openCodingWorkspace(
    trustOptions.root,
    trustOptions.stateRoot ? { stateRoot: trustOptions.stateRoot } : {}
  );
  try {
    if (command === 'status') {
      console.log(`Workspace: ${workspace.layout.workspaceRoot}`);
      console.log(`Identity: ${workspace.layout.identity.id}`);
      console.log(`Trust: ${workspace.security.trustLevel}`);
      return;
    }
    if (command === 'revoke') {
      await workspace.trustStore.delete(workspace.layout.identity);
      console.log(`Workspace trust revoked: ${workspace.layout.identity.id}`);
      return;
    }
    const decision = createTrustDecision({
      workspace: workspace.layout.identity,
      level: command,
      actorKind: 'user',
      actor: 'local-user'
    });
    await workspace.trustStore.write(decision);
    console.log(`Workspace trust set to ${command}: ${workspace.layout.identity.id}`);
  } finally {
    workspace.fileRoot.close();
  }
}

function parseTrustOptions(args: readonly string[]): {
  readonly root: string;
  readonly stateRoot?: string;
} {
  let root = process.cwd();
  let stateRoot: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    const [key = '', inlineValue] = argument.split('=', 2);
    if (key !== '--root' && key !== '--state-root')
      throw new Error(`Unknown trust option: ${key || argument}`);
    const value = requireValue(key, inlineValue ?? args[index + 1]);
    if (inlineValue === undefined) index += 1;
    if (key === '--root') root = path.resolve(value);
    else stateRoot = path.resolve(value);
  }
  return Object.freeze({ root, ...(stateRoot ? { stateRoot } : {}) });
}

function parseAuthProviderId(value: string): CliAuthProviderId {
  if (value === 'openai' || value === 'openai-codex') {
    return value;
  }
  throw new Error(`Unsupported auth provider: ${value}. Supported auth providers: openai, openai-codex.`);
}

async function printAuthStatus(provider: CliAuthProviderId): Promise<void> {
  if (provider === 'openai') {
    const apiKeySet = Boolean(process.env.OPENAI_API_KEY?.trim());
    console.log('openai:');
    console.log(`  Provider: OpenAI Platform API`);
    console.log(`  API key: ${apiKeySet ? 'set in OPENAI_API_KEY' : 'not set'}`);
    console.log('  ChatGPT subscription auth: use auth login openai-codex.');
    return;
  }
  const store = new FileCredentialStore();
  const stored = await store.read(provider);
  console.log(`${provider}:`);
  console.log('  Provider: OpenAI Codex / ChatGPT subscription');
  console.log(`  Stored OAuth credentials: ${stored ? 'present' : 'not present'}`);
  if (stored?.expiresAt) {
    console.log(`  Access token expires: ${new Date(stored.expiresAt).toISOString()}`);
  }
}

async function logoutAuth(provider: CliAuthProviderId): Promise<void> {
  if (provider === 'openai') {
    process.exitCode = 1;
    console.error(
      'openai uses OPENAI_API_KEY for API-key auth. Unset that environment variable to log out of the Platform provider.'
    );
    return;
  }
  const store = new FileCredentialStore();
  await store.delete(provider);
  console.log(`Deleted stored credentials for ${provider}.`);
}

async function loginAuth(provider: CliAuthProviderId): Promise<void> {
  if (provider === 'openai') {
    process.exitCode = 1;
    console.error(
      'openai is the OpenAI Platform API provider and uses OPENAI_API_KEY. Use auth login openai-codex for ChatGPT subscription auth.'
    );
    return;
  }
  const store = new FileCredentialStore();
  await loginOpenAICodexDeviceCode({
    store,
    key: provider,
    onDeviceCode(info) {
      console.log('OpenAI Codex device login:');
      console.log(`  Open: ${info.verificationUri}`);
      console.log(`  Code: ${info.userCode}`);
      console.log(`  Expires in: ${String(Math.round(info.expiresInSeconds / 60))} minutes`);
    }
  });
  console.log(`Stored credentials for ${provider}.`);
}

function writeLine(output: Writable, text: string): void {
  output.write(`${text}\n`);
}

function printResult(
  result: AgentRunResult,
  progress?: CodingAgentProgressRenderer,
  output: Writable = process.stdout,
  verification?: CodingRunVerification
): void {
  if (result.state === 'suspended') {
    if (result.reason !== 'approval_required') {
      writeLine(output, 'Execution: Waiting for recovery decision');
      writeLine(output, `Run: ${result.runId}`);
      writeLine(output, `Reason: ${title(result.reason.replaceAll('_', ' '))}`);
      if (result.effectId !== undefined) writeLine(output, `Effect: ${result.effectId}`);
      return;
    }
    writeLine(output, 'Execution: Waiting for approval');
    writeLine(output, `Run: ${result.runId}`);
    for (const approval of result.pendingApprovals) {
      writeLine(output, `Approval: ${approval.approvalId} ${approval.toolName} (${approval.reason})`);
      writeLine(output, `Fingerprint: ${approval.fingerprint}`);
      writeLine(
        output,
        `Allow: coding-agent approval allow ${result.runId} ${approval.approvalId} ${approval.fingerprint}`
      );
      writeLine(
        output,
        `Deny: coding-agent approval deny ${result.runId} ${approval.approvalId} ${approval.fingerprint}`
      );
    }
    return;
  }
  const terminal = result.terminal;
  if (!progress?.consumeFinalAlreadyPrinted()) {
    const message =
      terminal.modelOutput.status === 'absent'
        ? 'errorMessage' in terminal
          ? terminal.errorMessage
          : 'Run ended without model output.'
        : terminal.modelOutput.message;
    writeLine(output, `\n${message}`);
  }
  writeLine(output, `Execution: ${title(terminal.executionStatus)}`);
  writeLine(output, `Model output: ${title(terminal.modelOutput.status)}`);
  if (terminal.modelTerminationReason)
    writeLine(output, `Model termination: ${title(terminal.modelTerminationReason.replaceAll('_', ' '))}`);
  if ('errorMessage' in terminal) writeLine(output, `Reason: ${terminal.errorMessage}`);
  for (const check of verification?.checks ?? [])
    writeLine(output, `Check ${check.id}: ${check.requirement}/${check.status} (${check.coverage})`);
  for (const diagnostic of result.deliveryDiagnostics)
    writeLine(output, `Delivery diagnostic (${diagnostic.eventType}): ${diagnostic.message}`);
}

export function resultExitCode(result: AgentRunResult): number {
  if (result.state === 'suspended') return 7;
  if (result.terminal.executionStatus === 'aborted') return 130;
  if (result.terminal.executionStatus === 'failed') return 1;
  if (
    result.terminal.modelOutput.status === 'partial' ||
    result.terminal.modelOutput.status === 'indeterminate'
  )
    return 2;
  return 0;
}

function title(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
}

function printPersistenceLocations(application: CodingApplication, result: AgentRunResult): void {
  const locations = application.persistenceLocations(runIdOf(result));
  console.error(`\nLedger: ${locations.ledger}`);
  console.error(`Session: ${locations.session}`);
}

function runIdOf(result: AgentRunResult): string {
  return result.state === 'suspended' ? result.runId : result.terminal.runId;
}

export class CodingAgentProgressRenderer {
  private readonly stdout: Writable;
  private readonly stderr: Writable;
  private readonly showReasoning: boolean;
  private readonly hiddenReasoningHeartbeatChars: number;
  private readonly hiddenReasoningHeartbeatMs: number;
  private readonly streamedTurns = new Set<number>();
  private readonly reasoningTurns = new Set<number>();
  private readonly reasoningSummaryTurns = new Set<number>();
  private readonly reasoningUnavailableTurns = new Set<number>();
  private readonly streamedToolCallTurns = new Set<number>();
  private readonly streamedToolCallKeys = new Set<string>();
  private readonly statusKeys = new Set<string>();
  private readonly hiddenReasoningProgress = new Map<number, { chars: number; timestamp: number }>();
  private answerLineOpen = false;
  private reasoningLineOpen = false;
  private finalAlreadyPrinted = false;

  constructor(
    options: {
      stdout?: Writable;
      stderr?: Writable;
      showReasoning?: boolean;
      hiddenReasoningHeartbeatChars?: number;
      hiddenReasoningHeartbeatMs?: number;
    } = {}
  ) {
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.showReasoning = options.showReasoning ?? false;
    this.hiddenReasoningHeartbeatChars = Math.max(1, options.hiddenReasoningHeartbeatChars ?? 1_200);
    this.hiddenReasoningHeartbeatMs = Math.max(1, options.hiddenReasoningHeartbeatMs ?? 8_000);
  }

  handle(event: AgentProgressEvent): void {
    if (event.type === 'turn.started') {
      this.finishAnswerLine();
      this.finishReasoningLine();
      this.streamedTurns.clear();
      this.reasoningTurns.clear();
      this.reasoningSummaryTurns.clear();
      this.reasoningUnavailableTurns.clear();
      this.streamedToolCallTurns.clear();
      this.streamedToolCallKeys.clear();
      this.statusKeys.clear();
      this.hiddenReasoningProgress.clear();
      this.stderr.write(`\n[turn] ${event.task}\n`);
    } else if (event.type === 'assistant.started') {
      this.finishReasoningLine();
      this.stderr.write(`[assistant ${String(event.turnIndex)}] started\n`);
    } else if (event.type === 'assistant.delta') {
      if (event.delta.length > 0) {
        this.finishReasoningLine();
        this.stdout.write(event.delta);
        this.answerLineOpen = true;
        this.streamedTurns.add(event.turnIndex);
      }
    } else if (event.type === 'assistant.reasoning') {
      this.finishAnswerLine();
      if (this.showReasoning && event.channel === 'summary') {
        if (!this.reasoningSummaryTurns.has(event.turnIndex)) {
          this.finishReasoningLine();
          this.stderr.write(`[assistant ${String(event.turnIndex)}] reasoning summary\n`);
          this.reasoningSummaryTurns.add(event.turnIndex);
        }
        this.stderr.write(event.delta);
        this.reasoningLineOpen = true;
      } else if (
        this.showReasoning &&
        event.channel !== 'summary' &&
        !this.reasoningTurns.has(event.turnIndex)
      ) {
        this.reasoningTurns.add(event.turnIndex);
        this.hiddenReasoningProgress.set(event.turnIndex, {
          chars: event.accumulated.length,
          timestamp: Date.now()
        });
        this.maybeWriteHiddenReasoningHeartbeat(event);
      } else if (!this.reasoningTurns.has(event.turnIndex)) {
        this.stderr.write(`[assistant ${String(event.turnIndex)}] reasoning\n`);
        this.reasoningTurns.add(event.turnIndex);
        this.hiddenReasoningProgress.set(event.turnIndex, {
          chars: event.accumulated.length,
          timestamp: Date.now()
        });
      } else {
        this.maybeWriteHiddenReasoningHeartbeat(event);
      }
    } else if (event.type === 'assistant.status') {
      this.finishAnswerLine();
      this.finishReasoningLine();
      const key = `${String(event.turnIndex)}:${event.message}`;
      if (!this.statusKeys.has(key)) {
        this.statusKeys.add(key);
        this.stderr.write(`[assistant ${String(event.turnIndex)}] ${event.message}\n`);
      }
    } else if (event.type === 'model.failed') {
      this.finishAnswerLine();
      this.finishReasoningLine();
      this.stderr.write(
        `[assistant ${String(event.turnIndex)}] model failed: ${formatModelFailure(event.diagnostic)}\n`
      );
    } else if (event.type === 'tool.call.received') {
      this.finishAnswerLine();
      this.finishReasoningLine();
      this.streamedToolCallTurns.add(event.turnIndex);
      const key = `${String(event.turnIndex)}:${JSON.stringify(event.toolCall)}`;
      if (!this.streamedToolCallKeys.has(key)) {
        this.streamedToolCallKeys.add(key);
        this.stderr.write(
          `[assistant ${String(event.turnIndex)}] tool call: ${formatToolCall(event.toolCall)}\n`
        );
      }
    } else if (event.type === 'assistant.ended') {
      const toolCalls = event.toolCalls ?? [];
      this.writeUnavailableReasoningSummaryIfNeeded(event.turnIndex);
      if (toolCalls.length > 0 && !this.streamedToolCallTurns.has(event.turnIndex)) {
        this.finishAnswerLine();
        this.finishReasoningLine();
        this.stderr.write(
          `[assistant ${String(event.turnIndex)}] tool calls:\n${toolCalls.map((call) => `  - ${formatToolCall(call)}`).join('\n')}\n`
        );
      } else if (event.content.trim().length > 0 && this.streamedTurns.has(event.turnIndex)) {
        this.finishReasoningLine();
        this.finishAnswerLine();
        this.finalAlreadyPrinted = true;
      }
    } else if (event.type === 'assistant.interrupted') {
      if (event.content.trim().length > 0 && this.streamedTurns.has(event.turnIndex)) {
        this.finishReasoningLine();
        this.finishAnswerLine();
      }
      if (event.reasoningSummary !== undefined && this.showReasoning) {
        this.reasoningSummaryTurns.add(event.turnIndex);
      }
      this.writeUnavailableReasoningSummaryIfNeeded(event.turnIndex);
      this.stderr.write(`[assistant ${String(event.turnIndex)}] interrupted before final response\n`);
    } else if (event.type === 'tool.started') {
      this.finishAnswerLine();
      this.finishReasoningLine();
      this.stderr.write(`[tool ${String(event.turnIndex)}] running ${formatToolCall(event.input)}\n`);
    } else if (event.type === 'tool.updated') {
      const message = cliProgressMessage(event.progress);
      if (event.progress.type !== 'status' || event.progress.stage !== 'executing') {
        this.finishAnswerLine();
        this.finishReasoningLine();
        this.stderr.write(`[tool ${String(event.turnIndex)}] ${event.toolName}: ${message}\n`);
      }
    } else if (event.type === 'tool.ended') {
      this.finishAnswerLine();
      this.finishReasoningLine();
      this.stderr.write(formatToolResult(event.turnIndex, event.toolName, event.observation));
    } else {
      this.finishReasoningLine();
      this.finishAnswerLine();
    }
  }

  consumeFinalAlreadyPrinted(): boolean {
    const value = this.finalAlreadyPrinted;
    this.finalAlreadyPrinted = false;
    return value;
  }

  private finishAnswerLine(): void {
    if (!this.answerLineOpen) {
      return;
    }
    this.stdout.write('\n');
    this.answerLineOpen = false;
  }

  private finishReasoningLine(): void {
    if (!this.reasoningLineOpen) {
      return;
    }
    this.stderr.write('\n');
    this.reasoningLineOpen = false;
  }

  private maybeWriteHiddenReasoningHeartbeat(
    event: Extract<AgentProgressEvent, { type: 'assistant.reasoning' }>
  ): void {
    const previous = this.hiddenReasoningProgress.get(event.turnIndex);
    const now = Date.now();
    const chars = event.accumulated.length;
    if (
      !previous ||
      chars - previous.chars >= this.hiddenReasoningHeartbeatChars ||
      now - previous.timestamp >= this.hiddenReasoningHeartbeatMs
    ) {
      this.stderr.write(
        `[assistant ${String(event.turnIndex)}] reasoning still streaming (${String(chars)} chars hidden)\n`
      );
      this.hiddenReasoningProgress.set(event.turnIndex, { chars, timestamp: now });
    }
  }

  private writeUnavailableReasoningSummaryIfNeeded(turnIndex: number): void {
    if (
      !this.showReasoning ||
      !this.reasoningTurns.has(turnIndex) ||
      this.reasoningSummaryTurns.has(turnIndex) ||
      this.reasoningUnavailableTurns.has(turnIndex)
    ) {
      return;
    }
    this.finishAnswerLine();
    this.finishReasoningLine();
    this.stderr.write(`[assistant ${String(turnIndex)}] reasoning summary unavailable\n`);
    this.reasoningUnavailableTurns.add(turnIndex);
  }
}

function formatToolCall(toolCall: ToolCall): string {
  const input =
    toolCall.input.kind === 'json'
      ? compactForDisplay(redactLargeToolArguments(toolCall.input.value), 300)
      : compactForDisplay(redactLargeToolText(toolCall.input.value), 300);
  return input === '{}' || input.length === 0 ? toolCall.name : `${toolCall.name} ${input}`;
}

function formatToolResult(turnIndex: number, toolName: string, observation: ToolObservation): string {
  const status = observation.ok ? 'ok' : 'failed';
  const turnLabel = String(turnIndex);
  const artifactRefs = (observation.content ?? []).flatMap((item) =>
    item.type === 'text' ? [] : [item.artifact]
  );
  const artifacts =
    artifactRefs.length > 0
      ? `\n[tool ${turnLabel}] artifacts: ${artifactRefs.map((artifact) => artifact.label ?? artifact.artifactId).join(', ')}`
      : '';
  return `[tool ${turnLabel}] ${status} ${toolName} - ${observation.summary}${artifacts}\n`;
}

function formatModelFailure(
  diagnostic: Extract<AgentProgressEvent, { type: 'model.failed' }>['diagnostic']
): string {
  const parts = [
    `provider=${diagnostic.provider}`,
    `code=${diagnostic.code}`,
    `retryable=${String(diagnostic.retryable)}`,
    diagnostic.transport ? `transport=${diagnostic.transport}` : '',
    diagnostic.eventType ? `event=${diagnostic.eventType}` : ''
  ].filter((part) => part.length > 0);
  return parts.join(' ');
}

function redactLargeToolArguments(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      shouldSummarizeArgument(key, value) ? summarizeArgument(value) : value
    ])
  );
}

function redactLargeToolText(input: string): string {
  return input.length > 180 ? summarizeArgument(input) : input;
}

function shouldSummarizeArgument(key: string, value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (key === 'content' || key === 'oldText' || key === 'newText' || value.length > 180)
  );
}

function summarizeArgument(value: unknown): string {
  if (typeof value !== 'string') {
    return compactForDisplay(value, 180);
  }
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length > 80
    ? `${singleLine.slice(0, 80)}... (${String(value.length)} chars)`
    : `${singleLine} (${String(value.length)} chars)`;
}

function compactForDisplay(value: unknown, maxLength: number): string {
  const text = JSON.stringify(value);
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 14)}... [truncated]` : text;
}

async function readStandardInput(): Promise<string> {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += String(chunk);
  return input;
}

function requireValue(key: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`${key} requires a value.`);
  }
  return value;
}

function parsePositiveIntegerOption(key: string, value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return number;
}

function cliProgressMessage(progress: ToolProgress): string {
  switch (progress.type) {
    case 'status':
      return progress.message ?? progress.stage;
    case 'output':
      return `${progress.stream}: ${progress.text}`;
    case 'metric':
      return `${progress.name}: ${String(progress.value)}${progress.unit ? ` ${progress.unit}` : ''}`;
  }
}

function printHelp(): void {
  console.log(`Coding Agent CLI

Usage:
  coding-agent ["initial task"] [options]
  coding-agent rpc [options]
  coding-agent exec <task|-> [options]
  coding-agent exec --resume [options]
  coding-agent auth status openai
  coding-agent auth login openai-codex
  coding-agent trust <status|restricted|trusted|revoke> [--root .]
  coding-agent approval <allow|deny> <run-id> <approval-id> <fingerprint> [--root .] [--config coding-agent.config.json]
  coding-agent

Safety defaults:
  New and identity-changed workspaces are untrusted and cannot send provider requests or run effects.
  Private runs, sessions, artifacts, journals, and trust records are stored outside the workspace.
  review mode exposes root-bound read tools only; edit adds structured mutation; develop adds sandboxed commands.
  Commands and verification run with no network, no host-process access, no inherited environment, and no ambient fallback.
  Restricted workspaces require approval before every mutation or command. Repository policy can narrow but never expand the selected mode.

Common options:
  --root <dir>           Workspace root. Default: current directory.
  --state-root <dir>     Coding Agent private state root. Default: the platform user-state directory.
  --config <path>        Load a project configuration proposal. coding-agent.config.json is discovered when present.
  --provider <name>      Model provider. Supported: ollama, openrouter, openai, openai-codex.
  --model <name>         Model name. No provider or model is selected implicitly.
  --provider-endpoint <url>
                         Provider endpoint override. Ollama host or provider base URL.
  --codex-transport <http_sse|websocket>
                         OpenAI Codex streaming transport. Default: http_sse.
  --max-output-tokens <n>
                         Optional per-request output token override.
  --temperature <n>      Provider temperature.
  --reasoning-effort <level>
                         Optional reasoning effort: none, minimal, low, medium, high, xhigh, max.
  --show-reasoning       Stream separate model reasoning or reasoning summaries to stderr.
  --permissions <mode>   Authority ceiling: review, edit, or develop. Default: review.
  --resume               Select the latest session; taskless exec drives only its unfinished run.
  --session <id>         Open an existing session by ID.
  --branch <entry-id>    Branch the active session from a prior entry before running.

Interactive setup:
  The TUI opens before workspace trust or model selection is complete.
  Use /trust, /provider, /model, /permissions, and /login from the command picker.
  Messages submitted during setup are retained until the runtime is ready.
  coding-agent exec remains strict and never prompts for missing setup.

OpenRouter:
  Set OPENROUTER_API_KEY before using --provider openrouter.
  Optional attribution: OPENROUTER_APP_URL and OPENROUTER_APP_TITLE.

OpenAI:
  --provider openai uses the OpenAI Platform API and OPENAI_API_KEY.
  --provider openai-codex uses ChatGPT/Codex subscription auth stored outside the workspace.
  Run coding-agent auth login openai-codex before using --provider openai-codex.
`);
}

if (isDirectRun()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(formatCliError(error));
    process.exitCode = 1;
  });
}

function formatCliError(error: unknown): string {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || seen.has(value)) return;
    if ((typeof value === 'object' && value !== null) || typeof value === 'function') seen.add(value);
    if (value instanceof AggregateError) {
      lines.push(value.message);
      for (const nested of value.errors.slice(0, 8)) visit(nested, depth + 1);
      return;
    }
    lines.push(value instanceof Error ? value.message : String(value));
  };
  visit(error, 0);
  return [...new Set(lines)].join('\nCaused by: ');
}

function isDirectRun(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entrypoint) === realpathSync(modulePath);
  } catch {
    return path.resolve(entrypoint) === modulePath;
  }
}
interface CliOptions extends CodingApplicationOptions {
  showReasoning: boolean;
}

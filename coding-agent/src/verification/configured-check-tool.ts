import {
  defineTool,
  isRiskAllowed,
  planCommandExecution,
  releaseCommandExecutionPlan,
  startCommandExecutionPlan,
  type CommandExecution,
  type CommandExecutionOwner,
  type CommandExecutionResult,
  type CompiledToolDefinition
} from '@agent-core/tools';
import type { EventRepository } from '@agent-core/persistence';
import type { AgentEvent } from '@agent-core/runtime';
import * as z from 'zod';
import type { CodingAgentCheckConfiguration } from '../configuration.js';

const inputSchema = z.strictObject({ id: z.string().min(1) });
const outputSchema = z.strictObject({
  id: z.string().min(1),
  status: z.enum(['passed', 'failed', 'inconclusive']),
  processStatus: z.enum(['exited', 'stopped', 'timed_out', 'failed']),
  exitCode: z.number().int().nullable().optional(),
  output: z.string(),
  outputComplete: z.boolean()
});

interface ConfiguredCheck {
  readonly definition: CodingAgentCheckConfiguration;
  readonly requirement: 'required' | 'advisory';
}

type ConfiguredCheckProcessStatus = Exclude<CommandExecutionResult['status'], 'running'>;

export interface ConfiguredCheckResult {
  readonly id: string;
  readonly requirement: 'required' | 'advisory';
  readonly coverage: 'targeted' | 'full';
  readonly status: 'passed' | 'failed' | 'not_run' | 'inconclusive';
  readonly processStatus?: ConfiguredCheckProcessStatus;
  readonly exitCode?: number | null;
  readonly output?: string;
  readonly outputComplete?: boolean;
}

export interface CodingRunVerification {
  readonly runId: string;
  readonly checks: readonly ConfiguredCheckResult[];
}

export async function readConfiguredCheckResults(
  events: EventRepository<AgentEvent>,
  runId: string,
  configuration: Pick<import('../configuration.js').CodingAgentConfiguration, 'verification'> | undefined
): Promise<CodingRunVerification> {
  const observed = new Map<string, z.infer<typeof outputSchema>>();
  for await (const envelope of events.read(runId)) {
    const event = envelope.event;
    if (
      event.type !== 'tool.ended' ||
      event.toolName !== 'run_check' ||
      event.observation.kind !== 'result'
    )
      continue;
    const result = outputSchema.safeParse(event.observation.output);
    if (!result.success) throw new Error(`Run ${runId} contains an invalid configured-check result.`);
    observed.set(result.data.id, result.data);
  }
  const configured = [
    ...(configuration?.verification.required.map((definition) => ({
      definition,
      requirement: 'required' as const
    })) ?? []),
    ...(configuration?.verification.advisory.map((definition) => ({
      definition,
      requirement: 'advisory' as const
    })) ?? [])
  ];
  return Object.freeze({
    runId,
    checks: Object.freeze(
      configured.map(({ definition, requirement }): ConfiguredCheckResult => {
        const result = observed.get(definition.id);
        return result
          ? Object.freeze({
              id: result.id,
              requirement,
              coverage: definition.coverage,
              status: result.status,
              processStatus: result.processStatus,
              ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
              output: result.output,
              outputComplete: result.outputComplete
            })
          : Object.freeze({
              id: definition.id,
              requirement,
              coverage: definition.coverage,
              status: 'not_run'
            });
      })
    )
  });
}

export function createConfiguredCheckTool(input: {
  readonly required: readonly CodingAgentCheckConfiguration[];
  readonly advisory: readonly CodingAgentCheckConfiguration[];
  readonly commandExecution: CommandExecution;
}): CompiledToolDefinition {
  const checks = new Map<string, ConfiguredCheck>([
    ...input.required.map((definition) => [definition.id, { definition, requirement: 'required' as const }] as const),
    ...input.advisory.map((definition) => [definition.id, { definition, requirement: 'advisory' as const }] as const)
  ]);
  return defineTool({
    name: 'run_check',
    implementationId: 'coding-agent.configured-check@1',
    description: 'Run one explicitly configured workspace check and wait for its terminal process result.',
    promptGuide: `Available checks:\n${[...checks.values()]
      .map(({ definition, requirement }) =>
        `- ${definition.id} (${requirement}, ${definition.coverage}): ${definition.command}`
      )
      .join('\n')}`,
    schema: inputSchema,
    outputSchema,
    effectEnvelope: {
      accesses: [{ mode: 'execute', scope: 'workspace/checks' }],
      lockScopes: ['workspace']
    },
    canonicalizeInput(value) {
      const check = checks.get(value.id);
      if (!check) throw new Error(`Unknown configured check: ${value.id}`);
      return check;
    },
    snapshotInput(check) {
      return {
        id: check.definition.id,
        command: check.definition.command,
        requirement: check.requirement,
        coverage: check.definition.coverage
      };
    },
    deriveEffects() {
      return {
        accesses: [{ mode: 'execute', scope: 'workspace/checks' }],
        lockScopes: ['workspace'],
        recovery: { kind: 'unknown' }
      };
    },
    isAvailable: (policy) => isRiskAllowed(policy, 'execute'),
    async invoke(check, context) {
      const invocation = context.invocation;
      if (!invocation) throw new Error('Configured checks require a runtime invocation owner.');
      const owner: CommandExecutionOwner = Object.freeze({
        ownerId: context.resourceOwnerId ?? invocation.runId,
        runId: invocation.runId,
        turnId: invocation.turnId,
        toolBatchId: invocation.toolBatchId,
        callIndex: invocation.callIndex
      });
      const timeoutMs = check.definition.timeoutMs ?? 60_000;
      const reservation = await planCommandExecution(input.commandExecution, {
        command: check.definition.command,
        rootedDirectory: '.',
        pty: false,
        timeoutMs,
        yieldMs: Math.min(timeoutMs, 1_000),
        outputTokenBudget: 8_192,
        owner
      });
      try {
        let result = await startCommandExecutionPlan(input.commandExecution, reservation, {
          ...(context.signal ? { signal: context.signal } : {}),
          ...(context.resourceLease ? { lease: context.resourceLease } : {}),
          onProgress: (progress) => context.emitProgress?.(progress)
        });
        for (;;) {
          if (result.status !== 'running') return checkObservation(check, result, result.status);
          context.signal?.throwIfAborted();
          result = await input.commandExecution.query(result.processId, 8_192, 1_000, 0, owner);
        }
      } finally {
        await releaseCommandExecutionPlan(input.commandExecution, reservation);
      }
    }
  });
}

function checkObservation(
  check: ConfiguredCheck,
  result: CommandExecutionResult,
  processStatus: ConfiguredCheckProcessStatus
) {
  const outputComplete = result.combined.startsAtOutputStart && result.combined.endsAtOutputEnd;
  const status: 'passed' | 'failed' | 'inconclusive' =
    processStatus === 'exited' && result.exitCode === 0
      ? 'passed'
      : !outputComplete
        ? 'inconclusive'
        : 'failed';
  return {
    kind: 'result' as const,
    ok: true,
    summary: `Configured check ${check.definition.id} ${status}.`,
    scope: {
      resources: ['workspace', `workspace/checks/${check.definition.id}`],
      coverage: outputComplete ? ('complete' as const) : ('partial' as const),
      ...(outputComplete ? {} : { truncated: true, causes: ['incomplete_process_output'] })
    },
    output: {
      id: check.definition.id,
      status,
      processStatus,
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      output: result.combined.text,
      outputComplete
    }
  };
}

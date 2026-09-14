import {
  defineTool,
  defaultToolModelContent,
  isRiskAllowed,
  planCommandExecution,
  releaseCommandExecutionPlan,
  startCommandExecutionPlan,
  type CommandExecution,
  type CommandExecutionOwner,
  type CommandExecutionResult,
  type CompiledToolDefinition
} from '@agent-core/tools';
import { fileScope, processScope, type RootedFileAuthority } from '@agent-core/tools-local';
import type {
  ArtifactRepository,
  PublicArtifactRef,
  EventRepository,
  EventReference
} from '@agent-core/persistence';
import { resolveToolObservation, type AgentEvent } from '@agent-core/runtime';
import { createHash } from 'node:crypto';
import * as z from 'zod';
import type { CodingAgentCheckConfiguration, CodingAgentConfiguration } from '../configuration.js';
import {
  captureTestedState,
  checkApplicability,
  testedStateSchema,
  testedStateCaptureBudget,
  type TestedState,
  type CheckApplicability
} from './tested-state.js';

const definitionSchema = z
  .strictObject({
    id: z.string().min(1),
    command: z.string().min(1),
    timeoutMs: z.number().int().positive(),
    requirement: z.enum(['required', 'advisory']),
    coverage: z.enum(['targeted', 'full']),
    testedPaths: z.array(z.string()).max(256).readonly(),
    configurationIdentity: z.string().regex(/^[a-f0-9]{64}$/u),
    definitionIdentity: z.string().regex(/^[a-f0-9]{64}$/u)
  })
  .readonly();
const statusSchema = z.enum([
  'passed',
  'failed',
  'timed_out',
  'cancelled',
  'execution_failed',
  'unknown'
]);
const ownerSchema = z
  .strictObject({
    ownerId: z.string(),
    runId: z.string(),
    turnId: z.string(),
    toolBatchId: z.string(),
    callIndex: z.number().int().nonnegative()
  })
  .readonly();
export const configuredCheckObservationSchema = z
  .strictObject({
    definition: definitionSchema,
    status: statusSchema,
    processStatus: z.enum(['exited', 'stopped', 'timed_out', 'failed', 'unknown']),
    processId: z.string().optional(),
    owner: ownerSchema,
    executionIdentity: z.string().regex(/^[a-f0-9]{64}$/u),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().nullable().optional(),
    diagnostic: z.string().optional(),
    output: z.string(),
    outputComplete: z.boolean(),
    testedState: z.strictObject({ before: testedStateSchema, after: testedStateSchema }).readonly()
  })
  .readonly()
  .superRefine((value, context) => {
    if (value.status !== checkOutcome(value.processStatus, value.exitCode))
      context.addIssue({
        code: 'custom',
        message: 'Check outcome contradicts the recorded process result.'
      });
    const { definitionIdentity, ...definition } = value.definition;
    if (definitionIdentity !== digest(definition))
      context.addIssue({
        code: 'custom',
        message: 'Check definition identity does not match its recorded contents.'
      });
  });
type CheckDefinition = z.infer<typeof definitionSchema>;
type CheckObservation = z.infer<typeof configuredCheckObservationSchema>;
export interface ConfiguredCheckResult {
  readonly id: string;
  readonly definition: CheckDefinition;
  readonly requirement: 'required' | 'advisory';
  readonly coverage: 'targeted' | 'full';
  readonly status: CheckObservation['status'] | 'not_run';
  readonly applicability: CheckApplicability;
  readonly receipt?: EventReference;
  readonly observation?: CheckObservation;
  readonly processStatus?: CheckObservation['processStatus'];
  readonly exitCode?: number | null;
  readonly output?: string;
  readonly outputComplete?: boolean;
  readonly outputArtifacts?: readonly PublicArtifactRef[];
}
export interface CodingRunVerification {
  readonly runId: string;
  readonly checks: readonly ConfiguredCheckResult[];
  readonly history: {
    readonly complete: boolean;
    readonly omittedEarlierChecks: number;
    readonly nextSequence: number;
  };
}

interface RecordedCheck {
  readonly observation: CheckObservation;
  readonly receipt: EventReference;
  readonly outputArtifacts: readonly PublicArtifactRef[];
}
interface CheckIndex {
  sequence: number;
  omittedEarlierChecks: number;
  readonly observations: RecordedCheck[];
}
const indexes = new WeakMap<EventRepository<AgentEvent>, Map<string, CheckIndex>>();
const MAX_CACHED_RUNS = 32;
const MAX_RECORDED_CHECKS = 256;

const refreshQueues = new WeakMap<EventRepository<AgentEvent>, Map<string, Promise<unknown>>>();

export async function readConfiguredCheckResults(
  events: EventRepository<AgentEvent>,
  runId: string,
  configuration: Pick<CodingAgentConfiguration, 'verification'> | undefined,
  root?: RootedFileAuthority,
  artifacts?: ArtifactRepository
): Promise<CodingRunVerification> {
  let queues = refreshQueues.get(events);
  if (!queues) {
    queues = new Map();
    refreshQueues.set(events, queues);
  }
  const previous = queues.get(runId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => readCheckResults(events, runId, configuration, root, artifacts));
  queues.set(runId, next);
  try {
    return await next;
  } finally {
    if (queues.get(runId) === next) queues.delete(runId);
  }
}

async function readCheckResults(
  events: EventRepository<AgentEvent>,
  runId: string,
  configuration: Pick<CodingAgentConfiguration, 'verification'> | undefined,
  root?: RootedFileAuthority,
  artifacts?: ArtifactRepository
): Promise<CodingRunVerification> {
  let runs = indexes.get(events);
  if (!runs) {
    runs = new Map();
    indexes.set(events, runs);
  }
  let index = runs.get(runId);
  if (!index) {
    index = { sequence: -1, omittedEarlierChecks: 0, observations: [] };
    runs.set(runId, index);
  }
  if (runs.size > MAX_CACHED_RUNS) {
    const oldest = runs.keys().next().value;
    if (oldest !== undefined) runs.delete(oldest);
  }
  const tail = await events.tail(runId);
  if (index.sequence < tail.sequence) {
    const page = await events.readRange(runId, {
      afterSequence: index.sequence,
      through: tail,
      limit: 256,
      maxBytes: 8 * 1024 * 1024,
      types: ['tool.ended']
    });
    const additions: RecordedCheck[] = [];
    let sourceBytes = page.bytes;
    for (const envelope of page.records) {
      const event = envelope.event;
      if (
        event.type !== 'tool.ended' ||
        event.toolName !== 'run_check' ||
        event.observation.kind !== 'result'
      )
        continue;
      if (event.observation.storage === 'artifact') {
        sourceBytes += event.observation.artifact.size;
        if (sourceBytes > 8 * 1024 * 1024)
          throw new Error(
            `Run ${runId} configured-check original at event ${envelope.eventId} exceeds this bounded history page; read artifact ${event.observation.artifact.artifactId} using bounded source access.`
          );
      }
      const original = await resolveToolObservation(event.observation, artifacts);
      if (original.kind !== 'result') continue;
      const decoded = configuredCheckObservationSchema.safeParse(original.output);
      if (!decoded.success)
        throw new Error(
          `Run ${runId} contains an incompatible configured-check record; inspect its original event. ${decoded.error.message}`
        );
      if (
        decoded.data.owner.runId !== runId ||
        decoded.data.owner.turnId !== event.turnId ||
        decoded.data.owner.toolBatchId !== event.toolBatchId ||
        decoded.data.owner.callIndex !== event.callIndex
      )
        throw new Error(`Run ${runId} contains a configured-check invocation identity mismatch.`);
      additions.push(
        Object.freeze({
          observation: decoded.data,
          outputArtifacts: Object.freeze(
            (original.content ?? []).flatMap((item) =>
              item.type === 'artifact' ? [item.artifact] : []
            )
          ),
          receipt: Object.freeze({
            runId,
            eventId: envelope.eventId,
            sequence: envelope.sequence,
            hash: envelope.hash
          })
        })
      );
    }
    if (page.oversized)
      throw new Error(
        `Run ${runId} has an oversized check source at sequence ${String(page.oversized.reference.sequence)}; inspect the original event with bounded source access.`
      );
    if (page.nextSequence <= index.sequence && !page.complete)
      throw new Error('Configured-check index made no progress.');
    index.observations.push(...additions);
    const excess = Math.max(0, index.observations.length - MAX_RECORDED_CHECKS);
    index.observations.splice(0, excess);
    index.omittedEarlierChecks += excess;
    index.sequence = page.nextSequence;
  }
  const checks: ConfiguredCheckResult[] = [];
  const captureBudget = testedStateCaptureBudget();
  const currentScopes = new Map<string, TestedState>();
  for (const { observation, receipt, outputArtifacts } of index.observations) {
    const scopeKey = JSON.stringify(observation.definition.testedPaths);
    let current = currentScopes.get(scopeKey);
    if (root && !current) {
      current = await captureTestedState(root, observation.definition.testedPaths, captureBudget);
      currentScopes.set(scopeKey, current);
    }
    checks.push(
      Object.freeze({
        id: observation.definition.id,
        definition: observation.definition,
        requirement: observation.definition.requirement,
        coverage: observation.definition.coverage,
        status: observation.status,
        applicability: checkApplicability(
          observation.testedState.before,
          observation.testedState.after,
          current
        ),
        receipt,
        observation,
        outputArtifacts,
        processStatus: observation.processStatus,
        ...(observation.exitCode === undefined ? {} : { exitCode: observation.exitCode }),
        output: observation.output,
        outputComplete: observation.outputComplete
      })
    );
  }
  for (const definition of index.sequence >= tail.sequence && index.omittedEarlierChecks === 0
    ? configuredDefinitions(
        configuration?.verification.required ?? [],
        configuration?.verification.advisory ?? []
      )
    : []) {
    if (
      !checks.some((check) => check.definition.definitionIdentity === definition.definitionIdentity)
    )
      checks.push(
        Object.freeze({
          id: definition.id,
          definition,
          requirement: definition.requirement,
          coverage: definition.coverage,
          status: 'not_run',
          applicability: Object.freeze({
            status: 'unknown',
            reasons: Object.freeze(['definition_not_run'])
          })
        })
      );
  }
  return Object.freeze({
    runId,
    checks: Object.freeze(checks),
    history: Object.freeze({
      complete: index.sequence >= tail.sequence && index.omittedEarlierChecks === 0,
      omittedEarlierChecks: index.omittedEarlierChecks,
      nextSequence: index.sequence
    })
  });
}

export function createConfiguredCheckTool(input: {
  readonly required: readonly CodingAgentCheckConfiguration[];
  readonly advisory: readonly CodingAgentCheckConfiguration[];
  readonly commandExecution: CommandExecution;
  readonly root: RootedFileAuthority;
}): CompiledToolDefinition {
  const checks = new Map(
    configuredDefinitions(input.required, input.advisory).map((definition) => [
      definition.id,
      definition
    ])
  );
  const inputSchema = z.strictObject({ id: z.string().min(1) });
  return defineTool<
    typeof inputSchema,
    { readonly definition: CheckDefinition; readonly owner: CommandExecutionOwner },
    CheckObservation
  >({
    name: 'run_check',
    implementationId: 'coding-agent.configured-check@1',
    description:
      'Run an explicitly configured check. Its observed outcome is historical; applicability to current files is reported separately.',
    promptGuide: `Available checks:\n${[...checks.values()].map((check) => `- ${check.id} (${check.requirement}, ${check.coverage}, timeout ${String(check.timeoutMs)}ms): ${check.command}`).join('\n')}`,
    schema: inputSchema,
    outputSchema: configuredCheckObservationSchema,
    buildModelContent({ observation }) {
      if (observation.kind !== 'result') return defaultToolModelContent(observation);
      const result = observation.output;
      const applicability = checkApplicability(result.testedState.before, result.testedState.after);
      return [
        {
          type: 'text',
          text: [
            `Check ${result.definition.id}: ${result.status}; process ${result.processStatus}${result.exitCode === undefined ? '' : `, exit ${String(result.exitCode)}`}.`,
            ...(result.processId ? [`Process handle: ${result.processId}.`] : []),
            ...(result.diagnostic ? [`Execution diagnostic: ${result.diagnostic}`] : []),
            `Command: ${result.definition.command}\nTimeout: ${String(result.definition.timeoutMs)}ms; ${result.definition.requirement}; declared coverage: ${result.definition.coverage}.`,
            `Applicability: ${applicability.status}: ${applicability.reasons.join(', ')}.`,
            `Observed files: ${result.definition.testedPaths.join(', ') || 'no declared files'}; before ${result.testedState.before.completeness}, after ${result.testedState.after.completeness}.`,
            `Output ${result.outputComplete ? 'complete' : 'incomplete'}:\n${result.output}`
          ].join('\n')
        },
        ...(observation.content ?? [])
      ];
    },
    effectEnvelope: {
      accesses: [{ mode: 'execute', scope: processScope() }],
      lockScopes: [fileScope(), processScope()]
    },
    canonicalizeInput(value, context) {
      const definition = checks.get(value.id);
      if (!definition) throw new Error(`Unknown configured check: ${value.id}`);
      const invocation = context.invocation;
      if (!invocation) throw new Error('Configured checks require a runtime invocation owner.');
      const owner: CommandExecutionOwner = Object.freeze({
        ownerId: context.resourceOwnerId ?? invocation.runId,
        runId: invocation.runId,
        turnId: invocation.turnId,
        toolBatchId: invocation.toolBatchId,
        callIndex: invocation.callIndex
      });
      return Object.freeze({ definition, owner });
    },
    snapshotInput(check) {
      return { ...check.definition, workdir: '.' };
    },
    deriveEffects() {
      return {
        accesses: [{ mode: 'execute' as const, scope: processScope() }],
        lockScopes: [fileScope(), processScope()],
        recovery: { kind: 'unknown' as const }
      };
    },
    isAvailable: (policy) => isRiskAllowed(policy, 'execute'),
    async bindExecution(check, context) {
      const reservation = await planCommandExecution(input.commandExecution, {
        command: check.definition.command,
        rootedDirectory: '.',
        pty: false,
        timeoutMs: check.definition.timeoutMs,
        yieldMs: Math.min(check.definition.timeoutMs, 1000),
        outputTokenBudget: 8192,
        owner: check.owner
      });
      await context.lifetime.own({
        release: () => releaseCommandExecutionPlan(input.commandExecution, reservation)
      });
      return {
        snapshot: { ...check.definition, workdir: '.', execution: reservation.authorization },
        async invoke(executionContext) {
          const before = await captureTestedState(input.root, check.definition.testedPaths);
          let result: CommandExecutionResult | undefined;
          let executionError: string | undefined;
          try {
            result = await startCommandExecutionPlan(input.commandExecution, reservation, {
              ...(executionContext.signal ? { signal: executionContext.signal } : {}),
              ...(executionContext.resourceLease ? { lease: executionContext.resourceLease } : {}),
              onProgress: (progress) => executionContext.emitProgress?.(progress)
            });
            while (result.status === 'running') {
              if (executionContext.signal?.aborted)
                result = await input.commandExecution.terminate(result.processId, check.owner);
              else
                result = await input.commandExecution.query(
                  result.processId,
                  8192,
                  1000,
                  0,
                  check.owner
                );
            }
          } catch (error) {
            executionError = error instanceof Error ? error.message : String(error);
          }
          const after = await captureTestedState(input.root, check.definition.testedPaths);
          const outputComplete =
            executionError === undefined &&
            result !== undefined &&
            result.combined.startsAtOutputStart &&
            result.combined.endsAtOutputEnd &&
            result.combined.omittedBytes === 0;
          const processStatus =
            executionError !== undefined || !result || result.status === 'running'
              ? ('unknown' as const)
              : result.status;
          const status = checkOutcome(processStatus, result?.exitCode);
          return {
            kind: 'result' as const,
            execution: {
              state: processStatus === 'unknown' ? ('unknown' as const) : ('settled' as const)
            },
            summary: `Configured check ${check.definition.id} ${status}.`,
            scope: {
              resources: [fileScope(), processScope(result?.processId ?? '')],
              coverage: outputComplete ? ('complete' as const) : ('partial' as const),
              ...(outputComplete ? {} : { truncated: true, causes: ['incomplete_process_output'] })
            },
            ...(result?.artifact
              ? { content: [{ type: 'artifact' as const, artifact: result.artifact }] }
              : {}),
            output: {
              definition: check.definition,
              status,
              processStatus,
              ...(result ? { processId: result.processId } : {}),
              owner: check.owner,
              executionIdentity: digest(reservation.authorization),
              ...(result?.exitCode === undefined ? {} : { exitCode: result.exitCode }),
              ...(result?.signal === undefined ? {} : { signal: result.signal }),
              ...((executionError ?? result?.diagnostic) === undefined
                ? {}
                : { diagnostic: executionError ?? result?.diagnostic }),
              output: result?.combined.text ?? '',
              outputComplete,
              testedState: { before, after }
            }
          };
        }
      };
    }
  });
}

function configuredDefinitions(
  required: readonly CodingAgentCheckConfiguration[],
  advisory: readonly CodingAgentCheckConfiguration[]
): readonly CheckDefinition[] {
  const configurationIdentity = digest({ required, advisory });
  return Object.freeze(
    [
      ...required.map((check) => ({ check, requirement: 'required' as const })),
      ...advisory.map((check) => ({ check, requirement: 'advisory' as const }))
    ].map(({ check, requirement }) => {
      const definition = {
        id: check.id,
        command: check.command,
        timeoutMs: check.timeoutMs ?? 60000,
        requirement,
        coverage: check.coverage,
        testedPaths: Object.freeze([...(check.testedPaths ?? [])]),
        configurationIdentity
      };
      return Object.freeze({ ...definition, definitionIdentity: digest(definition) });
    })
  );
}
function checkOutcome(
  status: CheckObservation['processStatus'],
  exitCode?: number | null
): CheckObservation['status'] {
  if (status === 'unknown') return 'unknown';
  if (status === 'timed_out') return 'timed_out';
  if (status === 'stopped') return 'cancelled';
  if (status === 'failed') return 'execution_failed';
  return exitCode === 0 ? 'passed' : typeof exitCode === 'number' ? 'failed' : 'unknown';
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

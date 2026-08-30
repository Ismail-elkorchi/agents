import * as z from 'zod';
import { canonicalSha256, contentId, nowTimestamp } from './canonical.js';
import { WRITING_EVALUATION_TASKS, WRITING_EVALUATION_COVERAGE } from './evaluation-corpus.js';

export const writingEvaluationSetSchema = z.enum(['development', 'regression', 'holdout', 'adversarial', 'human-audit']);

export const writingEvaluationTaskSchema = z.strictObject({
  taskId: z.string().trim().min(1).max(256),
  taskVersion: z.int().min(1),
  set: writingEvaluationSetSchema,
  title: z.string().trim().min(1).max(1_000),
  coverage: z.array(z.string().trim().min(1).max(256)).min(1),
  instructions: z.string().trim().min(1).max(100_000),
  fixture: z.record(z.string(), z.json()),
  expectedBehaviors: z.array(z.string().trim().min(1).max(10_000)).min(1),
  graders: z.array(z.strictObject({
    graderId: z.string().trim().min(1).max(256),
    kind: z.enum(['deterministic', 'model-assisted', 'human-audit']),
    implementationId: z.string().trim().min(1).max(512),
    verificationPolicyId: z.string().trim().min(1).max(512),
    calibrationId: z.string().trim().min(1).max(512).optional(),
    requirement: z.enum(['required', 'advisory'])
  })).min(1)
});

export const humanAuditProtocolSchema = z.strictObject({
  protocolId: z.string().trim().min(1).max(256),
  version: z.int().min(1),
  samplingFrame: z.string().trim().min(1).max(100_000),
  taskSelection: z.string().trim().min(1).max(100_000),
  inclusionRules: z.array(z.string().trim().min(1).max(10_000)),
  exclusionRules: z.array(z.string().trim().min(1).max(10_000)),
  sampleSize: z.int().min(1),
  raterPopulation: z.string().trim().min(1).max(100_000),
  expertise: z.string().trim().min(1).max(100_000),
  recruitment: z.string().trim().min(1).max(100_000),
  compensation: z.string().trim().min(1).max(100_000),
  conflictsOfInterest: z.string().trim().min(1).max(100_000),
  instructions: z.string().trim().min(1).max(100_000),
  criteria: z.array(z.string().trim().min(1).max(10_000)).min(1),
  rubric: z.string().trim().min(1).max(100_000),
  examples: z.array(z.string().max(100_000)),
  interfaceDescription: z.string().trim().min(1).max(100_000),
  sourceVisibility: z.string().trim().min(1).max(100_000),
  assignment: z.string().trim().min(1).max(100_000),
  ordering: z.string().trim().min(1).max(100_000),
  randomization: z.string().trim().min(1).max(100_000),
  blinding: z.string().trim().min(1).max(100_000),
  ratingsPerItem: z.int().min(1),
  missingRatingTreatment: z.string().trim().min(1).max(100_000),
  disagreementHandling: z.string().trim().min(1).max(100_000),
  agreementMeasure: z.string().trim().min(1).max(100_000),
  adjudication: z.string().trim().min(1).max(100_000),
  aggregationPlan: z.string().trim().min(1).max(100_000),
  statisticalAnalysis: z.string().trim().min(1).max(100_000),
  uncertaintyReporting: z.string().trim().min(1).max(100_000),
  protocolDeviations: z.array(z.strictObject({ deviation: z.string().trim().min(1).max(100_000), disposition: z.string().trim().min(1).max(100_000) })),
  assistanceDisclosure: z.string().trim().min(1).max(100_000),
  personalDataPolicy: z.string().trim().min(1).max(100_000)
});

const bindingsSchema = z.strictObject({
  productId: z.string(), promptId: z.string(), policyId: z.string(), intentRegistryImplementationId: z.string(),
  contextPolicyId: z.string(), toolImplementationIds: z.array(z.string()), checkImplementationIds: z.array(z.string()),
  verifierImplementationIds: z.array(z.string()), calibrationIds: z.array(z.string()), dispositionImplementationId: z.string(),
  providerId: z.string(), providerImplementationId: z.string(), modelId: z.string()
});

const identityBindingsSchema = z.strictObject({
  baseProjectRevisionId: z.string(), briefRevisionId: z.string(), operationId: z.string(), contextReceiptId: z.string(),
  proposalId: z.string().optional(), sourceIds: z.array(z.string()), evidenceRelationIds: z.array(z.string()), resultingRevisionId: z.string().optional()
});

export const evaluationTrialRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  trialId: z.string(),
  taskSetId: z.string(),
  taskSetVersion: z.int().min(1),
  taskId: z.string(),
  taskVersion: z.int().min(1),
  set: writingEvaluationSetSchema,
  trialIndex: z.int().min(1),
  seed: z.string(),
  nondeterminismControls: z.record(z.string(), z.json()),
  bindings: bindingsSchema,
  identities: identityBindingsSchema,
  firstAttempt: z.boolean(),
  startedAt: z.iso.datetime(),
  humanAuditProtocol: humanAuditProtocolSchema.optional()
}).superRefine((value, context) => {
  if (value.firstAttempt !== (value.trialIndex === 1)) context.addIssue({ code: 'custom', message: 'firstAttempt must exactly reflect trialIndex.' });
  if (value.set === 'human-audit' && value.humanAuditProtocol === undefined) context.addIssue({ code: 'custom', message: 'Human-audit trials require a complete human-audit protocol.' });
  if (value.set !== 'human-audit' && value.humanAuditProtocol !== undefined) context.addIssue({ code: 'custom', message: 'Human-audit protocol is valid only for human-audit trials.' });
});

export type WritingEvaluationTask = z.infer<typeof writingEvaluationTaskSchema>;
export type HumanAuditProtocol = z.infer<typeof humanAuditProtocolSchema>;
export type EvaluationTrialRecord = z.infer<typeof evaluationTrialRecordSchema>;

export const WRITING_EVALUATION_TASK_SET_ID = 'writing-agent/evaluation-corpus';
export const WRITING_EVALUATION_TASK_SET_VERSION = 1;
export const WRITING_REGRESSION_LOCK_SHA256 = '081599c71b45b51199eb0687c073926a3483561addbe65848e54375cd0e45a92';

export function writingEvaluationTasks(set?: z.infer<typeof writingEvaluationSetSchema>): readonly WritingEvaluationTask[] {
  const tasks = WRITING_EVALUATION_TASKS.map((task) => writingEvaluationTaskSchema.parse(task));
  return Object.freeze(set === undefined ? tasks : tasks.filter((task) => task.set === set));
}

export function writingRegressionCorpusSha256(): string {
  return canonicalSha256(writingEvaluationTasks('regression'));
}

export function validateWritingEvaluationCorpus(): void {
  const tasks = writingEvaluationTasks();
  const identities = new Set<string>();
  for (const task of tasks) {
    const identity = `${task.taskId}@${String(task.taskVersion)}`;
    if (identities.has(identity)) throw new Error(`Duplicate writing evaluation task identity: ${identity}`);
    identities.add(identity);
  }
  const discoveredCoverage = new Set(tasks.flatMap((task) => task.coverage));
  const missing = WRITING_EVALUATION_COVERAGE.filter((coverage) => !discoveredCoverage.has(coverage));
  if (missing.length > 0) throw new Error(`Writing evaluation corpus lacks required coverage: ${missing.join(', ')}.`);
  if (writingEvaluationTasks('regression').length === 0) throw new Error('Writing regression task set must remain distinct and non-empty.');
}

export function assertWritingRegressionLock(): void {
  const actual = writingRegressionCorpusSha256();
  if (actual !== WRITING_REGRESSION_LOCK_SHA256) throw new Error(`Writing regression corpus changed without an explicit lock review: expected ${WRITING_REGRESSION_LOCK_SHA256}, found ${actual}.`);
}

export function createEvaluationTrialRecord(input: Omit<z.input<typeof evaluationTrialRecordSchema>, 'schemaVersion' | 'trialId' | 'startedAt'> & { readonly clock?: () => Date }): EvaluationTrialRecord {
  const { clock, ...recordInput } = input;
  return evaluationTrialRecordSchema.parse({
    ...recordInput,
    schemaVersion: 1,
    trialId: contentId('evaluation-trial', recordInput),
    startedAt: nowTimestamp(clock)
  });
}

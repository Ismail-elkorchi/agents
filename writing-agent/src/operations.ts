import { contentId, deepFreeze, nowTimestamp } from './canonical.js';
import {
  writingIntentSchema,
  writingOperationKindSchema,
  writingOperationModeSchema,
  writingOperationSchema,
  type ProjectSnapshot,
  type WritingIntent,
  type WritingOperation,
  type WritingOperationKind,
  type WritingOperationMode
} from './domain.js';

export const WRITING_INTENT_SCHEMA_ID = 'writing-agent/intents';
export const WRITING_INTENT_SCHEMA_VERSION = 1;
export const WRITING_INTENT_REGISTRY_IMPLEMENTATION_ID = 'writing-agent.intent-registry@1';

const intentKinds = Object.freeze({
  'structure.create': ['plan', 'revise'],
  'structure.remove': ['plan', 'revise'],
  'structure.reorder': ['plan', 'revise'],
  'structure.split': ['plan', 'revise'],
  'structure.merge': ['plan', 'revise'],
  'structure.purpose': ['plan', 'revise'],
  'structure.relation': ['plan', 'revise'],
  'text.draft': ['draft', 'continue'],
  'text.continue': ['continue', 'draft'],
  'text.revise': ['revise'],
  'text.transform': ['transform', 'revise'],
  'text.translate': ['translate', 'revise'],
  'review.editorial': ['review', 'plan', 'draft', 'continue', 'revise', 'transform', 'translate']
} satisfies Record<string, readonly WritingOperationKind[]>);

export type WritingIntentKind = keyof typeof intentKinds;

export interface WritingOperationAdmissionInput {
  readonly projectId: string;
  readonly briefRevisionId: string;
  readonly kind: WritingOperationKind;
  readonly instruction: string;
  readonly intents: readonly WritingIntent[];
  readonly baseProjectRevisionId: string;
  readonly mode: WritingOperationMode;
  readonly sessionId: string;
  readonly runId: string;
  readonly snapshot: WritingOperation['snapshot'];
}

export function admitWritingOperation(input: WritingOperationAdmissionInput, control: {
  readonly channel: 'direct-user' | 'untrusted-data';
  readonly project: ProjectSnapshot;
  readonly clock?: () => Date;
}): WritingOperation {
  if (control.channel !== 'direct-user') throw new Error('Writing operations may be admitted only from the direct user-control channel.');
  const kind = writingOperationKindSchema.parse(input.kind);
  const mode = writingOperationModeSchema.parse(input.mode);
  if (input.projectId !== control.project.brief.projectId) throw new Error('Writing operation project identity does not match the trusted project.');
  if (input.briefRevisionId !== control.project.brief.briefRevisionId) throw new Error('Writing operation targets a stale brief revision.');
  if (input.baseProjectRevisionId !== control.project.revision.revisionId) throw new Error('Writing operation targets a stale project revision.');
  const intents = input.intents.map((intent) => writingIntentSchema.parse(intent));
  validateIntentGraph(intents, kind, control.project);
  const targetNodeIds = uniqueSorted(intents.flatMap((intent) => intent.targetNodeIds));
  const targetResourceIds = uniqueSorted(intents.flatMap((intent) => intent.targetResourceIds));
  const instruction = input.instruction.trim();
  if (instruction.length === 0) throw new Error('Writing operation instruction must not be empty.');
  const admittedAt = nowTimestamp(control.clock);
  const material = {
    projectId: input.projectId,
    briefRevisionId: input.briefRevisionId,
    kind,
    instruction,
    intents,
    targetNodeIds,
    targetResourceIds,
    baseProjectRevisionId: input.baseProjectRevisionId,
    mode,
    sessionId: input.sessionId,
    runId: input.runId,
    lifecycleState: 'admitted' as const,
    snapshot: input.snapshot,
    admittedAt
  };
  return deepFreeze(writingOperationSchema.parse({ operationId: contentId('operation', material), ...material }));
}

export function validateIntentGraph(intents: readonly WritingIntent[], operationKind: WritingOperationKind, project: ProjectSnapshot): void {
  if (intents.length === 0) throw new Error('A writing operation requires at least one structured intent.');
  const ids = intents.map((intent) => intent.intentId);
  if (new Set(ids).size !== ids.length) throw new Error('Writing intent IDs must be unique within an operation.');
  const nodeIds = new Set(project.nodes.filter((node) => node.status !== 'removed').map((node) => node.nodeId));
  const resourceIds = new Set(project.resources.map((resource) => resource.resourceId));
  const rangeIds = new Set(project.resources.flatMap((resource) => resource.protectedRanges.map((range) => range.rangeId)));
  const criterionIds = new Set(project.brief.acceptanceCriteria.map((criterion) => criterion.criterionId));
  const claimIds = new Set(project.claims.map((claim) => claim.claimId));
  const relationIds = new Set([...project.relations.map((relation) => relation.relationId), ...project.evidenceRelations.map((relation) => relation.relationId)]);
  const decisionIds = new Set(project.editorialDecisions.map((decision) => decision.decisionId));
  let primaryConcern = false;
  for (const [index, intent] of intents.entries()) {
    if (intent.schemaId !== WRITING_INTENT_SCHEMA_ID || intent.schemaVersion !== WRITING_INTENT_SCHEMA_VERSION) {
      throw new Error(`Unsupported writing intent schema: ${intent.schemaId}@${String(intent.schemaVersion)}`);
    }
    if (!isWritingIntentKind(intent.kind)) throw new Error(`Unknown writing intent kind: ${intent.kind}`);
    if (new Set<WritingOperationKind>(intentKinds[intent.kind]).has(operationKind)) primaryConcern = true;
    for (const dependency of intent.dependencies) {
      const dependencyIndex = ids.indexOf(dependency);
      if (dependencyIndex < 0) throw new Error(`Writing intent ${intent.intentId} depends on an unknown intent: ${dependency}`);
      if (dependencyIndex >= index) throw new Error(`Writing intent ${intent.intentId} may depend only on an earlier intent: ${dependency}`);
    }
    for (const nodeId of intent.targetNodeIds) if (!nodeIds.has(nodeId) && intent.kind !== 'structure.create') throw new Error(`Writing intent targets an unknown node: ${nodeId}`);
    for (const resourceId of intent.targetResourceIds) if (!resourceIds.has(resourceId)) throw new Error(`Writing intent targets an unknown resource: ${resourceId}`);
    for (const rangeId of intent.targetRangeIds) if (!rangeIds.has(rangeId)) throw new Error(`Writing intent targets an unknown exact range: ${rangeId}`);
    for (const criterionId of intent.affectedCriterionIds) if (!criterionIds.has(criterionId)) throw new Error(`Writing intent affects an unknown criterion: ${criterionId}`);
    for (const claimId of intent.affectedClaimIds) if (!claimIds.has(claimId)) throw new Error(`Writing intent affects an unknown claim: ${claimId}`);
    for (const relationId of intent.affectedRelationIds) if (!relationIds.has(relationId)) throw new Error(`Writing intent affects an unknown relation: ${relationId}`);
    for (const decisionId of intent.affectedEditorialDecisionIds) if (!decisionIds.has(decisionId)) throw new Error(`Writing intent affects an unknown editorial decision: ${decisionId}`);
  }
  if (!primaryConcern) throw new Error(`Writing operation ${operationKind} has no intent registered for its primary lifecycle concern.`);
  rejectUnsupportedCombinations(intents);
}

export function createSingleIntent(input: {
  readonly intentId: string;
  readonly kind: WritingIntentKind;
  readonly instruction: string;
  readonly targetNodeIds?: readonly string[];
  readonly targetResourceIds?: readonly string[];
  readonly targetRangeIds?: readonly string[];
  readonly preservationRequirements?: WritingIntent['preservationRequirements'];
}): WritingIntent {
  return writingIntentSchema.parse({
    intentId: input.intentId,
    schemaId: WRITING_INTENT_SCHEMA_ID,
    schemaVersion: WRITING_INTENT_SCHEMA_VERSION,
    kind: input.kind,
    instruction: input.instruction,
    targetNodeIds: input.targetNodeIds ?? [],
    targetResourceIds: input.targetResourceIds ?? [],
    targetRangeIds: input.targetRangeIds ?? [],
    dependencies: [],
    affectedCriterionIds: [],
    affectedClaimIds: [],
    affectedRelationIds: [],
    affectedEditorialDecisionIds: [],
    preservationRequirements: input.preservationRequirements ?? []
  });
}

function rejectUnsupportedCombinations(intents: readonly WritingIntent[]): void {
  const removals = new Set(intents.filter((intent) => intent.kind === 'structure.remove').flatMap((intent) => intent.targetNodeIds));
  for (const intent of intents) {
    if (!intent.kind.startsWith('text.')) continue;
    const conflict = intent.targetNodeIds.find((nodeId) => removals.has(nodeId));
    if (conflict !== undefined) throw new Error(`Unsupported intent combination changes text in node scheduled for removal: ${conflict}`);
  }
  const structuralCreates = new Set(intents.filter((intent) => intent.kind === 'structure.create').flatMap((intent) => intent.targetNodeIds));
  for (const intent of intents) {
    for (const target of intent.targetNodeIds) {
      if (structuralCreates.has(target) && intent.kind !== 'structure.create' && !intent.dependencies.some((dependency) => intents.find((candidate) => candidate.intentId === dependency)?.kind === 'structure.create')) {
        throw new Error(`Intent ${intent.intentId} targets newly created node ${target} without depending on its creation.`);
      }
    }
  }
}

function isWritingIntentKind(value: string): value is WritingIntentKind {
  return Object.hasOwn(intentKinds, value);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

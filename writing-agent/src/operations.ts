import { canonicalSha256, contentId, deepFreeze, nowTimestamp } from './canonical.js';
import {
  writingIntentSchema,
  writingOperationKindSchema,
  writingOperationModeSchema,
  writingOperationSchema,
  effectiveConstraintSetSchema,
  type EffectiveConstraintSet,
  type ExactConstraint,
  type ProjectSnapshot,
  type WritingIntent,
  type WritingOperation,
  type WritingOperationKind,
  type WritingOperationMode
} from './domain.js';
import { createWritingOperationContract } from './operation-contract.js';

export const WRITING_INTENT_SCHEMA_ID = 'writing-agent/intents';
export const WRITING_INTENT_SCHEMA_VERSION = 2;
export const WRITING_INTENT_REGISTRY_IMPLEMENTATION_ID = 'writing-agent.intent-registry@2';

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
  readonly applyAuthorization?: WritingOperation['applyAuthorization'];
  readonly sessionId: string;
  readonly runId: string;
  readonly executionBinding: WritingOperation['executionBinding'];
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
  const effectiveConstraints = compileEffectiveConstraints(control.project, intents);
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
    effectiveConstraints,
    baseProjectRevisionId: input.baseProjectRevisionId,
    mode,
    ...(input.applyAuthorization === undefined ? {} : { applyAuthorization: input.applyAuthorization }),
    sessionId: input.sessionId,
    runId: input.runId,
    lifecycleState: 'admitted' as const,
    executionBinding: input.executionBinding,
    admittedAt
  };
  const operation = deepFreeze(writingOperationSchema.parse({ operationId: contentId('operation', material), ...material }));
  createWritingOperationContract(operation, control.project);
  return operation;
}

export function validateIntentGraph(intents: readonly WritingIntent[], operationKind: WritingOperationKind, project: ProjectSnapshot): void {
  if (intents.length === 0) throw new Error('A writing operation requires at least one structured intent.');
  const ids = intents.map((intent) => intent.intentId);
  if (new Set(ids).size !== ids.length) throw new Error('Writing intent IDs must be unique within an operation.');
  const nodeIds = new Set(project.nodes.filter((node) => node.status !== 'removed').map((node) => node.nodeId));
  const resourceIds = new Set(project.resources.map((resource) => resource.resourceId));
  const rangeOwners = new Map(project.resources.flatMap((resource) => resource.protectedRanges.map((range) => [range.rangeId, resource.resourceId] as const)));
  const criterionKinds = new Map(project.brief.acceptanceCriteria.map((criterion) => [criterion.criterionId, criterion.verificationKind] as const));
  const claimIds = new Set(project.claims.map((claim) => claim.claimId));
  const relationIds = new Set([...project.relations.map((relation) => relation.relationId), ...project.evidenceRelations.map((relation) => relation.relationId)]);
  const decisionIds = new Set(project.editorialDecisions.map((decision) => decision.decisionId));
  const declaredConstraintIds = new Set(project.brief.lengthConstraints.map((constraint) => constraint.constraintId));
  for (const constraint of project.brief.exactConstraints) {
    if (declaredConstraintIds.has(constraint.constraintId)) throw new Error(`Writing brief constraint IDs must be unique: ${constraint.constraintId}`);
    declaredConstraintIds.add(constraint.constraintId);
  }
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
    for (const rangeId of intent.targetRangeIds) {
      const owner = rangeOwners.get(rangeId);
      if (owner === undefined) throw new Error(`Writing intent targets an unknown exact range: ${rangeId}`);
      if (!intent.targetResourceIds.includes(owner)) throw new Error(`Writing intent exact range is outside its admitted resource targets: ${rangeId}/${owner}`);
    }
    for (const criterionId of intent.affectedCriterionIds) if (!criterionKinds.has(criterionId)) throw new Error(`Writing intent affects an unknown criterion: ${criterionId}`);
    for (const claimId of intent.affectedClaimIds) if (!claimIds.has(claimId)) throw new Error(`Writing intent affects an unknown claim: ${claimId}`);
    for (const relationId of intent.affectedRelationIds) if (!relationIds.has(relationId)) throw new Error(`Writing intent affects an unknown relation: ${relationId}`);
    for (const decisionId of intent.affectedEditorialDecisionIds) if (!decisionIds.has(decisionId)) throw new Error(`Writing intent affects an unknown editorial decision: ${decisionId}`);
    for (const constraint of [...intent.lengthConstraints, ...intent.exactConstraints]) {
      if (declaredConstraintIds.has(constraint.constraintId)) throw new Error(`Writing operation constraint IDs must be unique: ${constraint.constraintId}`);
      declaredConstraintIds.add(constraint.constraintId);
      for (const criterionId of constraint.criterionIds) {
        const kind = criterionKinds.get(criterionId);
        if (kind === undefined) throw new Error(`Writing operation constraint references an unknown criterion: ${criterionId}`);
        if (kind !== 'deterministic') throw new Error(`Writing operation machine constraint requires a deterministic criterion: ${criterionId}`);
      }
    }
    if ((intent.lengthConstraints.length > 0 || intent.exactConstraints.length > 0) && intent.targetResourceIds.length === 0) {
      throw new Error(`Writing intent ${intent.intentId} has text constraints without an exact resource target.`);
    }
    if ((intent.kind.startsWith('text.') || intent.kind === 'review.editorial') && intent.targetResourceIds.length === 0) {
      throw new Error(`Writing intent ${intent.intentId} requires at least one exact resource target.`);
    }
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
  readonly lengthConstraints?: WritingIntent['lengthConstraints'];
  readonly exactConstraints?: WritingIntent['exactConstraints'];
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
    preservationRequirements: input.preservationRequirements ?? [],
    lengthConstraints: input.lengthConstraints ?? [],
    exactConstraints: input.exactConstraints ?? []
  });
}

export function compileEffectiveConstraints(project: ProjectSnapshot, intents: readonly WritingIntent[]): EffectiveConstraintSet {
  const operationTargets = uniqueSorted(intents.flatMap((intent) => intent.targetResourceIds));
  const lengths = [
    ...project.brief.lengthConstraints.flatMap((constraint) => operationTargets.length === 0 ? [] : [{ constraint, targetResourceIds: operationTargets }]),
    ...intents.flatMap((intent) => {
      const targetResourceIds = uniqueSorted(intent.targetResourceIds);
      return targetResourceIds.length === 0 ? [] : intent.lengthConstraints.map((constraint) => ({ constraint, targetResourceIds }));
    })
  ];
  const groups = new Map<string, typeof lengths>();
  for (const scoped of lengths) {
    const key = canonicalSha256({ unit: scoped.constraint.unit, targetResourceIds: scoped.targetResourceIds });
    groups.set(key, [...(groups.get(key) ?? []), scoped]);
  }
  const lengthConstraints = [...groups.values()].map((selected) => {
    const unit = selected[0]?.constraint.unit;
    const targetResourceIds = selected[0]?.targetResourceIds;
    if (unit === undefined || targetResourceIds === undefined) throw new Error('Effective length constraint group is empty.');
    const constraints = selected.map((item) => item.constraint);
    const minima = constraints.flatMap((constraint) => constraint.minimum === undefined ? [] : [constraint.minimum]);
    const maxima = constraints.flatMap((constraint) => constraint.maximum === undefined ? [] : [constraint.maximum]);
    const minimum = minima.length === 0 ? undefined : Math.max(...minima);
    const maximum = maxima.length === 0 ? undefined : Math.min(...maxima);
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      throw new Error(`Writing operation ${unit} constraints do not intersect: minimum ${String(minimum)} exceeds maximum ${String(maximum)}.`);
    }
    const sourceConstraintIds = uniqueSorted(constraints.map((constraint) => constraint.constraintId));
    return {
      constraintId: contentId('effective-length-constraint', { unit, sourceConstraintIds, targetResourceIds, minimum: minimum ?? null, maximum: maximum ?? null }),
      unit,
      ...(minimum === undefined ? {} : { minimum }),
      ...(maximum === undefined ? {} : { maximum }),
      requirement: constraints.some((constraint) => constraint.requirement === 'required') ? 'required' as const : 'advisory' as const,
      criterionIds: uniqueSorted(constraints.flatMap((constraint) => constraint.criterionIds)),
      sourceConstraintIds,
      targetResourceIds
    };
  }).sort((left, right) => left.constraintId.localeCompare(right.constraintId));
  const exactConstraints = [
    ...project.brief.exactConstraints.flatMap((constraint) => operationTargets.length === 0 ? [] : [{ constraint, targetResourceIds: operationTargets }]),
    ...intents.flatMap((intent) => {
      const targetResourceIds = uniqueSorted(intent.targetResourceIds);
      return targetResourceIds.length === 0 ? [] : intent.exactConstraints.map((constraint) => ({ constraint, targetResourceIds }));
    })
  ].map(({ constraint, targetResourceIds }) => ({
    ...normalizeExactConstraint(constraint),
    sourceConstraintIds: [constraint.constraintId],
    targetResourceIds
  })).sort((left, right) => left.constraintId.localeCompare(right.constraintId));
  return effectiveConstraintSetSchema.parse({ lengthConstraints, exactConstraints });
}

function normalizeExactConstraint(constraint: ExactConstraint) {
  return {
    constraintId: constraint.constraintId,
    matcher: constraint.matcher,
    allowedValues: [...uniqueSorted(constraint.allowedValues.map((value) => value.trim()))],
    baselinePolicy: constraint.baselinePolicy,
    requirement: constraint.requirement,
    criterionIds: [...uniqueSorted(constraint.criterionIds)]
  };
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

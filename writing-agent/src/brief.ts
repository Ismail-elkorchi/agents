import { contentId, nowTimestamp } from './canonical.js';
import {
  writingBriefRevisionSchema,
  type WritingBriefRevision
} from './domain.js';

export type WritingBriefInput = Omit<WritingBriefRevision, 'briefRevisionId' | 'parentBriefRevisionId' | 'createdAt'>;

export function createWritingBrief(input: WritingBriefInput, clock: () => Date = () => new Date()): WritingBriefRevision {
  const createdAt = nowTimestamp(clock);
  const material = { ...briefBody(input), createdAt };
  const brief = writingBriefRevisionSchema.parse({
    ...material,
    briefRevisionId: contentId('brief', material)
  });
  assertBriefIntegrity(brief);
  return brief;
}

export function amendWritingBrief(
  previous: WritingBriefRevision,
  input: WritingBriefInput,
  clock: () => Date = () => new Date()
): WritingBriefRevision {
  if (input.projectId !== previous.projectId) throw new Error('A brief amendment cannot change project identity.');
  assertAssumptionHistory(previous, input);
  assertCriterionHistory(previous, input);
  const createdAt = nowTimestamp(clock);
  const material = { ...briefBody(input), parentBriefRevisionId: previous.briefRevisionId, createdAt };
  const brief = writingBriefRevisionSchema.parse({
    ...material,
    briefRevisionId: contentId('brief', material)
  });
  assertBriefIntegrity(brief);
  return brief;
}

export function assertBriefIntegrity(brief: WritingBriefRevision): void {
  const criterionKinds = new Map<string, WritingBriefRevision['acceptanceCriteria'][number]['verificationKind']>();
  for (const criterion of brief.acceptanceCriteria) {
    if (criterionKinds.has(criterion.criterionId)) throw new Error(`Writing brief contains duplicate acceptance criterion ID: ${criterion.criterionId}`);
    criterionKinds.set(criterion.criterionId, criterion.verificationKind);
  }
  const assumptionIds = new Set<string>();
  for (const assumption of brief.assumptions) {
    if (assumptionIds.has(assumption.assumptionId)) throw new Error(`Writing brief contains duplicate assumption ID: ${assumption.assumptionId}`);
    assumptionIds.add(assumption.assumptionId);
  }
  const constraintIds = new Set<string>();
  const constraints = [
    ...brief.lengthConstraints,
    ...brief.exactConstraints,
    ...brief.contentConstraints,
    ...brief.excludedContent,
    ...brief.structuralConstraints,
    ...brief.terminologyConstraints,
    ...brief.voiceConstraints,
    ...brief.evidencePolicy,
    ...brief.deliveryRequirements
  ];
  for (const constraint of constraints) {
    if (constraintIds.has(constraint.constraintId)) throw new Error(`Writing brief contains duplicate constraint ID: ${constraint.constraintId}`);
    constraintIds.add(constraint.constraintId);
  }
  for (const constraint of [...brief.lengthConstraints, ...brief.exactConstraints]) {
    for (const criterionId of constraint.criterionIds) {
      const kind = criterionKinds.get(criterionId);
      if (kind === undefined) throw new Error(`Writing brief machine constraint references an unknown criterion: ${constraint.constraintId}/${criterionId}`);
      if (kind !== 'deterministic') throw new Error(`Writing brief machine constraint requires a deterministic criterion: ${constraint.constraintId}/${criterionId}`);
    }
  }
  const { briefRevisionId, ...identityInput } = brief;
  if (contentId('brief', identityInput) !== briefRevisionId) throw new Error(`Writing brief identity is invalid: ${briefRevisionId}`);
}

function briefBody(input: WritingBriefInput): WritingBriefInput {
  const body = { ...input } as Record<string, unknown>;
  for (const identityField of ['briefRevisionId', 'parentBriefRevisionId', 'createdAt']) Reflect.deleteProperty(body, identityField);
  return body as WritingBriefInput;
}

export function briefFromInstruction(projectId: string, instruction: string, clock: () => Date = () => new Date()): WritingBriefRevision {
  const bounded = instruction.trim();
  if (bounded.length === 0) throw new Error('Writing brief instruction must not be empty.');
  return createWritingBrief({
    projectId,
    artifactKind: { value: 'document', origin: 'user' },
    subject: { value: bounded, origin: 'user' },
    rhetoricalContext: {
      purpose: { value: bounded, origin: 'user' },
      audience: { value: 'Audience specified by the user or left for explicit clarification.', origin: 'inferred' },
      medium: { value: 'plain text', origin: 'default' },
      language: { value: 'English', origin: 'default' }
    },
    lengthConstraints: [],
    exactConstraints: [],
    contentConstraints: [{ constraintId: 'constraint-user-instruction', statement: bounded, origin: 'user' }],
    excludedContent: [],
    structuralConstraints: [],
    terminologyConstraints: [],
    voiceConstraints: [],
    evidencePolicy: [{ constraintId: 'evidence-no-invention', statement: 'Do not invent external facts or sources.', origin: 'default' }],
    deliveryRequirements: [],
    acceptanceCriteria: [{
      criterionId: 'criterion-user-instruction',
      statement: 'The document satisfies the direct user instruction.',
      scope: 'project',
      requirement: 'required',
      verificationKind: 'human',
      origin: 'user'
    }],
    assumptions: [{
      assumptionId: 'assumption-default-audience',
      statement: 'Audience details not supplied by the user require confirmation before they become requirements.',
      origin: 'inferred',
      status: 'proposed'
    }]
  }, clock);
}

function assertAssumptionHistory(previous: WritingBriefRevision, input: WritingBriefInput): void {
  const next = new Map(input.assumptions.map((assumption) => [assumption.assumptionId, assumption]));
  for (const prior of previous.assumptions) {
    const current = next.get(prior.assumptionId);
    if (current === undefined) throw new Error(`Brief amendment removed assumption history: ${prior.assumptionId}`);
    if (current.statement !== prior.statement || current.origin !== prior.origin) throw new Error(`Brief amendment rewrote assumption identity: ${prior.assumptionId}`);
    if (!validAssumptionTransition(prior.status, current.status)) throw new Error(`Invalid assumption status transition for ${prior.assumptionId}: ${prior.status} -> ${current.status}`);
    if (prior.status === 'superseded' && current.supersedingAssumptionId !== prior.supersedingAssumptionId) throw new Error(`Brief amendment changed the successor of ${prior.assumptionId}.`);
    if (current.status === 'superseded' && !next.has(current.supersedingAssumptionId ?? '')) throw new Error(`Superseding assumption is missing: ${current.supersedingAssumptionId ?? ''}`);
  }
}

function assertCriterionHistory(previous: WritingBriefRevision, input: WritingBriefInput): void {
  const next = new Map(input.acceptanceCriteria.map((criterion) => [criterion.criterionId, criterion]));
  for (const prior of previous.acceptanceCriteria) {
    const current = next.get(prior.criterionId);
    if (current === undefined) throw new Error(`Brief amendment removed acceptance-criterion history: ${prior.criterionId}`);
    if (JSON.stringify(current) !== JSON.stringify(prior)) throw new Error(`Brief amendment rewrote acceptance criterion identity: ${prior.criterionId}`);
  }
}

function validAssumptionTransition(previous: WritingBriefRevision['assumptions'][number]['status'], next: WritingBriefRevision['assumptions'][number]['status']): boolean {
  if (previous === next) return true;
  return previous === 'proposed' && (next === 'accepted' || next === 'rejected' || next === 'superseded');
}

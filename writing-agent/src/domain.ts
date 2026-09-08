import { parseJsonObject } from '@agent-core/json';
import * as z from 'zod';

const jsonObjectSchema = z.unknown().transform((value, context) => {
  try {
    return parseJsonObject(value);
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'Invalid JSON object.'
    });
    return z.NEVER;
  }
});

export const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const timestampSchema = z.iso.datetime({ offset: true });
export const originSchema = z.enum(['user', 'source', 'inferred', 'default']);
export const trustSchema = z.enum(['trusted-control', 'untrusted-data']);

export const textPositionSchema = z
  .strictObject({
    line: z.int().min(1),
    column: z.int().min(1)
  })
  .readonly();

export const textRangeSchema = z
  .strictObject({
    start: textPositionSchema,
    end: textPositionSchema
  })
  .readonly();

export const originatedTextSchema = z
  .strictObject({
    value: z.string().trim().min(1).max(100_000),
    origin: originSchema,
    sourceId: identifierSchema.optional()
  })
  .readonly();

export const constraintSchema = z
  .strictObject({
    constraintId: identifierSchema,
    statement: z.string().trim().min(1).max(100_000),
    origin: originSchema,
    sourceId: identifierSchema.optional()
  })
  .readonly();

export const lengthConstraintSchema = z
  .strictObject({
    constraintId: identifierSchema,
    unit: z.enum(['words', 'characters', 'lines']),
    minimum: z.int().nonnegative().optional(),
    maximum: z.int().nonnegative().optional(),
    requirement: z.enum(['required', 'advisory']),
    criterionIds: z.array(identifierSchema).readonly(),
    origin: originSchema,
    sourceId: identifierSchema.optional()
  })
  .superRefine((value, context) => {
    if (value.minimum === undefined && value.maximum === undefined)
      context.addIssue({ code: 'custom', message: 'A length constraint requires a minimum or maximum.' });
    if (value.minimum !== undefined && value.maximum !== undefined && value.minimum > value.maximum)
      context.addIssue({ code: 'custom', message: 'Length minimum exceeds maximum.' });
  })
  .readonly();

export const exactConstraintSchema = z
  .strictObject({
    constraintId: identifierSchema,
    matcher: z.enum(['number', 'citation', 'named-entity']),
    allowedValues: z.array(z.string().trim().min(1).max(10_000)).readonly(),
    baselinePolicy: z.enum(['exclude', 'include']),
    requirement: z.enum(['required', 'advisory']),
    criterionIds: z.array(identifierSchema).readonly(),
    origin: originSchema,
    sourceId: identifierSchema.optional()
  })
  .readonly();

export const assumptionSchema = z
  .strictObject({
    assumptionId: identifierSchema,
    statement: z.string().trim().min(1).max(100_000),
    origin: originSchema,
    status: z.enum(['proposed', 'accepted', 'rejected', 'superseded']),
    supersedingAssumptionId: identifierSchema.optional()
  })
  .superRefine((value, context) => {
    if ((value.status === 'superseded') !== (value.supersedingAssumptionId !== undefined)) {
      context.addIssue({ code: 'custom', message: 'Only a superseded assumption identifies its successor.' });
    }
  })
  .readonly();

export const acceptanceCriterionSchema = z
  .strictObject({
    criterionId: identifierSchema,
    statement: z.string().trim().min(1).max(100_000),
    scope: z.string().trim().min(1).max(10_000),
    requirement: z.enum(['required', 'advisory']),
    verificationKind: z.enum(['deterministic', 'editorial', 'human']),
    origin: originSchema,
    sourceId: identifierSchema.optional()
  })
  .readonly();

export const writingBriefRevisionSchema = z
  .strictObject({
    projectId: identifierSchema,
    briefRevisionId: identifierSchema,
    parentBriefRevisionId: identifierSchema.optional(),
    artifactKind: originatedTextSchema,
    subject: originatedTextSchema.optional(),
    rhetoricalContext: z
      .strictObject({
        purpose: originatedTextSchema,
        audience: originatedTextSchema,
        occasion: originatedTextSchema.optional(),
        medium: originatedTextSchema,
        language: originatedTextSchema,
        locale: originatedTextSchema.optional()
      })
      .readonly(),
    lengthConstraints: z.array(lengthConstraintSchema).readonly(),
    exactConstraints: z.array(exactConstraintSchema).readonly(),
    contentConstraints: z.array(constraintSchema).readonly(),
    excludedContent: z.array(constraintSchema).readonly(),
    structuralConstraints: z.array(constraintSchema).readonly(),
    terminologyConstraints: z.array(constraintSchema).readonly(),
    voiceConstraints: z.array(constraintSchema).readonly(),
    evidencePolicy: z.array(constraintSchema).readonly(),
    deliveryRequirements: z.array(constraintSchema).readonly(),
    acceptanceCriteria: z.array(acceptanceCriterionSchema).readonly(),
    assumptions: z.array(assumptionSchema).readonly(),
    createdAt: timestampSchema
  })
  .readonly();

export const writingOperationKindSchema = z.enum([
  'plan',
  'draft',
  'continue',
  'revise',
  'review',
  'transform',
  'translate'
]);
export const writingOperationModeSchema = z.enum(['suggest', 'apply']);

export const humanCriterionDecisionSchema = z
  .strictObject({
    criterionId: identifierSchema,
    verdict: z.enum(['passed', 'failed']),
    explanation: z.string().trim().min(1).max(100_000)
  })
  .readonly();

export const WRITING_APPLY_AUTHORIZATION_POLICY_ID = 'writing-agent.apply-authorization@1';

export const writingDelegatedApplyPolicySchema = z
  .strictObject({
    channel: z.literal('direct-user'),
    decision: z.literal('accept-and-apply'),
    explanation: z.string().trim().min(1).max(100_000),
    humanCriterionDecisions: z.array(humanCriterionDecisionSchema).readonly()
  })
  .readonly();

export const writingApplyAuthorizationSchema = z
  .strictObject({
    authorizationId: identifierSchema,
    authorizationPolicyId: z.literal(WRITING_APPLY_AUTHORIZATION_POLICY_ID),
    projectId: identifierSchema,
    operationId: identifierSchema,
    proposalId: identifierSchema,
    projectRevisionId: identifierSchema,
    resourcePreimages: z.record(identifierSchema, sha256Schema).readonly(),
    productionVerificationId: identifierSchema,
    verificationInputSha256: sha256Schema,
    editorialDecisionId: identifierSchema,
    humanCriterionDecisionsSha256: sha256Schema,
    transactionId: identifierSchema,
    authorizedAt: timestampSchema
  })
  .readonly();

export const writingIntentSchema = z
  .strictObject({
    intentId: identifierSchema,
    schemaId: identifierSchema,
    schemaVersion: z.int().min(1),
    kind: identifierSchema,
    instruction: z.string().trim().min(1).max(100_000),
    targetNodeIds: z.array(identifierSchema).readonly(),
    targetResourceIds: z.array(identifierSchema).readonly(),
    targetRangeIds: z.array(identifierSchema).readonly(),
    dependencies: z.array(identifierSchema).readonly(),
    affectedCriterionIds: z.array(identifierSchema).readonly(),
    affectedClaimIds: z.array(identifierSchema).readonly(),
    affectedRelationIds: z.array(identifierSchema).readonly(),
    affectedEditorialDecisionIds: z.array(identifierSchema).readonly(),
    preservationRequirements: z.array(constraintSchema).readonly(),
    lengthConstraints: z.array(lengthConstraintSchema).readonly(),
    exactConstraints: z.array(exactConstraintSchema).readonly()
  })
  .readonly();

export const effectiveLengthConstraintSchema = z
  .strictObject({
    constraintId: identifierSchema,
    unit: z.enum(['words', 'characters', 'lines']),
    minimum: z.int().nonnegative().optional(),
    maximum: z.int().nonnegative().optional(),
    requirement: z.enum(['required', 'advisory']),
    criterionIds: z.array(identifierSchema).readonly(),
    sourceConstraintIds: z.array(identifierSchema).min(1).readonly(),
    targetResourceIds: z.array(identifierSchema).min(1).readonly()
  })
  .superRefine((value, context) => {
    if (value.minimum === undefined && value.maximum === undefined)
      context.addIssue({
        code: 'custom',
        message: 'An effective length constraint requires a minimum or maximum.'
      });
    if (value.minimum !== undefined && value.maximum !== undefined && value.minimum > value.maximum)
      context.addIssue({ code: 'custom', message: 'Effective length constraints do not intersect.' });
  })
  .readonly();

export const effectiveExactConstraintSchema = z
  .strictObject({
    constraintId: identifierSchema,
    matcher: z.enum(['number', 'citation', 'named-entity']),
    allowedValues: z.array(z.string().trim().min(1).max(10_000)).readonly(),
    baselinePolicy: z.enum(['exclude', 'include']),
    requirement: z.enum(['required', 'advisory']),
    criterionIds: z.array(identifierSchema).readonly(),
    sourceConstraintIds: z.array(identifierSchema).min(1).readonly(),
    targetResourceIds: z.array(identifierSchema).min(1).readonly()
  })
  .readonly();

export const effectiveConstraintSetSchema = z
  .strictObject({
    lengthConstraints: z.array(effectiveLengthConstraintSchema).readonly(),
    exactConstraints: z.array(effectiveExactConstraintSchema).readonly()
  })
  .readonly();

export const executionBindingSchema = z
  .strictObject({
    providerId: identifierSchema,
    providerImplementationId: identifierSchema,
    modelId: z.string().trim().min(1).max(1_000),
    intentRegistryImplementationId: identifierSchema,
    contextPolicyId: identifierSchema,
    contextPolicyVersion: z.int().min(1),
    toolImplementationIds: z.array(identifierSchema).readonly(),
    checkImplementationIds: z.array(identifierSchema).readonly(),
    dispositionImplementationId: identifierSchema,
    authorizationPolicyId: identifierSchema,
    configurationSha256: sha256Schema
  })
  .readonly();

export const writingOperationSchema = z
  .strictObject({
    projectId: identifierSchema,
    operationId: identifierSchema,
    briefRevisionId: identifierSchema,
    kind: writingOperationKindSchema,
    instruction: z.string().trim().min(1).max(100_000),
    intents: z.array(writingIntentSchema).min(1).readonly(),
    targetNodeIds: z.array(identifierSchema).readonly(),
    targetResourceIds: z.array(identifierSchema).readonly(),
    effectiveConstraints: effectiveConstraintSetSchema,
    baseProjectRevisionId: identifierSchema,
    mode: writingOperationModeSchema,
    delegatedApplyPolicy: writingDelegatedApplyPolicySchema.optional(),
    sessionId: identifierSchema,
    runId: identifierSchema,
    lifecycleState: z.literal('admitted'),
    executionBinding: executionBindingSchema,
    admittedAt: timestampSchema
  })
  .superRefine((operation, context) => {
    if ((operation.mode === 'apply') !== (operation.delegatedApplyPolicy !== undefined)) {
      context.addIssue({
        code: 'custom',
        message:
          'Apply operations require an explicit direct-user delegated apply policy, and suggest operations must not carry it.'
      });
    }
  })
  .readonly();

export const documentNodeSchema = z
  .strictObject({
    nodeId: identifierSchema,
    kind: z.string().trim().min(1).max(256),
    parentId: identifierSchema.nullable(),
    siblingOrder: z.int().nonnegative(),
    title: z.string().max(10_000).optional(),
    purpose: z.string().trim().min(1).max(100_000),
    status: z.enum(['planned', 'drafting', 'review', 'complete', 'removed']),
    targetLength: lengthConstraintSchema.optional(),
    resourceId: identifierSchema.optional()
  })
  .readonly();

export const relationEdgeSchema = z
  .strictObject({
    relationId: identifierSchema,
    kind: z.string().trim().min(1).max(256),
    sourceId: identifierSchema,
    targetId: identifierSchema,
    purpose: z.string().trim().min(1).max(10_000),
    status: z.enum(['active', 'superseded', 'removed'])
  })
  .readonly();

export const protectedRangeSchema = z
  .strictObject({
    rangeId: identifierSchema,
    range: textRangeSchema,
    sha256: sha256Schema,
    reason: z.string().trim().min(1).max(10_000),
    decisionRequired: z.boolean()
  })
  .readonly();

export const managedTextResourceSchema = z
  .strictObject({
    resourceId: identifierSchema,
    relativePath: z.string().trim().min(1).max(4_096),
    mediaType: z.string().trim().min(1).max(256),
    role: z.string().trim().min(1).max(256),
    ownership: z.enum(['user-owned', 'agent-owned', 'imported-source']),
    currentSha256: sha256Schema,
    protectedRanges: z.array(protectedRangeSchema).readonly(),
    currentProjectRevisionId: identifierSchema
  })
  .readonly();

export const sourceExcerptSchema = z
  .strictObject({
    excerptId: identifierSchema,
    resourceId: identifierSchema,
    sourceRevisionSha256: sha256Schema,
    range: textRangeSchema,
    rangeSha256: sha256Schema,
    textSha256: sha256Schema
  })
  .readonly();

export const sourceRecordSchema = z
  .strictObject({
    sourceId: identifierSchema,
    kind: z.string().trim().min(1).max(256),
    title: z.string().trim().min(1).max(10_000).optional(),
    authors: z.array(z.string().trim().min(1).max(1_000)).readonly(),
    date: z.string().trim().min(1).max(256).optional(),
    localResourceId: identifierSchema.optional(),
    artifactId: identifierSchema.optional(),
    exactSha256: sha256Schema,
    accessMetadata: jsonObjectSchema.optional(),
    rightsMetadata: jsonObjectSchema.optional(),
    identityStatus: z.enum(['unverified', 'verified', 'conflicting', 'unavailable']),
    authoritativeIdentifiers: z
      .array(
        z
          .strictObject({
            scheme: identifierSchema,
            value: z.string().trim().min(1).max(10_000),
            evidence: z.string().trim().min(1).max(100_000)
          })
          .readonly()
      )
      .readonly(),
    identityVerifierId: identifierSchema.optional(),
    verificationPolicyId: identifierSchema.optional(),
    excerpts: z.array(sourceExcerptSchema).readonly(),
    contradictions: z.array(z.string().trim().min(1).max(100_000)).readonly(),
    unsupportedFindings: z.array(z.string().trim().min(1).max(100_000)).readonly(),
    omittedRelevantEvidenceFindings: z.array(z.string().trim().min(1).max(100_000)).readonly(),
    addedAt: timestampSchema
  })
  .readonly();

export const claimSchema = z
  .strictObject({
    claimId: identifierSchema,
    version: z.int().min(1),
    statement: z.string().trim().min(1).max(100_000),
    scope: z.string().trim().min(1).max(10_000),
    origin: z.enum(['user', 'source', 'model', 'application']),
    status: z.enum(['proposed', 'adopted', 'superseded', 'rejected']),
    projectRevisionId: identifierSchema
  })
  .readonly();

export const claimEvidenceRelationSchema = z
  .strictObject({
    relationId: identifierSchema,
    claimId: identifierSchema,
    claimVersion: z.int().min(1),
    sourceId: identifierSchema,
    excerptId: identifierSchema,
    sourceRevisionSha256: sha256Schema,
    rangeSha256: sha256Schema,
    kind: z.enum(['direct-quotation', 'compression-or-paraphrase', 'inference']),
    verdict: z.enum(['supported', 'partially-supported', 'contradicted', 'unknown']),
    verifierId: identifierSchema,
    verificationPolicyId: identifierSchema,
    calibrationId: identifierSchema.optional(),
    criterionEvidence: z
      .array(
        z
          .strictObject({
            criterionId: identifierSchema,
            evidence: z.string().trim().min(1).max(100_000),
            explanation: z.string().trim().min(1).max(100_000)
          })
          .readonly()
      )
      .readonly(),
    humanDecisionId: identifierSchema.optional()
  })
  .readonly();

export const voiceReferenceSchema = z
  .strictObject({
    voiceReferenceId: identifierSchema,
    resourceId: identifierSchema.optional(),
    artifactId: identifierSchema.optional(),
    exactSha256: sha256Schema,
    range: textRangeSchema.optional(),
    assertedProvenance: z.string().trim().min(1).max(100_000),
    permittedPurpose: z.string().trim().min(1).max(100_000),
    consentOrRightsBasis: z.string().trim().min(1).max(100_000).optional(),
    language: z.string().trim().min(1).max(256),
    locale: z.string().trim().min(1).max(256).optional(),
    genre: z.string().trim().min(1).max(256),
    rhetoricalScope: z.string().trim().min(1).max(10_000),
    preserveNotes: z.array(z.string().trim().min(1).max(10_000)).readonly(),
    doNotImitateNotes: z.array(z.string().trim().min(1).max(10_000)).readonly(),
    retentionStatus: z.enum(['retained', 'deletion-requested', 'deleted'])
  })
  .superRefine((value, context) => {
    if (Number(value.resourceId !== undefined) + Number(value.artifactId !== undefined) !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'Voice reference requires exactly one resource or artifact identity.'
      });
    }
  })
  .readonly();

export const authorshipProvenanceSchema = z
  .strictObject({
    provenanceId: identifierSchema,
    projectRevisionId: identifierSchema,
    resourceId: identifierSchema.optional(),
    nodeId: identifierSchema.optional(),
    range: textRangeSchema.optional(),
    structuralObjectId: identifierSchema.optional(),
    operationId: identifierSchema,
    proposalId: identifierSchema.optional(),
    intentIds: z.array(identifierSchema).readonly(),
    classification: z.enum([
      'human-authored',
      'imported',
      'model-suggested',
      'user-accepted-unchanged',
      'user-modified'
    ]),
    supersedesProvenanceIds: z.array(identifierSchema).readonly(),
    createdAt: timestampSchema
  })
  .superRefine((value, context) => {
    const targetCount =
      Number(value.resourceId !== undefined && value.range !== undefined) +
      Number(value.nodeId !== undefined && value.structuralObjectId !== undefined);
    if (targetCount !== 1)
      context.addIssue({
        code: 'custom',
        message: 'Authorship provenance requires exactly one range or structural target.'
      });
  })
  .readonly();

export const localizedTextEditSchema = z
  .strictObject({
    resourceId: identifierSchema,
    baseSha256: sha256Schema,
    edits: z
      .array(
        z
          .strictObject({
            anchorId: identifierSchema,
            intentIds: z.array(identifierSchema).min(1).readonly(),
            range: textRangeSchema,
            expectedTextSha256: sha256Schema,
            replacementText: z.string()
          })
          .readonly()
      )
      .min(1)
      .readonly()
  })
  .readonly();

export const structuralChangeSchema = z
  .strictObject({
    changeId: identifierSchema,
    intentIds: z.array(identifierSchema).min(1).readonly(),
    kind: z.enum(['create', 'remove', 'reorder', 'split', 'merge', 'purpose', 'relation']),
    targetIds: z.array(identifierSchema).min(1).readonly(),
    value: jsonObjectSchema
  })
  .readonly();

export const semanticChangeItemSchema = z
  .strictObject({
    itemId: identifierSchema,
    kind: z.enum([
      'claim',
      'citation',
      'evidence-relation',
      'referent',
      'stance',
      'obligation',
      'chronology',
      'terminology',
      'structural-relation'
    ]),
    action: z.enum(['introduce', 'modify', 'remove']),
    scope: z.string().trim().min(1).max(10_000),
    targetId: identifierSchema.optional(),
    statement: z.string().trim().min(1).max(100_000)
  })
  .readonly();

export const semanticChangeDeclarationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }).readonly(),
  z
    .strictObject({ kind: z.literal('changes'), items: z.array(semanticChangeItemSchema).min(1).readonly() })
    .readonly()
]);

export const deterministicCheckSchema = z
  .strictObject({
    checkId: identifierSchema,
    implementationId: identifierSchema,
    criterionIds: z.array(identifierSchema).readonly(),
    requirement: z.enum(['required', 'advisory']),
    verdict: z.enum(['passed', 'failed', 'unknown']),
    summary: z.string().trim().min(1).max(100_000),
    observations: z.array(z.string().max(100_000)).readonly(),
    inputSha256: sha256Schema
  })
  .readonly();

export const criterionCoverageSchema = z
  .strictObject({
    criterionId: identifierSchema,
    requirement: z.enum(['required', 'advisory']),
    verificationKind: z.enum(['deterministic', 'editorial', 'human']),
    verdict: z.enum(['passed', 'failed', 'unknown']),
    coverage: z.enum(['complete', 'partial', 'none']),
    evaluatorIds: z.array(identifierSchema).readonly(),
    verificationIds: z.array(identifierSchema).readonly(),
    explanation: z.string().trim().min(1).max(100_000)
  })
  .readonly();

export const writingFindingCitationSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      citationId: identifierSchema,
      kind: z.literal('proposed'),
      proposedRevisionId: identifierSchema,
      resourceId: identifierSchema,
      range: textRangeSchema,
      textSha256: sha256Schema
    })
    .readonly(),
  z
    .strictObject({
      citationId: identifierSchema,
      kind: z.literal('base'),
      revisionId: identifierSchema,
      resourceId: identifierSchema,
      range: textRangeSchema,
      textSha256: sha256Schema
    })
    .readonly(),
  z
    .strictObject({
      citationId: identifierSchema,
      kind: z.literal('source'),
      sourceId: identifierSchema,
      excerptId: identifierSchema,
      resourceId: identifierSchema,
      range: textRangeSchema,
      sourceRevisionSha256: sha256Schema,
      textSha256: sha256Schema
    })
    .readonly()
]);

export const editorialFindingSchema = z
  .strictObject({
    findingId: identifierSchema,
    criterionId: identifierSchema,
    scope: z.string().trim().min(1).max(10_000),
    severity: z.enum(['required', 'advisory']),
    verdict: z.enum(['passed', 'failed', 'unknown']),
    supportingCitations: z.array(writingFindingCitationSchema).readonly(),
    explanation: z.string().trim().min(1).max(100_000),
    evaluatorId: identifierSchema,
    calibrationId: identifierSchema.optional(),
    verificationPolicyId: identifierSchema,
    verificationInputSha256: sha256Schema,
    baseRevisionId: identifierSchema,
    proposedRevisionId: identifierSchema,
    coverage: z.enum(['complete', 'partial', 'unknown'])
  })
  .readonly();

export const semanticPreservationFindingSchema = z
  .strictObject({
    findingId: identifierSchema,
    scope: z.string().trim().min(1).max(10_000),
    requirement: z.enum(['required', 'advisory']),
    verdict: z.enum(['passed', 'failed', 'unknown']),
    coverage: z.enum(['complete', 'partial', 'unknown']),
    supportingCitations: z.array(writingFindingCitationSchema).readonly(),
    intendedChanges: z.array(identifierSchema).readonly(),
    observedChanges: z.array(z.string().max(100_000)).readonly(),
    unexplainedChanges: z.array(z.string().max(100_000)).readonly(),
    lostPriorEditIds: z.array(identifierSchema).readonly(),
    evaluatorId: identifierSchema,
    verificationPolicyId: identifierSchema,
    calibrationId: identifierSchema.optional(),
    verificationInputSha256: sha256Schema,
    baseRevisionId: identifierSchema,
    proposedRevisionId: identifierSchema,
    explanation: z.string().trim().min(1).max(100_000)
  })
  .readonly();

export const preservationContractSchema = z
  .strictObject({
    allowedResourceIds: z.array(identifierSchema).readonly(),
    allowedNodeIds: z.array(identifierSchema).readonly(),
    allowedRangeIds: z.array(identifierSchema).readonly(),
    allowedStructuralObjectIds: z.array(identifierSchema).readonly(),
    protectedResourceHashes: z.record(identifierSchema, sha256Schema).readonly(),
    protectedRangeIds: z.array(identifierSchema).readonly(),
    protectedCriterionIds: z.array(identifierSchema).readonly(),
    protectedClaimIds: z.array(identifierSchema).readonly(),
    protectedEvidenceRelationIds: z.array(identifierSchema).readonly(),
    protectedEditorialDecisionIds: z.array(identifierSchema).readonly(),
    priorAcceptedProposalIds: z.array(identifierSchema).readonly(),
    priorRevisionIds: z.array(identifierSchema).readonly(),
    allowedSemanticScopes: z.array(z.string().trim().min(1).max(10_000)).readonly(),
    stableSemanticScopes: z.array(z.string().trim().min(1).max(10_000)).readonly(),
    comparisonBaselineRevisionIds: z.array(identifierSchema).min(1).readonly(),
    requiredRevalidations: z.array(identifierSchema).readonly()
  })
  .readonly();

const writingHistorySourceSchema = z
  .strictObject({
    sessionId: z.string().min(1),
    entryId: z.string().min(1),
    sha256: sha256Schema,
    event: z
      .strictObject({
        runId: z.string().min(1),
        eventId: z.string().min(1),
        sequence: z.int().nonnegative(),
        hash: sha256Schema
      })
      .optional()
      .readonly()
  })
  .readonly();
const writingNoteReferenceSchema = z
  .strictObject({
    scope: z.strictObject({ sessionId: z.string().min(1), branchId: z.string().min(1) }).readonly(),
    noteId: z.string().min(1),
    revisionId: z.string().min(1)
  })
  .readonly();
export const writingContextSupplementSchema = z
  .strictObject({
    supplementId: identifierSchema,
    operationId: identifierSchema,
    baseProjectRevisionId: identifierSchema,
    origin: z.discriminatedUnion('kind', [
      z
        .strictObject({
          kind: z.literal('history'),
          source: writingHistorySourceSchema,
          sourceCut: z
            .strictObject({
              format: z.literal('agent-core.history/1'),
              sessionId: z.string().min(1),
              branchId: z.string().min(1),
              throughEntryId: z.string().nullable(),
              sourceRevision: z.int().nonnegative(),
              ledgerCoverage: z.enum(['authoritative', 'session']),
              ledgerHeads: z
                .array(
                  z
                    .strictObject({
                      runId: z.string().min(1),
                      sequence: z.int().min(-1),
                      hash: sha256Schema.optional()
                    })
                    .readonly()
                )
                .readonly()
                .optional()
            })
            .readonly()
        })
        .readonly(),
      z.strictObject({ kind: z.literal('note'), reference: writingNoteReferenceSchema }).readonly()
    ]),
    content: z.string().max(128_000),
    contentSha256: sha256Schema,
    range: z.discriminatedUnion('kind', [
      z
        .strictObject({
          kind: z.literal('byte'),
          offset: z.int().nonnegative(),
          nextOffset: z.int().nonnegative(),
          totalBytes: z.int().nonnegative()
        })
        .readonly(),
      z.strictObject({ kind: z.literal('search-excerpt') }).readonly()
    ]),
    truncated: z.boolean(),
    trust: z.literal('untrusted-data')
  })
  .readonly();
export type WritingContextSupplement = z.infer<typeof writingContextSupplementSchema>;

export const writingContextSelectionSchema = z
  .strictObject({
    contextSelectionId: identifierSchema,
    parentSelectionId: identifierSchema.nullable(),
    baseProjectRevisionId: identifierSchema,
    supplements: z.array(writingContextSupplementSchema).max(128).readonly(),
    policyId: identifierSchema,
    policyVersion: z.int().min(1),
    operationId: identifierSchema,
    selectedIntentIds: z.array(identifierSchema).readonly(),
    intentCoverage: z.record(identifierSchema, z.enum(['complete', 'partial', 'none'])).readonly(),
    tokenBudget: z.int().min(1),
    targetDescriptors: z
      .array(
        z
          .strictObject({
            resourceId: identifierSchema,
            relativePath: z.string().trim().min(1).max(4_096),
            baseSha256: sha256Schema,
            mediaType: z.string().trim().min(1).max(256),
            anchors: z
              .array(
                z
                  .strictObject({
                    anchorId: identifierSchema,
                    kind: z.enum(['document', 'paragraph', 'protected-range']),
                    targetRangeId: identifierSchema.optional(),
                    range: textRangeSchema,
                    textSha256: sha256Schema,
                    label: z.string().trim().min(1).max(1_000)
                  })
                  .readonly()
              )
              .readonly()
          })
          .readonly()
      )
      .readonly(),
    items: z
      .array(
        z
          .strictObject({
            itemId: identifierSchema,
            kind: identifierSchema,
            versionOrSha256: z.string().trim().min(1).max(1_000),
            range: textRangeSchema.optional(),
            trust: trustSchema,
            provenanceId: identifierSchema,
            reasonCodes: z.array(identifierSchema).min(1).readonly(),
            content: z.string().max(2_000_000)
          })
          .readonly()
      )
      .readonly(),
    omittedCounts: z.record(identifierSchema, z.int().nonnegative()).readonly(),
    truncated: z.boolean(),
    coverage: z.enum(['complete', 'partial'])
  })
  .readonly();

export const revisionProposalSchema = z
  .strictObject({
    proposalId: identifierSchema,
    canonicalProposalSha256: sha256Schema,
    operationId: identifierSchema,
    baseProjectRevisionId: identifierSchema,
    affectedNodeIds: z.array(identifierSchema).readonly(),
    affectedResourceIds: z.array(identifierSchema).readonly(),
    textEdits: z.array(localizedTextEditSchema).readonly(),
    structuralChanges: z.array(structuralChangeSchema).readonly(),
    expectedBaseHashes: z.record(identifierSchema, sha256Schema).readonly(),
    preservationContract: preservationContractSchema,
    semanticChangeDeclaration: semanticChangeDeclarationSchema,
    proposedAuthorshipProvenance: z.array(authorshipProvenanceSchema).readonly(),
    contextSelectionId: identifierSchema,
    status: z.literal('proposed'),
    boundedRationale: z.string().max(10_000),
    createdAt: timestampSchema
  })
  .readonly();

export const proposalProductionVerificationSchema = z
  .strictObject({
    verificationId: identifierSchema,
    proposalId: identifierSchema,
    operationId: identifierSchema,
    baseProjectRevisionId: identifierSchema,
    proposedRevisionId: identifierSchema,
    verificationInputSha256: sha256Schema,
    evaluatorImplementationId: identifierSchema,
    verificationPolicyId: identifierSchema,
    calibrationId: identifierSchema.optional(),
    deterministicChecks: z.array(deterministicCheckSchema).readonly(),
    semanticPreservationFindings: z.array(semanticPreservationFindingSchema).readonly(),
    editorialFindings: z.array(editorialFindingSchema).readonly(),
    criterionCoverage: z.array(criterionCoverageSchema).readonly(),
    verifiedAt: timestampSchema
  })
  .readonly();

export const editorialDecisionSchema = z
  .strictObject({
    decisionId: identifierSchema,
    projectRevisionId: identifierSchema,
    proposalId: identifierSchema.optional(),
    findingIds: z.array(identifierSchema).readonly(),
    criterionDecisions: z.array(humanCriterionDecisionSchema).readonly(),
    decision: z.enum(['accepted', 'rejected', 'override']),
    explanation: z.string().trim().min(1).max(100_000),
    actor: z.enum(['human', 'application']),
    createdAt: timestampSchema
  })
  .readonly();

export const projectRevisionSchema = z
  .strictObject({
    revisionId: identifierSchema,
    parentRevisionIds: z.array(identifierSchema).readonly(),
    briefRevisionId: identifierSchema,
    documentTreeSha256: sha256Schema,
    relationGraphSha256: sha256Schema,
    resourceHashes: z.record(identifierSchema, sha256Schema).readonly(),
    sourceClaimEvidenceGraphSha256: sha256Schema,
    authorshipProvenanceGraphSha256: sha256Schema,
    operationId: identifierSchema,
    runId: identifierSchema.optional(),
    editorialDecisionIds: z.array(identifierSchema).readonly(),
    editorialFindingIds: z.array(identifierSchema).readonly(),
    timestamp: timestampSchema
  })
  .readonly();

export const projectSnapshotSchema = z
  .strictObject({
    revision: projectRevisionSchema,
    brief: writingBriefRevisionSchema,
    nodes: z.array(documentNodeSchema).readonly(),
    relations: z.array(relationEdgeSchema).readonly(),
    resources: z.array(managedTextResourceSchema).readonly(),
    sources: z.array(sourceRecordSchema).readonly(),
    claims: z.array(claimSchema).readonly(),
    evidenceRelations: z.array(claimEvidenceRelationSchema).readonly(),
    voiceReferences: z.array(voiceReferenceSchema).readonly(),
    authorshipProvenance: z.array(authorshipProvenanceSchema).readonly(),
    editorialFindings: z.array(editorialFindingSchema).readonly(),
    editorialDecisions: z.array(editorialDecisionSchema).readonly()
  })
  .readonly();

export interface WritingOperationResult {
  readonly projectId: string;
  readonly operationId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly baseRevisionId: string;
  readonly operationKind: WritingOperationKind;
  readonly proposalId?: string;
  readonly committedRevisionId?: string;
  readonly execution: import('@agent-core/runtime').AgentRunResult;
  readonly fileChanges: readonly WritingFileChange[];
  readonly transactionSettlement?: WritingTransactionSettlement;
  readonly semanticChangeDeclaration?: SemanticChangeDeclaration;
  readonly semanticPreservationFindings: readonly SemanticPreservationFinding[];
  readonly checkResults: readonly DeterministicCheck[];
  readonly criterionCoverage?: readonly CriterionCoverage[];
  readonly disposition: 'valid' | 'invalid' | 'inconclusive';
  readonly editorialFindings: readonly EditorialFinding[];
  readonly reviewStatus: 'not-requested' | 'pending' | 'accepted' | 'rejected';
  readonly contextSelection: WritingContextSelection;
  readonly affectedResourceIds: readonly string[];
  readonly authorshipProvenanceChanges: readonly AuthorshipProvenance[];
  readonly remainingUncertainty: readonly string[];
  readonly modelOutputMessage?: string;
}

export interface WritingFileChange {
  readonly resourceId: string;
  readonly path: string;
  readonly oldSha256?: string;
  readonly newSha256?: string;
  readonly changedAnchorIds: readonly string[];
}

export interface WritingTransactionSettlement {
  readonly transactionId: string;
  readonly outcome: 'committed' | 'committed_with_residue' | 'rolled_back' | 'rollback_failed';
  readonly cleanup: 'succeeded' | 'failed' | 'uncertain';
}

export type WritingBriefRevision = z.infer<typeof writingBriefRevisionSchema>;
export type ExactConstraint = z.infer<typeof exactConstraintSchema>;
export type EffectiveConstraintSet = z.infer<typeof effectiveConstraintSetSchema>;
export type WritingIntent = z.infer<typeof writingIntentSchema>;
export type WritingOperation = z.infer<typeof writingOperationSchema>;
export type WritingOperationKind = z.infer<typeof writingOperationKindSchema>;
export type WritingOperationMode = z.infer<typeof writingOperationModeSchema>;
export type WritingDelegatedApplyPolicy = z.infer<typeof writingDelegatedApplyPolicySchema>;
export type WritingApplyAuthorization = z.infer<typeof writingApplyAuthorizationSchema>;
export type DocumentNode = z.infer<typeof documentNodeSchema>;
export type RelationEdge = z.infer<typeof relationEdgeSchema>;
export type ManagedTextResource = z.infer<typeof managedTextResourceSchema>;
export type SourceRecord = z.infer<typeof sourceRecordSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type ClaimEvidenceRelation = z.infer<typeof claimEvidenceRelationSchema>;
export type VoiceReference = z.infer<typeof voiceReferenceSchema>;
export type AuthorshipProvenance = z.infer<typeof authorshipProvenanceSchema>;
export type LocalizedTextEdit = z.infer<typeof localizedTextEditSchema>;
export type StructuralChange = z.infer<typeof structuralChangeSchema>;
export type SemanticChangeDeclaration = z.infer<typeof semanticChangeDeclarationSchema>;
export type SemanticPreservationFinding = z.infer<typeof semanticPreservationFindingSchema>;
export type DeterministicCheck = z.infer<typeof deterministicCheckSchema>;
export type CriterionCoverage = z.infer<typeof criterionCoverageSchema>;
export type WritingFindingCitation = z.infer<typeof writingFindingCitationSchema>;
export type HumanCriterionDecision = z.infer<typeof humanCriterionDecisionSchema>;
export type EditorialFinding = z.infer<typeof editorialFindingSchema>;
export type EditorialDecision = z.infer<typeof editorialDecisionSchema>;
export type PreservationContract = z.infer<typeof preservationContractSchema>;
export type WritingContextSelection = z.infer<typeof writingContextSelectionSchema>;
export type RevisionProposal = z.infer<typeof revisionProposalSchema>;
export type ProposalProductionVerification = z.infer<typeof proposalProductionVerificationSchema>;
export type ProjectRevision = z.infer<typeof projectRevisionSchema>;
export type ProjectSnapshot = z.infer<typeof projectSnapshotSchema>;

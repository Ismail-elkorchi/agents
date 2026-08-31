import * as z from 'zod';

export const identifierSchema = z.string().trim().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const timestampSchema = z.iso.datetime({ offset: true });
export const originSchema = z.enum(['user', 'source', 'inferred', 'default']);
export const trustSchema = z.enum(['trusted-control', 'untrusted-data']);

export const textPositionSchema = z.strictObject({
  line: z.int().min(1),
  column: z.int().min(1)
});

export const textRangeSchema = z.strictObject({
  start: textPositionSchema,
  end: textPositionSchema
});

export const originatedTextSchema = z.strictObject({
  value: z.string().trim().min(1).max(100_000),
  origin: originSchema,
  sourceId: identifierSchema.optional()
});

export const constraintSchema = z.strictObject({
  constraintId: identifierSchema,
  statement: z.string().trim().min(1).max(100_000),
  origin: originSchema,
  sourceId: identifierSchema.optional()
});

export const lengthConstraintSchema = z.strictObject({
  constraintId: identifierSchema,
  unit: z.enum(['words', 'characters', 'lines']),
  minimum: z.int().nonnegative().optional(),
  maximum: z.int().nonnegative().optional(),
  requirement: z.enum(['required', 'advisory']),
  criterionIds: z.array(identifierSchema),
  origin: originSchema,
  sourceId: identifierSchema.optional()
}).superRefine((value, context) => {
  if (value.minimum === undefined && value.maximum === undefined) context.addIssue({ code: 'custom', message: 'A length constraint requires a minimum or maximum.' });
  if (value.minimum !== undefined && value.maximum !== undefined && value.minimum > value.maximum) context.addIssue({ code: 'custom', message: 'Length minimum exceeds maximum.' });
});

export const exactConstraintSchema = z.strictObject({
  constraintId: identifierSchema,
  matcher: z.enum(['number', 'citation', 'named-entity']),
  allowedValues: z.array(z.string().trim().min(1).max(10_000)),
  baselinePolicy: z.enum(['exclude', 'include']),
  requirement: z.enum(['required', 'advisory']),
  criterionIds: z.array(identifierSchema),
  origin: originSchema,
  sourceId: identifierSchema.optional()
});

export const assumptionSchema = z.strictObject({
  assumptionId: identifierSchema,
  statement: z.string().trim().min(1).max(100_000),
  origin: originSchema,
  status: z.enum(['proposed', 'accepted', 'rejected', 'superseded']),
  supersedingAssumptionId: identifierSchema.optional()
}).superRefine((value, context) => {
  if ((value.status === 'superseded') !== (value.supersedingAssumptionId !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Only a superseded assumption identifies its successor.' });
  }
});

export const acceptanceCriterionSchema = z.strictObject({
  criterionId: identifierSchema,
  statement: z.string().trim().min(1).max(100_000),
  scope: z.string().trim().min(1).max(10_000),
  requirement: z.enum(['required', 'advisory']),
  verificationKind: z.enum(['deterministic', 'editorial', 'human']),
  origin: originSchema,
  sourceId: identifierSchema.optional()
});

export const writingBriefRevisionSchema = z.strictObject({
  projectId: identifierSchema,
  briefRevisionId: identifierSchema,
  parentBriefRevisionId: identifierSchema.optional(),
  artifactKind: originatedTextSchema,
  subject: originatedTextSchema.optional(),
  rhetoricalContext: z.strictObject({
    purpose: originatedTextSchema,
    audience: originatedTextSchema,
    occasion: originatedTextSchema.optional(),
    medium: originatedTextSchema,
    language: originatedTextSchema,
    locale: originatedTextSchema.optional()
  }),
  lengthConstraints: z.array(lengthConstraintSchema),
  exactConstraints: z.array(exactConstraintSchema),
  contentConstraints: z.array(constraintSchema),
  excludedContent: z.array(constraintSchema),
  structuralConstraints: z.array(constraintSchema),
  terminologyConstraints: z.array(constraintSchema),
  voiceConstraints: z.array(constraintSchema),
  evidencePolicy: z.array(constraintSchema),
  deliveryRequirements: z.array(constraintSchema),
  acceptanceCriteria: z.array(acceptanceCriterionSchema),
  assumptions: z.array(assumptionSchema),
  createdAt: timestampSchema
});

export const writingOperationKindSchema = z.enum(['plan', 'draft', 'continue', 'revise', 'review', 'transform', 'translate']);
export const writingOperationModeSchema = z.enum(['suggest', 'apply']);

export const writingIntentSchema = z.strictObject({
  intentId: identifierSchema,
  schemaId: identifierSchema,
  schemaVersion: z.int().min(1),
  kind: identifierSchema,
  instruction: z.string().trim().min(1).max(100_000),
  targetNodeIds: z.array(identifierSchema),
  targetResourceIds: z.array(identifierSchema),
  targetRangeIds: z.array(identifierSchema),
  dependencies: z.array(identifierSchema),
  affectedCriterionIds: z.array(identifierSchema),
  affectedClaimIds: z.array(identifierSchema),
  affectedRelationIds: z.array(identifierSchema),
  affectedEditorialDecisionIds: z.array(identifierSchema),
  preservationRequirements: z.array(constraintSchema),
  lengthConstraints: z.array(lengthConstraintSchema),
  exactConstraints: z.array(exactConstraintSchema)
});

export const effectiveLengthConstraintSchema = z.strictObject({
  constraintId: identifierSchema,
  unit: z.enum(['words', 'characters', 'lines']),
  minimum: z.int().nonnegative().optional(),
  maximum: z.int().nonnegative().optional(),
  requirement: z.enum(['required', 'advisory']),
  criterionIds: z.array(identifierSchema),
  sourceConstraintIds: z.array(identifierSchema).min(1),
  targetResourceIds: z.array(identifierSchema).min(1)
}).superRefine((value, context) => {
  if (value.minimum === undefined && value.maximum === undefined) context.addIssue({ code: 'custom', message: 'An effective length constraint requires a minimum or maximum.' });
  if (value.minimum !== undefined && value.maximum !== undefined && value.minimum > value.maximum) context.addIssue({ code: 'custom', message: 'Effective length constraints do not intersect.' });
});

export const effectiveExactConstraintSchema = z.strictObject({
  constraintId: identifierSchema,
  matcher: z.enum(['number', 'citation', 'named-entity']),
  allowedValues: z.array(z.string().trim().min(1).max(10_000)),
  baselinePolicy: z.enum(['exclude', 'include']),
  requirement: z.enum(['required', 'advisory']),
  criterionIds: z.array(identifierSchema),
  sourceConstraintIds: z.array(identifierSchema).min(1),
  targetResourceIds: z.array(identifierSchema).min(1)
});

export const effectiveConstraintSetSchema = z.strictObject({
  lengthConstraints: z.array(effectiveLengthConstraintSchema),
  exactConstraints: z.array(effectiveExactConstraintSchema)
});

export const operationSnapshotSchema = z.strictObject({
  providerId: identifierSchema,
  providerImplementationId: identifierSchema,
  modelId: z.string().trim().min(1).max(1_000),
  intentRegistryImplementationId: identifierSchema,
  contextPolicyId: identifierSchema,
  contextPolicyVersion: z.int().min(1),
  toolImplementationIds: z.array(identifierSchema),
  checkImplementationIds: z.array(identifierSchema),
  dispositionImplementationId: identifierSchema,
  authorizationPolicyId: identifierSchema,
  configurationSha256: sha256Schema
});

export const writingOperationSchema = z.strictObject({
  projectId: identifierSchema,
  operationId: identifierSchema,
  briefRevisionId: identifierSchema,
  kind: writingOperationKindSchema,
  instruction: z.string().trim().min(1).max(100_000),
  intents: z.array(writingIntentSchema).min(1),
  targetNodeIds: z.array(identifierSchema),
  targetResourceIds: z.array(identifierSchema),
  effectiveConstraints: effectiveConstraintSetSchema,
  baseProjectRevisionId: identifierSchema,
  mode: writingOperationModeSchema,
  sessionId: identifierSchema,
  runId: identifierSchema,
  lifecycleState: z.literal('admitted'),
  snapshot: operationSnapshotSchema,
  admittedAt: timestampSchema
});

export const documentNodeSchema = z.strictObject({
  nodeId: identifierSchema,
  kind: z.string().trim().min(1).max(256),
  parentId: identifierSchema.nullable(),
  siblingOrder: z.int().nonnegative(),
  title: z.string().max(10_000).optional(),
  purpose: z.string().trim().min(1).max(100_000),
  status: z.enum(['planned', 'drafting', 'review', 'complete', 'removed']),
  targetLength: lengthConstraintSchema.optional(),
  resourceId: identifierSchema.optional()
});

export const relationEdgeSchema = z.strictObject({
  relationId: identifierSchema,
  kind: z.string().trim().min(1).max(256),
  sourceId: identifierSchema,
  targetId: identifierSchema,
  purpose: z.string().trim().min(1).max(10_000),
  status: z.enum(['active', 'superseded', 'removed'])
});

export const protectedRangeSchema = z.strictObject({
  rangeId: identifierSchema,
  range: textRangeSchema,
  sha256: sha256Schema,
  reason: z.string().trim().min(1).max(10_000),
  decisionRequired: z.boolean()
});

export const managedTextResourceSchema = z.strictObject({
  resourceId: identifierSchema,
  relativePath: z.string().trim().min(1).max(4_096),
  mediaType: z.string().trim().min(1).max(256),
  role: z.string().trim().min(1).max(256),
  ownership: z.enum(['user-owned', 'agent-owned', 'imported-source']),
  currentSha256: sha256Schema,
  protectedRanges: z.array(protectedRangeSchema),
  currentProjectRevisionId: identifierSchema
});

export const sourceExcerptSchema = z.strictObject({
  excerptId: identifierSchema,
  resourceId: identifierSchema,
  sourceRevisionSha256: sha256Schema,
  range: textRangeSchema,
  rangeSha256: sha256Schema,
  textSha256: sha256Schema
});

export const sourceRecordSchema = z.strictObject({
  sourceId: identifierSchema,
  kind: z.string().trim().min(1).max(256),
  title: z.string().trim().min(1).max(10_000).optional(),
  authors: z.array(z.string().trim().min(1).max(1_000)),
  date: z.string().trim().min(1).max(256).optional(),
  localResourceId: identifierSchema.optional(),
  artifactId: identifierSchema.optional(),
  exactSha256: sha256Schema,
  accessMetadata: z.record(z.string(), z.json()).optional(),
  rightsMetadata: z.record(z.string(), z.json()).optional(),
  identityStatus: z.enum(['unverified', 'verified', 'conflicting', 'unavailable']),
  authoritativeIdentifiers: z.array(z.strictObject({ scheme: identifierSchema, value: z.string().trim().min(1).max(10_000), evidence: z.string().trim().min(1).max(100_000) })),
  identityVerifierId: identifierSchema.optional(),
  verificationPolicyId: identifierSchema.optional(),
  excerpts: z.array(sourceExcerptSchema),
  contradictions: z.array(z.string().trim().min(1).max(100_000)),
  unsupportedFindings: z.array(z.string().trim().min(1).max(100_000)),
  omittedRelevantEvidenceFindings: z.array(z.string().trim().min(1).max(100_000)),
  addedAt: timestampSchema
});

export const claimSchema = z.strictObject({
  claimId: identifierSchema,
  version: z.int().min(1),
  statement: z.string().trim().min(1).max(100_000),
  scope: z.string().trim().min(1).max(10_000),
  origin: z.enum(['user', 'source', 'model', 'application']),
  status: z.enum(['proposed', 'adopted', 'superseded', 'rejected']),
  projectRevisionId: identifierSchema
});

export const claimEvidenceRelationSchema = z.strictObject({
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
  criterionEvidence: z.array(z.strictObject({ criterionId: identifierSchema, evidence: z.string().trim().min(1).max(100_000), explanation: z.string().trim().min(1).max(100_000) })),
  humanDecisionId: identifierSchema.optional()
});

export const voiceReferenceSchema = z.strictObject({
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
  preserveNotes: z.array(z.string().trim().min(1).max(10_000)),
  doNotImitateNotes: z.array(z.string().trim().min(1).max(10_000)),
  retentionStatus: z.enum(['retained', 'deletion-requested', 'deleted'])
}).superRefine((value, context) => {
  if (Number(value.resourceId !== undefined) + Number(value.artifactId !== undefined) !== 1) {
    context.addIssue({ code: 'custom', message: 'Voice reference requires exactly one resource or artifact identity.' });
  }
});

export const authorshipProvenanceSchema = z.strictObject({
  provenanceId: identifierSchema,
  projectRevisionId: identifierSchema,
  resourceId: identifierSchema.optional(),
  nodeId: identifierSchema.optional(),
  range: textRangeSchema.optional(),
  structuralObjectId: identifierSchema.optional(),
  operationId: identifierSchema,
  proposalId: identifierSchema.optional(),
  classification: z.enum(['human-authored', 'imported', 'model-suggested', 'user-accepted-unchanged', 'user-modified']),
  supersedesProvenanceIds: z.array(identifierSchema),
  createdAt: timestampSchema
}).superRefine((value, context) => {
  const targetCount = Number(value.resourceId !== undefined && value.range !== undefined) + Number(value.nodeId !== undefined && value.structuralObjectId !== undefined);
  if (targetCount !== 1) context.addIssue({ code: 'custom', message: 'Authorship provenance requires exactly one range or structural target.' });
});

export const localizedTextEditSchema = z.strictObject({
  resourceId: identifierSchema,
  baseSha256: sha256Schema,
  edits: z.array(z.strictObject({
    anchorId: identifierSchema,
    range: textRangeSchema,
    expectedTextSha256: sha256Schema,
    replacementText: z.string()
  })).min(1)
});

export const structuralChangeSchema = z.strictObject({
  changeId: identifierSchema,
  kind: z.enum(['create', 'remove', 'reorder', 'split', 'merge', 'purpose', 'relation']),
  targetIds: z.array(identifierSchema).min(1),
  value: z.record(z.string(), z.json())
});

export const semanticChangeItemSchema = z.strictObject({
  itemId: identifierSchema,
  kind: z.enum(['claim', 'citation', 'evidence-relation', 'referent', 'stance', 'obligation', 'chronology', 'terminology', 'structural-relation']),
  action: z.enum(['introduce', 'modify', 'remove']),
  scope: z.string().trim().min(1).max(10_000),
  targetId: identifierSchema.optional(),
  statement: z.string().trim().min(1).max(100_000)
});

export const semanticChangeDeclarationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('changes'), items: z.array(semanticChangeItemSchema).min(1) })
]);

export const deterministicCheckSchema = z.strictObject({
  checkId: identifierSchema,
  implementationId: identifierSchema,
  criterionIds: z.array(identifierSchema),
  requirement: z.enum(['required', 'advisory']),
  verdict: z.enum(['passed', 'failed', 'unknown']),
  summary: z.string().trim().min(1).max(100_000),
  evidence: z.array(z.string().max(100_000)),
  inputSha256: sha256Schema
});

export const criterionCoverageSchema = z.strictObject({
  criterionId: identifierSchema,
  requirement: z.enum(['required', 'advisory']),
  verificationKind: z.enum(['deterministic', 'editorial', 'human']),
  verdict: z.enum(['passed', 'failed', 'unknown']),
  coverage: z.enum(['complete', 'partial', 'none']),
  evaluatorIds: z.array(identifierSchema),
  evidenceIds: z.array(identifierSchema),
  explanation: z.string().trim().min(1).max(100_000)
});

export const humanCriterionDecisionSchema = z.strictObject({
  criterionId: identifierSchema,
  verdict: z.enum(['passed', 'failed']),
  explanation: z.string().trim().min(1).max(100_000)
});

export const editorialFindingSchema = z.strictObject({
  findingId: identifierSchema,
  criterionId: identifierSchema,
  scope: z.string().trim().min(1).max(10_000),
  severity: z.enum(['required', 'advisory']),
  verdict: z.enum(['passed', 'failed', 'unknown']),
  evidenceRanges: z.array(z.strictObject({ resourceId: identifierSchema, range: textRangeSchema, sha256: sha256Schema })),
  explanation: z.string().trim().min(1).max(100_000),
  evaluatorId: identifierSchema,
  calibrationId: identifierSchema.optional(),
  verificationPolicyId: identifierSchema,
  evaluationInputSha256: sha256Schema,
  baseRevisionId: identifierSchema,
  candidateRevisionId: identifierSchema,
  coverage: z.enum(['complete', 'partial', 'unknown'])
});

export const semanticPreservationFindingSchema = z.strictObject({
  findingId: identifierSchema,
  scope: z.string().trim().min(1).max(10_000),
  requirement: z.enum(['required', 'advisory']),
  verdict: z.enum(['passed', 'failed', 'unknown']),
  coverage: z.enum(['complete', 'partial', 'unknown']),
  evidenceRanges: z.array(z.strictObject({ resourceId: identifierSchema, range: textRangeSchema, sha256: sha256Schema })),
  intendedChanges: z.array(identifierSchema),
  observedChanges: z.array(z.string().max(100_000)),
  unexplainedChanges: z.array(z.string().max(100_000)),
  lostPriorEditIds: z.array(identifierSchema),
  evaluatorId: identifierSchema,
  verificationPolicyId: identifierSchema,
  calibrationId: identifierSchema.optional(),
  evaluationInputSha256: sha256Schema,
  baseRevisionId: identifierSchema,
  candidateRevisionId: identifierSchema,
  explanation: z.string().trim().min(1).max(100_000)
});

export const preservationContractSchema = z.strictObject({
  allowedResourceIds: z.array(identifierSchema),
  allowedNodeIds: z.array(identifierSchema),
  allowedRangeIds: z.array(identifierSchema),
  allowedStructuralObjectIds: z.array(identifierSchema),
  protectedResourceHashes: z.record(identifierSchema, sha256Schema),
  protectedRangeIds: z.array(identifierSchema),
  protectedCriterionIds: z.array(identifierSchema),
  protectedClaimIds: z.array(identifierSchema),
  protectedEvidenceRelationIds: z.array(identifierSchema),
  protectedEditorialDecisionIds: z.array(identifierSchema),
  priorAcceptedProposalIds: z.array(identifierSchema),
  priorRevisionIds: z.array(identifierSchema),
  allowedSemanticScopes: z.array(z.string().trim().min(1).max(10_000)),
  stableSemanticScopes: z.array(z.string().trim().min(1).max(10_000)),
  comparisonBaselineRevisionIds: z.array(identifierSchema).min(1),
  requiredRevalidations: z.array(identifierSchema)
});

export const contextReceiptSchema = z.strictObject({
  contextReceiptId: identifierSchema,
  policyId: identifierSchema,
  policyVersion: z.int().min(1),
  operationId: identifierSchema,
  selectedIntentIds: z.array(identifierSchema),
  intentCoverage: z.record(identifierSchema, z.enum(['complete', 'partial', 'none'])),
  tokenBudget: z.int().min(1),
  targetDescriptors: z.array(z.strictObject({
    resourceId: identifierSchema,
    relativePath: z.string().trim().min(1).max(4_096),
    baseSha256: sha256Schema,
    mediaType: z.string().trim().min(1).max(256),
    anchors: z.array(z.strictObject({
      anchorId: identifierSchema,
      kind: z.enum(['document', 'paragraph', 'protected-range']),
      targetRangeId: identifierSchema.optional(),
      range: textRangeSchema,
      textSha256: sha256Schema,
      label: z.string().trim().min(1).max(1_000)
    }))
  })),
  items: z.array(z.strictObject({
    itemId: identifierSchema,
    kind: identifierSchema,
    versionOrSha256: z.string().trim().min(1).max(1_000),
    range: textRangeSchema.optional(),
    trust: trustSchema,
    provenanceId: identifierSchema,
    reasonCodes: z.array(identifierSchema).min(1),
    content: z.string().max(2_000_000)
  })),
  omittedCounts: z.record(identifierSchema, z.int().nonnegative()),
  truncated: z.boolean(),
  coverage: z.enum(['complete', 'partial'])
});

export const revisionProposalSchema = z.strictObject({
  proposalId: identifierSchema,
  canonicalProposalSha256: sha256Schema,
  operationId: identifierSchema,
  baseProjectRevisionId: identifierSchema,
  affectedNodeIds: z.array(identifierSchema),
  affectedResourceIds: z.array(identifierSchema),
  textEdits: z.array(localizedTextEditSchema),
  structuralChanges: z.array(structuralChangeSchema),
  expectedBaseHashes: z.record(identifierSchema, sha256Schema),
  preservationContract: preservationContractSchema,
  semanticChangeDeclaration: semanticChangeDeclarationSchema,
  semanticPreservationFindings: z.array(semanticPreservationFindingSchema),
  proposedAuthorshipProvenance: z.array(authorshipProvenanceSchema),
  deterministicChecks: z.array(deterministicCheckSchema),
  editorialFindings: z.array(editorialFindingSchema),
  criterionCoverage: z.array(criterionCoverageSchema),
  contextReceiptId: identifierSchema,
  status: z.literal('proposed'),
  boundedRationale: z.string().max(10_000),
  createdAt: timestampSchema
});

export const editorialDecisionSchema = z.strictObject({
  decisionId: identifierSchema,
  projectRevisionId: identifierSchema,
  proposalId: identifierSchema.optional(),
  findingIds: z.array(identifierSchema),
  criterionDecisions: z.array(humanCriterionDecisionSchema),
  decision: z.enum(['accepted', 'rejected', 'override']),
  explanation: z.string().trim().min(1).max(100_000),
  actor: z.enum(['human', 'application']),
  createdAt: timestampSchema
});

export const projectRevisionSchema = z.strictObject({
  revisionId: identifierSchema,
  parentRevisionIds: z.array(identifierSchema),
  briefRevisionId: identifierSchema,
  documentTreeSha256: sha256Schema,
  relationGraphSha256: sha256Schema,
  resourceHashes: z.record(identifierSchema, sha256Schema),
  sourceClaimEvidenceGraphSha256: sha256Schema,
  authorshipProvenanceGraphSha256: sha256Schema,
  operationId: identifierSchema,
  runId: identifierSchema.optional(),
  editorialDecisionIds: z.array(identifierSchema),
  editorialFindingIds: z.array(identifierSchema),
  timestamp: timestampSchema
});

export const projectSnapshotSchema = z.strictObject({
  revision: projectRevisionSchema,
  brief: writingBriefRevisionSchema,
  nodes: z.array(documentNodeSchema),
  relations: z.array(relationEdgeSchema),
  resources: z.array(managedTextResourceSchema),
  sources: z.array(sourceRecordSchema),
  claims: z.array(claimSchema),
  evidenceRelations: z.array(claimEvidenceRelationSchema),
  voiceReferences: z.array(voiceReferenceSchema),
  authorshipProvenance: z.array(authorshipProvenanceSchema),
  editorialFindings: z.array(editorialFindingSchema),
  editorialDecisions: z.array(editorialDecisionSchema)
});

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
  readonly contextReceipt: ContextReceipt;
  readonly affectedResourceIds: readonly string[];
  readonly authorshipProvenanceChanges: readonly AuthorshipProvenance[];
  readonly remainingUncertainty: readonly string[];
  readonly candidateMessage?: string;
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
export type HumanCriterionDecision = z.infer<typeof humanCriterionDecisionSchema>;
export type EditorialFinding = z.infer<typeof editorialFindingSchema>;
export type EditorialDecision = z.infer<typeof editorialDecisionSchema>;
export type PreservationContract = z.infer<typeof preservationContractSchema>;
export type ContextReceipt = z.infer<typeof contextReceiptSchema>;
export type RevisionProposal = z.infer<typeof revisionProposalSchema>;
export type ProjectRevision = z.infer<typeof projectRevisionSchema>;
export type ProjectSnapshot = z.infer<typeof projectSnapshotSchema>;

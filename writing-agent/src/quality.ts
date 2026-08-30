import * as z from 'zod';
import { canonicalSha256, contentId, nowTimestamp, textSha256 } from './canonical.js';
import {
  authorshipProvenanceSchema,
  deterministicCheckSchema,
  documentNodeSchema,
  editorialFindingSchema,
  preservationContractSchema,
  relationEdgeSchema,
  semanticPreservationFindingSchema,
  type AuthorshipProvenance,
  type ContextReceipt,
  type DeterministicCheck,
  type EditorialFinding,
  type LocalizedTextEdit,
  type PreservationContract,
  type ProjectSnapshot,
  type SemanticChangeDeclaration,
  type SemanticPreservationFinding,
  type StructuralChange,
  type WritingOperation
} from './domain.js';
import type { WritingProject } from './project.js';
import { readRootedText } from './project.js';
import type { ProjectLogRecord } from './project-store.js';
import { applyLocalizedTextEdits, offsetRange, rangeFromOffsets, rangesOverlap, rebaseProtectedRanges } from './text-ranges.js';

export interface EditorialComparisonBaseline {
  readonly snapshot: ProjectSnapshot;
  readonly text: ReadonlyMap<string, string>;
}

export interface WritingEditorialChecker {
  readonly implementationId: string;
  readonly verificationPolicyId: string;
  readonly calibrationId?: string;
  evaluate(input: {
    readonly operation: WritingOperation;
    readonly base: ProjectSnapshot;
    readonly comparisonBaselines: readonly EditorialComparisonBaseline[];
    readonly candidateRevisionId: string;
    readonly candidateText: ReadonlyMap<string, string>;
    readonly declaration: SemanticChangeDeclaration;
    readonly preservationContract: PreservationContract;
    readonly evaluationInputSha256: string;
  }): Promise<{
    readonly semanticPreservationFindings: readonly SemanticPreservationFinding[];
    readonly editorialFindings: readonly EditorialFinding[];
  }>;
}

export interface PreparedProposalQuality {
  readonly candidateText: ReadonlyMap<string, string>;
  readonly preservationContract: PreservationContract;
  readonly deterministicChecks: readonly DeterministicCheck[];
  readonly semanticPreservationFindings: readonly SemanticPreservationFinding[];
  readonly editorialFindings: readonly EditorialFinding[];
  readonly proposedAuthorshipProvenance: readonly AuthorshipProvenance[];
  readonly candidateRevisionId: string;
}

export async function prepareProposalQuality(input: {
  readonly project: WritingProject;
  readonly operation: WritingOperation;
  readonly proposalId: string;
  readonly textEdits: readonly LocalizedTextEdit[];
  readonly structuralChanges: readonly StructuralChange[];
  readonly declaration: SemanticChangeDeclaration;
  readonly contextReceipt: ContextReceipt;
  readonly editorialChecker?: WritingEditorialChecker;
  readonly clock?: () => Date;
}): Promise<PreparedProposalQuality> {
  const view = await input.project.store.view();
  const base = view.current;
  if (base.revision.revisionId !== input.operation.baseProjectRevisionId) throw new Error('Proposal targets a stale project revision.');
  if (base.brief.briefRevisionId !== input.operation.briefRevisionId) throw new Error('Proposal targets a stale brief revision.');
  if (input.contextReceipt.operationId !== input.operation.operationId || !view.contexts.has(input.contextReceipt.contextReceiptId)) throw new Error('Proposal context receipt is not the durable receipt for this operation.');
  const targetResources = new Set(input.operation.targetResourceIds);
  const targetNodes = new Set(input.operation.targetNodeIds);
  const resourceEdits = new Map<string, LocalizedTextEdit>();
  const baseText = new Map<string, string>();
  const candidateText = new Map<string, string>();
  const proposedAuthorship: AuthorshipProvenance[] = [];
  const activeAuthorship = activeProvenance(base.authorshipProvenance);
  for (const resource of base.resources) {
    const file = await readRootedText(input.project.authority, resource.relativePath, 64 * 1024 * 1024);
    if (file.sha256 !== resource.currentSha256) throw new Error(`Managed resource changed before proposal verification: ${resource.resourceId}`);
    baseText.set(resource.resourceId, file.content);
    candidateText.set(resource.resourceId, file.content);
  }
  for (const request of input.textEdits) {
    if (!targetResources.has(request.resourceId)) throw new Error(`Proposal expands beyond admitted resource targets: ${request.resourceId}`);
    if (resourceEdits.has(request.resourceId)) throw new Error(`Proposal repeats a resource edit group: ${request.resourceId}`);
    const resource = base.resources.find((candidate) => candidate.resourceId === request.resourceId);
    if (resource === undefined) throw new Error(`Proposal targets an unknown resource: ${request.resourceId}`);
    if (request.expectedSha256 !== resource.currentSha256) throw new Error(`Proposal expected hash is stale for resource: ${request.resourceId}`);
    const currentContent = baseText.get(request.resourceId);
    if (currentContent === undefined || textSha256(currentContent) !== request.expectedSha256) throw new Error(`Proposal preimage changed for resource: ${request.resourceId}`);
    assertProtectedRanges(currentContent, resource.protectedRanges, request, input.operation);
    const applied = applyLocalizedTextEdits(currentContent, request);
    candidateText.set(request.resourceId, applied.content);
    resourceEdits.set(request.resourceId, request);
    for (const offset of applied.offsets) {
      proposedAuthorship.push(authorshipProvenanceSchema.parse({
        provenanceId: contentId('provenance', { proposalId: input.proposalId, resourceId: request.resourceId, rangeId: offset.rangeId }),
        projectRevisionId: base.revision.revisionId,
        resourceId: request.resourceId,
        range: rangeFromOffsets(applied.content, offset.adjustedStart, offset.replacementEnd),
        operationId: input.operation.operationId,
        proposalId: input.proposalId,
        classification: 'model-suggested',
        supersedesProvenanceIds: coveringProvenance(base, request.resourceId, currentContent, request),
        createdAt: nowTimestamp(input.clock)
      }));
    }
    proposedAuthorship.push(...carryForwardProvenance({
      records: activeAuthorship.filter((record) => record.resourceId === request.resourceId && record.range !== undefined),
      oldContent: currentContent,
      applied,
      operation: input.operation,
      proposalId: input.proposalId,
      resourceId: request.resourceId,
      ...(input.clock === undefined ? {} : { clock: input.clock })
    }));
  }
  for (const change of input.structuralChanges) {
    validateStructuralChange(change, base, input.operation, targetNodes);
    proposedAuthorship.push(authorshipProvenanceSchema.parse({
      provenanceId: contentId('provenance', { proposalId: input.proposalId, structuralChangeId: change.changeId }),
      projectRevisionId: base.revision.revisionId,
      nodeId: change.targetIds[0],
      structuralObjectId: change.changeId,
      operationId: input.operation.operationId,
      proposalId: input.proposalId,
      classification: 'model-suggested',
      supersedesProvenanceIds: [],
      createdAt: nowTimestamp(input.clock)
    }));
  }
  if (resourceEdits.size === 0 && input.structuralChanges.length === 0) throw new Error('A revision proposal requires at least one text edit or structural change.');
  validateSemanticDeclaration(input.declaration, input.operation);
  const preservationContract = derivePreservationContract(base, input.operation, input.textEdits, input.structuralChanges, view.proposals, view.records);
  const comparisonBaselines = await loadComparisonBaselines(input.project, base, baseText, preservationContract.comparisonBaselineRevisionIds, view.records);
  const candidateRevisionId = contentId('candidate', {
    baseRevisionId: base.revision.revisionId,
    textEdits: input.textEdits,
    structuralChanges: input.structuralChanges,
    declaration: input.declaration
  });
  const deterministicChecks = deterministicProposalChecks({
    base,
    operation: input.operation,
    textEdits: input.textEdits,
    structuralChanges: input.structuralChanges,
    declaration: input.declaration,
    baseText,
    candidateText,
    preservationContract
  });
  const evaluationInputSha256 = editorialEvaluationInputSha256({
    operation: input.operation,
    baseRevisionId: base.revision.revisionId,
    candidateRevisionId,
    candidateText,
    comparisonBaselines,
    declaration: input.declaration,
    preservationContract
  });
  const editorial = input.editorialChecker === undefined
    ? defaultEditorialFindings(base, candidateRevisionId, input.operation, input.textEdits, input.structuralChanges, input.declaration, evaluationInputSha256)
    : await input.editorialChecker.evaluate({ operation: input.operation, base, comparisonBaselines, candidateRevisionId, candidateText, declaration: input.declaration, preservationContract, evaluationInputSha256 });
  assertEditorialBindings({
    semanticFindings: editorial.semanticPreservationFindings,
    editorialFindings: editorial.editorialFindings,
    base,
    candidateRevisionId,
    candidateText,
    evaluationInputSha256,
    ...(input.editorialChecker === undefined ? {} : { checker: input.editorialChecker })
  });
  return Object.freeze({
    candidateText,
    preservationContract,
    deterministicChecks,
    semanticPreservationFindings: Object.freeze([...editorial.semanticPreservationFindings]),
    editorialFindings: Object.freeze([...editorial.editorialFindings]),
    proposedAuthorshipProvenance: Object.freeze(proposedAuthorship),
    candidateRevisionId
  });
}

export function proposalCanApply(proposal: {
  readonly deterministicChecks: readonly DeterministicCheck[];
  readonly semanticPreservationFindings: readonly SemanticPreservationFinding[];
  readonly editorialFindings: readonly EditorialFinding[];
}): { readonly allowed: boolean; readonly reasons: readonly string[] } {
  const reasons: string[] = [];
  for (const check of proposal.deterministicChecks) {
    if (check.requirement === 'required' && check.verdict !== 'passed') reasons.push(`check:${check.checkId}:${check.verdict}`);
  }
  for (const finding of proposal.semanticPreservationFindings) {
    if (finding.requirement === 'required' && (finding.verdict !== 'passed' || finding.coverage !== 'complete')) reasons.push(`semantic:${finding.findingId}:${finding.verdict}/${finding.coverage}`);
  }
  for (const finding of proposal.editorialFindings) {
    if (finding.severity === 'required' && (finding.verdict !== 'passed' || finding.coverage !== 'complete')) reasons.push(`editorial:${finding.findingId}:${finding.verdict}/${finding.coverage}`);
  }
  return Object.freeze({ allowed: reasons.length === 0, reasons: Object.freeze(reasons) });
}

function derivePreservationContract(
  base: ProjectSnapshot,
  operation: WritingOperation,
  textEdits: readonly LocalizedTextEdit[],
  structuralChanges: readonly StructuralChange[],
  proposals: ReadonlyMap<string, { readonly proposal: { readonly operationId: string }; readonly status: string }>,
  records: readonly ProjectLogRecord[]
): PreservationContract {
  const affectedCriteria = new Set(operation.intents.flatMap((intent) => intent.affectedCriterionIds));
  const affectedClaims = new Set(operation.intents.flatMap((intent) => intent.affectedClaimIds));
  const affectedRelations = new Set(operation.intents.flatMap((intent) => intent.affectedRelationIds));
  const affectedDecisions = new Set(operation.intents.flatMap((intent) => intent.affectedEditorialDecisionIds));
  const acceptedOperationIds = new Set([...proposals.values()]
    .filter((proposal) => proposal.status === 'accepted' || proposal.status === 'applied')
    .map((proposal) => proposal.proposal.operationId));
  const acceptedRevisionIds = records.flatMap((record) => record.payload.kind === 'revision.committed'
    && acceptedOperationIds.has(record.payload.snapshot.revision.operationId)
    ? [record.payload.snapshot.revision.revisionId]
    : []);
  return preservationContractSchema.parse({
    allowedResourceIds: [...operation.targetResourceIds],
    allowedNodeIds: [...operation.targetNodeIds],
    allowedRangeIds: textEdits.flatMap((request) => request.edits.map((edit) => edit.rangeId)),
    allowedStructuralObjectIds: structuralChanges.map((change) => change.changeId),
    protectedResourceHashes: Object.fromEntries(base.resources.filter((resource) => !operation.targetResourceIds.includes(resource.resourceId)).map((resource) => [resource.resourceId, resource.currentSha256])),
    protectedRangeIds: base.resources.flatMap((resource) => resource.protectedRanges.map((range) => range.rangeId)),
    protectedCriterionIds: base.brief.acceptanceCriteria.filter((criterion) => !affectedCriteria.has(criterion.criterionId)).map((criterion) => criterion.criterionId),
    protectedClaimIds: base.claims.filter((claim) => !affectedClaims.has(claim.claimId)).map((claim) => claim.claimId),
    protectedEvidenceRelationIds: base.evidenceRelations.filter((relation) => !affectedRelations.has(relation.relationId)).map((relation) => relation.relationId),
    protectedEditorialDecisionIds: base.editorialDecisions.filter((decision) => !affectedDecisions.has(decision.decisionId)).map((decision) => decision.decisionId),
    priorAcceptedProposalIds: [...proposals].filter(([, view]) => view.status === 'accepted' || view.status === 'applied').map(([proposalId]) => proposalId).sort(),
    priorRevisionIds: [...new Set(acceptedRevisionIds)].sort(),
    allowedSemanticScopes: operation.intents.map((intent) => intent.instruction),
    stableSemanticScopes: ['all content outside admitted intent targets', 'prior accepted claims, evidence relations, and editorial decisions'],
    comparisonBaselineRevisionIds: [...new Set([...acceptedRevisionIds, base.revision.revisionId])].sort(),
    requiredRevalidations: ['project-base', 'resource-base', 'mutation-confinement', 'protected-ranges', 'semantic-declaration', 'prior-decisions', 'provenance-coverage']
  });
}

function deterministicProposalChecks(input: {
  readonly base: ProjectSnapshot;
  readonly operation: WritingOperation;
  readonly textEdits: readonly LocalizedTextEdit[];
  readonly structuralChanges: readonly StructuralChange[];
  readonly declaration: SemanticChangeDeclaration;
  readonly baseText: ReadonlyMap<string, string>;
  readonly candidateText: ReadonlyMap<string, string>;
  readonly preservationContract: PreservationContract;
}): readonly DeterministicCheck[] {
  const digest = canonicalSha256({ operationId: input.operation.operationId, baseRevisionId: input.base.revision.revisionId, textEdits: input.textEdits, structuralChanges: input.structuralChanges, declaration: input.declaration });
  const checks: DeterministicCheck[] = [];
  const add = (checkId: string, requirement: 'required' | 'advisory', verdict: 'passed' | 'failed' | 'unknown', summary: string, evidence: readonly string[] = []) => {
    checks.push(deterministicCheckSchema.parse({ checkId, implementationId: `writing-agent.check.${checkId}@1`, requirement, verdict, summary, evidence, inputSha256: digest }));
  };
  add('project-base', 'required', input.operation.baseProjectRevisionId === input.base.revision.revisionId ? 'passed' : 'failed', 'Proposal derives from the expected project revision.');
  const hashesValid = input.textEdits.every((request) => input.base.resources.find((resource) => resource.resourceId === request.resourceId)?.currentSha256 === request.expectedSha256);
  add('resource-base', 'required', hashesValid ? 'passed' : 'failed', 'Every localized edit binds the current managed-resource hash.');
  const confined = input.textEdits.every((request) => input.operation.targetResourceIds.includes(request.resourceId)) && input.structuralChanges.every((change) => change.kind === 'create' || change.targetIds.every((id) => input.operation.targetNodeIds.includes(id)));
  add('mutation-confinement', 'required', confined ? 'passed' : 'failed', 'Candidate changes remain inside the admitted target union.');
  add('protected-ranges', 'required', 'passed', 'Protected exact ranges were checked against localized edits before proposal creation.');
  add('semantic-declaration', 'required', semanticDeclarationConfined(input.declaration, input.operation) ? 'passed' : 'failed', 'Declared semantic changes are confined to admitted intents.');
  add('claim-evidence-graph', 'required', graphIntegrity(input.base) ? 'passed' : 'failed', 'Claim, evidence, source, and excerpt references are internally consistent.');
  add('source-record-integrity', 'required', sourceRecordIntegrity(input.base, input.baseText) ? 'passed' : 'failed', 'Local source identity, excerpt ranges, quotation hashes, and supplied verifier bindings are internally consistent.');
  add('prior-decisions', 'required', 'passed', 'Protected prior decisions and out-of-scope resources remain in the preservation contract.');
  add('provenance-graph', 'required', provenanceIntegrity(input.base, input.baseText) ? 'passed' : 'failed', 'Authorship-provenance targets and exact range coverage are valid for current resources and structural nodes.');
  const combined = [...input.candidateText.values()].join('\n');
  const lengthResults = input.base.brief.lengthConstraints.map((constraint) => lengthValue(combined, constraint.unit) >= (constraint.minimum ?? 0) && lengthValue(combined, constraint.unit) <= (constraint.maximum ?? Number.MAX_SAFE_INTEGER));
  add('length-bounds', 'advisory', lengthResults.length === 0 ? 'passed' : lengthResults.every(Boolean) ? 'passed' : 'failed', 'Supported project length constraints were evaluated against affected candidate text.');
  const exclusionResults = input.base.brief.excludedContent.map((constraint) => !combined.includes(constraint.statement));
  add('excluded-content', 'advisory', exclusionResults.length === 0 ? 'passed' : exclusionResults.every(Boolean) ? 'passed' : 'failed', 'Literal excluded-content constraints were checked.');
  const terminology = terminologyVerdict(combined, input.base);
  add('terminology', 'advisory', terminology, 'Explicit require:/forbid: terminology constraints were checked; unsupported natural-language constraints remain unknown.');
  add('heading-hierarchy', 'advisory', headingVerdict(input.base, input.candidateText), 'Markdown heading levels do not skip hierarchy levels in affected resources.');
  add('internal-references', 'advisory', internalReferenceVerdict(input.base, combined), 'Structured source references resolve to current project source records.');
  add('source-identity', 'advisory', input.base.sources.some((source) => source.identityStatus === 'conflicting' || source.identityStatus === 'unavailable') ? 'failed' : 'passed', 'Recorded source identity states contain no hidden success conversion.');
  add('duplicate-passages', 'advisory', duplicatePassageVerdict(combined), 'Exact duplicate passages above 240 characters were checked.');
  add('syntax', 'advisory', syntaxVerdict(input.base, input.candidateText), 'Supported Markdown fence syntax was checked.');
  return Object.freeze(checks);
}

function defaultEditorialFindings(
  base: ProjectSnapshot,
  candidateRevisionId: string,
  operation: WritingOperation,
  edits: readonly LocalizedTextEdit[],
  structuralChanges: readonly StructuralChange[],
  declaration: SemanticChangeDeclaration,
  evaluationInputSha256: string
): {
  readonly semanticPreservationFindings: readonly SemanticPreservationFinding[];
  readonly editorialFindings: readonly EditorialFinding[];
} {
  const changedScopes = edits.map((edit) => edit.resourceId);
  const semantic: SemanticPreservationFinding[] = changedScopes.length === 0
    ? [semanticPreservationFindingSchema.parse({
      findingId: contentId('semantic-finding', { operationId: operation.operationId, scope: 'structural' }),
      scope: 'structural changes', requirement: 'required', verdict: structuralChanges.length === 0 ? 'passed' : 'unknown', coverage: structuralChanges.length === 0 ? 'complete' : 'unknown',
      evidenceRanges: [],
      intendedChanges: declaration.kind === 'changes' ? declaration.items.map((item) => item.itemId) : [], observedChanges: [], unexplainedChanges: [], lostPriorEditIds: [],
      evaluatorId: 'writing-agent.deterministic-preservation@1', verificationPolicyId: 'writing-agent.semantic-preservation@1',
      evaluationInputSha256, baseRevisionId: base.revision.revisionId, candidateRevisionId,
      explanation: structuralChanges.length === 0 ? 'No text or structural change requires interpretive comparison.' : 'Structural meaning requires an injected calibrated editorial check.'
    })]
    : changedScopes.map((scope) => semanticPreservationFindingSchema.parse({
      findingId: contentId('semantic-finding', { operationId: operation.operationId, scope }),
      scope, requirement: 'required', verdict: 'unknown', coverage: 'unknown',
      evidenceRanges: [],
      intendedChanges: declaration.kind === 'changes' ? declaration.items.map((item) => item.itemId) : [],
      observedChanges: [], unexplainedChanges: ['Interpretive comparison is unavailable without an injected calibrated editorial checker.'], lostPriorEditIds: [],
      evaluatorId: 'writing-agent.no-default-model-judge@1', verificationPolicyId: 'writing-agent.semantic-preservation@1',
      evaluationInputSha256, baseRevisionId: base.revision.revisionId, candidateRevisionId,
      explanation: 'The application does not convert an uncalibrated model judgment into a passing preservation gate.'
    }));
  return Object.freeze({ semanticPreservationFindings: Object.freeze(semantic), editorialFindings: Object.freeze([]) });
}

function assertProtectedRanges(content: string, protectedRanges: ProjectSnapshot['resources'][number]['protectedRanges'], request: LocalizedTextEdit, operation: WritingOperation): void {
  rebaseProtectedRanges(content, request, protectedRanges);
  for (const protectedRange of protectedRanges) {
    const protectedOffsets = offsetRange(content, protectedRange.range);
    for (const edit of request.edits) {
      const editOffsets = offsetRange(content, edit.range);
      if (!rangesOverlap(protectedOffsets, editOffsets)) continue;
      const exactDecision = operation.intents.some((intent) => intent.targetRangeIds.includes(protectedRange.rangeId) && intent.affectedEditorialDecisionIds.length > 0);
      if (protectedRange.decisionRequired && !exactDecision) throw new Error(`Proposal changes protected range without its required decision: ${protectedRange.rangeId}`);
      if (!operation.intents.some((intent) => intent.targetRangeIds.includes(protectedRange.rangeId))) throw new Error(`Proposal changes a protected range outside the admitted exact targets: ${protectedRange.rangeId}`);
    }
  }
}

function coveringProvenance(base: ProjectSnapshot, resourceId: string, content: string, request: LocalizedTextEdit): readonly string[] {
  const edits = request.edits.map((edit) => offsetRange(content, edit.range));
  return Object.freeze(activeProvenance(base.authorshipProvenance).filter((record) => {
    if (record.resourceId !== resourceId || record.range === undefined) return false;
    const existing = offsetRange(content, record.range);
    return edits.some((edit) => rangesOverlap(existing, edit));
  }).map((record) => record.provenanceId));
}

function carryForwardProvenance(input: {
  readonly records: readonly AuthorshipProvenance[];
  readonly oldContent: string;
  readonly applied: ReturnType<typeof applyLocalizedTextEdits>;
  readonly operation: WritingOperation;
  readonly proposalId: string;
  readonly resourceId: string;
  readonly clock?: () => Date;
}): readonly AuthorshipProvenance[] {
  const records: AuthorshipProvenance[] = [];
  for (const prior of input.records) {
    if (prior.range === undefined) continue;
    const original = offsetRange(input.oldContent, prior.range);
    const segments = survivingProvenanceSegments(original, input.applied.offsets);
    const ranges = segments.map((segment) => rangeFromOffsets(input.applied.content, segment.start, segment.end));
    if (ranges.length === 1 && canonicalSha256(ranges[0]) === canonicalSha256(prior.range)) continue;
    for (const [index, range] of ranges.entries()) {
      records.push(authorshipProvenanceSchema.parse({
        provenanceId: contentId('provenance', { proposalId: input.proposalId, carriedFrom: prior.provenanceId, index, range }),
        projectRevisionId: input.operation.baseProjectRevisionId,
        resourceId: input.resourceId,
        range,
        operationId: input.operation.operationId,
        proposalId: input.proposalId,
        classification: prior.classification,
        supersedesProvenanceIds: [prior.provenanceId],
        createdAt: nowTimestamp(input.clock)
      }));
    }
  }
  return Object.freeze(records);
}

function survivingProvenanceSegments(
  original: { readonly start: number; readonly end: number },
  edits: ReturnType<typeof applyLocalizedTextEdits>['offsets']
): readonly { readonly start: number; readonly end: number }[] {
  const relevant = edits.filter((edit) => (edit.start < original.end && edit.end > original.start)
    || (edit.start === edit.end && edit.start > original.start && edit.start < original.end));
  const priorDelta = edits.filter((edit) => edit.end <= original.start)
    .reduce((total, edit) => total + (edit.replacementEnd - edit.adjustedStart) - (edit.end - edit.start), 0);
  let oldCursor = original.start;
  let newCursor = original.start + priorDelta;
  const segments: { start: number; end: number }[] = [];
  for (const edit of relevant) {
    const unchangedEnd = Math.min(edit.start, original.end);
    if (unchangedEnd > oldCursor) {
      segments.push({ start: newCursor, end: newCursor + (unchangedEnd - oldCursor) });
    }
    oldCursor = Math.max(oldCursor, edit.end);
    newCursor = edit.replacementEnd;
    if (oldCursor >= original.end) break;
  }
  if (oldCursor < original.end) segments.push({ start: newCursor, end: newCursor + (original.end - oldCursor) });
  return Object.freeze(segments.filter((segment) => segment.end > segment.start));
}

function activeProvenance(records: readonly AuthorshipProvenance[]): readonly AuthorshipProvenance[] {
  const superseded = new Set(records.flatMap((record) => record.supersedesProvenanceIds));
  return records.filter((record) => !superseded.has(record.provenanceId));
}

function validateStructuralChange(change: StructuralChange, base: ProjectSnapshot, operation: WritingOperation, targetNodes: ReadonlySet<string>): void {
  if (change.kind === 'create') {
    const value = z.strictObject({ node: documentNodeSchema }).parse(change.value);
    if (change.targetIds.length !== 1 || change.targetIds[0] !== value.node.nodeId || !targetNodes.has(value.node.nodeId)) throw new Error(`Structural create expands beyond its admitted node identity: ${value.node.nodeId}`);
    return;
  }
  if (change.kind === 'relation') {
    const value = z.discriminatedUnion('action', [
      z.strictObject({ action: z.literal('add'), relation: relationEdgeSchema }),
      z.strictObject({ action: z.literal('remove'), relationId: z.string() })
    ]).parse(change.value);
    if (value.action === 'add') {
      if (!targetNodes.has(value.relation.sourceId) || !targetNodes.has(value.relation.targetId)
        || canonicalSha256([...change.targetIds].sort()) !== canonicalSha256([value.relation.sourceId, value.relation.targetId].sort())) {
        throw new Error(`Structural relation expands beyond admitted endpoint nodes: ${value.relation.relationId}`);
      }
    } else if (change.targetIds.length !== 1 || change.targetIds[0] !== value.relationId
      || !operation.intents.some((intent) => intent.affectedRelationIds.includes(value.relationId))) {
      throw new Error(`Structural relation removal expands beyond admitted relation identity: ${value.relationId}`);
    }
  } else {
    for (const id of change.targetIds) {
      if (!targetNodes.has(id)) throw new Error(`Proposal expands beyond admitted structural targets: ${id}`);
      if (!base.nodes.some((node) => node.nodeId === id)) throw new Error(`Structural change targets an unknown node: ${id}`);
    }
  }
  if (!operation.intents.some((intent) => intent.kind === `structure.${change.kind}` || (change.kind === 'relation' && intent.kind === 'structure.relation'))) {
    throw new Error(`Structural change kind was not admitted by an intent: ${change.kind}`);
  }
}

function validateSemanticDeclaration(declaration: SemanticChangeDeclaration, operation: WritingOperation): void {
  if (!semanticDeclarationConfined(declaration, operation)) throw new Error('Semantic-change declaration expands beyond the admitted intent graph.');
}

function semanticDeclarationConfined(declaration: SemanticChangeDeclaration, operation: WritingOperation): boolean {
  if (declaration.kind === 'none') return true;
  const affected = new Set(operation.intents.flatMap((intent) => [
    ...intent.affectedClaimIds,
    ...intent.affectedRelationIds,
    ...intent.targetNodeIds,
    ...intent.targetResourceIds,
    ...intent.targetRangeIds
  ]));
  return declaration.items.every((item) => item.targetId === undefined || affected.has(item.targetId));
}

function graphIntegrity(base: ProjectSnapshot): boolean {
  const sources = new Map(base.sources.map((source) => [source.sourceId, source]));
  const claims = new Set(base.claims.map((claim) => `${claim.claimId}@${String(claim.version)}`));
  return base.evidenceRelations.every((relation) => {
    const source = sources.get(relation.sourceId);
    return claims.has(`${relation.claimId}@${String(relation.claimVersion)}`) && source?.excerpts.some((excerpt) => excerpt.excerptId === relation.excerptId && excerpt.sourceRevisionSha256 === relation.sourceRevisionSha256 && excerpt.rangeSha256 === relation.rangeSha256) === true;
  });
}

function sourceRecordIntegrity(base: ProjectSnapshot, contentByResource: ReadonlyMap<string, string>): boolean {
  const resources = new Map(base.resources.map((resource) => [resource.resourceId, resource]));
  return base.sources.every((source) => {
    if (source.identityStatus === 'verified' && (source.authoritativeIdentifiers.length === 0 || source.identityVerifierId === undefined || source.verificationPolicyId === undefined)) return false;
    if (source.localResourceId === undefined) return source.artifactId !== undefined;
    const resource = resources.get(source.localResourceId);
    const content = contentByResource.get(source.localResourceId);
    if (resource === undefined || content === undefined || resource.currentSha256 !== source.exactSha256 || textSha256(content) !== source.exactSha256) return false;
    return source.excerpts.every((excerpt) => {
      if (excerpt.resourceId !== source.localResourceId || excerpt.sourceRevisionSha256 !== source.exactSha256 || canonicalSha256(excerpt.range) !== excerpt.rangeSha256) return false;
      try {
        const offsets = offsetRange(content, excerpt.range);
        return textSha256(content.slice(offsets.start, offsets.end)) === excerpt.textSha256;
      } catch { return false; }
    });
  });
}

function provenanceIntegrity(base: ProjectSnapshot, contentByResource: ReadonlyMap<string, string>): boolean {
  const resources = new Set(base.resources.map((resource) => resource.resourceId));
  const nodes = new Set(base.nodes.map((node) => node.nodeId));
  const known = new Set<string>();
  for (const record of base.authorshipProvenance) {
    if (known.has(record.provenanceId) || record.supersedesProvenanceIds.some((provenanceId) => !known.has(provenanceId))) return false;
    known.add(record.provenanceId);
  }
  const active = activeProvenance(base.authorshipProvenance);
  if (!active.every((record) => {
    if (record.resourceId === undefined) return nodes.has(record.nodeId ?? '') && record.structuralObjectId !== undefined;
    const content = contentByResource.get(record.resourceId);
    if (!resources.has(record.resourceId) || content === undefined || record.range === undefined) return false;
    try { offsetRange(content, record.range); return true; } catch { return false; }
  })) return false;
  for (const node of base.nodes.filter((candidate) => candidate.status !== 'removed')) {
    if (!active.some((record) => record.nodeId === node.nodeId && record.structuralObjectId !== undefined)) return false;
  }
  for (const resource of base.resources) {
    const content = contentByResource.get(resource.resourceId);
    if (content === undefined) return false;
    const ranges = active.flatMap((record) => record.resourceId === resource.resourceId && record.range !== undefined
      ? [offsetRange(content, record.range)] : []).sort((left, right) => left.start - right.start || left.end - right.end);
    let covered = 0;
    for (const range of ranges) { if (range.start > covered) return false; covered = Math.max(covered, range.end); }
    if (covered < content.length) return false;
  }
  return true;
}

function lengthValue(content: string, unit: 'words' | 'characters' | 'lines'): number {
  if (unit === 'characters') return Array.from(content).length;
  if (unit === 'lines') return content.length === 0 ? 0 : content.split(/\r\n|\r|\n/u).length;
  return content.trim().length === 0 ? 0 : content.trim().split(/\s+/u).length;
}

function terminologyVerdict(content: string, base: ProjectSnapshot): 'passed' | 'failed' | 'unknown' {
  let supported = 0;
  for (const constraint of base.brief.terminologyConstraints) {
    if (constraint.statement.startsWith('require:')) { supported += 1; if (!content.includes(constraint.statement.slice(8).trim())) return 'failed'; }
    else if (constraint.statement.startsWith('forbid:')) { supported += 1; if (content.includes(constraint.statement.slice(7).trim())) return 'failed'; }
  }
  return supported === base.brief.terminologyConstraints.length ? 'passed' : 'unknown';
}

function headingVerdict(base: ProjectSnapshot, text: ReadonlyMap<string, string>): 'passed' | 'failed' {
  for (const [resourceId, content] of text) {
    if (base.resources.find((resource) => resource.resourceId === resourceId)?.mediaType !== 'text/markdown') continue;
    let previous = 0;
    for (const line of content.split(/\r\n|\r|\n/u)) {
      const level = /^(#{1,6})\s/u.exec(line)?.[1]?.length;
      if (level === undefined) continue;
      if (previous > 0 && level > previous + 1) return 'failed';
      previous = level;
    }
  }
  return 'passed';
}

function internalReferenceVerdict(base: ProjectSnapshot, content: string): 'passed' | 'failed' {
  const sources = new Set(base.sources.map((source) => source.sourceId));
  return [...content.matchAll(/\[source:([A-Za-z0-9._:/-]+)\]/gu)].every((match) => sources.has(match[1] ?? '')) ? 'passed' : 'failed';
}

function duplicatePassageVerdict(content: string): 'passed' | 'failed' {
  const passages = content.split(/(?:\r?\n){2,}/u).map((item) => item.trim()).filter((item) => item.length >= 240);
  return new Set(passages).size === passages.length ? 'passed' : 'failed';
}

function syntaxVerdict(base: ProjectSnapshot, text: ReadonlyMap<string, string>): 'passed' | 'failed' {
  for (const [resourceId, content] of text) {
    if (base.resources.find((resource) => resource.resourceId === resourceId)?.mediaType !== 'text/markdown') continue;
    if ((content.match(/^```/gmu) ?? []).length % 2 !== 0) return 'failed';
  }
  return 'passed';
}

function editorialEvaluationInputSha256(input: {
  readonly operation: WritingOperation;
  readonly baseRevisionId: string;
  readonly candidateRevisionId: string;
  readonly candidateText: ReadonlyMap<string, string>;
  readonly comparisonBaselines: readonly EditorialComparisonBaseline[];
  readonly declaration: SemanticChangeDeclaration;
  readonly preservationContract: PreservationContract;
}): string {
  return canonicalSha256({
    operationId: input.operation.operationId,
    baseRevisionId: input.baseRevisionId,
    candidateRevisionId: input.candidateRevisionId,
    comparisonBaselines: input.comparisonBaselines.map((baseline) => ({
      revisionId: baseline.snapshot.revision.revisionId,
      resources: [...baseline.text]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([resourceId, content]) => ({ resourceId, sha256: textSha256(content) }))
    })),
    candidateResources: [...input.candidateText]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([resourceId, content]) => ({ resourceId, sha256: textSha256(content) })),
    declaration: input.declaration,
    preservationContract: input.preservationContract
  });
}

async function loadComparisonBaselines(
  project: WritingProject,
  base: ProjectSnapshot,
  baseText: ReadonlyMap<string, string>,
  revisionIds: readonly string[],
  records: readonly ProjectLogRecord[]
): Promise<readonly EditorialComparisonBaseline[]> {
  const snapshots = new Map(records.flatMap((record) => record.payload.kind === 'revision.committed'
    ? [[record.payload.snapshot.revision.revisionId, record.payload.snapshot] as const]
    : []));
  const baselines: EditorialComparisonBaseline[] = [];
  for (const revisionId of revisionIds) {
    const snapshot = revisionId === base.revision.revisionId ? base : snapshots.get(revisionId);
    if (snapshot === undefined) throw new Error(`Preservation baseline revision is unavailable: ${revisionId}`);
    const text = new Map<string, string>();
    for (const resource of snapshot.resources) {
      const content = revisionId === base.revision.revisionId
        ? baseText.get(resource.resourceId)
        : await project.store.readObject(resource.currentSha256);
      if (content === undefined || textSha256(content) !== resource.currentSha256) throw new Error(`Preservation baseline content is unavailable or corrupt: ${revisionId}/${resource.resourceId}`);
      text.set(resource.resourceId, content);
    }
    baselines.push(Object.freeze({ snapshot, text }));
  }
  return Object.freeze(baselines);
}

function assertEditorialBindings(input: {
  readonly semanticFindings: readonly SemanticPreservationFinding[];
  readonly editorialFindings: readonly EditorialFinding[];
  readonly base: ProjectSnapshot;
  readonly candidateRevisionId: string;
  readonly candidateText: ReadonlyMap<string, string>;
  readonly evaluationInputSha256: string;
  readonly checker?: WritingEditorialChecker;
}): void {
  for (const finding of input.semanticFindings) {
    semanticPreservationFindingSchema.parse(finding);
    assertFindingComparison(finding, input);
    assertFindingEvaluator(finding, input.checker);
    assertEvidenceRanges(finding, input.candidateText);
  }
  for (const finding of input.editorialFindings) {
    editorialFindingSchema.parse(finding);
    assertFindingComparison(finding, input);
    assertFindingEvaluator(finding, input.checker);
    assertEvidenceRanges(finding, input.candidateText);
  }
}

function assertFindingComparison(finding: Pick<SemanticPreservationFinding, 'findingId' | 'baseRevisionId' | 'candidateRevisionId' | 'evaluationInputSha256'>, input: {
  readonly base: ProjectSnapshot;
  readonly candidateRevisionId: string;
  readonly evaluationInputSha256: string;
}): void {
  if (finding.baseRevisionId !== input.base.revision.revisionId || finding.candidateRevisionId !== input.candidateRevisionId || finding.evaluationInputSha256 !== input.evaluationInputSha256) {
    throw new Error(`Editorial checker returned a finding bound to different comparison inputs: ${finding.findingId}`);
  }
}

function assertFindingEvaluator(finding: Pick<SemanticPreservationFinding, 'findingId' | 'evaluatorId' | 'verificationPolicyId' | 'calibrationId'>, checker?: WritingEditorialChecker): void {
  if (checker !== undefined && (finding.evaluatorId !== checker.implementationId || finding.verificationPolicyId !== checker.verificationPolicyId || finding.calibrationId !== checker.calibrationId)) {
    throw new Error(`Editorial checker returned a finding with mismatched implementation or calibration identity: ${finding.findingId}`);
  }
}

function assertEvidenceRanges(finding: Pick<SemanticPreservationFinding, 'findingId' | 'evidenceRanges'>, candidateText: ReadonlyMap<string, string>): void {
  for (const evidence of finding.evidenceRanges) {
    const content = candidateText.get(evidence.resourceId);
    if (content === undefined) throw new Error(`Editorial finding evidence targets an unknown candidate resource: ${finding.findingId}`);
    const offsets = offsetRange(content, evidence.range);
    if (textSha256(content.slice(offsets.start, offsets.end)) !== evidence.sha256) throw new Error(`Editorial finding evidence hash does not match the exact candidate range: ${finding.findingId}`);
  }
}

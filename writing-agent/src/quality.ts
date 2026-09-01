import * as z from 'zod';
import { canonicalSha256, contentId, nowTimestamp, textSha256 } from './canonical.js';
import {
  authorshipProvenanceSchema,
  criterionCoverageSchema,
  deterministicCheckSchema,
  documentNodeSchema,
  editorialFindingSchema,
  proposalQualityEvaluationSchema,
  preservationContractSchema,
  relationEdgeSchema,
  semanticPreservationFindingSchema,
  type AuthorshipProvenance,
  type ContextReceipt,
  type CriterionCoverage,
  type DeterministicCheck,
  type EditorialFinding,
  type HumanCriterionDecision,
  type LocalizedTextEdit,
  type PreservationContract,
  type ProposalQualityEvaluation,
  type ProjectSnapshot,
  type RevisionProposal,
  type SemanticChangeDeclaration,
  type SemanticPreservationFinding,
  type StructuralChange,
  type WritingOperation
} from './domain.js';
import type { WritingProject } from './project.js';
import { readRootedText } from './project.js';
import type { ProjectLogRecord } from './project-store.js';
import { createWritingOperationContract, type WritingOperationContract } from './operation-contract.js';
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
    readonly operationContract: WritingOperationContract;
    readonly base: ProjectSnapshot;
    readonly comparisonBaselines: readonly EditorialComparisonBaseline[];
    readonly candidateRevisionId: string;
    readonly candidateText: ReadonlyMap<string, string>;
    readonly declaration: SemanticChangeDeclaration;
    readonly preservationContract: PreservationContract;
    readonly evaluationInputSha256: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly semanticPreservationFindings: readonly SemanticPreservationFinding[];
    readonly editorialFindings: readonly EditorialFinding[];
  }>;
}

export interface PreparedProposalMaterial {
  readonly candidateText: ReadonlyMap<string, string>;
  readonly baseText: ReadonlyMap<string, string>;
  readonly base: ProjectSnapshot;
  readonly operationContract: WritingOperationContract;
  readonly comparisonBaselines: readonly EditorialComparisonBaseline[];
  readonly preservationContract: PreservationContract;
  readonly proposedAuthorshipProvenance: readonly AuthorshipProvenance[];
  readonly candidateRevisionId: string;
  readonly evaluationInputSha256: string;
}

export interface PreparedProposalQuality extends PreparedProposalMaterial {
  readonly deterministicChecks: readonly DeterministicCheck[];
}

interface ProposalPreparationInput {
  readonly project: WritingProject;
  readonly operation: WritingOperation;
  readonly proposalId: string;
  readonly textEdits: readonly LocalizedTextEdit[];
  readonly structuralChanges: readonly StructuralChange[];
  readonly declaration: SemanticChangeDeclaration;
  readonly contextReceipt: ContextReceipt;
  readonly clock?: () => Date;
}

export async function prepareProposalMaterial(input: ProposalPreparationInput): Promise<PreparedProposalMaterial> {
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
    if (request.baseSha256 !== resource.currentSha256) throw new Error(`Proposal base hash is stale for resource: ${request.resourceId}`);
    const currentContent = baseText.get(request.resourceId);
    if (currentContent === undefined || textSha256(currentContent) !== request.baseSha256) throw new Error(`Proposal preimage changed for resource: ${request.resourceId}`);
    assertProtectedRanges(currentContent, resource.protectedRanges, request, input.operation);
    const applied = applyLocalizedTextEdits(currentContent, request);
    candidateText.set(request.resourceId, applied.content);
    resourceEdits.set(request.resourceId, request);
    for (const offset of applied.offsets) {
      proposedAuthorship.push(authorshipProvenanceSchema.parse({
        provenanceId: contentId('provenance', { proposalId: input.proposalId, resourceId: request.resourceId, anchorId: offset.anchorId }),
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
  const operationContract = createWritingOperationContract(input.operation, base);
  const comparisonBaselines = await loadComparisonBaselines(input.project, base, baseText, preservationContract.comparisonBaselineRevisionIds, view.records);
  const candidateRevisionId = contentId('candidate', {
    baseRevisionId: base.revision.revisionId,
    textEdits: input.textEdits,
    structuralChanges: input.structuralChanges,
    declaration: input.declaration
  });
  const evaluationInputSha256 = editorialEvaluationInputSha256({
    operation: input.operation,
    operationContract,
    base,
    candidateRevisionId,
    candidateText,
    comparisonBaselines,
    declaration: input.declaration,
    preservationContract
  });
  return Object.freeze({
    candidateText,
    baseText,
    base,
    operationContract,
    comparisonBaselines,
    preservationContract,
    proposedAuthorshipProvenance: Object.freeze(proposedAuthorship),
    candidateRevisionId,
    evaluationInputSha256
  });
}

export async function prepareProposalQuality(input: ProposalPreparationInput): Promise<PreparedProposalQuality> {
  const prepared = await prepareProposalMaterial(input);
  const deterministicChecks = deterministicProposalChecks({
    base: prepared.base,
    operation: input.operation,
    textEdits: input.textEdits,
    structuralChanges: input.structuralChanges,
    declaration: input.declaration,
    baseText: prepared.baseText,
    candidateText: prepared.candidateText,
    preservationContract: prepared.preservationContract
  });
  return Object.freeze({ ...prepared, deterministicChecks });
}

export async function evaluateProposalQuality(input: {
  readonly project: WritingProject;
  readonly operation: WritingOperation;
  readonly proposal: RevisionProposal;
  readonly contextReceipt: ContextReceipt;
  readonly checker: WritingEditorialChecker;
  readonly clock?: () => Date;
  readonly signal?: AbortSignal;
}): Promise<ProposalQualityEvaluation> {
  const prepared = await prepareProposalQuality({
    project: input.project,
    operation: input.operation,
    proposalId: input.proposal.proposalId,
    textEdits: input.proposal.textEdits,
    structuralChanges: input.proposal.structuralChanges,
    declaration: input.proposal.semanticChangeDeclaration,
    contextReceipt: input.contextReceipt,
    ...(input.clock === undefined ? {} : { clock: input.clock })
  });
  if (canonicalSha256(prepared.preservationContract) !== canonicalSha256(input.proposal.preservationContract)) {
    throw new Error(`Proposal quality inputs no longer reproduce their durable deterministic evidence: ${input.proposal.proposalId}`);
  }
  const editorial = await input.checker.evaluate({
    operation: input.operation,
    operationContract: prepared.operationContract,
    base: prepared.base,
    comparisonBaselines: prepared.comparisonBaselines,
    candidateRevisionId: prepared.candidateRevisionId,
    candidateText: prepared.candidateText,
    declaration: input.proposal.semanticChangeDeclaration,
    preservationContract: prepared.preservationContract,
    evaluationInputSha256: prepared.evaluationInputSha256,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  assertExactEvaluationCoverage(editorial, input.operation, prepared.base);
  assertEditorialBindings({
    semanticFindings: editorial.semanticPreservationFindings,
    editorialFindings: editorial.editorialFindings,
    base: prepared.base,
    candidateRevisionId: prepared.candidateRevisionId,
    candidateText: prepared.candidateText,
    evaluationInputSha256: prepared.evaluationInputSha256,
    checker: input.checker
  });
  const criterionCoverage = acceptanceCriterionCoverage(prepared.base, prepared.deterministicChecks, editorial.editorialFindings);
  return proposalQualityEvaluationSchema.parse({
    evaluationId: contentId('proposal-quality', {
      proposalId: input.proposal.proposalId,
      evaluatorImplementationId: input.checker.implementationId,
      verificationPolicyId: input.checker.verificationPolicyId,
      calibrationId: input.checker.calibrationId,
      evaluationInputSha256: prepared.evaluationInputSha256,
      deterministicChecksSha256: canonicalSha256(prepared.deterministicChecks)
    }),
    proposalId: input.proposal.proposalId,
    operationId: input.operation.operationId,
    baseProjectRevisionId: prepared.base.revision.revisionId,
    candidateRevisionId: prepared.candidateRevisionId,
    evaluationInputSha256: prepared.evaluationInputSha256,
    evaluatorImplementationId: input.checker.implementationId,
    verificationPolicyId: input.checker.verificationPolicyId,
    ...(input.checker.calibrationId === undefined ? {} : { calibrationId: input.checker.calibrationId }),
    deterministicChecks: [...prepared.deterministicChecks],
    semanticPreservationFindings: [...editorial.semanticPreservationFindings],
    editorialFindings: [...editorial.editorialFindings],
    criterionCoverage: [...criterionCoverage],
    evaluatedAt: nowTimestamp(input.clock)
  });
}

export function proposalCanApply(quality: {
  readonly deterministicChecks: readonly DeterministicCheck[];
  readonly semanticPreservationFindings: readonly SemanticPreservationFinding[];
  readonly editorialFindings: readonly EditorialFinding[];
  readonly criterionCoverage: readonly CriterionCoverage[];
}, humanCriterionDecisions: readonly HumanCriterionDecision[] = []): { readonly allowed: boolean; readonly reasons: readonly string[] } {
  const decisions = new Map(humanCriterionDecisions.map((decision) => [decision.criterionId, decision]));
  if (decisions.size !== humanCriterionDecisions.length) throw new Error('Human acceptance criterion decisions must be unique.');
  const reasons: string[] = [];
  for (const check of quality.deterministicChecks) {
    if (check.requirement === 'required' && check.verdict !== 'passed') reasons.push(`check:${check.checkId}:${check.verdict}`);
  }
  for (const finding of quality.semanticPreservationFindings) {
    if (finding.requirement === 'required' && (finding.verdict !== 'passed' || finding.coverage !== 'complete')) reasons.push(`semantic:${finding.findingId}:${finding.verdict}/${finding.coverage}`);
  }
  for (const finding of quality.editorialFindings) {
    if (finding.severity === 'required' && (finding.verdict !== 'passed' || finding.coverage !== 'complete')) reasons.push(`editorial:${finding.findingId}:${finding.verdict}/${finding.coverage}`);
  }
  for (const coverage of quality.criterionCoverage) {
    if (coverage.requirement !== 'required') continue;
    if (coverage.verificationKind === 'human') {
      const decision = decisions.get(coverage.criterionId);
      if (decision?.verdict !== 'passed') reasons.push(`criterion:${coverage.criterionId}:${decision?.verdict ?? 'missing'}/human`);
    } else if (coverage.verdict !== 'passed' || coverage.coverage !== 'complete') {
      reasons.push(`criterion:${coverage.criterionId}:${coverage.verdict}/${coverage.coverage}`);
    }
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
    allowedRangeIds: textEdits.flatMap((request) => request.edits.map((edit) => edit.anchorId)),
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
    requiredRevalidations: ['project-base', 'resource-base', 'mutation-confinement', 'protected-ranges', 'semantic-declaration', 'prior-decisions', 'provenance-graph']
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
  const add = (checkId: string, requirement: 'required' | 'advisory', verdict: 'passed' | 'failed' | 'unknown', summary: string, evidence: readonly string[] = [], criterionIds: readonly string[] = []) => {
    checks.push(deterministicCheckSchema.parse({ checkId, implementationId: `writing-agent.check.${checkId}@2`, criterionIds, requirement, verdict, summary, evidence, inputSha256: digest }));
  };
  add('project-base', 'required', input.operation.baseProjectRevisionId === input.base.revision.revisionId ? 'passed' : 'failed', 'Proposal derives from the expected project revision.');
  const hashesValid = input.textEdits.every((request) => input.base.resources.find((resource) => resource.resourceId === request.resourceId)?.currentSha256 === request.baseSha256);
  add('resource-base', 'required', hashesValid ? 'passed' : 'failed', 'Every localized edit received its current managed-resource hash from application-owned target control.');
  const confined = input.textEdits.every((request) => input.operation.targetResourceIds.includes(request.resourceId)) && input.structuralChanges.every((change) => change.kind === 'create' || change.targetIds.every((id) => input.operation.targetNodeIds.includes(id)));
  add('mutation-confinement', 'required', confined ? 'passed' : 'failed', 'Candidate changes remain inside the admitted target union.');
  add('protected-ranges', 'required', 'passed', 'Protected exact ranges were checked against localized edits before proposal creation.');
  add('semantic-declaration', 'required', semanticDeclarationConfined(input.declaration, input.operation) ? 'passed' : 'failed', 'Declared semantic changes are confined to admitted intents.');
  add('claim-evidence-graph', 'required', graphIntegrity(input.base) ? 'passed' : 'failed', 'Claim, evidence, source, and excerpt references are internally consistent.');
  add('source-record-integrity', 'required', sourceRecordIntegrity(input.base, input.baseText) ? 'passed' : 'failed', 'Local source identity, excerpt ranges, quotation hashes, and supplied verifier bindings are internally consistent.');
  add('prior-decisions', 'required', 'passed', 'Protected prior decisions and out-of-scope resources remain in the preservation contract.');
  add('provenance-graph', 'required', provenanceIntegrity(input.base, input.baseText) ? 'passed' : 'failed', 'Authorship-provenance targets and exact range coverage are valid for current resources and structural nodes.');
  for (const constraint of input.operation.effectiveConstraints.lengthConstraints) {
    const candidate = constraintText(input.candidateText, constraint.targetResourceIds);
    const actual = lengthValue(candidate, constraint.unit);
    const passed = actual >= (constraint.minimum ?? 0) && actual <= (constraint.maximum ?? Number.MAX_SAFE_INTEGER);
    add(`length-${constraint.constraintId}`, constraint.requirement, passed ? 'passed' : 'failed', 'The effective operation length intersection was evaluated against candidate text.', [
      `actual=${String(actual)} ${constraint.unit}`,
      `minimum=${constraint.minimum === undefined ? 'unbounded' : String(constraint.minimum)}`,
      `maximum=${constraint.maximum === undefined ? 'unbounded' : String(constraint.maximum)}`,
      `sources=${constraint.sourceConstraintIds.join(',')}`,
      `targets=${constraint.targetResourceIds.join(',')}`
    ], constraint.criterionIds);
  }
  for (const constraint of input.operation.effectiveConstraints.exactConstraints) {
    const candidate = constraintText(input.candidateText, constraint.targetResourceIds);
    const baseline = constraintText(input.baseText, constraint.targetResourceIds);
    const candidateValues = extractExactValues(candidate, constraint.matcher);
    const allowed = new Set(constraint.allowedValues.map((value) => normalizeExactValue(value, constraint.matcher)));
    if (constraint.baselinePolicy === 'include') for (const value of extractExactValues(baseline, constraint.matcher)) allowed.add(value);
    const unexpected = candidateValues.filter((value) => !allowed.has(value));
    add(`exact-${constraint.constraintId}`, constraint.requirement, unexpected.length === 0 ? 'passed' : 'failed', `The ${constraint.matcher} closed world was checked against its explicit allowlist and baseline policy.`, [
      `allowed=${[...allowed].sort().join(' | ') || '(empty)'}`,
      `unexpected=${unexpected.join(' | ') || '(none)'}`,
      `baselinePolicy=${constraint.baselinePolicy}`,
      `sources=${constraint.sourceConstraintIds.join(',')}`,
      `targets=${constraint.targetResourceIds.join(',')}`
    ], constraint.criterionIds);
  }
  const combined = constraintText(input.candidateText, input.operation.targetResourceIds);
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

export function acceptanceCriterionCoverage(
  base: ProjectSnapshot,
  checks: readonly DeterministicCheck[],
  editorialFindings: readonly EditorialFinding[]
): readonly CriterionCoverage[] {
  return Object.freeze(base.brief.acceptanceCriteria.map((criterion) => {
    if (criterion.verificationKind === 'human') {
      return criterionCoverageSchema.parse({
        criterionId: criterion.criterionId,
        requirement: criterion.requirement,
        verificationKind: criterion.verificationKind,
        verdict: 'unknown',
        coverage: 'none',
        evaluatorIds: [],
        evidenceIds: [],
        explanation: 'This criterion requires an explicit direct-human decision at proposal acceptance.'
      });
    }
    if (criterion.verificationKind === 'deterministic') {
      const selected = checks.filter((check) => check.criterionIds.includes(criterion.criterionId));
      return criterionCoverageSchema.parse({
        criterionId: criterion.criterionId,
        requirement: criterion.requirement,
        verificationKind: criterion.verificationKind,
        verdict: aggregateVerdict(selected.map((check) => check.verdict)),
        coverage: selected.length === 0 ? 'none' : 'complete',
        evaluatorIds: [...new Set(selected.map((check) => check.implementationId))].sort(),
        evidenceIds: selected.map((check) => check.checkId).sort(),
        explanation: selected.length === 0 ? 'No deterministic checker declared coverage of this criterion.' : 'Coverage is derived only from deterministic checks that explicitly bind this criterion ID.'
      });
    }
    const selected = editorialFindings.filter((finding) => finding.criterionId === criterion.criterionId);
    const coverage = selected.length === 0 ? 'none' : selected.every((finding) => finding.coverage === 'complete') ? 'complete' : 'partial';
    return criterionCoverageSchema.parse({
      criterionId: criterion.criterionId,
      requirement: criterion.requirement,
      verificationKind: criterion.verificationKind,
      verdict: aggregateVerdict(selected.map((finding) => finding.verdict)),
      coverage,
      evaluatorIds: [...new Set(selected.map((finding) => finding.evaluatorId))].sort(),
      evidenceIds: selected.map((finding) => finding.findingId).sort(),
        explanation: selected.length === 0 ? 'No admitted editorial evaluator finding declared coverage of this criterion.' : 'Coverage is derived only from editorial findings that explicitly bind this criterion ID.'
    });
  }));
}

function aggregateVerdict(verdicts: readonly ('passed' | 'failed' | 'unknown')[]): 'passed' | 'failed' | 'unknown' {
  if (verdicts.some((verdict) => verdict === 'failed')) return 'failed';
  if (verdicts.length === 0 || verdicts.some((verdict) => verdict === 'unknown')) return 'unknown';
  return 'passed';
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

function constraintText(contentByResource: ReadonlyMap<string, string>, targetResourceIds: readonly string[]): string {
  return [...targetResourceIds].sort().map((resourceId) => {
    const content = contentByResource.get(resourceId);
    if (content === undefined) throw new Error(`Effective constraint targets unavailable resource text: ${resourceId}`);
    return content;
  }).join('\n');
}

function extractExactValues(content: string, matcher: 'number' | 'citation' | 'named-entity'): readonly string[] {
  let values: readonly string[];
  if (matcher === 'number') {
    values = content.match(/(?<![\p{L}\p{N}_])(?:[$€£]\s*)?[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?(?![\p{L}\p{N}_])/gu) ?? [];
  } else if (matcher === 'citation') {
    values = [
      ...(content.match(/https?:\/\/[^\s)>\]}]+/gu) ?? []),
      ...(content.match(/\[source:[A-Za-z0-9._:/@-]+\]/gu) ?? []),
      ...(content.match(/\[\^[A-Za-z0-9._:/@-]+\]/gu) ?? [])
    ];
  } else {
    values = content.match(/\b\p{Lu}[\p{L}\p{M}'’-]*(?:[\t ]+\p{Lu}[\p{L}\p{M}'’-]*)+\b/gu) ?? [];
  }
  return Object.freeze([...new Set(values.map((value) => normalizeExactValue(value, matcher)))].sort());
}

function normalizeExactValue(value: string, matcher: 'number' | 'citation' | 'named-entity'): string {
  const compact = value.trim().replace(/\s+/gu, ' ');
  if (matcher === 'number') return compact.replace(/[\s,]/gu, '');
  if (matcher === 'citation' && /^https?:\/\//iu.test(compact)) {
    try { return new URL(compact).toString(); } catch { return compact; }
  }
  return compact.normalize('NFC');
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
  readonly operationContract: WritingOperationContract;
  readonly base: ProjectSnapshot;
  readonly candidateRevisionId: string;
  readonly candidateText: ReadonlyMap<string, string>;
  readonly comparisonBaselines: readonly EditorialComparisonBaseline[];
  readonly declaration: SemanticChangeDeclaration;
  readonly preservationContract: PreservationContract;
}): string {
  return canonicalSha256({
    operationId: input.operation.operationId,
    operationContractSha256: canonicalSha256(input.operationContract),
    baseVerificationContext: {
      revisionId: input.base.revision.revisionId
    },
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

function assertExactEvaluationCoverage(
  evaluation: Awaited<ReturnType<WritingEditorialChecker['evaluate']>>,
  operation: WritingOperation,
  base: ProjectSnapshot
): void {
  assertExactSet(
    evaluation.semanticPreservationFindings.map((finding) => finding.scope),
    operation.intents.map((intent) => intent.intentId),
    'semantic intent scopes'
  );
  assertExactSet(
    evaluation.editorialFindings.map((finding) => finding.criterionId),
    base.brief.acceptanceCriteria.filter((criterion) => criterion.verificationKind === 'editorial').map((criterion) => criterion.criterionId),
    'editorial criterion bindings'
  );
}

function assertExactSet(actual: readonly string[], expected: readonly string[], label: string): void {
  if (new Set(actual).size !== actual.length || canonicalSha256([...actual].sort()) !== canonicalSha256([...expected].sort())) {
    throw new Error(`Editorial checker did not return the exact ${label}.`);
  }
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

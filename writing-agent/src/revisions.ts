import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import * as z from 'zod';
import {
  DEFAULT_LOCAL_TOOL_CONFIGURATION,
  TextPatchJournal,
  editText,
  editTextOutputSchema,
  editTextRecoveryPayloadSchema,
  type TextTransactionResult
} from '@agent-core/tools-local';
import { canonicalSha256, contentId, nowTimestamp, textSha256 } from './canonical.js';
import {
  authorshipProvenanceSchema,
  documentNodeSchema,
  editorialDecisionSchema,
  humanCriterionDecisionSchema,
  WRITING_APPLY_AUTHORIZATION_POLICY_ID,
  writingApplyAuthorizationSchema,
  relationEdgeSchema,
  type AuthorshipProvenance,
  type EditorialDecision,
  type HumanCriterionDecision,
  type LocalizedTextEdit,
  type ProjectSnapshot,
  type StructuralChange,
  type WritingApplyAuthorization
} from './domain.js';
import type { WritingProject } from './project.js';
import { completeTextRange, readRootedText, snapshotParts } from './project.js';
import { createProjectRevision, type ProjectMutationSettlement } from './project-store.js';
import { proposalSatisfiesRequiredVerification } from './verification.js';
import { applyLocalizedTextEdits, offsetRange, rebaseProtectedRanges } from './text-ranges.js';

export interface AppliedWritingRevision {
  readonly proposalId: string;
  readonly revisionId: string;
  readonly transactionId: string;
  readonly fileChanges: ProjectMutationSettlement['oldAndNewHashes'];
  readonly provenance: readonly AuthorshipProvenance[];
  readonly recoveredFinalization: boolean;
}

export interface UndoWritingRevision {
  readonly mutationId: string;
  readonly restoredRevisionId: string;
  readonly revisionId: string;
  readonly transactionId: string;
  readonly fileChanges: ProjectMutationSettlement['oldAndNewHashes'];
  readonly recoveredFinalization: boolean;
}

export async function acceptRevisionProposal(project: WritingProject, input: {
  readonly proposalId: string;
  readonly explanation: string;
  readonly humanCriterionDecisions: readonly HumanCriterionDecision[];
  readonly clock?: () => Date;
}): Promise<EditorialDecision> {
  const clock = input.clock ?? (() => new Date());
  const view = await project.store.view();
  const proposalView = view.proposals.get(input.proposalId);
  if (proposalView === undefined) throw new Error(`Unknown writing proposal: ${input.proposalId}`);
  if (proposalView.status !== 'proposed') throw new Error(`Writing proposal is already ${proposalView.status}: ${input.proposalId}`);
  const proposal = proposalView.proposal;
  const operation = view.operations.get(proposal.operationId);
  if (operation === undefined) throw new Error(`Writing proposal operation is unavailable: ${proposal.operationId}`);
  if (proposal.baseProjectRevisionId !== view.current.revision.revisionId) throw new Error(`Writing proposal base is stale: ${proposal.proposalId}`);
  if (operation.briefRevisionId !== view.current.brief.briefRevisionId) throw new Error(`Writing proposal brief is stale: ${proposal.proposalId}`);
  const verification = view.productionVerifications.get(proposal.proposalId);
  if (verification === undefined) throw new Error(`Writing proposal has no durable production verification through Agent Core: ${proposal.proposalId}`);
  const humanCriteria = new Set(verification.criterionCoverage.filter((criterion) => criterion.verificationKind === 'human').map((criterion) => criterion.criterionId));
  const criterionDecisions = input.humanCriterionDecisions.map((decision) => humanCriterionDecisionSchema.parse(decision));
  for (const decision of criterionDecisions) if (!humanCriteria.has(decision.criterionId)) throw new Error(`Human decision targets a criterion that is not human-verified: ${decision.criterionId}`);
  const applicability = proposalSatisfiesRequiredVerification({
    deterministicChecks: verification.deterministicChecks,
    semanticPreservationFindings: verification.semanticPreservationFindings,
    editorialFindings: verification.editorialFindings,
    criterionCoverage: verification.criterionCoverage
  }, criterionDecisions);
  if (!applicability.allowed) throw new Error(`Writing proposal cannot be accepted while required verification is non-passing: ${applicability.reasons.join(', ')}.`);
  const explanation = input.explanation.trim();
  if (explanation.length === 0) throw new Error('Writing proposal acceptance requires a direct-human explanation.');
  const decision = editorialDecisionSchema.parse({
    decisionId: contentId('decision', { proposalId: input.proposalId, decision: 'accepted', explanation, criterionDecisions }),
    projectRevisionId: view.current.revision.revisionId,
    proposalId: input.proposalId,
    findingIds: [...verification.semanticPreservationFindings.map((finding) => finding.findingId), ...verification.editorialFindings.map((finding) => finding.findingId)],
    criterionDecisions,
    decision: 'accepted',
    explanation,
    actor: 'human',
    createdAt: nowTimestamp(clock)
  });
  await project.store.appendProposalDecision({
    lifecycle: { proposalId: input.proposalId, expectedStatus: 'proposed', status: 'accepted', decisionId: decision.decisionId, explanation },
    decision,
    expectedRevisionId: view.current.revision.revisionId
  });
  return decision;
}

export async function rejectRevisionProposal(project: WritingProject, proposalId: string, explanation: string, clock: () => Date = () => new Date()): Promise<EditorialDecision> {
  const view = await project.store.view();
  const proposalView = view.proposals.get(proposalId);
  if (proposalView === undefined) throw new Error(`Unknown writing proposal: ${proposalId}`);
  if (proposalView.status !== 'proposed') throw new Error(`Writing proposal is already ${proposalView.status}: ${proposalId}`);
  const verification = view.productionVerifications.get(proposalId);
  const decision = editorialDecisionSchema.parse({
    decisionId: contentId('decision', { proposalId, decision: 'rejected', explanation }),
    projectRevisionId: view.current.revision.revisionId,
    proposalId,
    findingIds: verification === undefined ? [] : [...verification.semanticPreservationFindings.map((finding) => finding.findingId), ...verification.editorialFindings.map((finding) => finding.findingId)],
    criterionDecisions: [],
    decision: 'rejected',
    explanation,
    actor: 'human',
    createdAt: nowTimestamp(clock)
  });
  await project.store.appendProposalDecision({
    lifecycle: { proposalId, expectedStatus: 'proposed', status: 'rejected', decisionId: decision.decisionId, explanation },
    decision,
    expectedRevisionId: view.current.revision.revisionId
  });
  return decision;
}

export async function authorizeRevisionApplication(project: WritingProject, input: {
  readonly proposalId: string;
}): Promise<WritingApplyAuthorization> {
  const existing = await project.store.getWritingApplyAuthorization(input.proposalId);
  if (existing !== undefined) return existing;
  const view = await project.store.view();
  const proposalView = view.proposals.get(input.proposalId);
  if (proposalView === undefined) throw new Error(`Unknown writing proposal: ${input.proposalId}`);
  if (proposalView.status !== 'accepted') throw new Error(`Writing apply authorization requires an accepted proposal: ${input.proposalId} is ${proposalView.status}.`);
  const proposal = proposalView.proposal;
  if (view.current.revision.revisionId !== proposal.baseProjectRevisionId) throw new Error(`Writing apply authorization cannot bind a stale project revision: ${proposal.proposalId}`);
  const verification = view.productionVerifications.get(proposal.proposalId);
  if (verification === undefined) throw new Error(`Writing apply authorization requires durable production verification: ${proposal.proposalId}`);
  const decision = requireProposalDecision(view.records, proposal.proposalId, 'accepted');
  const applicability = proposalSatisfiesRequiredVerification({
    deterministicChecks: verification.deterministicChecks,
    semanticPreservationFindings: verification.semanticPreservationFindings,
    editorialFindings: verification.editorialFindings,
    criterionCoverage: verification.criterionCoverage
  }, decision.criterionDecisions);
  if (!applicability.allowed) throw new Error(`Writing apply authorization cannot bind non-passing verification: ${applicability.reasons.join(', ')}.`);
  const transactionId = writingTransactionId(proposal.proposalId, proposal.textEdits);
  const material = {
    authorizationPolicyId: WRITING_APPLY_AUTHORIZATION_POLICY_ID,
    projectId: project.store.identity.projectId,
    operationId: proposal.operationId,
    proposalId: proposal.proposalId,
    projectRevisionId: proposal.baseProjectRevisionId,
    resourcePreimages: proposal.expectedBaseHashes,
    productionVerificationId: verification.verificationId,
    verificationInputSha256: verification.verificationInputSha256,
    editorialDecisionId: decision.decisionId,
    humanCriterionDecisionsSha256: canonicalCriterionDecisionsSha256(decision.criterionDecisions),
    transactionId
  };
  const authorization = writingApplyAuthorizationSchema.parse({
    authorizationId: contentId('writing-apply-authorization', material),
    ...material,
    authorizedAt: decision.createdAt
  });
  await project.store.appendWritingApplyAuthorization(authorization);
  return authorization;
}

export async function applyRevisionProposal(project: WritingProject, input: {
  readonly proposalId: string;
  readonly authorization: WritingApplyAuthorization;
  readonly clock?: () => Date;
}): Promise<AppliedWritingRevision> {
  const clock = input.clock ?? (() => new Date());
  let view = await project.store.view();
  const proposalView = view.proposals.get(input.proposalId);
  if (proposalView === undefined) throw new Error(`Unknown writing proposal: ${input.proposalId}`);
  const proposal = proposalView.proposal;
  const verification = view.productionVerifications.get(proposal.proposalId);
  if (verification === undefined) throw new Error(`Writing proposal production verification is unavailable: ${proposal.proposalId}`);
  const acceptanceDecision = requireProposalDecision(view.records, proposal.proposalId, 'accepted');
  const durableAuthorization = view.applyAuthorizations.get(proposal.proposalId);
  if (durableAuthorization === undefined || canonicalSha256(durableAuthorization) !== canonicalSha256(input.authorization)) {
    throw new Error(`Writing proposal has no matching durable apply authorization: ${proposal.proposalId}`);
  }
  assertWritingApplyAuthorization(project, input.authorization, proposal, verification, acceptanceDecision);
  const existingRevision = findCommittedProposalRevision(view.records, proposal.operationId, proposal.proposalId);
  if (proposalView.status === 'applied' && existingRevision !== undefined) {
    const settlement = view.settlements.get(proposal.proposalId);
    if (settlement === undefined) throw new Error(`Applied proposal has no durable mutation settlement: ${proposal.proposalId}`);
    return Object.freeze({ proposalId: proposal.proposalId, revisionId: existingRevision.revision.revisionId, transactionId: settlement.transactionId, fileChanges: settlement.oldAndNewHashes, provenance: existingRevision.authorshipProvenance.filter((record) => record.proposalId === proposal.proposalId), recoveredFinalization: true });
  }
  if (proposalView.status !== 'accepted') throw new Error(`Writing proposal must be accepted before application: ${proposal.proposalId} is ${proposalView.status}.`);
  if (view.current.revision.revisionId !== proposal.baseProjectRevisionId) throw new Error(`Writing proposal base is stale: ${proposal.proposalId}`);
  const operation = view.operations.get(proposal.operationId);
  if (operation === undefined) throw new Error(`Writing proposal operation is unavailable: ${proposal.operationId}`);
  if (operation.briefRevisionId !== view.current.brief.briefRevisionId) throw new Error(`Writing proposal brief is stale: ${proposal.proposalId}`);
  const textEdits = proposal.textEdits;
  const plan = await planTextTransaction(project, view.current, textEdits);
  const transactionId = input.authorization.transactionId;
  const journalDirectory = path.join(project.state.projectDirectory(project.store.identity.projectId), 'transactions');
  await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
  const journal = TextPatchJournal.adopt(journalDirectory);
  let recoveredFinalization = false;
  let transactionResult: TextTransactionResult | undefined;
  try {
    const prior = await journal.withAuthority(project.authority, (authority) => authority.receipt(transactionId));
    if (prior !== undefined) {
      const recovery = editTextRecoveryPayloadSchema.parse(prior.recoveryPayload);
      assertRecoveryPlan(recovery, plan, transactionId);
      transactionResult = prior.result;
      recoveredFinalization = true;
    } else if (textEdits.length > 0) {
      const observation = await editText({
        files: textEdits.map((request) => ({
          path: requireResource(view.current, request.resourceId).relativePath,
          expectedSha256: request.baseSha256,
          edits: request.edits.map((edit) => ({ range: edit.range, expectedText: expectedAnchorText(plan, request.resourceId, edit), replacementText: edit.replacementText }))
        })),
        dryRun: false,
        transactionId,
        limits: DEFAULT_LOCAL_TOOL_CONFIGURATION.editText
      }, {
        policy: { allowedRisks: ['read', 'write'] },
        services: { rootedFileAuthority: project.authority, patchJournal: journal, localToolConfiguration: DEFAULT_LOCAL_TOOL_CONFIGURATION },
        invocation: { runId: operation.runId, turnId: `application-${proposal.proposalId}`, requestAttempt: 1, toolBatchId: `apply-${proposal.proposalId}`, callIndex: 0, toolAttempt: 1 }
      });
      if (observation.kind !== 'result' || !observation.ok) throw new Error(`Agent Core edit_text rejected proposal application: ${observation.summary}`);
      const output = editTextOutputSchema.parse(observation.output);
      if (output.applicationStatus !== 'applied' && output.applicationStatus !== 'no_change') throw new Error(`Agent Core edit_text did not establish a committed result: ${output.applicationStatus}`);
      const receipt = await journal.withAuthority(project.authority, (authority) => authority.receipt(transactionId));
      if (receipt === undefined) throw new Error(`Committed text edit has no durable transaction receipt: ${transactionId}`);
      transactionResult = receipt.result;
    }
  } finally { journal.close(); }
  transactionResult ??= { outcome: 'committed', cleanup: { status: 'succeeded', diagnostics: [], strandedPaths: [] } };
  if (transactionResult.outcome === 'rolled_back') throw new Error(`Writing text transaction rolled back: ${transactionResult.failure.message}`);
  if (transactionResult.outcome === 'rollback_failed') throw new Error(`Writing text transaction rollback is uncertain: ${transactionResult.failure.message}`);
  await assertCommittedFiles(project, plan);
  for (const item of plan.values()) { await project.store.putObject(item.oldContent); await project.store.putObject(item.newContent); }
  view = await project.store.view();
  if (view.current.revision.revisionId !== proposal.baseProjectRevisionId) {
    const completed = findCommittedProposalRevision(view.records, proposal.operationId, proposal.proposalId);
    if (completed !== undefined) return Object.freeze({ proposalId: proposal.proposalId, revisionId: completed.revision.revisionId, transactionId, fileChanges: view.settlements.get(proposal.proposalId)?.oldAndNewHashes ?? [], provenance: completed.authorshipProvenance.filter((record) => record.proposalId === proposal.proposalId), recoveredFinalization: true });
    throw new Error('Project revision changed after the text transaction committed; finalization requires explicit reconciliation.');
  }
  const resources = view.current.resources.map((resource) => {
    const item = plan.get(resource.resourceId);
    if (item === undefined) return resource;
    const request = textEdits.find((candidate) => candidate.resourceId === resource.resourceId);
    if (request === undefined) throw new Error(`Committed text plan has no localized edit request: ${resource.resourceId}`);
    return { ...resource, currentSha256: item.newSha256, protectedRanges: rebaseProtectedRanges(item.oldContent, request, resource.protectedRanges) };
  });
  const structural = applyStructuralChanges(view.current, proposal.structuralChanges);
  const proposedRecords = proposal.proposedAuthorshipProvenance.map((record) => authorshipProvenanceSchema.parse(record));
  const acceptedRecords = proposedRecords.filter((record) => record.classification === 'model-suggested').map((record) => authorshipProvenanceSchema.parse({
    ...record,
    provenanceId: contentId('provenance', { proposalId: proposal.proposalId, accepted: record.provenanceId }),
    classification: 'user-accepted-unchanged',
    supersedesProvenanceIds: [record.provenanceId],
    createdAt: nowTimestamp(clock)
  }));
  const allNewProvenance = [...proposedRecords, ...acceptedRecords];
  const findings = verification.editorialFindings;
  const checks = verification.deterministicChecks;
  const provisional = createProjectRevision({
    ...snapshotParts(view.current),
    parentRevisionIds: [view.current.revision.revisionId],
    briefRevisionId: view.current.brief.briefRevisionId,
    operationId: proposal.operationId,
    runId: operation.runId,
    editorialDecisionIds: [...view.current.revision.editorialDecisionIds, acceptanceDecision.decisionId],
    editorialFindingIds: [...view.current.revision.editorialFindingIds, ...findings.map((finding) => finding.findingId)],
    timestamp: nowTimestamp(clock),
    nodes: structural.nodes,
    relations: structural.relations,
    resources,
    authorshipProvenance: [...view.current.authorshipProvenance, ...allNewProvenance],
    editorialFindings: [...view.current.editorialFindings, ...findings],
    editorialDecisions: [...view.current.editorialDecisions.filter((decision) => decision.decisionId !== acceptanceDecision.decisionId), acceptanceDecision]
  });
  const committedProvenance = allNewProvenance.map((record) => ({ ...record, projectRevisionId: provisional.revision.revisionId }));
  const snapshot = createProjectRevision({
    ...snapshotParts(provisional),
    parentRevisionIds: [view.current.revision.revisionId],
    briefRevisionId: view.current.brief.briefRevisionId,
    operationId: proposal.operationId,
    runId: operation.runId,
    editorialDecisionIds: provisional.revision.editorialDecisionIds,
    editorialFindingIds: provisional.revision.editorialFindingIds,
    timestamp: provisional.revision.timestamp,
    authorshipProvenance: [...view.current.authorshipProvenance, ...committedProvenance]
  });
  const fileChanges = [...plan].map(([resourceId, item]) => ({
    resourceId,
    path: item.path,
    oldSha256: item.oldSha256,
    newSha256: item.newSha256,
    changedAnchorIds: textEdits.find((request) => request.resourceId === resourceId)?.edits.map((edit) => edit.anchorId) ?? []
  }));
  const settlement: ProjectMutationSettlement = {
    mutationId: proposal.proposalId,
    operationId: proposal.operationId,
    transactionId,
    applyAuthorizationId: input.authorization.authorizationId,
    outcome: transactionResult.outcome,
    oldAndNewHashes: fileChanges,
    changedPaths: fileChanges.filter((change) => change.oldSha256 !== change.newSha256).map((change) => change.path),
    addedPaths: [],
    deletedPaths: [],
    cleanup: transactionResult.cleanup.status,
    remainingUncertainty: transactionResult.outcome === 'committed_with_residue' ? ['Agent Core transaction committed with cleanup residue.'] : []
  };
  await project.store.appendAppliedRevision({
    settlement,
    provenance: committedProvenance,
    checks,
    findings,
    decision: acceptanceDecision,
    snapshot,
    expectedRevisionId: proposal.baseProjectRevisionId
  });
  return Object.freeze({ proposalId: proposal.proposalId, revisionId: snapshot.revision.revisionId, transactionId, fileChanges, provenance: Object.freeze(committedProvenance), recoveredFinalization });
}

function assertWritingApplyAuthorization(
  project: WritingProject,
  authorization: WritingApplyAuthorization,
  proposal: import('./domain.js').RevisionProposal,
  verification: import('./domain.js').ProposalProductionVerification,
  decision: EditorialDecision
): void {
  const parsed = writingApplyAuthorizationSchema.parse(authorization);
  const transactionId = writingTransactionId(proposal.proposalId, proposal.textEdits);
  const expected = {
    authorizationPolicyId: WRITING_APPLY_AUTHORIZATION_POLICY_ID,
    projectId: project.store.identity.projectId,
    operationId: proposal.operationId,
    proposalId: proposal.proposalId,
    projectRevisionId: proposal.baseProjectRevisionId,
    resourcePreimages: proposal.expectedBaseHashes,
    productionVerificationId: verification.verificationId,
    verificationInputSha256: verification.verificationInputSha256,
    editorialDecisionId: decision.decisionId,
    humanCriterionDecisionsSha256: canonicalCriterionDecisionsSha256(decision.criterionDecisions),
    transactionId
  };
  if (parsed.authorizationId !== contentId('writing-apply-authorization', expected) || canonicalSha256({
    authorizationPolicyId: parsed.authorizationPolicyId,
    projectId: parsed.projectId,
    operationId: parsed.operationId,
    proposalId: parsed.proposalId,
    projectRevisionId: parsed.projectRevisionId,
    resourcePreimages: parsed.resourcePreimages,
    productionVerificationId: parsed.productionVerificationId,
    verificationInputSha256: parsed.verificationInputSha256,
    editorialDecisionId: parsed.editorialDecisionId,
    humanCriterionDecisionsSha256: parsed.humanCriterionDecisionsSha256,
    transactionId: parsed.transactionId
  }) !== canonicalSha256(expected)) {
    throw new Error(`Writing apply authorization does not bind the exact verified proposal transaction: ${proposal.proposalId}`);
  }
}

function writingTransactionId(proposalId: string, textEdits: readonly LocalizedTextEdit[]): string {
  return contentId('writing-edit', { proposalId, textEdits });
}

function canonicalCriterionDecisionsSha256(decisions: readonly HumanCriterionDecision[]): string {
  return canonicalSha256(decisions);
}

export async function undoWritingRevision(project: WritingProject, input: {
  readonly revisionId?: string;
  readonly resourceIds?: readonly string[];
  readonly explanation: string;
  readonly clock?: () => Date;
}): Promise<UndoWritingRevision> {
  const clock = input.clock ?? (() => new Date());
  const view = await project.store.view();
  const restoredRevisionId = input.revisionId ?? view.current.revision.parentRevisionIds[0];
  if (restoredRevisionId === undefined) throw new Error('The current project revision has no parent content to restore.');
  const targetRecord = view.records.find((record) => record.payload.kind === 'revision.committed' && record.payload.snapshot.revision.revisionId === restoredRevisionId);
  if (targetRecord?.payload.kind !== 'revision.committed') throw new Error(`Unknown project revision to restore: ${restoredRevisionId}`);
  const target = targetRecord.payload.snapshot;
  const requested = input.resourceIds === undefined ? undefined : new Set(input.resourceIds);
  if (requested !== undefined && requested.size !== input.resourceIds?.length) throw new Error('Undo resource IDs must be unique.');
  const selected = view.current.resources.filter((resource) => requested?.has(resource.resourceId) ?? true);
  if (requested !== undefined) {
    const missing = [...requested].filter((resourceId) => !view.current.resources.some((resource) => resource.resourceId === resourceId));
    if (missing.length > 0) throw new Error(`Undo targets unknown current resources: ${missing.join(', ')}.`);
  }
  const plan = new Map<string, { path: string; oldContent: string; newContent: string; oldSha256: string; newSha256: string }>();
  for (const currentResource of selected) {
    const priorResource = target.resources.find((resource) => resource.resourceId === currentResource.resourceId);
    if (priorResource === undefined) {
      if (requested?.has(currentResource.resourceId)) throw new Error(`Selected resource did not exist at revision ${restoredRevisionId}: ${currentResource.resourceId}`);
      continue;
    }
    if (currentResource.currentSha256 === priorResource.currentSha256) continue;
    const currentFile = await readRootedText(project.authority, currentResource.relativePath, 64 * 1024 * 1024);
    if (currentFile.sha256 !== currentResource.currentSha256) throw new Error(`Undo preimage is stale for resource: ${currentResource.resourceId}`);
    const priorContent = await project.store.readObject(priorResource.currentSha256);
    plan.set(currentResource.resourceId, {
      path: currentResource.relativePath,
      oldContent: currentFile.content,
      newContent: priorContent,
      oldSha256: currentFile.sha256,
      newSha256: priorResource.currentSha256
    });
  }
  if (plan.size === 0) throw new Error(`No selected current resource differs from revision ${restoredRevisionId}.`);
  const explanation = input.explanation.trim();
  if (explanation.length === 0) throw new Error('Undo requires a direct-user explanation.');
  const mutationId = contentId('undo', {
    baseRevisionId: view.current.revision.revisionId,
    restoredRevisionId,
    resources: [...plan].map(([resourceId, item]) => ({ resourceId, oldSha256: item.oldSha256, newSha256: item.newSha256 }))
  });
  const transactionId = contentId('writing-undo-edit', { mutationId });
  const operationId = contentId('undo-operation', { mutationId });
  const journalDirectory = path.join(project.state.projectDirectory(project.store.identity.projectId), 'transactions');
  await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
  const journal = TextPatchJournal.adopt(journalDirectory);
  let transactionResult: TextTransactionResult;
  let recoveredFinalization = false;
  try {
    const prior = await journal.withAuthority(project.authority, (authority) => authority.receipt(transactionId));
    if (prior !== undefined) {
      const recovery = editTextRecoveryPayloadSchema.parse(prior.recoveryPayload);
      assertRecoveryPlan(recovery, plan, transactionId);
      transactionResult = prior.result;
      recoveredFinalization = true;
    } else {
      const observation = await editText({
        files: [...plan].map(([, item]) => ({
          path: item.path,
          expectedSha256: item.oldSha256,
          edits: [{ range: completeTextRange(item.oldContent), expectedText: item.oldContent, replacementText: item.newContent }]
        })),
        dryRun: false,
        transactionId,
        limits: DEFAULT_LOCAL_TOOL_CONFIGURATION.editText
      }, {
        policy: { allowedRisks: ['read', 'write'] },
        services: { rootedFileAuthority: project.authority, patchJournal: journal, localToolConfiguration: DEFAULT_LOCAL_TOOL_CONFIGURATION },
        invocation: { runId: operationId, turnId: `undo-${mutationId}`, requestAttempt: 1, toolBatchId: `undo-${mutationId}`, callIndex: 0, toolAttempt: 1 }
      });
      if (observation.kind !== 'result' || !observation.ok) throw new Error(`Agent Core edit_text rejected undo: ${observation.summary}`);
      const output = editTextOutputSchema.parse(observation.output);
      if (output.applicationStatus !== 'applied' && output.applicationStatus !== 'no_change') throw new Error(`Agent Core edit_text did not establish undo: ${output.applicationStatus}`);
      const receipt = await journal.withAuthority(project.authority, (authority) => authority.receipt(transactionId));
      if (receipt === undefined) throw new Error(`Committed undo has no durable transaction receipt: ${transactionId}`);
      transactionResult = receipt.result;
    }
  } finally { journal.close(); }
  if (transactionResult.outcome === 'rolled_back') throw new Error(`Writing undo transaction rolled back: ${transactionResult.failure.message}`);
  if (transactionResult.outcome === 'rollback_failed') throw new Error(`Writing undo rollback is uncertain: ${transactionResult.failure.message}`);
  await assertCommittedFiles(project, plan);
  for (const item of plan.values()) { await project.store.putObject(item.oldContent); await project.store.putObject(item.newContent); }
  const refreshed = await project.store.view();
  if (refreshed.current.revision.revisionId !== view.current.revision.revisionId) throw new Error('Project revision changed while undo was being finalized.');
  const resources = refreshed.current.resources.map((resource) => {
    const item = plan.get(resource.resourceId);
    if (item === undefined) return resource;
    const restored = target.resources.find((candidate) => candidate.resourceId === resource.resourceId);
    if (restored === undefined) throw new Error(`Undo target resource metadata is unavailable: ${resource.resourceId}`);
    return { ...resource, currentSha256: item.newSha256, protectedRanges: restored.protectedRanges };
  });
  const decisionId = contentId('decision', { mutationId, decision: 'override', explanation });
  const provisionalDecision = editorialDecisionSchema.parse({
    decisionId,
    projectRevisionId: refreshed.current.revision.revisionId,
    findingIds: [],
    criterionDecisions: [],
    decision: 'override',
    explanation,
    actor: 'human',
    createdAt: nowTimestamp(clock)
  });
  const provisionalProvenance = [...plan].map(([resourceId, item]) => authorshipProvenanceSchema.parse({
    provenanceId: contentId('provenance', { mutationId, resourceId, restoredRevisionId }),
    projectRevisionId: refreshed.current.revision.revisionId,
    resourceId,
    range: completeTextRange(item.newContent),
    operationId,
    intentIds: [],
    classification: 'user-modified',
    supersedesProvenanceIds: refreshed.current.authorshipProvenance.filter((record) => record.resourceId === resourceId).map((record) => record.provenanceId),
    createdAt: nowTimestamp(clock)
  }));
  const provisional = createProjectRevision({
    ...snapshotParts(refreshed.current),
    parentRevisionIds: [refreshed.current.revision.revisionId],
    briefRevisionId: refreshed.current.brief.briefRevisionId,
    operationId,
    editorialDecisionIds: [...refreshed.current.revision.editorialDecisionIds, decisionId],
    timestamp: nowTimestamp(clock),
    resources,
    authorshipProvenance: [...refreshed.current.authorshipProvenance, ...provisionalProvenance],
    editorialDecisions: [...refreshed.current.editorialDecisions, provisionalDecision]
  });
  const decision = editorialDecisionSchema.parse({ ...provisionalDecision, projectRevisionId: provisional.revision.revisionId });
  const provenance = provisionalProvenance.map((record) => authorshipProvenanceSchema.parse({ ...record, projectRevisionId: provisional.revision.revisionId }));
  const snapshot = createProjectRevision({
    ...snapshotParts(provisional),
    parentRevisionIds: [refreshed.current.revision.revisionId],
    briefRevisionId: refreshed.current.brief.briefRevisionId,
    operationId,
    editorialDecisionIds: provisional.revision.editorialDecisionIds,
    timestamp: provisional.revision.timestamp,
    authorshipProvenance: [...refreshed.current.authorshipProvenance, ...provenance],
    editorialDecisions: [...refreshed.current.editorialDecisions, decision]
  });
  const fileChanges = [...plan].map(([resourceId, item]) => ({
    resourceId,
    path: item.path,
    oldSha256: item.oldSha256,
    newSha256: item.newSha256,
    changedAnchorIds: [`undo-${resourceId}`]
  }));
  const settlement: ProjectMutationSettlement = {
    mutationId,
    operationId,
    transactionId,
    outcome: transactionResult.outcome,
    oldAndNewHashes: fileChanges,
    changedPaths: fileChanges.map((change) => change.path),
    addedPaths: [],
    deletedPaths: [],
    cleanup: transactionResult.cleanup.status,
    remainingUncertainty: transactionResult.outcome === 'committed_with_residue' ? ['Agent Core undo transaction committed with cleanup residue.'] : []
  };
  await project.store.appendUndoRevision({
    settlement,
    provenance,
    decision,
    snapshot,
    expectedRevisionId: refreshed.current.revision.revisionId,
    restoredRevisionId
  });
  return Object.freeze({ mutationId, restoredRevisionId, revisionId: snapshot.revision.revisionId, transactionId, fileChanges, recoveredFinalization });
}

async function planTextTransaction(project: WritingProject, base: ProjectSnapshot, edits: readonly LocalizedTextEdit[]) {
  const plan = new Map<string, { path: string; oldContent: string; newContent: string; oldSha256: string; newSha256: string }>();
  for (const request of edits) {
    const resource = requireResource(base, request.resourceId);
    if (resource.currentSha256 !== request.baseSha256) throw new Error(`Proposal resource hash is stale: ${request.resourceId}`);
    const file = await readRootedText(project.authority, resource.relativePath, 64 * 1024 * 1024);
    if (file.sha256 !== request.baseSha256) {
      const oldContent = await project.store.readObject(request.baseSha256);
      const newContent = applyLocalizedTextEdits(oldContent, request).content;
      if (file.sha256 === textSha256(newContent)) {
        plan.set(request.resourceId, { path: resource.relativePath, oldContent, newContent, oldSha256: request.baseSha256, newSha256: file.sha256 });
        continue;
      }
      throw new Error(`Proposal file preimage is stale: ${request.resourceId}`);
    }
    const newContent = applyLocalizedTextEdits(file.content, request).content;
    plan.set(request.resourceId, { path: resource.relativePath, oldContent: file.content, newContent, oldSha256: file.sha256, newSha256: textSha256(newContent) });
  }
  return plan;
}

function requireResource(base: ProjectSnapshot, resourceId: string) {
  const resource = base.resources.find((candidate) => candidate.resourceId === resourceId);
  if (resource === undefined) throw new Error(`Unknown managed resource: ${resourceId}`);
  return resource;
}

function assertRecoveryPlan(recovery: z.infer<typeof editTextRecoveryPayloadSchema>, plan: ReadonlyMap<string, { path: string; oldSha256: string; newSha256: string }>, transactionId: string): void {
  if (recovery.transactionId !== transactionId) throw new Error('Recovered text transaction ID does not match proposal application.');
  for (const item of plan.values()) {
    const file = recovery.files.find((candidate) => candidate.path === item.path);
    if (file?.oldSha256 !== item.oldSha256 || file.newSha256 !== item.newSha256) throw new Error(`Recovered text transaction does not match the staged proposal file: ${item.path}`);
  }
}

async function assertCommittedFiles(project: WritingProject, plan: ReadonlyMap<string, { path: string; newSha256: string }>): Promise<void> {
  for (const item of plan.values()) {
    const file = await readRootedText(project.authority, item.path, 64 * 1024 * 1024);
    if (file.sha256 !== item.newSha256) throw new Error(`Committed text transaction cannot be reconciled with current file hash: ${item.path}`);
  }
}

function expectedAnchorText(
  plan: ReadonlyMap<string, { readonly oldContent: string }>,
  resourceId: string,
  edit: LocalizedTextEdit['edits'][number]
): string {
  const content = plan.get(resourceId)?.oldContent;
  if (content === undefined) throw new Error(`Text application plan lacks anchor preimage content: ${resourceId}`);
  const offsets = offsetRange(content, edit.range);
  const expectedText = content.slice(offsets.start, offsets.end);
  if (textSha256(expectedText) !== edit.expectedTextSha256) throw new Error(`Text application plan anchor preimage is stale: ${edit.anchorId}`);
  return expectedText;
}

function applyStructuralChanges(base: ProjectSnapshot, changes: readonly StructuralChange[]): { readonly nodes: ProjectSnapshot['nodes']; readonly relations: ProjectSnapshot['relations'] } {
  let nodes = [...base.nodes];
  let relations = [...base.relations];
  for (const change of changes) {
    if (change.kind === 'create') {
      const value = z.strictObject({ node: documentNodeSchema }).parse(change.value);
      if (nodes.some((node) => node.nodeId === value.node.nodeId)) throw new Error(`Structural create reuses a node ID: ${value.node.nodeId}`);
      if (value.node.parentId !== null && !nodes.some((node) => node.nodeId === value.node.parentId && node.status !== 'removed')) throw new Error(`Structural create has an unknown parent: ${value.node.parentId}`);
      nodes.push(value.node);
    } else if (change.kind === 'remove') {
      const targets = new Set(change.targetIds);
      nodes = nodes.map((node) => targets.has(node.nodeId) ? { ...node, status: 'removed' as const } : node);
    } else if (change.kind === 'reorder') {
      const value = z.strictObject({ orders: z.array(z.strictObject({ nodeId: z.string(), siblingOrder: z.int().nonnegative() })).min(1) }).parse(change.value);
      const orders = new Map(value.orders.map((item) => [item.nodeId, item.siblingOrder]));
      nodes = nodes.map((node) => orders.has(node.nodeId) ? { ...node, siblingOrder: orders.get(node.nodeId) ?? node.siblingOrder } : node);
    } else if (change.kind === 'purpose') {
      const value = z.strictObject({ purpose: z.string().trim().min(1).max(100_000) }).parse(change.value);
      const targets = new Set(change.targetIds);
      nodes = nodes.map((node) => targets.has(node.nodeId) ? { ...node, purpose: value.purpose } : node);
    } else if (change.kind === 'relation') {
      const value = z.discriminatedUnion('action', [
        z.strictObject({ action: z.literal('add'), relation: relationEdgeSchema }),
        z.strictObject({ action: z.literal('remove'), relationId: z.string() })
      ]).parse(change.value);
      if (value.action === 'add') {
        if (!nodes.some((node) => node.nodeId === value.relation.sourceId) || !nodes.some((node) => node.nodeId === value.relation.targetId)) throw new Error(`Relation endpoints are not current project nodes: ${value.relation.relationId}`);
        relations.push(value.relation);
      } else relations = relations.map((relation) => relation.relationId === value.relationId ? { ...relation, status: 'removed' as const } : relation);
    } else {
      const value = z.strictObject({ replacementNodes: z.array(documentNodeSchema).min(1) }).parse(change.value);
      const targets = new Set(change.targetIds);
      nodes = [...nodes.map((node) => targets.has(node.nodeId) ? { ...node, status: 'removed' as const } : node), ...value.replacementNodes];
    }
  }
  validateTree(nodes);
  return { nodes, relations };
}

function validateTree(nodes: readonly ProjectSnapshot['nodes'][number][]): void {
  const active = nodes.filter((node) => node.status !== 'removed');
  const roots = active.filter((node) => node.parentId === null);
  if (roots.length !== 1) throw new Error('Document containment must have exactly one active root.');
  const ids = new Set(active.map((node) => node.nodeId));
  if (ids.size !== active.length) throw new Error('Document node IDs must be unique.');
  for (const node of active) if (node.parentId !== null && !ids.has(node.parentId)) throw new Error(`Document node has an unknown active parent: ${node.nodeId}`);
  for (const node of active) {
    const seen = new Set([node.nodeId]);
    let parent = node.parentId;
    while (parent !== null) {
      if (seen.has(parent)) throw new Error(`Document containment cycle includes node: ${node.nodeId}`);
      seen.add(parent);
      parent = active.find((candidate) => candidate.nodeId === parent)?.parentId ?? null;
    }
  }
}

function requireProposalDecision(records: readonly import('./project-store.js').ProjectLogRecord[], proposalId: string, decision: 'accepted' | 'rejected'): EditorialDecision {
  const record = [...records].reverse().find((candidate) => candidate.payload.kind === 'editorial.decision' && candidate.payload.decision.proposalId === proposalId && candidate.payload.decision.decision === decision);
  if (record?.payload.kind !== 'editorial.decision') throw new Error(`Proposal has no durable ${decision} editorial decision: ${proposalId}`);
  return record.payload.decision;
}

function findCommittedProposalRevision(records: readonly import('./project-store.js').ProjectLogRecord[], operationId: string, proposalId: string): ProjectSnapshot | undefined {
  const settled = records.some((record) => record.payload.kind === 'mutation.settled' && record.payload.settlement.mutationId === proposalId);
  if (!settled) return undefined;
  const record = [...records].reverse().find((candidate) => candidate.payload.kind === 'revision.committed' && candidate.payload.snapshot.revision.operationId === operationId);
  return record?.payload.kind === 'revision.committed' ? record.payload.snapshot : undefined;
}

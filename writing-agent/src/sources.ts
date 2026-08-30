import { canonicalSha256, contentId, nowTimestamp, randomId, textSha256 } from './canonical.js';
import {
  claimEvidenceRelationSchema,
  claimSchema,
  editorialDecisionSchema,
  sourceRecordSchema,
  type Claim,
  type ClaimEvidenceRelation,
  type EditorialDecision,
  type ProjectSnapshot,
  type SourceRecord
} from './domain.js';
import type { WritingProject } from './project.js';
import { readRootedText, snapshotParts } from './project.js';
import { createProjectRevision } from './project-store.js';
import { offsetRange } from './text-ranges.js';

export interface SourceIdentityVerifier {
  readonly implementationId: string;
  readonly verificationPolicyId: string;
  verify(input: {
    readonly kind: string;
    readonly title?: string;
    readonly authors: readonly string[];
    readonly date?: string;
    readonly authoritativeIdentifiers: readonly { readonly scheme: string; readonly value: string; readonly evidence: string }[];
    readonly exactSha256: string;
  }): Promise<'verified' | 'conflicting' | 'unavailable'>;
}

export interface SemanticEvidenceVerifier {
  readonly implementationId: string;
  readonly verificationPolicyId: string;
  readonly calibrationId?: string;
  verify(input: {
    readonly claim: Claim;
    readonly source: SourceRecord;
    readonly excerptText: string;
    readonly relationKind: ClaimEvidenceRelation['kind'];
  }): Promise<{ readonly verdict: ClaimEvidenceRelation['verdict']; readonly evidence: string; readonly explanation: string }>;
}

export async function addManualSource(project: WritingProject, input: {
  readonly kind: string;
  readonly title?: string;
  readonly authors?: readonly string[];
  readonly date?: string;
  readonly localResourceId: string;
  readonly accessMetadata?: Record<string, unknown>;
  readonly rightsMetadata?: Record<string, unknown>;
  readonly authoritativeIdentifiers?: readonly { readonly scheme: string; readonly value: string; readonly evidence: string }[];
  readonly excerpts?: readonly { readonly excerptId?: string; readonly range: SourceRecord['excerpts'][number]['range']; readonly expectedText: string }[];
  readonly identityVerifier?: SourceIdentityVerifier;
  readonly clock?: () => Date;
}): Promise<SourceRecord> {
  const clock = input.clock ?? (() => new Date());
  const view = await project.store.view();
  const resource = view.current.resources.find((candidate) => candidate.resourceId === input.localResourceId);
  if (resource === undefined) throw new Error(`Manual source resource is not managed: ${input.localResourceId}`);
  const file = await readRootedText(project.authority, resource.relativePath, 64 * 1024 * 1024);
  if (file.sha256 !== resource.currentSha256) throw new Error(`Manual source resource hash is stale: ${input.localResourceId}`);
  const excerpts = (input.excerpts ?? []).map((excerpt) => {
    const offsets = offsetRange(file.content, excerpt.range);
    const actual = file.content.slice(offsets.start, offsets.end);
    if (actual !== excerpt.expectedText) throw new Error(`Source excerpt expected text does not match its exact range: ${excerpt.excerptId ?? 'new excerpt'}`);
    return {
      excerptId: excerpt.excerptId ?? randomId('excerpt'),
      resourceId: input.localResourceId,
      sourceRevisionSha256: file.sha256,
      range: excerpt.range,
      rangeSha256: canonicalSha256(excerpt.range),
      textSha256: textSha256(actual)
    };
  });
  const authoritativeIdentifiers = input.authoritativeIdentifiers ?? [];
  const identityStatus = input.identityVerifier === undefined || authoritativeIdentifiers.length === 0
    ? 'unverified' as const
    : await input.identityVerifier.verify({
      kind: input.kind,
      ...(input.title === undefined ? {} : { title: input.title }),
      authors: input.authors ?? [],
      ...(input.date === undefined ? {} : { date: input.date }),
      authoritativeIdentifiers,
      exactSha256: file.sha256
    });
  const sourceId = randomId('source');
  const source = sourceRecordSchema.parse({
    sourceId,
    kind: input.kind,
    ...(input.title === undefined ? {} : { title: input.title }),
    authors: input.authors ?? [],
    ...(input.date === undefined ? {} : { date: input.date }),
    localResourceId: input.localResourceId,
    exactSha256: file.sha256,
    ...(input.accessMetadata === undefined ? {} : { accessMetadata: input.accessMetadata }),
    ...(input.rightsMetadata === undefined ? {} : { rightsMetadata: input.rightsMetadata }),
    identityStatus,
    authoritativeIdentifiers,
    ...(input.identityVerifier === undefined ? {} : { identityVerifierId: input.identityVerifier.implementationId, verificationPolicyId: input.identityVerifier.verificationPolicyId }),
    excerpts,
    contradictions: [],
    unsupportedFindings: [],
    omittedRelevantEvidenceFindings: [],
    addedAt: nowTimestamp(clock)
  });
  const operationId = randomId('source-addition');
  const snapshot = createProjectRevision({
    ...snapshotParts(view.current),
    parentRevisionIds: [view.current.revision.revisionId],
    briefRevisionId: view.current.brief.briefRevisionId,
    operationId,
    timestamp: nowTimestamp(clock),
    sources: [...view.current.sources, source]
  });
  await project.store.appendSource(source, snapshot, view.current.revision.revisionId);
  return source;
}

export async function adoptClaim(project: WritingProject, input: {
  readonly claimId?: string;
  readonly statement: string;
  readonly scope: string;
  readonly origin: Claim['origin'];
  readonly status?: Claim['status'];
  readonly clock?: () => Date;
}): Promise<Claim> {
  const clock = input.clock ?? (() => new Date());
  const view = await project.store.view();
  const claimId = input.claimId ?? randomId('claim');
  const prior = view.current.claims.filter((claim) => claim.claimId === claimId).sort((left, right) => right.version - left.version)[0];
  if (prior?.statement === input.statement && prior.scope === input.scope && prior.status !== 'superseded') throw new Error(`Claim version already exists without a superseding change: ${claimId}`);
  const operationId = randomId('claim-adoption');
  const provisional = claimSchema.parse({
    claimId,
    version: (prior?.version ?? 0) + 1,
    statement: input.statement,
    scope: input.scope,
    origin: input.origin,
    status: input.status ?? 'adopted',
    projectRevisionId: view.current.revision.revisionId
  });
  const claims = prior === undefined
    ? [...view.current.claims, provisional]
    : [...view.current.claims.map((claim) => claim.claimId === prior.claimId && claim.version === prior.version ? { ...claim, status: 'superseded' as const } : claim), provisional];
  const provisionalSnapshot = createProjectRevision({
    ...snapshotParts(view.current),
    parentRevisionIds: [view.current.revision.revisionId],
    briefRevisionId: view.current.brief.briefRevisionId,
    operationId,
    timestamp: nowTimestamp(clock),
    claims
  });
  const claim = { ...provisional, projectRevisionId: provisionalSnapshot.revision.revisionId };
  const snapshot = createProjectRevision({
    ...snapshotParts(provisionalSnapshot),
    parentRevisionIds: [view.current.revision.revisionId],
    briefRevisionId: view.current.brief.briefRevisionId,
    operationId,
    timestamp: provisionalSnapshot.revision.timestamp,
    claims: claims.map((candidate) => candidate.claimId === claim.claimId && candidate.version === claim.version ? claim : candidate)
  });
  await project.store.appendEvidence({ claim, snapshot, expectedRevisionId: view.current.revision.revisionId });
  return claim;
}

export async function verifyClaimEvidence(project: WritingProject, input: {
  readonly claimId: string;
  readonly claimVersion: number;
  readonly sourceId: string;
  readonly excerptId: string;
  readonly kind: ClaimEvidenceRelation['kind'];
  readonly criterionIds?: readonly string[];
  readonly verifier?: SemanticEvidenceVerifier;
  readonly clock?: () => Date;
}): Promise<ClaimEvidenceRelation> {
  const clock = input.clock ?? (() => new Date());
  const view = await project.store.view();
  const claim = view.current.claims.find((candidate) => candidate.claimId === input.claimId && candidate.version === input.claimVersion);
  if (claim === undefined) throw new Error(`Claim version is unavailable: ${input.claimId}@${String(input.claimVersion)}`);
  const source = view.current.sources.find((candidate) => candidate.sourceId === input.sourceId);
  if (source === undefined) throw new Error(`Source is unavailable: ${input.sourceId}`);
  const excerpt = source.excerpts.find((candidate) => candidate.excerptId === input.excerptId);
  if (excerpt === undefined || source.localResourceId === undefined) throw new Error(`Source excerpt is unavailable: ${input.excerptId}`);
  const resource = view.current.resources.find((candidate) => candidate.resourceId === source.localResourceId);
  if (resource === undefined) throw new Error(`Source local resource is unavailable: ${source.localResourceId}`);
  const file = await readRootedText(project.authority, resource.relativePath, 64 * 1024 * 1024);
  if (file.sha256 !== source.exactSha256 || file.sha256 !== excerpt.sourceRevisionSha256) throw new Error(`Source content changed since excerpt capture: ${source.sourceId}`);
  const offsets = offsetRange(file.content, excerpt.range);
  const excerptText = file.content.slice(offsets.start, offsets.end);
  if (textSha256(excerptText) !== excerpt.textSha256 || canonicalSha256(excerpt.range) !== excerpt.rangeSha256) throw new Error(`Source excerpt range or text hash is invalid: ${excerpt.excerptId}`);
  let verification: { verdict: ClaimEvidenceRelation['verdict']; evidence: string; explanation: string };
  let verifierId: string;
  let policyId: string;
  let calibrationId: string | undefined;
  if (input.kind === 'direct-quotation' && claim.statement === excerptText) {
    verification = { verdict: 'supported', evidence: 'Claim text equals the exact source excerpt.', explanation: 'Deterministic quotation equality passed.' };
    verifierId = 'writing-agent.quotation-equality@1';
    policyId = 'writing-agent.direct-quotation@1';
  } else if (input.verifier === undefined) {
    verification = { verdict: 'unknown', evidence: 'No calibrated semantic verifier was supplied.', explanation: 'Citation identity and excerpt consistency do not prove semantic support.' };
    verifierId = 'writing-agent.no-semantic-verifier@1';
    policyId = 'writing-agent.semantic-support@1';
  } else {
    verification = await input.verifier.verify({ claim, source, excerptText, relationKind: input.kind });
    verifierId = input.verifier.implementationId;
    policyId = input.verifier.verificationPolicyId;
    calibrationId = input.verifier.calibrationId;
  }
  const relation = claimEvidenceRelationSchema.parse({
    relationId: contentId('evidence-relation', { claimId: claim.claimId, claimVersion: claim.version, sourceId: source.sourceId, excerptId: excerpt.excerptId, kind: input.kind }),
    claimId: claim.claimId,
    claimVersion: claim.version,
    sourceId: source.sourceId,
    excerptId: excerpt.excerptId,
    sourceRevisionSha256: excerpt.sourceRevisionSha256,
    rangeSha256: excerpt.rangeSha256,
    kind: input.kind,
    verdict: verification.verdict,
    verifierId,
    verificationPolicyId: policyId,
    ...(calibrationId === undefined ? {} : { calibrationId }),
    criterionEvidence: (input.criterionIds ?? []).map((criterionId) => ({ criterionId, evidence: verification.evidence, explanation: verification.explanation }))
  });
  const operationId = randomId('evidence-verification');
  const snapshot = createProjectRevision({
    ...snapshotParts(view.current),
    parentRevisionIds: [view.current.revision.revisionId],
    briefRevisionId: view.current.brief.briefRevisionId,
    operationId,
    timestamp: nowTimestamp(clock),
    evidenceRelations: [...view.current.evidenceRelations.filter((candidate) => candidate.relationId !== relation.relationId), relation]
  });
  await project.store.appendEvidence({ relation, snapshot, expectedRevisionId: view.current.revision.revisionId });
  return relation;
}

export async function recordEvidenceOverride(project: WritingProject, input: {
  readonly relationId: string;
  readonly decision: 'accepted' | 'rejected' | 'override';
  readonly explanation: string;
  readonly clock?: () => Date;
}): Promise<EditorialDecision> {
  const clock = input.clock ?? (() => new Date());
  const view = await project.store.view();
  if (!view.current.evidenceRelations.some((relation) => relation.relationId === input.relationId)) throw new Error(`Evidence relation is unavailable: ${input.relationId}`);
  const decision = editorialDecisionSchema.parse({
    decisionId: contentId('decision', input),
    projectRevisionId: view.current.revision.revisionId,
    findingIds: [input.relationId],
    decision: input.decision,
    explanation: input.explanation,
    actor: 'human',
    createdAt: nowTimestamp(clock)
  });
  const operationId = randomId('evidence-decision');
  const snapshot = createProjectRevision({
    ...snapshotParts(view.current),
    parentRevisionIds: [view.current.revision.revisionId],
    briefRevisionId: view.current.brief.briefRevisionId,
    operationId,
    timestamp: nowTimestamp(clock),
    editorialDecisions: [...view.current.editorialDecisions, decision]
  });
  await project.store.appendProjectRevision({
    change: { changeKind: 'evidence', operationId, affectedIds: [input.relationId, decision.decisionId], summary: 'Recorded a human evidence decision without rewriting the verifier result.' },
    snapshot,
    expectedRevisionId: view.current.revision.revisionId,
    cause: 'provenance'
  });
  return decision;
}

export function sourceEvidenceStatus(source: SourceRecord): 'verified' | 'inconclusive' | 'failed' {
  if (source.identityStatus === 'verified') return 'verified';
  if (source.identityStatus === 'conflicting') return 'failed';
  return 'inconclusive';
}

export function evidenceGraphSha256(snapshot: ProjectSnapshot): string {
  return canonicalSha256({ sources: snapshot.sources, claims: snapshot.claims, evidenceRelations: snapshot.evidenceRelations });
}

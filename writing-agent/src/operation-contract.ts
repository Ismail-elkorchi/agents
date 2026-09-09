import { hashJson } from '@agent-core/persistence';
import type {
  Claim,
  ClaimEvidenceRelation,
  EditorialDecision,
  ProjectSnapshot,
  SourceRecord,
  WritingBriefRevision,
  WritingIntent,
  WritingOperation
} from './domain.js';

export const WRITING_OPERATION_CONTRACT_IMPLEMENTATION_ID = 'writing-agent.operation-contract@2';
export const MAX_WRITING_OPERATION_CONTRACT_BYTES = 128 * 1024;

export interface WritingOperationContract {
  readonly contract: typeof WRITING_OPERATION_CONTRACT_IMPLEMENTATION_ID;
  readonly operationId: string;
  readonly operationHash: string;
  readonly baseProjectRevisionId: string;
  readonly briefRevisionId: string;
  readonly kind: WritingOperation['kind'];
  readonly mode: WritingOperation['mode'];
  readonly aggregateInstruction: string;
  readonly intents: readonly WritingIntent[];
  readonly targets: {
    readonly nodes: readonly ProjectSnapshot['nodes'][number][];
    readonly resources: readonly ProjectSnapshot['resources'][number][];
    readonly exactRanges: readonly {
      readonly resourceId: string;
      readonly range: Pick<
        ProjectSnapshot['resources'][number]['protectedRanges'][number],
        'rangeId' | 'range'
      >;
    }[];
  };
  readonly briefRequirements: Omit<
    WritingBriefRevision,
    'projectId' | 'briefRevisionId' | 'parentBriefRevisionId' | 'acceptanceCriteria' | 'createdAt'
  >;
  readonly applicableCriteria: WritingBriefRevision['acceptanceCriteria'];
  readonly verification: {
    readonly semanticIntentIds: readonly string[];
    readonly editorialCriterionIds: readonly string[];
  };
  readonly effectiveConstraints: WritingOperation['effectiveConstraints'];
  readonly evidenceRequirements: {
    readonly claims: readonly Claim[];
    readonly claimEvidenceRelations: readonly ClaimEvidenceRelation[];
    readonly documentRelations: readonly ProjectSnapshot['relations'][number][];
    readonly sources: readonly SourceRecord[];
    readonly editorialDecisions: readonly EditorialDecision[];
    readonly readableSourceResourceIds: readonly string[];
  };
}

/** Freezes the complete bounded normative contract shared by producer and verifier. */
export function createWritingOperationContract(
  operation: WritingOperation,
  snapshot: ProjectSnapshot
): WritingOperationContract {
  if (operation.baseProjectRevisionId !== snapshot.revision.revisionId)
    throw new Error('Writing operation contract requires the exact admitted project revision.');
  if (operation.briefRevisionId !== snapshot.brief.briefRevisionId)
    throw new Error('Writing operation contract requires the exact admitted brief revision.');

  const affectedClaimIds = new Set(operation.intents.flatMap((intent) => intent.affectedClaimIds));
  const affectedRelationIds = new Set(operation.intents.flatMap((intent) => intent.affectedRelationIds));
  const affectedDecisionIds = new Set(
    operation.intents.flatMap((intent) => intent.affectedEditorialDecisionIds)
  );
  const claims = sorted(
    snapshot.claims.filter((claim) => affectedClaimIds.has(claim.claimId)),
    (claim) => claim.claimId
  );
  const claimEvidenceRelations = sorted(
    snapshot.evidenceRelations.filter(
      (relation) => affectedRelationIds.has(relation.relationId) || affectedClaimIds.has(relation.claimId)
    ),
    (relation) => relation.relationId
  );
  const sourceIds = new Set(claimEvidenceRelations.map((relation) => relation.sourceId));
  const sources = sorted(
    snapshot.sources.filter((source) => sourceIds.has(source.sourceId)),
    (source) => source.sourceId
  );
  const documentRelations = sorted(
    snapshot.relations.filter((relation) => affectedRelationIds.has(relation.relationId)),
    (relation) => relation.relationId
  );
  const editorialDecisions = sorted(
    snapshot.editorialDecisions.filter((decision) => affectedDecisionIds.has(decision.decisionId)),
    (decision) => decision.decisionId
  );
  const targetResources = sorted(
    snapshot.resources.filter((resource) => operation.targetResourceIds.includes(resource.resourceId)),
    (resource) => resource.resourceId
  );
  const targetRangeIds = new Set(operation.intents.flatMap((intent) => intent.targetRangeIds));
  const exactRanges = Object.freeze([
    ...targetResources.flatMap((resource) =>
      resource.protectedRanges
        .filter((range) => targetRangeIds.has(range.rangeId))
        .map((range) => Object.freeze({ resourceId: resource.resourceId, range }))
    ),
    ...operation.selectedRanges.map((selected) => ({
      resourceId: selected.resourceId,
      range: { rangeId: selected.rangeId, range: selected.range }
    }))
  ]);
  const {
    projectId: _projectId,
    briefRevisionId: _briefRevisionId,
    parentBriefRevisionId: _parentBriefRevisionId,
    acceptanceCriteria: _acceptanceCriteria,
    createdAt: _createdAt,
    ...briefRequirements
  } = snapshot.brief;
  void _projectId;
  void _briefRevisionId;
  void _parentBriefRevisionId;
  void _acceptanceCriteria;
  void _createdAt;

  const contract: WritingOperationContract = {
    contract: WRITING_OPERATION_CONTRACT_IMPLEMENTATION_ID,
    operationId: operation.operationId,
    operationHash: hashJson(operation),
    baseProjectRevisionId: operation.baseProjectRevisionId,
    briefRevisionId: operation.briefRevisionId,
    kind: operation.kind,
    mode: operation.mode,
    aggregateInstruction: operation.instruction,
    intents: operation.intents,
    targets: Object.freeze({
      nodes: sorted(
        snapshot.nodes.filter((node) => operation.targetNodeIds.includes(node.nodeId)),
        (node) => node.nodeId
      ),
      resources: targetResources,
      exactRanges
    }),
    briefRequirements: Object.freeze(briefRequirements),
    applicableCriteria: snapshot.brief.acceptanceCriteria,
    verification: Object.freeze({
      semanticIntentIds: Object.freeze(
        operation.intents
          .filter(
            (intent) =>
              intent.verification === 'semantic' ||
              intent.preservationRequirements.length > 0 ||
              intent.affectedClaimIds.length > 0 ||
              intent.affectedRelationIds.length > 0 ||
              intent.affectedEditorialDecisionIds.length > 0 ||
              intent.kind === 'text.translate'
          )
          .map((intent) => intent.intentId)
      ),
      editorialCriterionIds: Object.freeze(
        snapshot.brief.acceptanceCriteria
          .filter((criterion) => criterion.verificationKind === 'editorial')
          .map((criterion) => criterion.criterionId)
      )
    }),
    effectiveConstraints: operation.effectiveConstraints,
    evidenceRequirements: Object.freeze({
      claims,
      claimEvidenceRelations,
      documentRelations,
      sources,
      editorialDecisions,
      readableSourceResourceIds: Object.freeze(
        [
          ...new Set(
            sources.flatMap((source) =>
              source.localResourceId === undefined ? [] : [source.localResourceId]
            )
          )
        ].sort()
      )
    })
  };
  const bytes = Buffer.byteLength(JSON.stringify(contract));
  if (bytes > MAX_WRITING_OPERATION_CONTRACT_BYTES) {
    throw new Error(
      `Writing operation contract exceeds its ${String(MAX_WRITING_OPERATION_CONTRACT_BYTES)}-byte admission bound.`
    );
  }
  return Object.freeze(contract);
}

function sorted<T>(values: readonly T[], identity: (value: T) => string): readonly T[] {
  return Object.freeze([...values].sort((left, right) => identity(left).localeCompare(identity(right))));
}

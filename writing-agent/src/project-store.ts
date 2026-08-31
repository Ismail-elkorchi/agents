import { lstat } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import type { RootIdentity } from '@agent-core/tools-local';
import { adoptSchema, canonicalSha256, contentId, deepFreeze, nowTimestamp, randomId, textSha256 } from './canonical.js';
import { assertBriefIntegrity } from './brief.js';
import {
  authorshipProvenanceSchema,
  claimEvidenceRelationSchema,
  claimSchema,
  contextReceiptSchema,
  deterministicCheckSchema,
  editorialDecisionSchema,
  editorialFindingSchema,
  identifierSchema,
  projectSnapshotSchema,
  proposalQualityEvaluationSchema,
  revisionProposalSchema,
  sha256Schema,
  sourceRecordSchema,
  timestampSchema,
  writingBriefRevisionSchema,
  writingOperationSchema,
  type AuthorshipProvenance,
  type Claim,
  type ClaimEvidenceRelation,
  type ContextReceipt,
  type DeterministicCheck,
  type EditorialDecision,
  type EditorialFinding,
  type ProjectSnapshot,
  type ProposalQualityEvaluation,
  type RevisionProposal,
  type SourceRecord,
  type WritingBriefRevision,
  type WritingOperation
} from './domain.js';
import {
  appendPrivateLine,
  ensurePrivateDirectory,
  readSecureFile,
  readSecureFileIfPresent,
  withPrivateLock,
  writePrivateAtomic,
  type WritingStateRoot
} from './private-state.js';

const ZERO_HASH = '0'.repeat(64);
const MAX_LOG_BYTES = 256 * 1024 * 1024;

const rootIdentitySchema = z.strictObject({
  canonicalPath: z.string().trim().min(1).max(16_384),
  device: z.string().trim().min(1).max(256),
  inode: z.string().trim().min(1).max(256),
  mountId: z.string().trim().min(1).max(256)
});

export const writingProjectIdentitySchema = z.strictObject({
  projectId: identifierSchema,
  projectStoreId: identifierSchema,
  platform: z.string().trim().min(1).max(128),
  rootIdentity: rootIdentitySchema,
  createdAt: timestampSchema
});

export type WritingProjectIdentity = z.infer<typeof writingProjectIdentitySchema>;

const proposalLifecycleSchema = z.strictObject({
  proposalId: identifierSchema,
  expectedStatus: z.enum(['proposed', 'accepted', 'rejected', 'superseded']),
  status: z.enum(['accepted', 'rejected', 'superseded', 'applied']),
  decisionId: identifierSchema,
  explanation: z.string().trim().min(1).max(100_000)
});

const operationLifecycleSchema = z.strictObject({
  operationId: identifierSchema,
  runId: identifierSchema,
  status: z.enum(['suspended', 'completed', 'failed', 'aborted', 'inconclusive']),
  executionSha256: sha256Schema,
  proposalId: identifierSchema.optional(),
  committedRevisionId: identifierSchema.optional(),
  reason: z.string().trim().min(1).max(100_000).optional()
});

const assumptionStatusChangeSchema = z.strictObject({
  assumptionId: identifierSchema,
  previousStatus: z.literal('proposed'),
  status: z.enum(['accepted', 'rejected', 'superseded']),
  supersedingAssumptionId: identifierSchema.optional(),
  briefRevisionId: identifierSchema,
  decisionSource: z.literal('direct-user')
});

const mutationSettlementSchema = z.strictObject({
  mutationId: identifierSchema,
  operationId: identifierSchema,
  transactionId: identifierSchema,
  outcome: z.enum(['committed', 'committed_with_residue', 'rolled_back', 'rollback_failed']),
  oldAndNewHashes: z.array(z.strictObject({ resourceId: identifierSchema, path: z.string().trim().min(1).max(4_096), oldSha256: sha256Schema.optional(), newSha256: sha256Schema.optional(), changedAnchorIds: z.array(identifierSchema) })),
  changedPaths: z.array(z.string().trim().min(1).max(4_096)),
  addedPaths: z.array(z.string().trim().min(1).max(4_096)),
  deletedPaths: z.array(z.string().trim().min(1).max(4_096)),
  cleanup: z.enum(['succeeded', 'failed', 'uncertain']),
  remainingUncertainty: z.array(z.string().trim().min(1).max(100_000))
});

const projectChangeSchema = z.strictObject({
  changeKind: z.enum(['resource', 'structure', 'relation', 'brief', 'source', 'claim', 'evidence', 'voice', 'provenance', 'undo', 'delivery']),
  operationId: identifierSchema,
  affectedIds: z.array(identifierSchema),
  beforeSha256: sha256Schema.optional(),
  afterSha256: sha256Schema.optional(),
  summary: z.string().trim().min(1).max(100_000)
});

const deliveryRecordSchema = z.strictObject({
  deliveryId: identifierSchema,
  projectRevisionId: identifierSchema,
  operationId: identifierSchema,
  format: z.string().trim().min(1).max(256),
  resourceIds: z.array(identifierSchema),
  deliveredAt: timestampSchema
});

const eventPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('project.created'), identity: writingProjectIdentitySchema }),
  z.strictObject({ kind: z.literal('brief.revised'), brief: writingBriefRevisionSchema }),
  z.strictObject({ kind: z.literal('assumption.status-changed'), change: assumptionStatusChangeSchema }),
  z.strictObject({ kind: z.literal('operation.admitted'), operation: writingOperationSchema }),
  z.strictObject({ kind: z.literal('operation.lifecycle'), lifecycle: operationLifecycleSchema }),
  z.strictObject({ kind: z.literal('context.recorded'), receipt: contextReceiptSchema }),
  z.strictObject({ kind: z.literal('proposal.created'), proposal: revisionProposalSchema }),
  z.strictObject({ kind: z.literal('proposal.quality-evaluated'), evaluation: proposalQualityEvaluationSchema }),
  z.strictObject({ kind: z.literal('proposal.lifecycle'), lifecycle: proposalLifecycleSchema }),
  z.strictObject({ kind: z.literal('mutation.settled'), settlement: mutationSettlementSchema }),
  z.strictObject({ kind: z.literal('revision.committed'), snapshot: projectSnapshotSchema, cause: z.enum(['initial', 'brief', 'proposal', 'direct', 'structure', 'undo', 'source', 'evidence', 'provenance']) }),
  z.strictObject({ kind: z.literal('project.changed'), change: projectChangeSchema }),
  z.strictObject({ kind: z.literal('source.added'), source: sourceRecordSchema }),
  z.strictObject({ kind: z.literal('claim.adopted'), claim: claimSchema }),
  z.strictObject({ kind: z.literal('evidence.verified'), relation: claimEvidenceRelationSchema }),
  z.strictObject({ kind: z.literal('authorship.recorded'), provenance: z.array(authorshipProvenanceSchema).min(1) }),
  z.strictObject({ kind: z.literal('check.recorded'), check: deterministicCheckSchema }),
  z.strictObject({ kind: z.literal('editorial.finding'), finding: editorialFindingSchema }),
  z.strictObject({ kind: z.literal('editorial.decision'), decision: editorialDecisionSchema }),
  z.strictObject({ kind: z.literal('delivery.recorded'), delivery: deliveryRecordSchema })
]);

const logRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  recordId: identifierSchema,
  timestamp: timestampSchema,
  projectId: identifierSchema,
  projectRevisionId: identifierSchema.optional(),
  payload: eventPayloadSchema
});

const logEnvelopeSchema = z.strictObject({
  previousHash: sha256Schema,
  record: logRecordSchema,
  recordHash: sha256Schema
});

const headPointerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: identifierSchema,
  revisionId: identifierSchema,
  recordHash: sha256Schema
});

export type ProjectLogRecord = z.infer<typeof logRecordSchema>;
export type ProjectMutationSettlement = z.infer<typeof mutationSettlementSchema>;
export type WritingOperationLifecycle = z.infer<typeof operationLifecycleSchema>;
export type ProposalStatus = 'proposed' | 'accepted' | 'rejected' | 'superseded' | 'applied';

export interface ProjectView {
  readonly identity: WritingProjectIdentity;
  readonly records: readonly ProjectLogRecord[];
  readonly current: ProjectSnapshot;
  readonly proposals: ReadonlyMap<string, { readonly proposal: RevisionProposal; readonly status: ProposalStatus }>;
  readonly qualityEvaluations: ReadonlyMap<string, ProposalQualityEvaluation>;
  readonly operations: ReadonlyMap<string, WritingOperation>;
  readonly operationLifecycles: ReadonlyMap<string, WritingOperationLifecycle>;
  readonly contexts: ReadonlyMap<string, ContextReceipt>;
  readonly settlements: ReadonlyMap<string, ProjectMutationSettlement>;
}

export class WritingProjectStore {
  readonly identity: WritingProjectIdentity;
  readonly recoveryIdentity: string;
  readonly #directory: string;
  readonly #clock: () => Date;

  private constructor(directory: string, identity: WritingProjectIdentity, clock: () => Date) {
    this.#directory = directory;
    this.identity = identity;
    this.#clock = clock;
    this.recoveryIdentity = `writing-project-store:${identity.projectStoreId}`;
  }

  static async create(input: {
    readonly state: WritingStateRoot;
    readonly rootIdentity: RootIdentity;
    readonly brief: WritingBriefRevision;
    readonly initialSnapshot: ProjectSnapshot;
    readonly projectId?: string;
    readonly projectStoreId?: string;
    readonly clock?: () => Date;
  }): Promise<WritingProjectStore> {
    const clock = input.clock ?? (() => new Date());
    const projectId = input.projectId ?? randomId('project');
    if (input.brief.projectId !== projectId || input.initialSnapshot.brief.projectId !== projectId) throw new Error('Initial writing records do not match the project identity.');
    const identity = adoptSchema(writingProjectIdentitySchema, {
      projectId,
      projectStoreId: input.projectStoreId ?? randomId('project-store'),
      platform: process.platform,
      rootIdentity: input.rootIdentity,
      createdAt: nowTimestamp(clock)
    });
    const directory = input.state.projectDirectory(projectId);
    if (await exists(directory)) throw new Error(`Writing project already exists: ${projectId}`);
    await ensurePrivateDirectory(directory);
    await ensurePrivateDirectory(path.join(directory, 'objects'));
    const store = new WritingProjectStore(directory, identity, clock);
    await store.appendMany([
      { payload: { kind: 'project.created', identity } },
      { payload: { kind: 'brief.revised', brief: input.brief }, projectRevisionId: input.initialSnapshot.revision.revisionId },
      { payload: { kind: 'revision.committed', snapshot: input.initialSnapshot, cause: 'initial' }, projectRevisionId: input.initialSnapshot.revision.revisionId }
    ], { expectedRevisionId: undefined });
    await store.rebuildIndex();
    return store;
  }

  static async open(input: {
    readonly state: WritingStateRoot;
    readonly projectId: string;
    readonly expectedRootIdentity?: RootIdentity;
    readonly clock?: () => Date;
  }): Promise<WritingProjectStore> {
    const directory = input.state.projectDirectory(input.projectId);
    const records = await readLog(directory);
    const creation = records[0];
    if (creation?.payload.kind !== 'project.created') throw new Error(`Writing project ${input.projectId} has no valid creation record.`);
    const identity = creation.payload.identity;
    if (identity.projectId !== input.projectId) throw new Error(`Writing project directory does not match its creation identity: ${input.projectId}`);
    if (input.expectedRootIdentity !== undefined && !sameRootIdentity(identity.rootIdentity, input.expectedRootIdentity)) {
      throw new Error(`Writing project ${input.projectId} belongs to another physical project root.`);
    }
    const store = new WritingProjectStore(directory, identity, input.clock ?? (() => new Date()));
    await store.assertOrRebuildHead(records);
    return store;
  }

  static async findByRoot(input: { readonly state: WritingStateRoot; readonly rootIdentity: RootIdentity }): Promise<WritingProjectStore | undefined> {
    const matches: WritingProjectStore[] = [];
    for (const projectId of await input.state.listProjectIds()) {
      const store = await WritingProjectStore.open({ state: input.state, projectId });
      if (sameRootIdentity(store.identity.rootIdentity, input.rootIdentity)) matches.push(store);
    }
    if (matches.length > 1) throw new Error('Several writing projects claim the same physical root; select a project ID explicitly.');
    return matches[0];
  }

  async view(): Promise<ProjectView> {
    return projectView(await this.records(), this.identity);
  }

  async records(): Promise<readonly ProjectLogRecord[]> {
    return readLog(this.#directory);
  }

  async appendBrief(brief: WritingBriefRevision, snapshot: ProjectSnapshot, expectedRevisionId: string): Promise<void> {
    const previous = (await this.view()).current.brief;
    const previousAssumptions = new Map(previous.assumptions.map((assumption) => [assumption.assumptionId, assumption]));
    const statusChanges = brief.assumptions.flatMap((assumption) => {
      const prior = previousAssumptions.get(assumption.assumptionId);
      if (prior === undefined || prior.status === assumption.status) return [];
      if (prior.status !== 'proposed' || assumption.status === 'proposed') throw new Error(`Invalid durable assumption status transition: ${assumption.assumptionId}`);
      return [{
        payload: {
          kind: 'assumption.status-changed' as const,
          change: {
            assumptionId: assumption.assumptionId,
            previousStatus: prior.status,
            status: assumption.status,
            ...(assumption.supersedingAssumptionId === undefined ? {} : { supersedingAssumptionId: assumption.supersedingAssumptionId }),
            briefRevisionId: brief.briefRevisionId,
            decisionSource: 'direct-user' as const
          }
        },
        projectRevisionId: snapshot.revision.revisionId
      }];
    });
    await this.appendMany([
      ...statusChanges,
      { payload: { kind: 'brief.revised', brief }, projectRevisionId: snapshot.revision.revisionId },
      { payload: { kind: 'project.changed', change: { changeKind: 'brief', operationId: snapshot.revision.operationId, affectedIds: [brief.briefRevisionId], summary: 'Writing brief amended.' } }, projectRevisionId: snapshot.revision.revisionId },
      { payload: { kind: 'revision.committed', snapshot, cause: 'brief' }, projectRevisionId: snapshot.revision.revisionId }
    ], { expectedRevisionId });
  }

  async appendOperation(operation: WritingOperation, expectedRevisionId: string): Promise<void> {
    await this.appendMany([{ payload: { kind: 'operation.admitted', operation }, projectRevisionId: expectedRevisionId }], { expectedRevisionId });
  }

  async appendOperationLifecycle(input: z.input<typeof operationLifecycleSchema>, expectedRevisionId: string): Promise<void> {
    const lifecycle = adoptSchema(operationLifecycleSchema, input);
    const existing = await this.operationLifecycleReceipt(lifecycle.operationId);
    if (existing !== undefined && existing.status !== 'suspended') {
      if (sameOperationSettlement(existing, lifecycle)) return;
      throw new Error(`Writing operation already has a conflicting terminal settlement: ${lifecycle.operationId}`);
    }
    if (existing !== undefined && sameOperationSettlement(existing, lifecycle)) return;
    await this.appendMany([{ payload: { kind: 'operation.lifecycle', lifecycle }, projectRevisionId: expectedRevisionId }], { expectedRevisionId });
  }

  async appendContext(receipt: ContextReceipt, expectedRevisionId: string): Promise<void> {
    await this.appendMany([{ payload: { kind: 'context.recorded', receipt }, projectRevisionId: expectedRevisionId }], { expectedRevisionId });
  }

  async appendProposal(proposal: RevisionProposal): Promise<void> {
    const view = await this.view();
    const superseded = [...view.proposals.values()].filter((entry) => entry.proposal.operationId === proposal.operationId && entry.status === 'proposed');
    await this.appendMany([
      ...superseded.map((entry) => ({
        payload: {
          kind: 'proposal.lifecycle' as const,
          lifecycle: {
            proposalId: entry.proposal.proposalId,
            expectedStatus: 'proposed' as const,
            status: 'superseded' as const,
            decisionId: contentId('proposal-supersession', { previousProposalId: entry.proposal.proposalId, proposalId: proposal.proposalId }),
            explanation: `Superseded by revised proposal ${proposal.proposalId}.`
          }
        },
        projectRevisionId: proposal.baseProjectRevisionId
      })),
      { payload: { kind: 'proposal.created' as const, proposal }, projectRevisionId: proposal.baseProjectRevisionId }
    ], { expectedRevisionId: proposal.baseProjectRevisionId });
  }

  async appendProposalQuality(evaluation: ProposalQualityEvaluation): Promise<void> {
    const parsed = proposalQualityEvaluationSchema.parse(evaluation);
    const existing = await this.qualityEvaluationReceipt(parsed.proposalId);
    if (existing !== undefined) {
      if (canonicalSha256(existing) !== canonicalSha256(parsed)) throw new Error(`Proposal quality evaluation conflicts with its durable receipt: ${parsed.proposalId}`);
      return;
    }
    await this.appendMany([{ payload: { kind: 'proposal.quality-evaluated', evaluation: parsed }, projectRevisionId: parsed.baseProjectRevisionId }], { expectedRevisionId: parsed.baseProjectRevisionId });
  }

  async appendProposalLifecycle(input: z.input<typeof proposalLifecycleSchema>, expectedRevisionId: string): Promise<void> {
    const lifecycle = adoptSchema(proposalLifecycleSchema, input);
    await this.appendMany([{ payload: { kind: 'proposal.lifecycle', lifecycle }, projectRevisionId: expectedRevisionId }], { expectedRevisionId });
  }

  async appendProposalDecision(input: {
    readonly lifecycle: z.input<typeof proposalLifecycleSchema>;
    readonly decision: EditorialDecision;
    readonly expectedRevisionId: string;
  }): Promise<void> {
    const lifecycle = adoptSchema(proposalLifecycleSchema, input.lifecycle);
    await this.appendMany([
      { payload: { kind: 'editorial.decision', decision: input.decision }, projectRevisionId: input.expectedRevisionId },
      { payload: { kind: 'proposal.lifecycle', lifecycle }, projectRevisionId: input.expectedRevisionId }
    ], { expectedRevisionId: input.expectedRevisionId });
  }

  async appendAppliedRevision(input: {
    readonly settlement: ProjectMutationSettlement;
    readonly provenance: readonly AuthorshipProvenance[];
    readonly checks: readonly DeterministicCheck[];
    readonly findings: readonly EditorialFinding[];
    readonly decision: EditorialDecision;
    readonly snapshot: ProjectSnapshot;
    readonly expectedRevisionId: string;
    readonly cause?: 'proposal' | 'direct' | 'structure' | 'undo' | 'source' | 'evidence' | 'provenance';
  }): Promise<void> {
    const records: AppendRecordInput[] = [
      { payload: { kind: 'mutation.settled', settlement: input.settlement }, projectRevisionId: input.snapshot.revision.revisionId },
      ...(input.provenance.length > 0 ? [{ payload: { kind: 'authorship.recorded' as const, provenance: [...input.provenance] }, projectRevisionId: input.snapshot.revision.revisionId }] : []),
      ...input.checks.map((check) => ({ payload: { kind: 'check.recorded' as const, check }, projectRevisionId: input.snapshot.revision.revisionId })),
      ...input.findings.map((finding) => ({ payload: { kind: 'editorial.finding' as const, finding }, projectRevisionId: input.snapshot.revision.revisionId })),
      { payload: { kind: 'proposal.lifecycle', lifecycle: { proposalId: requiredDecisionProposal(input.decision), expectedStatus: 'accepted', status: 'applied', decisionId: input.decision.decisionId, explanation: input.decision.explanation } }, projectRevisionId: input.snapshot.revision.revisionId },
      { payload: { kind: 'revision.committed', snapshot: input.snapshot, cause: input.cause ?? 'proposal' }, projectRevisionId: input.snapshot.revision.revisionId }
    ];
    await this.appendMany(records, { expectedRevisionId: input.expectedRevisionId });
  }

  async appendUndoRevision(input: {
    readonly settlement: ProjectMutationSettlement;
    readonly provenance: readonly AuthorshipProvenance[];
    readonly decision: EditorialDecision;
    readonly snapshot: ProjectSnapshot;
    readonly expectedRevisionId: string;
    readonly restoredRevisionId: string;
  }): Promise<void> {
    const records: AppendRecordInput[] = [
      { payload: { kind: 'mutation.settled', settlement: input.settlement }, projectRevisionId: input.snapshot.revision.revisionId },
      ...(input.provenance.length > 0 ? [{ payload: { kind: 'authorship.recorded' as const, provenance: [...input.provenance] }, projectRevisionId: input.snapshot.revision.revisionId }] : []),
      { payload: { kind: 'editorial.decision', decision: input.decision }, projectRevisionId: input.snapshot.revision.revisionId },
      { payload: { kind: 'project.changed', change: { changeKind: 'undo', operationId: input.snapshot.revision.operationId, affectedIds: [input.restoredRevisionId], summary: `Compensating revision restores content from ${input.restoredRevisionId}.` } }, projectRevisionId: input.snapshot.revision.revisionId },
      { payload: { kind: 'revision.committed', snapshot: input.snapshot, cause: 'undo' }, projectRevisionId: input.snapshot.revision.revisionId }
    ];
    await this.appendMany(records, { expectedRevisionId: input.expectedRevisionId });
  }

  async appendSource(source: SourceRecord, snapshot: ProjectSnapshot, expectedRevisionId: string): Promise<void> {
    await this.appendMany([
      { payload: { kind: 'source.added', source }, projectRevisionId: snapshot.revision.revisionId },
      { payload: { kind: 'project.changed', change: { changeKind: 'source', operationId: snapshot.revision.operationId, affectedIds: [source.sourceId], afterSha256: source.exactSha256, summary: 'Manual source added and bound to exact content.' } }, projectRevisionId: snapshot.revision.revisionId },
      { payload: { kind: 'revision.committed', snapshot, cause: 'source' }, projectRevisionId: snapshot.revision.revisionId }
    ], { expectedRevisionId });
  }

  async appendProjectRevision(input: {
    readonly change: z.input<typeof projectChangeSchema>;
    readonly snapshot: ProjectSnapshot;
    readonly expectedRevisionId: string;
    readonly cause: 'direct' | 'structure' | 'undo' | 'provenance';
    readonly provenance?: readonly AuthorshipProvenance[];
  }): Promise<void> {
    const records: AppendRecordInput[] = [
      { payload: { kind: 'project.changed', change: projectChangeSchema.parse(input.change) }, projectRevisionId: input.snapshot.revision.revisionId },
      ...(input.provenance?.length ? [{ payload: { kind: 'authorship.recorded' as const, provenance: [...input.provenance] }, projectRevisionId: input.snapshot.revision.revisionId }] : []),
      { payload: { kind: 'revision.committed', snapshot: input.snapshot, cause: input.cause }, projectRevisionId: input.snapshot.revision.revisionId }
    ];
    await this.appendMany(records, { expectedRevisionId: input.expectedRevisionId });
  }

  async appendEvidence(input: { readonly claim?: Claim; readonly relation?: ClaimEvidenceRelation; readonly snapshot: ProjectSnapshot; readonly expectedRevisionId: string }): Promise<void> {
    const records: AppendRecordInput[] = [
      ...(input.claim ? [{ payload: { kind: 'claim.adopted' as const, claim: input.claim }, projectRevisionId: input.snapshot.revision.revisionId }] : []),
      ...(input.relation ? [{ payload: { kind: 'evidence.verified' as const, relation: input.relation }, projectRevisionId: input.snapshot.revision.revisionId }] : []),
      { payload: { kind: 'revision.committed', snapshot: input.snapshot, cause: 'evidence' }, projectRevisionId: input.snapshot.revision.revisionId }
    ];
    await this.appendMany(records, { expectedRevisionId: input.expectedRevisionId });
  }

  async putObject(content: string): Promise<string> {
    const sha256 = textSha256(content);
    const target = path.join(this.#directory, 'objects', sha256);
    const existing = await readSecureFileIfPresent(target, 64 * 1024 * 1024);
    if (existing !== undefined) {
      if (textSha256(existing) !== sha256) throw new Error(`Content-addressed object is corrupt: ${sha256}`);
      return sha256;
    }
    await writePrivateAtomic(target, content);
    return sha256;
  }

  async readObject(sha256: string): Promise<string> {
    const digest = sha256Schema.parse(sha256);
    const content = await readSecureFile(path.join(this.#directory, 'objects', digest), 64 * 1024 * 1024);
    if (textSha256(content) !== digest) throw new Error(`Content-addressed object does not match its identity: ${digest}`);
    return content;
  }

  async rebuildIndex(): Promise<void> {
    await this.assertOrRebuildHead(await this.records(), true);
  }

  async proposalReceipt(proposalId: string): Promise<RevisionProposal | undefined> {
    return (await this.view()).proposals.get(proposalId)?.proposal;
  }

  async qualityEvaluationReceipt(proposalId: string): Promise<ProposalQualityEvaluation | undefined> {
    return (await this.view()).qualityEvaluations.get(proposalId);
  }

  async operationLifecycleReceipt(operationId: string): Promise<WritingOperationLifecycle | undefined> {
    return (await this.view()).operationLifecycles.get(operationId);
  }

  private async appendMany(inputs: readonly AppendRecordInput[], guard: { readonly expectedRevisionId: string | undefined }): Promise<void> {
    if (inputs.length === 0) return;
    await withPrivateLock(this.#directory, async () => {
      let envelopes = await readLogEnvelopesIfPresent(this.#directory);
      const existingRecords = envelopes.map((item) => item.record);
      const currentRevisionId = latestSnapshot(existingRecords)?.revision.revisionId;
      if (guard.expectedRevisionId !== undefined && currentRevisionId !== guard.expectedRevisionId) {
        throw new Error(`Writing project base is stale: expected ${guard.expectedRevisionId}, current ${currentRevisionId ?? 'none'}.`);
      }
      let previousHash = envelopes.at(-1)?.recordHash ?? ZERO_HASH;
      for (const input of inputs) {
        const recordId = input.recordId ?? contentId('record', { projectId: this.identity.projectId, projectRevisionId: input.projectRevisionId, payload: input.payload });
        const duplicate = existingRecords.find((record) => record.recordId === recordId);
        if (duplicate !== undefined) {
          if (duplicate.projectRevisionId !== input.projectRevisionId || canonicalSha256(duplicate.payload) !== canonicalSha256(input.payload)) {
            throw new Error(`Project log record ID conflicts with different content: ${recordId}`);
          }
          continue;
        }
        const candidate = adoptSchema(logRecordSchema, {
          schemaVersion: 1,
          recordId,
          timestamp: input.timestamp ?? nowTimestamp(this.#clock),
          projectId: this.identity.projectId,
          ...(input.projectRevisionId === undefined ? {} : { projectRevisionId: input.projectRevisionId }),
          payload: input.payload
        });
        validateConcurrentTransition(existingRecords, candidate, this.identity);
        const recordHash = canonicalSha256({ previousHash, record: candidate });
        const envelope = adoptSchema(logEnvelopeSchema, { previousHash, record: candidate, recordHash });
        await appendPrivateLine(path.join(this.#directory, 'project.jsonl'), JSON.stringify(envelope));
        previousHash = recordHash;
        envelopes = [...envelopes, envelope];
        existingRecords.push(candidate);
      }
      const current = latestSnapshot(existingRecords);
      if (current !== undefined) await writeHead(this.#directory, this.identity.projectId, current.revision.revisionId, previousHash);
    });
  }

  private async assertOrRebuildHead(records: readonly ProjectLogRecord[], force = false): Promise<void> {
    const current = latestSnapshot(records);
    if (current === undefined) throw new Error(`Writing project ${this.identity.projectId} has no committed revision.`);
    const envelopes = await readLogEnvelopes(this.#directory);
    const lastHash = envelopes.at(-1)?.recordHash;
    if (lastHash === undefined) throw new Error(`Writing project ${this.identity.projectId} has no log.`);
    const text = force ? undefined : await readSecureFileIfPresent(path.join(this.#directory, 'head.json'), 32_000);
    if (text !== undefined) {
      const head = headPointerSchema.parse(JSON.parse(text));
      if (head.projectId === this.identity.projectId && head.revisionId === current.revision.revisionId && head.recordHash === lastHash) return;
    }
    await writeHead(this.#directory, this.identity.projectId, current.revision.revisionId, lastHash);
  }
}

function validateConcurrentTransition(
  records: readonly ProjectLogRecord[],
  candidate: ProjectLogRecord,
  identity: WritingProjectIdentity
): void {
  const payload = candidate.payload;
  if (payload.kind !== 'operation.lifecycle' && payload.kind !== 'proposal.quality-evaluated' && payload.kind !== 'proposal.lifecycle') return;
  const view = projectView(records, identity);
  if (payload.kind === 'operation.lifecycle') {
    const operation = view.operations.get(payload.lifecycle.operationId);
    if (operation?.runId !== payload.lifecycle.runId) throw new Error(`Operation lifecycle precedes or contradicts admission: ${payload.lifecycle.operationId}`);
    const previous = view.operationLifecycles.get(payload.lifecycle.operationId);
    if (previous !== undefined && previous.status !== 'suspended') throw new Error(`Operation lifecycle changes a terminal settlement: ${payload.lifecycle.operationId}`);
    return;
  }
  if (payload.kind === 'proposal.quality-evaluated') {
    const proposal = view.proposals.get(payload.evaluation.proposalId);
    if (proposal?.proposal.operationId !== payload.evaluation.operationId) throw new Error(`Proposal quality evaluation precedes or contradicts its proposal: ${payload.evaluation.proposalId}`);
    if (view.qualityEvaluations.has(payload.evaluation.proposalId)) throw new Error(`Proposal quality evaluation already exists: ${payload.evaluation.proposalId}`);
    return;
  }
  const proposal = view.proposals.get(payload.lifecycle.proposalId);
  if (proposal === undefined) throw new Error(`Proposal lifecycle precedes creation: ${payload.lifecycle.proposalId}`);
  if (proposal.status !== payload.lifecycle.expectedStatus) throw new Error(`Proposal lifecycle expected ${payload.lifecycle.expectedStatus}, found ${proposal.status}: ${payload.lifecycle.proposalId}`);
}

interface AppendRecordInput {
  readonly payload: z.input<typeof eventPayloadSchema>;
  readonly projectRevisionId?: string;
  readonly recordId?: string;
  readonly timestamp?: string;
}

async function readLog(directory: string): Promise<readonly ProjectLogRecord[]> {
  return Object.freeze((await readLogEnvelopes(directory)).map((item) => item.record));
}

async function readLogEnvelopes(directory: string): Promise<readonly z.infer<typeof logEnvelopeSchema>[]> {
  const text = await readSecureFile(path.join(directory, 'project.jsonl'), MAX_LOG_BYTES);
  const lines = text.split('\n');
  if (lines.at(-1) !== '') throw new Error('Writing project log ends with an incomplete record.');
  lines.pop();
  if (lines.length === 0) throw new Error('Writing project log is empty.');
  let previousHash = ZERO_HASH;
  const envelopes = lines.map((line, index) => {
    if (line.length === 0) throw new Error(`Writing project log contains an empty record at line ${String(index + 1)}.`);
    const envelope = adoptSchema(logEnvelopeSchema, JSON.parse(line));
    if (envelope.previousHash !== previousHash) throw new Error(`Writing project log chain is invalid at line ${String(index + 1)}.`);
    const expected = canonicalSha256({ previousHash, record: envelope.record });
    if (envelope.recordHash !== expected) throw new Error(`Writing project log checksum is invalid at line ${String(index + 1)}.`);
    previousHash = envelope.recordHash;
    return envelope;
  });
  return Object.freeze(envelopes);
}

async function readLogEnvelopesIfPresent(directory: string): Promise<readonly z.infer<typeof logEnvelopeSchema>[]> {
  try { return await readLogEnvelopes(directory); }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return Object.freeze([]);
    throw error;
  }
}

function projectView(records: readonly ProjectLogRecord[], identity: WritingProjectIdentity): ProjectView {
  const proposals = new Map<string, { proposal: RevisionProposal; status: ProposalStatus }>();
  const qualityEvaluations = new Map<string, ProposalQualityEvaluation>();
  const operations = new Map<string, WritingOperation>();
  const operationLifecycles = new Map<string, WritingOperationLifecycle>();
  const contexts = new Map<string, ContextReceipt>();
  const settlements = new Map<string, ProjectMutationSettlement>();
  for (const record of records) {
    if (record.projectId !== identity.projectId) throw new Error(`Project log mixes project identities at record ${record.recordId}.`);
    const payload = record.payload;
    if (payload.kind === 'operation.admitted') uniqueSet(operations, payload.operation.operationId, payload.operation, 'operation');
    else if (payload.kind === 'operation.lifecycle') {
      const operation = operations.get(payload.lifecycle.operationId);
      if (operation?.runId !== payload.lifecycle.runId) throw new Error(`Operation lifecycle precedes or contradicts admission: ${payload.lifecycle.operationId}`);
      const previous = operationLifecycles.get(payload.lifecycle.operationId);
      if (previous !== undefined && previous.status !== 'suspended') throw new Error(`Operation lifecycle changes a terminal settlement: ${payload.lifecycle.operationId}`);
      operationLifecycles.set(payload.lifecycle.operationId, payload.lifecycle);
    }
    else if (payload.kind === 'context.recorded') uniqueSet(contexts, payload.receipt.contextReceiptId, payload.receipt, 'context receipt');
    else if (payload.kind === 'proposal.created') uniqueSet(proposals, payload.proposal.proposalId, { proposal: payload.proposal, status: 'proposed' }, 'proposal');
    else if (payload.kind === 'proposal.quality-evaluated') {
      const proposal = proposals.get(payload.evaluation.proposalId);
      if (proposal?.proposal.operationId !== payload.evaluation.operationId) throw new Error(`Proposal quality evaluation precedes or contradicts its proposal: ${payload.evaluation.proposalId}`);
      uniqueSet(qualityEvaluations, payload.evaluation.proposalId, payload.evaluation, 'proposal quality evaluation');
    }
    else if (payload.kind === 'proposal.lifecycle') {
      const proposal = proposals.get(payload.lifecycle.proposalId);
      if (proposal === undefined) throw new Error(`Proposal lifecycle precedes creation: ${payload.lifecycle.proposalId}`);
      if (proposal.status !== payload.lifecycle.expectedStatus) throw new Error(`Proposal lifecycle expected ${payload.lifecycle.expectedStatus}, found ${proposal.status}: ${payload.lifecycle.proposalId}`);
      proposals.set(payload.lifecycle.proposalId, { proposal: proposal.proposal, status: payload.lifecycle.status });
    } else if (payload.kind === 'mutation.settled') uniqueSet(settlements, payload.settlement.mutationId, payload.settlement, 'mutation settlement');
  }
  const current = latestSnapshot(records);
  if (current === undefined) throw new Error(`Writing project ${identity.projectId} has no current revision.`);
  return deepFreeze({ identity, records: Object.freeze([...records]), current, proposals, qualityEvaluations, operations, operationLifecycles, contexts, settlements });
}

function sameOperationSettlement(left: WritingOperationLifecycle, right: WritingOperationLifecycle): boolean {
  return canonicalSha256({
    operationId: left.operationId,
    runId: left.runId,
    status: left.status,
    executionSha256: left.executionSha256,
    proposalId: left.proposalId,
    committedRevisionId: left.committedRevisionId,
    reason: left.reason
  }) === canonicalSha256({
    operationId: right.operationId,
    runId: right.runId,
    status: right.status,
    executionSha256: right.executionSha256,
    proposalId: right.proposalId,
    committedRevisionId: right.committedRevisionId,
    reason: right.reason
  });
}

function latestSnapshot(records: readonly ProjectLogRecord[]): ProjectSnapshot | undefined {
  let current: ProjectSnapshot | undefined;
  const revisionIds = new Set<string>();
  for (const record of records) {
    if (record.payload.kind !== 'revision.committed') continue;
    const revision = record.payload.snapshot.revision;
    if (revisionIds.has(revision.revisionId)) throw new Error(`Duplicate project revision: ${revision.revisionId}`);
    for (const parent of revision.parentRevisionIds) if (!revisionIds.has(parent)) throw new Error(`Project revision ${revision.revisionId} has an unknown parent ${parent}.`);
    assertRevisionIdentity(record.payload.snapshot);
    revisionIds.add(revision.revisionId);
    current = record.payload.snapshot;
  }
  return current;
}

export function createProjectRevision(input: Omit<z.input<typeof projectSnapshotSchema>, 'revision'> & {
  readonly parentRevisionIds: readonly string[];
  readonly briefRevisionId: string;
  readonly operationId: string;
  readonly runId?: string;
  readonly editorialDecisionIds?: readonly string[];
  readonly editorialFindingIds?: readonly string[];
  readonly timestamp?: string;
}): ProjectSnapshot {
  const brief = writingBriefRevisionSchema.parse(input.brief);
  assertBriefIntegrity(brief);
  if (input.briefRevisionId !== brief.briefRevisionId) throw new Error('Project revision brief binding does not match the embedded writing brief.');
  assertManagedResourceStructure(input.resources);
  assertDocumentStructure(input.nodes, input.relations, input.resources.map((resource) => resource.resourceId));
  const documentTreeSha256 = canonicalSha256(input.nodes);
  const relationGraphSha256 = canonicalSha256(input.relations);
  const resourceHashes = Object.fromEntries([...input.resources].sort((left, right) => left.resourceId.localeCompare(right.resourceId)).map((resource) => [resource.resourceId, resource.currentSha256]));
  const sourceClaimEvidenceGraphSha256 = canonicalSha256(sourceClaimEvidenceGraphInput(input.sources, input.claims, input.evidenceRelations));
  const authorshipProvenanceGraphSha256 = canonicalSha256(provenanceGraphInput(input.authorshipProvenance));
  const revisionInput = {
    parentRevisionIds: [...input.parentRevisionIds],
    briefRevisionId: input.briefRevisionId,
    documentTreeSha256,
    relationGraphSha256,
    resourceHashes,
    sourceClaimEvidenceGraphSha256,
    authorshipProvenanceGraphSha256,
    operationId: input.operationId,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    editorialDecisionIds: [...(input.editorialDecisionIds ?? [])],
    editorialFindingIds: [...(input.editorialFindingIds ?? [])],
    timestamp: input.timestamp ?? new Date().toISOString()
  };
  const revisionId = contentId('revision', revisionInput);
  const resources = input.resources.map((resource) => ({ ...resource, currentProjectRevisionId: revisionId }));
  return adoptSchema(projectSnapshotSchema, {
    revision: { revisionId, ...revisionInput },
    brief: input.brief,
    nodes: input.nodes,
    relations: input.relations,
    resources,
    sources: input.sources,
    claims: input.claims,
    evidenceRelations: input.evidenceRelations,
    voiceReferences: input.voiceReferences,
    authorshipProvenance: input.authorshipProvenance,
    editorialFindings: input.editorialFindings,
    editorialDecisions: input.editorialDecisions
  });
}

function assertManagedResourceStructure(resources: readonly z.input<typeof projectSnapshotSchema>['resources'][number][]): void {
  const resourceIds = new Set<string>();
  const relativePaths = new Set<string>();
  const protectedRangeIds = new Set<string>();
  for (const resource of resources) {
    if (resourceIds.has(resource.resourceId)) throw new Error(`Managed resources contain duplicate resource ID: ${resource.resourceId}`);
    if (relativePaths.has(resource.relativePath)) throw new Error(`Managed resources contain duplicate relative path: ${resource.relativePath}`);
    resourceIds.add(resource.resourceId);
    relativePaths.add(resource.relativePath);
    for (const protectedRange of resource.protectedRanges) {
      if (protectedRangeIds.has(protectedRange.rangeId)) throw new Error(`Managed resources contain duplicate protected range ID: ${protectedRange.rangeId}`);
      protectedRangeIds.add(protectedRange.rangeId);
    }
  }
}

function assertDocumentStructure(
  nodes: readonly (z.input<typeof projectSnapshotSchema>['nodes'][number])[],
  relations: readonly (z.input<typeof projectSnapshotSchema>['relations'][number])[],
  resourceIds: readonly string[]
): void {
  const nodeById = new Map<string, z.input<typeof projectSnapshotSchema>['nodes'][number]>();
  for (const node of nodes) {
    if (nodeById.has(node.nodeId)) throw new Error(`Document tree contains duplicate node ID: ${node.nodeId}`);
    nodeById.set(node.nodeId, node);
  }
  const active = nodes.filter((node) => node.status !== 'removed');
  const roots = active.filter((node) => node.parentId === null);
  if (roots.length !== 1) throw new Error(`Document tree requires exactly one active root, found ${String(roots.length)}.`);
  const activeIds = new Set(active.map((node) => node.nodeId));
  const knownResources = new Set(resourceIds);
  const siblingOrders = new Set<string>();
  const attachedResources = new Set<string>();
  for (const node of active) {
    if (node.parentId !== null && !activeIds.has(node.parentId)) throw new Error(`Active document node has no active parent: ${node.nodeId}`);
    const siblingIdentity = `${node.parentId ?? '<root>'}:${String(node.siblingOrder)}`;
    if (siblingOrders.has(siblingIdentity)) throw new Error(`Document siblings reuse order ${String(node.siblingOrder)} under ${node.parentId ?? '<root>'}.`);
    siblingOrders.add(siblingIdentity);
    if (node.resourceId !== undefined) {
      if (!knownResources.has(node.resourceId)) throw new Error(`Document node references an unknown managed resource: ${node.nodeId}`);
      if (attachedResources.has(node.resourceId)) throw new Error(`Managed resource is attached to several active document nodes: ${node.resourceId}`);
      attachedResources.add(node.resourceId);
    }
    const ancestors = new Set<string>([node.nodeId]);
    let parentId = node.parentId;
    while (parentId !== null) {
      if (ancestors.has(parentId)) throw new Error(`Document tree contains a parent cycle at node: ${node.nodeId}`);
      ancestors.add(parentId);
      parentId = nodeById.get(parentId)?.parentId ?? null;
    }
  }
  const relationIds = new Set<string>();
  for (const relation of relations) {
    if (relationIds.has(relation.relationId)) throw new Error(`Relation graph contains duplicate relation ID: ${relation.relationId}`);
    relationIds.add(relation.relationId);
    if (relation.status === 'active' && (!activeIds.has(relation.sourceId) || !activeIds.has(relation.targetId))) {
      throw new Error(`Active relation has an inactive or unknown endpoint: ${relation.relationId}`);
    }
  }
}

function assertRevisionIdentity(snapshot: ProjectSnapshot): void {
  assertBriefIntegrity(snapshot.brief);
  if (snapshot.revision.briefRevisionId !== snapshot.brief.briefRevisionId) throw new Error(`Project revision brief binding is invalid: ${snapshot.revision.revisionId}`);
  assertManagedResourceStructure(snapshot.resources);
  assertDocumentStructure(snapshot.nodes, snapshot.relations, snapshot.resources.map((resource) => resource.resourceId));
  const revision = snapshot.revision;
  const expected = contentId('revision', {
    parentRevisionIds: revision.parentRevisionIds,
    briefRevisionId: revision.briefRevisionId,
    documentTreeSha256: revision.documentTreeSha256,
    relationGraphSha256: revision.relationGraphSha256,
    resourceHashes: revision.resourceHashes,
    sourceClaimEvidenceGraphSha256: revision.sourceClaimEvidenceGraphSha256,
    authorshipProvenanceGraphSha256: revision.authorshipProvenanceGraphSha256,
    operationId: revision.operationId,
    ...(revision.runId === undefined ? {} : { runId: revision.runId }),
    editorialDecisionIds: revision.editorialDecisionIds,
    editorialFindingIds: revision.editorialFindingIds,
    timestamp: revision.timestamp
  });
  if (revision.revisionId !== expected) throw new Error(`Project revision identity is invalid: ${revision.revisionId}`);
  if (canonicalSha256(snapshot.nodes) !== revision.documentTreeSha256 || canonicalSha256(snapshot.relations) !== revision.relationGraphSha256) {
    throw new Error(`Project revision graph hashes are invalid: ${revision.revisionId}`);
  }
  const resourceHashes = Object.fromEntries([...snapshot.resources].sort((left, right) => left.resourceId.localeCompare(right.resourceId)).map((resource) => [resource.resourceId, resource.currentSha256]));
  if (canonicalSha256(resourceHashes) !== canonicalSha256(revision.resourceHashes)) throw new Error(`Project revision resource hashes are invalid: ${revision.revisionId}`);
  if (canonicalSha256(sourceClaimEvidenceGraphInput(snapshot.sources, snapshot.claims, snapshot.evidenceRelations)) !== revision.sourceClaimEvidenceGraphSha256) {
    throw new Error(`Project revision evidence graph hash is invalid: ${revision.revisionId}`);
  }
  if (canonicalSha256(provenanceGraphInput(snapshot.authorshipProvenance)) !== revision.authorshipProvenanceGraphSha256) throw new Error(`Project revision provenance graph hash is invalid: ${revision.revisionId}`);
}

function provenanceGraphInput(records: readonly AuthorshipProvenance[]) {
  return records.map((record) => ({ ...record, projectRevisionId: 'current-revision' }));
}

function sourceClaimEvidenceGraphInput(sources: readonly SourceRecord[], claims: readonly Claim[], evidenceRelations: readonly ClaimEvidenceRelation[]) {
  return { sources, claims: claims.map((claim) => ({ ...claim, projectRevisionId: 'current-revision' })), evidenceRelations };
}

async function writeHead(directory: string, projectId: string, revisionId: string, recordHash: string): Promise<void> {
  const pointer = headPointerSchema.parse({ schemaVersion: 1, projectId, revisionId, recordHash });
  await writePrivateAtomic(path.join(directory, 'head.json'), `${JSON.stringify(pointer)}\n`);
}

function uniqueSet<T>(map: Map<string, T>, id: string, value: T, label: string): void {
  const existing = map.get(id);
  if (existing !== undefined) {
    if (canonicalSha256(existing) !== canonicalSha256(value)) throw new Error(`Duplicate ${label} ID has conflicting content: ${id}`);
    return;
  }
  map.set(id, value);
}

function requiredDecisionProposal(decision: EditorialDecision): string {
  if (decision.proposalId === undefined) throw new Error(`Applied proposal decision has no proposal identity: ${decision.decisionId}`);
  return decision.proposalId;
}

function sameRootIdentity(left: Pick<RootIdentity, 'device' | 'inode' | 'mountId'>, right: Pick<RootIdentity, 'device' | 'inode' | 'mountId'>): boolean {
  return left.device === right.device && left.inode === right.inode && left.mountId === right.mountId;
}

async function exists(target: string): Promise<boolean> {
  try { await lstat(target); return true; }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

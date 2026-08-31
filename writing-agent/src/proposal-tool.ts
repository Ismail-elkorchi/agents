import * as z from 'zod';
import {
  defineTool,
  isRiskAllowed,
  requireToolService,
  ToolInputError,
  type CompiledToolDefinition,
  type ToolExecutionContext
} from '@agent-core/tools';
import {
  documentNodeSchema,
  relationEdgeSchema,
  revisionProposalSchema,
  semanticChangeDeclarationSchema,
  type ContextReceipt,
  type LocalizedTextEdit,
  type RevisionProposal,
  type StructuralChange,
  type WritingIntent,
  type WritingOperation
} from './domain.js';
import { canonicalJson, canonicalSha256, contentId, nowTimestamp } from './canonical.js';
import type { WritingProject } from './project.js';
import { prepareProposalMaterial } from './quality.js';

export const PROPOSE_REVISION_IMPLEMENTATION_ID = 'writing-agent.propose-revision@2';
export const WRITING_OPERATION_SERVICE = 'writingOperation';
const PROJECT_SCOPE = 'writing-projects';

interface ModelTextChange {
  readonly resourceId: string;
  readonly replacements: readonly { readonly anchorId: string; readonly replacementText: string }[];
}

interface ModelIntentOperation {
  readonly intentId: string;
  readonly textChanges?: readonly ModelTextChange[];
  readonly structuralChanges?: readonly StructuralChange[];
}

interface ProposeRevisionInput {
  readonly operations: readonly ModelIntentOperation[];
  readonly semanticChangeDeclaration: z.output<typeof semanticChangeDeclarationSchema>;
  readonly rationale: string;
}

const proposeRevisionOutputSchema = z.strictObject({
  proposalId: z.string(),
  canonicalProposalSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.literal('proposed'),
  affectedNodeIds: z.array(z.string()),
  affectedResourceIds: z.array(z.string()),
  summary: z.string().max(4_000)
});

type ProposeRevisionOutput = z.output<typeof proposeRevisionOutputSchema>;

interface CanonicalProposalInput {
  readonly proposalId: string;
  readonly operationId: string;
  readonly baseProjectRevisionId: string;
  readonly textEdits: readonly LocalizedTextEdit[];
  readonly structuralChanges: readonly StructuralChange[];
  readonly semanticChangeDeclaration: z.output<typeof semanticChangeDeclarationSchema>;
  readonly rationale: string;
}

const operationServices = new WeakSet();

export class WritingOperationService {
  readonly project: WritingProject;
  readonly operation: WritingOperation;
  readonly contextReceipt: ContextReceipt;

  constructor(input: {
    readonly project: WritingProject;
    readonly operation: WritingOperation;
    readonly contextReceipt: ContextReceipt;
  }) {
    this.project = input.project;
    this.operation = input.operation;
    this.contextReceipt = input.contextReceipt;
    assertTargetDescriptors(input.operation, input.contextReceipt);
    operationServices.add(this);
    Object.freeze(this);
  }

  canonicalize(input: ProposeRevisionInput): CanonicalProposalInput {
    const parsed = proposalInputSchema(this.operation, this.contextReceipt).parse(input);
    const textByResource = new Map<string, LocalizedTextEdit['edits'][number][]>();
    const structuralChanges: StructuralChange[] = [];
    for (const intentOperation of parsed.operations) {
      const intent = requireIntent(this.operation, intentOperation.intentId);
      for (const textChange of intentOperation.textChanges ?? []) {
        if (!intent.targetResourceIds.includes(textChange.resourceId)) throw new Error(`Proposal intent expands beyond its resource targets: ${intent.intentId}/${textChange.resourceId}`);
        const descriptor = requireDescriptor(this.contextReceipt, textChange.resourceId);
        const edits = textByResource.get(textChange.resourceId) ?? [];
        for (const replacement of textChange.replacements) {
          const anchor = descriptor.anchors.find((candidate) => candidate.anchorId === replacement.anchorId);
          if (anchor === undefined) throw new Error(`Proposal references an unknown application-owned edit anchor: ${replacement.anchorId}`);
          if (edits.some((edit) => edit.anchorId === anchor.anchorId)) throw new Error(`Proposal repeats an edit anchor: ${anchor.anchorId}`);
          edits.push({ anchorId: anchor.anchorId, range: anchor.range, expectedTextSha256: anchor.textSha256, replacementText: replacement.replacementText });
        }
        textByResource.set(textChange.resourceId, edits);
      }
      for (const change of intentOperation.structuralChanges ?? []) {
        if (change.kind !== structuralKind(intent)) throw new Error(`Proposal structural change does not match intent ${intent.intentId}: ${change.kind}`);
        structuralChanges.push(change);
      }
    }
    const textEdits = [...textByResource]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([resourceId, edits]) => {
        const descriptor = requireDescriptor(this.contextReceipt, resourceId);
        return {
          resourceId,
          baseSha256: descriptor.baseSha256,
          edits: edits.sort((left, right) => comparePositions(left.range.start, right.range.start))
        };
      });
    if (textEdits.length === 0 && structuralChanges.length === 0) throw new Error('A proposal requires at least one intent-bound text replacement or structural change.');
    const canonicalIntent = {
      operationId: this.operation.operationId,
      baseProjectRevisionId: this.operation.baseProjectRevisionId,
      textEdits,
      structuralChanges,
      semanticChangeDeclaration: parsed.semanticChangeDeclaration,
      rationale: parsed.rationale
    };
    return Object.freeze({ ...canonicalIntent, proposalId: contentId('proposal', canonicalIntent) });
  }

  async createProposal(input: CanonicalProposalInput): Promise<RevisionProposal> {
    if (input.operationId !== this.operation.operationId || input.baseProjectRevisionId !== this.operation.baseProjectRevisionId) throw new Error('Proposal input does not match its operation-scoped service.');
    const existing = await this.project.store.proposalReceipt(input.proposalId);
    if (existing !== undefined) {
      if (!sameProposalIntent(existing, input)) throw new Error(`Proposal identity conflicts with a different canonical intent: ${input.proposalId}`);
      return existing;
    }
    const materialPreparation = await prepareProposalMaterial({
      project: this.project,
      operation: this.operation,
      proposalId: input.proposalId,
      textEdits: input.textEdits,
      structuralChanges: input.structuralChanges,
      declaration: input.semanticChangeDeclaration,
      contextReceipt: this.contextReceipt
    });
    const material = {
      proposalId: input.proposalId,
      operationId: this.operation.operationId,
      baseProjectRevisionId: this.operation.baseProjectRevisionId,
      affectedNodeIds: [...new Set(input.structuralChanges.flatMap((change) => change.targetIds))].sort(),
      affectedResourceIds: [...new Set(input.textEdits.map((edit) => edit.resourceId))].sort(),
      textEdits: input.textEdits,
      structuralChanges: input.structuralChanges,
      expectedBaseHashes: Object.fromEntries(input.textEdits.map((edit) => [edit.resourceId, edit.baseSha256])),
      preservationContract: materialPreparation.preservationContract,
      semanticChangeDeclaration: input.semanticChangeDeclaration,
      proposedAuthorshipProvenance: materialPreparation.proposedAuthorshipProvenance,
      contextReceiptId: this.contextReceipt.contextReceiptId,
      status: 'proposed' as const,
      boundedRationale: input.rationale,
      createdAt: nowTimestamp()
    };
    const canonicalProposalSha256 = canonicalSha256(material);
    const proposal = revisionProposalSchema.parse({ ...material, canonicalProposalSha256 });
    await this.project.store.appendProposal(proposal);
    return proposal;
  }
}

export function createProposeRevisionTool(service: WritingOperationService): CompiledToolDefinition<ProposeRevisionInput, CanonicalProposalInput, ProposeRevisionOutput> {
  const proposeRevisionInputSchema = proposalInputSchema(service.operation, service.contextReceipt);
  return defineTool({
    name: 'propose_revision',
    implementationId: PROPOSE_REVISION_IMPLEMENTATION_ID,
    description: 'Create one validated writing proposal from ordered, intent-bound changes without supplying hashes, paths, source text, or mutation authority.',
    promptGuide: 'Use only the listed intent IDs, resource IDs, and application-owned anchor IDs. Supply replacement prose or admitted structural content plus an explicit semantic-change declaration. The application binds hashes, ranges, paths, authority, and provenance.',
    schema: proposeRevisionInputSchema,
    outputSchema: proposeRevisionOutputSchema,
    requirements: { services: [WRITING_OPERATION_SERVICE] },
    effectEnvelope: {
      accesses: [{ mode: 'read', scope: PROJECT_SCOPE }, { mode: 'write', scope: PROJECT_SCOPE }],
      lockScopes: [PROJECT_SCOPE]
    },
    canonicalizeInput(input, context) { return requireOperationService(context).canonicalize(input); },
    snapshotInput(input) { return canonicalJson(input); },
    deriveEffects(input, context) {
      const bound = requireOperationService(context);
      const projectId = bound.project.store.identity.projectId;
      const base = `${PROJECT_SCOPE}/${projectId}`;
      return Object.freeze({
        accesses: Object.freeze([
          { mode: 'read' as const, scope: `${base}/revisions/${input.baseProjectRevisionId}` },
          { mode: 'write' as const, scope: `${base}/proposals/${input.proposalId}` }
        ]),
        lockScopes: Object.freeze([`${base}/proposals/${input.proposalId}`]),
        recovery: Object.freeze({
          kind: 'buffered_mutation' as const,
          authority: bound.project.store.recoveryIdentity,
          reconcilerId: PROPOSE_REVISION_IMPLEMENTATION_ID,
          transactionId: input.proposalId
        })
      });
    },
    async recover(input, effect, context) {
      const bound = requireOperationService(context);
      const capability = effect.intent.recovery;
      if (capability.kind !== 'buffered_mutation' || capability.authority !== bound.project.store.recoveryIdentity
        || capability.reconcilerId !== PROPOSE_REVISION_IMPLEMENTATION_ID || capability.transactionId !== input.proposalId) {
        return { status: 'parameter_mismatch', reason: 'Proposal recovery identity does not match the operation-scoped project store.' };
      }
      const proposal = await bound.project.store.proposalReceipt(input.proposalId);
      if (proposal === undefined) return { status: 'not_found', reason: 'No durable proposal-creation record exists; the started append outcome is unknown.' };
      if (!sameProposalIntent(proposal, input)) return { status: 'parameter_mismatch', reason: 'Durable proposal content conflicts with the recovered canonical intent.' };
      return { status: 'settled', observation: proposalObservation(proposal) };
    },
    isAvailable: (policy) => isRiskAllowed(policy, 'read') && isRiskAllowed(policy, 'write'),
    async invoke(input, context) {
      const proposal = await requireOperationService(context).createProposal(input);
      return proposalObservation(proposal);
    }
  });
}

function proposalInputSchema(operation: WritingOperation, receipt: ContextReceipt): z.ZodType<ProposeRevisionInput> {
  const intentSchemas = operation.intents.map((intent) => intentOperationSchema(intent, receipt));
  const operationSchema = oneOf(intentSchemas);
  return z.strictObject({
    operations: z.array(operationSchema).min(1),
    semanticChangeDeclaration: semanticChangeDeclarationSchema,
    rationale: z.string().max(10_000).default('')
  }).superRefine((value, context) => {
    const ids = value.operations.map((item) => item.intentId);
    if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'Proposal intent operations must be unique.' });
    const expected = operation.intents.map((intent) => intent.intentId);
    const missing = expected.filter((intentId) => !ids.includes(intentId));
    const unknown = ids.filter((intentId) => !expected.includes(intentId));
    if (missing.length > 0 || unknown.length > 0) context.addIssue({ code: 'custom', message: `Proposal must cover the exact admitted intent set; missing: ${missing.join(', ') || '(none)'}; unknown: ${unknown.join(', ') || '(none)'}.` });
    const order = ids.map((intentId) => expected.indexOf(intentId));
    if (order.some((value, index) => index > 0 && value < (order[index - 1] ?? -1))) context.addIssue({ code: 'custom', message: 'Proposal intent operations must preserve admitted dependency order.' });
  });
}

function intentOperationSchema(intent: WritingIntent, receipt: ContextReceipt): z.ZodType<ModelIntentOperation> {
  if (textIntent(intent)) {
    const resources = intent.targetResourceIds.map((resourceId) => {
      const descriptor = requireDescriptor(receipt, resourceId);
      const anchors = intent.targetRangeIds.length === 0
        ? descriptor.anchors
        : descriptor.anchors.filter((anchor) => anchor.targetRangeId !== undefined && intent.targetRangeIds.includes(anchor.targetRangeId));
      if (anchors.length === 0) throw new Error(`Text intent has no application-owned edit anchors inside its exact admitted scope: ${intent.intentId}/${resourceId}`);
      return z.strictObject({
        resourceId: z.literal(resourceId),
        replacements: z.array(z.strictObject({
          anchorId: literalChoice(anchors.map((anchor) => anchor.anchorId)),
          replacementText: z.string()
        })).min(1)
      });
    });
    return z.strictObject({
      intentId: z.literal(intent.intentId),
      textChanges: z.array(oneOf(resources)).min(1)
    });
  }
  const kind = structuralKind(intent);
  if (kind === undefined) throw new Error(`Intent cannot produce a revision proposal: ${intent.intentId}/${intent.kind}`);
  const targetIds = intent.targetNodeIds;
  if (targetIds.length === 0) throw new Error(`Structural intent has no exact node targets: ${intent.intentId}`);
  return z.strictObject({
    intentId: z.literal(intent.intentId),
    structuralChanges: z.array(z.strictObject({
      changeId: z.string().trim().min(1).max(512),
      kind: z.literal(kind),
      targetIds: z.array(literalChoice(targetIds)).min(1),
      value: structuralValueSchema(kind)
    })).min(1)
  }) as z.ZodType<ModelIntentOperation>;
}

function structuralValueSchema(kind: StructuralChange['kind']): z.ZodType {
  if (kind === 'create') return z.strictObject({ node: documentNodeSchema });
  if (kind === 'reorder') return z.strictObject({ orders: z.array(z.strictObject({ nodeId: z.string(), siblingOrder: z.int().nonnegative() })).min(1) });
  if (kind === 'purpose') return z.strictObject({ purpose: z.string().trim().min(1).max(100_000) });
  if (kind === 'relation') return z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('add'), relation: relationEdgeSchema }),
    z.strictObject({ action: z.literal('remove'), relationId: z.string() })
  ]);
  if (kind === 'split' || kind === 'merge') return z.strictObject({ replacementNodes: z.array(documentNodeSchema).min(1) });
  return z.strictObject({});
}

function oneOf<T extends z.ZodType>(schemas: readonly T[]): T {
  const first = schemas.at(0);
  if (first === undefined) throw new Error('A proposal schema requires at least one admitted choice.');
  if (schemas.length === 1) return first;
  return z.union(schemas as [T, T, ...T[]]) as unknown as T;
}

function literalChoice(values: readonly string[]): z.ZodType<string> {
  const first = values.at(0);
  if (first === undefined) throw new Error('An operation-bound schema choice cannot be empty.');
  if (values.length === 1) return z.literal(first);
  return z.enum(values as [string, ...string[]]);
}

function textIntent(intent: WritingIntent): boolean {
  return intent.kind.startsWith('text.') || intent.kind === 'review.editorial';
}

function structuralKind(intent: WritingIntent): StructuralChange['kind'] | undefined {
  return intent.kind.startsWith('structure.') ? intent.kind.slice('structure.'.length) as StructuralChange['kind'] : undefined;
}

function requireIntent(operation: WritingOperation, intentId: string): WritingIntent {
  const intent = operation.intents.find((candidate) => candidate.intentId === intentId);
  if (intent === undefined) throw new Error(`Proposal references an unknown admitted intent: ${intentId}`);
  return intent;
}

function requireDescriptor(receipt: ContextReceipt, resourceId: string): ContextReceipt['targetDescriptors'][number] {
  const descriptor = receipt.targetDescriptors.find((candidate) => candidate.resourceId === resourceId);
  if (descriptor === undefined) throw new Error(`Context receipt lacks an application-owned target descriptor: ${resourceId}`);
  return descriptor;
}

function assertTargetDescriptors(operation: WritingOperation, receipt: ContextReceipt): void {
  if (receipt.operationId !== operation.operationId) throw new Error('Target descriptors do not belong to the operation-scoped context receipt.');
  const descriptorIds = receipt.targetDescriptors.map((descriptor) => descriptor.resourceId);
  if (new Set(descriptorIds).size !== descriptorIds.length) throw new Error('Context receipt repeats an application-owned target descriptor.');
  for (const resourceId of operation.targetResourceIds) requireDescriptor(receipt, resourceId);
}

function comparePositions(left: { readonly line: number; readonly column: number }, right: { readonly line: number; readonly column: number }): number {
  return left.line - right.line || left.column - right.column;
}

function requireOperationService(context: ToolExecutionContext): WritingOperationService {
  return requireToolService(context, WRITING_OPERATION_SERVICE, isOperationService, 'adopted WritingOperationService');
}

function isOperationService(value: unknown): value is WritingOperationService {
  return typeof value === 'object' && value !== null && operationServices.has(value);
}

function proposalObservation(proposal: RevisionProposal) {
  const output: ProposeRevisionOutput = {
    proposalId: proposal.proposalId,
    canonicalProposalSha256: proposal.canonicalProposalSha256,
    status: 'proposed',
    affectedNodeIds: proposal.affectedNodeIds,
    affectedResourceIds: proposal.affectedResourceIds,
    summary: boundedSummary(proposal)
  };
  return Object.freeze({
    kind: 'result' as const,
    ok: true,
    summary: `Created writing revision proposal ${proposal.proposalId}.`,
    scope: Object.freeze({ resources: Object.freeze([`${PROJECT_SCOPE}/${proposal.operationId}/proposals/${proposal.proposalId}`]), coverage: 'complete' as const }),
    output
  });
}

function boundedSummary(proposal: RevisionProposal): string {
  const summary = `${String(proposal.textEdits.length)} resource edit group(s) and ${String(proposal.structuralChanges.length)} structural change(s); deterministic and interpretive quality verification follows in Agent Core.`;
  return summary.slice(0, 4_000);
}

function sameProposalIntent(proposal: RevisionProposal, input: CanonicalProposalInput): boolean {
  return proposal.operationId === input.operationId
    && proposal.baseProjectRevisionId === input.baseProjectRevisionId
    && canonicalSha256({
      textEdits: proposal.textEdits,
      structuralChanges: proposal.structuralChanges,
      semanticChangeDeclaration: proposal.semanticChangeDeclaration,
      rationale: proposal.boundedRationale
    }) === canonicalSha256({
      textEdits: input.textEdits,
      structuralChanges: input.structuralChanges,
      semanticChangeDeclaration: input.semanticChangeDeclaration,
      rationale: input.rationale
    });
}

export function assertProposalToolOnlyPrivateMutation(request: { readonly call: { readonly name: string }; readonly effects: { readonly accesses: readonly { readonly mode: string; readonly scope: string }[] } }): void {
  if (request.call.name !== 'propose_revision') throw new ToolInputError('Suggest mode permits only propose_revision to mutate Writing Agent private state.');
  if (request.effects.accesses.some((access) => access.mode !== 'read' && (access.mode !== 'write' || !access.scope.startsWith(`${PROJECT_SCOPE}/`)))) {
    throw new ToolInputError('Proposal tool effects exceed the private proposal boundary.');
  }
}

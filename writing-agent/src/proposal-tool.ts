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
  localizedTextEditSchema,
  revisionProposalSchema,
  semanticChangeDeclarationSchema,
  structuralChangeSchema,
  type ContextReceipt,
  type RevisionProposal,
  type WritingOperation
} from './domain.js';
import { canonicalJson, canonicalSha256, contentId, nowTimestamp } from './canonical.js';
import type { WritingProject } from './project.js';
import { prepareProposalQuality, type WritingEditorialChecker } from './quality.js';

export const PROPOSE_REVISION_IMPLEMENTATION_ID = 'writing-agent.propose-revision@1';
export const WRITING_OPERATION_SERVICE = 'writingOperation';
const PROJECT_SCOPE = 'writing-projects';

const proposeRevisionInputSchema = z.strictObject({
  textEdits: z.array(localizedTextEditSchema),
  structuralChanges: z.array(structuralChangeSchema),
  semanticChangeDeclaration: semanticChangeDeclarationSchema,
  rationale: z.string().max(10_000).default('')
}).superRefine((value, context) => {
  if (value.textEdits.length === 0 && value.structuralChanges.length === 0) context.addIssue({ code: 'custom', message: 'A proposal requires a text edit or structural change.' });
});

const proposeRevisionOutputSchema = z.strictObject({
  proposalId: z.string(),
  canonicalProposalSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.literal('proposed'),
  affectedNodeIds: z.array(z.string()),
  affectedResourceIds: z.array(z.string()),
  summary: z.string().max(4_000)
});

type ProposeRevisionInput = z.output<typeof proposeRevisionInputSchema>;
type ProposeRevisionOutput = z.output<typeof proposeRevisionOutputSchema>;

interface CanonicalProposalInput extends ProposeRevisionInput {
  readonly proposalId: string;
  readonly operationId: string;
  readonly baseProjectRevisionId: string;
}

const operationServices = new WeakSet();

export class WritingOperationService {
  readonly project: WritingProject;
  readonly operation: WritingOperation;
  readonly contextReceipt: ContextReceipt;
  readonly editorialChecker: WritingEditorialChecker | undefined;

  constructor(input: {
    readonly project: WritingProject;
    readonly operation: WritingOperation;
    readonly contextReceipt: ContextReceipt;
    readonly editorialChecker?: WritingEditorialChecker;
  }) {
    this.project = input.project;
    this.operation = input.operation;
    this.contextReceipt = input.contextReceipt;
    this.editorialChecker = input.editorialChecker;
    operationServices.add(this);
    Object.freeze(this);
  }

  async createProposal(input: CanonicalProposalInput): Promise<RevisionProposal> {
    if (input.operationId !== this.operation.operationId || input.baseProjectRevisionId !== this.operation.baseProjectRevisionId) throw new Error('Proposal input does not match its operation-scoped service.');
    const existing = await this.project.store.proposalReceipt(input.proposalId);
    if (existing !== undefined) {
      if (!sameProposalIntent(existing, input)) throw new Error(`Proposal identity conflicts with a different canonical intent: ${input.proposalId}`);
      return existing;
    }
    const quality = await prepareProposalQuality({
      project: this.project,
      operation: this.operation,
      proposalId: input.proposalId,
      textEdits: input.textEdits,
      structuralChanges: input.structuralChanges,
      declaration: input.semanticChangeDeclaration,
      contextReceipt: this.contextReceipt,
      ...(this.editorialChecker === undefined ? {} : { editorialChecker: this.editorialChecker })
    });
    const material = {
      proposalId: input.proposalId,
      operationId: this.operation.operationId,
      baseProjectRevisionId: this.operation.baseProjectRevisionId,
      affectedNodeIds: [...new Set(input.structuralChanges.flatMap((change) => change.targetIds))].sort(),
      affectedResourceIds: [...new Set(input.textEdits.map((edit) => edit.resourceId))].sort(),
      textEdits: input.textEdits,
      structuralChanges: input.structuralChanges,
      expectedBaseHashes: Object.fromEntries(input.textEdits.map((edit) => [edit.resourceId, edit.expectedSha256])),
      preservationContract: quality.preservationContract,
      semanticChangeDeclaration: input.semanticChangeDeclaration,
      semanticPreservationFindings: quality.semanticPreservationFindings,
      proposedAuthorshipProvenance: quality.proposedAuthorshipProvenance,
      deterministicChecks: quality.deterministicChecks,
      editorialFindings: quality.editorialFindings,
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

export const proposeRevisionTool: CompiledToolDefinition<ProposeRevisionInput, CanonicalProposalInput, ProposeRevisionOutput> = defineTool({
  name: 'propose_revision',
  implementationId: PROPOSE_REVISION_IMPLEMENTATION_ID,
  description: 'Create one validated writing revision proposal inside the current operation scope without mutating project files.',
  promptGuide: 'Supply only localized edits or admitted structural changes, an explicit semantic-change declaration, and a bounded rationale. Project, operation, brief, context, authority, and provenance are application-owned.',
  schema: proposeRevisionInputSchema,
  outputSchema: proposeRevisionOutputSchema,
  requirements: { services: [WRITING_OPERATION_SERVICE] },
  effectEnvelope: {
    accesses: [{ mode: 'read', scope: PROJECT_SCOPE }, { mode: 'write', scope: PROJECT_SCOPE }],
    lockScopes: [PROJECT_SCOPE]
  },
  canonicalizeInput(input, context) {
    const service = requireOperationService(context);
    const canonicalIntent = {
      operationId: service.operation.operationId,
      baseProjectRevisionId: service.operation.baseProjectRevisionId,
      textEdits: input.textEdits,
      structuralChanges: input.structuralChanges,
      semanticChangeDeclaration: input.semanticChangeDeclaration,
      rationale: input.rationale
    };
    return Object.freeze({ ...input, proposalId: contentId('proposal', canonicalIntent), operationId: service.operation.operationId, baseProjectRevisionId: service.operation.baseProjectRevisionId });
  },
  snapshotInput(input) {
    return canonicalJson({
      proposalId: input.proposalId,
      operationId: input.operationId,
      baseProjectRevisionId: input.baseProjectRevisionId,
      textEdits: input.textEdits,
      structuralChanges: input.structuralChanges,
      semanticChangeDeclaration: input.semanticChangeDeclaration,
      rationale: input.rationale
    });
  },
  deriveEffects(input, context) {
    const service = requireOperationService(context);
    const projectId = service.project.store.identity.projectId;
    const base = `${PROJECT_SCOPE}/${projectId}`;
    return Object.freeze({
      accesses: Object.freeze([
        { mode: 'read' as const, scope: `${base}/revisions/${input.baseProjectRevisionId}` },
        { mode: 'write' as const, scope: `${base}/proposals/${input.proposalId}` }
      ]),
      lockScopes: Object.freeze([`${base}/proposals/${input.proposalId}`]),
      recovery: Object.freeze({
        kind: 'buffered_mutation' as const,
        authority: service.project.store.recoveryIdentity,
        reconcilerId: PROPOSE_REVISION_IMPLEMENTATION_ID,
        transactionId: input.proposalId
      })
    });
  },
  async recover(input, effect, context) {
    const service = requireOperationService(context);
    const capability = effect.intent.recovery;
    if (capability.kind !== 'buffered_mutation' || capability.authority !== service.project.store.recoveryIdentity
      || capability.reconcilerId !== PROPOSE_REVISION_IMPLEMENTATION_ID || capability.transactionId !== input.proposalId) {
      return { status: 'parameter_mismatch', reason: 'Proposal recovery identity does not match the operation-scoped project store.' };
    }
    const proposal = await service.project.store.proposalReceipt(input.proposalId);
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
  const summary = `${String(proposal.textEdits.length)} resource edit group(s), ${String(proposal.structuralChanges.length)} structural change(s), ${String(proposal.deterministicChecks.filter((check) => check.verdict !== 'passed').length)} non-passing deterministic check(s), ${String(proposal.semanticPreservationFindings.filter((finding) => finding.verdict !== 'passed' || finding.coverage !== 'complete').length)} unresolved semantic preservation finding(s).`;
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

import {
  sessionBranchBoundary as boundary,
  sessionBranchPageParameters as historyPage,
  sessionBranchSearchParameters as historySearch,
  noteListParameters,
  noteReadParameters
} from '@agents/application';
import { JsonlRpcConnection, rpcMethod } from '@agents/rpc';
import type { Readable, Writable } from 'node:stream';
import * as z from 'zod';
import type { WritingApplication } from '../application/service.js';
import {
  humanCriterionDecisionSchema,
  textRangeSchema,
  writingApplyAuthorizationSchema,
  writingOperationKindSchema
} from '../domain.js';

const empty = z.strictObject({});
const id = z.string().min(1);
const proposal = z.strictObject({ proposalId: id });
const selection = z
  .strictObject({
    projectRevisionId: id,
    resourceId: id,
    resourceSha256: id,
    range: textRangeSchema.optional()
  })
  .transform(({ range, ...selection }) => ({ ...selection, ...(range === undefined ? {} : { range }) }));

export function writingRpcMethods(application: WritingApplication, shutdown: () => void) {
  return {
    'notes.list': rpcMethod(noteListParameters, ({ cursor }) => application.listNotes(cursor)),
    'notes.read': rpcMethod(noteReadParameters, (request) => application.readNote(request)),
    'application.read': rpcMethod(empty, () => application.state()),
    'application.shutdown': rpcMethod(empty, () => {
      shutdown();
    }),
    'project.read': rpcMethod(empty, () => application.readProject()),
    'document.read': rpcMethod(z.strictObject({ resourceId: id }), ({ resourceId }) =>
      application.readDocument(resourceId)
    ),
    'session.read': rpcMethod(empty, () => application.readSession()),
    'source.read': rpcMethod(z.strictObject({ sourceId: id }), ({ sourceId }) =>
      application.readSource(sourceId)
    ),
    'session.list': rpcMethod(empty, () => application.listSessions()),
    'session.select': rpcMethod(z.strictObject({ sessionId: id }), ({ sessionId }) =>
      application.selectSession(sessionId)
    ),
    'history.read': rpcMethod(historyPage, (request) => application.readHistory(request)),
    'history.search': rpcMethod(historySearch, (request) => application.searchHistory(request)),
    'history.entry': rpcMethod(z.strictObject({ boundary, entryId: id }), ({ boundary, entryId }) =>
      application.readHistoryEntry(boundary, entryId)
    ),
    'instruction.submit': rpcMethod(
      z.strictObject({
        kind: writingOperationKindSchema,
        instruction: z.string().min(1),
        selection,
        verification: z.enum(['deterministic', 'semantic']).optional()
      }),
      async (input) => {
        const result = await application.instruct({
          kind: input.kind,
          instruction: input.instruction,
          selection: input.selection,
          ...(input.verification === undefined ? {} : { verification: input.verification })
        });
        if (result.kind === 'rejected') return result;
        const { completion, ...accepted } = result;
        void completion.catch(() => undefined);
        return accepted;
      }
    ),
    'proposal.read': rpcMethod(proposal, ({ proposalId }) => application.readProposal(proposalId)),
    'proposal.compare': rpcMethod(proposal, ({ proposalId }) => application.compareProposal(proposalId)),
    'proposal.reject': rpcMethod(
      proposal.extend({ explanation: z.string().min(1) }),
      ({ proposalId, explanation }) => application.reject(proposalId, explanation)
    ),
    'proposal.accept': rpcMethod(
      proposal.extend({
        explanation: z.string().min(1),
        humanCriterionDecisions: z.array(humanCriterionDecisionSchema)
      }),
      (input) => application.accept(input)
    ),
    'proposal.authorize': rpcMethod(proposal, ({ proposalId }) => application.authorize(proposalId)),
    'proposal.apply': rpcMethod(
      proposal.extend({ authorization: writingApplyAuthorizationSchema }),
      (input) => application.apply(input)
    ),
    'revision.undo': rpcMethod(
      z.strictObject({
        revisionId: id.optional(),
        resourceIds: z.array(id).optional(),
        explanation: z.string().min(1)
      }),
      ({ explanation, revisionId, resourceIds }) =>
        application.undo({
          explanation,
          ...(revisionId === undefined ? {} : { revisionId }),
          ...(resourceIds === undefined ? {} : { resourceIds })
        })
    ),
    'suspension.read': rpcMethod(empty, () => application.inspectSuspension()),
    'run.resume': rpcMethod(z.strictObject({ runId: id }), ({ runId }) => application.resume(runId)),
    'run.abort': rpcMethod(z.strictObject({ runId: id.optional() }), ({ runId }) => application.abort(runId)),
    'decision.resolve': rpcMethod(
      z.strictObject({
        runId: id,
        decisionRequestId: id,
        choice: id,
        fingerprint: id,
        expectedRunRevision: z.number().int().min(0)
      }),
      (input) => application.decide(input)
    ),
    'approval.resolve': rpcMethod(
      z.strictObject({ runId: id, approvalId: id, fingerprint: id, decision: z.enum(['allow', 'deny']) }),
      (input) => application.resolveApproval(input)
    ),
    'operation.continue': rpcMethod(
      z.strictObject({ operationId: id, instruction: z.string().optional() }),
      ({ operationId, instruction }) => application.continueOperation(operationId, instruction)
    )
  };
}

export async function runWritingRpc(
  application: WritingApplication,
  streams: {
    readonly input: Readable;
    readonly output: Writable;
    readonly diagnostic: (message: string) => void;
  }
) {
  const connection = new JsonlRpcConnection({
    ...streams,
    methods: writingRpcMethods(application, () => {
      connection.stop();
    }),
    onClose: () => application.close()
  });
  const unsubscribe = application.subscribe((event) =>
    connection.notify(
      event.type,
      'error' in event ? { ...event, error: { name: event.error.name, message: event.error.message } } : event
    )
  );
  try {
    await application.start();
    await connection.run();
  } finally {
    unsubscribe();
    await application.close();
  }
}

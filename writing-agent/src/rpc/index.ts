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

const empty = z.strictObject({});
const id = z.string().min(1);

export function writingRpcMethods(application: WritingApplication, shutdown: () => void) {
  return {
    'notes.list': rpcMethod(noteListParameters, ({ cursor }) => application.listNotes(cursor)),
    'notes.read': rpcMethod(noteReadParameters, (request) => application.readNote(request)),
    'application.read': rpcMethod(empty, () => application.state()),
    'application.shutdown': rpcMethod(empty, () => {
      shutdown();
    }),
    'document.list': rpcMethod(z.strictObject({ directory: z.string().optional() }), ({ directory }) =>
      application.listDocuments(directory)
    ),
    'document.read': rpcMethod(z.strictObject({ path: id }), ({ path }) => application.readDocument(path)),
    'session.read': rpcMethod(empty, () => application.readSession()),
    'session.new': rpcMethod(empty, () => application.newSession()),
    'mode.select': rpcMethod(z.strictObject({ mode: z.enum(['edit', 'review']) }), ({ mode }) =>
      application.setMode(mode)
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
      z.strictObject({ instruction: z.string().min(1) }),
      async ({ instruction }) => {
        const result = await application.submit(instruction);
        if (result.kind === 'rejected') return result;
        const { completion, ...accepted } = result;
        void completion.catch(() => undefined);
        return accepted;
      }
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
      z.strictObject({
        runId: id,
        approvalId: id,
        fingerprint: id,
        decision: z.enum(['allow', 'deny'])
      }),
      (input) => application.resolveApproval(input)
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
  const unsubscribe = application.subscribe(
    (event) =>
      connection.notify(
        event.type,
        'error' in event
          ? {
              ...event,
              error: { name: event.error.name, message: event.error.message }
            }
          : event
      ),
    (error) => {
      streams.diagnostic(`Application event delivery failed: ${error.message}`);
      connection.stop();
    }
  );
  try {
    await application.start();
    await connection.run();
  } finally {
    unsubscribe();
    await application.close();
  }
}

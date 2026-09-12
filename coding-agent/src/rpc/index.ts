import { ownSessionSubmissionInput } from '@agent-core/runtime';
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
import type { CodingSubmissionResult } from '../application/contracts.js';
import type { CodingApplication } from '../application/service.js';

const empty = z.strictObject({});
const id = z.string().min(1);
const submissionInput = z.unknown().transform((value) => ownSessionSubmissionInput(value));

export function codingRpcMethods(application: CodingApplication, shutdown: () => void) {
  return {
    'notes.list': rpcMethod(noteListParameters, ({ cursor }) => application.listNotes(cursor)),
    'notes.read': rpcMethod(noteReadParameters, (request) => application.readNote(request)),
    'application.read': rpcMethod(empty, () => application.state()),
    'application.shutdown': rpcMethod(empty, () => {
      shutdown();
    }),
    'provider.select': rpcMethod(
      z.strictObject({ provider: z.enum(['ollama', 'openai', 'openai-codex', 'openrouter']) }),
      ({ provider }) => application.selectProvider(provider)
    ),
    'model.select': rpcMethod(z.strictObject({ model: id }), ({ model }) => application.selectModel(model)),
    'workspace.trust': rpcMethod(z.strictObject({ level: z.enum(['restricted', 'trusted']) }), ({ level }) =>
      application.selectWorkspaceTrust(level)
    ),
    'permissions.select': rpcMethod(
      z.strictObject({ mode: z.enum(['review', 'edit', 'develop']) }),
      ({ mode }) => application.selectPermissionMode(mode)
    ),
    'session.read': rpcMethod(empty, () => application.readSession()),
    'session.list': rpcMethod(empty, () => application.listSessions()),
    'session.select': rpcMethod(z.strictObject({ sessionId: id }), ({ sessionId }) =>
      application.selectSession(sessionId)
    ),
    'session.branch': rpcMethod(
      z.strictObject({ entryId: id, label: z.string().optional() }),
      ({ entryId, label }) => application.branchFrom(entryId, label)
    ),
    'history.read': rpcMethod(historyPage, (request) => application.readHistory(request)),
    'history.search': rpcMethod(historySearch, (request) => application.searchHistory(request)),
    'history.entry': rpcMethod(z.strictObject({ boundary, entryId: id }), ({ boundary, entryId }) =>
      application.readHistoryEntry(boundary, entryId)
    ),
    'input.submit': rpcMethod(submissionInput, async (input) => acceptance(await application.submit(input))),
    'input.follow': rpcMethod(submissionInput, async (input) => acceptance(await application.follow(input))),
    'input.steer': rpcMethod(
      z.strictObject({ input: submissionInput, expectedRunId: id }),
      async ({ input, expectedRunId }) => acceptance(await application.steer(input, expectedRunId))
    ),
    'queue.read': rpcMethod(empty, () => application.readPendingSubmissions()),
    'queue.replace': rpcMethod(
      z.strictObject({ submissionId: id, expectedInput: submissionInput, input: submissionInput }),
      ({ submissionId, ...change }) =>
        application.updateQueuedSubmission(submissionId, { kind: 'replace', ...change })
    ),
    'queue.cancel': rpcMethod(
      z.strictObject({ submissionId: id, expectedInput: submissionInput }),
      ({ submissionId, expectedInput }) =>
        application.updateQueuedSubmission(submissionId, { kind: 'cancel', expectedInput })
    ),
    'run.abort': rpcMethod(
      z.strictObject({ runId: id, reason: z.string().optional() }),
      ({ runId, reason }) => application.abort(reason, runId)
    ),
    'run.resume': rpcMethod(empty, () => application.resumeSuspension()),
    'approval.resolve': rpcMethod(
      z.strictObject({ runId: id, approvalId: id, fingerprint: id, decision: z.enum(['allow', 'deny']) }),
      (request) => application.resolveApproval(request)
    ),
    'change.read': rpcMethod(z.strictObject({ runId: id, path: id }), ({ runId, path }) =>
      application.readChange(runId, path)
    ),
    'context.read': rpcMethod(empty, () => application.inspectContext()),
    'workspace.files': rpcMethod(
      z.strictObject({ directory: z.string().optional(), prefix: z.string().optional() }),
      ({ directory, prefix }) => application.listFiles(directory, prefix)
    )
  };
}
function acceptance(result: CodingSubmissionResult) {
  if (result.kind === 'rejected') return result;
  const { completion, ...accepted } = result;
  void completion.catch(() => undefined);
  return accepted;
}

export async function runCodingRpc(
  application: CodingApplication,
  streams: {
    readonly input: Readable;
    readonly output: Writable;
    readonly diagnostic: (message: string) => void;
  }
) {
  const connection = new JsonlRpcConnection({
    ...streams,
    methods: codingRpcMethods(application, () => {
      connection.stop();
    }),
    onClose: () => application.close()
  });
  const unsubscribe = application.subscribe(
    (event) =>
      connection.notify(
        event.type,
        'error' in event ? { ...event, error: { name: event.error.name, message: event.error.message } } : event
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

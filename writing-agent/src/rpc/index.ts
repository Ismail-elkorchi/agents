import { contextSelectionSchema } from '@agent-core/runtime';
import { ModelContinuationRequiredError, parseModelChangeRequest } from '@agent-core/runtime';
import {
  RpcError,
  historyRpcMethods,
  inputRpcMethods,
  noteRpcMethods,
  recoveryRpcMethods,
  rpcMethod,
  sessionRpcMethods
} from '@agent-core/rpc';
import { JsonlRpcConnection } from '@agent-core/rpc/node';
import type { Readable, Writable } from 'node:stream';
import * as z from 'zod';
import type { WritingApplication } from '../application/service.js';
import {
  documentSectionSchema,
  documentPassageSchema,
  documentComparisonSchema
} from '../documents.js';

const empty = z.strictObject({});
const id = z.string().min(1);

export function writingRpcMethods(application: WritingApplication, shutdown: () => void) {
  return {
    ...historyRpcMethods(application),
    ...noteRpcMethods(application),
    ...sessionRpcMethods(application),
    ...inputRpcMethods(application),
    ...recoveryRpcMethods({
      abort: (runId) => application.abort(runId),
      resume: (runId) => application.resume(runId),
      resolveApproval: (request) => application.resolveApproval(request),
      resolveDecision: (request) => application.decide(request)
    }),
    'configuration.read': rpcMethod(empty, () => application.modelSelection()),
    'configuration.set': rpcMethod(
      z.unknown().transform(parseModelChangeRequest),
      async ({ selection, options }) => {
        const provider = application.connectProvider(selection.provider, selection.endpoint);
        try {
          await application.configureModel(selection, provider, options);
        } catch (error) {
          if (error instanceof ModelContinuationRequiredError)
            throw new RpcError(-32010, error.message);
          throw error;
        }
        return application.modelSelection();
      }
    ),
    'context.read': rpcMethod(empty, () => application.inspectContext()),
    'context.renew': rpcMethod(
      z.strictObject({ selection: contextSelectionSchema.optional() }),
      ({ selection }) => application.renewContext(selection)
    ),
    'application.read': rpcMethod(empty, () => application.state()),
    'application.shutdown': rpcMethod(empty, () => {
      shutdown();
    }),
    'document.list': rpcMethod(
      z.strictObject({ directory: z.string().optional() }),
      ({ directory }) => application.listDocuments(directory)
    ),
    'document.read': rpcMethod(z.strictObject({ path: id }), ({ path }) =>
      application.readDocument(path)
    ),
    'document.section': rpcMethod(documentSectionSchema, (input) =>
      application.readDocumentSection(input)
    ),
    'document.passage': rpcMethod(documentPassageSchema, (input) =>
      application.readDocumentPassage(input)
    ),
    'document.compare': rpcMethod(documentComparisonSchema, (input) =>
      application.compareDocumentRevisions(input)
    ),
    'document.passage_context': rpcMethod(documentPassageSchema, (input) =>
      application.readPassageContext(input)
    ),
    'session.new': rpcMethod(empty, () => application.newSession()),
    'mode.select': rpcMethod(z.strictObject({ mode: z.enum(['edit', 'review']) }), ({ mode }) =>
      application.setMode(mode)
    ),
    'suspension.read': rpcMethod(empty, () => application.inspectSuspension())
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

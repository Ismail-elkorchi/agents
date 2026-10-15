import { parseModelSelection } from '@agent-core/model';
import {
  historyRpcMethods,
  contextRpcMethods,
  inputRpcMethods,
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
    ...contextRpcMethods(application),
    ...sessionRpcMethods(application),
    ...inputRpcMethods(application),
    ...recoveryRpcMethods({
      abort: (runId) => application.abort(runId),
      resume: (runId) => application.resume(runId),
      resolveApproval: (request) => application.resolveApproval(request)
    }),
    'configuration.read': rpcMethod(empty, () => application.modelSelection()),
    'configuration.set': rpcMethod(
      z.unknown().transform(parseModelSelection),
      async (selection) => {
        const provider = application.connectProvider(selection.provider, selection.endpoint);
        await application.configureModel(selection, provider);
        return application.modelSelection();
      }
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
  let startup = Promise.resolve();
  const lifecycle = { closing: false };
  const methods = writingRpcMethods(application, () => {
    lifecycle.closing = true;
    connection.stop();
  });
  const connection = new JsonlRpcConnection({
    ...streams,
    methods: Object.fromEntries(Object.entries(methods).map(([name, method]) => [
      name,
      {
        ...method,
        async invoke(params: unknown) {
          // Cancellation remains available while startup restores history.
          if (name !== 'application.shutdown')
            await startup;
          return method.invoke(params);
        }
      }
    ])),
    onClose: () => {
      lifecycle.closing = true;
      return application.close();
    }
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
  const cancel = (signal: NodeJS.Signals) => {
    lifecycle.closing = true;
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    connection.stop();
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  startup = application.start();
  const running = connection.run();
  try {
    await Promise.all([startup, running]);
  } catch (error) {
    if (!(lifecycle.closing && error instanceof Error && error.name === 'AbortError')) throw error;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    connection.stop();
    try {
      await running;
    } finally {
      unsubscribe();
      await application.close();
    }
  }
}

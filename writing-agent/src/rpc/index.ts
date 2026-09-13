import { parseModelSelection } from '@agent-core/model';
import {
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
    'configuration.set': rpcMethod(z.unknown().transform(parseModelSelection), async (selection) => {
      const provider = application.connectProvider(selection.provider, selection.endpoint);
      await application.configureModel(selection, provider);
      return application.modelSelection();
    }),
    'application.read': rpcMethod(empty, () => application.state()),
    'application.shutdown': rpcMethod(empty, () => {
      shutdown();
    }),
    'document.list': rpcMethod(z.strictObject({ directory: z.string().optional() }), ({ directory }) =>
      application.listDocuments(directory)
    ),
    'document.read': rpcMethod(z.strictObject({ path: id }), ({ path }) => application.readDocument(path)),
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

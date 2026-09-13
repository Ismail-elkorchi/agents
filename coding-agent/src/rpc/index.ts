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
import type { CodingApplication } from '../application/service.js';

const empty = z.strictObject({});
const id = z.string().min(1);

export function codingRpcMethods(application: CodingApplication, shutdown: () => void) {
  return {
    ...historyRpcMethods(application),
    ...noteRpcMethods(application),
    ...sessionRpcMethods(application),
    ...inputRpcMethods(application),
    ...recoveryRpcMethods({
      abort: (runId, reason) => application.abort(reason, runId),
      resume: (runId) => application.resumeSuspension(runId),
      resolveApproval: (request) => application.resolveApproval(request)
    }),
    'application.read': rpcMethod(empty, () => application.state()),
    'application.shutdown': rpcMethod(empty, () => {
      shutdown();
    }),
    'configuration.read': rpcMethod(empty, () => application.modelSelection()),
    'configuration.set': rpcMethod(z.unknown().transform(parseModelSelection), async (selection) => {
      const adapter = application.connectProvider(selection.provider, selection.endpoint);
      await application.configureModel(selection, adapter);
      return application.modelSelection();
    }),
    'workspace.trust': rpcMethod(
      z.strictObject({ level: z.enum(['restricted', 'trusted']) }),
      ({ level }) => application.selectWorkspaceTrust(level)
    ),
    'permissions.select': rpcMethod(
      z.strictObject({ mode: z.enum(['review', 'edit', 'develop']) }),
      ({ mode }) => application.selectPermissionMode(mode)
    ),
    'session.branch': rpcMethod(
      z.strictObject({ entryId: id, label: z.string().optional() }),
      ({ entryId, label }) => application.branchFrom(entryId, label)
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
        'error' in event
          ? { ...event, error: { name: event.error.name, message: event.error.message } }
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

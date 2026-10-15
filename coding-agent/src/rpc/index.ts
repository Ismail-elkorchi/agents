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
import type { CodingApplication } from '../application/service.js';

const empty = z.strictObject({});
const id = z.string().min(1);
const processTarget = z
  .strictObject({
    sessionId: id,
    processId: id,
    command: z.string(),
    revision: id,
    diagnostic: z.string().optional(),
    status: z.enum([
      'running',
      'exited',
      'stopped',
      'timed_out',
      'failed',
      'unknown',
      'acknowledged-unknown'
    ]),
    owner: z.strictObject({
      ownerId: id,
      runId: id,
      turnId: id,
      toolBatchId: id,
      callIndex: z.int().nonnegative()
    })
  })
  .transform(({ diagnostic, ...value }) => ({
    ...value,
    ...(diagnostic === undefined ? {} : { diagnostic })
  }));
const processAction = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('inspect'), afterCursor: z.int().nonnegative() }),
  z.strictObject({ kind: z.literal('input'), text: z.string() }),
  z.strictObject({ kind: z.literal('close-input') }),
  z.strictObject({ kind: z.literal('terminate') })
]);

export function codingRpcMethods(application: CodingApplication, shutdown: () => void) {
  return {
    ...historyRpcMethods(application),
    ...contextRpcMethods(application),
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
    'configuration.set': rpcMethod(
      z.unknown().transform(parseModelSelection),
      async (selection) => {
        const adapter = application.connectProvider(selection.provider, selection.endpoint);
        await application.configureModel(selection, adapter);
        return application.modelSelection();
      }
    ),
    'workspace.trust': rpcMethod(z.strictObject({ level: z.literal('trusted') }), ({ level }) =>
      application.selectWorkspaceTrust(level)
    ),
    'permissions.select': rpcMethod(
      z.strictObject({ mode: z.enum(['read_only', 'full_host']) }),
      ({ mode }) => application.selectPermissionMode(mode)
    ),
    'session.branch': rpcMethod(
      z.strictObject({ entryId: id, label: z.string().optional() }),
      ({ entryId, label }) => application.branchFrom(entryId, label)
    ),
    'verification.read': rpcMethod(z.strictObject({ runId: id }), ({ runId }) =>
      application.readVerification(runId)
    ),
    'change.read': rpcMethod(z.strictObject({ runId: id, path: id }), ({ runId, path }) =>
      application.readChange(runId, path)
    ),
    'process.list': rpcMethod(empty, () => application.listProcesses()),
    'process.control': rpcMethod(
      z.strictObject({ target: processTarget, action: processAction }),
      ({ target, action }) => application.controlProcess(target, action)
    ),
    'process.reconcile': rpcMethod(
      z.strictObject({ acknowledge: processTarget.optional() }),
      ({ acknowledge }) => application.reconcileProcesses(acknowledge)
    ),
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
  let startup = Promise.resolve();
  const lifecycle = { closing: false };
  const methods = codingRpcMethods(application, () => {
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
          ? { ...event, error: { name: event.error.name, message: event.error.message } }
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

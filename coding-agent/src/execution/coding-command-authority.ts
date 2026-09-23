import {
  ResourceLeaseCoordinator,
  type CommandExecution,
  type CommandExecutionDescriptor,
  type CommandExecutionOwner,
  type CommandExecutionStatus,
  type WorkspaceFiles
} from '@agent-core/tools';
import {
  Sandsurf,
  type ResourceEnvelope,
  type Sandbox,
  type SandboxInspection,
  type SandsurfCapability
} from 'sandsurf';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import * as z from 'zod';
import { withPersistenceFileLock } from '@agent-core/persistence/node';
import type { PrivateStateDirectory } from '../state/private-state.js';
import {
  SandsurfCommandExecution,
  type SandsurfCommandExecutionOptions
} from './sandsurf-command-execution.js';
import type { SandsurfObservationOptions } from './sandsurf-command-observations.js';
import { SandsurfWorkspaceFiles } from './sandsurf-workspace.js';

export class CodingCommandUnavailableError extends Error {}

export interface CodingProcess {
  readonly command: string;
  readonly revision: string;
  readonly diagnostic?: string;
  readonly processId: string;
  readonly owner: CommandExecutionOwner;
  readonly status: CommandExecutionStatus | 'unknown' | 'acknowledged-unknown';
}

export interface CodingCommandAuthority extends CommandExecution {
  listProcesses(): Promise<readonly CodingProcess[]>;
}

export interface CodingEnvironment {
  readonly host: Sandsurf;
  readonly sandbox: Sandbox;
  readonly files: WorkspaceFiles;
  readonly commandExecution?: CodingCommandAuthority;
  close(): Promise<void>;
}

const bindingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  phase: z.enum(['creating', 'ready']),
  hostId: z.string().min(1),
  sandboxId: z.string().min(1),
  createOperationId: z.string().min(1),
  importOperationId: z.string().min(1),
  sourceWorkspaceId: z.string().min(1)
});
type EnvironmentBinding = z.infer<typeof bindingSchema>;

export interface OpenCodingEnvironmentOptions extends SandsurfObservationOptions {
  readonly repositoryDirectory: string;
  readonly hostWorkspaceRoot: string;
  readonly workspaceId: string;
  readonly state: PrivateStateDirectory;
  readonly commandExecution: boolean;
  readonly writable: boolean;
  readonly resources?: ResourceEnvelope;
}

/**
 * Reconnect one durable Sandsurf environment. Persisted revisions are only
 * preconditions/observations; every request is evaluated by the Sandsurf host.
 */
export async function openCodingEnvironment(
  options: OpenCodingEnvironmentOptions
): Promise<CodingEnvironment> {
  const bindingPath = `sandsurf/environments/${bindingKey(options.workspaceId)}.json`;
  return withPersistenceFileLock(
    path.join(options.state.path, bindingPath),
    30_000,
    30_000,
    async (assertOwned) => {
      const directory = path.resolve(options.repositoryDirectory, 'host');
      const stored = await options.state.read(bindingPath);
      const existing = stored === undefined ? undefined : decodeBinding(stored, options);
      const sandboxId = existing?.sandboxId ?? `coding-${randomUUID()}`;
      let admittingInitialEnvironment = existing === undefined;
      const desiredCapabilities: Partial<Record<SandsurfCapability, boolean>> = {
        'read-files': true,
        'write-files': options.writable,
        spawn: options.commandExecution,
        'release-evidence': options.commandExecution
      };
      let configuringGrants = true;
      const host = await Sandsurf.open({
        directory,
        authorizer: (change) =>
          change.sandboxId === sandboxId &&
          ((admittingInitialEnvironment &&
            (change.kind === 'sandbox-create' || change.kind === 'host-import')) ||
            (configuringGrants &&
              change.kind === 'grant' &&
              typeof change.request.capability === 'string' &&
              (change.request.revoked === true ||
                desiredCapabilities[change.request.capability as SandsurfCapability] === true ||
                (admittingInitialEnvironment && change.request.capability === 'write-files'))))
      });
      try {
        const hostInspection = await host.inspect();
        let sandbox: Sandbox;
        if (existing !== undefined) {
          const binding = existing;
          if (binding.hostId !== hostInspection.hostId)
            throw new CodingCommandUnavailableError(
              'The Coding Agent environment belongs to another Sandsurf host store.'
            );
          // Missing/unknown environments are surfaced; they are never recreated by
          // replaying an old application binding.
          sandbox = await host.sandboxes.connect(binding.sandboxId);
        } else {
          const image = hostInspection.defaultImageDigest;
          if (image === null)
            throw new CodingCommandUnavailableError(
              'This Sandsurf installation has no verified development image for the host architecture.'
            );
          const capabilities: Partial<Record<SandsurfCapability, boolean>> = {
            'read-files': true,
            'write-files': true, // Initialization imports files before exposing read-only access.
            ...(options.commandExecution ? { 'release-evidence': true } : {}),
            ...(options.commandExecution ? { spawn: true } : {})
          };
          const binding: EnvironmentBinding = {
            schemaVersion: 1,
            phase: 'creating',
            hostId: hostInspection.hostId,
            sandboxId,
            createOperationId: `create-${randomUUID()}`,
            importOperationId: `import-${randomUUID()}`,
            sourceWorkspaceId: options.workspaceId
          };
          // Persist identity before any effect. Interrupted initialization must be
          // reconciled explicitly; reopening cannot silently create another guest.
          await assertOwned();
          await options.state.write(bindingPath, JSON.stringify(binding));
          sandbox = await host.sandboxes.create({
            id: binding.sandboxId,
            operationId: binding.createOperationId,
            user: 'agent',
            image,
            resources: options.resources ?? {
              vcpus: 1,
              memoryMiB: 1024,
              diskBytes: 2 * 1024 ** 3,
              outputBytes: 256 * 1024 ** 2,
              processes: 256
            },
            capabilities
          });
          await sandbox.workspace.importFromHost({
            source: path.resolve(options.hostWorkspaceRoot),
            operationId: binding.importOperationId,
            exclusions: ['.agent-core', '.coding-agent']
          });
          await assertOwned();
          await options.state.write(bindingPath, JSON.stringify({ ...binding, phase: 'ready' }));
        }
        admittingInitialEnvironment = false;
        // Product permission selection changes host grants explicitly. Existing
        // clients are fenced by configuration revision rather than cached labels.
        const activeGrants = [];
        let after: string | undefined;
        for (;;) {
          const page = await sandbox.grants.list({ maximum: 256, ...(after ? { after } : {}) });
          activeGrants.push(...page.filter((grant) => !grant.revoked));
          if (page.length < 256) break;
          after = page.at(-1)?.id;
        }
        for (const grant of activeGrants)
          if (desiredCapabilities[grant.capability] !== true) await sandbox.grants.revoke(grant);
        for (const [capability, enabled] of Object.entries(desiredCapabilities))
          if (enabled && !activeGrants.some((grant) => grant.capability === capability))
            await sandbox.grants.grant(capability as SandsurfCapability);
        configuringGrants = false;

        const view = await sandbox.inspect();
        const epoch = currentEpoch(view);
        const files = new SandsurfWorkspaceFiles(
          sandbox,
          epoch,
          view.configurationRevision,
          options.writable
        );
        const resourceLeases = new ResourceLeaseCoordinator();
        const descriptor: CommandExecutionDescriptor = Object.freeze({
          implementationId: 'coding-agent.sandsurf-command-execution@1',
          recoveryIdentity: `sandsurf:${hostInspection.hostId}:${sandbox.id}`,
          capabilities: Object.freeze([
            'persistent-linux-environment',
            'durable-output-cursors',
            'concurrent-process-groups',
            'pty',
            'reconnect',
            'environment-lifetime'
          ]),
          supportsPty: true
        });
        const commandOptions: SandsurfCommandExecutionOptions = {
          sandbox,
          epoch,
          configurationRevision: view.configurationRevision,
          state: options.state,
          resourceLeases,
          descriptor,
          events: options.events,
          artifacts: options.artifacts,
          ...(options.onSettlement ? { onSettlement: options.onSettlement } : {})
        };
        const commandExecution = options.commandExecution
          ? new SandsurfCommandExecution(commandOptions)
          : undefined;
        return Object.freeze({
          host,
          sandbox,
          files,
          ...(commandExecution ? { commandExecution } : {}),
          async close() {
            const errors: unknown[] = [];
            files.close();
            try {
              await commandExecution?.close();
            } catch (error) {
              errors.push(error);
            }
            try {
              await host.close();
            } catch (error) {
              errors.push(error);
            }
            if (errors.length)
              throw new AggregateError(errors, 'Coding environment cleanup failed.');
          }
        });
      } catch (error) {
        try {
          await host.close();
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            'Coding environment initialization and cleanup failed.',
            { cause: cleanup }
          );
        }
        throw error;
      }
    }
  );
}

function currentEpoch(view: SandboxInspection): number {
  if (
    view.machine.kind !== 'current' ||
    typeof view.machine.value !== 'object' ||
    view.machine.value === null ||
    !('epoch' in view.machine.value) ||
    typeof view.machine.value.epoch !== 'number' ||
    !Number.isSafeInteger(view.machine.value.epoch) ||
    view.machine.value.epoch <= 0
  )
    throw new CodingCommandUnavailableError(
      `Sandsurf environment ${view.id} has no current machine observation.`
    );
  return view.machine.value.epoch;
}

function bindingKey(workspaceId: string): string {
  return createHash('sha256').update(workspaceId).digest('hex');
}

function decodeBinding(source: string, options: OpenCodingEnvironmentOptions): EnvironmentBinding {
  const result = bindingSchema.safeParse(JSON.parse(source));
  if (!result.success || result.data.sourceWorkspaceId !== options.workspaceId)
    throw new CodingCommandUnavailableError(
      'The persisted Sandsurf environment binding is invalid or incompatible.'
    );
  if (result.data.phase === 'creating')
    throw new CodingCommandUnavailableError(
      `Sandsurf environment ${result.data.sandboxId} has interrupted initialization. Inspect create operation ${result.data.createOperationId} and import operation ${result.data.importOperationId} before reconnecting; no operation was replayed.`
    );
  return result.data;
}

import { type ResourceLeaseCoordinator, commandReleaseReport, type CommandExecutionResult } from '@agent-core/tools';
import { LocalCommandExecution, DEFAULT_LOCAL_TOOL_CONFIGURATION, type RootedFileAuthority } from '@agent-core/tools-local';
import { commitResourceRelease, type AgentEvent } from '@agent-core/runtime';
import type { ArtifactRepository, EventRepository, PublicArtifactRef } from '@agent-core/persistence';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

/** One process authority and file scheduler for every participant in this workspace host. */
export interface CodingWorkspaceResources {
  readonly commandExecution: LocalCommandExecution;
  readonly resourceLeases: ResourceLeaseCoordinator;
  attachOwner(ownerId: string, listener: (result: CommandExecutionResult) => void,
    recordProducedArtifact?: (artifact: PublicArtifactRef) => Promise<void>): Promise<() => Promise<void>>;
  close(): Promise<void>;
}
interface WorkspaceResourceOptions {
  readonly root: RootedFileAuthority;
  readonly runtimeDirectory: string;
  readonly artifacts: ArtifactRepository;
  readonly events: EventRepository<AgentEvent>;
}
interface OwnerAttachment {
  readonly listeners: Set<(result: CommandExecutionResult) => void>;
  readonly producers: Set<(artifact: PublicArtifactRef) => Promise<void>>;
  closing?: Promise<void> | undefined;
}
interface WorkspaceResourcePool {
  readonly fingerprint: string;
  readonly resources: Promise<CodingWorkspaceResources>;
  references: number;
  closing?: Promise<void> | undefined;
}
// Handle reuse is process-local; LocalCommandExecution's ledger lock owns exclusion across processes.
const workspaces = new Map<string, WorkspaceResourcePool>();

export async function openCodingWorkspaceResources(options: WorkspaceResourceOptions): Promise<CodingWorkspaceResources> {
  const ledgerDirectory = path.join(options.runtimeDirectory, 'host-processes');
  await mkdir(ledgerDirectory, { recursive: true, mode: 0o700 });
  const key = await realpath(ledgerDirectory);
  const fingerprint = JSON.stringify({ root: options.root.identity,
    process: DEFAULT_LOCAL_TOOL_CONFIGURATION.process });
  let entry = workspaces.get(key);
  if (entry?.closing) { await entry.closing; entry = workspaces.get(key); }
  if (entry && entry.fingerprint !== fingerprint) throw new Error('The workspace already has an incompatible command resource policy.');
  if (!entry) {
    entry = { fingerprint, resources: createWorkspaceResources(options, key), references: 0 };
    workspaces.set(key, entry);
  }
  const owned = entry;
  owned.references++;
  let resources: CodingWorkspaceResources;
  try { resources = await owned.resources; }
  catch (error) {
    owned.references--;
    if (workspaces.get(key) === owned) workspaces.delete(key);
    throw error;
  }
  let closed: Promise<void> | undefined;
  let released = false;
  return Object.freeze({
    commandExecution: resources.commandExecution,
    resourceLeases: resources.resourceLeases,
    attachOwner: (ownerId: string, listener: (result: CommandExecutionResult) => void,
      recordProducedArtifact?: (artifact: PublicArtifactRef) => Promise<void>) => resources.attachOwner(ownerId, listener, recordProducedArtifact),
    close() {
      closed ??= (async () => {
        if (!released) { owned.references--; released = true; }
        if (owned.references !== 0) return;
        owned.closing = resources.close().then(() => {
          if (workspaces.get(key) === owned) workspaces.delete(key);
        });
        await owned.closing;
      })().catch((error: unknown) => { closed = undefined; throw error; });
      return closed;
    }
  });
}

async function createWorkspaceResources(options: WorkspaceResourceOptions, ledgerDirectory: string): Promise<CodingWorkspaceResources> {
  const owners = new Map<string, OwnerAttachment>();
  const root = options.root.derive();
  let commandExecution: LocalCommandExecution | undefined;
  try {
    commandExecution = new LocalCommandExecution({
      rootedFileAuthority: root,
      artifactRepository: options.artifacts,
      ledgerDirectory,
      ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process,
      async commitTerminalReport(report) {
        const owner = owners.get(report.result.owner.ownerId);
        if (!owner) throw new Error('The original command resource owner must attach before terminal handoff.');
        if (report.result.artifact) for (const produce of owner.producers) await produce(report.result.artifact);
        await commitResourceRelease({ runId: report.result.owner.runId,
          report: commandReleaseReport(report), events: options.events });
        for (const listener of owners.get(report.result.owner.ownerId)?.listeners ?? []) {
          try { listener(report.result); }
          catch { /* Observer delivery cannot alter durable resource settlement. */ }
        }
      }
    });
    await commandExecution.reconcile();
    const commands = commandExecution;
    let closed: Promise<void> | undefined;
    return Object.freeze({
      commandExecution: commands,
      resourceLeases: commands.resourceLeases,
      async attachOwner(ownerId: string, listener: (result: CommandExecutionResult) => void,
        recordProducedArtifact?: (artifact: PublicArtifactRef) => Promise<void>) {
        let owner = owners.get(ownerId);
        if (owner?.closing) { await owner.closing; owner = owners.get(ownerId); }
        if (!owner) { owner = { listeners: new Set(), producers: new Set() }; owners.set(ownerId, owner); }
        const attachment = owner;
        attachment.listeners.add(listener);
        if (recordProducedArtifact) attachment.producers.add(recordProducedArtifact);
        let closing: Promise<void> | undefined;
        return () => {
          closing ??= (async () => {
            attachment.listeners.delete(listener);
            if (attachment.listeners.size) {
              if (recordProducedArtifact) attachment.producers.delete(recordProducedArtifact);
              return;
            }
            attachment.closing = (async () => {
              const reconciliation = await commands.reconcile(ownerId);
              if (reconciliation.unresolved.some(record => record.owner?.ownerId === ownerId))
                throw new Error('The resource owner still has an unresolved process outcome.');
              for (const report of await commands.disposeOwner(ownerId)) {
                if (report.result.artifact) for (const produce of attachment.producers) await produce(report.result.artifact);
                await commitResourceRelease({ runId: report.result.owner.runId,
                  report: commandReleaseReport(report), events: options.events,
                  acknowledge: resourceId => commands.acknowledgeTerminalReport(resourceId) });
              }
              if (owners.get(ownerId) === attachment) owners.delete(ownerId);
            })();
            await attachment.closing;
          })().catch((error: unknown) => { closing = undefined; throw error; });
          return closing;
        };
      },
      close() {
        closed ??= (async () => {
          await commands.close();
          owners.clear(); root.close();
        })().catch((error: unknown) => { closed = undefined; throw error; });
        return closed;
      }
    });
  } catch (error) {
    try { await commandExecution?.close(); }
    finally { root.close(); }
    throw error;
  }
}

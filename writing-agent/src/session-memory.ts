import {
  HistoryReader,
  createHistoryTools,
  createNotesTools,
  type HistoryReadRequest,
  type HistoryReadResult,
  type HistorySearchRequest,
  type HistorySearchResult,
  type NoteRepository,
  type SessionDescriptor,
  type SessionRepository
} from '@agent-core/runtime';
import type { ArtifactRepository, EventRepository } from '@agent-core/persistence';
import type { AgentEvent } from '@agent-core/runtime';
import type { CompiledToolDefinition } from '@agent-core/tools';
import type { WritingOperation } from './domain.js';
import type { WritingProject } from './project.js';
import {
  recordWritingHistoryDelivery,
  recordWritingHistorySearchDelivery,
  recordWritingNoteDelivery,
  recordWritingNoteIndexDelivery
} from './context-supplements.js';

export interface WritingMemoryOptions {
  readonly history?: boolean;
  readonly notes?: boolean;
}

/** Core factories retain their compiled identity; scoped readers record app deliveries. */
export function createWritingMemoryTools(input: {
  readonly project: WritingProject;
  readonly operation: WritingOperation;
  readonly sessions: SessionRepository;
  readonly session: SessionDescriptor;
  readonly notes: NoteRepository;
  readonly events: EventRepository<AgentEvent>;
  readonly artifacts: ArtifactRepository;
  readonly options: WritingMemoryOptions;
}): readonly CompiledToolDefinition[] {
  const history = new WritingHistoryReader(input);
  const notes: NoteRepository = {
    write: (request) => input.notes.write(request),
    remove: (request) => input.notes.remove(request),
    async list(request) {
      const result = await input.notes.list(request);
      await recordWritingNoteIndexDelivery(input.project, input.operation, result);
      return result;
    },
    async search(request) {
      const result = await input.notes.search(request);
      await recordWritingNoteIndexDelivery(input.project, input.operation, result);
      return result;
    },
    fork: (request) => input.notes.fork(request),
    async read(request) {
      const result = await input.notes.read(request);
      if (result.status === 'available')
        await recordWritingNoteDelivery(input.project, input.operation, result);
      return result;
    }
  };
  return Object.freeze([
    ...(input.options.history ? createHistoryTools({ history }) : []),
    ...(input.options.notes
      ? createNotesTools({
          repository: notes,
          authorId: 'writing-model',
          scope: async () => {
            const cut = await history.capture();
            return { sessionId: cut.sessionId, branchId: cut.branchId };
          }
        })
      : [])
  ]);
}

class WritingHistoryReader extends HistoryReader {
  constructor(
    private readonly delivery: {
      readonly project: WritingProject;
      readonly operation: WritingOperation;
      readonly sessions: SessionRepository;
      readonly session: SessionDescriptor;
      readonly events: EventRepository<AgentEvent>;
      readonly artifacts: ArtifactRepository;
    }
  ) {
    super({
      repository: delivery.sessions,
      session: delivery.session,
      events: delivery.events,
      artifacts: delivery.artifacts
    });
  }
  override async read(request: HistoryReadRequest): Promise<HistoryReadResult> {
    const result = await super.read(request);
    if (result.status === 'available') {
      await recordWritingHistoryDelivery(this.delivery.project, this.delivery.operation, result);
      for (const item of result.neighbors)
        await recordWritingHistorySearchDelivery(this.delivery.project, this.delivery.operation, {
          ...result,
          items: [item]
        });
    }
    return result;
  }
  override async search(request: HistorySearchRequest = {}): Promise<HistorySearchResult> {
    const result = await super.search(request);
    await recordWritingHistorySearchDelivery(this.delivery.project, this.delivery.operation, result);
    return result;
  }
}

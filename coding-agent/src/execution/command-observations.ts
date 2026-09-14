import { isUtf8 } from 'node:buffer';
import { parseJsonObject, type JsonObject } from '@agent-core/json';
import {
  hashJson,
  redactTextPreservingLength,
  validateArtifactRef,
  type ArtifactRepository,
  type EventRepository,
  type ProtectedArtifactRef
} from '@agent-core/persistence';
import type { AgentEvent } from '@agent-core/runtime';
import type {
  CommandExecutionOwner,
  CommandExecutionReport,
  CommandExecutionResult
} from '@agent-core/tools';
import { processOutputSchema } from '@agent-core/tools-local';
import type {
  SandboxExecutionObservation,
  SandboxExecutionRepository
} from '@ismail-elkorchi/sandbox';

type TerminalObservation = Extract<SandboxExecutionObservation, { kind: 'settled' | 'rejected' }>;
interface OutputSegment {
  readonly start: number;
  readonly end: number;
  readonly artifact: ProtectedArtifactRef;
}
interface Capture {
  cursor: number;
  segments: OutputSegment[];
}
export interface CommandObservationsOptions {
  readonly events: EventRepository<AgentEvent>;
  readonly artifacts: ArtifactRepository;
  readonly onSettlement?: (report: CommandExecutionReport) => void;
}
export interface CommandIdentity {
  readonly processId: string;
  readonly requestDigest: string;
  readonly owner: CommandExecutionOwner;
  readonly authority: string;
}

/** Original bytes and terminal observations use the existing integrity-bound stores. */
export class CommandObservations {
  readonly #captures = new Map<string, Capture>();
  constructor(private readonly options: CommandObservationsOptions) {}

  async terminal(identity: CommandIdentity): Promise<CommandExecutionReport | undefined> {
    const record = await this.read(identity, terminalKey(identity.processId));
    if (!record) return undefined;
    const result = processOutputSchema.parse(record.result) as CommandExecutionResult;
    if (
      result.processId !== identity.processId ||
      hashJson(result.owner) !== hashJson(identity.owner) ||
      result.status === 'running'
    )
      throw new Error('Committed command settlement identity is invalid.');
    validateProtectedArtifactRef(record.protectedArtifact);
    return { result, protectedArtifact: record.protectedArtifact };
  }

  async receiptDigest(identity: CommandIdentity): Promise<string | undefined> {
    const record = await this.read(identity, terminalKey(identity.processId));
    return record ? requiredDigest(record.receiptDigest) : undefined;
  }

  async capture(
    identity: CommandIdentity,
    repository: SandboxExecutionRepository,
    observation: SandboxExecutionObservation
  ): Promise<Capture> {
    const capture = await this.loadCapture(identity);
    for (;;) {
      const page = await repository.inspect(identity.processId, {
        afterCursor: capture.cursor,
        maxBytes: 64 * 1024
      });
      if (page.requestDigest !== identity.requestDigest)
        throw new Error('Output source request identity changed.');
      if (page.output.kind !== 'available') {
        if (page.output.kind === 'unavailable')
          throw new OriginalOutputUnavailable(
            `Original command output is unavailable: ${page.output.reason}: ${page.output.diagnostic}`
          );
        throw new Error('Requested original command output was not returned.');
      }
      const output = page.output;
      if (output.cursorEnd === capture.cursor) break;
      const artifact = await this.options.artifacts.storeProtected({
        label: `${identity.processId}-output-${String(capture.cursor)}`,
        mediaType: 'application/json',
        content: Buffer.from(
          JSON.stringify(
            output.chunks.map((chunk) => ({
              start: chunk.cursorStart,
              end: chunk.cursorEnd,
              stream: chunk.stream,
              data: chunk.data.toString('base64')
            }))
          )
        )
      });
      const segment: OutputSegment = { start: capture.cursor, end: output.cursorEnd, artifact };
      await this.options.events.append(
        identity.owner.runId,
        {
          type: 'resource.observed',
          runId: identity.owner.runId,
          resourceId: identity.processId,
          details: parseJsonObject({ identity, segment })
        },
        { idempotencyKey: outputKey(identity.processId, capture.cursor) }
      );
      capture.segments.push(segment);
      capture.cursor = segment.end;
      if (capture.cursor === output.availableCursorEnd) break;
    }
    if (
      (observation.kind === 'settled' || observation.kind === 'rejected') &&
      capture.cursor !== observation.receipt.finalCursor
    )
      throw new OriginalOutputUnavailable(
        'Original command output does not cover the terminal receipt.'
      );
    return capture;
  }

  async settle(
    identity: CommandIdentity,
    repository: SandboxExecutionRepository,
    observation: TerminalObservation,
    result: CommandExecutionResult
  ): Promise<CommandExecutionReport> {
    const previous = await this.terminal(identity);
    if (previous) {
      if ((await this.receiptDigest(identity)) !== observation.receipt.digest)
        throw new Error('Command terminal receipts conflict.');
      return previous;
    }
    const { receipt } = observation;
    const counted = (
      view: CommandExecutionResult['stdout'],
      retained: number,
      omitted: number
    ) => ({
      ...view,
      observedBytes: retained + omitted,
      omittedBytes: Math.max(0, retained + omitted - view.capturedBytes),
      endsAtOutputEnd: view.endsAtOutputEnd && omitted === 0
    });
    result = {
      ...result,
      stdout: counted(result.stdout, receipt.stdoutBytes, receipt.omittedStdoutBytes),
      stderr: counted(result.stderr, receipt.stderrBytes, receipt.omittedStderrBytes),
      combined: counted(
        result.combined,
        receipt.stdoutBytes + receipt.stderrBytes,
        receipt.omittedStdoutBytes + receipt.omittedStderrBytes
      )
    };
    let capture: Capture;
    try {
      capture = await this.capture(identity, repository, observation);
    } catch (error) {
      if (!(error instanceof OriginalOutputUnavailable)) throw error;
      const captured = await this.loadCapture(identity);
      const protectedArtifact = await this.storeReceipt(identity, observation, captured);
      return this.commit(identity, observation, {
        protectedArtifact,
        result: {
          ...result,
          originalOutput: {
            kind: 'unavailable',
            cursorEnd: captured.cursor,
            diagnostic: error.message
          }
        }
      });
    }
    const chunks: Buffer[] = [];
    for (const segment of capture.segments) {
      const bytes = await this.options.artifacts.readVerified(segment.artifact);
      const records: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
      if (!Array.isArray(records)) throw new Error('Original output segment is invalid.');
      let cursor = segment.start;
      for (const value of records) {
        const chunk = parseJsonObject(value);
        if (
          chunk.start !== cursor ||
          typeof chunk.end !== 'number' ||
          typeof chunk.data !== 'string' ||
          (chunk.stream !== 'stdout' && chunk.stream !== 'stderr')
        )
          throw new Error('Original output cursor coverage is invalid.');
        const data = Buffer.from(chunk.data, 'base64');
        if (data.toString('base64') !== chunk.data || data.length !== chunk.end - cursor)
          throw new Error('Original output bytes are invalid.');
        chunks.push(data);
        cursor = chunk.end;
      }
      if (cursor !== segment.end) throw new Error('Original output segment boundary is invalid.');
    }
    // Redacting the byte view preserves offsets into the original stream ranges.
    const publicBytes = Buffer.from(
      redactTextPreservingLength(Buffer.concat(chunks).toString('latin1')).text,
      'latin1'
    );
    const artifact = await this.options.artifacts.store({
      label: `${identity.processId}-output`,
      mediaType: isUtf8(publicBytes) ? 'text/plain; charset=utf-8' : 'application/octet-stream',
      content: publicBytes,
      description:
        'Complete retained command output; sensitive values redacted. Original stream boundaries are protected.'
    });
    const protectedArtifact = await this.storeReceipt(identity, observation, capture);
    let report: CommandExecutionReport = {
      result: {
        ...result,
        artifact,
        originalOutput: {
          kind: 'captured',
          cursorEnd: capture.cursor,
          omittedBytes:
            observation.receipt.omittedStdoutBytes + observation.receipt.omittedStderrBytes
        }
      },
      protectedArtifact
    };
    report = { ...report, result: await this.present(identity, report.result, 0, 4_000) };
    return this.commit(identity, observation, report);
  }

  private storeReceipt(
    identity: CommandIdentity,
    observation: TerminalObservation,
    capture: Capture
  ): Promise<ProtectedArtifactRef> {
    return this.options.artifacts.storeProtected({
      label: `${identity.processId}-receipt`,
      mediaType: 'application/json',
      content: Buffer.from(
        JSON.stringify({
          identity,
          terminal:
            observation.kind === 'settled'
              ? { kind: observation.kind, receipt: observation.receipt, result: observation.result }
              : { kind: observation.kind, receipt: observation.receipt, error: observation.error },
          segments: capture.segments
        })
      )
    });
  }

  private async commit(
    identity: CommandIdentity,
    observation: TerminalObservation,
    report: CommandExecutionReport
  ): Promise<CommandExecutionReport> {
    await this.options.events.append(
      identity.owner.runId,
      {
        type: 'resource.released',
        runId: identity.owner.runId,
        resourceId: identity.processId,
        outcome: 'released',
        details: parseJsonObject({ identity, receiptDigest: observation.receipt.digest, ...report })
      },
      { idempotencyKey: terminalKey(identity.processId) }
    );
    try {
      this.options.onSettlement?.(report);
    } catch {
      // Subscriber delivery cannot change the committed command outcome or its ownership.
      // The application delivery hub reports subscriber failures independently.
    }
    return report;
  }

  async present(
    identity: CommandIdentity,
    result: CommandExecutionResult,
    afterCursor: number,
    tokens: number
  ): Promise<CommandExecutionResult> {
    if (tokens === 0) {
      const empty = (view: CommandExecutionResult['stdout']) => ({
        ...view,
        text: '',
        capturedBytes: 0,
        omittedBytes: view.observedBytes,
        startsAtOutputStart: afterCursor === 0,
        endsAtOutputEnd:
          result.originalOutput?.kind === 'captured' &&
          afterCursor === result.originalOutput.cursorEnd &&
          result.originalOutput.omittedBytes === 0
      });
      return {
        ...result,
        cursorStart: afterCursor,
        cursorEnd: afterCursor,
        stdout: empty(result.stdout),
        stderr: empty(result.stderr),
        combined: empty(result.combined)
      };
    }
    if (!result.artifact) return result;
    const range = await this.options.artifacts.readVerifiedRange(result.artifact, {
      offset: afterCursor,
      length: Math.min(64 * 1024, Math.max(1, tokens * 4))
    });
    const capture = await this.loadCapture(identity);
    const streams = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    for (const segment of capture.segments) {
      if (segment.end <= range.offset || segment.start >= range.end) continue;
      const value: unknown = JSON.parse(
        Buffer.from(await this.options.artifacts.readVerified(segment.artifact)).toString('utf8')
      );
      if (!Array.isArray(value)) throw new Error('Stored command output segment is invalid.');
      for (const item of value) {
        const chunk = parseJsonObject(item);
        if (
          typeof chunk.start !== 'number' ||
          typeof chunk.end !== 'number' ||
          (chunk.stream !== 'stdout' && chunk.stream !== 'stderr')
        )
          throw new Error('Stored command stream range is invalid.');
        const start = Math.max(range.offset, chunk.start),
          end = Math.min(range.end, chunk.end);
        if (end > start)
          streams[chunk.stream].push(
            Buffer.from(range.bytes.subarray(start - range.offset, end - range.offset))
          );
      }
    }
    const view = (data: Uint8Array, observedBytes: number) => ({
      text: Buffer.from(data).toString('utf8'),
      observedBytes,
      capturedBytes: data.length,
      omittedBytes: Math.max(0, observedBytes - data.length),
      startsAtOutputStart: range.offset === 0,
      endsAtOutputEnd:
        range.end === range.fullSize &&
        result.originalOutput?.kind === 'captured' &&
        result.originalOutput.omittedBytes === 0
    });
    return {
      ...result,
      cursorStart: range.offset,
      cursorEnd: range.end,
      stdout: view(Buffer.concat(streams.stdout), result.stdout.observedBytes),
      stderr: view(Buffer.concat(streams.stderr), result.stderr.observedBytes),
      combined: view(range.bytes, result.stdout.observedBytes + result.stderr.observedBytes)
    };
  }

  private async loadCapture(identity: CommandIdentity): Promise<Capture> {
    const cached = this.#captures.get(identity.processId);
    const capture: Capture = cached ?? { cursor: 0, segments: [] };
    for (;;) {
      const details = await this.read(identity, outputKey(identity.processId, capture.cursor));
      if (!details) break;
      const segment = parseJsonObject(details.segment);
      validateProtectedArtifactRef(segment.artifact);
      if (
        segment.start !== capture.cursor ||
        typeof segment.end !== 'number' ||
        !Number.isSafeInteger(segment.end) ||
        segment.end <= capture.cursor
      )
        throw new Error('Stored output coverage is invalid.');
      capture.segments.push({
        start: capture.cursor,
        end: segment.end,
        artifact: segment.artifact
      });
      capture.cursor = segment.end;
    }
    this.#captures.set(identity.processId, capture);
    return capture;
  }

  private async read(identity: CommandIdentity, key: string): Promise<JsonObject | undefined> {
    const reference = await this.options.events.referenceByKey(identity.owner.runId, key);
    if (!reference) return undefined;
    const { event } = await this.options.events.readReference(reference);
    if (
      (event.type !== 'resource.observed' && event.type !== 'resource.released') ||
      event.resourceId !== identity.processId ||
      hashJson(event.details.identity) !== hashJson(identity)
    )
      throw new Error('Command evidence does not match its execution authority.');
    return event.details;
  }
}

function outputKey(processId: string, cursor: number): string {
  return `command:${processId}:output:${String(cursor)}`;
}
function terminalKey(processId: string): string {
  return `command:${processId}:terminal`;
}
function requiredDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value))
    throw new Error('Stored terminal receipt digest is invalid.');
  return value;
}

function validateProtectedArtifactRef(value: unknown): asserts value is ProtectedArtifactRef {
  validateArtifactRef(value);
  if (value.visibility !== 'protected')
    throw new Error('Original command bytes require protected artifact storage.');
}

class OriginalOutputUnavailable extends Error {}

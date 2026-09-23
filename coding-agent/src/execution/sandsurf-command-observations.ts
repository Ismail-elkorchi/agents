import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
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
import type { ReceiptView, SandboxProcess } from 'sandsurf';

interface OutputSegment {
  readonly start: number;
  readonly end: number;
  readonly artifact: ProtectedArtifactRef;
}
interface Capture {
  cursor: number;
  segments: OutputSegment[];
}
export interface SandsurfObservationOptions {
  readonly events: EventRepository<AgentEvent>;
  readonly artifacts: ArtifactRepository;
  readonly onSettlement?: (report: CommandExecutionReport) => void;
}
export interface SandsurfCommandIdentity {
  readonly processId: string;
  readonly requestDigest: string;
  readonly owner: CommandExecutionOwner;
  readonly sandboxId: string;
  readonly epoch: number;
}

/** Application evidence sink; Sandsurf remains the process/output authority. */
export class SandsurfCommandObservations {
  readonly #captures = new Map<string, Capture>();

  constructor(private readonly options: SandsurfObservationOptions) {}

  async terminal(identity: SandsurfCommandIdentity): Promise<CommandExecutionReport | undefined> {
    const record = await this.#read(identity, terminalKey(identity.processId));
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

  async capture(
    identity: SandsurfCommandIdentity,
    process: SandboxProcess,
    finalCursor?: number
  ): Promise<Capture> {
    const capture = await this.#loadCapture(identity);
    for (;;) {
      let page;
      try {
        page = await process.output.read({ after: capture.cursor, maximum: 256 * 1024 });
      } catch (error) {
        throw new OriginalOutputUnavailable(error instanceof Error ? error.message : String(error));
      }
      if (page.after !== capture.cursor)
        throw new Error('Sandsurf output page does not start at the requested cursor.');
      if (page.chunks.length === 0) {
        if (page.available > capture.cursor)
          throw new Error('Sandsurf omitted an available output chunk from a maximum-sized page.');
        break;
      }
      let cursor = capture.cursor;
      const records = page.chunks.map((chunk) => {
        if (chunk.cursor !== cursor) throw new Error('Sandsurf output coverage is not contiguous.');
        const actual = createHash('sha256').update(chunk.bytes).digest('hex');
        if (actual !== chunk.digest) throw new Error('Sandsurf output chunk digest is invalid.');
        const value = {
          start: cursor,
          end: cursor + chunk.bytes.byteLength,
          stream: chunk.stream,
          data: Buffer.from(chunk.bytes).toString('base64')
        };
        cursor = value.end;
        return value;
      });
      const artifact = await this.options.artifacts.storeProtected({
        label: `${identity.processId}-output-${String(capture.cursor)}`,
        mediaType: 'application/json',
        content: Buffer.from(JSON.stringify(records))
      });
      const segment: OutputSegment = { start: capture.cursor, end: cursor, artifact };
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
      capture.cursor = cursor;
      if (capture.cursor >= page.available) break;
    }
    if (finalCursor !== undefined && capture.cursor > finalCursor)
      throw new Error('Captured output exceeds the terminal receipt boundary.');
    if (finalCursor !== undefined && capture.cursor < finalCursor)
      throw new OriginalOutputUnavailable(
        'Original command output does not cover the terminal receipt.'
      );
    return capture;
  }

  async settle(
    identity: SandsurfCommandIdentity,
    process: SandboxProcess,
    receipt: ReceiptView,
    result: CommandExecutionResult
  ): Promise<CommandExecutionReport> {
    const previous = await this.terminal(identity);
    if (previous) {
      const recorded = await this.#read(identity, terminalKey(identity.processId));
      if (recorded?.receiptDigest !== receipt.digest)
        throw new Error('Command has conflicting terminal receipts.');
      await this.#acknowledge(process, receipt);
      return previous;
    }
    const finalCursor = counter(receipt.receipt.output.finalCursor);
    const omittedBytes = counter(receipt.receipt.output.omittedBytes);
    let capture: Capture;
    try {
      capture = await this.capture(identity, process, finalCursor);
    } catch (error) {
      if (!(error instanceof OriginalOutputUnavailable)) throw error;
      const protectedArtifact = await this.options.artifacts.storeProtected({
        label: `${identity.processId}-receipt`,
        mediaType: 'application/json',
        content: Buffer.from(JSON.stringify({ identity, receipt }))
      });
      return this.#commit(identity, receipt, {
        result: {
          ...result,
          originalOutput: { kind: 'unavailable', cursorEnd: 0, diagnostic: error.message }
        },
        protectedArtifact
      });
    }
    const original: Buffer[] = [];
    for (const segment of capture.segments) {
      const stored: unknown = JSON.parse(
        Buffer.from(await this.options.artifacts.readVerified(segment.artifact)).toString('utf8')
      );
      if (!Array.isArray(stored)) throw new Error('Protected command output segment is invalid.');
      let cursor = segment.start;
      for (const supplied of stored) {
        const chunk = parseJsonObject(supplied);
        if (
          chunk.start !== cursor ||
          typeof chunk.end !== 'number' ||
          typeof chunk.data !== 'string' ||
          (chunk.stream !== 'stdout' && chunk.stream !== 'stderr' && chunk.stream !== 'terminal')
        )
          throw new Error('Protected command output coverage is invalid.');
        const bytes = Buffer.from(chunk.data, 'base64');
        if (bytes.toString('base64') !== chunk.data || cursor + bytes.length !== chunk.end)
          throw new Error('Protected command output bytes are invalid.');
        original.push(bytes);
        cursor = chunk.end;
      }
      if (cursor !== segment.end) throw new Error('Protected command output boundary is invalid.');
    }
    const bytes = Buffer.concat(original);
    const publicBytes = Buffer.from(
      redactTextPreservingLength(bytes.toString('latin1')).text,
      'latin1'
    );
    const artifact = await this.options.artifacts.store({
      label: `${identity.processId}-output`,
      mediaType: isUtf8(publicBytes) ? 'text/plain; charset=utf-8' : 'application/octet-stream',
      content: publicBytes,
      description:
        'Complete command output presentation with sensitive values redacted; originals remain retained by Sandsurf and in protected segments.'
    });
    result = {
      ...result,
      artifact,
      originalOutput: {
        kind: 'captured',
        cursorEnd: capture.cursor,
        omittedBytes
      }
    };
    const protectedArtifact = await this.options.artifacts.storeProtected({
      label: `${identity.processId}-receipt`,
      mediaType: 'application/json',
      content: Buffer.from(
        JSON.stringify({
          identity,
          receipt,
          segments: capture.segments,
          originalsRetainedBy: 'sandsurf'
        })
      )
    });
    const report = await this.#commit(identity, receipt, { result, protectedArtifact });
    await this.#acknowledge(process, receipt);
    return report;
  }

  async acknowledge(identity: SandsurfCommandIdentity, process: SandboxProcess): Promise<void> {
    const record = await this.#read(identity, terminalKey(identity.processId));
    if (!record || typeof record.receiptDigest !== 'string') return;
    const result = processOutputSchema.parse(record.result);
    if (result.originalOutput?.kind !== 'captured') return;
    await process.acknowledge(record.receiptDigest, { operationId: `ack-${record.receiptDigest}` });
  }

  async #acknowledge(process: SandboxProcess, receipt: ReceiptView): Promise<void> {
    try {
      await process.acknowledge(receipt.digest, { operationId: `ack-${receipt.digest}` });
    } catch {
      /* A failed acknowledgement leaves Sandsurf evidence retained; reconciliation retries it. */
    }
  }

  async #commit(
    identity: SandsurfCommandIdentity,
    receipt: ReceiptView,
    report: CommandExecutionReport
  ): Promise<CommandExecutionReport> {
    await this.options.events.append(
      identity.owner.runId,
      {
        type: 'resource.released',
        runId: identity.owner.runId,
        resourceId: identity.processId,
        outcome: 'released',
        details: parseJsonObject({ identity, receiptDigest: receipt.digest, ...report })
      },
      { idempotencyKey: terminalKey(identity.processId) }
    );
    try {
      this.options.onSettlement?.(report);
    } catch {
      // Subscriber delivery cannot change committed application evidence.
    }
    return report;
  }

  async present(
    identity: SandsurfCommandIdentity,
    result: CommandExecutionResult,
    after: number,
    tokens: number
  ): Promise<CommandExecutionResult> {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(tokens) || tokens < 0)
      throw new TypeError('Output cursor and budget must be nonnegative safe integers.');
    const finalCursor = result.originalOutput?.cursorEnd ?? result.cursorEnd;
    if (after > finalCursor) throw new RangeError('Output cursor is beyond the retained output.');
    const outputEnd =
      after === finalCursor &&
      result.originalOutput?.kind === 'captured' &&
      result.originalOutput.omittedBytes === 0;
    const empty = (view: CommandExecutionResult['stdout']) => ({
      ...view,
      text: '',
      capturedBytes: 0,
      omittedBytes: view.observedBytes,
      startsAtOutputStart: after === 0,
      endsAtOutputEnd: outputEnd
    });
    if (tokens === 0 || !result.artifact)
      return {
        ...result,
        cursorStart: after,
        cursorEnd: after,
        stdout: empty(result.stdout),
        stderr: empty(result.stderr),
        combined: empty(result.combined),
        ...(result.terminal ? { terminal: empty(result.terminal) } : {})
      };
    const range = await this.options.artifacts.readVerifiedRange(result.artifact, {
      offset: after,
      length: Math.min(256 * 1024, tokens * 4)
    });
    const streams: Record<'stdout' | 'stderr' | 'terminal', Uint8Array[]> = {
      stdout: [],
      stderr: [],
      terminal: []
    };
    for (const segment of (await this.#loadCapture(identity)).segments) {
      if (segment.end <= range.offset || segment.start >= range.end) continue;
      const chunks: unknown = JSON.parse(
        Buffer.from(await this.options.artifacts.readVerified(segment.artifact)).toString('utf8')
      );
      if (!Array.isArray(chunks)) throw new Error('Original stream metadata is invalid.');
      for (const supplied of chunks) {
        const chunk = parseJsonObject(supplied);
        if (
          typeof chunk.start !== 'number' ||
          typeof chunk.end !== 'number' ||
          (chunk.stream !== 'stdout' && chunk.stream !== 'stderr' && chunk.stream !== 'terminal')
        )
          throw new Error('Original stream range is invalid.');
        const start = Math.max(range.offset, chunk.start),
          end = Math.min(range.end, chunk.end);
        if (end > start)
          streams[chunk.stream].push(
            range.bytes.subarray(start - range.offset, end - range.offset)
          );
      }
    }
    const view = (bytes: Uint8Array, original: CommandExecutionResult['stdout']) => ({
      text: Buffer.from(bytes).toString('utf8'),
      observedBytes: original.observedBytes,
      capturedBytes: bytes.length,
      omittedBytes: Math.max(0, original.observedBytes - bytes.length),
      startsAtOutputStart: after === 0,
      endsAtOutputEnd:
        range.end === range.fullSize &&
        result.originalOutput?.kind === 'captured' &&
        result.originalOutput.omittedBytes === 0
    });
    return {
      ...result,
      cursorStart: range.offset,
      cursorEnd: range.end,
      stdout: view(Buffer.concat(streams.stdout), result.stdout),
      stderr: view(Buffer.concat(streams.stderr), result.stderr),
      combined: view(range.bytes, result.combined),
      ...(result.terminal
        ? { terminal: view(Buffer.concat(streams.terminal), result.terminal) }
        : {})
    };
  }

  async #loadCapture(identity: SandsurfCommandIdentity): Promise<Capture> {
    const cached = this.#captures.get(identity.processId);
    const capture: Capture = cached ?? { cursor: 0, segments: [] };
    for (;;) {
      const details = await this.#read(identity, outputKey(identity.processId, capture.cursor));
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

  async #read(identity: SandsurfCommandIdentity, key: string): Promise<JsonObject | undefined> {
    const reference = await this.options.events.referenceByKey(identity.owner.runId, key);
    if (!reference) return undefined;
    const { event } = await this.options.events.readReference(reference);
    if (
      (event.type !== 'resource.observed' && event.type !== 'resource.released') ||
      event.resourceId !== identity.processId ||
      hashJson(event.details.identity) !== hashJson(identity)
    )
      throw new Error('Command evidence does not match its Sandsurf binding.');
    return event.details;
  }
}

function outputKey(processId: string, cursor: number): string {
  return `command:${processId}:output:${String(cursor)}`;
}
function terminalKey(processId: string): string {
  return `command:${processId}:terminal`;
}
function validateProtectedArtifactRef(value: unknown): asserts value is ProtectedArtifactRef {
  validateArtifactRef(value);
  if (value.visibility !== 'protected')
    throw new Error('Original command bytes require protected artifact storage.');
}

class OriginalOutputUnavailable extends Error {}
function counter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Sandsurf receipt counter is invalid.');
  return value;
}

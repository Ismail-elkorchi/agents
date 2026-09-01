import { textSha256 } from './canonical.js';
import type { LocalizedTextEdit, ManagedTextResource } from './domain.js';

type ManagedProtectedRange = ManagedTextResource['protectedRanges'][number];

export interface AppliedLocalizedTextEdit {
  readonly content: string;
  readonly offsets: readonly { readonly anchorId: string; readonly start: number; readonly end: number; readonly adjustedStart: number; readonly replacementEnd: number }[];
}

export function applyLocalizedTextEdits(content: string, request: LocalizedTextEdit): AppliedLocalizedTextEdit {
  const lines = lineIndex(content);
  const replacements: { anchorId: string; start: number; end: number; replacement: string }[] = [];
  let previousEnd = -1;
  for (const edit of request.edits) {
    const start = positionOffset(content, lines, edit.range.start.line, edit.range.start.column);
    const end = positionOffset(content, lines, edit.range.end.line, edit.range.end.column);
    if (end < start) throw new Error(`Text edit range is reversed: ${edit.anchorId}`);
    if (start < previousEnd) throw new Error(`Text edits overlap or are unordered: ${edit.anchorId}`);
    const preimage = content.slice(start, end);
    if (textSha256(preimage) !== edit.expectedTextSha256) throw new Error(`Text edit anchor preimage is stale: ${edit.anchorId}`);
    assertWellFormedUnicode(preimage, edit.anchorId);
    assertWellFormedUnicode(edit.replacementText, edit.anchorId);
    replacements.push({ anchorId: edit.anchorId, start, end, replacement: edit.replacementText });
    previousEnd = end;
  }
  let output = '';
  let cursor = 0;
  let delta = 0;
  const offsets: AppliedLocalizedTextEdit['offsets'][number][] = [];
  for (const replacement of replacements) {
    output += content.slice(cursor, replacement.start);
    output += replacement.replacement;
    const adjustedStart = replacement.start + delta;
    const replacementEnd = adjustedStart + replacement.replacement.length;
    offsets.push({ anchorId: replacement.anchorId, start: replacement.start, end: replacement.end, adjustedStart, replacementEnd });
    delta += replacement.replacement.length - (replacement.end - replacement.start);
    cursor = replacement.end;
  }
  output += content.slice(cursor);
  return Object.freeze({ content: output, offsets: Object.freeze(offsets) });
}

export function rangesOverlap(left: { readonly start: number; readonly end: number }, right: { readonly start: number; readonly end: number }): boolean {
  return left.start < right.end && right.start < left.end;
}

export function rebaseProtectedRanges(content: string, request: LocalizedTextEdit, protectedRanges: readonly ManagedProtectedRange[]): ManagedTextResource['protectedRanges'] {
  const applied = applyLocalizedTextEdits(content, request);
  return protectedRanges.map((protectedRange) => {
    const original = offsetRange(content, protectedRange.range);
    if (textSha256(content.slice(original.start, original.end)) !== protectedRange.sha256) throw new Error(`Protected range hash is stale: ${protectedRange.rangeId}`);
    const overlapping = applied.offsets.filter((edit) => rangesOverlap(original, edit));
    if (overlapping.length > 1) throw new Error(`A protected range may be changed only by one exact-range replacement: ${protectedRange.rangeId}`);
    const replacement = overlapping[0];
    if (replacement !== undefined && (replacement.start !== original.start || replacement.end !== original.end)) {
      throw new Error(`A protected range may be changed only by one exact-range replacement: ${protectedRange.rangeId}`);
    }
    const priorDelta = applied.offsets
      .filter((edit) => edit.end <= original.start)
      .reduce((total, edit) => total + (edit.replacementEnd - edit.adjustedStart) - (edit.end - edit.start), 0);
    const start = replacement?.adjustedStart ?? original.start + priorDelta;
    const end = replacement?.replacementEnd ?? original.end + priorDelta;
    return {
      ...protectedRange,
      range: rangeFromOffsets(applied.content, start, end),
      sha256: textSha256(applied.content.slice(start, end))
    };
  });
}

export function offsetRange(content: string, range: { readonly start: { readonly line: number; readonly column: number }; readonly end: { readonly line: number; readonly column: number } }): { readonly start: number; readonly end: number } {
  const lines = lineIndex(content);
  return Object.freeze({
    start: positionOffset(content, lines, range.start.line, range.start.column),
    end: positionOffset(content, lines, range.end.line, range.end.column)
  });
}

export function rangeFromOffsets(content: string, start: number, end: number) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > content.length) throw new Error('Text offsets are outside the proposed content.');
  return Object.freeze({ start: positionAtOffset(content, start), end: positionAtOffset(content, end) });
}

export function newlineConvention(content: string): 'lf' | 'crlf' | 'mixed' | 'none' {
  const crlf = (content.match(/\r\n/gu) ?? []).length;
  const lf = (content.match(/(?<!\r)\n/gu) ?? []).length;
  const bareCr = (content.match(/\r(?!\n)/gu) ?? []).length;
  const kinds = Number(crlf > 0) + Number(lf > 0) + Number(bareCr > 0);
  if (kinds === 0) return 'none';
  if (kinds > 1 || bareCr > 0) return 'mixed';
  return crlf > 0 ? 'crlf' : 'lf';
}

function lineIndex(content: string): readonly { readonly start: number; readonly contentEnd: number; readonly nextStart: number }[] {
  const lines: { start: number; contentEnd: number; nextStart: number }[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\r' && content[index + 1] === '\n') {
      lines.push({ start, contentEnd: index, nextStart: index + 2 });
      index += 1;
      start = index + 1;
    } else if (content[index] === '\n' || content[index] === '\r') {
      lines.push({ start, contentEnd: index, nextStart: index + 1 });
      start = index + 1;
    }
  }
  lines.push({ start, contentEnd: content.length, nextStart: content.length });
  return Object.freeze(lines);
}

function positionOffset(content: string, lines: readonly { readonly start: number; readonly contentEnd: number; readonly nextStart: number }[], line: number, column: number): number {
  if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1) throw new Error('Text positions use positive one-based lines and Unicode-scalar columns.');
  const selected = lines[line - 1];
  if (selected === undefined) throw new Error(`Text line is out of bounds: ${String(line)}`);
  const lineContent = content.slice(selected.start, selected.contentEnd);
  const scalars = Array.from(lineContent);
  if (column > scalars.length + 1) throw new Error(`Text column is out of bounds: ${String(line)}:${String(column)}`);
  return selected.start + scalars.slice(0, column - 1).join('').length;
}

function positionAtOffset(content: string, offset: number) {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (content[index] === '\r' && content[index + 1] === '\n') {
      line += 1;
      index += 1;
      lineStart = index + 1;
    } else if (content[index] === '\n' || content[index] === '\r') {
      line += 1;
      lineStart = index + 1;
    }
  }
  return Object.freeze({ line, column: Array.from(content.slice(lineStart, offset)).length + 1 });
}

function assertWellFormedUnicode(value: string, rangeId: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) throw new Error(`Text edit contains an unpaired surrogate: ${rangeId}`);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error(`Text edit contains an unpaired surrogate: ${rangeId}`);
  }
}

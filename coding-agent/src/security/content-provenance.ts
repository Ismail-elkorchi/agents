import { createHash } from 'node:crypto';
import type { CodingWorkspaceIdentity } from './workspace-identity.js';
import type { WorkspaceTrustLevel } from './workspace-trust.js';

export type WorkspaceContentKind = 'instruction' | 'source' | 'tool_output' | 'checkpoint' | 'receipt' | 'diagnostic' | 'summary';

export interface WorkspaceContentProvenance {
  readonly kind: WorkspaceContentKind;
  readonly sourceUri: string;
  readonly scope: string;
  readonly workspaceId: string;
  readonly trustLevel: WorkspaceTrustLevel;
  readonly sha256: string;
  readonly sourceBytes: number;
  readonly retainedBytes: number;
  readonly truncated: boolean;
  readonly hazards: readonly ContentHazard[];
}

export type ContentHazard = 'terminal_control' | 'bidirectional_control' | 'invisible_unicode' | 'invalid_unicode';

export interface ProvenancedWorkspaceContent {
  readonly content: string;
  readonly provenance: WorkspaceContentProvenance;
}

const bidi = new Set([0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);
const invisible = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);

export function adoptWorkspaceContent(input: {
  readonly content: string;
  readonly kind: WorkspaceContentKind;
  readonly sourceUri: string;
  readonly scope: string;
  readonly workspace: CodingWorkspaceIdentity;
  readonly trustLevel: WorkspaceTrustLevel;
  readonly maxBytes?: number;
}): ProvenancedWorkspaceContent {
  const sourceBytes = Buffer.byteLength(input.content);
  const maxBytes = input.maxBytes ?? 256 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Workspace content byte limit must be a positive safe integer.');
  const hazards = new Set<ContentHazard>();
  const visible = makeControlsVisible(input.content, hazards);
  const bounded = truncateUtf8(visible, maxBytes);
  return Object.freeze({
    content: bounded.value,
    provenance: Object.freeze({
      kind: input.kind,
      sourceUri: input.sourceUri,
      scope: input.scope,
      workspaceId: input.workspace.id,
      trustLevel: input.trustLevel,
      sha256: createHash('sha256').update(input.content).digest('hex'),
      sourceBytes,
      retainedBytes: Buffer.byteLength(bounded.value),
      truncated: bounded.truncated,
      hazards: Object.freeze([...hazards])
    })
  });
}

function makeControlsVisible(value: string, hazards: Set<ContentHazard>): string {
  let result = '';
  for (let index = 0; index < value.length;) {
    const code = value.codePointAt(index);
    if (code === undefined) break;
    const width = code > 0xffff ? 2 : 1;
    if (width === 1 && code >= 0xd800 && code <= 0xdfff) {
      hazards.add('invalid_unicode');
      result += `\\u{${code.toString(16).toUpperCase()}}`;
    } else if (bidi.has(code)) {
      hazards.add('bidirectional_control');
      result += `\\u{${code.toString(16).toUpperCase()}}`;
    } else if (invisible.has(code)) {
      hazards.add('invisible_unicode');
      result += `\\u{${code.toString(16).toUpperCase()}}`;
    } else if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f || code === 0x1b) {
      hazards.add('terminal_control');
      result += `\\u{${code.toString(16).toUpperCase()}}`;
    } else {
      result += String.fromCodePoint(code);
    }
    index += width;
  }
  return result;
}

function truncateUtf8(value: string, maxBytes: number): { readonly value: string; readonly truncated: boolean } {
  if (Buffer.byteLength(value) <= maxBytes) return { value, truncated: false };
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end)) > maxBytes) end -= 1;
  if (end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return { value: value.slice(0, end), truncated: true };
}

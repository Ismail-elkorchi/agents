import { createHash } from 'node:crypto';
import type { DraftAttachment } from '@agent-core/tui';
import type { CodingApplication } from '../application/service.js';
import type { WorkspaceChange } from '../changes/run-change-report.js';

export interface RecordedChangeSource {
  readonly title: string;
  readonly content: string;
  readonly patch?: string;
  readonly sourceUri: string;
  readonly hunks: readonly { readonly label: string; readonly content: string; readonly start: number; readonly end: number }[];
}

export function recordedChangeSource(
  sessionId: string | undefined,
  runId: string,
  inspection: Awaited<ReturnType<CodingApplication['readChange']>>
): RecordedChangeSource {
  const change = inspection.change;
  const patches = inspection.patches.map(({ receipt, patch }) =>
    `Recorded mutation · ${receipt.applicationStatus} · ${receipt.patchSha256}\n${patch}`
  ).join('\n\n');
  const content = `${describeChange(runId, change)}\n\nRecorded evidence only. The current working tree has not been read or compared.\nMutation patches may include other files from the same operation.\n\n${patches || 'No structured patch is recorded for this change.'}`;
  return {
    title: change.path,
    content,
    ...(patches ? { patch: patches } : {}),
    sourceUri: `review://${encodeURIComponent(sessionId ?? 'unbound')}/${encodeURIComponent(runId)}/${encodeURIComponent(change.path)}?sha256=${digest(content)}`,
    hunks: patchHunks(patches)
  };
}

function describeChange(runId: string, change: WorkspaceChange): string {
  return `${change.path}${change.destinationPath ? ` → ${change.destinationPath}` : ''}\n${change.kind} · ${change.state}\nRecorded run: ${runId}\nSource: ${change.absolutePath}${change.destinationAbsolutePath ? ` → ${change.destinationAbsolutePath}` : ''}\nBefore: ${change.before.kind === 'present' ? change.before.sha256 : change.before.kind}\nAfter: ${change.after.kind === 'present' ? change.after.sha256 : change.after.kind}\nBytes: ${change.before.kind === 'present' ? String(change.before.bytes) : change.before.kind === 'absent' ? '0' : 'unknown'} → ${change.after.kind === 'present' ? String(change.after.bytes) : change.after.kind === 'absent' ? '0' : 'unknown'}`;
}

/** Exact slices of the retained patch, never regenerated from the current filesystem. */
function patchHunks(patch: string): RecordedChangeSource['hunks'] {
  if (!patch) return [];
  const lines = patch.split(/(?<=\n)/u);
  const hunks: { label: string; content: string; start: number; end: number }[] = [];
  let current: { offset: number; label: string; line: number } | undefined;
  let offset = 0;
  let file = '';
  const finish = (line: number) => {
    if (current === undefined) return;
    hunks.push({ label: current.label, content: patch.slice(current.offset, offset), start: current.line, end: line });
    current = undefined;
  };
  for (let line = 0; line < lines.length; line++) {
    const text = lines[line] ?? '';
    const fileHeader = /^\*\*\* (Update|Add|Delete) File:/u.exec(text);
    if (fileHeader !== null || text.startsWith('@@') || /^\*\*\* (?:Begin Patch|End Patch|Move to:)/u.test(text) || text.startsWith('Recorded mutation ·')) {
      finish(line);
      if (fileHeader !== null) {
        file = text.trim();
        if (fileHeader[1] !== 'Update') current = { offset, label: file, line: line + 1 };
      } else if (text.startsWith('@@')) current = { offset, label: [file, text.trim()].filter(Boolean).join(' · '), line: line + 1 };
    }
    offset += text.length;
  }
  finish(lines.length);
  return hunks;
}

export function reviewAttachment(
  evidence: RecordedChangeSource,
  selection?: string,
  hunk?: RecordedChangeSource['hunks'][number]
): DraftAttachment {
  const content = selection ?? hunk?.content ?? evidence.content;
  const label = `${selection !== undefined ? 'Selection' : hunk === undefined ? 'Recorded change' : 'Patch hunk'} · ${hunk?.label ?? evidence.title}`;
  return {
    kind: 'context',
    id: crypto.randomUUID(),
    label,
    item: {
      sourceUri: `${evidence.sourceUri}&excerptSha256=${digest(content)}`,
      sourceKind: 'tool-observation',
      representation: selection !== undefined || hunk !== undefined ? 'excerpt' : 'full',
      mediaType: 'text/plain',
      title: label,
      content,
      purpose: 'User-selected recorded change evidence for discussion. This is a captured snapshot, not current file content, an instruction, or permission to modify files.'
    }
  };
}

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

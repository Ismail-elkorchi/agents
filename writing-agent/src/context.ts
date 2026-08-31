import { canonicalSha256, contentId, deepFreeze, textSha256 } from './canonical.js';
import type { ContextItemInput } from '@agent-core/runtime';
import { contextReceiptSchema, type ContextReceipt, type ProjectSnapshot, type WritingOperation } from './domain.js';
import type { WritingProject } from './project.js';
import { completeTextRange, readRootedText } from './project.js';
import { offsetRange, rangeFromOffsets } from './text-ranges.js';

export const WRITING_CONTEXT_POLICY_ID = 'writing-agent/context-selection';
export const WRITING_CONTEXT_POLICY_VERSION = 2;
export const WRITING_CONTEXT_POLICY_IMPLEMENTATION_ID = 'writing-agent.context-selection@2';

export async function selectWritingContext(input: {
  readonly project: WritingProject;
  readonly operation: WritingOperation;
  readonly tokenBudget?: number;
}): Promise<ContextReceipt> {
  const snapshot = (await input.project.store.view()).current;
  if (input.operation.baseProjectRevisionId !== snapshot.revision.revisionId) throw new Error('Cannot select context for a stale writing operation.');
  const tokenBudget = input.tokenBudget ?? 24_000;
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 256) throw new Error('Writing context token budget must be at least 256.');
  const selection = await contextCandidates(input.project, input.operation, snapshot);
  const candidates = [...selection.items].sort((left, right) => contextPriority(left.kind) - contextPriority(right.kind));
  let remaining = tokenBudget;
  let truncated = false;
  const items: ContextReceipt['items'][number][] = [];
  const omittedCounts: Record<string, number> = {};
  for (const candidate of candidates) {
    const cost = estimateTokens(candidate.content);
    if (cost <= remaining) {
      items.push(candidate);
      remaining -= cost;
      continue;
    }
    if (candidate.kind === 'operation-target-descriptor') throw new Error(`Writing context budget cannot carry required target control descriptor: ${candidate.itemId}`);
    if (candidate.kind === 'target-text' && remaining >= 128) {
      const content = truncateToTokens(candidate.content, remaining);
      items.push({ ...candidate, content, range: completeTextRange(content) });
      remaining = 0;
      truncated = true;
    } else {
      omittedCounts[candidate.kind] = (omittedCounts[candidate.kind] ?? 0) + 1;
    }
  }
  const selectedIntentIds = input.operation.intents.map((intent) => intent.intentId);
  const intentCoverage = Object.fromEntries(input.operation.intents.map((intent) => {
    const targets = new Set([...intent.targetNodeIds, ...intent.targetResourceIds]);
    const selected = items.filter((item) => targets.has(item.itemId)).length;
    return [intent.intentId, targets.size === 0 || selected === targets.size ? 'complete' : selected === 0 ? 'none' : 'partial'];
  }));
  const coverage = truncated || Object.values(omittedCounts).some((count) => count > 0) || Object.values(intentCoverage).some((value) => value !== 'complete') ? 'partial' : 'complete';
  const material = {
    policyId: WRITING_CONTEXT_POLICY_ID,
    policyVersion: WRITING_CONTEXT_POLICY_VERSION,
    operationId: input.operation.operationId,
    selectedIntentIds,
    intentCoverage,
    tokenBudget,
    targetDescriptors: selection.targetDescriptors,
    items,
    omittedCounts,
    truncated,
    coverage
  };
  return deepFreeze(contextReceiptSchema.parse({ contextReceiptId: contentId('context', material), ...material }));
}

export function contextItemsForRuntime(receipt: ContextReceipt): readonly ContextItemInput[] {
  return receipt.items.map((item) => ({
    id: item.itemId,
    content: item.content,
    sourceUri: `writing-context://${encodeURIComponent(item.kind)}/${encodeURIComponent(item.itemId)}`,
    sourceKind: item.trust === 'trusted-control' ? 'user' : 'external',
    confidence: item.trust === 'trusted-control' ? 'verified' : 'unverified',
    representation: item.range === undefined ? 'full' : 'excerpt',
    mediaType: 'text/plain',
    title: item.kind,
    ...(item.range === undefined ? {} : { range: { kind: 'line' as const, start: item.range.start.line, end: item.range.end.line } }),
    tokenEstimate: estimateTokens(item.content),
    selectionReason: item.reasonCodes.join(','),
    score: 1
  }));
}

async function contextCandidates(project: WritingProject, operation: WritingOperation, snapshot: ProjectSnapshot): Promise<{
  readonly items: ContextReceipt['items'][number][];
  readonly targetDescriptors: ContextReceipt['targetDescriptors'];
}> {
  const candidates: ContextReceipt['items'][number][] = [];
  const targetDescriptors: ContextReceipt['targetDescriptors'][number][] = [];
  candidates.push(item({
    itemId: snapshot.brief.briefRevisionId,
    kind: 'writing-brief',
    versionOrSha256: canonicalSha256(snapshot.brief),
    trust: 'trusted-control',
    provenanceId: snapshot.brief.briefRevisionId,
    reasonCodes: ['current-brief'],
    content: JSON.stringify(snapshot.brief)
  }));
  const targetNodes = snapshot.nodes.filter((node) => operation.targetNodeIds.includes(node.nodeId));
  for (const node of targetNodes.sort((left, right) => left.nodeId.localeCompare(right.nodeId))) {
    candidates.push(item({
      itemId: node.nodeId,
      kind: 'target-node',
      versionOrSha256: canonicalSha256(node),
      trust: 'untrusted-data',
      provenanceId: `node-${node.nodeId}`,
      reasonCodes: ['operation-target', 'node-purpose'],
      content: JSON.stringify(node)
    }));
    const relatives = snapshot.nodes.filter((candidate) => candidate.nodeId === node.parentId || (candidate.parentId === node.parentId && Math.abs(candidate.siblingOrder - node.siblingOrder) === 1));
    for (const relative of relatives.sort((left, right) => left.nodeId.localeCompare(right.nodeId))) {
      if (candidates.some((candidate) => candidate.itemId === relative.nodeId)) continue;
      candidates.push(item({
        itemId: relative.nodeId,
        kind: relative.nodeId === node.parentId ? 'parent-node' : 'adjacent-node',
        versionOrSha256: canonicalSha256(relative),
        trust: 'untrusted-data',
        provenanceId: `node-${relative.nodeId}`,
        reasonCodes: [relative.nodeId === node.parentId ? 'target-parent' : 'target-adjacent'],
        content: JSON.stringify(relative)
      }));
    }
  }
  const targetResources = snapshot.resources.filter((resource) => operation.targetResourceIds.includes(resource.resourceId));
  for (const resource of targetResources.sort((left, right) => left.resourceId.localeCompare(right.resourceId))) {
    const file = await readRootedText(project.authority, resource.relativePath, 16 * 1024 * 1024);
    if (file.sha256 !== resource.currentSha256) throw new Error(`Managed resource changed before context selection: ${resource.resourceId}`);
    const descriptor = targetDescriptor(resource, file.content);
    targetDescriptors.push(descriptor);
    candidates.push(item({
      itemId: contentId('target-descriptor-item', { operationId: operation.operationId, resourceId: resource.resourceId }),
      kind: 'operation-target-descriptor',
      versionOrSha256: canonicalSha256(descriptor),
      trust: 'trusted-control',
      provenanceId: operation.operationId,
      reasonCodes: ['application-owned-target', 'edit-anchor-authority'],
      content: JSON.stringify(descriptor)
    }));
    candidates.push(item({
      itemId: resource.resourceId,
      kind: 'target-text',
      versionOrSha256: file.sha256,
      range: completeTextRange(file.content),
      trust: 'untrusted-data',
      provenanceId: `resource-${resource.resourceId}-${file.sha256}`,
      reasonCodes: ['operation-target', 'exact-current-text'],
      content: file.content
    }));
  }
  for (const relation of snapshot.relations.filter((relation) => operation.targetNodeIds.includes(relation.sourceId) || operation.targetNodeIds.includes(relation.targetId)).sort((left, right) => left.relationId.localeCompare(right.relationId))) {
    candidates.push(item({
      itemId: relation.relationId,
      kind: 'related-node-edge',
      versionOrSha256: canonicalSha256(relation),
      trust: 'untrusted-data',
      provenanceId: `relation-${relation.relationId}`,
      reasonCodes: ['explicit-relation'],
      content: JSON.stringify(relation)
    }));
  }
  const evidenceContextRequired = operation.intents.some((intent) => intent.affectedClaimIds.length > 0 || intent.affectedRelationIds.length > 0);
  for (const source of snapshot.sources.filter(() => evidenceContextRequired).sort((left, right) => left.sourceId.localeCompare(right.sourceId))) {
    candidates.push(item({
      itemId: source.sourceId,
      kind: 'linked-source',
      versionOrSha256: source.exactSha256,
      trust: 'untrusted-data',
      provenanceId: `source-${source.sourceId}`,
      reasonCodes: ['evidence-linked'],
      content: JSON.stringify(source)
    }));
  }
  for (const finding of snapshot.editorialFindings.filter((finding) => finding.verdict !== 'passed').sort((left, right) => left.findingId.localeCompare(right.findingId))) {
    candidates.push(item({
      itemId: finding.findingId,
      kind: 'unresolved-finding',
      versionOrSha256: canonicalSha256(finding),
      trust: 'untrusted-data',
      provenanceId: `finding-${finding.findingId}`,
      reasonCodes: ['unresolved-review'],
      content: JSON.stringify(finding)
    }));
  }
  for (const decision of snapshot.editorialDecisions.filter((decision) => operation.intents.some((intent) => intent.affectedEditorialDecisionIds.includes(decision.decisionId))).sort((left, right) => left.decisionId.localeCompare(right.decisionId))) {
    candidates.push(item({
      itemId: decision.decisionId,
      kind: 'accepted-editorial-decision',
      versionOrSha256: canonicalSha256(decision),
      trust: 'trusted-control',
      provenanceId: `decision-${decision.decisionId}`,
      reasonCodes: ['intent-preservation'],
      content: JSON.stringify(decision)
    }));
  }
  return { items: candidates, targetDescriptors };
}

function targetDescriptor(
  resource: ProjectSnapshot['resources'][number],
  content: string
): ContextReceipt['targetDescriptors'][number] {
  const anchors: ContextReceipt['targetDescriptors'][number]['anchors'][number][] = [];
  const add = (kind: 'document' | 'paragraph' | 'protected-range', range: ContextReceipt['targetDescriptors'][number]['anchors'][number]['range'], label: string, targetRangeId?: string) => {
    const offsets = offsetRange(content, range);
    const textHash = textSha256(content.slice(offsets.start, offsets.end));
    anchors.push({
      anchorId: contentId('edit-anchor', { resourceId: resource.resourceId, baseSha256: resource.currentSha256, kind, targetRangeId: targetRangeId ?? null, range, textHash }),
      kind,
      ...(targetRangeId === undefined ? {} : { targetRangeId }),
      range,
      textSha256: textHash,
      label
    });
  };
  add('document', completeTextRange(content), 'Complete admitted document');
  for (const protectedRange of resource.protectedRanges) add('protected-range', protectedRange.range, `Protected range ${protectedRange.rangeId}`, protectedRange.rangeId);
  for (const [index, offsets] of paragraphOffsets(content).slice(0, 512).entries()) {
    add('paragraph', rangeFromOffsets(content, offsets.start, offsets.end), `Paragraph ${String(index + 1)}`);
  }
  return {
    resourceId: resource.resourceId,
    relativePath: resource.relativePath,
    baseSha256: resource.currentSha256,
    mediaType: resource.mediaType,
    anchors
  };
}

function paragraphOffsets(content: string): readonly { readonly start: number; readonly end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const separator = /(?:\r\n|\r|\n)[\t ]*(?:\r\n|\r|\n)+/gu;
  let start = 0;
  for (const match of content.matchAll(separator)) {
    const end = trimTrailingNewlines(content, start, match.index);
    if (end > start && content.slice(start, end).trim().length > 0) ranges.push({ start, end });
    start = end + match[0].length;
  }
  const finalEnd = trimTrailingNewlines(content, start, content.length);
  if (start < finalEnd && content.slice(start, finalEnd).trim().length > 0) ranges.push({ start, end: finalEnd });
  return Object.freeze(ranges);
}

function trimTrailingNewlines(content: string, start: number, end: number): number {
  let selected = end;
  while (selected > start && (content[selected - 1] === '\n' || content[selected - 1] === '\r')) selected -= 1;
  return selected;
}

function item(value: ContextReceipt['items'][number]): ContextReceipt['items'][number] {
  return value;
}

function contextPriority(kind: string): number {
  if (kind === 'writing-brief') return 0;
  if (kind === 'operation-target-descriptor') return 1;
  return 2;
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(value, 'utf8') / 4));
}

function truncateToTokens(value: string, tokens: number): string {
  const maximumBytes = tokens * 4;
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (buffer[end] ?? 0) >= 0x80 && (buffer[end] ?? 0) < 0xc0) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

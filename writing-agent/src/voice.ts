import { createHash } from 'node:crypto';
import { contentId, nowTimestamp, randomId } from './canonical.js';
import { authorshipProvenanceSchema, voiceReferenceSchema, type AuthorshipProvenance, type VoiceReference } from './domain.js';
import type { WritingProject } from './project.js';
import { readRootedText, snapshotParts } from './project.js';
import { createProjectRevision } from './project-store.js';
import { offsetRange } from './text-ranges.js';

export interface VoiceArtifactReader {
  readonly implementationId: string;
  read(artifactId: string): Promise<Uint8Array>;
}

export async function addVoiceReference(project: WritingProject, input: {
  readonly resourceId?: string;
  readonly artifactId?: string;
  readonly artifactReader?: VoiceArtifactReader;
  readonly exactSha256: string;
  readonly range?: VoiceReference['range'];
  readonly expectedText?: string;
  readonly assertedProvenance: string;
  readonly permittedPurpose: string;
  readonly consentOrRightsBasis?: string;
  readonly language: string;
  readonly locale?: string;
  readonly genre: string;
  readonly rhetoricalScope: string;
  readonly preserveNotes?: readonly string[];
  readonly doNotImitateNotes?: readonly string[];
  readonly clock?: () => Date;
}): Promise<VoiceReference> {
  if (Number(input.resourceId !== undefined) + Number(input.artifactId !== undefined) !== 1) throw new Error('Voice reference requires exactly one resource or artifact.');
  const view = await project.store.view();
  let content: string | undefined;
  if (input.resourceId !== undefined) {
    const resource = view.current.resources.find((candidate) => candidate.resourceId === input.resourceId);
    if (resource === undefined) throw new Error(`Voice reference resource is not managed: ${input.resourceId}`);
    const file = await readRootedText(project.authority, resource.relativePath, 64 * 1024 * 1024);
    if (file.sha256 !== resource.currentSha256 || file.sha256 !== input.exactSha256) throw new Error(`Voice reference hash does not match current resource content: ${input.resourceId}`);
    content = file.content;
  } else {
    if (input.artifactId === undefined || input.artifactReader === undefined) throw new Error('Artifact voice references require an explicit artifact reader.');
    const bytes = await input.artifactReader.read(input.artifactId);
    if (createHash('sha256').update(bytes).digest('hex') !== input.exactSha256) throw new Error(`Voice artifact hash mismatch: ${input.artifactId}`);
    if (input.range !== undefined || input.expectedText !== undefined) {
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error('Ranged voice artifacts must be valid UTF-8 text.'); }
    }
  }
  if (input.range !== undefined) {
    if (content === undefined || input.expectedText === undefined) throw new Error('Ranged voice references require exact expected text.');
    const offsets = offsetRange(content, input.range);
    if (content.slice(offsets.start, offsets.end) !== input.expectedText) throw new Error('Voice reference range does not match expected text.');
  } else if (input.expectedText !== undefined) throw new Error('Voice expected text requires an exact range.');
  const clock = input.clock ?? (() => new Date());
  const voiceReference = voiceReferenceSchema.parse({
    voiceReferenceId: randomId('voice-reference'),
    ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
    ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
    exactSha256: input.exactSha256,
    ...(input.range === undefined ? {} : { range: input.range }),
    assertedProvenance: input.assertedProvenance,
    permittedPurpose: input.permittedPurpose,
    ...(input.consentOrRightsBasis === undefined ? {} : { consentOrRightsBasis: input.consentOrRightsBasis }),
    language: input.language,
    ...(input.locale === undefined ? {} : { locale: input.locale }),
    genre: input.genre,
    rhetoricalScope: input.rhetoricalScope,
    preserveNotes: input.preserveNotes ?? [],
    doNotImitateNotes: input.doNotImitateNotes ?? [],
    retentionStatus: 'retained'
  });
  const operationId = randomId('voice-reference-addition');
  const snapshot = createProjectRevision({
    ...snapshotParts(view.current), parentRevisionIds: [view.current.revision.revisionId], briefRevisionId: view.current.brief.briefRevisionId,
    operationId, timestamp: nowTimestamp(clock), voiceReferences: [...view.current.voiceReferences, voiceReference]
  });
  await project.store.appendProjectRevision({
    change: { changeKind: 'voice', operationId, affectedIds: [voiceReference.voiceReferenceId], afterSha256: input.exactSha256, summary: 'Added an exact, purpose-bounded voice reference.' },
    snapshot, expectedRevisionId: view.current.revision.revisionId, cause: 'provenance'
  });
  return voiceReference;
}

export async function setVoiceReferenceRetention(project: WritingProject, input: {
  readonly voiceReferenceId: string;
  readonly status: 'deletion-requested' | 'deleted';
  readonly clock?: () => Date;
}): Promise<VoiceReference> {
  const view = await project.store.view();
  const current = view.current.voiceReferences.find((reference) => reference.voiceReferenceId === input.voiceReferenceId);
  if (current === undefined) throw new Error(`Unknown voice reference: ${input.voiceReferenceId}`);
  if (current.retentionStatus === 'deleted') throw new Error(`Voice reference is already deleted: ${input.voiceReferenceId}`);
  if (current.retentionStatus === input.status) return current;
  const updated = voiceReferenceSchema.parse({ ...current, retentionStatus: input.status });
  const operationId = randomId('voice-reference-retention');
  const snapshot = createProjectRevision({
    ...snapshotParts(view.current), parentRevisionIds: [view.current.revision.revisionId], briefRevisionId: view.current.brief.briefRevisionId,
    operationId, timestamp: nowTimestamp(input.clock),
    voiceReferences: view.current.voiceReferences.map((reference) => reference.voiceReferenceId === updated.voiceReferenceId ? updated : reference)
  });
  await project.store.appendProjectRevision({
    change: { changeKind: 'voice', operationId, affectedIds: [updated.voiceReferenceId], summary: `Voice reference retention status changed to ${input.status}.` },
    snapshot, expectedRevisionId: view.current.revision.revisionId, cause: 'provenance'
  });
  return updated;
}

export async function recordAuthorshipTransformation(project: WritingProject, input: {
  readonly operationId: string;
  readonly classification: AuthorshipProvenance['classification'];
  readonly supersedesProvenanceIds: readonly string[];
  readonly targets: readonly ({ readonly resourceId: string; readonly range: NonNullable<AuthorshipProvenance['range']> } | { readonly nodeId: string; readonly structuralObjectId: string })[];
  readonly proposalId?: string;
  readonly clock?: () => Date;
}): Promise<readonly AuthorshipProvenance[]> {
  if (input.targets.length === 0 || input.supersedesProvenanceIds.length === 0) throw new Error('Authorship transformation requires targets and superseded provenance.');
  const view = await project.store.view();
  const known = new Set(view.current.authorshipProvenance.map((record) => record.provenanceId));
  for (const provenanceId of input.supersedesProvenanceIds) if (!known.has(provenanceId)) throw new Error(`Unknown superseded provenance: ${provenanceId}`);
  const records: AuthorshipProvenance[] = [];
  for (const [index, target] of input.targets.entries()) {
    if ('resourceId' in target) {
      const resource = view.current.resources.find((candidate) => candidate.resourceId === target.resourceId);
      if (resource === undefined) throw new Error(`Unknown authorship target resource: ${target.resourceId}`);
      const file = await readRootedText(project.authority, resource.relativePath, 64 * 1024 * 1024);
      if (file.sha256 !== resource.currentSha256) throw new Error(`Authorship target resource is stale: ${target.resourceId}`);
      offsetRange(file.content, target.range);
    } else if (!view.current.nodes.some((node) => node.nodeId === target.nodeId)) throw new Error(`Unknown authorship target node: ${target.nodeId}`);
    records.push(authorshipProvenanceSchema.parse({
      provenanceId: contentId('provenance', { operationId: input.operationId, index, target, supersedes: input.supersedesProvenanceIds }),
      projectRevisionId: view.current.revision.revisionId, ...target, operationId: input.operationId,
      ...(input.proposalId === undefined ? {} : { proposalId: input.proposalId }),
      classification: input.classification, supersedesProvenanceIds: input.supersedesProvenanceIds, createdAt: nowTimestamp(input.clock)
    }));
  }
  const provisional = createProjectRevision({
    ...snapshotParts(view.current), parentRevisionIds: [view.current.revision.revisionId], briefRevisionId: view.current.brief.briefRevisionId,
    operationId: input.operationId, timestamp: nowTimestamp(input.clock), authorshipProvenance: [...view.current.authorshipProvenance, ...records]
  });
  const committed = records.map((record) => authorshipProvenanceSchema.parse({ ...record, projectRevisionId: provisional.revision.revisionId }));
  const snapshot = createProjectRevision({
    ...snapshotParts(provisional), parentRevisionIds: [view.current.revision.revisionId], briefRevisionId: view.current.brief.briefRevisionId,
    operationId: input.operationId, timestamp: provisional.revision.timestamp, authorshipProvenance: [...view.current.authorshipProvenance, ...committed]
  });
  await project.store.appendProjectRevision({
    change: { changeKind: 'provenance', operationId: input.operationId, affectedIds: committed.map((record) => record.provenanceId), summary: 'Recorded superseding range or structural authorship provenance.' },
    snapshot, expectedRevisionId: view.current.revision.revisionId, cause: 'provenance', provenance: committed
  });
  return Object.freeze(committed);
}

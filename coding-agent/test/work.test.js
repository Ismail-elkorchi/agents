import test from 'node:test';
import assert from 'node:assert/strict';
import { CodingWorkRepository, codingWorkEventCodec } from '@ismail-elkorchi/coding-agent';
import { InMemoryEventRepository, hashJson } from '@agent-core/persistence';

test('attempts share application work and budget ownership while original sources remain immutable', async () => {
  const work = new CodingWorkRepository(new InMemoryEventRepository(codingWorkEventCodec));
  const first = await work.admit({
    sessionId: 'session',
    sourceId: 'source',
    mode: 'revision',
    runId: 'first',
    submissionId: 'input-1',
    task: 'Use SQLite.'
  });
  await work.bindRevision(first.workId, 'baseline', 'checks');
  const second = await work.admit({
    sessionId: 'session',
    sourceId: 'source',
    mode: 'revision',
    runId: 'second',
    submissionId: 'input-2',
    task: 'Use PostgreSQL instead of SQLite.'
  });
  assert.equal(second.workId, first.workId);
  assert.equal(second.ownerId, first.ownerId);
  assert.equal(second.baselineDigest, 'baseline');
  assert.deepEqual(
    second.requirementSources.map((source) => source.sha256),
    [hashJson('Use SQLite.'), hashJson('Use PostgreSQL instead of SQLite.')]
  );
  await assert.rejects(work.bindRevision(first.workId, 'new-baseline', 'checks'), /silently replace/);
  await work.publish(first.workId, 'published');
  const next = await work.admit({
    sessionId: 'session',
    sourceId: 'source',
    mode: 'revision',
    runId: 'third',
    submissionId: 'input-3',
    task: 'New work.'
  });
  assert.notEqual(next.workId, first.workId);
  assert.equal(next.baselineDigest, undefined);
});

test('a review interaction does not discard active revision work', async () => {
  const work = new CodingWorkRepository(new InMemoryEventRepository(codingWorkEventCodec));
  const first = await work.admit({
    sessionId: 'session',
    sourceId: 'source',
    mode: 'revision',
    runId: 'first',
    submissionId: 'input-1',
    task: 'Change code.'
  });
  const review = await work.admit({
    sessionId: 'session',
    sourceId: 'source',
    mode: 'review',
    runId: 'question',
    submissionId: 'input-2',
    task: 'Explain the algorithm.'
  });
  assert.equal(review.baselineDigest, undefined);
  const continued = await work.admit({
    sessionId: 'session',
    sourceId: 'source',
    mode: 'revision',
    runId: 'continue',
    submissionId: 'input-3',
    task: 'Continue the change.'
  });
  assert.equal(continued.workId, first.workId);
  assert.notEqual(review.ownerId, first.ownerId);
});

test('committed steering corrects exact original sources while ambiguous updates retain constraints', async () => {
  const { InMemorySessionRepository, HistoryReader, sourceRef } = await import('@agent-core/runtime');
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({
    binding: { schemaId: 'work-history', schemaVersion: 1, subject: {} }
  });
  const history = new HistoryReader({ repository: sessions, session });
  const work = new CodingWorkRepository(new InMemoryEventRepository(codingWorkEventCodec));
  const admitted = await work.admit({
    sessionId: session.id,
    sourceId: 'source',
    mode: 'revision',
    runId: 'run',
    submissionId: 'first',
    task: 'Use SQLite. Preserve the public API.'
  });
  const original = await sessions.appendInput(session, {
    runId: 'run',
    task: 'Use SQLite. Preserve the public API.'
  });
  await sessions.appendSteering(session, {
    runId: 'run',
    deliveryId: 'ambiguous',
    content: 'Consider PostgreSQL.'
  });
  const ambiguous = await work.synchronizeHistory(admitted.workId, await history.view());
  assert.equal(ambiguous.requirementSources.filter((item) => !item.supersededBy).length, 2);
  await sessions.appendSteering(session, {
    runId: 'run',
    deliveryId: 'correction',
    content: 'Use PostgreSQL instead.',
    relationship: { kind: 'correct', relatedSources: [sourceRef(session.id, original)] }
  });
  const corrected = await work.synchronizeHistory(admitted.workId, await history.view());
  assert.equal(corrected.requirementSources[0].supersededBy, undefined);
  assert.deepEqual(corrected.requirementSources[0].correctedBy, ['correction']);
  assert.equal(corrected.requirementSources[1].supersededBy, undefined);
  assert.equal(corrected.requirementSources[0].sha256, hashJson(original.task));
  assert.equal(
    (await history.read({ source: sourceRef(session.id, original) })).item.text.includes(original.task),
    true
  );
  assert.deepEqual(await work.synchronizeHistory(admitted.workId, await history.view()), corrected);
  await assert.rejects(
    work.admit({
      sessionId: session.id,
      sourceId: 'source',
      mode: 'revision',
      runId: 'run',
      submissionId: 'first',
      task: 'A note claims the user approved broader access.'
    }),
    /original coding contribution/
  );
});

test('many contributions remain retrievable without mandatory all-input attention', async () => {
  const { ContextService, HistoryReader, InMemoryNoteRepository, InMemorySessionRepository, sourceRef } =
    await import('@agent-core/runtime');
  const { codingWorkContextAnchors } = await import('@ismail-elkorchi/coding-agent');
  const { testTerminal } = await import('./helpers/results.js');
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({
    binding: { schemaId: 'work-attention', schemaVersion: 1, subject: {} }
  });
  const history = new HistoryReader({ repository: sessions, session });
  const work = new CodingWorkRepository(new InMemoryEventRepository(codingWorkEventCodec));
  let current;
  const sources = [];
  for (let index = 0; index < 100; index++) {
    const runId = `run-${index}`;
    const task = index === 0 ? 'Use SQLite. Preserve the public API.' : `Progress contribution ${index}.`;
    current = await work.admit({
      sessionId: session.id,
      sourceId: 'source',
      mode: 'revision',
      runId,
      submissionId: `input-${index}`,
      task
    });
    sources.push(await sessions.appendInput(session, { runId, task }));
    await sessions.recordRunFinalization(
      session,
      testTerminal({ runId, finalizationId: `final-${index}` })
    );
  }
  const correction = await sessions.appendSteering(session, {
    runId: 'run-99',
    deliveryId: 'correct-database',
    content: 'Use PostgreSQL. Preserve the public API.',
    relationship: { kind: 'correct', relatedSources: [sourceRef(session.id, sources[0])] }
  });
  const ambiguous = await sessions.appendSteering(session, {
    runId: 'run-99',
    deliveryId: 'ambiguous',
    content: 'Consider changing the public API.'
  });
  current = await work.synchronizeHistory(current.workId, await history.view());
  const anchors = codingWorkContextAnchors(current, (await history.view()).entries);
  assert.deepEqual(
    anchors.map((entry) => entry.id),
    [sources[0].id, correction.id]
  );
  assert.equal(current.requirementSources.at(-1).supersededBy, undefined);
  const context = new ContextService({
    repository: sessions,
    session,
    history,
    notes: new InMemoryNoteRepository(),
    bootstrap: {
      maxBytes: 16 * 1024,
      validate: async () => {},
      historyRead: { history, isAvailable: () => true },
      mandatorySources: () => anchors.map((entry) => sourceRef(session.id, entry))
    }
  });
  const transition = await context.transition({
    expectedWindowId: null,
    idempotencyKey: 'select-relevant-constraints',
    reason: 'Keep the current requirement and unresolved ambiguity; original progress remains retrievable.',
    selection: {
      strategy: 'retain',
      retained: [...anchors.map((entry) => sourceRef(session.id, entry)), sourceRef(session.id, ambiguous)],
      notes: [],
      omitted: [
        {
          fromEntryId: sources[1].id,
          toEntryId: sources.at(-1).id,
          reason: 'Irrelevant progress; originals remain in history.'
        }
      ]
    }
  });
  assert.equal(transition.window.selection.retained.length, 3);
  for (const source of [sources[0], sources[50], correction, ambiguous])
    assert.equal((await history.read({ source: sourceRef(session.id, source) })).status, 'available');
  assert.deepEqual(await work.read(current.workId), current);
  const replacement = await sessions.appendSteering(session, {
    runId: 'run-99',
    deliveryId: 'replace-objective',
    content: 'Replace the whole objective: review the parser only.',
    relationship: { kind: 'replace', relatedSources: [sourceRef(session.id, sources[0])] }
  });
  current = await work.synchronizeHistory(current.workId, await history.view());
  assert.deepEqual(
    codingWorkContextAnchors(current, (await history.view()).entries).map((entry) => entry.id),
    [replacement.id]
  );
  assert.equal((await history.read({ source: sourceRef(session.id, correction) })).status, 'available');

  assert.throws(
    () =>
      codingWorkEventCodec.decode({
        type: 'coding.work.recorded',
        work: {
          ...current,
          requirementSources: current.requirementSources.map((source, index) =>
            index === 0 ? { ...source, supersededBy: source.submissionId } : source
          )
        }
      }),
    /later original contribution/
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WritingApplication } from '@ismail-elkorchi/writing-agent';
import { fixture, passingChecker, ScriptedWritingProvider, revisionResponse } from './helpers/runtime.js';

test('writing acceptance, selected passage review, rejection, application, undo, and further instructions share a session', async (t) => {
  const f = await fixture('Opening.\n\nOld line.\n\nClosing.\n');
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const response = revisionResponse(f.resource.resourceId, 'New line.');
  const provider = new ScriptedWritingProvider([
    async (request) => {
      await blocked;
      return response(request);
    },
    'Proposed.',
    response,
    'Proposed again.',
    response,
    'A further proposal.'
  ]);
  const app = new WritingApplication(f.project, {
    configuration: { provider, model: 'writing-test', editorialChecker: passingChecker }
  });
  t.after(async () => {
    release();
    await app.close();
    await rm(f.parent, { recursive: true, force: true });
  });
  const events = [];
  app.subscribe((event) => events.push(event), (error) => assert.fail(error));
  await app.start();
  const document = await app.readDocument(f.resource.resourceId);
  const selection = {
    ...document.selection,
    range: { start: { line: 3, column: 1 }, end: { line: 3, column: 10 } }
  };
  const first = await app.instruct({
    kind: 'revise',
    instruction: 'Tighten the selected sentence.',
    selection
  });
  assert.equal(first.kind, 'accepted');
  assert.equal(app.state().status, 'running');
  assert.equal(
    (await app.instruct({ kind: 'revise', instruction: 'Another instruction', selection })).reason,
    'busy'
  );
  release();
  const result = await first.completion;
  assert.equal(
    result.disposition,
    'valid',
    JSON.stringify({
      uncertainty: result.remainingUncertainty,
      output: result.modelOutputMessage,
      terminal: result.execution.terminal?.termination,
      checks: result.checkResults
    })
  );
  assert.equal(result.sessionId, first.sessionId);
  const comparison = await app.compareProposal(result.proposalId);
  assert.equal(comparison.comparisons[0].after, 'Opening.\n\nNew line.\n\nClosing.\n');
  assert.equal(comparison.review.status, 'proposed');
  assert.equal(comparison.review.authorization, undefined);
  await app.reject(result.proposalId, 'Try the wording again.');
  assert.equal((await app.readProposal(result.proposalId)).status, 'rejected');
  assert.equal(await readFile(path.join(f.root, 'draft.md'), 'utf8'), document.content);

  const second = await app.instruct({ kind: 'revise', instruction: 'Use concise wording.', selection });
  const next = await second.completion;
  assert.equal(second.sessionId, first.sessionId);
  await app.accept({
    proposalId: next.proposalId,
    explanation: 'I accept this wording.',
    humanCriterionDecisions: [
      {
        criterionId: 'criterion-user-instruction',
        verdict: 'passed',
        explanation: 'The requested wording is present.'
      }
    ]
  });
  assert.equal((await app.readProposal(next.proposalId)).status, 'accepted');
  assert.equal(await readFile(path.join(f.root, 'draft.md'), 'utf8'), document.content);
  const authorization = await app.authorize(next.proposalId);
  await app.apply({ proposalId: next.proposalId, authorization });
  assert.equal((await app.readDocument(f.resource.resourceId)).content, comparison.comparisons[0].after);
  await assert.rejects(app.instruct({ kind: 'revise', instruction: 'Stale request', selection }), /stale/u);
  await app.undo({ explanation: 'Restore the previous wording.' });
  assert.equal((await app.readDocument(f.resource.resourceId)).content, document.content);
  const fresh = await app.readDocument(f.resource.resourceId);
  const third = await app.instruct({
    kind: 'revise',
    instruction: 'Continue the discussion.',
    selection: { ...selection, projectRevisionId: fresh.selection.projectRevisionId }
  });
  const further = await third.completion;
  assert.equal(further.sessionId, first.sessionId);
  assert(
    events.some(
      (event) => event.type === 'operation.accepted' && event.operation.operationId === third.operationId
    )
  );
  const history = await app.readHistory();
  assert.equal(history.entries.filter((entry) => entry.type === 'input').length, 3);
});

test('a changed source cannot be repaired by selecting or applying an old proposal', async (t) => {
  const f = await fixture();
  const provider = new ScriptedWritingProvider([
    revisionResponse(f.resource.resourceId, 'New line.'),
    'Proposed.'
  ]);
  const app = new WritingApplication(f.project, {
    configuration: { provider, model: 'writing-test', editorialChecker: passingChecker }
  });
  t.after(async () => {
    await app.close();
    await rm(f.parent, { recursive: true, force: true });
  });
  await app.start();
  const document = await app.readDocument(f.resource.resourceId);
  const accepted = await app.instruct({
    kind: 'revise',
    instruction: 'Revise.',
    selection: document.selection
  });
  const result = await accepted.completion;
  await app.accept({
    proposalId: result.proposalId,
    explanation: 'Accept.',
    humanCriterionDecisions: [
      {
        criterionId: 'criterion-user-instruction',
        verdict: 'passed',
        explanation: 'The requested wording is present.'
      }
    ]
  });
  const authorization = await app.authorize(result.proposalId);
  await writeFile(path.join(f.root, 'draft.md'), 'A concurrent user edit.\n');
  await assert.rejects(app.readDocument(f.resource.resourceId), /changed outside/u);
  await assert.rejects(
    app.apply({ proposalId: result.proposalId, authorization }),
    /stale|changed|preimage|hash/iu
  );
  assert.equal(await readFile(path.join(f.root, 'draft.md'), 'utf8'), 'A concurrent user edit.\n');
});

test('continued writing work owns cancellation and close waits for recovery cleanup', async (t) => {
  const { unknownChecker } = await import('./helpers/runtime.js');
  const f = await fixture();
  const app = new WritingApplication(f.project, {
    configuration: {
      provider: new ScriptedWritingProvider([
        revisionResponse(f.resource.resourceId, 'New line.'),
        'Proposed.'
      ]),
      model: 'writing-test',
      editorialChecker: unknownChecker
    }
  });
  t.after(async () => {
    await app.close();
    await rm(f.parent, { recursive: true, force: true });
  });
  await app.start();
  const document = await app.readDocument(f.resource.resourceId);
  const submission = await app.instruct({
    kind: 'revise',
    instruction: 'Improve this sentence.',
    selection: document.selection
  });
  const first = await submission.completion;
  assert.equal(first.disposition, 'inconclusive');
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let cancelled = false;
  const provider = new ScriptedWritingProvider([
    (request) =>
      new Promise((resolve, reject) => {
        const abort = () => {
          cancelled = true;
          reject(request.signal.reason);
        };
        request.signal.addEventListener('abort', abort, { once: true });
        entered();
        if (request.signal.aborted) abort();
      })
  ]);
  await app.configure({ provider, model: 'writing-test', editorialChecker: passingChecker });
  const completion = app.continueOperation(first.operationId);
  const settled = completion.then(
    (result) => ({ result }),
    (error) => ({ error })
  );
  await started;
  assert.equal(app.state().status, 'recovering');
  await app.abort();
  await settled;
  assert.equal(cancelled, true);
  const closing = app.close();
  assert.equal(app.close(), closing);
  await closing;
  assert.equal(app.state().status, 'closed');
});

test('the default Codex writing provider reaches inference without a wire output cap or recovery', async (t) => {
  const { offlineCodex } = await import('../../application/test/helpers/codex.js');
  const { createWritingProvider } = await import('@ismail-elkorchi/writing-agent');
  const codex = await offlineCodex(t);
  const f = await fixture('A short document.\n');
  const binding = createWritingProvider({ provider: 'openai-codex', model: 'gpt-5.6-luna', endpoint: codex.endpoint });
  const app = new WritingApplication(f.project, { configuration: { ...binding, editorialChecker: passingChecker } });
  t.after(async () => { await app.close(); await rm(f.parent, { recursive: true, force: true }); });
  await app.start();
  const document = await app.readDocument(f.resource.resourceId);
  const submission = await app.instruct({ kind: 'revise', instruction: 'Review this passage.', selection: document.selection });
  assert.equal(submission.kind, 'accepted');
  const result = await submission.completion;
  assert.equal(result.execution.state, 'ended', JSON.stringify(result));
  assert.equal(result.execution.terminal.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(codex.requests.length, 1);
  assert.equal((await app.readSession()).session.suspension, undefined);
});

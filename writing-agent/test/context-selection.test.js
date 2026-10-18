import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, submit, toolCall } from './helpers/runtime.js';

test('idle context selection cannot publish without an actual successor request', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const f = await fixture('', { responses: ['First answer.', 'Second answer.'] });
  t.after(() => f.close());
  await f.application.start();
  await submit(f.application, 'Remember ORIGINAL-MARKER-493.');
  const inspected = await f.application.inspectContext();
  assert.equal(inspected.window, null);
  await assert.rejects(f.application.transitionContext({
    expectedWindowId: null,
    expectedSourceRevision: inspected.cut.sourceRevision,
    idempotencyKey: 'idle-selection',
    reason: 'Attempt an idle selection.',
    selection: { retained: [] }
  }), /compiled next-request admission/);
  assert.equal((await f.application.inspectContext()).window, null);
  await submit(f.application, 'Second question.');
  assert.match(JSON.stringify(f.provider.requests.at(-1).messages), /ORIGINAL-MARKER-493/);
});

test('review mode exposes protected live context without acquiring document edit authority',
  { skip: process.platform !== 'linux', timeout: 30_000 }, async (t) => {
    const f = await fixture('Original document.\n', { mode: 'review', responses: [
      toolCall('context_inspect', { limit: 10, maxBytes: 8192 }),
      request => {
        const inspection = JSON.parse(request.messages.find(item => item.role === 'tool').content);
        assert.equal(inspection.committedWindow, null);
        assert.equal(inspection.selection.status, 'available');
        assert(inspection.selection.items.some(item => item.type === 'input' && item.group.release === 'protected'));
        assert(inspection.admission.inputIdentity);
        assert.equal(inspection.operational.lastAdmittedRequest.inputIdentity, inspection.admission.inputIdentity);
        assert.ok(inspection.operational.capabilities.bindingId);
        assert.ok(inspection.operational.allowance.ownerId);
        const configuredNames = inspection.operational.capabilities.items.filter(tool => tool.available).map(tool => tool.name);
        assert.ok(configuredNames.includes('context_inspect'));
        assert.ok(!configuredNames.includes('apply_patch'));
        assert(!request.tools.some(tool => ['apply_patch', 'edit_text'].includes(tool.type === 'function' ? tool.function.name : tool.name)));
        return 'Review context is available.';
      }
    ] });
    t.after(() => f.close());
    await f.application.start();
    const result = await submit(f.application, 'Inspect the current context for this review.');
    assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
    assert.equal(await readFile(path.join(f.root, 'document.txt'), 'utf8'), 'Original document.\n');
  }
);

test('history_latest retrieves recent user contributions after a fresh context selection',
  { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
    const f = await fixture('', { mode: 'review', responses: [
      'First answer.',
      toolCall('context_save_and_activate', { renewal: true, retain: [], operations: [{ kind: 'create', text: 'Recover recent original user instructions.' }], reason: 'Recover original history in fresh inference.' }),
      toolCall('history_latest', { limit: 10, maxBytes: 8192 }),
      request => {
        const latest = request.messages.filter(item => item.role === 'tool').at(-1);
        assert.ok(latest, 'history_latest must return original contributions');
        assert.match(JSON.stringify(latest), /RECENT-USER-CONSTRAINT-493/);
        assert.match(JSON.stringify(latest), /Recover my recent instructions/);
        return 'Recovered the original instructions.';
      }
    ] });
    t.after(() => f.close());
    await f.application.start();
    await submit(f.application, 'Remember RECENT-USER-CONSTRAINT-493.');
    const result = await submit(f.application, 'Recover my recent instructions.');
    assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  }
);

test('activating the same exact narrative revision preserves the context window',
  { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
    let selected;
    const operations = [{ kind: 'create', text: 'Preserve the author’s uncertainty.' }];
    const f = await fixture('', { mode: 'review', responses: [
      toolCall('context_save_and_activate', { operations, reason: 'Record the current editorial interpretation.' }),
      'State recorded.',
      () => toolCall('context_transition', { sessionState: selected, reason: 'Keep the same editorial interpretation.' }),
      'State unchanged.'
    ] });
    t.after(() => f.close());
    await f.application.start();
    assert.equal((await submit(f.application, 'Review the draft.')).terminal.executionStatus, 'completed');
    const before = await f.application.inspectContext();
    selected = before.sessionState.selected;
    const firstHistory = await f.application.readHistory();
    const transitions = firstHistory.entries.filter(entry => entry.type === 'context_transition');
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].transition.strategy, 'append');
    assert.equal(transitions[0].transition.admission.status, 'admitted');
    assert.equal((await f.application.readSessionState(selected[0])).text, operations[0].text);
    assert.equal((await submit(f.application, 'Keep that interpretation.')).terminal.executionStatus, 'completed');
    const after = await f.application.inspectContext();
    assert.deepEqual(after.sessionState.selected, before.sessionState.selected);
    assert.equal(after.window.windowId, before.window.windowId);
    assert.equal((await f.application.readHistory()).entries.filter(entry => entry.type === 'context_transition').length, 1);
    assert.ok(JSON.stringify(f.provider.requests.at(-1)).includes('Keep that interpretation.'));
  }
);


test('runtime inspection distinguishes the actual last admitted catalog from configured eligibility',
  { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
    const f = await fixture('', { mode: 'review', responses: [
      toolCall('context_runtime_inspect', { target: 'last_admitted', limit: 128 }),
      request => {
        const inspection = JSON.parse(request.messages.filter(item => item.role === 'tool').at(-1).content);
        assert.equal(inspection.capabilityTarget, 'last_admitted');
        assert.equal(inspection.capabilities.revision, inspection.lastAdmittedRequest.catalogRevision);
        assert.equal(inspection.capabilities.bindingId, inspection.lastAdmittedRequest.bindingId);
        assert.ok(inspection.configuredRevision);
        assert.equal(inspection.capabilities.coverage, 'complete');
        const names = inspection.capabilities.items.filter(tool => tool.available).map(tool => tool.name);
        assert.deepEqual(names.sort(), request.tools.map(tool => tool.type === 'function' ? tool.function.name : tool.name).sort());
        return 'Inspected the admitted request.';
      }
    ] });
    t.after(() => f.close());
    await f.application.start();
    assert.equal((await submit(f.application, 'Inspect runtime capabilities.')).terminal.executionStatus, 'completed');
  }
);

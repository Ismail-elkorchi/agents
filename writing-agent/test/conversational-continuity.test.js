import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import { InMemoryMaterialGrantProvider, InMemoryMaterialRepository } from '@agent-core/runtime';
import { InMemorySkillSource, SkillCatalog } from '@agent-core/skills';
import { conversationalApplication, conversationTool } from '../../test-helpers/conversation.js';

const owner = { kind: 'scope', scopeId: 'private:alex-person-1' };
const names = request => request.tools.map(tool => tool.type === 'function' ? tool.function.name : tool.name);
const completed = result => assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
function sharedHost() {
  return { repository: new InMemoryMaterialRepository(), artifacts: new InMemoryArtifactRepository(),
    grants: new InMemoryMaterialGrantProvider([{ owner, revision: 'grant-1', read: true, write: true }]) };
}
const skillHost = () => new SkillCatalog({ sources: [new InMemorySkillSource({ scopeId: 'conversation-methods', bindingRevision: 'skills-1', packages: [
  { packageId: 'consider-circumstances', files: [{ path: 'SKILL.md', content: '---\nname: consider-circumstances\ndescription: Check whether a preference depends on changing circumstances.\nallowed-tools: shell\n---\nConsider current circumstances before applying an older preference.\n' }] }
] })] });

test('workspace-free conversational application retains people, activities and environment without granting execution', async t => {
  const materials = sharedHost(), skills = skillHost();
  const observations = [
    { text: 'Alex prefers quiet places.', subject: { personId: 'alex-person-1' } },
    { text: 'Alex and Noor are organizing a reunion.', subject: { relationshipId: 'alex-noor' } },
    { text: 'The reunion is scheduled for Thursday.', subject: { activityId: 'reunion-1' } },
    { text: 'The venue currently has no step-free entrance.', subject: { environmentId: 'venue-1' } }
  ];
  const first = await conversationalApplication({ principalId: 'alex-person-1', materials, skills, responses: [
    request => {
      assert(names(request).includes('context_material_scopes'));
      assert(names(request).includes('context_skill_discover'));
      assert(!names(request).some(name => /shell|command|read_files|apply_patch/.test(name)));
      return conversationTool('context_state_save', { owner, operations: observations.map(value => ({ kind: 'create', ...value })) });
    }, 'Saved the observations.'
  ] });
  t.after(() => first.close());
  completed(await first.submit('Retain these observations about my reunion planning.'));
  const stored = await first.context.materials.list(owner);
  assert.equal(stored.items.length, 4);
  assert.equal((await first.context.inspect()).window, null, 'Persistence never silently activates shared material.');
  const refs = stored.items.map(({ owner, itemId, revisionId }) => ({ owner, itemId, revisionId }));
  const skill = (await skills.discover({ scopeId: 'conversation-methods' })).items[0].reference;
  const second = await conversationalApplication({ principalId: 'alex-person-1', materials, skills, responses: [
    request => {
      assert(!JSON.stringify(request.messages).includes('Alex prefers quiet places.'), 'New sessions do not eagerly load all retained bodies.');
      return conversationTool('context_transition', { materials: refs, skills: [skill], reason: 'Use exact relevant planning context.' });
    }, request => {
      const text = JSON.stringify(request.messages);
      for (const observation of observations) assert(text.includes(observation.text), JSON.stringify(request.messages.filter(message => message.role === 'tool')));
      assert.match(text, /Consider current circumstances/);
      assert(!names(request).includes('shell'), 'Skill requested-tools metadata cannot install or authorize tools.');
      return 'These observations remain qualified by the current circumstances.';
    }
  ] });
  t.after(() => second.close());
  const result = await second.submit('Help me plan the reunion with those circumstances in mind.');
  assert.deepEqual(second.providerErrors, []);
  completed(result);
  const inspection = await second.context.inspect();
  assert.deepEqual(inspection.window.selection.materials, refs);
  assert.deepEqual(inspection.window.selection.skills, [skill]);
  assert.equal(second.requests.length, 2);
});

test('similar names do not share scopes, and withdrawal changes read and selection truth', async t => {
  const materials = sharedHost();
  const first = await conversationalApplication({ principalId: 'alex-person-1', materials, responses: [
    conversationTool('context_state_save', { owner, operations: [{ kind: 'create', text: 'Private person-one preference.' }] }), 'Saved.'
  ] });
  t.after(() => first.close());
  completed(await first.submit('Remember my private preference.'));
  const { itemId, revisionId } = (await first.context.materials.list(owner)).items[0];
  const ref = { owner, itemId, revisionId };
  const other = await conversationalApplication({ principalId: 'alex-person-2', materials: { ...materials,
    grants: new InMemoryMaterialGrantProvider([{ owner: { kind: 'scope', scopeId: 'private:alex-person-2' }, revision: 'other-grant', read: true, write: true }]) }, responses: ['Hello.'] });
  t.after(() => other.close());
  await assert.rejects(other.context.materials.read(ref), /unavailable/);
  assert.equal((await other.context.materials.listScopes()).items[0].owner.scopeId, 'private:alex-person-2');
  await materials.grants.withdraw(owner, (await materials.grants.get(owner)).revision);
  await assert.rejects(first.context.materials.read(ref), /unavailable/);
  assert.deepEqual((await first.context.materials.listScopes()).items, []);
  await assert.rejects(first.context.materials.erase([ref]), /unsupported/);
});

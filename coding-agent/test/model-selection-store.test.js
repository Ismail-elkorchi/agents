import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PrivateStateDirectory } from '../dist/state/private-state.js';
import { ModelSelectionStore } from '../dist/state/model-selection-store.js';

test('interactive model selection persists one provider-scoped user default', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'coding-agent-model-selection-'));
  const state = await PrivateStateDirectory.create(path.join(parent, 'state'));
  const store = new ModelSelectionStore(state);
  assert.equal(await store.read(), undefined);
  await store.write({ provider: 'openai-codex', model: 'gpt-5.6-luna' });
  assert.deepEqual(await store.read(), { provider: 'openai-codex', model: 'gpt-5.6-luna' });
  await store.write({ provider: 'ollama' });
  assert.deepEqual(await store.read(), { provider: 'ollama' });
});

test('interactive model selection rejects unknown schema fields instead of migrating them', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'coding-agent-model-selection-invalid-'));
  const state = await PrivateStateDirectory.create(path.join(parent, 'state'));
  await state.write('settings/model-selection.json', JSON.stringify({
    version: 1,
    provider: 'ollama',
    model: 'test',
    legacyProvider: 'ignored'
  }));
  await assert.rejects(new ModelSelectionStore(state).read(), /Stored model selection is invalid/u);
});

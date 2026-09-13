import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileCredentialStore } from '@agent-core/auth';

/** Exercise application-owned provider construction without credentials or network from the host. */
export async function offlineCodex(t, output = 'Hello from the provider.') {
  const root = await mkdtemp(path.join(tmpdir(), 'agents-codex-test-'));
  const prior = process.env.AGENT_CORE_HOME;
  process.env.AGENT_CORE_HOME = root;
  t.after(async () => {
    if (prior === undefined) delete process.env.AGENT_CORE_HOME;
    else process.env.AGENT_CORE_HOME = prior;
    await rm(root, { recursive: true, force: true });
  });
  const token = `test.${Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'offline-test' }
    })
  ).toString('base64url')}.test`;
  await new FileCredentialStore().write('openai-codex', { token, expiresAt: Date.now() + 3_600_000 });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), 'https://offline-codex.invalid/codex/responses');
    const body = JSON.parse(init.body);
    requests.push(body);
    assert.equal('max_output_tokens' in body, false);
    const content = typeof output === 'function' ? output(body) : output;
    return new Response(
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: `response-${requests.length}`,
          model: body.model,
          status: 'completed',
          output_text: content,
          output: []
        }
      })}\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } }
    );
  });
  return { requests, endpoint: 'https://offline-codex.invalid/codex/responses' };
}

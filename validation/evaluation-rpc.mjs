import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { launch, sandboxArgs } from './evaluation-isolation.mjs';

/** The only application-specific adapter: documented Coding Agent CLI/RPC. */
export function codingAgent({ workspace, state, build, socket, settings, signal, timeoutMs, onEvent }) {
  const pending = new Map();
  let nextId = 0, ended;
  const process = launch([...sandboxArgs({
    workspace, state, build, socket,
    runner: fileURLToPath(new URL('./evaluation-bridge.mjs', import.meta.url))
  }), '/runtime/node', '/bridge.mjs',
  '--permissions', settings.permissions,
  '--max-output-tokens', String(settings.maxOutputTokens),
  '--temperature', String(settings.temperature),
  ...(settings.reasoning === 'provider-default' ? [] : ['--reasoning-effort', settings.reasoning])], {
    signal, timeoutMs,
    onLine(line) {
      const value = JSON.parse(line);
      if (Object.hasOwn(value, 'id')) {
        const waiter = pending.get(value.id);
        if (!waiter) throw new Error('Unmatched RPC response');
        pending.delete(value.id);
        if (value.error) waiter.reject(new Error(value.error.message));
        else waiter.resolve(value.result);
      } else onEvent(value.method, value.params);
    }
  });
  process.done.then(result => {
    ended = result;
    for (const waiter of pending.values()) waiter.reject(new Error(`Application exited: ${JSON.stringify(result)}`));
    pending.clear();
  });
  return {
    ...process,
    request(method, params = {}) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (ended) return Promise.reject(new Error('Application has exited.'));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        process.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    }
  };
}

/** A narrow local provider capability, not a general network proxy. */
export async function providerSocket({ endpoint, socket, model, maxOutputTokens, maxRequests, signal }) {
  signal?.throwIfAborted();
  const target = new URL(endpoint);
  if (!['127.0.0.1', '[::1]'].includes(target.hostname) ||
      target.protocol !== 'http:' || target.username || target.password ||
      target.pathname !== '/' || target.search || target.hash)
    throw new Error('Only credential-free loopback providers are supported. Paid execution is disabled.');
  const receipts = [];
  let metadataRequests = 0;
  let admissionClosedReason;
  const upstreams = new Map();
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (incoming.method !== 'POST' || !['/api/show', '/api/chat'].includes(incoming.url)) {
        outgoing.writeHead(403).end(); return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) throw new Error('Provider request too large.');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const body = JSON.parse(bytes);
      if (signal?.aborted || admissionClosedReason === 'closed') {
        outgoing.writeHead(429).end(); return;
      }
      if (body.model !== model) { outgoing.writeHead(403).end(); return; }
      const chat = incoming.url === '/api/chat';
      if (!chat) metadataRequests++;
      if (chat && !admissionClosedReason) {
        if (receipts.length >= maxRequests) admissionClosedReason = 'request_limit';
        else if (!Number.isSafeInteger(body.options?.num_predict) ||
            body.options.num_predict < 1 || body.options.num_predict > maxOutputTokens)
          admissionClosedReason = 'invalid_generation_limit';
      }
      if (chat && admissionClosedReason) {
        outgoing.writeHead(429).end('{"error":"Evaluation request boundary exhausted"}'); return;
      }
      const receipt = chat ? {
        ordinal: receipts.length + 1, startedAt: new Date().toISOString(),
        requestBytes: bytes.length, status: 'in-flight', usage: null
      } : undefined;
      if (receipt) receipts.push(receipt);
      const uncertain = (reason = 'provider_failure') => {
        if (receipt?.status === 'in-flight') {
          receipt.status = 'uncertain';
          receipt.elapsedMs = Date.now() - Date.parse(receipt.startedAt);
        }
        admissionClosedReason ??= reason;
        outgoing.destroy();
      };
      const upstream = request(new URL(incoming.url, target), {
        method: 'POST', headers: { 'content-type': 'application/json' }
      }, response => {
        outgoing.writeHead(response.statusCode, { 'content-type': response.headers['content-type'] ?? 'application/json' });
        let buffered = '', responseBytes = 0;
        response.on('data', chunk => {
          responseBytes += chunk.length;
          if (responseBytes > 16 * 1024 * 1024) { uncertain(); upstream.destroy(); return; }
          if (receipt) {
            buffered += chunk.toString();
            const lines = buffered.split('\n');
            buffered = lines.pop();
            for (const line of lines) observe(line);
          }
          outgoing.write(chunk);
        });
        function observe(line) {
          try {
            const value = JSON.parse(line);
            if (value.done === true && Number.isSafeInteger(value.prompt_eval_count) &&
              value.prompt_eval_count >= 0 && Number.isSafeInteger(value.eval_count) && value.eval_count >= 0)
              receipt.usage = { promptTokens: value.prompt_eval_count, completionTokens: value.eval_count };
          } catch { /* Interrupted framing is retained as unavailable usage. */ }
        }
        response.on('end', () => {
          if (receipt) {
            observe(buffered);
            receipt.status = response.statusCode === 200 ? 'returned' : 'provider-error';
            receipt.elapsedMs = Date.now() - Date.parse(receipt.startedAt);
            if (response.statusCode !== 200) admissionClosedReason ??= 'provider_failure';
            else if (!receipt.usage) admissionClosedReason ??= 'usage_unavailable';
          }
          outgoing.end();
        });
        response.on('error', () => uncertain());
      });
      upstream.on('error', () => uncertain());
      upstreams.set(upstream, new Promise(resolve => upstream.once('close', () => {
        if (receipt?.status === 'in-flight') uncertain();
        upstreams.delete(upstream);
        resolve();
      })));
      outgoing.on('close', () => {
        if (!outgoing.writableFinished) uncertain('request_interrupted');
        upstream.destroy();
      });
      upstream.end(bytes);
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(400);
      outgoing.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  return {
    receipts,
    get metadataRequests() { return metadataRequests; },
    get admissionClosedReason() { return admissionClosedReason; },
    async close() {
      admissionClosedReason ??= receipts.some(receipt => receipt.status === 'in-flight') ? 'request_interrupted' : 'closed';
      const closing = [...upstreams.values()];
      for (const upstream of upstreams.keys()) upstream.destroy();
      server.closeAllConnections();
      await Promise.all([...closing, new Promise(resolve => server.close(resolve))]);
    }
  };
}

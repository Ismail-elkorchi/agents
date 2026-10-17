import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { providerSocket } from '../../validation/evaluation-rpc.mjs';
import { providerMeasurements } from '../../validation/evaluation-report.mjs';

async function fixture(t, handler, maxRequests = 4, signal) {
  const directory = await mkdtemp(path.join(tmpdir(), 'evaluation-provider-'));
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\${path.basename(directory)}` : path.join(directory, 'provider.sock');
  const transport = await providerSocket({
    endpoint: `http://127.0.0.1:${server.address().port}`, socket,
    model: 'local-fixture', maxOutputTokens: 16, maxRequests, signal
  });
  t.after(async () => {
    await transport.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const chat = () => new Promise((resolve, reject) => {
    const call = request({ socketPath: socket, path: '/api/chat', method: 'POST' }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
      response.once('error', reject);
    });
    call.once('error', reject);
    call.end(JSON.stringify({ model: 'local-fixture', options: { num_predict: 16 } }));
  });
  return { transport, chat };
}

test('provider request limit refuses new work without adding a fictitious upstream receipt', async t => {
  let requests = 0;
  const { transport, chat } = await fixture(t, (_request, response) => {
    requests++;
    response.end(JSON.stringify({ done: true, prompt_eval_count: 3, eval_count: 0 }));
  }, 1);
  assert.equal(await chat(), 200);
  assert.equal(await chat(), 429);
  assert.equal(requests, 1);
  assert.equal(transport.admissionClosedReason, 'request_limit');
  assert.equal(providerMeasurements(transport.receipts).reported.completionTokens, 0);
});

test('missing provider usage closes admission without claiming budget exhaustion', async t => {
  const { transport, chat } = await fixture(t, (_request, response) => response.end('{"done":true}'));
  assert.equal(await chat(), 200);
  assert.equal(await chat(), 429);
  assert.equal(transport.admissionClosedReason, 'usage_unavailable');
  assert.equal(providerMeasurements(transport.receipts).reported.promptTokens, null);
});

test('truncated upstream response settles uncertain and closes admission', async t => {
  const { transport, chat } = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'content-length': 1000, connection: 'close' });
    // End a short response, without relying on a timer to interrupt framing.
    response.end('{"done":false}');
  });
  await assert.rejects(chat());
  assert.equal(await chat(), 429);
  assert.equal(transport.admissionClosedReason, 'provider_failure');
  assert.equal(transport.receipts[0].status, 'uncertain');
  assert.equal(providerMeasurements(transport.receipts).reported.promptTokens, null);
});

test('cancellation closes provider admission before another request is forwarded', async t => {
  const controller = new AbortController();
  let requests = 0;
  const { transport, chat } = await fixture(t, (_request, response) => {
    requests++; response.end('{"done":true,"prompt_eval_count":1,"eval_count":1}');
  }, 4, controller.signal);
  assert.equal(await chat(), 200);
  controller.abort();
  assert.equal(await chat(), 429);
  assert.equal(requests, 1);
  assert.equal(transport.receipts.length, 1);
});

test('transport shutdown settles outstanding receipts before returning measurements', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { transport, chat } = await fixture(t, () => started());
  const pending = assert.rejects(chat());
  await ready;
  await transport.close();
  await pending;
  assert.equal(transport.receipts[0].status, 'uncertain');
  assert.equal(transport.admissionClosedReason, 'request_interrupted');
});

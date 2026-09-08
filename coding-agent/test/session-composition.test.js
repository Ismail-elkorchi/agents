import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createCodingSession,
  closeCodingSession,
  openCodingWorkspace,
  createTrustDecision
} from '@ismail-elkorchi/coding-agent';

const rootedWorkspaceTest = {
  skip: process.platform !== 'linux' && 'Rooted workspaces require Linux handle-relative file authority.'
};

class SessionProvider {
  id = 'coding-session-test';
  implementationId = 'tests.coding-session-provider@1';
  requests = [];
  describe() {
    return { id: this.id, displayName: 'Coding session test', defaultModel: 'fixture' };
  }
  async describeModel() {
    return {
      id: 'fixture',
      provider: this.id,
      capabilities: {
        streaming: false,
        toolCalling: true,
        supportedToolInputs: [{ kind: 'json' }],
        jsonMode: false,
        jsonSchema: false,
        logprobs: false,
        temperature: false,
        topP: false
      },
      modalities: { input: ['text'], output: ['text'] },
      limits: { contextTokens: 100_000, outputTokens: 2_000 },
      supportedParameters: ['tools', 'maxOutputTokens']
    };
  }
  async complete(request) {
    this.requests.push(request);
    return {
      content: `Inspected the requested workspace (response ${this.requests.length}).`,
      model: request.model,
      provider: this.id,
      terminationReason: 'stop'
    };
  }
}

test(
  'programmatic coding composition keeps original requests and refreshes current application state',
  rootedWorkspaceTest,
  async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'coding-session-app-'));
    const root = path.join(parent, 'workspace');
    const stateRoot = path.join(parent, 'state');
    await mkdir(root);
    await writeFile(path.join(root, 'AGENTS.md'), 'Current guidance: initial.\n');
    await writeFile(path.join(root, 'file.txt'), 'before\n');
    let workspace = await openCodingWorkspace(root, { stateRoot });
    await workspace.trustStore.write(
      createTrustDecision({
        workspace: workspace.layout.identity,
        level: 'trusted',
        actorKind: 'user',
        actor: 'test-owner'
      })
    );
    workspace.fileRoot.close();
    workspace = await openCodingWorkspace(root, { stateRoot });
    const provider = new SessionProvider();
    const composition = await createCodingSession({
      workspace,
      provider,
      settings: { provider: provider.id, model: 'fixture' },
      permissionMode: 'review'
    });
    try {
      const original = `${'Original context. '.repeat(80)}Keep exact constraint AFTER EIGHT HUNDRED.`;
      const first = await composition.agent.submit({ task: original });
      assert.equal(first.kind, 'started');
      assert.equal((await first.completion).state, 'ended');
      await writeFile(path.join(root, 'AGENTS.md'), 'Current guidance: corrected.\n');
      await writeFile(path.join(root, 'file.txt'), 'after\n');
      const second = await composition.agent.submit({ task: 'Continue the same inspection.' });
      assert.equal((await second.completion).state, 'ended');
      const request = provider.requests.at(-1);
      assert.ok(request.messages.some((item) => item.role === 'user' && item.content.includes(original)));
      const current = request.messages
        .filter((item) => item.content.includes('<context'))
        .map((item) => item.content)
        .join('\n');
      assert.match(current, /Current guidance: corrected/u);
      assert.doesNotMatch(current, /Current guidance: initial/u);
      const tools = request.tools.map((tool) =>
        tool.type === 'function' ? tool.function.name : tool.name
      );
      for (const name of [
        'history_read',
        'history_search',
        'notes_write',
        'notes_read',
        'context_inspect',
        'context_transition'
      ])
        assert.ok(tools.includes(name), name);
      assert.equal(tools.includes('apply_patch'), false);
      const stateContext = current.match(/coding-state\//u);
      assert.ok(stateContext);

      const statePayload = current.match(
        /<context id="coding-state\/[^\n]+[\s\S]*?<data>\n([\s\S]*?)\n<\/data>/u
      );
      assert.ok(statePayload);
      const boundary = JSON.parse(
        statePayload[1].replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
      );
      assert.equal(await composition.handoffs.read(first.runId), undefined);
      assert.equal(boundary.workingCopy, null);
      assert.equal(boundary.latestHandoff, null);
      const firstWork = await composition.work.forRun(first.runId);
      assert.equal((await composition.work.forRun(second.runId)).workId, firstWork.workId);
      assert.equal(firstWork.baselineDigest, undefined);

      const { sourceRef } = await import('@agent-core/runtime');
      const view = await composition.history.view();
      const oldResponse = view.entries.find(
        (entry) => entry.type === 'assistant' && entry.content.includes('(response 1)')
      );
      const latestResponse = view.entries.find(
        (entry) => entry.type === 'assistant' && entry.content.includes('(response 2)')
      );
      const pressureRequest = {
        expectedWindowId: view.contextWindow?.windowId ?? null,
        expectedSourceRevision: view.cut.sourceRevision,
        idempotencyKey: 'explicit-selection',
        reason: 'Select relevant history with original retrieval.',
        selection: {
          strategy: 'retain',
          notes: [],
          retained: view.entries
            .filter((entry) => entry !== oldResponse)
            .map((entry) => sourceRef(view.cut.sessionId, entry)),
          omitted: [
            {
              fromEntryId: sourceRef(view.cut.sessionId, oldResponse).entryId,
              toEntryId: sourceRef(view.cut.sessionId, oldResponse).entryId,
              reason: 'Original remains available.'
            }
          ]
        }
      };
      assert.ok(latestResponse);
      const transition = await composition.agent.transitionContext(pressureRequest);
      assert.equal((await composition.context.inspect()).window.windowId, transition.window.windowId);
      await assert.rejects(
        () =>
          composition.agent.transitionContext({ ...pressureRequest, idempotencyKey: 'stale-selection' }),
        /stale/u
      );
      const third = await composition.agent.submit({ task: 'Continue after selecting retained history.' });
      assert.equal((await third.completion).state, 'ended');
      const retainedRequest = provider.requests.at(-1);
      assert.ok(
        retainedRequest.messages.some((item) => item.role === 'user' && item.content.includes(original))
      );
      assert.equal(
        retainedRequest.messages.some(
          (item) => item.role === 'assistant' && item.content.includes('(response 1)')
        ),
        false
      );
      assert.ok(
        retainedRequest.messages.some(
          (item) => item.role === 'assistant' && item.content.includes('(response 2)')
        )
      );
      const retrieved = await composition.history.read({
        source: sourceRef(view.cut.sessionId, oldResponse),
        maxBytes: 4096
      });
      assert.equal(retrieved.status, 'available');
      assert.match(retrieved.item.text, /response 1/u);

      let requested = false;
      const complete = provider.complete.bind(provider);
      const observedWindows = [];
      const unsubscribe = composition.agent.subscribe((event) => {
        if (event.type === 'run.progress' && event.event.type === 'context.transitioned')
          observedWindows.push(event.event.window.windowId);
      });
      provider.complete = async (request) => {
        if (requested) return complete(request);
        requested = true;
        provider.requests.push(request);
        const currentView = await composition.history.view();
        return {
          content: '',
          model: request.model,
          provider: provider.id,
          terminationReason: 'tool_calls',
          toolCalls: [
            {
              id: 'model-context-call',
              type: 'function',
              name: 'context_transition',
              input: {
                kind: 'json',
                value: {
                  expectedWindowId: currentView.contextWindow?.windowId ?? null,
                  idempotencyKey: 'model-queued-transition',
                  reason: 'Model requested exact retained history.',
                  selection: {
                    strategy: 'retain',
                    retained: currentView.entries
                      .filter((entry) => entry.type !== 'context_transition')
                      .map((entry) => sourceRef(currentView.cut.sessionId, entry)),
                    omitted: [],
                    notes: []
                  }
                }
              }
            }
          ]
        };
      };
      const modelControl = await composition.agent.submit({
        task: 'Use the general context transition tool.'
      });
      assert.equal((await modelControl.completion).state, 'ended');
      const lifecycle = [];
      for await (const record of composition.events.read(modelControl.runId))
        if (record.event.type.startsWith('context.transition.')) lifecycle.push(record.event);
      assert.equal(lifecycle.filter((event) => event.type === 'context.transition.requested').length, 1);
      assert.equal(
        lifecycle.filter((event) => event.type === 'context.transition.completed').length,
        1,
        JSON.stringify(lifecycle)
      );
      assert.equal(lifecycle.filter((event) => event.type === 'context.transition.rejected').length, 0);
      const modelWindow = (await composition.context.inspect()).window;
      assert.match(modelWindow.reason, /Model requested exact retained history/u);
      assert.ok(observedWindows.includes(modelWindow.windowId));
      unsubscribe();
    } finally {
      await closeCodingSession(composition);
      workspace.fileRoot.close();
      await rm(parent, { recursive: true, force: true });
    }
  }
);

test('compiled provider egress checks sent content and admits each dispatch once', async () => {
  const { protectProviderEgress } = await import('@ismail-elkorchi/coding-agent');
  const { modelInputIdentity } = await import('@agent-core/model');
  const workspace = {
    id: 'test-workspace',
    platform: process.platform,
    canonicalPath: '/workspace',
    device: '1',
    inode: '2',
    mountId: '3'
  };
  const request = Object.freeze({
    model: 'fixture',
    messages: Object.freeze([Object.freeze({ role: 'user', content: 'Public source.' })])
  });
  let content = 'Provider-added safe content';
  let calls = 0;
  const receipts = [];
  const provider = new SessionProvider();
  provider.compileRequest = async (logicalRequest) => {
    const body = Object.freeze({ input: content });
    return Object.freeze({
      version: 1,
      provider: provider.id,
      model: logicalRequest.model,
      endpoint: 'https://provider.invalid',
      capabilityRevision: 'fixture',
      logicalRequest,
      body,
      accounting: Object.freeze({}),
      inputIdentity: await modelInputIdentity(body)
    });
  };
  provider.completeCompiled = async () => {
    calls += 1;
    return { content: 'done', model: 'fixture', provider: provider.id, terminationReason: 'stop' };
  };
  const protectedProvider = protectProviderEgress({
    provider,
    workspace,
    trustLevel: 'trusted',
    policy: { onAdmitted: (receipt) => receipts.push(receipt) }
  });
  const compiled = await protectedProvider.compileRequest(request);
  assert.equal(receipts.length, 0);
  await protectedProvider.completeCompiled(compiled);
  assert.equal(calls, 1);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].bytes, Buffer.byteLength(JSON.stringify(compiled.body)));
  content = 'api_key=abcdefghijk';
  await assert.rejects(() => protectedProvider.complete(request), /sensitive-data/u);
  assert.equal(calls, 1);
  const changed = Object.freeze({ ...compiled, body: Object.freeze({ input: 'Different body' }) });
  await assert.rejects(() => protectedProvider.completeCompiled(changed), /input identity/u);
  assert.equal(calls, 1);
});

test('provider session preserves steering identities and applies egress to appended input', async () => {
  const { protectProviderEgress } = await import('@ismail-elkorchi/coding-agent');
  const workspace = {
    id: 'test-workspace',
    platform: process.platform,
    canonicalPath: '/workspace',
    device: '1',
    inode: '2',
    mountId: '3'
  };
  const provider = new SessionProvider();
  const delivered = [];
  provider.createSession = () => ({
    complete: (request) => provider.complete(request),
    steer: async (submission) => {
      delivered.push(submission);
      return {
        deliveryId: submission.deliveryId,
        responseId: submission.responseId,
        status: 'acknowledged'
      };
    },
    steeringStatus: async (deliveryId) => ({ deliveryId, responseId: 'response-1', status: 'acknowledged' })
  });
  const session = protectProviderEgress({ provider, workspace, trustLevel: 'trusted' }).createSession();
  await session.complete({ model: 'fixture', messages: [{ role: 'user', content: 'start' }] });
  const submission = {
    deliveryId: 'delivery-1',
    responseId: 'response-1',
    input: [{ role: 'user', content: 'Correct the wording.' }]
  };
  assert.equal((await session.steer(submission)).deliveryId, submission.deliveryId);
  assert.equal(delivered[0], submission);
  assert.equal((await session.steeringStatus(submission.deliveryId)).responseId, submission.responseId);
  assert.throws(
    () => session.steer({ ...submission, input: [{ role: 'user', content: 'password=abcdefghijk' }] }),
    /sensitive-data/u
  );
  assert.equal(delivered.length, 1);
});

test('provider session retains independent tool-result identities under the egress boundary', async () => {
  const { protectProviderEgress } = await import('@ismail-elkorchi/coding-agent');
  const provider = new SessionProvider();
  const delivered = [];
  provider.createSession = () => ({
    complete: (request) => provider.complete(request),
    deliverToolResults: async (delivery) => {
      delivered.push(delivery);
      return {
        deliveryId: delivery.deliveryId,
        responseId: delivery.responseId,
        sourceCalls: delivery.sourceCalls,
        inputIdentity: 'result-input',
        status: 'acknowledged'
      };
    }
  });
  const session = protectProviderEgress({
    provider,
    workspace: { id: 'test-workspace' },
    trustLevel: 'trusted'
  }).createSession();
  await session.complete({ model: 'fixture', messages: [{ role: 'user', content: 'start' }] });
  const delivery = {
    deliveryId: 'result-delivery-1',
    responseId: 'response-2',
    sourceCalls: [{ responseId: 'response-1', catalogIdentity: 'catalog-1', toolCallId: 'call-1' }],
    results: [
      {
        role: 'tool',
        toolCallType: 'function',
        toolName: 'fixture_read',
        toolCallId: 'call-1',
        content: 'Observed result.'
      }
    ]
  };
  const receipt = await session.deliverToolResults(delivery);
  assert.equal(delivered[0], delivery);
  assert.equal(receipt.deliveryId, delivery.deliveryId);
  assert.equal(receipt.sourceCalls, delivery.sourceCalls);
  assert.throws(
    () =>
      session.deliverToolResults({
        ...delivery,
        results: [{ ...delivery.results[0], content: 'api_key=abcdefghijk' }]
      }),
    /sensitive-data/u
  );
  assert.equal(delivered.length, 1);
});

test('native successors inspect their exact frame and retained state before shared host admission', async () => {
  const { protectProviderEgress } = await import('@ismail-elkorchi/coding-agent');
  const { modelInputIdentity } = await import('@agent-core/model');
  const provider = new SessionProvider();
  const logicalRequest = Object.freeze({
    model: 'fixture',
    messages: Object.freeze([Object.freeze({ role: 'user', content: 'Public logical source.' })])
  });
  const compile = async (body, retainedBody) =>
    Object.freeze({
      version: 1,
      provider: provider.id,
      model: 'fixture',
      endpoint: 'fixture-native',
      capabilityRevision: 'fixture',
      logicalRequest,
      body,
      ...(retainedBody === undefined ? {} : { retainedBody }),
      accounting: Object.freeze({}),
      inputIdentity: await modelInputIdentity(retainedBody === undefined ? body : { body, retainedBody })
    });
  const initial = await compile(Object.freeze({ input: 'Initial frame.' }));
  const receipts = [];
  const reserved = [];
  const sent = [];
  const controller = new AbortController();
  let transport;
  let nextCompiled = await compile(
    Object.freeze({ input: 'Exact successor frame.' }),
    Object.freeze({ input: 'Exact inherited context.' })
  );
  let rejectReservation = false;
  const send = async (kind, submission) => {
    const dispatch = Object.freeze({
      kind,
      deliveryId: submission.deliveryId,
      responseId: submission.responseId,
      generationDeliveryId: submission.deliveryId,
      compiled: nextCompiled,
      sourceCalls: submission.sourceCalls ?? []
    });
    await transport.native.admit(dispatch);
    const receipt = {
      deliveryId: submission.deliveryId,
      responseId: submission.responseId,
      inputIdentity: nextCompiled.inputIdentity,
      status: 'acknowledged',
      ...(submission.sourceCalls === undefined ? {} : { sourceCalls: submission.sourceCalls })
    };
    sent.push({ dispatch, submission, receipt });
    return receipt;
  };
  provider.createSession = () => ({
    complete: (request) => provider.complete(request),
    completeCompiled: async (compiled, options) => {
      assert.equal(compiled, initial);
      assert.equal(options.signal, controller.signal);
      transport = options;
      return provider.complete(compiled.logicalRequest);
    },
    steer: (submission) => send('steering', submission),
    deliverToolResults: (submission) => send('tool_results', submission),
    continueNative: (submission) => send('continuation', submission),
    toolResultStatus: async (id) => sent.find((item) => item.receipt.deliveryId === id).receipt,
    nativeDeliveryStatus: async (id) => sent.find((item) => item.receipt.deliveryId === id).receipt
  });
  const session = protectProviderEgress({
    provider,
    workspace: { id: 'test-workspace' },
    trustLevel: 'trusted',
    policy: { onAdmitted: (receipt) => receipts.push(receipt) }
  }).createSession();
  await session.completeCompiled(initial, {
    signal: controller.signal,
    native: {
      admit: async (dispatch) => {
        assert.equal(dispatch.compiled, nextCompiled);
        if (rejectReservation) throw new Error('Shared budget denied.');
        reserved.push(dispatch);
      }
    }
  });
  const steering = {
    deliveryId: 'steer-1',
    responseId: 'response-1',
    input: [{ role: 'user', content: 'Additional requirement.' }]
  };
  const result = {
    deliveryId: 'result-1',
    responseId: 'response-2',
    sourceCalls: [{ responseId: 'response-1', catalogIdentity: 'catalog-1', toolCallId: 'call-1' }],
    results: [
      {
        role: 'tool',
        toolCallType: 'function',
        toolName: 'fixture_read',
        toolCallId: 'call-1',
        content: 'Observed result.'
      }
    ]
  };
  const continuation = {
    deliveryId: 'continue-1',
    responseId: 'response-3',
    input: [{ role: 'user', content: 'Next requirement.' }]
  };
  await session.steer(steering);
  const resultReceipt = await session.deliverToolResults(result);
  const continuationReceipt = await session.continueNative(continuation);
  assert.deepEqual(
    sent.map((item) => item.submission),
    [steering, result, continuation]
  );
  for (let i = 0; i < sent.length; i += 1) assert.equal(reserved[i], sent[i].dispatch);
  assert.equal(sent[1].dispatch.sourceCalls, result.sourceCalls);
  assert.equal(await session.toolResultStatus(result.deliveryId), resultReceipt);
  assert.equal(await session.nativeDeliveryStatus(continuation.deliveryId), continuationReceipt);
  assert.equal(
    receipts.length,
    4,
    'one receipt per initial or successor frame, no duplicate logical/control admission'
  );
  assert.equal(
    receipts[1].bytes,
    Buffer.byteLength(JSON.stringify({ body: nextCompiled.body, retainedBody: nextCompiled.retainedBody }))
  );

  nextCompiled = await compile(Object.freeze({ input: 'password=abcdefghijk' }));
  await assert.rejects(
    () => session.continueNative({ ...continuation, deliveryId: 'secret-frame' }),
    /sensitive-data/u
  );
  nextCompiled = await compile(
    Object.freeze({ input: 'Safe frame.' }),
    Object.freeze({ input: 'api_key=abcdefghijk' })
  );
  await assert.rejects(
    () => session.deliverToolResults({ ...result, deliveryId: 'secret-retained-state' }),
    /sensitive-data/u
  );
  nextCompiled = Object.freeze({
    ...(await compile(Object.freeze({ input: 'Safe frame.' }))),
    inputIdentity: 'changed-identity'
  });
  await assert.rejects(
    () => session.steer({ ...steering, deliveryId: 'changed-frame-identity' }),
    /input identity/u
  );
  assert.equal(reserved.length, 3);
  assert.equal(sent.length, 3);
  assert.equal(receipts.length, 4);
  nextCompiled = await compile(Object.freeze({ input: 'Safe budget-denied frame.' }));
  rejectReservation = true;
  await assert.rejects(
    () => session.continueNative({ ...continuation, deliveryId: 'budget-denied' }),
    /Shared budget denied/u
  );
  assert.equal(sent.length, 3);
});

test('provider egress includes structured response controls in admission', async () => {
  const { protectProviderEgress } = await import('@ismail-elkorchi/coding-agent');
  const provider = new SessionProvider();
  const protectedProvider = protectProviderEgress({
    provider,
    workspace: { id: 'test-workspace' },
    trustLevel: 'trusted'
  });
  await assert.rejects(
    () =>
      protectedProvider.complete({
        model: 'fixture',
        messages: [{ role: 'user', content: 'Public request.' }],
        responseFormat: {
          type: 'json_schema',
          jsonSchema: { name: 'fixture', schema: { password: 'abcdefghijk' } }
        }
      }),
    /sensitive-data/u
  );
  assert.equal(provider.requests.length, 0);
});

test(
  'coding pressure cannot silently replace an application context selection',
  rootedWorkspaceTest,
  async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'coding-pressure-app-'));
    const root = path.join(parent, 'workspace');
    const stateRoot = path.join(parent, 'state');
    await mkdir(root);
    await writeFile(path.join(root, 'file.txt'), 'Stable source.\n');
    let workspace = await openCodingWorkspace(root, { stateRoot });
    await workspace.trustStore.write(
      createTrustDecision({
        workspace: workspace.layout.identity,
        level: 'trusted',
        actorKind: 'user',
        actor: 'test-owner'
      })
    );
    workspace.fileRoot.close();
    workspace = await openCodingWorkspace(root, { stateRoot });
    const provider = new SessionProvider();
    const describeModel = provider.describeModel.bind(provider);
    let contextTokens = 100_000;
    provider.describeModel = async () => {
      const profile = await describeModel();
      return { ...profile, limits: { ...profile.limits, contextTokens } };
    };
    const oldOutput = 'Older context retained for exact history retrieval. '.repeat(100);
    provider.complete = async (request) => {
      provider.requests.push(request);
      return {
        content: provider.requests.length === 1 ? oldOutput : 'Current inspected state.',
        model: request.model,
        provider: provider.id,
        terminationReason: 'stop'
      };
    };
    const coding = await createCodingSession({
      workspace,
      provider,
      settings: { provider: provider.id, model: 'fixture' },
      permissionMode: 'review'
    });
    try {
      for (const task of ['Original requirement must remain exact.', 'Latest settled work.']) {
        const submission = await coding.agent.submit({ task });
        assert.equal((await submission.completion).state, 'ended');
      }
      contextTokens = 4096;
      const submission = await coding.agent.submit({ task: 'Newest requirement must also remain exact.' });
      const result = await submission.completion;
      assert.equal(result.state, 'ended');
      const inspection = await coding.context.inspect();
      assert.equal(inspection.window, null);
      assert.equal(result.terminal.executionStatus, 'failed');
      assert.equal(provider.requests.length, 2);
      const sources = await coding.history.view();
      assert.ok(
        sources.entries.some(
          (entry) => entry.type === 'input' && entry.task === 'Newest requirement must also remain exact.'
        )
      );
      assert.ok(sources.entries.some((entry) => entry.type === 'assistant' && entry.content === oldOutput));
    } finally {
      await closeCodingSession(coding);
      workspace.fileRoot.close();
      await rm(parent, { recursive: true, force: true });
    }
  }
);

test('native context transforms retain exact compiled admission and transform identity', async () => {
  const { protectProviderEgress } = await import('@ismail-elkorchi/coding-agent');
  const { modelInputIdentity } = await import('@agent-core/model');
  const provider = new SessionProvider();
  const receipts = [];
  const sent = [];
  let input = 'Exact native transformation input.';
  provider.compileContextTransform = async (request) => {
    const body = Object.freeze({ input });
    return Object.freeze({
      version: 1,
      provider: provider.id,
      model: request.request.model,
      endpoint: 'https://provider.invalid/compact',
      capabilityRevision: 'fixture',
      logicalRequest: request.request,
      body,
      accounting: Object.freeze({}),
      inputIdentity: await modelInputIdentity(body)
    });
  };
  provider.transformContextCompiled = async (transformId, request) => {
    sent.push({ transformId, request });
    return { transformId, input: [], state: {} };
  };
  provider.transformContext = () => {
    throw new Error('The compiled path must dispatch its already admitted request.');
  };
  const protectedProvider = protectProviderEgress({
    provider,
    workspace: { id: 'fixture-workspace' },
    trustLevel: 'trusted',
    policy: { onAdmitted: (receipt) => receipts.push(receipt) }
  });
  const request = {
    transformId: 'transform-1',
    request: Object.freeze({
      model: 'fixture',
      messages: Object.freeze([Object.freeze({ role: 'user', content: 'Original text.' })])
    })
  };
  const compiled = await protectedProvider.compileContextTransform(request);
  assert.equal(receipts.length, 0);
  await protectedProvider.transformContextCompiled(request.transformId, compiled);
  assert.equal(sent[0].request, compiled);
  assert.equal(sent[0].transformId, request.transformId);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].bytes, Buffer.byteLength(JSON.stringify(compiled.body)));
  input = 'password=abcdefghijk';
  await assert.rejects(
    () => protectedProvider.transformContext({ ...request, transformId: 'transform-2' }),
    /sensitive-data/u
  );
  assert.equal(sent.length, 1);
});

test(
  'coding attempts, native transformation and primary inference share one work budget',
  rootedWorkspaceTest,
  async () => {
    const { compileModelRequest, conservativeProtocolCapabilities } = await import('@agent-core/model');
    const { sourceRef } = await import('@agent-core/runtime');
    const { JsonlInferenceRepository } = await import('@agent-core/runtime/node');
    const parent = await mkdtemp(path.join(tmpdir(), 'coding-native-app-'));
    const root = path.join(parent, 'workspace');
    const stateRoot = path.join(parent, 'state');
    await mkdir(root);
    let workspace = await openCodingWorkspace(root, { stateRoot });
    await workspace.trustStore.write(
      createTrustDecision({
        workspace: workspace.layout.identity,
        level: 'trusted',
        actorKind: 'user',
        actor: 'test-owner'
      })
    );
    workspace.fileRoot.close();
    workspace = await openCodingWorkspace(root, { stateRoot });
    const provider = new SessionProvider();
    const describeModel = provider.describeModel.bind(provider);
    provider.describeModel = async () => {
      const profile = await describeModel();
      return {
        ...profile,
        capabilities: {
          ...profile.capabilities,
          protocol: conservativeProtocolCapabilities('fixture-native', {
            roles: ['system', 'developer', 'user', 'assistant'],
            contextTransforms: ['fixture-native'],
            state: 'exact'
          })
        }
      };
    };
    let transforms = 0;
    provider.compileContextTransform = async ({ request }) =>
      compileModelRequest({
        request,
        profile: await provider.describeModel(),
        endpoint: 'fixture-native',
        body: { model: request.model, input: request.messages }
      });
    provider.transformContextCompiled = async (transformId, compiled) => {
      transforms += 1;
      return {
        transformId,
        input: [
          ...compiled.logicalRequest.messages.filter((item) => item.role === 'user'),
          { role: 'assistant', content: 'Native transformed completed context.' }
        ],
        state: {
          version: 1,
          provider: provider.id,
          model: 'fixture',
          endpoint: 'fixture-native',
          kind: 'fixture-native',
          data: {},
          origin: { requestId: transformId, inputIdentity: compiled.inputIdentity },
          compatibility: {
            protocolRevision: (await provider.describeModel()).capabilities.protocol.revision,
            model: 'fixture',
            endpoint: 'fixture-native',
            requiresExactPrefix: false
          },
          replay: 'required'
        }
      };
    };
    const coding = await createCodingSession({
      workspace,
      provider,
      settings: { provider: provider.id, model: 'fixture' },
      permissionMode: 'review',
      inferenceBudget: { maxInvocations: 4 }
    });
    try {
      const first = await coding.agent.submit({
        task: 'Original requirement survives the native transform.'
      });
      assert.equal((await first.completion).state, 'ended');
      let requested = false;
      const complete = provider.complete.bind(provider);
      provider.complete = async (request) => {
        if (requested) return complete(request);
        requested = true;
        provider.requests.push(request);
        const view = await coding.history.view();
        return {
          content: '',
          provider: provider.id,
          model: 'fixture',
          terminationReason: 'tool_calls',
          toolCalls: [
            {
              id: 'native-transition-call',
              type: 'function',
              name: 'context_transition',
              input: {
                kind: 'json',
                value: {
                  expectedWindowId: view.contextWindow?.windowId ?? null,
                  idempotencyKey: 'native-transition',
                  reason: 'Use the governed native transform.',
                  selection: {
                    strategy: 'provider',
                    retained: view.entries.map((entry) => sourceRef(view.cut.sessionId, entry)),
                    notes: [],
                    omitted: []
                  }
                }
              }
            }
          ]
        };
      };
      const second = await coding.agent.submit({
        task: 'Current work remains in its original protocol form.'
      });
      const result = await second.completion;
      assert.equal(result.state, 'ended');
      const window = (await coding.history.view()).contextWindow;
      assert.equal(window?.selection.strategy, 'provider');
      assert.equal((await coding.context.inspect()).window.selection.providerState, undefined);
      assert.equal(transforms, 1);
      assert.equal(window.selection.providerState.artifact.visibility, 'protected');
      const finalRequest = provider.requests.at(-1);
      assert.ok(
        finalRequest.messages.some(
          (item) => item.role === 'assistant' && item.content === 'Native transformed completed context.'
        )
      );
      for (const original of [
        'Original requirement survives the native transform.',
        'Current work remains in its original protocol form.'
      ])
        assert.ok(
          finalRequest.messages.some((item) => item.role === 'user' && item.content.includes(original))
        );
      const repository = new JsonlInferenceRepository({
        rootDir: path.join(workspace.layout.runtimeDir, 'inference')
      });
      const work = await coding.work.forRun(second.runId);
      const owner = await repository.load(work.ownerId);
      assert.deepEqual(
        [...owner.invocations.values()].map((invocation) => invocation.start.operation),
        ['generation', 'generation', 'context_transform', 'generation']
      );
      assert.ok([...owner.invocations.values()].every((invocation) => invocation.settlement !== undefined));
      await assert.rejects(
        () =>
          coding.inference.invoke({
            invocationId: 'over-budget',
            ownerId: work.ownerId,
            purpose: 'extra',
            request: {
              model: 'fixture',
              maxOutputTokens: 100,
              messages: [{ role: 'user', content: 'Extra request.' }]
            }
          }),
        /budget.*exceed|exceed.*budget/iu
      );
    } finally {
      await closeCodingSession(coding);
      workspace.fileRoot.close();
      await rm(parent, { recursive: true, force: true });
    }
  }
);

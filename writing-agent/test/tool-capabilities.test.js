import assert from 'node:assert/strict';
import test from 'node:test';
import { openWritingApplication } from '@ismail-elkorchi/writing-agent';
import { writingRpcMethods } from '@ismail-elkorchi/writing-agent/rpc';
import { fixture, ScriptedWritingProvider, submit } from './helpers/runtime.js';

const integration = { skip: process.platform !== 'linux' };
test('review composes isolated read programs and keeps intermediate source out of model context', integration, async t => {
  const f = await fixture('private intermediate source\n');
  await f.application.close();
  const provider = new ScriptedWritingProvider([
    { content: '', terminationReason: 'tool_calls', toolCalls: [{ id: 'program-read', name: 'run_program', type: 'custom', input: { kind: 'text', value: "const result = await call('read_files', {files:[{path:'document.txt'}]}); return {files:result.observation.output.returnedFiles};" } }] },
    request => {
      assert.ok(request.tools.some(tool => (tool.type === 'function' ? tool.function.name : tool.name) === 'run_program'));
      assert.ok(!request.tools.some(tool => (tool.type === 'function' ? tool.function.name : tool.name) === 'edit_text'));
      const result = request.messages.find(item => item.role === 'tool' && item.toolName === 'run_program');
      assert.ok(result, JSON.stringify(request.messages));
      assert.doesNotMatch(result.content, /private intermediate source/u);
      assert.ok(!request.messages.some(item => item.role === 'tool' && item.toolName === 'read_files'));
      return 'Read completed without changing the file.';
    }
  ]);
  const app = await openWritingApplication({ rootDirectory:f.root, stateRoot:f.stateRoot, mode:'review',
    configuration:{provider,model:'writing-test'}, programmaticTools:{} });
  t.after(async()=>{await app.close();await f.close();});
  const completed=await submit(app,'Inspect the document through a program.');
  assert.equal(completed.terminal.executionStatus,'completed', JSON.stringify(completed));
  const context=await writingRpcMethods(app,()=>{})['context.read'].invoke({});
  assert.ok(context.operational.capabilities.items.some(tool=>tool.name==='run_program'));
});

test('web capability is explicit and inspection agrees with local-only default', integration, async t=>{
  const f=await fixture(); await f.application.close();
  const apps=[]; t.after(async()=>{for(const app of apps)await app.close();await f.close();});
  for(const enabled of [false,true]) {
    const app=await openWritingApplication({rootDirectory:f.root,stateRoot:f.stateRoot,
      configuration:{provider:new ScriptedWritingProvider(),model:'writing-test'},
      ...(enabled?{webTools:{policy:{id:'public-research',allowedOrigins:['https://example.com']}}}:{})});
    apps.push(app); await app.start();
    const context=await app.inspectContext();
    assert.equal(context.operational.capabilities.items.some(tool=>tool.name==='fetch_source'),enabled);
    await app.close();
  }
});

test('review filters write-only MCP sources before credentials or connection', integration, async t => {
  const f = await fixture(); await f.application.close();
  const app = await openWritingApplication({ rootDirectory: f.root, stateRoot: f.stateRoot, mode: 'review',
    configuration: { provider: new ScriptedWritingProvider(), model: 'writing-test' },
    mcpTools: { servers: [{ id: 'write-only', endpoint: 'https://example.invalid/mcp', accountId: 'test',
      policyRevision: '1', bearerTokenEnv: 'AGENT_TEST_MISSING_MCP_TOKEN', tools: {
        modify: { accesses: [{ mode: 'write', scope: 'remote' }], lockScopes: [] }
      } }] } });
  t.after(async () => { await app.close(); await f.close(); });
  await app.start();
  const context = await app.inspectContext();
  assert.ok(!context.operational.capabilities.items.some(tool => tool.name.includes('modify')));
});

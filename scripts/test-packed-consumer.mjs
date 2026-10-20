import { packPackages } from './pack-packages.mjs';
import { execFile } from 'node:child_process';
import { glob, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is required to verify packed consumers.');
const core = path.resolve(root, '../agent-core');
const coreManifest = JSON.parse(await readFile(path.join(core, 'package.json'), 'utf8'));
const packageDirs = [];
for await (const file of glob(
  coreManifest.workspaces.map((workspace) => `${workspace}/package.json`),
  { cwd: core }
)) {
  const manifest = JSON.parse(await readFile(path.join(core, file), 'utf8'));
  if (!manifest.private) packageDirs.push(path.dirname(file));
}
packageDirs.sort();
const temporary = await mkdtemp(path.join(tmpdir(), 'coding-agent-packed-consumer-'));
try {
  const packs = path.join(temporary, 'packs');
  const consumer = path.join(temporary, 'consumer');
  await mkdir(packs, { recursive: true });
  const dependencies = {};
  const agentsManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const directories = [
    ...packageDirs.map((relative) => path.join(core, relative)),
    path.join(root, 'node_modules/@ismail-elkorchi/terminal-ui'),
    path.join(root, 'node_modules/markspan'),
    ...agentsManifest.workspaces.map((workspace) => path.join(root, workspace))
  ];
  Object.assign(dependencies, await packPackages(directories, packs, npmCli));
  await mkdir(consumer, { recursive: true });
  await writeFile(
    path.join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'coding-agent-consumer', private: true, type: 'module', dependencies, devDependencies: { '@types/node': coreManifest.devDependencies['@types/node'] }, overrides: { '@ismail-elkorchi/terminal-ui': '$@ismail-elkorchi/terminal-ui', markspan: '$markspan' } }, null, 2)}\n`
  );
  await exec(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: consumer,
    maxBuffer: 20 * 1024 * 1024
  });

  // Exercise the packed worker URL, WASM dependency, and explicit Node adapter exports.
  await writeFile(path.join(consumer, 'optional-tools.mjs'), String.raw`
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'node:worker_threads' || /^(quickjs-emscripten|@jitl\/quickjs|acorn)/u.test(specifier))
    throw new Error('Portable program contract import initialized an isolation adapter: ' + specifier);
  return next(specifier, context);
} });
const programmatic = await import('@agent-core/tools-programmatic');
hook.deregister();
const { createQuickJSProgramRunner } = await import('@agent-core/tools-programmatic/node');
const web = await import('@agent-core/tools-web');
const nodeWeb = await import('@agent-core/tools-web/node');
const mcp = await import('@agent-core/tools-mcp');
const nodeMcp = await import('@agent-core/tools-mcp/node');
const { InMemoryArtifactRepository } = await import('@agent-core/persistence');
const { ToolCatalog } = await import('@agent-core/tools');
const limits = programmatic.parseProgramLimits({ calls: 2, concurrentPrograms: 1 });
const tool = programmatic.createProgrammaticTool({ limits });
const runner = createQuickJSProgramRunner({ limits });
assert.deepEqual(tool.invocationModes, ['direct']);
assert.equal(runner.maxConcurrentPrograms, 1);
assert.match(runner.configurationRevision, /^[a-f0-9]{64}$/u);
const result = await runner.run({ source: 'return await call("echo", {value: 7});',
  tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }],
  signal: new AbortController().signal,
  call: async (name, input) => { assert.equal(name, 'echo'); assert.deepEqual(input, { value: 7 }); return { observationId: 'packed-observation', value: input.value }; }
});
assert.deepEqual(result, { status: 'completed', value: { observationId: 'packed-observation', value: 7 } });
const artifacts = new InMemoryArtifactRepository();
const configuration = nodeWeb.parseWebConfiguration({ policy: { id: 'packed', allowedOrigins: ['https://example.com'] } });
const webTools = web.createWebTools({ policy: configuration.policy, artifacts, transport: nodeWeb.createNodeWebTransport() });
assert.ok(webTools.some(definition => definition.name === 'fetch_source' && definition.outputJsonSchema));
assert.equal(nodeWeb.createConfiguredWebTools(configuration, { artifacts, environment: {} }).length, 1);
assert.equal(typeof mcp.MCP_PROTOCOL_VERSION, 'string');
const source = new mcp.McpToolSource({ id: 'packed', binding: { endpointId: 'endpoint', accountId: 'account', policyRevision: 'policy' }, createTransport: () => undefined, tools: {}, watchChanges: false });
const catalog = new ToolCatalog({ tools: [tool, ...webTools], sources: [source] });
assert.ok(catalog.current().some(definition => definition.name === 'run_program'));
await source.close();
const http = nodeMcp.createMcpHttpTransport({ endpoint: 'https://example.invalid/mcp' });
assert.equal(typeof http.start, 'function');
await http.close();
assert.equal(typeof nodeMcp.createMcpStdioTransport, 'function');
const configured = nodeMcp.createConfiguredMcpSources(nodeMcp.parseMcpConfiguration({ servers: [] }), { artifacts, environment: {} });
assert.deepEqual(configured.sources, []);
await configured.close();
const { InMemorySkillSource, SkillCatalog } = await import('@agent-core/skills');
const skills = new SkillCatalog({ sources: [new InMemorySkillSource({ scopeId: 'packed-methods', bindingRevision: 'grant-1', packages: [
  { packageId: 'review', files: [{ path: 'SKILL.md', content: '---\nname: review\ndescription: Check source evidence.\n---\nRead original sources.' }] }
] })] });
const page = await skills.discover({ scopeId: 'packed-methods' });
assert.equal(page.items.length, 1);
assert.equal((await skills.load(page.items[0].reference)).instructions, 'Read original sources.');
`);
  await exec(process.execPath, ['optional-tools.mjs'], { cwd: consumer });
  await writeFile(path.join(consumer, 'optional-tools.ts'), String.raw`
import { createProgrammaticTool, parseProgramLimits, type ProgramLimits, type ProgrammaticToolOptions, type ProgramRunnerInput, type ProgramRunnerResult, type RuntimeProgramRunner } from '@agent-core/tools-programmatic';
import { createQuickJSProgramRunner, type QuickJSProgramRunnerOptions } from '@agent-core/tools-programmatic/node';
import { McpToolSource, type McpBinding, type McpToolPolicy, type McpToolSourceOptions, type McpLimits } from '@agent-core/tools-mcp';
import { createMcpHttpTransport, createMcpStdioTransport, parseMcpConfiguration, createConfiguredMcpSources, type McpHttpTransportOptions, type McpStdioTransportOptions, type NodeMcpConfiguration, type ConfiguredMcpSources } from '@agent-core/tools-mcp/node';
import { createWebTools, type WebConfiguration, type WebToolOptions, type WebTransport, type WebResponse } from '@agent-core/tools-web';
import { createNodeWebTransport, createConfiguredWebTools, parseWebConfiguration, type NodeWebTransportOptions } from '@agent-core/tools-web/node';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import { ToolCatalog, type ToolCatalogSource, type ToolReference, type ToolInvocationMode } from '@agent-core/tools';
import { parseNativeToolExposure, type NativeToolExposure, type AgentRuntimeOptions } from '@agent-core/runtime';
const limits: ProgramLimits = parseProgramLimits({ calls: 2, concurrentPrograms: 1 });
const programOptions: ProgrammaticToolOptions = { name: 'run_program', limits };
const runnerOptions: QuickJSProgramRunnerOptions = { toolName: programOptions.name ?? 'run_program', limits };
const runner: RuntimeProgramRunner = createQuickJSProgramRunner(runnerOptions);
const configurationRevision: string = runner.configurationRevision;
const tool = createProgrammaticTool(programOptions);
const input: ProgramRunnerInput = { source: 'return await call("echo", {});', tools: [], signal: new AbortController().signal, call: async (_name, value) => value };
const result: Promise<ProgramRunnerResult> = runner.run(input);
// @ts-expect-error isolation limits are immutable owned configuration
limits.calls = 3;
// @ts-expect-error bridge arguments must be JSON objects
input.call('echo', []);
const mode: ToolInvocationMode = 'programmatic';
// @ts-expect-error recursive program mode does not exist
const recursive: ToolInvocationMode = 'recursive';
const reference: ToolReference = { sourceId: 'source', toolId: 'echo', revision: 'definition', bindingRevision: 'authority' };
const binding: McpBinding = { endpointId: 'endpoint', accountId: 'account', policyRevision: 'policy' };
const mcpLimits: Partial<McpLimits> = { maxPages: 2, maxResultBytes: 1024 };
const policy: McpToolPolicy = { effectEnvelope: { accesses: [{ mode: 'read', scope: 'memory' }], lockScopes: [] }, invocationModes: ['direct', mode], deriveEffects: () => ({ accesses: [{ mode: 'read', scope: 'memory' }], lockScopes: [] }) };
const sourceOptions: McpToolSourceOptions = { id: 'source', binding, createTransport: () => undefined, tools: { echo: policy }, limits: mcpLimits, watchChanges: false };
const source: ToolCatalogSource = new McpToolSource(sourceOptions);
const catalog = new ToolCatalog({ tools: [tool], sources: [source] });
const httpOptions: McpHttpTransportOptions = { endpoint: 'https://example.invalid/mcp', limits: mcpLimits, headers: () => ({ 'x-client': 'packed' }) };
const stdioOptions: McpStdioTransportOptions = { command: 'mcp-server', args: [], cwd: '/tmp', env: {}, limits: mcpLimits };
const http = createMcpHttpTransport(httpOptions);
const stdio = createMcpStdioTransport(stdioOptions);
const mcpConfiguration: NodeMcpConfiguration = parseMcpConfiguration({ servers: [] });
const configuredMcp: ConfiguredMcpSources = createConfiguredMcpSources(mcpConfiguration, { environment: {}, allowedRisks: ['read', 'network'] });
const artifacts = new InMemoryArtifactRepository();
const response: WebResponse = { status: 200, headers: { 'content-type': 'text/plain' }, body: new Uint8Array(), transferredBytes: 0 };
const transport: WebTransport = { id: 'packed', get: async () => response };
const webConfiguration: WebConfiguration = parseWebConfiguration({ policy: { id: 'packed', allowedOrigins: ['https://example.com'], limits: { maxResponseBytes: 1024 } } });
const webOptions: WebToolOptions = { policy: webConfiguration.policy, transport, artifacts };
const webTools = createWebTools(webOptions);
const nodeWebOptions: NodeWebTransportOptions = { id: 'packed-node', resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }] };
const nodeTransport: WebTransport = createNodeWebTransport(nodeWebOptions);
const configuredWeb = createConfiguredWebTools(webConfiguration, { artifacts, environment: {} });
const native: NativeToolExposure = parseNativeToolExposure({ discovery: true });
const runtimeOptions: Pick<AgentRuntimeOptions, 'programRunner' | 'nativeToolExposure'> = { programRunner: runner, nativeToolExposure: native };
// @ts-expect-error Node isolation host is only available through the explicit adapter export
import { createQuickJSProgramRunner as wrongRunner } from '@agent-core/tools-programmatic';
// @ts-expect-error Node network transport is only available through the explicit adapter export
import { createNodeWebTransport as wrongWeb } from '@agent-core/tools-web';
// @ts-expect-error Node MCP transport is only available through the explicit adapter export
import { createMcpHttpTransport as wrongMcp } from '@agent-core/tools-mcp';
void [result, configurationRevision, recursive, reference, catalog, http, stdio, configuredMcp, webTools, nodeTransport, configuredWeb, runtimeOptions];

import type { CodingApplicationOptions, CodingSessionOptions } from '@ismail-elkorchi/coding-agent';
import type { WritingApplicationOptions, WritingConfiguration } from '@ismail-elkorchi/writing-agent';
type OptionalToolKeys = 'programmaticTools' | 'nativeToolExposure' | 'webTools' | 'mcpTools';
const codingApplication: Pick<CodingApplicationOptions, OptionalToolKeys> = { programmaticTools: limits, nativeToolExposure: native, webTools: webConfiguration, mcpTools: mcpConfiguration };
const codingSession: Pick<CodingSessionOptions, OptionalToolKeys> = codingApplication;
const writingApplication: Pick<WritingApplicationOptions, OptionalToolKeys> = codingApplication;
const writingConfiguration: Pick<WritingConfiguration, OptionalToolKeys> = writingApplication;
void [codingSession, writingConfiguration];

import { InMemoryMaterialRepository, InMemoryMaterialGrantProvider, HostWakeService, InMemoryIntentionRepository, type HostWakeSession, type ContextServiceOptions } from '@agent-core/runtime';
import { InMemorySkillSource, SkillCatalog } from '@agent-core/skills';
import type { CodingApplication } from '@ismail-elkorchi/coding-agent';
import type { WritingApplication } from '@ismail-elkorchi/writing-agent';
const materials: ContextServiceOptions['materials'] = { repository: new InMemoryMaterialRepository(), artifacts,
  grants: new InMemoryMaterialGrantProvider([{ owner: { kind: 'scope', scopeId: 'person:opaque-id' }, revision: 'grant-1', read: true, write: true }]) };
const skills = new SkillCatalog({ sources: [new InMemorySkillSource({ scopeId: 'methods', bindingRevision: 'grant-1', packages: [] })] });
const codingMemory: Pick<CodingApplicationOptions, 'materials' | 'skills'> = { materials, skills };
const writingMemory: Pick<WritingApplicationOptions, 'materials' | 'skills'> = codingMemory;
declare const codingHost: CodingApplication;
declare const writingHost: WritingApplication;
const codingWake: HostWakeSession = codingHost.hostWakeSession('session');
const writingWake: HostWakeSession = writingHost.hostWakeSession('session');
const hostWakes = new HostWakeService({ repository: new InMemoryIntentionRepository(),
  resolveSession: async id => writingHost.hostWakeSession(id), adapter: {
    now: () => new Date().toISOString(), evaluate: async () => undefined,
    withAdmission: async (_intention, _trigger, operation) => operation()
  }
});
void [codingWake, writingWake, hostWakes, writingMemory];
`);
  await writeFile(
    path.join(consumer, 'index.mjs'),
    [
      "import {registerHooks} from 'node:module';",
      "const hook = registerHooks({resolve(specifier, context, next) {const resolved = next(specifier, context); if (/\\/(coding-agent|writing-agent)\\/dist\\/(cli\\.js|tui\\/|rpc\\/)/u.test(resolved.url) || resolved.url.includes('/terminal-ui/')) throw new Error('Headless package loaded an adapter: ' + resolved.url); return resolved;}});",
      "const coding = await import('@ismail-elkorchi/coding-agent');",
      "const writing = await import('@ismail-elkorchi/writing-agent');",
      'hook.deregister();',
      "const tui = await import('@ismail-elkorchi/coding-agent/tui');",
      "const writingTui = await import('@ismail-elkorchi/writing-agent/tui');",
      "const codingRpc = await import('@ismail-elkorchi/coding-agent/rpc');",
      "const writingRpc = await import('@ismail-elkorchi/writing-agent/rpc');",
      "if (!coding.openCodingApplication || !tui.createCodingAgentTuiApp || !codingRpc.runCodingRpc) throw new Error('Coding application exports are incomplete');",
      "if (!writing.openWritingApplication || !writingTui.createWritingAgentTuiApp || !writingRpc.runWritingRpc) throw new Error('Writing application exports are incomplete');",
      "for (const name of ['rpc', 'tui']) { await import('@agent-core/' + name); await import('@agent-core/' + name + '/node'); }"
    ].join('\n')
  );
  await exec(process.execPath, ['index.mjs'], { cwd: consumer });
  await writeFile(
    path.join(consumer, 'ownership.ts'),
    [
      "import type { WritingDocument, WritingMode } from '@ismail-elkorchi/writing-agent';",
      "import type { RunChangeReport } from '@ismail-elkorchi/coding-agent';",
      'declare const changes: RunChangeReport;',
      'changes.mutationReceipts;',
      'declare const document: WritingDocument;',
      '// @ts-expect-error admitted documents are readonly',
      "document.content = 'changed';",
      '// @ts-expect-error modes cannot grant arbitrary capabilities',
      "const mode: WritingMode = 'unrestricted';"
    ].join('\n')
  );
  for (const exactOptionalPropertyTypes of [true, false]) {
    const config = `tsconfig-${String(exactOptionalPropertyTypes)}.json`;
    await writeFile(
      path.join(consumer, config),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          types: ['node'],
          strict: true,
          skipLibCheck: false,
          exactOptionalPropertyTypes,
          noEmit: true
        },
        files: ['ownership.ts', 'optional-tools.ts']
      })
    );
    await exec(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', config], {
      cwd: consumer,
      maxBuffer: 20 * 1024 * 1024
    });
  }
  for (const agent of ['coding-agent', 'writing-agent']) {
    const binary = path.join(consumer, 'node_modules/@ismail-elkorchi', agent, 'dist/cli.js');
    const { stdout } = await exec(process.execPath, [binary, '--help'], { cwd: consumer });
    if (!stdout.includes('rpc')) throw new Error(`${agent} help omits its stdio entry point.`);
  }
  console.log('Packed agent consumers passed.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}

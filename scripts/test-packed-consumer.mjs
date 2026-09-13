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
    path.resolve(root, '../sandbox/packages/sandbox'),
    ...agentsManifest.workspaces.map((workspace) => path.join(root, workspace))
  ];
  for (const directory of directories) {
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const { stdout } = await exec(
      process.execPath,
      [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', packs],
      { cwd: directory, maxBuffer: 10 * 1024 * 1024 }
    );
    const packed = JSON.parse(stdout)[0];
    if (!packed.files.some((file) => file.path.startsWith('dist/')))
      throw new Error(`${manifest.name} archive has no compiled output.`);
    if (
      manifest.name === '@ismail-elkorchi/coding-agent' ||
      manifest.name === '@ismail-elkorchi/writing-agent'
    ) {
      for (const entry of ['index.js', 'cli.js', 'tui/index.js', 'rpc/index.js'])
        if (!packed.files.some((file) => file.path === `dist/${entry}`))
          throw new Error(`${manifest.name} archive is missing ${entry}.`);
    }
    dependencies[manifest.name] = `file:${path.join(packs, packed.filename)}`;
  }
  await mkdir(consumer, { recursive: true });
  await writeFile(
    path.join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'coding-agent-consumer', private: true, type: 'module', dependencies, devDependencies: { '@types/node': coreManifest.devDependencies['@types/node'] }, overrides: { '@ismail-elkorchi/terminal-ui': '$@ismail-elkorchi/terminal-ui', markspan: '$markspan' } }, null, 2)}\n`
  );
  await exec(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: consumer,
    maxBuffer: 20 * 1024 * 1024
  });
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
        files: ['ownership.ts']
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

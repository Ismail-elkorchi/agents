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
for await (const file of glob(coreManifest.workspaces.map((workspace) => `${workspace}/package.json`), { cwd: core })) {
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
  for (const relative of packageDirs) {
    const directory = path.join(core, relative);
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const { stdout } = await exec(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', packs], { cwd: directory, maxBuffer: 10 * 1024 * 1024 });
    const packed = JSON.parse(stdout)[0];
    if (!packed.files.some((file) => file.path.startsWith('dist/'))) throw new Error(`${manifest.name} is missing compiled output.`);
    dependencies[manifest.name] = `file:${path.join(packs, packed.filename)}`;
  }
  const terminalUiDirectory = path.join(root, 'node_modules', '@ismail-elkorchi', 'terminal-ui');
  const terminalUiManifest = JSON.parse(await readFile(path.join(terminalUiDirectory, 'package.json'), 'utf8'));
  const { stdout: terminalUiOutput } = await exec(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', packs], { cwd: terminalUiDirectory, maxBuffer: 10 * 1024 * 1024 });
  const terminalUiPack = JSON.parse(terminalUiOutput)[0];
  if (!terminalUiPack.files.some((file) => file.path.startsWith('dist/host/'))) throw new Error('Terminal UI archive is incomplete.');
  dependencies[terminalUiManifest.name] = `file:${path.join(packs, terminalUiPack.filename)}`;
  const sandboxDirectory = path.resolve(root, '../sandbox/packages/sandbox');
  const sandboxManifest = JSON.parse(await readFile(path.join(sandboxDirectory, 'package.json'), 'utf8'));
  const { stdout: sandboxOutput } = await exec(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', packs], { cwd: sandboxDirectory, maxBuffer: 10 * 1024 * 1024 });
  const sandboxPack = JSON.parse(sandboxOutput)[0];
  if (!sandboxPack.files.some((file) => file.path.startsWith('dist/'))) throw new Error('Sandbox archive is incomplete.');
  dependencies[sandboxManifest.name] = `file:${path.join(packs, sandboxPack.filename)}`;
  const codingDirectory = path.join(root, 'coding-agent');
  const codingManifest = JSON.parse(await readFile(path.join(codingDirectory, 'package.json'), 'utf8'));
  const { stdout } = await exec(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', packs], { cwd: codingDirectory, maxBuffer: 10 * 1024 * 1024 });
  const codingPack = JSON.parse(stdout)[0];
  if (!codingPack.files.some((file) => file.path === 'dist/index.js') || !codingPack.files.some((file) => file.path === 'dist/tui/index.js')) throw new Error('Coding agent archive is incomplete.');
  dependencies[codingManifest.name] = `file:${path.join(packs, codingPack.filename)}`;
  const writingDirectory = path.join(root, 'writing-agent');
  const writingManifest = JSON.parse(await readFile(path.join(writingDirectory, 'package.json'), 'utf8'));
  const { stdout: writingOutput } = await exec(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', packs], { cwd: writingDirectory, maxBuffer: 10 * 1024 * 1024 });
  const writingPack = JSON.parse(writingOutput)[0];
  if (!writingPack.files.some((file) => file.path === 'dist/index.js')) throw new Error('Writing agent archive is incomplete.');
  dependencies[writingManifest.name] = `file:${path.join(packs, writingPack.filename)}`;
  await mkdir(consumer, { recursive: true });
  await writeFile(path.join(consumer, 'package.json'), `${JSON.stringify({ name: 'coding-agent-consumer', private: true, type: 'module', dependencies, devDependencies: { '@types/node': coreManifest.devDependencies['@types/node'] }, overrides: { '@ismail-elkorchi/terminal-ui': '$@ismail-elkorchi/terminal-ui' } }, null, 2)}\n`);
  await exec(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumer, maxBuffer: 20 * 1024 * 1024 });
  await writeFile(path.join(consumer, 'index.mjs'), ["import * as coding from '@ismail-elkorchi/coding-agent';", "import * as tui from '@ismail-elkorchi/coding-agent/tui';", "import * as writing from '@ismail-elkorchi/writing-agent';", "if (!coding.resolveCodingAuthority || !coding.loadCodingAgentConfiguration || !coding.createCodingSession || !tui.createCodingAgentTuiApp) throw new Error('Coding-agent public exports are incomplete');", "if (!writing.createWritingProject || !writing.admitWritingOperation || !writing.runTransientWriting) throw new Error('Writing-agent public exports are incomplete');"].join('\n'));
  await exec(process.execPath, ['index.mjs'], { cwd: consumer });
  await writeFile(path.join(consumer, 'ownership.ts'), [
    "import { textRangeSchema, type StructuralChange, type WritingOperation } from '@ismail-elkorchi/writing-agent';",
    'declare const range: ReturnType<typeof textRangeSchema.parse>;',
    'declare const change: StructuralChange;',
    'declare const operation: WritingOperation;',
    '// @ts-expect-error admitted nested positions are readonly',
    'range.start.line = 2;',
    '// @ts-expect-error admitted intent collections are readonly',
    "change.intentIds.push('new');",
    '// @ts-expect-error admitted JSON metadata is readonly',
    'change.value.extra = true;',
    '// @ts-expect-error admitted operation targets are readonly',
    "operation.targetNodeIds.push('new');"
  ].join('\n'));
  for (const exactOptionalPropertyTypes of [true, false]) {
    const config = `tsconfig-${String(exactOptionalPropertyTypes)}.json`;
    await writeFile(path.join(consumer, config), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', types: ['node'], strict: true, skipLibCheck: false, exactOptionalPropertyTypes, noEmit: true },
      files: ['ownership.ts']
    }));
    await exec(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', config], { cwd: consumer, maxBuffer: 20 * 1024 * 1024 });
  }
  console.log('Packed agent consumers passed.');
} finally { await rm(temporary, { recursive: true, force: true }); }

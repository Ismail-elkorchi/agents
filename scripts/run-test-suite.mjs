import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const linuxRootCapabilityTests = new Set(
  [
    'coding-agent/test/project.test.js',
    'coding-agent/test/resilience.test.js',
    'coding-agent/test/sandbox-command-execution.test.js',
    'coding-agent/test/tool-composition.test.js',
    'writing-agent/test/application.test.js',
    'writing-agent/test/rpc.test.js',
    'writing-agent/test/tui.test.js',
    'writing-agent/test/writing-agent.test.js'
  ].map((value) => path.join(root, value))
);
const { workspaces } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const directories = workspaces.map((workspace) => path.join(root, workspace, 'test'));
const discovered = (
  await Promise.all(
    directories.map(async (directory) =>
      (await readdir(directory))
        .filter((file) => file.endsWith('.test.js'))
        .sort()
        .map((file) => path.join(directory, file))
    )
  )
).flat();
const files =
  process.platform === 'linux'
    ? discovered
    : discovered.filter((file) => !linuxRootCapabilityTests.has(file));
if (files.length === 0) throw new Error('No agent tests were discovered.');
const child = spawn(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
const code = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (value, signal) =>
    signal ? reject(new Error(`Test process ended with ${signal}.`)) : resolve(value ?? 1)
  );
});
if (code !== 0) process.exitCode = code;

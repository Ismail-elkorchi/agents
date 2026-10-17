import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);

// One archive contract shared by release consumer checks and evaluator preparation.
export async function packPackages(directories, packs, npmCli, env = process.env) {
  const dependencies = {};
  for (const directory of directories) {
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const { stdout } = await exec(
      process.execPath,
      [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', packs],
      { cwd: directory, env, maxBuffer: 10 * 1024 * 1024 }
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
  return dependencies;
}

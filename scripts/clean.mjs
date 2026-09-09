import { readFile, rm } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const { workspaces } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
await Promise.all(
  workspaces.flatMap((workspace) => [
    rm(new URL(`${workspace}/dist`, root), { recursive: true, force: true }),
    rm(new URL(`${workspace}/tsconfig.tsbuildinfo`, root), { force: true })
  ])
);

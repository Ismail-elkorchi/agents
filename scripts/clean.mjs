import { rm } from 'node:fs/promises';
await Promise.all([
  rm(new URL('../coding-agent/dist', import.meta.url), { recursive: true, force: true }),
  rm(new URL('../coding-agent/tsconfig.tsbuildinfo', import.meta.url), { force: true }),
  rm(new URL('../writing-agent/dist', import.meta.url), { recursive: true, force: true }),
  rm(new URL('../writing-agent/tsconfig.tsbuildinfo', import.meta.url), { force: true })
]);

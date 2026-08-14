import { chmod } from 'node:fs/promises';
if (process.platform !== 'win32') await Promise.all([
  chmod(new URL('../coding-agent/dist/index.js', import.meta.url), 0o755),
  chmod(new URL('../writing-agent/dist/index.js', import.meta.url), 0o755)
]);

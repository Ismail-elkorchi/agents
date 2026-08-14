import { chmod } from 'node:fs/promises';
if (process.platform !== 'win32') await chmod(new URL('../coding-agent/dist/index.js', import.meta.url), 0o755);

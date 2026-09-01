#!/usr/bin/env node
export * from './brief.js';
export * from './context.js';
export * from './domain.js';
export * from './evaluation.js';
export * from './operations.js';
export * from './operation-contract.js';
export * from './private-state.js';
export * from './project-store.js';
export * from './project.js';
export * from './proposal-tool.js';
export * from './provider.js';
export * from './quality.js';
export * from './revisions.js';
export * from './runtime.js';
export * from './semantic-checker.js';
export * from './sources.js';
export * from './text-ranges.js';
export * from './voice.js';
export { main } from './cli.js';

import { isDirectRun, main } from './cli.js';

if (isDirectRun(import.meta.url)) main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

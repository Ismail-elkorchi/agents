#!/usr/bin/env node
import { main } from '../../dist/cli.js';
import { createTestCodingEnvironment } from './test-environment.js';

main(process.argv.slice(2), { environmentFactory: createTestCodingEnvironment }).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

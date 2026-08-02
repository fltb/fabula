#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..'); // packages/workbench
const repoRoot = resolve(root, '../..'); // monorepo root

const envFile = process.env.WORKBENCH_ENV_FILE;
if (envFile) {
  dotenv.config({ path: envFile });
} else {
  // cwd wins over the monorepo root; shell variables always win over dotenv.
  dotenv.config({ path: [resolve(process.cwd(), '.env'), resolve(repoRoot, '.env')] });
}

const mode = process.argv[2];
if (mode !== 'workbench' && mode !== 'listener') {
  console.error('Usage: node scripts/start.mjs <workbench|listener>');
  process.exit(2);
}
const env = { ...process.env, WORKBENCH_MODE: mode, WORKBENCH_DEV: 'false' };
const child = spawn(process.execPath, ['dist/host/host/main.js'], { env, stdio: 'inherit' });
const shutdown = (signal) => child.kill(signal);
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

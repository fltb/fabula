#!/usr/bin/env node
// Workbench production start: resolves the environment file once, in priority
// order — WORKBENCH_ENV_FILE, then the working-directory .env, then the
// monorepo-root .env — and spawns the built Host entry. dotenv never
// overrides variables already present in the shell, so shell values always
// win. No env file is required: an unconfigured Host starts a loopback-only
// setup runtime with packaged assets; dotenv only ever pre-fills initial
// setup or imports when WORKBENCH_CONFIG_IMPORT=1 (enforced by the Host
// configuration service, not by this launcher).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..'); // packages/workbench
const repoRoot = resolve(root, '../..'); // monorepo root

// Priority: WORKBENCH_ENV_FILE (exclusive when set) → cwd/.env → repo-root
// .env. Later files never override earlier ones (dotenv first-wins within the
// array) and missing files are skipped, so production does not require an env
// file.
const envFile = process.env.WORKBENCH_ENV_FILE;
if (envFile) {
  if (existsSync(envFile)) {
    dotenv.config({ path: envFile });
  } else {
    console.warn(`[workbench] WORKBENCH_ENV_FILE not found; ignoring: ${envFile}`);
  }
} else {
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

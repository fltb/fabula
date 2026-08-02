#!/usr/bin/env node
import { spawn } from 'node:child_process';
import dotenv from 'dotenv';

dotenv.config({ path: process.env.WORKBENCH_ENV_FILE });

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

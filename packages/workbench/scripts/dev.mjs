#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: process.env.WORKBENCH_ENV_FILE });
const root = resolve(new URL('.', import.meta.url).pathname, '..');
const projectRoot = process.env.WORKBENCH_PROJECT_ROOT;
if (!projectRoot) {
  console.error('Set WORKBENCH_PROJECT_ROOT to a fixture/project directory containing nova.yaml.');
  process.exit(2);
}
const databasePath =
  process.env.WORKBENCH_DATABASE_PATH ?? resolve(process.cwd(), '.nova/workbench.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });
const env = {
  ...process.env,
  WORKBENCH_MODE: 'workbench',
  WORKBENCH_DEV: 'true',
  WORKBENCH_PROJECT_ROOT: projectRoot,
  WORKBENCH_PROVIDER: process.env.WORKBENCH_PROVIDER ?? 'mock',
  WORKBENCH_ALLOW_MOCK_PROVIDER: process.env.WORKBENCH_ALLOW_MOCK_PROVIDER ?? 'true',
  WORKBENCH_DATABASE_PATH: databasePath,
  WORKBENCH_ALLOWED_ORIGINS: process.env.WORKBENCH_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173',
  WORKBENCH_ALLOWED_HOSTS: process.env.WORKBENCH_ALLOWED_HOSTS ?? '127.0.0.1',
};

const built = spawnSync('npm', ['run', 'build:host'], { cwd: root, env, stdio: 'inherit' });
if (built.status !== 0) process.exit(built.status ?? 1);
const host = spawn('node', ['dist/host/host/main.js'], { cwd: root, env, stdio: 'inherit' });
const vite = spawn('npx', ['vite', '--config', 'vite.config.ts'], {
  cwd: root,
  env,
  stdio: 'inherit',
});
let shuttingDown = false;
const close = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  host.kill('SIGTERM');
  vite.kill('SIGTERM');
  setTimeout(() => process.exit(code), 250);
};
host.on('exit', (code) => {
  if (!shuttingDown && code !== 0) close(code ?? 1);
});
vite.on('exit', (code) => {
  if (!shuttingDown && code !== 0) close(code ?? 1);
});
process.on('SIGINT', () => close());
process.on('SIGTERM', () => close());

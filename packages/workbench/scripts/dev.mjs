#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

// Empty values in .env count as unset so a copied template cannot break dev.
const unset = (value) => value === undefined || value.trim() === '';
const rawProjectRoot = process.env.WORKBENCH_PROJECT_ROOT;
const explicitProjectRoot = !unset(rawProjectRoot);
const projectRoot = explicitProjectRoot
  ? resolve(rawProjectRoot)
  : resolve(repoRoot, 'fixtures/zhu-fu');
if (!existsSync(join(projectRoot, 'nova.yaml'))) {
  console.error(
    explicitProjectRoot
      ? `WORKBENCH_PROJECT_ROOT has no nova.yaml: ${projectRoot}`
      : 'No WORKBENCH_PROJECT_ROOT and the demo fixtures/zhu-fu project is unavailable. Set WORKBENCH_PROJECT_ROOT to a project directory containing nova.yaml.',
  );
  process.exit(2);
}
if (!explicitProjectRoot) {
  console.warn(
    `[workbench dev] WORKBENCH_PROJECT_ROOT unset; using demo project ${projectRoot}. Set WORKBENCH_PROJECT_ROOT to override.`,
  );
}

const databasePath = unset(process.env.WORKBENCH_DATABASE_PATH)
  ? resolve(process.cwd(), '.nova/workbench.sqlite')
  : resolve(process.env.WORKBENCH_DATABASE_PATH);
mkdirSync(dirname(databasePath), { recursive: true });

const pick = (value, fallback) => (unset(value) ? fallback : value);
const env = {
  ...process.env,
  WORKBENCH_MODE: 'workbench',
  WORKBENCH_DEV: 'true',
  WORKBENCH_PROJECT_ROOT: projectRoot,
  WORKBENCH_PROVIDER: pick(process.env.WORKBENCH_PROVIDER, 'mock'),
  WORKBENCH_ALLOW_MOCK_PROVIDER: pick(process.env.WORKBENCH_ALLOW_MOCK_PROVIDER, 'true'),
  WORKBENCH_ALLOW_BOOTSTRAP: pick(process.env.WORKBENCH_ALLOW_BOOTSTRAP, 'true'),
  WORKBENCH_DATABASE_PATH: databasePath,
  WORKBENCH_ALLOWED_ORIGINS: pick(process.env.WORKBENCH_ALLOWED_ORIGINS, 'http://127.0.0.1:5173'),
  WORKBENCH_ALLOWED_HOSTS: pick(process.env.WORKBENCH_ALLOWED_HOSTS, '127.0.0.1'),
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

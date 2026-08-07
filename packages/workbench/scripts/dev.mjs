#!/usr/bin/env node
// Workbench development start: resolves the environment file once, in
// priority order — WORKBENCH_ENV_FILE, then the working-directory .env, then
// the monorepo-root .env — and keeps fixture/mock/loopback bootstrap
// defaults whenever the corresponding variable is unset. dotenv never
// overrides variables already present in the shell, so shell values always
// win. Configuration thereafter belongs to the Host configuration service,
// not to this launcher.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, fstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..'); // packages/workbench
const repoRoot = resolve(root, '../..'); // monorepo root

// Priority: WORKBENCH_ENV_FILE (exclusive when set) → cwd/.env → repo-root
// .env. Later files never override earlier ones (dotenv first-wins within the
// array) and missing files are skipped.
const envFile = process.env.WORKBENCH_ENV_FILE;
if (envFile) {
  if (existsSync(envFile)) {
    dotenv.config({ path: envFile });
  } else {
    console.warn(`[workbench dev] WORKBENCH_ENV_FILE not found; ignoring: ${envFile}`);
  }
} else {
  dotenv.config({ path: [resolve(process.cwd(), '.env'), resolve(repoRoot, '.env')] });
}

// Empty values in .env count as unset so a copied template cannot break dev.
const unset = (value) => value === undefined || value.trim() === '';
const rawProjectRoot = process.env.WORKBENCH_PROJECT_ROOT;
const explicitProjectRoot = !unset(rawProjectRoot);
let copiedDemoRoot;
const projectRoot = explicitProjectRoot
  ? resolve(rawProjectRoot)
  : (() => {
      const source = resolve(repoRoot, 'fixtures/zhu-fu');
      const workspace = mkdtempSync(join(tmpdir(), 'fabula-workbench-dev-'));
      const destination = join(workspace, 'zhu-fu');
      cpSync(source, destination, { recursive: true });
      copiedDemoRoot = workspace;
      return destination;
    })();
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
    `[workbench dev] WORKBENCH_PROJECT_ROOT unset; copied demo project to ${projectRoot}. Set WORKBENCH_PROJECT_ROOT to override.`,
  );
}

const databasePath = unset(process.env.WORKBENCH_DATABASE_PATH)
  ? resolve(process.cwd(), '.nova/workbench.sqlite')
  : resolve(process.env.WORKBENCH_DATABASE_PATH);
mkdirSync(dirname(databasePath), { recursive: true });

const pick = (value, fallback) => (unset(value) ? fallback : value);
const vitePort = pick(process.env.WORKBENCH_VITE_PORT, '5173');
const env = {
  ...process.env,
  WORKBENCH_MODE: 'workbench',
  WORKBENCH_DEV: 'true',
  WORKBENCH_PROJECT_ROOT: projectRoot,
  WORKBENCH_PROVIDER: pick(process.env.WORKBENCH_PROVIDER, 'mock'),
  WORKBENCH_ALLOW_MOCK_PROVIDER: pick(process.env.WORKBENCH_ALLOW_MOCK_PROVIDER, 'true'),
  WORKBENCH_ALLOW_BOOTSTRAP: pick(process.env.WORKBENCH_ALLOW_BOOTSTRAP, 'true'),
  WORKBENCH_DATABASE_PATH: databasePath,
  WORKBENCH_VITE_PORT: vitePort,
  WORKBENCH_ALLOWED_ORIGINS: pick(
    process.env.WORKBENCH_ALLOWED_ORIGINS,
    `http://127.0.0.1:${vitePort}`,
  ),
  WORKBENCH_ALLOWED_HOSTS: pick(process.env.WORKBENCH_ALLOWED_HOSTS, '127.0.0.1'),
};

const built = spawnSync('npm', ['run', 'build:host'], { cwd: root, env, stdio: 'inherit' });
if (built.status !== 0) process.exit(built.status ?? 1);
const inheritedControlFd3 = (() => {
  try {
    fstatSync(3);
    return true;
  } catch {
    return false;
  }
})();
const hostEnv = {
  ...env,
  WORKBENCH_CONTROL_FD3: inheritedControlFd3 ? '3' : 'disabled',
};
const host = spawn(process.execPath, ['dist/host/host/main.js'], {
  cwd: root,
  env: hostEnv,
  stdio: ['inherit', 'inherit', 'inherit', inheritedControlFd3 ? 'inherit' : 'ignore'],
});
const vite = spawn('npx', ['vite', '--config', 'vite.config.ts'], {
  cwd: root,
  env,
  stdio: 'inherit',
});
let shuttingDown = false;
let hostExited = false;
let viteExited = false;
let shutdownCode = 0;
let shutdownDeadline;
const finish = () => {
  if (shutdownDeadline !== undefined) clearTimeout(shutdownDeadline);
  if (copiedDemoRoot !== undefined) rmSync(copiedDemoRoot, { recursive: true, force: true });
  process.exit(shutdownCode);
};
const close = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdownCode = code;
  host.kill('SIGTERM');
  vite.kill('SIGTERM');
  // Host persistence shutdown is bounded at five seconds; leave the project
  // copy available until both children exit, then use a small final fallback.
  shutdownDeadline = setTimeout(finish, 5_500);
};
host.on('exit', (code) => {
  hostExited = true;
  if (!shuttingDown) close(code ?? 1);
  else if (viteExited) finish();
});
vite.on('exit', (code) => {
  viteExited = true;
  if (!shuttingDown) close(code ?? 1);
  else if (hostExited) finish();
});
process.on('SIGINT', () => close());
process.on('SIGTERM', () => close());

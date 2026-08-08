#!/usr/bin/env node
// Workbench development start: resolves the environment file once, in
// priority order — WORKBENCH_ENV_FILE, then the working-directory .env, then
// the monorepo-root .env — and keeps fixture/mock/loopback bootstrap
// defaults whenever the corresponding variable is unset. dotenv never
// overrides variables already present in the shell, so shell values always
// win. Configuration thereafter belongs to the Host configuration service,
// not to this launcher.
//
// Author Mode: all project roots are Host-managed under one home. Dev pins a
// concrete repo-local home (`.nova/workbench/`, gitignored) so every
// development run writes to a deterministic path — projects/,
// config/workbench.yaml, reference-jobs/ and the SQLite — regardless of
// working directory. Override with WORKBENCH_HOME to point elsewhere.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, fstatSync, mkdirSync } from 'node:fs';
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
const workbenchHome = unset(process.env.WORKBENCH_HOME)
  ? resolve(repoRoot, '.nova/workbench')
  : resolve(process.env.WORKBENCH_HOME);
mkdirSync(workbenchHome, { recursive: true });

if (!unset(process.env.WORKBENCH_PROJECT_ROOT)) {
  console.warn(
    '[workbench dev] WORKBENCH_PROJECT_ROOT is ignored: project roots are managed as $WORKBENCH_HOME/projects/<id>. Use the setup wizard or project import instead.',
  );
}

const databasePath = unset(process.env.WORKBENCH_DATABASE_PATH)
  ? join(workbenchHome, 'workbench.sqlite')
  : resolve(process.env.WORKBENCH_DATABASE_PATH);
mkdirSync(dirname(databasePath), { recursive: true });

const pick = (value, fallback) => (unset(value) ? fallback : value);
const vitePort = pick(process.env.WORKBENCH_VITE_PORT, '5173');
const env = {
  ...process.env,
  WORKBENCH_MODE: 'workbench',
  WORKBENCH_DEV: 'true',
  WORKBENCH_HOME: workbenchHome,
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
console.log(`[workbench dev] managed home: ${workbenchHome}`);

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
  // An explicit WORKBENCH_CONTROL_FD3 wins (shell values always win); the
  // default mirrors the launcher's own detection so supervised runs keep the
  // control channel while plain terminals (no fd3) disable it.
  WORKBENCH_CONTROL_FD3: pick(
    process.env.WORKBENCH_CONTROL_FD3,
    inheritedControlFd3 ? '3' : 'disabled',
  ),
};
let hostStartedByRestart = false;
const startHost = () => {
  const child = spawn(process.execPath, ['dist/host/host/main.js'], {
    cwd: root,
    env: hostEnv,
    stdio: ['inherit', 'inherit', 'inherit', inheritedControlFd3 ? 'inherit' : 'ignore'],
  });
  child.on('exit', (code, signal) => {
    if (restartPending) {
      restartPending = false;
      console.log('[workbench dev] host restarted');
      host = startHost();
      hostStartedByRestart = true;
      return;
    }
    hostExited = true;
    const detail = `code=${code ?? 'null'} signal=${signal ?? 'none'}`;
    if (!shuttingDown && hostStartedByRestart) {
      // Restarted host crashed at boot: keep the watcher and the dev session
      // alive (nodemon/tsx behavior) — never tear the whole tree down.
      hostStartedByRestart = false;
      console.error(
        `[workbench dev] restarted host exited (${detail}); keeping watcher alive — fix the error and save again to retry`,
      );
      return;
    }
    if (!shuttingDown) console.error(`[workbench dev] host exited (${detail})`);
    if (!shuttingDown) close(code ?? 1);
    else if (viteExited) finish();
  });
  return child;
};
let host = startHost();
const restartHost = () => {
  if (restartPending) return;
  restartPending = true;
  if (host.exitCode !== null || host.signalCode !== null) {
    // The previous host already crashed: its exit event was consumed, so
    // spawn a fresh one directly instead of waiting for a kill that never
    // fires an exit.
    restartPending = false;
    console.log('[workbench dev] host already exited — starting fresh host');
    host = startHost();
    hostStartedByRestart = true;
    return;
  }
  host.kill('SIGTERM');
};
const vite = spawn('npx', ['vite', '--config', 'vite.config.ts'], {
  cwd: root,
  env,
  stdio: 'inherit',
});
const watcher = spawn(process.execPath, ['build.host.mjs', '--watch'], {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'inherit'],
});
let watchBuffer = '';
watcher.stdout.on('data', (chunk) => {
  watchBuffer += chunk.toString();
  let newline = watchBuffer.indexOf('\n');
  while (newline !== -1) {
    const line = watchBuffer.slice(0, newline).trim();
    watchBuffer = watchBuffer.slice(newline + 1);
    if (line === '[host-build] built') {
      if (watcherBuilt) {
        console.log('[workbench dev] host source changed — restarting host');
        restartHost();
      } else {
        watcherBuilt = true; // initial build duplicates the build:host gate above
      }
    } else if (line === '[host-build] failed') {
      console.warn('[workbench dev] host rebuild failed; keeping current host running');
    }
    newline = watchBuffer.indexOf('\n');
  }
});
let shuttingDown = false;
let hostExited = false;
let viteExited = false;
let restartPending = false;
let watcherBuilt = false;
let shutdownCode = 0;
let shutdownDeadline;
const finish = () => {
  clearTimeout(shutdownDeadline);
  for (const child of [host, vite, watcher]) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  process.exit(shutdownCode);
};
const close = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdownCode = code;
  host.kill('SIGTERM');
  vite.kill('SIGTERM');
  watcher.kill('SIGTERM');
  // Host persistence shutdown is bounded at five seconds; leave the project
  // copy available until both children exit, then use a small final fallback.
  shutdownDeadline = setTimeout(finish, 5_500);
};
vite.on('exit', (code) => {
  viteExited = true;
  if (!shuttingDown) {
    console.error(`[workbench dev] vite exited (code=${code ?? 'null'})`);
    close(code ?? 1);
  } else if (hostExited) finish();
});
watcher.on('exit', (code, signal) => {
  if (!shuttingDown) {
    console.error(
      `[workbench dev] host watcher exited (code=${code ?? 'null'} signal=${signal ?? 'none'})`,
    );
    close(code ?? 1);
  }
});
process.on('SIGINT', () => close());
process.on('SIGTERM', () => close());

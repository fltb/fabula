#!/usr/bin/env node
// Workbench production start: resolves the environment file once, in priority
// order — WORKBENCH_ENV_FILE, then the working-directory .env, then the
// monorepo-root .env — and spawns the built Host entry. dotenv never
// overrides variables already present in the shell, so shell values always
// win. No env file is required: an unconfigured Host starts a loopback-only
// setup. Configuration thereafter belongs to the Host configuration
// service, not to this launcher.
//
// Ready-signal fan-in: the Host announces its endpoint either on the
// inherited control descriptor 3 (JSON-lines ready frame) or, when fd3 is
// absent under a plain `npm start`, on stdout as `[workbench-host] browser:
// <url>`. Both listeners attach up front; the first match wins and triggers
// the "Fabula Workbench:" line plus the platform browser open.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, fstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
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
// Unix-socket binding is a darwin/linux feature; fail clearly on Windows
// before spawning the Host (the config-file `network.mode: unix` path is
// rejected inside the Host at listener construction).
if (process.platform === 'win32' && process.env.WORKBENCH_UNIX_SOCKET !== undefined) {
  console.error('network.mode "unix" is not supported on this platform');
  process.exit(1);
}
// Only launch-relevant variables reach the Host: WORKBENCH_*/NODE_* names, a
// small allowlist of absolute-path basics, and XDG_/LC_ locale overrides.
// Everything else (credentials, editor/shell state) stays out of the child.
const ENV_ALLOW = /^(WORKBENCH_|NODE_|PATH$|HOME$|USER$|TMPDIR$|XDG_|LANG$|LC_)/;
const inheritedControlFd3 = (() => {
  try {
    fstatSync(3);
    return true;
  } catch {
    return false;
  }
})();
const childEnv = { WORKBENCH_MODE: mode, WORKBENCH_DEV: 'false' };
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && ENV_ALLOW.test(key)) childEnv[key] = value;
}
childEnv.WORKBENCH_CONTROL_FD3 = inheritedControlFd3 ? '3' : 'disabled';
const hostEntry = resolve(root, 'dist/host/host/main.js');
const child = spawn(process.execPath, [hostEntry], {
  env: childEnv,
  stdio: ['inherit', 'pipe', 'inherit', inheritedControlFd3 ? 'inherit' : 'ignore'],
});
let announced = false;
const announce = (raw) => {
  if (announced) return;
  announced = true;
  const url = `${raw.replace(/\/+$/, '')}/`;
  console.log(`Fabula Workbench: ${url}`);
  if (mode === 'workbench' && process.env.WORKBENCH_OPEN_BROWSER !== 'false') {
    openBrowser(url);
  }
};

function openBrowser(url) {
  const opener =
    process.platform === 'darwin'
      ? { command: 'open', args: [url] }
      : process.platform === 'win32'
        ? { command: process.env.COMSPEC ?? 'cmd', args: ['/c', 'start', '', url] }
        : { command: 'xdg-open', args: [url] };
  const handle = spawn(opener.command, opener.args, { stdio: 'ignore', detached: true });
  handle.on('error', (error) =>
    console.warn(`[workbench] could not open browser: ${error.message}`),
  );
  handle.unref();
}

// stdout path: forward every Host line, scanning for the ready URL. This is
// the primary signal under `npm start`, where fd3 does not exist.
const stdoutLines = createInterface({ input: child.stdout });
stdoutLines.on('line', (line) => {
  process.stdout.write(`${line}\n`);
  const match = /\[workbench-host\] browser: (\S+)/.exec(line);
  if (match) announce(match[1]);
});
stdoutLines.on('error', () => {});

// fd3 path: JSON-lines ready frame on the inherited control descriptor.
if (inheritedControlFd3) {
  const control = createInterface({
    input: createReadStream(null, { fd: 3, autoClose: false }),
  });
  control.on('line', (line) => {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return; // not a control frame; ignore
    }
    if (frame?.type === 'ready' && typeof frame.endpoint === 'string') {
      announce(frame.endpoint);
    }
  });
  control.on('error', () => {}); // broken fd3 → stdout fallback stays live
}
const shutdown = (signal) => child.kill(signal);
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
child.on('error', (error) => {
  console.error(`[workbench] failed to start Host: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

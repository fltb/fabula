/**
 * E2E host fixture: boots the BUILT composed Workbench Host as a child
 * process and exposes a typed HTTP + MCP surface for the E2E specs.
 *
 * Launch contract (mirrors `scripts/start.mjs` + the fd3 control protocol in
 * `src/host/main.ts` / `src/host/supervisor.ts`):
 *
 * - Env: `WORKBENCH_MODE=workbench`, `WORKBENCH_DEV=false`, temp
 *   `WORKBENCH_HOME` + SQLite, `WORKBENCH_PROJECT_ROOT` at a copy of
 *   `fixtures/zhu-fu` (or caller-chosen fixtures), `WORKBENCH_PROVIDER=mock`
 *   + `WORKBENCH_ALLOW_MOCK_PROVIDER=true` (deterministic, no API key),
 *   loopback bootstrap enabled, built client assets from `dist/client`, port
 *   0 (ephemeral — the real endpoint comes from the ready frame).
 * - Readiness: the child writes a versioned `ready` frame on fd 3
 *   (`{version:1,type:'ready',endpoint,...}`) only after its listener is up
 *   and `/health` returns ok; the fixture additionally polls `/health`
 *   itself. A `fatal` frame, a pre-ready exit, or a timeout fails the boot
 *   with a typed error that includes the host log tail.
 * - Teardown: the fixture sends `{version:1,type:'shutdown',requestId,
 *   deadlineMs}` on fd 3 and waits for the `stopped` ack, then closes its own
 *   end of the control pipe. Closing the pipe is REQUIRED on Node 26.5.0: the
 *   Host's pending fd-3 read stream otherwise keeps `process.exit()` from
 *   terminating the child (see README "Known quirks"). Bounded SIGTERM then
 *   SIGKILL remain as final fallbacks, so no orphan can survive `close()`.
 *
 * The fixture owns a temp `WORKBENCH_HOME`, the copied project(s) and the
 * child process; `close()` removes them (unless `keepAlive`).
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { McpTestClient } from './mcp.js';

// ─── Control-frame protocol (mirrors src/host/main.ts) ──────────────────────

export const HOST_CONTROL_PROTOCOL_VERSION = 1 as const;
export const HOST_CONTROL_MAX_FRAME_BYTES = 64 * 1024;

export interface HostReadyBuildV1 {
  readonly version: 1;
  readonly packageId: string;
  readonly buildId: string;
  readonly protocolVersion: typeof HOST_CONTROL_PROTOCOL_VERSION;
}

export interface HostReadyFrameV1 {
  readonly version: typeof HOST_CONTROL_PROTOCOL_VERSION;
  readonly type: 'ready';
  readonly endpoint: string;
  readonly build: HostReadyBuildV1;
  readonly pid: number;
  readonly listenerMode: 'workbench' | 'listener';
  readonly bootstrapRequired: boolean;
}

export interface HostStoppedFrameV1 {
  readonly version: typeof HOST_CONTROL_PROTOCOL_VERSION;
  readonly type: 'stopped';
  readonly requestId: string;
  readonly reason: string;
}

export interface HostFatalFrameV1 {
  readonly version: typeof HOST_CONTROL_PROTOCOL_VERSION;
  readonly type: 'fatal';
  readonly code: string;
  readonly message: string;
}

export type HostControlFrameV1 = HostReadyFrameV1 | HostStoppedFrameV1 | HostFatalFrameV1;

// ─── Fixture options and surface ─────────────────────────────────────────────

export const DEFAULT_FIXTURE = 'zhu-fu';
/** Minimum owner password enforced by `/api/v1/auth/bootstrap`. */
export const DEFAULT_BOOTSTRAP_PASSWORD = 'e2e-owner-password-123';
export const DEFAULT_READY_TIMEOUT_MS = 30_000;
export const DEFAULT_SHUTDOWN_DEADLINE_MS = 5_000;
export const DEFAULT_DEVICE_TTL_MS = 10 * 60 * 1000;

/**
 * Project-role → MCP scope grants, mirrored from
 * `src/contracts/configuration.ts` `PROJECT_ACCESS_ROLE_GRANTS` (the device
 * pairing service derives its accepted scope vocabulary from the same
 * constant). A project device may only claim scopes covered by one role.
 */
export const PROJECT_ROLE_GRANTS: Readonly<
  Record<'reader' | 'author' | 'maintainer', readonly string[]>
> = {
  reader: ['mcp:read'],
  author: ['mcp:read', 'mcp:render', 'mcp:author'],
  maintainer: ['mcp:read', 'mcp:render', 'mcp:author', 'mcp:submit'],
};

/** Full maintainer grant: the standard project-device scope set. */
export const MAINTAINER_SCOPES: readonly string[] = PROJECT_ROLE_GRANTS.maintainer;

export interface HostFixtureOptions {
  /**
   * Fixture directory names under the repo `fixtures/` dir, in boot order.
   * Each is copied into the temp projects root; the first one is
   * `WORKBENCH_PROJECT_ROOT` and its project id (`basename`) is returned as
   * `projectId`. With more than one fixture the fixture writes a V3
   * `workbench.yaml` into the temp Host home so every project is configured.
   */
  readonly fixtures?: readonly string[];
  /** Bound (ms) for ready-frame + `/health` readiness; default 30s. */
  readonly readyTimeoutMs?: number;
  /** Extra environment variables for the Host child (override defaults). */
  readonly env?: Readonly<Record<string, string>>;
  /** Called after each fixture copy, before the Host boots (fixture tweaks). */
  readonly onProjectCopied?: (project: {
    readonly projectRoot: string;
    readonly projectId: string;
  }) => void | Promise<void>;
  /**
   * Do not write the V3 workbench.yaml; launch purely from env
   * (`WORKBENCH_PROJECT_ROOT` + `env` overrides). Only for boot-failure
   * scenarios such as the authority-lease rejection in the concurrency spec
   * (a second Host pointed at another fixture's root must fail to start) —
   * the admin surface is unavailable without a config file.
   */
  readonly skipConfigFile?: boolean;
  /** Keep temp dirs and logs after `close()` (debugging). */
  readonly keepAlive?: boolean;
}

export interface PairDeviceOptions {
  /** Scopes the device may claim; must be covered by one project role. */
  readonly scopes?: readonly string[];
  /** Explicit role; defaults to the minimal role covering `scopes`. */
  readonly role?: 'reader' | 'author' | 'maintainer';
  readonly label?: string;
  readonly ttlMs?: number;
}

export interface PairedDevice {
  readonly credential: string;
  readonly device: unknown;
  readonly scopes: readonly string[];
}

export interface McpClientOptions extends PairDeviceOptions {
  /** Reuse an existing credential instead of pairing a new device. */
  readonly credential?: string;
}

export class HostFixtureError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HostFixtureError';
  }
}

export class HostHttpError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`Host HTTP ${status} for ${path}: ${body.slice(0, 400)}`);
    this.name = 'HostHttpError';
  }
}

/** One incremental JSON-lines parser over the child's fd-3 control stream. */
class ControlFrameParser {
  #handlers = new Map<string, Set<(frame: HostControlFrameV1) => void>>();
  #onError: ((code: string, message: string) => void) | null = null;
  #buffer = '';

  on(type: string, handler: (frame: HostControlFrameV1) => void): void {
    let set = this.#handlers.get(type);
    if (set === undefined) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    set.add(handler);
  }

  off(type: string, handler: (frame: HostControlFrameV1) => void): void {
    const set = this.#handlers.get(type);
    if (set === undefined) return;
    set.delete(handler);
    if (set.size === 0) this.#handlers.delete(type);
  }

  onProtocolError(handler: (code: string, message: string) => void): void {
    this.#onError = handler;
  }

  push(chunk: Buffer): void {
    this.#buffer += chunk.toString('utf8');
    if (this.#buffer.length > HOST_CONTROL_MAX_FRAME_BYTES * 4) {
      this.#buffer = this.#buffer.slice(-HOST_CONTROL_MAX_FRAME_BYTES * 2);
      this.#onError?.('CONTROL_STREAM_OVERSIZED', 'control stream exceeded the frame budget');
      return;
    }
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim().length === 0) continue;
      let frame: HostControlFrameV1;
      try {
        frame = JSON.parse(line) as HostControlFrameV1;
      } catch {
        this.#onError?.('CONTROL_FRAME_MALFORMED', 'control frame is not valid JSON');
        return;
      }
      if (
        typeof frame !== 'object' ||
        frame === null ||
        frame.version !== HOST_CONTROL_PROTOCOL_VERSION ||
        typeof frame.type !== 'string'
      ) {
        this.#onError?.('CONTROL_FRAME_MALFORMED', 'control frame is not a versioned object');
        return;
      }
      const set = this.#handlers.get(frame.type);
      if (set !== undefined) {
        for (const handler of [...set]) handler(frame);
      }
    }
  }

  finish(): void {
    if (this.#buffer.trim().length > 0) {
      this.#onError?.('CONTROL_FRAME_MALFORMED', 'control stream ended with a partial frame');
    }
  }
}

// ─── V3 config file (only for multi-project launches) ───────────────────────

/** Fixed V3 defaults, mirrored from `DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2`. */
const REFERENCE_LIMITS: Readonly<Record<string, number | boolean>> = {
  enabled: true,
  maxFileBytes: 104_857_600,
  maxBytesPerProject: 5_368_709_120,
  maxItemsPerProject: 10_000,
  maxPendingJobsPerProject: 4,
  maxChunksPerProject: 1_000_000,
  maxExtractedCharactersPerProject: 2_147_483_648,
  maxChunkCharacters: 12_000,
  chunkOverlapCharacters: 400,
  extractionTimeoutMs: 120_000,
  mcpImportChunkBytes: 1_048_576,
};

/** YAML double-quoted scalar; JSON string syntax is valid YAML 1.2. */
const yamlScalar = (value: string): string => JSON.stringify(value);

/** Serialize the exact V3 `workbench.yaml` shape the Host file store parses. */
function serializeV3ConfigYaml(
  projects: readonly {
    readonly projectId: string;
    readonly displayName: string;
    readonly root: string;
  }[],
): string {
  const lines: string[] = ['version: 3', 'projects:'];
  for (const project of projects) {
    lines.push(`  - projectId: ${yamlScalar(project.projectId)}`);
    lines.push(`    displayName: ${yamlScalar(project.displayName)}`);
    lines.push(`    root: ${yamlScalar(project.root)}`);
    lines.push('    revisionMirror:');
    lines.push('      mode: disabled');
    lines.push('    providerProfile: default');
    lines.push('    trustedPlugins: []');
  }
  lines.push(`defaultProjectId: ${yamlScalar(projects[0]?.projectId ?? '')}`);
  lines.push('providers: {}');
  lines.push('network:');
  lines.push('  mode: loopback');
  lines.push('  port: 0');
  lines.push('  allowedHosts: []');
  lines.push('  allowedOrigins: []');
  lines.push('  unixSocket: null');
  lines.push('referenceLimits:');
  for (const [key, value] of Object.entries(REFERENCE_LIMITS)) {
    lines.push(`  ${key}: ${typeof value === 'string' ? yamlScalar(value) : String(value)}`);
  }
  lines.push('operationLimits:');
  lines.push('  maxQueuedPerProject: 64');
  lines.push('  maxConcurrentRendersPerProject: 1');
  lines.push('  maxConcurrentRendersPerHost: 2');
  lines.push('agent:');
  lines.push('  enabled: false');
  lines.push('  maxTurns: 16');
  lines.push('  maxToolCalls: 64');
  return `${lines.join('\n')}\n`;
}

// ─── Fixture implementation ──────────────────────────────────────────────────

export interface HostFixture {
  /** Base HTTP endpoint from the ready frame (loopback TCP). */
  readonly endpoint: string;
  /** Temp `WORKBENCH_HOME` (owns SQLite + config). Removed on `close()`. */
  readonly home: string;
  /** Temp dir holding the copied fixture projects. Removed on `close()`. */
  readonly projectsRoot: string;
  /** Absolute path of the first copied project (the `WORKBENCH_PROJECT_ROOT`). */
  readonly projectRoot: string;
  /** Host-side project id of the first project (basename of `projectRoot`). */
  readonly projectId: string;
  /** PID of the Host child process (from the ready frame). */
  readonly hostPid: number;
  /** The parsed `ready` control frame. */
  readonly ready: HostReadyFrameV1;
  /** True once `close()` has run (or boot failed and cleanup happened). */
  readonly closed: boolean;
  /** Last ~200 lines of the Host child stdout+stderr (for diagnostics). */
  logs(): readonly string[];
  /**
   * Raw fetch against the fixture endpoint. Attaches `x-fabula-session` when
   * a session exists (set by `bootstrapOwner`/`login`) unless the caller
   * provided its own. Returns the `Response` so specs can assert status.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** `fetch` + 2xx check + parsed JSON body; throws `HostHttpError`. */
  fetchJson<T>(path: string, init?: RequestInit): Promise<T>;
  /** POST /api/v1/auth/bootstrap; stores the owner session for later calls. */
  bootstrapOwner(
    password?: string,
  ): Promise<{ readonly sessionId: string; readonly userId: string }>;
  /** POST /api/v1/auth/login; stores the session for later calls. */
  login(
    userId: string,
    password: string,
  ): Promise<{ readonly sessionId: string; readonly userId: string }>;
  /** Issue + claim a project device; returns the one-time credential. */
  pairDevice(options?: PairDeviceOptions): Promise<PairedDevice>;
  /** Build a typed MCP client for `/mcp/projects/:projectId`. */
  mcpClient(options?: McpClientOptions): Promise<McpTestClient>;
  /** Read a file inside the first copied project root. */
  readProjectFile(relPath: string): Promise<string>;
  /** Write a file inside the first copied project root. */
  writeProjectFile(relPath: string, content: string): Promise<void>;
  /** Control-frame shutdown → fd-3 EOF → bounded SIGTERM → SIGKILL. */
  close(): Promise<void>;
}

interface FixtureState {
  readonly child: ChildProcess;
  readonly parser: ControlFrameParser;
  readonly logRing: string[];
  readonly clients: Set<McpTestClient>;
  sessionId: string | null;
}

function roleForScopes(scopes: readonly string[]): 'reader' | 'author' | 'maintainer' {
  const roles = ['reader', 'author', 'maintainer'] as const;
  for (const role of roles) {
    const grant = PROJECT_ROLE_GRANTS[role];
    if (scopes.every((scope) => grant.includes(scope))) return role;
  }
  throw new HostFixtureError(
    'SCOPE_INVALID',
    `scopes [${scopes.join(', ')}] are not covered by any project role grant; project devices may only claim reader/author/maintainer scopes.`,
  );
}

function listFixtureDirs(repoRoot: string): readonly string[] {
  const fixturesDir = join(repoRoot, 'fixtures');
  try {
    return readdirSync(fixturesDir, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && existsSync(join(fixturesDir, entry.name, 'nova.yaml')),
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Sleep; kept in one place so the wait idiom stays consistent. */
function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

export async function startHostFixture(options: HostFixtureOptions = {}): Promise<HostFixture> {
  const fixtures = options.fixtures ?? [DEFAULT_FIXTURE];
  if (fixtures.length === 0)
    throw new HostFixtureError('INVALID_INPUT', 'fixtures must not be empty');
  const packageRoot = resolve(import.meta.dirname, '..', '..', '..');
  const repoRoot = resolve(packageRoot, '..', '..');
  const hostEntry = join(packageRoot, 'dist', 'host', 'host', 'main.js');
  const workerEntry = join(packageRoot, 'dist', 'host', 'persistence', 'worker.js');
  const assetsRoot = join(packageRoot, 'dist', 'client');

  // Pre-flight: the harness boots the BUILT host; give a clear message when
  // the build artifacts are missing instead of a cryptic spawn failure.
  const missing: string[] = [];
  if (!existsSync(hostEntry)) missing.push(hostEntry);
  if (!existsSync(workerEntry)) missing.push(workerEntry);
  if (!existsSync(join(assetsRoot, 'index.html'))) missing.push(join(assetsRoot, 'index.html'));
  if (missing.length > 0) {
    throw new HostFixtureError(
      'BUILD_ARTIFACTS_MISSING',
      `Workbench build artifacts missing:\n${missing.join('\n')}\n` +
        'Run `npm run build` in packages/workbench (build:host + build:client) before E2E tests.',
    );
  }

  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const home = mkdtempSync(join(tmpdir(), 'fabula-workbench-e2e-home-'));
  const projectsRoot = mkdtempSync(join(tmpdir(), 'fabula-workbench-e2e-projects-'));

  // Copy every requested fixture into the temp projects root.
  const copied: Array<{
    readonly projectId: string;
    readonly projectRoot: string;
    readonly displayName: string;
  }> = [];
  try {
    for (const name of fixtures) {
      const source = join(repoRoot, 'fixtures', name);
      if (!existsSync(join(source, 'nova.yaml'))) {
        throw new HostFixtureError(
          'FIXTURE_NOT_FOUND',
          `Fixture "${name}" not found at ${source} (expected nova.yaml).` +
            (existsSync(join(repoRoot, 'fixtures'))
              ? ` Available: ${listFixtureDirs(repoRoot).join(', ') || '(none)'}.`
              : ''),
        );
      }
      const destination = join(projectsRoot, name);
      cpSync(source, destination, { recursive: true });
      const project = { projectId: name, projectRoot: destination, displayName: name };
      copied.push(project);
      await options.onProjectCopied?.(project);
    }
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectsRoot, { recursive: true, force: true });
    throw error;
  }

  const first = copied[0];
  if (first === undefined) {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectsRoot, { recursive: true, force: true });
    throw new HostFixtureError('INVALID_INPUT', 'no fixture was copied');
  }

  // Configure every project through a V3 workbench.yaml in the temp Host
  // home. This is REQUIRED for the admin surface (device pairing, provider/
  // plugin config) to work — it rejects with "The Host is not configured yet"
  // when absent. The launch synthesizes the same project from
  // WORKBENCH_PROJECT_ROOT when the file is missing, so keeping both
  // consistent is harmless. `skipConfigFile` opts out for boot-failure tests.
  if (!(options.skipConfigFile ?? false)) {
    mkdirSync(join(home, 'config'), { recursive: true });
    const configYaml = serializeV3ConfigYaml(
      copied.map((project) => ({
        projectId: project.projectId,
        displayName: project.displayName,
        root: project.projectRoot,
      })),
    );
    await writeFile(join(home, 'config', 'workbench.yaml'), configYaml, 'utf8');
  }

  // Hermetic child env: deterministic E2E never touches a real provider, so
  // drop any caller-supplied AI credential/endpoint before spawning. The
  // live smoke command (`smoke:workbench-agent:live`) is the only key consumer.
  const childEnv = { ...(process.env as Record<string, string>) };
  for (const secret of [
    'NOVALISTICALLY_AI_API_KEY',
    'NOVALISTICALLY_AI_BASE_URL',
    'NOVALISTICALLY_AI_MODEL',
  ]) {
    delete childEnv[secret];
  }
  const env: Record<string, string> = {
    ...childEnv,
    WORKBENCH_MODE: 'workbench',
    WORKBENCH_DEV: 'false',
    WORKBENCH_HOME: home,
    WORKBENCH_DATABASE_PATH: join(home, 'workbench.sqlite'),
    WORKBENCH_PROJECT_ROOT: first.projectRoot,
    WORKBENCH_PROJECT_ID: first.projectId,
    WORKBENCH_DISPLAY_NAME: first.displayName,
    WORKBENCH_PROVIDER: 'mock',
    WORKBENCH_ALLOW_MOCK_PROVIDER: 'true',
    WORKBENCH_ALLOW_BOOTSTRAP: 'true',
    WORKBENCH_HOST: 'loopback',
    WORKBENCH_PORT: '0',
    WORKBENCH_ALLOWED_HOSTS: '127.0.0.1',
    WORKBENCH_ASSETS_ROOT: assetsRoot,
    WORKBENCH_CONTROL_FD3: '3',
    ...options.env,
  };

  const parser = new ControlFrameParser();
  const logRing: string[] = [];
  const pushLog = (line: string): void => {
    logRing.push(line);
    if (logRing.length > 200) logRing.splice(0, logRing.length - 200);
  };

  const child = spawn(process.execPath, [hostEntry], {
    cwd: packageRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  const state: FixtureState = { child, parser, logRing, clients: new Set(), sessionId: null };
  child.stdio[1]?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n'))
      if (line.length > 0) pushLog(`[host] ${line}`);
  });
  child.stdio[2]?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.length > 0) pushLog(`[host:err] ${line}`);
    }
  });
  child.stdio[3]?.on('data', (chunk: Buffer) => parser.push(chunk));
  child.stdio[3]?.on('end', () => parser.finish());

  // stdio[3] of a pipe spawn is always a Duplex at runtime (the Host writes
  // ready/stopped frames and reads shutdown frames on it); the spawn types
  // only see the Readable|Writable union, so narrow once at the boundary.
  const controlStream = (): {
    write(chunk: string, encoding?: BufferEncoding): boolean;
    destroy(): void;
  } | null => {
    const stream = child.stdio[3];
    return stream === null
      ? null
      : (stream as unknown as {
          write(chunk: string, encoding?: BufferEncoding): boolean;
          destroy(): void;
        });
  };

  /**
   * One-shot frame wait. `fatal` frames reject the wait immediately so a
   * Host that dies during boot/shutdown fails fast with its diagnostic.
   */
  const waitForFrame = (
    type: 'ready' | 'stopped' | 'fatal',
    timeoutMs: number,
  ): Promise<HostControlFrameV1> => {
    const { promise, resolve, reject } = Promise.withResolvers<HostControlFrameV1>();
    const cleanup = (): void => {
      parser.off(type, handler);
      parser.off('fatal', fatalHandler);
    };
    const handler = (frame: HostControlFrameV1): void => {
      clearTimeout(timer);
      cleanup();
      resolve(frame);
    };
    const fatalHandler = (frame: HostControlFrameV1): void => {
      if (frame.type !== 'fatal') return;
      clearTimeout(timer);
      cleanup();
      const fatal = frame;
      reject(
        new HostFixtureError(
          'HOST_FATAL',
          `Host sent a fatal frame (${fatal.code}): ${fatal.message}\nhost log:\n${state.logRing.slice(-60).join('\n')}`,
        ),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new HostFixtureError(
          'CONTROL_TIMEOUT',
          `timed out after ${timeoutMs}ms waiting for a "${type}" control frame; host log:\n${state.logRing.slice(-60).join('\n')}`,
        ),
      );
    }, timeoutMs);
    parser.on(type, handler);
    if (type !== 'fatal') parser.on('fatal', fatalHandler);
    return promise;
  };

  // Fail fast when the Host child exits before signaling ready.
  const waitForPreReadyExit = (): Promise<never> => {
    const { promise, reject } = Promise.withResolvers<never>();
    child.once('exit', (code, signal) => {
      reject(
        new HostFixtureError(
          'HOST_EXITED',
          `Host child exited before ready (code=${code} signal=${signal}); host log:\n${state.logRing.slice(-60).join('\n')}`,
        ),
      );
    });
    return promise;
  };

  let ready: HostReadyFrameV1;
  try {
    const readyFrame = await Promise.race([
      waitForFrame('ready', readyTimeoutMs),
      waitForPreReadyExit(),
    ]);
    if (readyFrame.type !== 'ready') {
      throw new HostFixtureError(
        'CONTROL_FRAME_MALFORMED',
        `expected a ready frame, got ${readyFrame.type}`,
      );
    }
    if (
      typeof readyFrame.endpoint !== 'string' ||
      readyFrame.endpoint.length === 0 ||
      !Number.isInteger(readyFrame.pid) ||
      readyFrame.pid < 1
    ) {
      throw new HostFixtureError('CONTROL_FRAME_MALFORMED', 'ready frame fields are invalid');
    }
    ready = readyFrame;

    // The Host verifies /health before the ready frame; re-verify from the
    // fixture so the contract is asserted on the observable surface too.
    const healthDeadline = Date.now() + readyTimeoutMs;
    let healthOk = false;
    while (Date.now() < healthDeadline) {
      const response = await fetch(`${ready.endpoint}/health`).catch(() => null);
      if (response !== null && response.ok) {
        const payload = (await response.json().catch(() => null)) as { status?: unknown } | null;
        if (payload !== null && typeof payload === 'object' && payload.status === 'ok') {
          healthOk = true;
          break;
        }
      }
      await delay(250);
    }
    if (!healthOk) {
      throw new HostFixtureError(
        'HEALTH_TIMEOUT',
        `Host ready frame arrived but /health never returned ok; host log:\n${state.logRing.slice(-60).join('\n')}`,
      );
    }
  } catch (error) {
    // Boot failed: never leave the child or temp dirs behind.
    if (child.exitCode === null && child.signalCode === null) {
      try {
        controlStream()?.write(
          `${JSON.stringify({ version: HOST_CONTROL_PROTOCOL_VERSION, type: 'shutdown', requestId: `boot-failure-${randomUUID().slice(0, 8)}`, deadlineMs: 1_000 })}\n`,
          'utf8',
        );
      } catch {
        /* ignore */
      }
      await delay(500);
      child.kill('SIGKILL');
      await delay(100);
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(projectsRoot, { recursive: true, force: true });
    throw error;
  }

  // ── Fixture surface ────────────────────────────────────────────────────────
  const endpoint = ready.endpoint;
  let closed = false;

  const sessionHeaders = (init?: RequestInit): Headers => {
    const headers = new Headers(init?.headers);
    if (state.sessionId !== null && !headers.has('x-fabula-session')) {
      headers.set('x-fabula-session', state.sessionId);
    }
    return headers;
  };

  const http = async (path: string, init?: RequestInit): Promise<Response> => {
    const url = path.startsWith('http') ? path : `${endpoint}${path}`;
    return fetch(url, { ...init, headers: sessionHeaders(init) });
  };

  const httpJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await http(path, init);
    if (!response.ok) {
      throw new HostHttpError(path, response.status, await response.text().catch(() => ''));
    }
    return (await response.json()) as T;
  };

  const requireOwnerSession = (): void => {
    if (state.sessionId === null) {
      throw new HostFixtureError(
        'OWNER_SESSION_REQUIRED',
        'no owner session; call bootstrapOwner() or login() before pairing devices or calling owner routes',
      );
    }
  };

  const pairDevice = async (pairOptions: PairDeviceOptions = {}): Promise<PairedDevice> => {
    requireOwnerSession();
    const scopes = [...new Set(pairOptions.scopes ?? MAINTAINER_SCOPES)];
    if (scopes.length === 0) {
      throw new HostFixtureError('SCOPE_INVALID', 'pairDevice requires at least one scope');
    }
    const role = pairOptions.role ?? roleForScopes(scopes);
    const ttlMs = pairOptions.ttlMs ?? DEFAULT_DEVICE_TTL_MS;
    const label = pairOptions.label ?? `fabula-e2e-${randomUUID().slice(0, 8)}`;
    const issued = await httpJson<{ pairingCode: string }>('/api/v1/admin/mcp-devices/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        kind: 'project',
        projectId: first.projectId,
        role,
        ttlMs,
      }),
    });
    const claimed = await httpJson<{ credential: string; device: unknown }>(
      '/api/v1/admin/mcp-devices',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, pairingCode: issued.pairingCode, label, scopes, ttlMs }),
      },
    );
    return { credential: claimed.credential, device: claimed.device, scopes };
  };

  const mcpClient = async (clientOptions: McpClientOptions = {}): Promise<McpTestClient> => {
    const credential = clientOptions.credential ?? (await pairDevice(clientOptions)).credential;
    const client = new McpTestClient({
      url: `${endpoint}/mcp/projects/${first.projectId}`,
      credential,
    });
    state.clients.add(client);
    await client.connect();
    return client;
  };

  const guardProjectPath = (relPath: string): string => {
    const absolute = resolve(first.projectRoot, relPath);
    if (absolute !== first.projectRoot && !absolute.startsWith(`${first.projectRoot}${sep}`)) {
      throw new HostFixtureError('INVALID_INPUT', `path escapes the project root: ${relPath}`);
    }
    return absolute;
  };

  const readProjectFile = async (relPath: string): Promise<string> =>
    readFile(guardProjectPath(relPath), 'utf8');

  const writeProjectFile = async (relPath: string, content: string): Promise<void> => {
    const absolute = guardProjectPath(relPath);
    mkdirSync(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  };

  const sendShutdownFrame = (requestId: string, deadlineMs: number): void => {
    const stream = controlStream();
    if (stream === null) return;
    try {
      stream.write(
        `${JSON.stringify({ version: HOST_CONTROL_PROTOCOL_VERSION, type: 'shutdown', requestId, deadlineMs })}\n`,
        'utf8',
      );
    } catch {
      /* child already gone */
    }
  };

  const destroyControl = (): void => {
    const stream = controlStream();
    if (stream !== null) {
      try {
        stream.destroy();
      } catch {
        /* ignore */
      }
    }
  };

  const waitForExit = (timeoutMs: number): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return promise;
    }
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    return promise;
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const client of state.clients) await client.close().catch(() => undefined);
    state.clients.clear();
    if (child.exitCode === null && child.signalCode === null) {
      const requestId = `shutdown-${randomUUID().slice(0, 8)}`;
      const stoppedWait = waitForFrame('stopped', DEFAULT_SHUTDOWN_DEADLINE_MS + 2_000).catch(
        () => null,
      );
      sendShutdownFrame(requestId, DEFAULT_SHUTDOWN_DEADLINE_MS);
      await stoppedWait;
      // Close our end of the control pipe: the Host's pending fd-3 read then
      // completes (EOF) and its process.exit() can actually terminate — see
      // README "Known quirks" for the Node 26.5.0 behavior this works around.
      destroyControl();
      await waitForExit(5_000);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM'); // ignored after a control-frame shutdown, but harmless
        await waitForExit(2_000);
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForExit(2_000);
      }
    }
    if (!(options.keepAlive ?? false)) {
      rmSync(home, { recursive: true, force: true });
      rmSync(projectsRoot, { recursive: true, force: true });
    }
  };

  return {
    endpoint,
    home,
    projectsRoot,
    projectRoot: first.projectRoot,
    projectId: first.projectId,
    hostPid: ready.pid,
    ready,
    get closed() {
      return closed;
    },
    logs: () => [...logRing],
    fetch: http,
    fetchJson: httpJson,
    bootstrapOwner: async (
      password = DEFAULT_BOOTSTRAP_PASSWORD,
    ): Promise<{ sessionId: string; userId: string }> => {
      const result = await httpJson<{ sessionId: string; userId: string }>(
        '/api/v1/auth/bootstrap',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password, displayName: 'E2E Owner' }),
        },
      );
      state.sessionId = result.sessionId;
      return result;
    },
    login: async (
      userId: string,
      password: string,
    ): Promise<{ sessionId: string; userId: string }> => {
      const result = await httpJson<{ sessionId: string; userId: string }>('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, password }),
      });
      state.sessionId = result.sessionId;
      return result;
    },
    pairDevice,
    mcpClient,
    readProjectFile,
    writeProjectFile,
    close,
  };
}

/**
 * Workbench Host launch: parses the environment into a `WorkbenchLaunchConfig`
 * and composes the Host runtime. Phase 1A changes:
 *
 * - Persistence runs in a real `worker_threads.Worker` spawned from the built
 *   `src/persistence/worker.ts` entry; the SQLite driver and Kysely never
 *   execute on the Host thread. Worker crashes reject in-flight requests and
 *   propagate to callers; `close()` terminates the worker under a bounded
 *   deadline, and every partial-launch failure disposes the worker, its
 *   ports and any already-started server.
 * - The launch no longer requires a project root, database path or API key:
 *   an unconfigured Host starts a loopback-only setup runtime (the Phase-1B
 *   setup/admin surface mounts here) with clear built-assets diagnostics.
 * - Providers are constructed only through the Host-only
 *   {@link HostProviderFactory}, which reads the API key exclusively from
 *   `ProviderCredentialStore` and passes explicit AI SDK options, so provider
 *   construction can never fall back to process-environment keys.
 *
 * The Phase-1B configuration service is deliberately not implemented here:
 * the launch consumes the Phase-0 configuration DTOs through the optional
 * `configurationService` seam (and uses `configuration.provider` for
 * credential-backed provider construction) while the versioned YAML service,
 * setup/admin API and runtime registry stay with the configuration slice.
 */

import { readFileSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { LLMProvider } from '@novalistically/core';
import { MockProvider } from '@novalistically/core/testing';
import { createFileCoreRuntimeServices, FileProjectSourceLoader } from '@novalistically/node-host';
import {
  BROWSER_API_VERSION,
  type BrowserProjectSummaryV1,
  type BrowserSessionPrincipalV1,
} from '../contracts/browser-api.js';
import type { WorkbenchConfigurationV1 } from '../contracts/configuration.js';
import type {
  PersistenceOperation,
  PersistencePayloads,
  PersistenceResults,
} from '../contracts/persistence.js';
import type { SourceStudioStateV1 } from '../contracts/source-studio.js';
import type { PersistenceMessagePort, PersistenceResponse } from '../persistence/messages.js';
import { PersistenceWorkerClient } from '../persistence/worker-client.js';
import { AgentCapabilityService, createCapabilityPersistence } from './agent/index.js';
import { createAuthPersistence, LocalAuthService } from './auth/index.js';
import { createBrowserPrincipalResolver } from './browser-read-api.js';
import { createProjectCoreRuntime } from './core-runtime.js';
import { projectCanonicalGraphRuntime } from './graph-projection.js';
import { createProjectSessionRegistry } from './project-session.js';
import { HostProviderError, HostProviderFactory } from './provider-factory.js';
import { createProviderCredentialStore } from './providers/index.js';
import { createHostServer, type HostServer, type HostServerOptions } from './server.js';

export interface WorkbenchLaunchConfig extends HostServerOptions {
  readonly mode: 'workbench';
  readonly provider: 'ai-sdk' | 'mock';
  readonly allowMockProvider: boolean;
  /** Resolved Host home directory; owns SQLite and coordinator state. */
  readonly hostHome: string;
  /** SQLite path owned by the Host; always passed to the persistence worker. */
  readonly databasePath: string;
  /** Optional env-derived single project; absent = unconfigured setup runtime. */
  readonly projectRoot?: string;
  readonly projectId?: string;
  readonly displayName?: string;
  /** Custom assets root; defaults to the packaged `dist/client` outside dev. */
  readonly assetsRoot?: string;
  readonly allowBootstrap: boolean;
  /**
   * Phase-1B configuration-service seam. The launch only consumes the
   * validated Phase-0 DTO (its `provider` endpoint/model feed the provider
   * factory); the versioned YAML service itself is owned by the configuration
   * slice. Absent = env-derived single-project launch.
   */
  readonly configurationService?: WorkbenchConfigurationSeam;
  /** Test/dev-only provider override injected past the credential store (e.g. `MockProvider`). */
  readonly providerOverride?: LLMProvider;
  /** Absolute path to the built persistence worker entry; defaults to the bundled `dist/host/persistence/worker.js`. */
  readonly persistenceWorkerEntry?: string;
  /** Bound on persistence worker termination during close; default 5s. */
  readonly workerTerminationTimeoutMs?: number;
  /** Invoked once when the persistence worker exits unexpectedly while running. */
  readonly onPersistenceCrash?: (error: Error) => void;
}

/**
 * Explicit Phase-1B integration seam: loading the validated Phase-0
 * configuration DTO. The launch never reads or writes `workbench.yaml`
 * itself in Phase 1A.
 */
export interface WorkbenchConfigurationSeam {
  /** Load the validated Phase-0 configuration DTO; null while unconfigured. */
  load(): Promise<WorkbenchConfigurationV1 | null>;
}

export interface WorkbenchLaunchHandle {
  readonly host: HostServer;
  readonly endpoint: string;
  /** Open project id, or null in the unconfigured setup runtime. */
  readonly projectId: string | null;
  readonly auth: LocalAuthService;
  /** Host-only provider factory (credential-backed; secret-free readiness). */
  readonly provider: HostProviderFactory;
  /** Close the listener and terminate the persistence worker (bounded, idempotent). */
  close(): Promise<void>;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** Default bound on persistence worker termination during close. */
export const DEFAULT_WORKER_TERMINATION_TIMEOUT_MS = 5_000;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

async function bodyObject(request: Request): Promise<Record<string, unknown> | null> {
  const value: unknown = await request.json().catch(() => null);
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sessionResponse(sessionId: string, userId?: string): Response {
  return json(userId === undefined ? { sessionId } : { sessionId, userId });
}

function isLoopbackConfig(config: WorkbenchLaunchConfig): boolean {
  return config.host === undefined || config.host === 'loopback' || config.host === '127.0.0.1';
}

function validateConfig(config: WorkbenchLaunchConfig): void {
  if (!config.hostHome || !config.databasePath) {
    throw new Error('Workbench requires a Host home and database path');
  }
  if (config.projectRoot === undefined && !isLoopbackConfig(config)) {
    throw new Error(
      'An unconfigured Workbench starts loopback-only; LAN or reverse-proxy binding requires an owner-configured Host',
    );
  }
  if (config.projectRoot === undefined && (config.lan === true || config.unixSocket !== undefined)) {
    throw new Error(
      'An unconfigured Workbench starts loopback-only; LAN or Unix-socket binding requires an owner-configured Host',
    );
  }
  if (config.allowBootstrap && !isLoopbackConfig(config)) {
    throw new Error('Workbench bootstrap is permitted only on loopback');
  }
  if (config.allowBootstrap && (config.lan === true || config.unixSocket !== undefined)) {
    throw new Error('Workbench bootstrap cannot be enabled with LAN or reverse-proxy binding');
  }
  if (config.provider === 'mock' && !config.allowMockProvider) {
    throw new Error('Mock provider requires explicit WORKBENCH_ALLOW_MOCK_PROVIDER=true');
  }
}

async function staticHandler(request: Request, assetsRoot: string): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (
    path === '/health' ||
    path === '/status' ||
    path === '/mcp' ||
    path === '/yjs' ||
    path.startsWith('/api/')
  ) {
    return new Response('Not Found', { status: 404 });
  }
  const requested = path === '/' ? '/index.html' : path;
  const candidate = resolve(assetsRoot, `.${requested}`);
  const root = resolve(assetsRoot);
  if (!candidate.startsWith(`${root}/`) && candidate !== root) {
    return new Response('Not Found', { status: 404 });
  }
  try {
    const info = await stat(candidate);
    if (!info.isFile()) throw new Error('not a file');
    return new Response(await readFile(candidate), {
      headers: { 'content-type': MIME_TYPES[extname(candidate)] ?? 'application/octet-stream' },
    });
  } catch {
    // Only browser GET paths may receive the SPA shell. API/transport paths
    // were rejected above so their diagnostics remain HTTP errors, not HTML.
    if (request.method === 'GET' && !extname(path)) {
      try {
        return new Response(await readFile(resolve(root, 'index.html')), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    }
    return new Response('Not Found', { status: 404 });
  }
}

/** Treat empty env values as unset so a copied template cannot break startup. */
function opt(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

/**
 * Locate the `@novalistically/workbench` package root from any module URL
 * (bundled output or source) by walking up to its package.json.
 */
function resolveWorkbenchPackageRoot(fromUrl: string | URL): string {
  let directory = dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        name?: unknown;
      };
      if (manifest.name === '@novalistically/workbench') return directory;
    } catch {
      // Not this level; keep walking up.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('Unable to locate the @novalistically/workbench package root');
}

/**
 * Resolve the Host home directory: `WORKBENCH_HOME` override, else
 * `$XDG_STATE_HOME/fabula/workbench`, else `$HOME/.local/state/fabula/workbench`.
 * Fails closed when no base is available so state never lands somewhere
 * accidental.
 */
export function resolveWorkbenchHostHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = opt(env.WORKBENCH_HOME);
  if (override !== undefined) return resolve(override);
  const xdgState = opt(env.XDG_STATE_HOME);
  if (xdgState !== undefined) return resolve(join(xdgState, 'fabula', 'workbench'));
  const home = opt(env.HOME);
  if (home !== undefined) return resolve(join(home, '.local', 'state', 'fabula', 'workbench'));
  throw new Error(
    'Workbench cannot resolve a Host home: set WORKBENCH_HOME, XDG_STATE_HOME, or HOME',
  );
}

async function ensureHostHomeDirectory(hostHome: string): Promise<void> {
  await mkdir(hostHome, { recursive: true });
  const info = await stat(hostHome);
  if (!info.isDirectory()) {
    throw new Error(`Workbench Host home is not a directory: ${hostHome}`);
  }
}
/**
 * Bridge the Worker's EventEmitter message surface to the typed persistence
 * port. Node 26 no longer exposes `worker.port` on the main thread, so the
 * worker's implicit parent port is reached through `postMessage`/`on`; the
 * worker delivers the response payload directly, so each listener is wrapped
 * into the `{ data }` event shape the domain client expects (and the same
 * wrapper is reused for removal).
 */
function toPersistenceMessagePort(worker: Worker): PersistenceMessagePort {
  const wrappers = new Map<
    (event: { data: PersistenceResponse }) => void,
    (payload: unknown) => void
  >();
  return {
    postMessage: (message) => worker.postMessage(message),
    addEventListener: (type, listener) => {
      if (type !== 'message') return;
      const wrapped = (payload: unknown): void =>
        listener({ data: payload as PersistenceResponse });
      wrappers.set(listener, wrapped);
      worker.on('message', wrapped);
    },
    removeEventListener: (type, listener) => {
      if (type !== 'message') return;
      const wrapped = wrappers.get(listener);
      if (wrapped !== undefined) {
        wrappers.delete(listener);
        worker.off('message', wrapped);
      }
    },
  };
}

/**
 * Persistence client that fails fast once the worker dies: an unexpected
 * crash rejects every in-flight request with the crash error, and future
 * requests reject immediately instead of hanging on a closed port.
 */
class WorkerBackedPersistenceClient extends PersistenceWorkerClient {
  #failure: Error | null = null;

  override request<O extends PersistenceOperation>(
    operation: O,
    payload: PersistencePayloads[O],
    signal?: AbortSignal,
  ): Promise<PersistenceResults[O]> {
    if (this.#failure !== null) return Promise.reject(this.#failure);
    return super.request(operation, payload, signal).catch((error: unknown) => {
      throw this.#failure ?? error;
    });
  }

  override dispose(): void {
    this.#failure ??= new Error('Persistence client disposed');
    super.dispose();
  }

  /** Crash propagation: fail every in-flight request and stop new ones. */
  fail(error: Error): void {
    if (this.#failure !== null) return;
    this.#failure = error;
    super.dispose();
  }
}

export interface PersistenceWorkerRuntime {
  readonly client: PersistenceWorkerClient;
  /** Worker thread id; diagnostics only (proves SQLite runs off the Host thread). */
  readonly threadId: number;
  /** Crash propagation from worker error/exit events. */
  fail(error: Error): void;
  /** Bounded, idempotent shutdown: reject pending, terminate the thread, release the port. */
  dispose(): Promise<void>;
}

/**
 * Spawn the built persistence worker entry as a real worker thread. The
 * worker module (SQLite driver + Kysely) is the only owner of the database
 * handle; the Host talks typed RPC over the worker's implicit parent port.
 */
export function createPersistenceWorkerRuntime(options: {
  readonly entry: string;
  readonly databasePath: string;
  readonly terminationTimeoutMs: number;
  readonly onCrash?: (error: Error) => void;
}): PersistenceWorkerRuntime {
  const worker = new Worker(options.entry, {
    name: 'workbench-persistence',
    workerData: { databasePath: options.databasePath },
  });
  const client = new WorkerBackedPersistenceClient(toPersistenceMessagePort(worker));
  let closing = false;
  let disposePromise: Promise<void> | undefined;
  const fail = (error: Error): void => {
    if (closing) return;
    client.fail(error);
    options.onCrash?.(error);
    void worker.terminate().catch(() => undefined);
  };
  worker.on('error', (error: unknown) =>
    fail(
      new Error(
        `Workbench persistence worker crashed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      ),
    ),
  );
  worker.on('exit', (code) => {
    if (!closing && code !== 0) {
      fail(new Error(`Workbench persistence worker exited unexpectedly (code ${code})`));
    }
  });
  const dispose = (): Promise<void> => {
    if (disposePromise !== undefined) return disposePromise;
    closing = true;
    client.dispose();
    disposePromise = (async () => {
      // `terminate()` stops the worker thread; the race keeps disposal
      // bounded even if the exit notification never arrives.
      await Promise.race([
        worker.terminate(),
        new Promise<void>((resolve) => setTimeout(resolve, options.terminationTimeoutMs)),
      ]);
      worker.removeAllListeners('message');
      worker.removeAllListeners('error');
      worker.removeAllListeners('exit');
    })();
    return disposePromise;
  };
  return { client, threadId: worker.threadId, fail, dispose };
}

/** Default worker entry: the esbuild output of `src/persistence/worker.ts`. */
function defaultPersistenceWorkerEntry(): string {
  return fileURLToPath(new URL('../persistence/worker.js', import.meta.url));
}

export function parseWorkbenchLaunchConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkbenchLaunchConfig {
  if (opt(env.WORKBENCH_MODE) !== 'workbench') {
    throw new Error('WORKBENCH_MODE must be explicitly set to "workbench" for a composed Host');
  }
  const devMode = env.WORKBENCH_DEV === 'true';
  const hostHome = resolveWorkbenchHostHome(env);
  const databasePathRaw = opt(env.WORKBENCH_DATABASE_PATH);
  const databasePath =
    databasePathRaw === undefined ? join(hostHome, 'workbench.sqlite') : resolve(databasePathRaw);
  const projectRootRaw = opt(env.WORKBENCH_PROJECT_ROOT);
  const projectRoot = projectRootRaw === undefined ? undefined : resolve(projectRootRaw);
  const assetsRootRaw = opt(env.WORKBENCH_ASSETS_ROOT);
  const assetsRoot =
    assetsRootRaw !== undefined
      ? resolve(assetsRootRaw)
      : devMode
        ? undefined
        : resolve(join(resolveWorkbenchPackageRoot(import.meta.url), 'dist', 'client'));
  const workerEntryRaw = opt(env.WORKBENCH_PERSISTENCE_WORKER_ENTRY);
  const allowBootstrap = env.WORKBENCH_ALLOW_BOOTSTRAP === 'true';
  const hostRaw = opt(env.WORKBENCH_HOST);
  const host = hostRaw === 'lan' ? 'lan' : (hostRaw ?? 'loopback');
  const lan = env.WORKBENCH_LAN === 'true';
  const portRaw = opt(env.WORKBENCH_PORT);
  const port = portRaw === undefined ? 8787 : Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('WORKBENCH_PORT must be 0..65535');
  const providerValue = opt(env.WORKBENCH_PROVIDER) ?? 'ai-sdk';
  if (providerValue !== 'ai-sdk' && providerValue !== 'mock') {
    throw new Error('WORKBENCH_PROVIDER must be ai-sdk or mock');
  }
  const allowedHostsRaw = opt(env.WORKBENCH_ALLOWED_HOSTS) ?? '127.0.0.1';
  const allowedOriginsRaw = opt(env.WORKBENCH_ALLOWED_ORIGINS);
  const config: WorkbenchLaunchConfig = {
    mode: 'workbench',
    provider: providerValue,
    allowMockProvider: env.WORKBENCH_ALLOW_MOCK_PROVIDER === 'true',
    hostHome,
    databasePath,
    projectRoot,
    projectId:
      projectRoot === undefined ? undefined : (opt(env.WORKBENCH_PROJECT_ID) ?? basename(projectRoot)),
    displayName:
      projectRoot === undefined
        ? undefined
        : (opt(env.WORKBENCH_DISPLAY_NAME) ?? basename(projectRoot)),
    assetsRoot,
    allowBootstrap,
    persistenceWorkerEntry: workerEntryRaw === undefined ? undefined : resolve(workerEntryRaw),
    unixSocket: opt(env.WORKBENCH_UNIX_SOCKET),
    trustForwardedHeaders: env.WORKBENCH_TRUST_FORWARDED_HEADERS === 'true',
    host,
    lan,
    port,
    mutation: {
      allowedHosts: allowedHostsRaw.split(',').map((x) => x.trim()),
      allowedOrigins: allowedOriginsRaw?.split(',').map((x) => x.trim()),
    },
  };
  validateConfig(config);
  return config;
}

export async function startWorkbench(
  config: WorkbenchLaunchConfig,
): Promise<WorkbenchLaunchHandle> {
  validateConfig(config);

  // Phase-1B seam: load the validated configuration DTO when a service is
  // wired; the launch itself never reads or writes `workbench.yaml`.
  const configuration =
    config.configurationService === undefined
      ? null
      : await config.configurationService.load();

  // Built-assets diagnostics before any runtime resource is constructed.
  const assetsRoot = config.assetsRoot ?? null;
  if (assetsRoot !== null) {
    const assetInfo = await stat(assetsRoot).catch(() => null);
    if (assetInfo === null || !assetInfo.isDirectory()) {
      throw new Error(
        `Workbench built assets not found at ${assetsRoot}. Run \`npm run build:client\` or set WORKBENCH_ASSETS_ROOT before starting Workbench.`,
      );
    }
  }

  await ensureHostHomeDirectory(config.hostHome);
  await mkdir(dirname(config.databasePath), { recursive: true });

  const workerEntry = config.persistenceWorkerEntry ?? defaultPersistenceWorkerEntry();
  const workerInfo = await stat(workerEntry).catch(() => null);
  if (workerInfo === null || !workerInfo.isFile()) {
    throw new Error(
      `Workbench persistence worker bundle not found at ${workerEntry}. Run \`npm run build:host\` before starting Workbench.`,
    );
  }

  const persistence = createPersistenceWorkerRuntime({
    entry: workerEntry,
    databasePath: config.databasePath,
    terminationTimeoutMs:
      config.workerTerminationTimeoutMs ?? DEFAULT_WORKER_TERMINATION_TIMEOUT_MS,
    onCrash: config.onPersistenceCrash,
  });

  let host: HostServer | undefined;
  try {
    const auth = new LocalAuthService({ persistence: createAuthPersistence(persistence.client) });
    const capabilities = new AgentCapabilityService({
      persistence: createCapabilityPersistence(persistence.client),
    });

    // Host-only provider construction: the API key is read exclusively from
    // the credential store and passed as an explicit AI SDK option; the
    // factory never consults `NOVALISTICALLY_AI_API_KEY` or any other env key.
    const credentialStore = createProviderCredentialStore();
    const provider = new HostProviderFactory({
      store: credentialStore,
      configuration: configuration?.provider ?? null,
      override:
        config.providerOverride ?? (config.provider === 'mock' ? new MockProvider() : undefined),
    });

    let browser: HostServerOptions['browser'];
    if (config.projectRoot === undefined) {
      // Unconfigured setup runtime: loopback listener, static assets, auth
      // seams and health/status only. The Phase-1B setup/admin API mounts
      // here; no project session or provider is constructed.
      browser = undefined;
    } else {
      const projectId = config.projectId ?? basename(config.projectRoot);
      const displayName = config.displayName ?? basename(config.projectRoot);
      if (
        config.provider === 'ai-sdk' &&
        config.providerOverride === undefined &&
        !(await provider.hasCredential())
      ) {
        throw new HostProviderError(
          'PROVIDER_CREDENTIAL_UNAVAILABLE',
          'No stored AI provider credential for this Host; complete setup or import a credential before opening a project',
        );
      }
      const loader = new FileProjectSourceLoader();
      const source = loader.load(config.projectRoot);
      const runtime = createProjectCoreRuntime({
        projectId,
        services: createFileCoreRuntimeServices(config.projectRoot, {
          provider: await provider.create(),
        }),
      });
      const sessions = createProjectSessionRegistry();
      const session = sessions.open({
        projectId,
        runtime,
        capabilities,
        audit: { record: async () => undefined },
        initialSource: source,
      });
      await persistence.client.request('upsertProject', {
        projectId,
        displayName,
        rootLabel: basename(config.projectRoot),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const project = await persistence.client.request('getProject', { projectId });
      const users = {
        loadUser: async (userId: string) => {
          const user = await persistence.client.request('loadUser', { userId });
          return user
            ? {
                userId: user.userId,
                role: user.role,
                displayName: user.displayName,
                capabilityVersion: user.capabilityVersion,
                createdAt: user.createdAt,
                updatedAt: user.updatedAt,
              }
            : null;
        },
      };
      const principal = createBrowserPrincipalResolver({ sessions: auth, users });
      const catalog = {
        listProjects: async (
          _p: BrowserSessionPrincipalV1,
        ): Promise<readonly BrowserProjectSummaryV1[]> => {
          const rows = await persistence.client.request('listProjects', undefined);
          return rows.map((row) => ({
            version: BROWSER_API_VERSION,
            projectId: row.projectId,
            displayName: row.displayName,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            open: sessions.get(row.projectId) !== null,
          }));
        },
      };
      browser = {
        principal,
        authorization: {
          canAccessProject: async (_userId: string, id: string) => id === projectId,
        },
        catalog,
        overview: {
          loadOverview: async (id: string) =>
            id !== projectId || !project
              ? null
              : {
                  version: 1 as const,
                  projectId: id,
                  metadata: {
                    displayName: project.displayName,
                    createdAt: project.createdAt,
                    updatedAt: project.updatedAt,
                  },
                  projection: session.projection,
                  activity: { busy: session.busy, hasHumanPresence: session.hasHumanPresence },
                  generatedAt: new Date().toISOString(),
                },
        },
        graph: {
          project: async (id: string, selector: Parameters<typeof projectCanonicalGraphRuntime>[1]) => {
            if (id !== projectId || session.source === null)
              throw new Error('project unavailable');
            return projectCanonicalGraphRuntime(session.source, selector);
          },
        },
        source: {
          loadSourceStudio: async (id: string): Promise<SourceStudioStateV1 | null> =>
            id !== projectId
              ? null
              : {
                  version: 1,
                  projectId: id,
                  accepted: session.projection,
                  working: {
                    documents: source.documents.map((d) => ({
                      projectId: id,
                      documentId: d.logicalPath,
                      kind: 'raw-yaml' as const,
                      available: false,
                    })),
                  },
                  generatedAt: new Date().toISOString(),
                },
        },
      };
    }

    const hostServer = createHostServer({ ...config, browser });
    host = hostServer;
    hostServer.registerPublicAuthPostRoute('/api/v1/auth/login', async (c) => {
      const body = await bodyObject(c.req.raw);
      if (typeof body?.userId !== 'string' || typeof body.password !== 'string')
        return json({ error: 'invalid_credentials' }, 401);
      const result = await auth.authenticate({ userId: body.userId, password: body.password });
      return result.ok
        ? sessionResponse(result.session.sessionId, result.session.userId)
        : json({ error: 'invalid_credentials' }, 401);
    });
    hostServer.registerPublicAuthPostRoute('/api/v1/auth/bootstrap', async (c) => {
      if (!config.allowBootstrap) return json({ error: 'bootstrap_disabled' }, 403);
      const body = await bodyObject(c.req.raw);
      if (typeof body?.password !== 'string' || body.password.length < 12)
        return json({ error: 'invalid_bootstrap' }, 400);
      try {
        const result = await auth.bootstrapOwner({
          password: body.password,
          displayName: typeof body.displayName === 'string' ? body.displayName : 'Owner',
        });
        return sessionResponse(result.session.sessionId, result.user.userId);
      } catch {
        return json({ error: 'bootstrap_unavailable' }, 409);
      }
    });
    if (assetsRoot !== null) {
      const root = assetsRoot;
      hostServer.registerPublicStaticRoute('/*', (c) => staticHandler(c.req.raw, root));
    }
    const handle = await hostServer.start();
    const endpoint =
      handle.mode === 'unix'
        ? `http+unix://${handle.address}`
        : `http://${handle.host}:${handle.port}`;
    return {
      host: hostServer,
      endpoint,
      projectId:
        config.projectRoot === undefined ? null : (config.projectId ?? basename(config.projectRoot)),
      auth,
      provider,
      close: async () => {
        await hostServer.close();
        await persistence.dispose();
      },
    };
  } catch (error) {
    // Partial-launch failure: dispose the worker (bounded terminate) and any
    // already-created server so no thread or port survives the failed start.
    await host?.close().catch(() => undefined);
    await persistence.dispose();
    throw error;
  }
}

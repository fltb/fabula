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
import type { AuthoringActivityEventV1 } from '../contracts/authoring.js';
import {
  BROWSER_API_VERSION,
  type BrowserProjectSummaryV1,
  type BrowserSessionPrincipalV1,
} from '../contracts/browser-api.js';
import type {
  WorkbenchConfigurationV1,
  WorkbenchProjectConfigurationV1,
} from '../contracts/configuration.js';
import type {
  PersistenceOperation,
  PersistencePayloads,
  PersistenceResults,
} from '../contracts/persistence.js';
import type { SourceStudioStateV1 } from '../contracts/source-studio.js';
import type { PersistenceMessagePort, PersistenceResponse } from '../persistence/messages.js';
import { PersistenceWorkerClient } from '../persistence/worker-client.js';
import { createAdminApi } from './admin-api.js';
import {
  AgentCapabilityService,
  AgentTaskService,
  createAgentCommandService,
  createAgentDurableAudit,
  createAgentSuggestionService,
  createCapabilityPersistence,
  createDurableAuditSink,
} from './agent/index.js';
import { createAuthPersistence, LocalAuthService } from './auth/index.js';
import { createMcpAuthoringCoordinatorPort } from './authoring/mcp-adapter.js';
import {
  createProjectAuthoringRuntime,
  type ProjectAuthoringRuntime,
} from './authoring/project-runtime.js';
import {
  createProjectAuthoringTreeWatcher,
  type ProjectAuthoringTreeWatcher,
} from './authoring/project-tree-watcher.js';
import type { AuthoringCoordinatorEvent } from './authoring/types.js';
import { type BrowserAgentProject, createBrowserAgentApi } from './browser-agent-api.js';
import {
  type BrowserAuthoringEventSource,
  createBrowserAuthoringApi,
} from './browser-authoring-api.js';
import { createBrowserPrincipalResolver } from './browser-read-api.js';
import { ConfigurationFileStore } from './configuration-file-store.js';
import { ConfigurationChangeService } from './configuration-service.js';
import { createProjectCoreRuntime } from './core-runtime.js';
import { projectCanonicalGraphRuntime } from './graph-projection.js';
import {
  createDeviceVerifierPersistence,
  createMcpAuthorizationPort,
  createMcpDevicePairingService,
  createMcpStreamableEndpoint,
  createProjectSessionMcpRegistry,
} from './mcp/index.js';
import { createProjectSession, createProjectSessionRegistry } from './project-session.js';
import { HostProviderError, HostProviderFactory } from './provider-factory.js';
import { createProviderCredentialStore } from './providers/index.js';
import { createHostServer, type HostServer, type HostServerOptions } from './server.js';
import { createSetupApi, createSetupStatusBuilder } from './setup-api.js';
import { createWorkbenchRuntime } from './workbench-runtime.js';
import {
  createSessionAuthPort,
  createYjsPersistencePort,
  createYjsWorkingDocumentCore,
} from './yjs/index.js';

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
  if (
    config.projectRoot === undefined &&
    (config.lan === true || config.unixSocket !== undefined)
  ) {
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
      projectRoot === undefined
        ? undefined
        : (opt(env.WORKBENCH_PROJECT_ID) ?? basename(projectRoot)),
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
    config.configurationService === undefined ? null : await config.configurationService.load();

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
  let disposeAuthoringRuntimes: (() => Promise<void>) | undefined;
  try {
    const auth = new LocalAuthService({ persistence: createAuthPersistence(persistence.client) });
    const capabilities = new AgentCapabilityService({
      persistence: createCapabilityPersistence(persistence.client),
    });
    const sessions = createProjectSessionRegistry();
    const configurationStore = new ConfigurationFileStore({
      filePath: join(config.hostHome, 'config', 'workbench.yaml'),
    });
    const configurationService = new ConfigurationChangeService({
      store: configurationStore,
      isProjectBusy: (projectId) => sessions.get(projectId)?.busy ?? false,
      operations: {
        record: (operation) =>
          persistence.client
            .request('createConfigurationOperation', {
              ...operation,
              changedFields: [...operation.changedFields],
              diagnostics: operation.diagnostics.map((diagnostic) => ({ ...diagnostic })),
            })
            .then(() => undefined),
      },
    });
    const storedConfiguration = await configurationService.readActive().catch(() => null);
    const activeConfiguration = configuration ?? storedConfiguration?.configuration ?? null;

    // Host-only provider construction: the API key is read exclusively from
    // the credential store and passed as an explicit AI SDK option; the
    // factory never consults process environment keys.
    const credentialStore = createProviderCredentialStore();
    const provider = new HostProviderFactory({
      store: credentialStore,
      configuration: activeConfiguration?.provider ?? null,
      override:
        config.providerOverride ?? (config.provider === 'mock' ? new MockProvider() : undefined),
    });
    const configuredProjects: readonly WorkbenchProjectConfigurationV1[] =
      activeConfiguration?.projects ??
      (config.projectRoot === undefined
        ? []
        : [
            {
              projectId: config.projectId ?? basename(config.projectRoot),
              displayName: config.displayName ?? basename(config.projectRoot),
              root: config.projectRoot,
            },
          ]);
    const providerReady =
      config.providerOverride !== undefined ||
      config.provider === 'mock' ||
      (activeConfiguration?.provider !== null && (await provider.hasCredential()));
    const unavailableProvider: LLMProvider = {
      name: 'workbench-provider-unavailable',
      complete: async () => {
        throw new HostProviderError(
          'PROVIDER_CREDENTIAL_UNAVAILABLE',
          'The Host provider is not configured. Complete provider setup before rendering or requesting an Agent proposal.',
        );
      },
    };
    const runtimeProvider = providerReady ? await provider.create() : unavailableProvider;
    const audit = createAgentDurableAudit({ client: persistence.client });
    const projectConfiguration = new Map<string, WorkbenchProjectConfigurationV1>();
    const yjsPersistence = createYjsPersistencePort(persistence.client);
    const yjsCore = createYjsWorkingDocumentCore({ persistence: yjsPersistence });
    const authoring = new Map<string, ProjectAuthoringRuntime>();
    const authoringWatchers = new Map<string, ProjectAuthoringTreeWatcher>();
    disposeAuthoringRuntimes = async () => {
      for (const watcher of authoringWatchers.values()) watcher.dispose();
      authoringWatchers.clear();
      for (const runtime of authoring.values()) await runtime.dispose();
      authoring.clear();
    };
    const agentProjects = new Map<string, BrowserAgentProject>();
    const listeners = new Map<string, Set<(event: AuthoringActivityEventV1) => void>>();
    const eventSource: BrowserAuthoringEventSource = {
      subscribe(projectId, listener) {
        const current = listeners.get(projectId) ?? new Set();
        current.add(listener);
        listeners.set(projectId, current);
        return () => {
          current.delete(listener);
          if (current.size === 0) listeners.delete(projectId);
        };
      },
    };
    const publishAuthoringEvent = (event: AuthoringCoordinatorEvent): void => {
      const subscribers = listeners.get(event.projectId);
      if (subscribers === undefined || event.type === 'submit-receipt') return;
      const safe: AuthoringActivityEventV1 = { ...event, version: 1 };
      for (const listener of subscribers) listener(safe);
    };
    const agentTasks = providerReady ? new AgentTaskService({ provider: runtimeProvider }) : null;

    /**
     * One lifecycle owns each project's session, Yjs working store, observer,
     * controlled Git submission service and optional Agent service. Browser,
     * MCP and Yjs resolve these maps only after this factory resolves.
     */
    const runtimeLifecycle = createWorkbenchRuntime({
      registry: sessions,
      createSession: async (project) => {
        const source = new FileProjectSourceLoader().load(project.root);
        const coreRuntime = createProjectCoreRuntime({
          projectId: project.projectId,
          services: createFileCoreRuntimeServices(project.root, { provider: runtimeProvider }),
        });
        const session = createProjectSession({
          projectId: project.projectId,
          runtime: coreRuntime,
          capabilities,
          audit: createDurableAuditSink(audit),
          initialSource: source,
        });
        const now = new Date().toISOString();
        const existing = await persistence.client.request('getProject', {
          projectId: project.projectId,
        });
        await persistence.client.request('upsertProject', {
          projectId: project.projectId,
          displayName: project.displayName,
          rootLabel: basename(project.root),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        });
        const projectAuthoring = await createProjectAuthoringRuntime({
          projectId: project.projectId,
          projectRoot: project.root,
          hostStagingRoot: join(config.hostHome, 'staging', project.projectId),
          session,
          capabilities,
          persistence: persistence.client,
          yjsCore,
          events: { publish: publishAuthoringEvent },
        });
        let authoringWatcher: ProjectAuthoringTreeWatcher;
        try {
          authoringWatcher = createProjectAuthoringTreeWatcher({
            projectRoot: project.root,
            onChange: (input) => projectAuthoring.observer.notify(input).then(() => undefined),
          });
        } catch (error) {
          await projectAuthoring.dispose();
          throw error;
        }
        authoring.set(project.projectId, projectAuthoring);
        authoringWatchers.set(project.projectId, authoringWatcher);
        projectConfiguration.set(project.projectId, project);
        if (agentTasks !== null) {
          const command = createAgentCommandService({
            session,
            documents: projectAuthoring.documents,
            presence: { isHumanEditing: () => session.hasHumanPresence },
          });
          agentProjects.set(project.projectId, {
            projectId: project.projectId,
            documents: projectAuthoring.documents,
            suggestions: createAgentSuggestionService({
              documents: projectAuthoring.documents,
              tasks: agentTasks,
              command,
              presence: { isHumanEditing: () => session.hasHumanPresence },
            }),
            async issueCapability(input) {
              const issued = await capabilities.issue({
                userId: input.principal.userId,
                projectId: project.projectId,
                scopes: ['mcp:author'],
              });
              return { capabilityId: issued.grant.capabilityId, scopes: issued.grant.scopes };
            },
          });
        }
        return session;
      },
      closeSession: async (session) => {
        agentProjects.delete(session.projectId);
        const authoringWatcher = authoringWatchers.get(session.projectId);
        authoringWatchers.delete(session.projectId);
        authoringWatcher?.dispose();
        const projectAuthoring = authoring.get(session.projectId);
        authoring.delete(session.projectId);
        await projectAuthoring?.dispose();
      },
    });
    await runtimeLifecycle.sync(configuredProjects);

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
    const authorization = {
      canAccessProject: async (_userId: string, projectId: string) =>
        sessions.get(projectId) !== null,
    };
    const catalog = {
      listProjects: async (
        _principal: BrowserSessionPrincipalV1,
      ): Promise<readonly BrowserProjectSummaryV1[]> => {
        const rows = await persistence.client.request('listProjects', undefined);
        const active = await configurationService.readActive();
        const configuredIds = new Set(
          (active?.configuration.projects ?? configuredProjects).map(
            (project) => project.projectId,
          ),
        );
        return rows
          .filter((row) => configuredIds.has(row.projectId))
          .map((row) => ({
            version: BROWSER_API_VERSION,
            projectId: row.projectId,
            displayName: row.displayName,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            open: sessions.get(row.projectId) !== null,
          }));
      },
    };
    const browser: HostServerOptions['browser'] =
      configuredProjects.length === 0
        ? undefined
        : {
            principal,
            authorization,
            catalog,
            overview: {
              loadOverview: async (projectId) => {
                const session = sessions.get(projectId);
                const project = projectConfiguration.get(projectId);
                const record = await persistence.client.request('getProject', { projectId });
                if (session === null || project === undefined || record === null) return null;
                return {
                  version: 1 as const,
                  projectId,
                  metadata: {
                    displayName: project.displayName,
                    createdAt: record.createdAt,
                    updatedAt: record.updatedAt,
                  },
                  projection: session.projection,
                  activity: { busy: session.busy, hasHumanPresence: session.hasHumanPresence },
                  generatedAt: new Date().toISOString(),
                };
              },
            },
            graph: {
              project: async (
                projectId,
                selector: Parameters<typeof projectCanonicalGraphRuntime>[1],
              ) => {
                const session = sessions.get(projectId);
                if (session === null || session.source === null)
                  throw new Error('project unavailable');
                return projectCanonicalGraphRuntime(session.source, selector);
              },
            },
            source: {
              loadSourceStudio: async (projectId): Promise<SourceStudioStateV1 | null> => {
                const session = sessions.get(projectId);
                const runtime = authoring.get(projectId);
                if (session === null || runtime === undefined) return null;
                return {
                  version: 1,
                  projectId,
                  accepted: session.projection,
                  working: {
                    documents: runtime.documents.descriptors().map((document) => ({
                      projectId,
                      documentId: document.documentId,
                      kind: document.kind,
                      available: document.available,
                    })),
                  },
                  generatedAt: new Date().toISOString(),
                };
              },
            },
          };
    const yjs =
      configuredProjects.length === 0
        ? undefined
        : {
            persistence: yjsPersistence,
            sessions,
            core: yjsCore,
            auth: createSessionAuthPort({
              sessions: auth,
              canAccessProject: authorization.canAccessProject,
              isValidDocument: (projectId, documentId) =>
                authoring.get(projectId)?.documents.descriptor(documentId) !== null,
            }),
          };

    const devices = createMcpDevicePairingService({
      persistence: createDeviceVerifierPersistence(persistence.client),
    });
    const defaultProjectId =
      activeConfiguration?.defaultProjectId ?? configuredProjects[0]?.projectId ?? null;
    const defaultSession = defaultProjectId === null ? null : sessions.get(defaultProjectId);
    const defaultAuthoring =
      defaultProjectId === null ? undefined : authoring.get(defaultProjectId);
    const mcp =
      defaultSession === null || defaultAuthoring === undefined
        ? undefined
        : {
            endpoint: createMcpStreamableEndpoint({
              registry: createProjectSessionMcpRegistry(defaultSession, {
                coordinator: createMcpAuthoringCoordinatorPort({
                  session: defaultSession,
                  coordinator: defaultAuthoring.coordinator,
                  documents: defaultAuthoring.documents,
                  capabilities,
                }),
                admin: {
                  async preview(request) {
                    const active = await configurationService.readActive();
                    if (active?.revision !== request.expectedRevision) {
                      return {
                        status: 'stale',
                        activeRevision: active?.revision ?? null,
                        candidateRevision: null,
                        changedFields: ['configuration'],
                        diagnostics: [
                          { code: 'CONFIG_STALE', message: 'Configuration revision changed.' },
                        ],
                      };
                    }
                    const validation = await configurationService.validateCandidate(
                      request.configuration,
                    );
                    return validation.ok
                      ? {
                          status: 'applied',
                          activeRevision: active?.revision ?? null,
                          candidateRevision: validation.revision,
                          changedFields: [],
                          diagnostics: [],
                        }
                      : {
                          status: 'invalid',
                          activeRevision: active?.revision ?? null,
                          candidateRevision: null,
                          changedFields: [],
                          diagnostics: [...validation.diagnostics],
                        };
                  },
                  apply: (request) =>
                    configurationService.apply({
                      candidate: request.configuration,
                      expectedRevision: request.expectedRevision,
                      origin: 'mcp',
                    }),
                },
              }),
              authorization: createMcpAuthorizationPort({
                sessions: auth,
                capabilities,
                devices,
                owner: {
                  loadOwner: () => persistence.client.request('loadOwner', undefined),
                },
              }),
            }),
          };

    const hostServer = createHostServer({
      ...config,
      browser,
      ...(yjs === undefined ? {} : { yjs }),
      ...(mcp === undefined ? {} : { mcp }),
    });
    host = hostServer;
    const setupStatus = createSetupStatusBuilder({
      configuration: configurationService,
      credentials: credentialStore,
      auth,
      listenerMode: () => hostServer.status().mode,
      runtime: runtimeLifecycle,
    });
    createSetupApi({
      configuration: configurationService,
      credentials: credentialStore,
      auth,
      listenerMode: () => hostServer.status().mode,
      runtime: runtimeLifecycle,
    }).register(hostServer);
    createAdminApi({
      resolver: principal,
      configuration: configurationService,
      auth,
      credentials: credentialStore,
      devices: {
        createPairing: (input) => devices.createPairing(input),
        claim: (input) =>
          devices.claim({
            pairingCode: input.pairingCode,
            clientLabel: input.label,
            scopes: input.scopes,
            ttlMs: input.ttlMs,
          }),
        listDevices: () => devices.listDevices(),
        revoke: (deviceId, revokedAt) => devices.revoke(deviceId, revokedAt),
      },
      operations: {
        async list({ limit }) {
          const [configuration, audit] = await Promise.all([
            persistence.client.request('listConfigurationOperations', { limit }),
            persistence.client.request('listAudit', { limit }),
          ]);
          return { configuration, audit };
        },
      },
      runtime: runtimeLifecycle,
      status: setupStatus,
      loadOwnerProfile: async () => {
        const owner = await persistence.client.request('loadOwner', undefined);
        return owner === null
          ? null
          : {
              displayName: owner.displayName,
              capabilityVersion: owner.capabilityVersion,
            };
      },
      listenerStatus: () => {
        const status = hostServer.status();
        return { mode: status.mode, port: status.port };
      },
      unixSocketDir: join(config.hostHome, 'sockets'),
    }).register(hostServer);
    if (configuredProjects.length > 0) {
      createBrowserAuthoringApi({
        principal,
        authorization,
        catalog,
        coordinators: {
          get: (projectId) => authoring.get(projectId)?.coordinator ?? null,
        },
        capabilities: {
          async resolve(input) {
            const issued = await capabilities.issue({
              userId: input.principal.userId,
              projectId: input.projectId,
              scopes: ['mcp:submit'],
            });
            return { capabilityId: issued.grant.capabilityId, scopes: issued.grant.scopes };
          },
        },
        events: eventSource,
      }).register(hostServer);
    }
    if (agentProjects.size > 0) {
      createBrowserAgentApi({
        principal,
        authorization,
        catalog,
        projects: {
          get: (projectId) => agentProjects.get(projectId) ?? null,
        },
      }).register(hostServer);
    }
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
      projectId: activeConfiguration?.defaultProjectId ?? configuredProjects[0]?.projectId ?? null,
      auth,
      provider,
      close: async () => {
        await disposeAuthoringRuntimes?.();
        configurationService.dispose();
        await hostServer.close();
        await persistence.dispose();
      },
    };
  } catch (error) {
    // Partial-launch failure: dispose the worker (bounded terminate) and any
    // already-created server so no thread or port survives the failed start.
    await disposeAuthoringRuntimes?.().catch(() => undefined);
    await host?.close().catch(() => undefined);
    await persistence.dispose();
    throw error;
  }
}

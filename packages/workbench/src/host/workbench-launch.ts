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

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  type LLMProvider,
  PluginExtensionSchemaRegistrar,
  type ProjectSourceSnapshotV1,
} from '@novalistically/core';
import {
  activateNodePlugins,
  createDeterministicMockProvider,
  createFileCoreRuntimeServices,
  FileProjectSourceLoader,
  FileProjectStatusReporter,
  type NodePluginActivationResult,
  PluginIdentityMismatchError,
  type ProjectAuthorityTokenV1,
  ProjectWriteCoordinator,
  shutdownNodePlugins,
} from '@novalistically/node-host';
import {
  DEFAULT_WORKBENCH_AGENT_CONFIGURATION,
  DEFAULT_WORKBENCH_NETWORK,
  DEFAULT_WORKBENCH_OPERATION_LIMITS,
  DEFAULT_WORKBENCH_REFERENCE_LIMITS,
  DEFAULT_WORKBENCH_RENDER_POLICY,
  type WorkbenchReferenceLimitsV1,
} from '@novalistically/workbench-protocol';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  AUTHORING_CONTRACT_VERSION,
  type AuthoringActivityEventV1,
} from '../contracts/authoring.js';
import type {
  BrowserProjectSummaryV1,
  BrowserSessionPrincipalV1,
  WorkbenchProjectFeatureV1,
} from '../contracts/browser-api.js';
import type { SceneAdoptionViewV1 } from '../contracts/scene.js';
import type {
  ConfigChangeRequestV1,
  ConfigOperationReceiptV1,
  WorkbenchConfigurationV1,
  WorkbenchDeviceSafeViewV1,
  WorkbenchInviteSafeViewV1,
  WorkbenchProjectConfigurationV1,
  WorkbenchProjectSafeViewV1,
} from '../contracts/configuration.js';
import { PROJECT_ACCESS_ROLE_GRANTS } from '../contracts/configuration.js';
import type {
  CapabilityState,
  InviteState,
  McpDeviceVerifierReadState,
  PersistenceOperation,
  PersistencePayloads,
  PersistenceResults,
} from '../contracts/persistence.js';
import type { SourceStudioStateV1 } from '../contracts/source-studio.js';
import { createAgentStore } from '../persistence/agent-store.js';
import type { PersistenceMessagePort, PersistenceResponse } from '../persistence/messages.js';
import { createProjectOperationStore } from '../persistence/project-operation-store.js';
import { createProjectPublicationStore } from '../persistence/project-publication-store.js';
import { PersistenceWorkerClient } from '../persistence/worker-client.js';
import { createAdminApi, type PluginDiscoveryAdminPort } from './admin-api.js';
import {
  AgentCapabilityService,
  type AgentCapabilityGrant,
  createAgentDurableAudit,
  createCapabilityPersistence,
  createDurableAuditSink,
} from './agent/index.js';
import { createPiAgentModel } from './agent/pi-agent-model.js';
import { createProjectToolExecutor } from './agent/project-tool-executor.js';
import {
  createWorkbenchAgentRunService,
  type WorkbenchAgentRunService,
} from './agent/run-service.js';
import { createAuthPersistence, DEFAULT_SESSION_TTL_MS, LocalAuthService } from './auth/index.js';
import { projectCanonicalGraphRuntime } from './graph-projection.js';
import { receiptFromRecord } from './authoring/coordinator.js';
import {
  createBrowserAuthoringMutationPort,
  createMcpAuthoringCoordinatorPort,
} from './authoring/mcp-adapter.js';
import {
  createProjectAuthoringRuntime,
  type ProjectAuthoringRuntime,
} from './authoring/project-runtime.js';
import {
  createProjectAuthoringTreeWatcher,
  type ProjectAuthoringTreeWatcher,
} from './authoring/project-tree-watcher.js';
import type { AuthoringCoordinatorEvent } from './authoring/types.js';
import { createBrowserAgentChatApi } from './browser-agent-chat-api.js';
import {
  type BrowserAuthoringEventSource,
  createBrowserAuthoringApi,
} from './browser-authoring-api.js';
import { createBrowserPublicationApi } from './browser-publication-api.js';
import { createBrowserReferenceApi } from './browser-reference-api.js';
import { createBrowserPrincipalResolver } from './browser-read-api.js';
import { createBrowserSceneApi } from './browser-scene-api.js';
import { createBrowserReviewApi } from './browser-review-api.js';
import { ConfigurationFileStore } from './configuration-file-store.js';
import { type ActiveConfiguration, ConfigurationChangeService } from './configuration-service.js';
import { createProjectCoreRuntime } from './core-runtime.js';
import { prepareSceneAdoption } from './scene-adoption.js';
import { loadSceneDetail, loadSceneMap } from './scene-map-service.js';
import {
  createAdminMcpRegistry,
  createDeviceVerifierPersistence,
  createMcpAuthorizationPort,
  createMcpDevicePairingService,
  createMcpStreamableEndpoint,
  createProjectSessionMcpRegistry,
  MCP_ADMIN_SCOPE,
  MCP_AUTHOR_SCOPE,
  MCP_READ_SCOPE,
  MCP_REFERENCE_READ_SCOPE,
  MCP_REFERENCE_WRITE_SCOPE,
  MCP_RENDER_SCOPE,
  MCP_SUBMIT_SCOPE,
  type McpAdminPort,
  type McpDevicePairingService,
} from './mcp/index.js';
import { createWorkbenchReferencePort } from './mcp/reference-port.js';
import {
  createProjectOperationService,
  createRenderConcurrencyLimiter,
  type ProjectOperationService,
} from './operation-service.js';
import { createPluginDiscoveryPort } from './plugins/plugin-discovery.js';
import {
  createProjectAccessService,
  type ProjectAccessRequiredRole,
} from './project-access-service.js';
import {
  createProjectMembershipService,
  type DurableProjectMembershipService,
} from './project-membership-service.js';
import { createProjectSession, createProjectSessionRegistry } from './project-session.js';
import {
  HostProviderError,
  HostProviderFactory,
} from './provider-factory.js';
import { createProviderCredentialStore, providerCredentialKey } from './providers/index.js';
import {
  createProjectPublicationService,
  type ProjectPublicationService,
} from './publication/publication-service.js';
import { createHostReviewService, type HostReviewService } from './review/review-service.js';
import { createHostServer, type HostServer, type HostServerOptions } from './server.js';
import { createSetupApi, createSetupStatusBuilder, type SetupStatusBuilder } from './setup-api.js';
import {
  type CanonicalStateProjectionService,
  createCanonicalStateProjectionService,
  DEFAULT_SNAPSHOT_INTERVAL,
} from './state/canonical-state-projection.js';
import { createWorkbenchRuntime, type WorkbenchRuntime } from './workbench-runtime.js';
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
  /**
   * Test/dev-only built-in Agent model injection (e.g. a deterministic
   * tool-calling model for the parity fixture). Absent = production
   * construction from the project profile configuration + credential.
   */
  readonly agentModel?:
    | { readonly model: Model<Api>; readonly streamFn: StreamFn }
    | undefined;
  /**
  /** Test-only provider factory injection. Production composes the
   * credential-backed {@link HostProviderFactory}; a double injected here
   * replaces it entirely (including the default-profile admin validation
   * surface exposed on the launch handle).
   */
  readonly providerFactory?: HostProviderFactory;
  /**
   * Built-in Agent parity gate (plan 9.6). The deterministic parity matrix
   * test toggles this; it is NEVER hardcoded true in production. The
   * `agent-chat` capability is exposed only when the canonical
   * `agent.enabled` is true AND this flag is true. Defaults to false, so
   * the Agent surface stays fully hidden until the parity matrix passes.
   */
  readonly agentReady?: boolean | (() => boolean | Promise<boolean>);
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

/**
 * Project authority lease heartbeat TTL. Matches the coordinator default;
 * the launch passes it explicitly so the heartbeat interval stays in lockstep
 * with the lease expiry window.
 */
export const AUTHORITY_HEARTBEAT_TTL_MS = 30_000;

/**
 * Build identity recorded in each project's authority lease after the Host
 * listener is ready. Public routing/health data only — never a credential.
 */
const AUTHORITY_LEASE_BUILD = {
  version: 1 as const,
  packageId: '@novalistically/workbench',
  buildId: 'workbench',
  protocolVersion: 1,
};

/**
 * Health probe used to reclaim an expired lease: probe the recorded endpoint
 * of the *previous* authority holder. An unrecorded or unreachable endpoint
 * counts as a failed probe so a stale lease can be reclaimed instead of
 * wedging the project forever.
 */
function authorityHealthProbe(lease: { readonly endpoint?: string }): Promise<boolean> {
  if (lease.endpoint === undefined || lease.endpoint === '') return Promise.resolve(false);
  return fetch(`${lease.endpoint}/health`)
    .then((response) => response.ok)
    .catch(() => false);
}

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
    path.startsWith('/mcp/') ||
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
 * Mock-mode reference fixture dirs for one project root, in lookup order.
 * The canonical fixture layout is `<root>/reference/data/<eventId>.json`;
 * a bare `<root>/reference/` layout is supported as a fallback. Missing
 * dirs are skipped by the deterministic mock (generated fallback only).
 */
function mockReferenceDirs(projectRoot: string): readonly string[] {
  return [join(projectRoot, 'reference', 'data'), join(projectRoot, 'reference')];
}

/**
 * Resolve the built-in Agent parity flag (plan 9.6). The parity matrix test
 * toggles the injection point; production keeps the default `false` so the
 * Agent surface stays fully hidden until parity passes. Never hardcoded true.
 */
async function resolveAgentReady(
  agentReady: boolean | (() => boolean | Promise<boolean>) | undefined,
): Promise<boolean> {
  if (agentReady === undefined) return false;
  if (typeof agentReady === 'boolean') return agentReady;
  const resolved = await agentReady();
  return resolved === true;
}

/**
 * Project intent flag `nova.yaml.plugins.enabled` (plan 7.1). Plugins are
 * only ever activated when the project explicitly enables them AND the
 * trustedPlugins allowlist matches the discovered identity exactly;
 * `enabled` is the gate, trust matching is the filter. A missing, unparsed
 * or non-boolean flag reads as disabled (fail closed).
 */
function pluginsEnabledIn(source: ProjectSourceSnapshotV1): boolean {
  const nova = source.documents.find((document) => document.logicalPath === 'nova.yaml');
  const parsed = nova?.parseResult.status === 'parsed' ? nova.parseResult.value : null;
  if (typeof parsed !== 'object' || parsed === null) return false;
  const plugins = (parsed as Record<string, unknown>).plugins;
  if (typeof plugins !== 'object' || plugins === null) return false;
  return (plugins as Record<string, unknown>).enabled === true;
}

/**
 * Project snapshot cadence from `nova.yaml.snapshotInterval` (plan 8.1). The
 * value must be a positive integer when present; absent projects fall back to
 * the canonical default of 10 events per snapshot.
 */
function readSnapshotInterval(source: ProjectSourceSnapshotV1): number {
  const nova = source.documents.find((document) => document.logicalPath === 'nova.yaml');
  const parsed = nova?.parseResult.status === 'parsed' ? nova.parseResult.value : null;
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SNAPSHOT_INTERVAL;
  const value = (parsed as Record<string, unknown>).snapshotInterval;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return DEFAULT_SNAPSHOT_INTERVAL;
  }
  return value;
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
  // Project write authority: one lease per project root, acquired before the
  // session bundle opens and heartbeat every TTL/3 once the listener is
  // ready. A second Host opening the same root is rejected while this lease
  // is authoritative, so the same project root can never be written by two
  // authorities even across different WORKBENCH_HOME directories. The state
  // and helpers live outside the try because the startup-failure path must
  // clear timers and release every acquired lease before rethrow (a catch
  // block cannot see try-local bindings).
  const instanceNonce = randomUUID();
  const coordinators = new Map<string, ProjectWriteCoordinator>();
  const authorityTokens = new Map<string, ProjectAuthorityTokenV1>();
  const heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** Public Host endpoint; null until the listener has started. */
  let hostEndpoint: string | null = null;

  /** One coordinator per project root, cached for the life of the Host. */
  const coordinatorFor = (project: {
    readonly projectId: string;
    readonly root: string;
  }): ProjectWriteCoordinator => {
    const existing = coordinators.get(project.projectId);
    if (existing !== undefined) return existing;
    const created = new ProjectWriteCoordinator(project.root, {
      projectId: project.projectId,
      heartbeatTtlMs: AUTHORITY_HEARTBEAT_TTL_MS,
      healthProbe: authorityHealthProbe,
    });
    coordinators.set(project.projectId, created);
    return created;
  };

  /** Refresh the lease every TTL/3 so it can never expire under a live Host. */
  const startHeartbeat = (
    projectId: string,
    coordinator: ProjectWriteCoordinator,
    token: ProjectAuthorityTokenV1,
  ): void => {
    if (heartbeatTimers.has(projectId)) return;
    const timer = setInterval(() => {
      void coordinator.heartbeat(token).catch(() => undefined);
    }, AUTHORITY_HEARTBEAT_TTL_MS / 3);
    heartbeatTimers.set(projectId, timer);
  };

  const stopHeartbeat = (projectId: string): void => {
    const timer = heartbeatTimers.get(projectId);
    if (timer === undefined) return;
    clearInterval(timer);
    heartbeatTimers.delete(projectId);
  };

  /**
   * Promote a project lease to `ready` and start its heartbeat. No-op before
   * the listener has an endpoint, and again after a project was already
   * marked (reopen path).
   */
  const markProjectReady = async (projectId: string): Promise<void> => {
    if (hostEndpoint === null) return;
    const coordinator = coordinators.get(projectId);
    const token = authorityTokens.get(projectId);
    if (coordinator === undefined || token === undefined) return;
    await coordinator.markReady(token, {
      endpoint: hostEndpoint,
      build: AUTHORITY_LEASE_BUILD,
    });
    startHeartbeat(projectId, coordinator, token);
  };

  /** Instance-CAS release; safe to call twice and for unacquired projects. */
  const releaseProjectAuthority = async (projectId: string): Promise<void> => {
    const coordinator = coordinators.get(projectId);
    if (coordinator === undefined) return;
    await coordinator.release(instanceNonce);
  };
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

    // renderPolicy threading lands with Stage 1.9 core wiring: the sampling
    // policy is available here as `activeConfiguration?.renderPolicy ??
    // DEFAULT_WORKBENCH_RENDER_POLICY`, but the per-session core render
    // runtime (createProjectCoreRuntime) is built in @novalistically/core
    // and does not accept it yet.

    // Built-in Agent parity gate (plan 9.6): the deterministic parity matrix
    // test toggles `agentReady`; production never hardcodes it true. The
    // `agent-chat` capability is derived only when the canonical
    // agent.enabled is true AND the parity flag.
    const agentReadyValue = await resolveAgentReady(config.agentReady);
    const agentChatEnabled =
      activeConfiguration?.agent.enabled === true && agentReadyValue === true;

    // Host-only provider construction: the API key is read exclusively from
    // the credential store and passed as an explicit AI SDK option; the
    // factory never consults process environment keys. One factory instance
    // serves the whole Host; runtime providers are built per project session
    // from that project's canonical `providerProfile`, so no two sessions
    // share one runtime provider instance. Mock mode
    // (`WORKBENCH_PROVIDER=mock`, no injected override) builds a fresh
    // deterministic mock PER PROJECT with that project's `reference/`
    // fixtures, so Pass-2 analysis is resolved per event instead of the old
    // bare shared MockProvider (whose default echo is non-JSON and blocked
    // every release).
    const credentialStore = createProviderCredentialStore();
    // Stage 2 swaps the constructor by `kind` ('pi' vs legacy 'ai-sdk');
    // both currently build through the same openai-compatible AiSdkProvider
    // path (the factory ignores `kind`), so 'pi' falls through unchanged.
    const provider =
      config.providerFactory ??
      new HostProviderFactory({
        store: credentialStore,
        configuration: activeConfiguration?.providers.default ?? null,
        override: config.providerOverride,
        overrideForProject:
          config.providerOverride === undefined && config.provider === 'mock'
            ? (projectRoot) =>
                createDeterministicMockProvider({ referenceDirs: mockReferenceDirs(projectRoot) })
            : undefined,
      });
    // Env prefill (WORKBENCH_PROJECT_ROOT/PROJECT_ID/DISPLAY_NAME) only
    // applies when activeConfiguration === null (unconfigured); once
    // workbench.yaml exists, env prefill is fully ignored:
    // `activeConfiguration?.projects` short-circuits the fallback below.
    const configuredProjects: readonly WorkbenchProjectConfigurationV1[] =
      activeConfiguration?.projects ??
      (config.projectRoot === undefined
        ? []
        : [
            {
              projectId: config.projectId ?? basename(config.projectRoot),
              displayName: config.displayName ?? basename(config.projectRoot),
              root: config.projectRoot,
              revisionMirror: { mode: 'disabled' },
              providerProfile: 'default',
              trustedPlugins: [],
            },
          ]);
    // Reference routes are mounted only after a durable Host-owned job/chunk
    // adapter is available; the portable manifest and objects remain under
    // each configured project root.
    const memberships = createProjectMembershipService(persistence.client);
    const projectAccess = createProjectAccessService({
      projects: async () => {
        const active = await configurationService.readActive();
        return (active?.configuration.projects ?? configuredProjects).map((project) => ({
          projectId: project.projectId,
          displayName: project.displayName,
        }));
      },
      ownerUserId: async () =>
        (await persistence.client.request('loadOwner', undefined))?.userId ?? null,
      isOpen: (projectId) => sessions.get(projectId) !== null,
    });

    // Built-in Agent principal grant (plan 9.6): the builtin caller's
    // capabilityId (`builtin:<projectId>:<userId>`, project-tool-executor
    // callerForRole) is validated by the session gate through the DURABLE
    // capability row on every phase. The parity-matrix harness persists the
    // identical row via `createCapabilityPersistence().upsertCapability`;
    // the launch issues it here for every owner/maintainer principal when
    // the `agent-chat` gate passes, so render prepare/commit (and every
    // capability-checked effect) is not DENIED for the built-in caller. The
    // version mirrors the user's durable `capabilityVersion` (the browser
    // principal binding) and the expiry mirrors the browser-session horizon.
    const capabilityPersistence = createCapabilityPersistence(persistence.client);
    const ensureBuiltinAgentGrants = async (projectId: string): Promise<void> => {
      const owner = await persistence.client.request('loadOwner', undefined).catch(() => null);
      const principals = new Map<string, number>();
      if (owner !== null) principals.set(owner.userId, owner.capabilityVersion);
      const members = await memberships.list({ projectId }).catch(() => []);
      for (const member of members) {
        if (member.role !== 'maintainer') continue;
        const user = await persistence.client
          .request('loadUser', { userId: member.userId })
          .catch(() => null);
        if (user !== null) principals.set(user.userId, user.capabilityVersion);
      }
      if (principals.size === 0) return;
      const scope = [...PROJECT_ACCESS_ROLE_GRANTS.maintainer.scopes];
      const expiresAt = new Date(Date.now() + DEFAULT_SESSION_TTL_MS).toISOString();
      for (const [userId, capabilityVersion] of principals) {
        const state: CapabilityState = {
          capabilityId: `builtin:${projectId}:${userId}`,
          userId,
          projectId,
          scope,
          version: capabilityVersion,
          expiresAt,
        };
        await capabilityPersistence.upsertCapability(state);
      }
    };

    const unavailableProvider: LLMProvider = {
      name: 'workbench-provider-unavailable',
      complete: async () => {
        throw new HostProviderError(
          'PROVIDER_CREDENTIAL_UNAVAILABLE',
          'The Host provider is not configured. Complete provider setup before rendering or requesting an Agent proposal.',
        );
      },
    };
    const audit = createAgentDurableAudit({ client: persistence.client });
    const projectConfiguration = new Map<string, WorkbenchProjectConfigurationV1>();
    const revisionMirrors = new Map(
      configuredProjects.map((project) => [project.projectId, project.revisionMirror] as const),
    );
    const yjsPersistence = createYjsPersistencePort(persistence.client);
    const yjsCore = createYjsWorkingDocumentCore({ persistence: yjsPersistence });
    const authoring = new Map<string, ProjectAuthoringRuntime>();
    const authoringWatchers = new Map<string, ProjectAuthoringTreeWatcher>();
    const statusReporters = new Map<string, FileProjectStatusReporter>();
    // Per-project trusted-plugin activation health (plan 7.3): the activation
    // result snapshot (hooks manager + active/blocked/disabled records) is
    // captured at open time, injected into the project Core runtime and
    // surfaced through `nova_status` blockers/guidance. Shutdown runs in
    // reverse registration order per project (the hooks manager's own
    // `shutdown()` reverses onUnload order).
    const pluginActivations = new Map<string, NodePluginActivationResult>();
    // Per-project enabled-plugin extension gate (plan 7.5): derived from the
    // activation's ACTIVE set only — disabled/unknown namespaces are source
    // errors, enabled namespaces validate structurally. Absent activation
    // (plugins never enabled) → no registrar → no extension diagnostics.
    const extensionRegistrarFor = (
      projectId: string,
    ): PluginExtensionSchemaRegistrar | undefined => {
      const activation = pluginActivations.get(projectId);
      if (activation === undefined || activation.active.length === 0) return undefined;
      return new PluginExtensionSchemaRegistrar(
        activation.active.map((plugin) => ({ name: plugin.name })),
      );
    };
    // Per-project durable operation service: FIFO render queue + cancel. The
    // host-wide render concurrency gate is shared by every project service so
    // `maxConcurrentRendersPerHost` is enforced across projects while each
    // project's own concurrency stays 1.
    const operationServices = new Map<string, ProjectOperationService>();
    // Per-project review/gate service over the append-only Core review stream.
    // One per project, constructed with the session + the durable operation
    // store so every review/gate mutation writes a ProjectOperationRecordV1.
    const reviewServices = new Map<string, HostReviewService>();
    // Per-project canonical state projection service (plan 8.1): one derived
    // per-source/route state stream + durable snapshots per project session;
    // disposed on close.
    const stateProjections = new Map<string, CanonicalStateProjectionService>();
    // Per-project publication service over the durable publication repository.
    // Publish runs as a `publish` operation through the project operation
    // service; the canonical refresh (plan 6.5) fires from the operation
    // completion and release-gate hooks below.
    const publicationServices = new Map<string, ProjectPublicationService>();
    // Per-project built-in Agent run service (plan 9.4): created only when
    // the `agent-chat` gate passes (canonical agent.enabled + model
    // tool-call support + parity flag); absent projects have no Agent route
    // at all.
    const agentRunServices = new Map<string, WorkbenchAgentRunService>();
    const operationLimits =
      activeConfiguration?.operationLimits ?? DEFAULT_WORKBENCH_OPERATION_LIMITS;
    const renderConcurrencyLimiter = createRenderConcurrencyLimiter(
      operationLimits.maxConcurrentRendersPerHost,
    );
    disposeAuthoringRuntimes = async () => {
      for (const service of operationServices.values()) await service.close();
      for (const service of agentRunServices.values()) service.close();
      agentRunServices.clear();
      operationServices.clear();
      reviewServices.clear();
      publicationServices.clear();
      for (const watcher of authoringWatchers.values()) watcher.dispose();
      authoringWatchers.clear();
      for (const runtime of authoring.values()) await runtime.dispose();
      authoring.clear();
      statusReporters.clear();
      // Shut down any activation whose session was never closed (e.g. a
      // mid-sync failure); per-project closeSession already shut down and
      // removed its own activation.
      for (const activation of pluginActivations.values()) {
        await shutdownNodePlugins(activation.hooksManager).catch(() => undefined);
      }
      pluginActivations.clear();
    };
    const listeners = new Map<string, Set<(event: AuthoringActivityEventV1) => void>>();
    const referenceLimitsFor = async (): Promise<WorkbenchReferenceLimitsV1> => {
      const current = await configurationService.readActive();
      return (
        current?.configuration.referenceLimits ??
        activeConfiguration?.referenceLimits ??
        DEFAULT_WORKBENCH_REFERENCE_LIMITS
      );
    };
    const referencesEnabled = (await referenceLimitsFor()).enabled;
    const referencePortFor = async (projectId: string) => {
      const project = projectConfiguration.get(projectId);
      if (project === undefined) return undefined;
      const referenceLimits = await referenceLimitsFor();
      if (!referenceLimits.enabled) return undefined;
      return createWorkbenchReferencePort({
        projectId,
        projectRoot: project.root,
        jobsRoot: join(config.hostHome, 'reference-jobs'),
        referenceLimits,
      });
    };
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
      publish(projectId, event) {
        // Post-persist broadcast (e.g. the browser cancel route after the
        // durable transition was written): listeners never see a state the
        // store does not already have.
        const subscribers = listeners.get(projectId);
        if (subscribers === undefined) return;
        for (const listener of subscribers) listener(event);
      },
    };
    const publishAuthoringEvent = (event: AuthoringCoordinatorEvent): void => {
      const subscribers = listeners.get(event.projectId);
      if (subscribers === undefined || event.type === 'submit-receipt') return;
      const safe: AuthoringActivityEventV1 = { ...event, version: AUTHORING_CONTRACT_VERSION };
      for (const listener of subscribers) listener(safe);
    };

    /**
     * One lifecycle owns each project's session, Yjs working store and
     * observer. Browser, MCP and Yjs resolve these maps only after this
     * factory resolves.
     */
    const runtimeLifecycle = createWorkbenchRuntime({
      registry: sessions,
      createSession: async (project) => {
        // The project authority lease must be held before the session bundle
        // (session, Core runtime, authoring runtime) is constructed: every
        // accepted source materialization runs under this token. A live or
        // healthy lease owned by another Host fails the open with the typed
        // authority-unavailable error and the project stays unopened.
        const coordinator = coordinatorFor(project);
        const authorityToken = await coordinator.acquireWorkbenchAuthority(instanceNonce);
        authorityTokens.set(project.projectId, authorityToken);
        // Per-project provider: the project's canonical `providerProfile`
        // selects the profile; the factory builds a fresh instance per
        // session. A construction failure (missing profile or credential)
        // degrades to the unavailable provider so the project still opens
        // read-only and renders fail with the typed provider error.
        const profileId =
          configuredProjects.find((entry) => entry.projectId === project.projectId)
            ?.providerProfile ?? 'default';
        const sessionProvider = await provider
          .createForProfile(profileId, activeConfiguration?.providers[profileId], project.root)
          .catch(() => unavailableProvider);
        const source = new FileProjectSourceLoader().load(project.root);
        // Trusted-plugin activation (plan 7.1-7.2): only when the project
        // intent flag `nova.yaml.plugins.enabled` is true do we attempt
        // activation, and only exact trustedPlugins name/version/moduleHash
        // matches load. A required identity mismatch keeps the project open
        // but records a blocking diagnostic: render/status report it and the
        // admin surface can fix the allowlist without a failed open.
        const trustedPlugins =
          configuredProjects.find((entry) => entry.projectId === project.projectId)
            ?.trustedPlugins ?? [];
        let pluginActivation: NodePluginActivationResult | null = null;
        if (pluginsEnabledIn(source)) {
          try {
            pluginActivation = await activateNodePlugins({
              projectRoot: project.root,
              trustedPlugins: trustedPlugins.map((entry) => ({
                name: entry.name,
                version: entry.version,
                moduleHash: entry.moduleHash,
                required: entry.required,
              })),
            });
          } catch (error) {
            if (error instanceof PluginIdentityMismatchError) {
              // Required allowlist entry failed identity verification: the
              // project stays open, render/status carry the blocking
              // diagnostic (plan 7.3), and no hooks manager exists.
              pluginActivation = {
                hooksManager: null,
                active: [],
                blocked: trustedPlugins.map((entry) => ({
                  name: entry.name,
                  reason: error.message,
                })),
                disabled: [],
              };
            } else {
              throw error;
            }
          }
          if (pluginActivation !== null) {
            pluginActivations.set(project.projectId, pluginActivation);
          }
        }
        // The project-private runtime artifact tree (execution repo, render
        // cache, state log) lives under the Host home; create it before the
        // file repositories realpath their root on first access.
        await mkdir(join(config.hostHome, 'projects', project.projectId, 'runtime'), {
          recursive: true,
        });
        const coreRuntime = createProjectCoreRuntime({
          projectId: project.projectId,
          services: createFileCoreRuntimeServices(project.root, {
            provider: sessionProvider,
            artifactRoot: join(config.hostHome, 'projects', project.projectId, 'runtime'),
          }),
          // Null (no hooks manager, e.g. a blocked activation) and undefined
          // (plugins never activated) both mean “no plugin runtime”.
          pluginHooksManager: pluginActivation?.hooksManager ?? undefined,
        });
        const session = createProjectSession({
          projectId: project.projectId,
          runtime: coreRuntime,
          capabilities,
          audit: createDurableAuditSink(audit),
          initialSource: source,
        });
        // Per-project canonical state projection service (plan 8.1): one
        // derived per-source/route stream per session, honoring the project
        // config's `nova.yaml.snapshotInterval`. Lazy: the first status/diff
        // query builds the stream and saves the durable snapshots through the
        // injected Core state repositories (the Host's derived runtime area).
        stateProjections.set(
          project.projectId,
          createCanonicalStateProjectionService({
            projectId: project.projectId,
            runtime: coreRuntime,
            snapshotInterval: readSnapshotInterval(source),
          }),
        );
        // Durable operation queue for this project (render/revise/render-tree
        // and publish/agent runs). The restart sweep marks queued/running
        // rows interrupted; LLM work is never auto-replayed. Accepted-scene
        // commits (render/revise/render-tree success) trigger the best-effort
        // canonical publication refresh (plan 6.5); a failing refresh degrades
        // the publication service without rolling back the accepted revision.
        const operationService = createProjectOperationService({
          projectId: project.projectId,
          store: createProjectOperationStore(persistence.client),
          session,
          limits: operationLimits,
          concurrencyLimiter: renderConcurrencyLimiter,
          onStatusChange: (record) => {
            // Store-first SSE (plan 4.7): the durable row was persisted before
            // this observer fires; broadcast the derived receipt to every
            // connected browser — ALL kinds (render/revise/render-tree/
            // publish/agent-run) and ALL status transitions (queued→running→
            // succeeded/failed/stale/cancelled/interrupted).
            publishAuthoringEvent({
              type: 'operation-updated',
              projectId: record.projectId,
              receipt: receiptFromRecord(record),
              at: record.updatedAt,
            });
            if (
              record.kind === 'render' ||
              record.kind === 'revise' ||
              record.kind === 'render-tree'
            ) {
              if (record.status === 'succeeded') {
                publicationServices
                  .get(record.projectId)
                  ?.refreshCanonical({ actorId: record.actorId, operationId: record.operationId })
                  .catch(() => undefined);
              }
            }
          },
        });
        await operationService.start();
        operationServices.set(project.projectId, operationService);
        // Durable publication service: publish enqueues a `publish` operation
        // through the queue above; refresh/status read the same repository.
        publicationServices.set(
          project.projectId,
          createProjectPublicationService({
            projectId: project.projectId,
            session,
            projectRoot: project.root,
            publicationStore: createProjectPublicationStore(persistence.client),
            operations: operationService,
          }),
        );
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
        const statusReporter = new FileProjectStatusReporter(project.root);
        const projectAuthoring = await createProjectAuthoringRuntime({
          projectId: project.projectId,
          projectRoot: project.root,
          hostStagingRoot: join(config.hostHome, 'staging', project.projectId),
          session,
          revisionMirror: revisionMirrors.get(project.projectId) ?? { mode: 'disabled' },
          capabilities,
          persistence: persistence.client,
          yjsCore,
          events: { publish: publishAuthoringEvent },
          coordinator,
          authorityToken,
          statusReporter,
          extensionRegistrar: extensionRegistrarFor(project.projectId),
        });
        statusReporters.set(project.projectId, statusReporter);
        // Review/gate service over the append-only Core review stream. Reads
        // are pure projections; mutations write durable 'review' /
        // 'release-gate' operation records under the caller grant.
        reviewServices.set(
          project.projectId,
          createHostReviewService({
            projectId: project.projectId,
            session,
            operationStore: createProjectOperationStore(persistence.client),
            // Store-first SSE (plan 4.7): review/release-gate records are
            // written directly to the durable queue (mirroring the authoring
            // coordinator), so the same post-persist broadcast keeps the
            // Operation Center live for those kinds too.
            onStatusChange: (record) => {
              publishAuthoringEvent({
                type: 'operation-updated',
                projectId: record.projectId,
                receipt: receiptFromRecord(record),
                at: record.updatedAt,
              });
            },
            // A gate resolution that promotes a candidate is an accepted-scene
            // commit: best-effort canonical publication refresh (plan 6.5).
            onGateAccepted: () => {
              publicationServices
                .get(project.projectId)
                ?.refreshCanonical()
                .catch(() => undefined);
            },
          }),
        );
        // Built-in Agent run service (plan 9.4): constructed only when the
        // `agent-chat` gate passes. The model is built per project from
        // the same profile configuration + credential the provider uses (the
        // credential stays inside the Host; only secret-free options cross).
        if (agentChatEnabled) {
          const profileConfig = activeConfiguration?.providers[profileId];
          // Production construction is credential-backed and may fail when no
          // key is stored yet: the project must still open — the Agent
          // surface simply stays absent for it (fail closed, feature derived
          // from registered services only). Tests/parity inject a
          // deterministic model; the pi defaults fill a missing baseUrl/model.
          let agentModel:
            | { readonly model: Model<Api>; readonly streamFn: StreamFn }
            | null = config.agentModel ?? null;
          if (agentModel === null) {
            try {
              agentModel = createPiAgentModel({
                baseURL: profileConfig?.baseUrl,
                apiKey:
                  (await credentialStore.get(providerCredentialKey(profileId)).catch(() => null)) ??
                  undefined,
                modelId: profileConfig?.model,
              });
            } catch {
              agentModel = null;
            }
          }
          if (agentModel !== null) {
            // Persist the built-in Agent principal's capability grant for
            // this project's owner/maintainer users (plan 9.6): the session
            // gate re-loads the row by capabilityId before every phase, and
            // without it render prepare/commit (and every
            // capability-checked effect) would be DENIED for the built-in
            // caller. Mirrors the parity-matrix harness row exactly.
            await ensureBuiltinAgentGrants(project.projectId);
            // The authoring runtime exists as this scope's local before the
            // session map is populated (authoring.set runs after the agent
            // branch), so reference the local — authoring.get() here would be
            // undefined and every authoring tool would fail PROJECT_NOT_READY.
            const projectAuthoringRuntime = projectAuthoring;
            const reviewService = reviewServices.get(project.projectId);
            const publicationService = publicationServices.get(project.projectId);
            const executor = createProjectToolExecutor(session, {
              family: 'project',
              operations: operationService,
              revision: projectAuthoringRuntime?.revision,
              stateProjection: stateProjections.get(project.projectId),
              extensionRegistrar: extensionRegistrarFor(project.projectId),
              coordinator:
                projectAuthoringRuntime === undefined
                  ? undefined
                  : createMcpAuthoringCoordinatorPort({
                      session,
                      coordinator: projectAuthoringRuntime.coordinator,
                      documents: projectAuthoringRuntime.documents,
                      capabilities,
                    }),
              ...(reviewService === undefined ? {} : { review: reviewService }),
              ...(publicationService === undefined ? {} : { publication: publicationService }),
              // Reference library tools (plan 3.8): threaded only while
              // referenceLimits.enabled — referencePortFor returns undefined
              // otherwise, preserving the registry's fail-closed filter.
              ...(await referencePortFor(project.projectId) === undefined
                ? {}
                : { reference: await referencePortFor(project.projectId) }),
            });
            const agentService = createWorkbenchAgentRunService({
              projectId: project.projectId,
              store: createAgentStore(persistence.client),
              executor,
              agentModel,
              operations: operationService,
              agent: {
                maxTurns: activeConfiguration?.agent.maxTurns ?? 16,
                maxToolCalls: activeConfiguration?.agent.maxToolCalls ?? 64,
              },
              // Workflow-completion gate (plan 9.4 hardening): once the
              // canonical publication is current, a tool-executing run is
              // force-terminated as succeeded instead of letting a
              // re-confirming agent burn remaining turns.
              isWorkflowComplete:
                publicationService === undefined
                  ? undefined
                  : async () =>
                      (await publicationService.workflowPublicationProjection()).status ===
                      'current',
            });
            await agentService.start();
            agentRunServices.set(project.projectId, agentService);
          }
        }
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
        // Projects opened after the listener started (admin reopen) are
        // promoted immediately; the initial sync is promoted after start.
        await markProjectReady(project.projectId);
        return session;
      },
      closeSession: async (session) => {
        // Drain/stop the project operation service before the authoring
        // runtime is torn down; no timers are left behind.
        await operationServices.get(session.projectId)?.close();
        operationServices.delete(session.projectId);
        const authoringWatcher = authoringWatchers.get(session.projectId);
        authoringWatchers.delete(session.projectId);
        authoringWatcher?.dispose();
        const projectAuthoring = authoring.get(session.projectId);
        authoring.delete(session.projectId);
        statusReporters.delete(session.projectId);
        reviewServices.delete(session.projectId);
        publicationServices.delete(session.projectId);
        agentRunServices.get(session.projectId)?.close();
        agentRunServices.delete(session.projectId);
        const stateProjection = stateProjections.get(session.projectId);
        stateProjections.delete(session.projectId);
        await stateProjection?.dispose().catch(() => undefined);
        await projectAuthoring?.dispose();
        // Plugin hooks shut down in reverse registration order after the
        // authoring runtime is torn down; a second close is a no-op because
        // the activation is removed from the map here.
        const pluginActivation = pluginActivations.get(session.projectId);
        pluginActivations.delete(session.projectId);
        await shutdownNodePlugins(pluginActivation?.hooksManager ?? null).catch(() => undefined);
        // Release the project authority on close so another Host (or a
        // standalone writer) can take over. Instance-CAS: safe even if the
        // lease was already released by the startup-failure path.
        stopHeartbeat(session.projectId);
        authorityTokens.delete(session.projectId);
        await releaseProjectAuthority(session.projectId).catch(() => undefined);
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
      canAccessProject: (
        userId: string,
        projectId: string,
        requiredRole: ProjectAccessRequiredRole = 'reader',
      ) => projectAccess.canAccessProject(userId, projectId, requiredRole),
    };
    const catalog = {
      listProjects: (
        current: BrowserSessionPrincipalV1,
      ): Promise<readonly BrowserProjectSummaryV1[]> => projectAccess.listProjects(current),
    };
    // Feature list derived ONLY from already-registered Host services: each
    // capability maps to a real mounted route (project home, source studio,
    // scene canvas, graph/route) plus the review MCP tools and status
    // projection (review-hub, plan Step 5) and the publication service + MCP
    // tools + browser publication routes (publication, plan Step 6.6).
    // agent-chat is derived only when the full gate passes (canonical
    // agent.enabled + tool-call-ready model + parity flag, plan 9.6); the
    const launchFeatures: readonly WorkbenchProjectFeatureV1[] = [
      'project-home',
      'source-studio',
      'scene-canvas',
      // Scene Map (plan 9.2): always-on like scene-canvas; the scene-map and
      // scene-detail read routes plus the scene render trigger mount under it.
      'scene-map',
      'graph-route',
      'review-hub',
      'publication',
      // References (plan 9.1): derived from referenceLimits.enabled, the same
      // gate the MCP reference port uses; disabled limits remove the feature
      // (and with it every browser reference route) for the whole Host.
      ...(referencesEnabled ? (['references'] as const) : []),
      ...(agentChatEnabled ? (['agent-chat'] as const) : []),
    ];
    const browser: HostServerOptions['browser'] =
      configuredProjects.length === 0
        ? undefined
        : {
            access: projectAccess,
            principal,
            authorization,
            catalog,
            capabilities: {
              loadCapabilities: async (projectId) => ({
                version: 1 as const,
                projectId,
                // Derived from registered services only: a project whose
                // Agent run service could not be constructed (e.g. missing
                // provider credential) never claims the capability.
                features: launchFeatures.filter(
                  (feature) => feature !== 'agent-chat' || agentRunServices.has(projectId),
                ),
              }),
            },
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
            // Reference library surface (plan 9.1): present only while
            // referenceLimits.enabled, so a disabled library registers no
            // read or mutation route at all (the feature also disappears).
            ...(referencesEnabled
              ? {
                  references: {
                    loadReferences: async (projectId, query) => {
                      const reference = await referencePortFor(projectId);
                      if (reference === undefined) return null;
                      const listed = await reference.list({ version: 1, ...query });
                      return {
                        version: 1,
                        projectId,
                        items: listed.items,
                        nextCursor: listed.nextCursor,
                      };
                    },
                    get: async (projectId, referenceId) => {
                      const reference = await referencePortFor(projectId);
                      if (reference === undefined) return null;
                      const result = await reference.get({ version: 1, referenceId });
                      return result === null
                        ? { version: 1, projectId, item: null }
                        : { version: 1, projectId, item: result.item };
                    },
                    readContent: async (projectId, referenceId, query) => {
                      const reference = await referencePortFor(projectId);
                      if (reference === undefined) return null;
                      const result = await reference.readContent({
                        version: 1,
                        referenceId,
                        offset: query.offset,
                        limit: query.limit,
                      });
                      return { version: 1, projectId, content: result.content };
                    },
                  },
                }
              : {}),
            // Scene Canvas adoption preview (plan 5.2): the route mounts only
            // under the `scene-canvas` feature (always-on today). The port
            // bridges the Host-only `prepareSceneAdoption` service, so the
            // preview is always derived from the persisted released revision
            // by the project session's Core execution repository.
            sceneAdoption: launchFeatures.includes('scene-canvas')
              ? {
                  prepare: async (input) => {
                    const session = sessions.get(input.projectId);
                    if (session === null) {
                      return {
                        ok: false as const,
                        code: 'REVISION_NOT_FOUND' as const,
                        message: 'The project session is not open.',
                      };
                    }
                    return prepareSceneAdoption(
                      { execution: session.runtime.services.execution },
                      input,
                    );
                  },
                }
              : undefined,
            // Scene Map surface (plan 9.2): the scene-map / scene-detail GET
            // routes mount under the `scene-map` feature (always-on). The
            // port derives every row from the session's accepted source, the
            // per-project canonical state projection (diff counts) and the
            // session's Core execution repository (accepted scene hashes).
            sceneMap: launchFeatures.includes('scene-map')
              ? {
                  loadSceneMap: async (projectId) => {
                    const session = sessions.get(projectId);
                    const projection = stateProjections.get(projectId);
                    if (session === null || projection === undefined) return null;
                    return loadSceneMap({
                      projectId,
                      session,
                      projection,
                      execution: session.runtime.services.execution,
                    });
                  },
                  loadSceneDetail: async (projectId, eventId) => {
                    const session = sessions.get(projectId);
                    const projection = stateProjections.get(projectId);
                    if (session === null || projection === undefined) {
                      return {
                        ok: false as const,
                        code: 'SCENE_UNAVAILABLE' as const,
                        message: 'The project session is not open.',
                      };
                    }
                    return loadSceneDetail({
                      projectId,
                      session,
                      projection,
                      execution: session.runtime.services.execution,
                      eventId,
                    });
                  },
                }
              : undefined,
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
    const setupStatus = createSetupStatusBuilder({
      configuration: configurationService,
      credentials: credentialStore,
      auth,
      listenerMode: () => hostServer.status().mode,
      runtime: runtimeLifecycle,
    });
    const defaultProjectId =
      activeConfiguration?.defaultProjectId ?? configuredProjects[0]?.projectId ?? null;
    const defaultSession = defaultProjectId === null ? null : sessions.get(defaultProjectId);
    const adminSession =
      defaultSession ??
      (configuredProjects.length > 0 ? sessions.get(configuredProjects[0].projectId) : null);
    // Trusted-plugin discovery (plan 7.7): project roots resolve from the
    // live active configuration (admin-added projects included) with a
    // fallback to the launch-time list. Discovery itself makes no trust
    // decision; it only reports on-disk name/version/moduleHash identities.
    const pluginDiscoveryPort: PluginDiscoveryAdminPort = createPluginDiscoveryPort({
      resolveProjectRoot: async (projectId) => {
        const active = await configurationService.readActive();
        const project =
          active?.configuration.projects.find((entry) => entry.projectId === projectId) ??
          configuredProjects.find((entry) => entry.projectId === projectId);
        return project?.root ?? null;
      },
    });
    const adminConfiguration: McpAdminPort = createLaunchAdminPort({
      configuration: configurationService,
      runtime: runtimeLifecycle,
      memberships,
      auth,
      devices,
      persistence: persistence.client,
      status: setupStatus,
      plugins: pluginDiscoveryPort,
    });
    const mcpAuthorization = createMcpAuthorizationPort({
      sessions: auth,
      access: projectAccess,
      capabilities,
      devices,
      owner: {
        loadOwner: () => persistence.client.request('loadOwner', undefined),
      },
    });
    const projectEndpoint =
      configuredProjects.length === 0
        ? null
        : createMcpStreamableEndpoint({
            route: 'project',
            authorization: mcpAuthorization,
            availableScopes: [
              MCP_READ_SCOPE,
              MCP_RENDER_SCOPE,
              MCP_AUTHOR_SCOPE,
              MCP_SUBMIT_SCOPE,
              MCP_REFERENCE_READ_SCOPE,
              MCP_REFERENCE_WRITE_SCOPE,
            ],
            projectIdResolver: (request) => {
              const pathname = new URL(request.url).pathname;
              const prefix = '/mcp/projects/';
              if (!pathname.startsWith(prefix)) return null;
              const encoded = pathname.slice(prefix.length);
              if (encoded.length === 0 || encoded.includes('/')) return null;
              try {
                const projectId = decodeURIComponent(encoded);
                return projectId.length === 0 || projectId.includes('/') ? null : projectId;
              } catch {
                return null;
              }
            },
            resolveRegistry: async (_request, projectId) => {
              // Lifecycle and ACL are gates before this callback is reached;
              // check open state before touching authoring or registry state.
              const session = sessions.get(projectId);
              if (session === null) return null;
              const projectAuthoring = authoring.get(projectId);
              if (projectAuthoring === undefined) return null;
              const reviewService = reviewServices.get(projectId);
              const publicationService = publicationServices.get(projectId);
              return createProjectSessionMcpRegistry(session, {
                family: 'project',
                operations: operationServices.get(projectId),
                revision: projectAuthoring.revision,
                stateProjection: stateProjections.get(projectId),
                coordinator: createMcpAuthoringCoordinatorPort({
                  session,
                  coordinator: projectAuthoring.coordinator,
                  documents: projectAuthoring.documents,
                  capabilities,
                }),
                // Plugin activation health (plan 7.3): a live accessor so
                // `nova_status` reports the current activation snapshot at
                // call time; null when plugins were never activated.
                ...(await referencePortFor(projectId) === undefined
                  ? {}
                  : { reference: await referencePortFor(projectId) }),
                plugins: () => pluginActivations.get(projectId) ?? null,
                // Enabled-plugin extension gate (plan 7.5) for the accepted-
                // source validation paths.
                extensionRegistrar: extensionRegistrarFor(projectId),
                ...(publicationService === undefined ? {} : { publication: publicationService }),
                ...(reviewService === undefined
                  ? {}
                  : {
                      review: reviewService,
                      // Live projections: `nova_status` reads the append-only
                      // review stream and the durable publication store at
                      // call time (plan Steps 5/6), never cached snapshots.
                      status: {
                        review: () => reviewService.workflowReviewProjection(),
                        ...(publicationService === undefined
                          ? {}
                          : {
                              publication: () => publicationService.workflowPublicationProjection(),
                            }),
                      },
                    }),
              });
            },
          });
    const adminEndpoint =
      adminSession === null
        ? null
        : createMcpStreamableEndpoint({
            route: 'admin',
            projectId: adminSession.projectId,
            authorization: mcpAuthorization,
            availableScopes: [MCP_ADMIN_SCOPE],
            registry: createAdminMcpRegistry(adminSession, { admin: adminConfiguration }),
          });
    const mcp =
      projectEndpoint === null
        ? adminEndpoint === null
          ? undefined
          : { endpoint: adminEndpoint, path: '/mcp/admin' }
        : {
            endpoint: projectEndpoint,
            path: '/mcp/projects/:projectId',
            ...(adminEndpoint === null
              ? {}
              : { routes: [{ path: '/mcp/admin', endpoint: adminEndpoint }] }),
          };

    // Unix-socket binding is a darwin/linux feature: reject it on Windows at
    // listener construction, covering both the env path (WORKBENCH_UNIX_SOCKET)
    // and an owner-configured `network.mode: "unix"`.
    if (
      process.platform === 'win32' &&
      (config.unixSocket !== undefined || activeConfiguration?.network.mode === 'unix')
    ) {
      throw new Error('network.mode "unix" is not supported on this platform');
    }
    const hostServer = createHostServer({
      ...config,
      browser,
      ...(yjs === undefined ? {} : { yjs }),
      ...(mcp === undefined ? {} : { mcp }),
    });
    host = hostServer;
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
      memberships,
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
      plugins: pluginDiscoveryPort,
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
        access: projectAccess,
        authorization,
        catalog,
        coordinators: {
          get: (projectId) => authoring.get(projectId)?.coordinator ?? null,
        },
        mutations: {
          get: (projectId) => {
            const session = sessions.get(projectId);
            const projectAuthoring = authoring.get(projectId);
            if (session === null || projectAuthoring === undefined) return null;
            return createBrowserAuthoringMutationPort({
              session,
              coordinator: projectAuthoring.coordinator,
              documents: projectAuthoring.documents,
              capabilities,
            });
          },
        },
        revision: {
          get: (projectId) => authoring.get(projectId)?.revision ?? null,
        },
        operations: {
          get: (projectId) => operationServices.get(projectId) ?? null,
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
      // Guarded publication surface (plan Step 6.6): catalog/get/bounded read
      // routes plus the publish trigger, all through ProjectPublicationService.
      createBrowserPublicationApi({
        principal,
        access: projectAccess,
        authorization,
        catalog,
        publications: {
          get: (projectId) => publicationServices.get(projectId) ?? null,
        },
        capabilities: {
          async resolve(input) {
            const issued = await capabilities.issue({
              userId: input.principal.userId,
              projectId: input.projectId,
              scopes: ['mcp:submit'],
            });
            return issued.grant;
          },
        },
      }).register(hostServer);
      // Guarded review surface (plan Step 5): comment list/get/add/update, the
      // safe event trail, and release-gate list/decide, all through the
      // per-project HostReviewService (durable 'review' / 'release-gate'
      // operation records under the caller grant). Comment mutations require
      // an `mcp:author` grant; gate decisions require `mcp:submit`.
      createBrowserReviewApi({
        principal,
        access: projectAccess,
        authorization,
        catalog,
        reviews: {
          get: (projectId) => reviewServices.get(projectId) ?? null,
        },
        capabilities: {
          async resolve(input) {
            const issued = await capabilities.issue({
              userId: input.principal.userId,
              projectId: input.projectId,
              scopes: [input.scope],
            });
            return issued.grant;
          },
        },
      }).register(hostServer);
      // Guarded scene render surface (plan 9.2.3): `POST /scenes/:eventId/render`
      // enqueues through the SAME `nova_render` tool the MCP endpoint serves —
      // the same durable operation queue, two-phase lane discipline, and
      // idempotency semantics. The trigger issues a real `mcp:render` grant
      // for the already-resolved browser actor; the browser never supplies an
      // actor, capability, or scope. Registered under the `scene-map` feature.
      if (launchFeatures.includes('scene-map')) {
        createBrowserSceneApi({
          principal,
          access: projectAccess,
          authorization,
          catalog,
          render: {
            trigger: async ({ projectId, eventId, userId }) => {
              const session = sessions.get(projectId);
              if (session === null) {
                return {
                  ok: false as const,
                  code: 'SCENE_RENDER_UNAVAILABLE' as const,
                  message: 'The project session is not open.',
                };
              }
              let grant: AgentCapabilityGrant;
              try {
                const issued = await capabilities.issue({
                  userId,
                  projectId,
                  scopes: [MCP_RENDER_SCOPE],
                });
                grant = issued.grant;
              } catch {
                return {
                  ok: false as const,
                  code: 'SCENE_RENDER_UNAVAILABLE' as const,
                  message: 'The render capability could not be issued.',
                };
              }
              const reference = await referencePortFor(projectId);
              const registry = createProjectSessionMcpRegistry(session, {
                family: 'project',
                operations: operationServices.get(projectId),
                ...(reference === undefined ? {} : { reference }),
              });
              const outcome = await registry.run(
                'nova_render',
                { sessionId: null, userId: grant.userId, grant },
                { sceneSelector: { type: 'events', eventIds: [eventId] } },
              );
              if (!outcome.ok) {
                if (outcome.error.code === 'IDEMPOTENCY_CONFLICT') {
                  return {
                    ok: false as const,
                    code: 'SCENE_RENDER_INVALID' as const,
                    message: outcome.error.message,
                  };
                }
                if (outcome.error.code === 'OPERATION_QUEUE_FULL') {
                  return {
                    ok: false as const,
                    code: 'SCENE_RENDER_QUEUE_FULL' as const,
                    message: outcome.error.message,
                  };
                }
                return {
                  ok: false as const,
                  code: 'SCENE_RENDER_UNAVAILABLE' as const,
                  message: outcome.error.message,
                };
              }
              const rawHandle =
                outcome.data !== null &&
                typeof outcome.data === 'object' &&
                'operationHandle' in outcome.data
                  ? outcome.data.operationHandle
                  : undefined;
              if (typeof rawHandle !== 'string' || rawHandle.length === 0) {
                return {
                  ok: false as const,
                  code: 'SCENE_RENDER_UNAVAILABLE' as const,
                  message: 'The render operation returned no operation handle.',
                };
              }
              // Adoption preview: present when the current accepted source
              // already carries a committed scene (the author may adopt while
              // the queued render runs); never derived from caller bytes.
              const record = await session.runtime.services.execution.readAcceptedScene({
                projectId,
                eventId,
              });
              const source = session.source;
              const adoption: SceneAdoptionViewV1 | undefined =
                record !== null &&
                source !== null &&
                record.value.sourceHash === source.sourceHash
                  ? {
                      version: 1,
                      eventId,
                      revisionId: record.value.revisionId,
                      proseHash: record.value.proseHash,
                      released: true,
                      disclosure: 'accepted generated prose will enter the authoring manifest',
                    }
                  : undefined;
              return {
                ok: true as const,
                result: {
                  version: 1,
                  operationId: rawHandle,
                  ...(adoption === undefined ? {} : { adoption }),
                },
              };
            },
          },
        }).register(hostServer);
      }
      // Guarded browser reference mutations (plan 9.1): multipart import,
      // one-reference delete, and failed-import retry, all through the same
      // McpReferencePort the MCP tools drive. Registered ONLY while
      // referenceLimits.enabled so a disabled library has no reachable route.
      if (referencesEnabled) {
        createBrowserReferenceApi({
          principal,
          access: projectAccess,
          authorization,
          catalog,
          references: { get: referencePortFor },
          referenceLimits: await referenceLimitsFor(),
        }).register(hostServer);
      }
      // Guarded Agent chat surface (plan 9.5): conversation/run routes plus
      // SSE progress and cancel/retry. Registered ONLY when the `agent-chat`
      // gate passes, so a disabled Agent has no reachable route at all.
      if (agentChatEnabled) {
        createBrowserAgentChatApi({
          principal,
          access: projectAccess,
          authorization,
          catalog,
          roleResolver: async (userId, projectId) => {
            const owner = await persistence.client
              .request('loadOwner', undefined)
              .catch(() => null);
            if (owner?.userId === userId) return 'maintainer';
            return memberships.getMembership(userId, projectId);
          },
          services: {
            get: (projectId) => agentRunServices.get(projectId) ?? null,
          },
        }).register(hostServer);
      }
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
    // The listener is live: promote every opened project lease to `ready` and
    // start its heartbeat so the lease can never expire under this Host.
    hostEndpoint = endpoint;
    for (const project of configuredProjects) await markProjectReady(project.projectId);
    return {
      host: hostServer,
      endpoint,
      projectId: activeConfiguration?.defaultProjectId ?? configuredProjects[0]?.projectId ?? null,
      auth,
      provider,
      close: async () => {
        for (const projectId of [...heartbeatTimers.keys()]) stopHeartbeat(projectId);
        await disposeAuthoringRuntimes?.();
        configurationService.dispose();
        await hostServer.close();
        // Instance-CAS release for every coordinator this Host created; safe
        // to run after the listener is gone and for never-acquired projects.
        for (const projectId of [...coordinators.keys()]) {
          await releaseProjectAuthority(projectId).catch(() => undefined);
        }
        await persistence.dispose();
      },
    };
  } catch (error) {
    // Partial-launch failure: dispose the worker (bounded terminate), any
    // already-created server and every acquired authority lease so no thread,
    // port or lease survives the failed start.
    for (const projectId of [...heartbeatTimers.keys()]) stopHeartbeat(projectId);
    await disposeAuthoringRuntimes?.().catch(() => undefined);
    await host?.close().catch(() => undefined);
    for (const projectId of [...coordinators.keys()]) {
      await releaseProjectAuthority(projectId).catch(() => undefined);
    }
    await persistence.dispose();
    throw error;
  }
}

// ─── Owner MCP admin port (production launch wiring) ─────────────────────────

/** Dependencies shared by every owner-admin MCP tool in the production launch. */
export interface LaunchAdminPortOptions {
  readonly configuration: ConfigurationChangeService;
  readonly runtime: WorkbenchRuntime;
  readonly memberships: DurableProjectMembershipService;
  readonly auth: LocalAuthService;
  readonly devices: McpDevicePairingService;
  readonly persistence: PersistenceWorkerClient;
  readonly status: SetupStatusBuilder;
  /** Trusted-plugin discovery; absent → the admin plugin tools fail closed. */
  readonly plugins?: PluginDiscoveryAdminPort;
}

function adminFailure(
  code: string,
  message: string,
): { readonly error: { readonly code: string; readonly message: string } } {
  return { error: { code, message } };
}

/** Extract the typed `{ code, message }` from a persistence worker failure. */
/** Read the `code` property off an unknown error shape, or undefined. */
function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** Extract the typed `{ code, message }` from a persistence worker failure. */
function persistenceFailure(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): { readonly code: string; readonly message: string } {
  if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
    const code = error.code;
    const message = error.message;
    if (typeof code === 'string' && typeof message === 'string') {
      return { code, message };
    }
  }
  return { code: fallbackCode, message: fallbackMessage };
}

function inviteSafeView(invite: InviteState): WorkbenchInviteSafeViewV1 {
  return {
    inviteId: invite.inviteId,
    projectId: invite.projectId ?? null,
    role: invite.role,
    expiresAt: invite.expiresAt,
    consumedAt: invite.consumedAt ?? null,
  };
}

function deviceSafeView(device: McpDeviceVerifierReadState): WorkbenchDeviceSafeViewV1 {
  return {
    deviceId: device.deviceId,
    scopes: [...device.scopes],
    createdAt: device.createdAt,
    expiresAt: device.expiresAt,
    revokedAt: device.revokedAt ?? null,
  };
}

/**
 * Build the canonical version-1 configuration candidate over the given
 * project list, mirroring the owner dashboard's explicit field construction:
 * every V1 domain is carried over from the active configuration or filled
 * from its canonical default when absent.
 */
function v1Candidate(
  projects: readonly WorkbenchProjectConfigurationV1[],
  active: ActiveConfiguration | null,
  defaultProjectId: string | null = active?.configuration.defaultProjectId ?? null,
): WorkbenchConfigurationV1 {
  return {
    version: 1,
    projects,
    defaultProjectId,
    providers: active?.configuration.providers ?? {},
    network: active?.configuration.network ?? { ...DEFAULT_WORKBENCH_NETWORK },
    referenceLimits:
      active?.configuration.referenceLimits ?? { ...DEFAULT_WORKBENCH_REFERENCE_LIMITS },
    operationLimits:
      active?.configuration.operationLimits ?? { ...DEFAULT_WORKBENCH_OPERATION_LIMITS },
    agent: active?.configuration.agent ?? { ...DEFAULT_WORKBENCH_AGENT_CONFIGURATION },
    renderPolicy: active?.configuration.renderPolicy ?? { ...DEFAULT_WORKBENCH_RENDER_POLICY },
  };
}

/**
 * Real owner-admin MCP port used by the production launch. Every registry
 * handler method is wired to the normal configuration CAS, the runtime
 * lifecycle, durable memberships, invites, devices, and typed persistence
 * worker calls; none of them is a placeholder or no-op. Where a persistence
 * operation cannot express the action, a narrow typed operation is added
 * rather than faking success.
 */
export function createLaunchAdminPort(options: LaunchAdminPortOptions): McpAdminPort {
  const { configuration, runtime, memberships, auth, devices, persistence, status, plugins } =
    options;

  /** The project list currently registered in the active configuration. */
  async function configuredProjects(): Promise<readonly WorkbenchProjectConfigurationV1[]> {
    const active = await configuration.readActive();
    return active?.configuration.projects ?? [];
  }

  /** Safe project view (no root path) for a configured project, or null. */
  async function projectView(projectId: string): Promise<WorkbenchProjectSafeViewV1 | null> {
    const active = await configuration.readActive();
    if (active === null) return null;
    const project = active.configuration.projects.find((entry) => entry.projectId === projectId);
    if (project === undefined) return null;
    return {
      projectId: project.projectId,
      displayName: project.displayName,
      validation: 'valid',
      open: runtime.isOpen(project.projectId),
      defaultProject: project.projectId === active.configuration.defaultProjectId,
    };
  }

  return {
    // ── Configuration ───────────────────────────────────────────────────────
    preview: async (request: ConfigChangeRequestV1) => {
      const active = await configuration.readActive();
      if (active?.revision !== request.expectedRevision) {
        return {
          status: 'stale' as const,
          activeRevision: active?.revision ?? null,
          candidateRevision: null,
          changedFields: ['configuration'],
          diagnostics: [{ code: 'CONFIG_STALE', message: 'Configuration revision changed.' }],
        };
      }
      const validation = await configuration.validateCandidate(request.configuration);
      return validation.ok
        ? {
            status: 'applied' as const,
            activeRevision: active?.revision ?? null,
            candidateRevision: validation.revision,
            changedFields: [],
            diagnostics: [],
          }
        : {
            status: 'invalid' as const,
            activeRevision: active?.revision ?? null,
            candidateRevision: null,
            changedFields: [],
            diagnostics: [...validation.diagnostics],
          };
    },
    apply: (request: ConfigChangeRequestV1) =>
      configuration.apply({
        candidate: request.configuration,
        expectedRevision: request.expectedRevision,
        origin: 'mcp',
      }),
    get: async () => ({ version: 1, status: await status.build() }),

    // ── Projects ────────────────────────────────────────────────────────────
    projectList: async () => ({
      version: 1,
      projects: (await status.build()).projects,
    }),
    projectValidate: async (input) => {
      const active = await configuration.readActive();
      const candidate = v1Candidate(
        [
          ...(await configuredProjects()),
          {
            projectId: input.projectId,
            displayName: input.displayName,
            root: input.root,
            revisionMirror: { mode: 'disabled' },
            providerProfile: 'default',
            trustedPlugins: [],
          },
        ],
        active,
      );
      const result = await configuration.validateCandidate(candidate);
      if (!result.ok) {
        const first = result.diagnostics[0];
        return {
          version: 1,
          projectId: input.projectId,
          validation: 'invalid',
          code: first?.code ?? 'CONFIG_INVALID',
          diagnostics: [...result.diagnostics],
        };
      }
      return { version: 1, projectId: input.projectId, validation: 'valid' };
    },
    projectCreate: async (input) => {
      const active = await configuration.readActive();
      const projects = await configuredProjects();
      const candidate = v1Candidate(
        projects.some((project) => project.projectId === input.projectId)
          ? projects
          : [
              ...projects,
              {
                projectId: input.projectId,
                displayName: input.displayName,
                root: input.root,
                revisionMirror: { mode: 'disabled' },
                providerProfile: 'default',
                trustedPlugins: [],
              },
            ],
        active,
      );
      const receipt: ConfigOperationReceiptV1 = await configuration.apply({
        candidate,
        expectedRevision: active?.revision ?? null,
        origin: 'mcp',
      });
      return { version: 1, project: await projectView(input.projectId), receipt };
    },
    projectUpdate: async (input) => {
      const active = await configuration.readActive();
      const projects = await configuredProjects();
      if (!projects.some((project) => project.projectId === input.projectId)) {
        return {
          version: 1,
          projectId: input.projectId,
          project: null,
          ...adminFailure('PROJECT_NOT_FOUND', `Project "${input.projectId}" is not registered.`),
        };
      }
      const candidate = v1Candidate(
        projects.map((project) =>
          project.projectId === input.projectId
            ? {
                projectId: input.projectId,
                displayName: input.displayName,
                root: input.root,
                revisionMirror: { mode: 'disabled' },
                providerProfile: 'default',
                trustedPlugins: [],
              }
            : project,
        ),
        active,
      );
      const receipt: ConfigOperationReceiptV1 = await configuration.apply({
        candidate,
        expectedRevision: active?.revision ?? null,
        origin: 'mcp',
      });
      return { version: 1, project: await projectView(input.projectId), receipt };
    },
    projectDelete: async (input) => {
      const active = await configuration.readActive();
      const projects = await configuredProjects();
      if (!projects.some((project) => project.projectId === input.projectId)) {
        return {
          version: 1,
          projectId: input.projectId,
          ...adminFailure('PROJECT_NOT_FOUND', `Project "${input.projectId}" is not registered.`),
        };
      }
      let closedRuntime = false;
      try {
        if (runtime.isOpen(input.projectId)) {
          closedRuntime = await runtime.close(input.projectId);
        }
      } catch (error) {
        if (errorCode(error) === 'PROJECT_BUSY') {
          return {
            version: 1,
            projectId: input.projectId,
            ...adminFailure(
              'PROJECT_BUSY',
              `Project "${input.projectId}" is busy; close it before removal.`,
            ),
          };
        }
        throw error;
      }
      const restoreClosedRuntime = async (): Promise<void> => {
        if (!closedRuntime) return;
        const activeAfter = await configuration.readActive();
        const projectToRestore = activeAfter?.configuration.projects.find(
          (project) => project.projectId === input.projectId,
        );
        if (projectToRestore !== undefined) {
          await runtime.open(projectToRestore);
        }
      };
      let receipt: ConfigOperationReceiptV1;
      try {
        receipt = await configuration.apply({
          candidate: v1Candidate(
            projects.filter((project) => project.projectId !== input.projectId),
            active,
            active?.configuration.defaultProjectId === input.projectId
              ? (projects.find((project) => project.projectId !== input.projectId)?.projectId ??
                  null)
              : undefined,
          ),
          expectedRevision: active?.revision ?? null,
          origin: 'mcp',
        });
      } catch {
        await restoreClosedRuntime().catch(() => undefined);
        return {
          version: 1,
          projectId: input.projectId,
          ...adminFailure(
            'INTERNAL',
            `The configuration change for project "${input.projectId}" failed; its runtime was restored.`,
          ),
        };
      }
      if (receipt.status === 'stale' || receipt.status === 'invalid') {
        await restoreClosedRuntime().catch(() => undefined);
      }
      if (receipt.status === 'stale') {
        return {
          version: 1,
          projectId: input.projectId,
          ...adminFailure('CONFIG_STALE', 'The configuration changed; re-read and retry.'),
        };
      }
      if (receipt.status === 'invalid') {
        const first = receipt.diagnostics[0];
        return {
          version: 1,
          projectId: input.projectId,
          ...adminFailure(
            first?.code ?? 'CONFIG_INVALID',
            first?.message ?? 'The configuration change was rejected.',
          ),
        };
      }
      return { version: 1, projectId: input.projectId, removed: true, receipt };
    },
    projectOpen: async (input) => {
      const active = await configuration.readActive();
      const project = active?.configuration.projects.find(
        (entry) => entry.projectId === input.projectId,
      );
      if (project === undefined) {
        return {
          version: 1,
          projectId: input.projectId,
          open: false,
          ...adminFailure('PROJECT_NOT_FOUND', `Project "${input.projectId}" is not registered.`),
        };
      }
      await runtime.open(project);
      return { version: 1, open: true, project: await projectView(input.projectId) };
    },
    projectClose: async (input) => {
      try {
        const closed = await runtime.close(input.projectId);
        if (!closed) {
          return {
            version: 1,
            projectId: input.projectId,
            open: false,
            ...adminFailure('PROJECT_NOT_FOUND', `Project "${input.projectId}" is not open.`),
          };
        }
      } catch (error) {
        if (errorCode(error) === 'PROJECT_BUSY') {
          return {
            version: 1,
            projectId: input.projectId,
            open: true,
            ...adminFailure(
              'PROJECT_BUSY',
              `Project "${input.projectId}" is busy and cannot be closed.`,
            ),
          };
        }
        throw error;
      }
      return { version: 1, projectId: input.projectId, open: false };
    },
    projectRecover: async (input) => {
      // Recover the complete runtime bundle for a configured project whose
      // session is missing (e.g. after a rejected configuration change
      // closed it): reopening is the runtime recovery action.
      const active = await configuration.readActive();
      const project = active?.configuration.projects.find(
        (entry) => entry.projectId === input.projectId,
      );
      if (project === undefined) {
        return {
          version: 1,
          projectId: input.projectId,
          ...adminFailure('PROJECT_NOT_FOUND', `Project "${input.projectId}" is not registered.`),
        };
      }
      if (!runtime.isOpen(input.projectId)) {
        await runtime.open(project);
      }
      return { version: 1, project: await projectView(input.projectId) };
    },

    // ── Memberships ─────────────────────────────────────────────────────────
    membershipList: async (input) => ({
      version: 1,
      memberships: [
        ...(await memberships.list(
          input.projectId === undefined ? {} : { projectId: input.projectId },
        )),
      ],
    }),
    membershipUpsert: async (input) => {
      if (input.role === undefined) {
        return { version: 1, ...adminFailure('INVALID_INPUT', 'role is required.') };
      }
      try {
        const membership = await memberships.upsert({
          userId: input.userId,
          projectId: input.projectId,
          role: input.role,
        });
        return { version: 1, membership };
      } catch (error) {
        const failure = persistenceFailure(
          error,
          'MEMBERSHIP_UPDATE_FAILED',
          'The membership could not be updated.',
        );
        return { version: 1, ...adminFailure(failure.code, failure.message) };
      }
    },
    membershipRevoke: async (input) => {
      try {
        await memberships.revoke({ userId: input.userId, projectId: input.projectId });
        return { version: 1, userId: input.userId, projectId: input.projectId, revoked: true };
      } catch (error) {
        const failure = persistenceFailure(
          error,
          'MEMBERSHIP_REVOKE_FAILED',
          'The membership could not be revoked.',
        );
        return { version: 1, ...adminFailure(failure.code, failure.message) };
      }
    },

    // ── Invites ─────────────────────────────────────────────────────────────
    inviteList: async (input) => ({
      version: 1,
      invites: (
        await persistence.request(
          'listInvites',
          input.projectId === undefined ? {} : { projectId: input.projectId },
        )
      ).map(inviteSafeView),
    }),
    inviteCreate: async (input) => {
      const active = await configuration.readActive();
      if (
        !active?.configuration.projects.some((project) => project.projectId === input.projectId)
      ) {
        return {
          version: 1,
          ...adminFailure('PROJECT_NOT_FOUND', 'The project is not registered.'),
        };
      }
      const invite = await auth.createInvite({
        projectId: input.projectId,
        role: input.role,
        ttlMs: input.ttlMs,
      });
      return { version: 1, invite: inviteSafeView(invite) };
    },
    inviteRevoke: async (input) => {
      const result = await persistence.request('revokeInvite', { inviteId: input.inviteId });
      if (result.status === 'revoked') {
        return { version: 1, inviteId: input.inviteId, revoked: true };
      }
      return {
        version: 1,
        inviteId: input.inviteId,
        revoked: false,
        ...adminFailure(
          result.status === 'not-found' ? 'INVITE_NOT_FOUND' : 'INVITE_ALREADY_CONSUMED',
          result.status === 'not-found'
            ? 'The invite does not exist.'
            : 'The invite has already been consumed.',
        ),
      };
    },

    // ── Devices ─────────────────────────────────────────────────────────────
    deviceList: async () => ({
      version: 1,
      devices: (await devices.listDevices()).map(deviceSafeView),
    }),
    devicePairBegin: async (input) => {
      const owner = await persistence.request('loadOwner', undefined);
      if (owner === null) {
        return {
          version: 1,
          ...adminFailure('OWNER_NOT_FOUND', 'No owner account exists; devices cannot be paired.'),
        };
      }
      const kind = input.kind ?? (input.projectId === undefined ? 'admin' : 'project');
      if (kind === 'admin' && (input.projectId !== undefined || input.role !== undefined)) {
        return {
          version: 1,
          ...adminFailure('INVALID_INPUT', 'admin device pairing cannot carry projectId or role.'),
        };
      }
      if (kind === 'project') {
        if (input.projectId === undefined) {
          return {
            version: 1,
            ...adminFailure('INVALID_INPUT', 'project device pairing requires projectId.'),
          };
        }
        const pairing = await devices.createPairing({
          ownerUserId: owner.userId,
          kind: 'project',
          projectId: input.projectId,
          ...(input.role === undefined ? {} : { role: input.role }),
          ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
        });
        return { version: 1, pairingCode: pairing.pairingCode, expiresAt: pairing.expiresAt };
      }
      const pairing = await devices.createPairing({
        ownerUserId: owner.userId,
        kind: 'admin',
        ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      });
      return { version: 1, pairingCode: pairing.pairingCode, expiresAt: pairing.expiresAt };
    },
    deviceRevoke: async (input) => {
      await devices.revoke(input.deviceId);
      return { version: 1, deviceId: input.deviceId, revoked: true };
    },

    // ── Operations ──────────────────────────────────────────────────────────
    operationList: async (input) => {
      const limit = input.limit ?? 50;
      const [configurationOperations, audit] = await Promise.all([
        persistence.request('listConfigurationOperations', { limit }),
        persistence.request('listAudit', { limit }),
      ]);
      return { version: 1, configuration: configurationOperations, audit };
    },
    operationGet: async (input) => {
      const handle = input.operationHandle;
      const [configurationOperation, audit, checkpoint, submission, revisionOperation] =
        await Promise.all([
          persistence.request('loadConfigurationOperation', { operationId: handle }),
          persistence.request('loadAudit', { auditId: handle }),
          persistence.request('loadOperationCheckpoint', { operationId: handle }),
          persistence.request('loadGitSubmission', { submitId: handle }),
          persistence.request('loadSourceRevisionOperation', { operationId: handle }),
        ]);
      if (configurationOperation !== null) {
        return {
          version: 1,
          operationHandle: handle,
          kind: 'configuration',
          operation: configurationOperation,
        };
      }
      if (audit !== null) {
        return { version: 1, operationHandle: handle, kind: 'audit', operation: audit };
      }
      if (checkpoint !== null) {
        return { version: 1, operationHandle: handle, kind: 'checkpoint', operation: checkpoint };
      }
      if (submission !== null) {
        return { version: 1, operationHandle: handle, kind: 'submission', operation: submission };
      }
      if (revisionOperation !== null) {
        return {
          version: 1,
          operationHandle: handle,
          kind: 'revision',
          operation: revisionOperation,
        };
      }
      return { version: 1, operationHandle: handle, kind: null, operation: null };
    },
    // Trusted-plugin discovery (plan 7.7): reports the name/version/moduleHash
    // triples the Host found under the project root; the owner admin builds
    // trusted allowlists from these identities only. Absent port → fail
    // closed (the registry surfaces NO_ADMIN_SERVICE).
    pluginsDiscovered: async (input) => {
      if (plugins === undefined) {
        throw new Error('Plugin discovery is not available on this Host.');
      }
      const discovered = await plugins.discover({ projectId: input.projectId });
      return { version: 1, projectId: input.projectId, plugins: discovered };
    },
  };
}

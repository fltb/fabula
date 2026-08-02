import { readFile, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { MockProvider } from '@novalistically/core/testing';
import {
  AiSdkProvider,
  createFileCoreRuntimeServices,
  FileProjectSourceLoader,
} from '@novalistically/node-host';
import {
  BROWSER_API_VERSION,
  type BrowserProjectSummaryV1,
  type BrowserSessionPrincipalV1,
} from '../contracts/browser-api.js';
import type { SourceStudioStateV1 } from '../contracts/source-studio.js';
import { start as startPersistenceWorker } from '../persistence/worker.js';
import { PersistenceWorkerClient } from '../persistence/worker-client.js';
import { AgentCapabilityService, createCapabilityPersistence } from './agent/index.js';
import { createAuthPersistence, LocalAuthService } from './auth/index.js';
import { createBrowserPrincipalResolver } from './browser-read-api.js';
import { createProjectCoreRuntime } from './core-runtime.js';
import { projectCanonicalGraphRuntime } from './graph-projection.js';
import { createProjectSessionRegistry } from './project-session.js';
import { createHostServer, type HostServer, type HostServerOptions } from './server.js';

export interface WorkbenchLaunchConfig extends HostServerOptions {
  readonly mode: 'workbench' | 'listener';
  readonly provider: 'ai-sdk' | 'mock';
  readonly allowMockProvider: boolean;
  readonly projectRoot: string;
  readonly databasePath: string;
  readonly projectId: string;
  readonly displayName: string;
  readonly assetsRoot?: string;
  readonly allowBootstrap: boolean;
}

export interface WorkbenchLaunchHandle {
  readonly host: HostServer;
  readonly endpoint: string;
  readonly projectId: string;
  readonly auth: LocalAuthService;
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
  if (!config.projectRoot || !config.databasePath) {
    throw new Error('Workbench requires WORKBENCH_PROJECT_ROOT and WORKBENCH_DATABASE_PATH');
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

export function parseWorkbenchLaunchConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkbenchLaunchConfig {
  if (opt(env.WORKBENCH_MODE) !== 'workbench') {
    throw new Error('WORKBENCH_MODE must be explicitly set to "workbench" for a composed Host');
  }
  const projectRoot = opt(env.WORKBENCH_PROJECT_ROOT);
  const databasePath = opt(env.WORKBENCH_DATABASE_PATH);
  if (!projectRoot || !databasePath) {
    throw new Error(
      'Set WORKBENCH_PROJECT_ROOT and WORKBENCH_DATABASE_PATH before starting Workbench',
    );
  }
  const devMode = env.WORKBENCH_DEV === 'true';
  const assetsRootRaw = opt(env.WORKBENCH_ASSETS_ROOT);
  const assetsRoot = assetsRootRaw ? resolve(assetsRootRaw) : undefined;
  if (!devMode && assetsRoot === undefined) {
    throw new Error('WORKBENCH_ASSETS_ROOT is required outside Workbench development mode');
  }
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
  if (providerValue === 'ai-sdk' && !env.NOVALISTICALLY_AI_API_KEY) {
    throw new Error('NOVALISTICALLY_AI_API_KEY is required when WORKBENCH_PROVIDER=ai-sdk');
  }
  const allowedHostsRaw = opt(env.WORKBENCH_ALLOWED_HOSTS) ?? '127.0.0.1';
  const allowedOriginsRaw = opt(env.WORKBENCH_ALLOWED_ORIGINS);
  const config: WorkbenchLaunchConfig = {
    mode: 'workbench',
    provider: providerValue,
    allowMockProvider: env.WORKBENCH_ALLOW_MOCK_PROVIDER === 'true',
    projectRoot: resolve(projectRoot),
    databasePath: resolve(databasePath),
    projectId: opt(env.WORKBENCH_PROJECT_ID) ?? basename(resolve(projectRoot)),
    displayName: opt(env.WORKBENCH_DISPLAY_NAME) ?? basename(resolve(projectRoot)),
    assetsRoot,
    allowBootstrap,
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
  const channel = new MessageChannel();
  const persistenceDisposer = startPersistenceWorker(channel.port1, {
    databasePath: config.databasePath,
  });
  const persistence = new PersistenceWorkerClient(channel.port2);
  const auth = new LocalAuthService({ persistence: createAuthPersistence(persistence) });
  const capabilities = new AgentCapabilityService({
    persistence: createCapabilityPersistence(persistence),
  });
  const loader = new FileProjectSourceLoader();
  const source = loader.load(config.projectRoot);
  if (config.assetsRoot) {
    const assetInfo = await stat(config.assetsRoot).catch(() => null);
    if (assetInfo === null || !assetInfo.isDirectory()) {
      throw new Error(`WORKBENCH_ASSETS_ROOT is not a directory: ${config.assetsRoot}`);
    }
  }
  const provider = config.provider === 'mock' ? new MockProvider() : new AiSdkProvider();
  const runtime = createProjectCoreRuntime({
    projectId: config.projectId,
    services: createFileCoreRuntimeServices(config.projectRoot, { provider }),
  });
  const sessions = createProjectSessionRegistry();
  const session = sessions.open({
    projectId: config.projectId,
    runtime,
    capabilities,
    audit: { record: async () => undefined },
    initialSource: source,
  });
  await persistence.request('upsertProject', {
    projectId: config.projectId,
    displayName: config.displayName,
    rootLabel: basename(config.projectRoot),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const users = {
    loadUser: async (userId: string) => {
      const user = await persistence.request('loadUser', { userId });
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
  const project = await persistence.request('getProject', { projectId: config.projectId });
  const catalog = {
    listProjects: async (
      _p: BrowserSessionPrincipalV1,
    ): Promise<readonly BrowserProjectSummaryV1[]> => {
      const rows = await persistence.request('listProjects', undefined);
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
  const browser = {
    principal,
    authorization: {
      canAccessProject: async (_userId: string, id: string) => id === config.projectId,
    },
    catalog,
    overview: {
      loadOverview: async (id: string) =>
        id !== config.projectId || !project
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
        if (id !== config.projectId || session.source === null)
          throw new Error('project unavailable');
        return projectCanonicalGraphRuntime(session.source, selector);
      },
    },
    source: {
      loadSourceStudio: async (id: string): Promise<SourceStudioStateV1 | null> =>
        id !== config.projectId
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
  const host = createHostServer({ ...config, browser });
  host.registerPublicAuthPostRoute('/api/v1/auth/login', async (c) => {
    const body = await bodyObject(c.req.raw);
    if (typeof body?.userId !== 'string' || typeof body.password !== 'string')
      return json({ error: 'invalid_credentials' }, 401);
    const result = await auth.authenticate({ userId: body.userId, password: body.password });
    return result.ok
      ? sessionResponse(result.session.sessionId, result.session.userId)
      : json({ error: 'invalid_credentials' }, 401);
  });
  host.registerPublicAuthPostRoute('/api/v1/auth/bootstrap', async (c) => {
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
  if (config.assetsRoot) {
    const assetsRoot = config.assetsRoot;
    host.registerPublicStaticRoute('/*', (c) => staticHandler(c.req.raw, assetsRoot));
  }
  const handle = await host.start();
  const endpoint =
    handle.mode === 'unix'
      ? `http+unix://${handle.address}`
      : `http://${handle.host}:${handle.port}`;
  return {
    host,
    endpoint,
    projectId: config.projectId,
    auth,
    close: async () => {
      await host.close();
      persistence.dispose();
      await persistenceDisposer.dispose();
      channel.port1.close();
      channel.port2.close();
    },
  };
}

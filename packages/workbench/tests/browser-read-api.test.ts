import { afterEach, describe, expect, it } from 'vitest';
import {
  BROWSER_GRAPH_ROUTE_QUERY,
  BROWSER_PROJECT_GRAPHS_PATH,
  BROWSER_PROJECT_OVERVIEW_PATH,
  BROWSER_PROJECTS_PATH,
  BROWSER_SESSION_HEADER,
  BROWSER_SESSION_PATH,
} from '../src/contracts/browser-api.js';
import type {
  BrowserApiErrorV1,
  BrowserProjectOverviewV1,
  BrowserProjectSummaryV1,
  BrowserSessionPrincipalV1,
  ProjectSessionProjectionV1,
  SourceStudioStateV1,
  WorkbenchGraphProjectionV1,
} from '../src/contracts/index.js';
import { BROWSER_PROJECT_SOURCE_PATH } from '../src/contracts/source-studio.js';
import type {
  BrowserGraphProjector,
  BrowserPrincipalResolver,
  BrowserProjectAuthorization,
  BrowserProjectCatalog,
  BrowserProjectOverviewSource,
  BrowserReadApiOptions,
  BrowserSourceStudioSource,
} from '../src/host/browser-read-api.js';
import {
  createBrowserPrincipalResolver,
  parseBrowserGraphRouteSelector,
} from '../src/host/browser-read-api.js';
import {
  createHostListener,
  type HostListener,
  HostListenerError,
  HostListenerStateError,
} from '../src/host/listener.js';
import { createHostServer, type HostServer } from '../src/host/server.js';

const openServers: HostServer[] = [];
const openListeners: HostListener[] = [];

const trackServer = (server: HostServer): HostServer => {
  openServers.push(server);
  return server;
};
const trackListener = (listener: HostListener): HostListener => {
  openListeners.push(listener);
  return listener;
};

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  await Promise.all(openListeners.splice(0).map((listener) => listener.close()));
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

const principal: BrowserSessionPrincipalV1 = {
  version: 1,
  userId: 'u-owner',
  role: 'owner',
  displayName: 'Owner',
  capabilityVersion: 3,
  expiresAt: '2099-01-01T00:00:00.000Z',
};

const projection: ProjectSessionProjectionV1 = {
  version: 1,
  projectId: 'proj-a',
  revision: 3,
  sourceHash: 'abc123',
  documents: 2,
  events: 5,
  rendered: 4,
  pending: 1,
  blocked: 0,
  errorCount: 0,
  warningCount: 1,
  diagnostics: [
    {
      code: 'W1',
      severity: 'warning',
      message: 'missing prose hint',
      logicalPath: 'chapters/chapter_01/_chapter.yaml',
    },
  ],
  presence: [{ actorId: 'u-owner', surface: 'browser', since: '2026-08-02T00:00:00.000Z' }],
  generatedAt: '2026-08-02T00:00:00.000Z',
};

const overview: BrowserProjectOverviewV1 = {
  version: 1,
  projectId: 'proj-a',
  metadata: {
    displayName: 'Alpha',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  },
  projection,
  activity: { busy: false, hasHumanPresence: true },
  generatedAt: '2026-08-02T00:00:00.000Z',
};

const sourceStudio: SourceStudioStateV1 = {
  version: 1,
  projectId: 'proj-a',
  accepted: projection,
  working: {
    documents: [
      {
        projectId: 'proj-a',
        documentId: 'chapters/chapter_01/_chapter.yaml',
        kind: 'raw-yaml',
        available: true,
      },
      {
        projectId: 'proj-a',
        documentId: 'scenes/E1.md',
        kind: 'prose',
        available: false,
      },
    ],
  },
  generatedAt: '2026-08-02T00:00:00.000Z',
};

const graphProjection: WorkbenchGraphProjectionV1 = {
  version: 1,
  story: {
    version: 1,
    domain: 'story',
    hash: 'story-hash',
    nodes: [],
    edges: [],
    outputs: [],
    reads: [],
    resolutions: [],
    boundaryReferences: [],
    ellipses: [],
    sceneSequence: [],
  },
  discourse: {
    version: 1,
    domain: 'discourse',
    hash: 'discourse-hash',
    nodes: [],
    edges: [],
    outputs: [],
    reads: [],
    resolutions: [],
    boundaryReferences: [],
    ellipses: [],
    sceneSequence: [],
  },
  route: {
    version: 1,
    branchPath: { decisions: [] },
    branchScope: 'Linear',
    discourseBranch: 'main',
    selectedEventIds: [],
    leafPaths: [],
    eventScopes: [],
    choices: [],
  },
};

interface FakePorts {
  readonly resolver: BrowserPrincipalResolver;
  readonly authorization: BrowserProjectAuthorization;
  readonly catalog: BrowserProjectCatalog;
  readonly overview: BrowserProjectOverviewSource;
  readonly graph: BrowserGraphProjector;
  readonly source: BrowserSourceStudioSource;
  readonly graphCalls: Array<{ projectId: string; selector: unknown }>;
  readonly sourceCalls: string[];
}

/** Deterministic fake ports; the resolver authenticates only `session-1`. */
const fakePorts = (overrides: Partial<FakePorts> = {}): FakePorts => {
  const graphCalls: Array<{ projectId: string; selector: unknown }> = [];
  const sourceCalls: string[] = [];
  const base: FakePorts = {
    resolver: {
      resolve: async (request) => {
        const session = request.headers.get(BROWSER_SESSION_HEADER);
        if (session === 'expired') return { ok: false, failure: 'SESSION_EXPIRED' };
        if (session !== 'session-1') return { ok: false, failure: 'SESSION_NOT_FOUND' };
        return { ok: true, principal };
      },
    },
    authorization: {
      canAccessProject: async (_userId, projectId) => projectId !== 'secret-project',
    },
    catalog: {
      listProjects: async (current) => {
        const projects: BrowserProjectSummaryV1[] = [
          {
            version: 1,
            projectId: 'proj-a',
            displayName: 'Alpha',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
            open: true,
          },
        ];
        return current.userId === 'u-owner' ? projects : [];
      },
    },
    overview: {
      loadOverview: async (projectId) => (projectId === 'proj-a' ? overview : null),
    },
    graph: {
      project: async (projectId, selector) => {
        graphCalls.push({ projectId, selector });
        if (projectId === 'exploding') throw new Error('compiler exploded');
        return graphProjection;
      },
    },
    source: {
      loadSourceStudio: async (projectId) => {
        sourceCalls.push(projectId);
        return projectId === 'proj-a' ? sourceStudio : null;
      },
    },
    graphCalls,
    sourceCalls,
  };
  return { ...base, ...overrides, graphCalls, sourceCalls };
};

const browserOptions = (ports: FakePorts = fakePorts()): BrowserReadApiOptions => ({
  principal: ports.resolver,
  authorization: ports.authorization,
  catalog: ports.catalog,
  overview: ports.overview,
  graph: ports.graph,
  source: ports.source,
});

const authHeaders = { [BROWSER_SESSION_HEADER]: 'session-1' };

const expectError = async (
  response: Response,
  status: number,
  code: BrowserApiErrorV1['error']['code'],
): Promise<void> => {
  expect(response.status).toBe(status);
  const body = (await response.json()) as BrowserApiErrorV1;
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe('string');
  expect(body.error.message.length).toBeGreaterThan(0);
};

// ─── Principal resolver ──────────────────────────────────────────────────────

describe('createBrowserPrincipalResolver', () => {
  const sessions = {
    getSession: async (sessionId: string) => {
      if (sessionId === 'session-1') {
        return {
          sessionId,
          userId: 'u-owner',
          expiresAt: '2099-01-01T00:00:00.000Z',
          capabilityVersion: 3,
        };
      }
      if (sessionId === 'stale') {
        return {
          sessionId,
          userId: 'u-owner',
          expiresAt: '2000-01-01T00:00:00.000Z',
          capabilityVersion: 3,
        };
      }
      return null;
    },
  };
  const users = {
    loadUser: async (userId: string) =>
      userId === 'u-owner'
        ? {
            userId,
            role: 'owner' as const,
            displayName: 'Owner',
            capabilityVersion: 3,
            createdAt: 'x',
            updatedAt: 'x',
          }
        : null,
  };

  it('resolves a safe principal from the session header', async () => {
    const resolver = createBrowserPrincipalResolver({ sessions, users });
    const resolution = await resolver.resolve(
      new Request('http://localhost/api/v1/session', { headers: authHeaders }),
    );
    expect(resolution).toEqual({ ok: true, principal });
  });

  it('rejects missing, unknown, and expired sessions without a principal', async () => {
    const resolver = createBrowserPrincipalResolver({ sessions, users });
    const none = await resolver.resolve(new Request('http://localhost/api/v1/session'));
    expect(none).toEqual({ ok: false, failure: 'SESSION_NOT_FOUND' });
    const unknown = await resolver.resolve(
      new Request('http://localhost/api/v1/session', {
        headers: { [BROWSER_SESSION_HEADER]: 'nope' },
      }),
    );
    expect(unknown).toEqual({ ok: false, failure: 'SESSION_NOT_FOUND' });
    const stale = await resolver.resolve(
      new Request('http://localhost/api/v1/session', {
        headers: { [BROWSER_SESSION_HEADER]: 'stale' },
      }),
    );
    expect(stale).toEqual({ ok: false, failure: 'SESSION_EXPIRED' });
  });
});

// ─── Mounted surface over real Hono requests ─────────────────────────────────

describe('browser read API over the Host server', () => {
  it('serves a safe session principal with no session id or credential echo', async () => {
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions() }));
    const handle = await server.start();
    const res = await server.app.request(BROWSER_SESSION_PATH, { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BrowserSessionPrincipalV1;
    expect(body).toEqual(principal);
    // The session credential never round-trips and no cookie/secret field exists.
    expect(JSON.stringify(body)).not.toContain('session-1');
    expect(JSON.stringify(body)).not.toContain('cookie');
    await handle.close();
  });

  it('lists server-scoped projects without root labels or filesystem paths', async () => {
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions() }));
    const handle = await server.start();
    const res = await server.app.request(BROWSER_PROJECTS_PATH, { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: number; projects: BrowserProjectSummaryV1[] };
    expect(body.version).toBe(1);
    expect(body.projects).toHaveLength(1);
    const [project] = body.projects;
    expect(project).toEqual({
      version: 1,
      projectId: 'proj-a',
      displayName: 'Alpha',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      open: true,
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('rootLabel');
    expect(serialized).not.toContain('rootPath');
    expect(serialized).not.toContain('/home/');
    await handle.close();
  });

  it('serves a project overview with metadata, projection, and safe activity state', async () => {
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions() }));
    const handle = await server.start();
    const res = await server.app.request('/api/v1/projects/proj-a/overview', {
      headers: authHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BrowserProjectOverviewV1;
    expect(body).toEqual(overview);
    const serialized = JSON.stringify(body);
    // No Git, SQLite, credential, token, Yjs bytes, or operation output path.
    expect(serialized).not.toContain('rootLabel');
    expect(serialized).not.toContain('rootPath');
    expect(serialized).not.toContain('credential');
    expect(serialized).not.toContain('capabilityToken');
    expect(serialized).not.toContain('git');
    expect(serialized).not.toContain('sqlite');
    expect(serialized).not.toContain('.nova/');
    await handle.close();
  });

  it('rejects missing, unknown, and expired sessions with 401', async () => {
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions() }));
    const handle = await server.start();
    for (const headers of [
      {},
      { [BROWSER_SESSION_HEADER]: 'unknown-session' },
      { [BROWSER_SESSION_HEADER]: 'expired' },
    ]) {
      const session = await server.app.request(BROWSER_SESSION_PATH, { headers });
      await expectError(
        session,
        401,
        headers[BROWSER_SESSION_HEADER] === 'expired' ? 'SESSION_EXPIRED' : 'SESSION_NOT_FOUND',
      );
      const projects = await server.app.request(BROWSER_PROJECTS_PATH, { headers });
      await expectError(
        projects,
        401,
        headers[BROWSER_SESSION_HEADER] === 'expired' ? 'SESSION_EXPIRED' : 'SESSION_NOT_FOUND',
      );
    }
    await handle.close();
  });

  it('denies cross-project reads with 403 before any project data is loaded', async () => {
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions() }));
    const handle = await server.start();
    const overviewRes = await server.app.request('/api/v1/projects/secret-project/overview', {
      headers: authHeaders,
    });
    await expectError(overviewRes, 403, 'PROJECT_MISMATCH');
    const selector = encodeURIComponent(
      JSON.stringify({ version: 1, branchPath: { decisions: [] } }),
    );
    const graphsRes = await server.app.request(
      `/api/v1/projects/secret-project/graphs?${BROWSER_GRAPH_ROUTE_QUERY}=${selector}`,
      { headers: authHeaders },
    );
    await expectError(graphsRes, 403, 'PROJECT_MISMATCH');
    await handle.close();
  });

  it('returns 404 for an authorized project outside the server-scoped catalog', async () => {
    const ports = fakePorts();
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions(ports) }));
    const handle = await server.start();
    const overview = await server.app.request('/api/v1/projects/proj-b/overview', {
      headers: authHeaders,
    });
    await expectError(overview, 404, 'PROJECT_NOT_FOUND');
    const route = encodeURIComponent(JSON.stringify({ version: 1, branchPath: { decisions: [] } }));
    const graphs = await server.app.request(
      `/api/v1/projects/proj-b/graphs?${BROWSER_GRAPH_ROUTE_QUERY}=${route}`,
      { headers: authHeaders },
    );
    await expectError(graphs, 404, 'PROJECT_NOT_FOUND');
    expect(ports.graphCalls).toHaveLength(0);
    await handle.close();
  });

  it('serves no read routes on an unconfigured Host and 404s the read paths', async () => {
    const server = trackServer(createHostServer({ port: 0 }));
    expect(server.browser).toBeNull();
    expect(server.endpoints().reads).toEqual([]);
    const handle = await server.start();
    for (const path of [
      BROWSER_SESSION_PATH,
      BROWSER_PROJECTS_PATH,
      '/api/v1/projects/proj-a/overview',
      '/api/v1/projects/proj-a/graphs',
      '/api/v1/projects/proj-a/source',
    ]) {
      const res = await server.app.request(path, { headers: authHeaders });
      expect(res.status).toBe(404);
    }
    await handle.close();
  });

  it('exposes only GET: mutation methods on read paths are unknown routes', async () => {
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions() }));
    const handle = await server.start();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const path of [BROWSER_SESSION_PATH, '/api/v1/projects/proj-a/source']) {
        const res = await server.app.request(path, {
          method,
          headers: authHeaders,
        });
        expect(res.status).toBe(404);
      }
    }
    await handle.close();
  });

  it('404s unknown routes under the API base', async () => {
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions() }));
    const handle = await server.start();
    const res = await server.app.request('/api/v1/definitely-not-a-route', {
      headers: authHeaders,
    });
    expect(res.status).toBe(404);
    await handle.close();
  });

  it('guards mounted read routes with the Host allowlist', async () => {
    const server = trackServer(
      createHostServer({
        port: 0,
        browser: browserOptions(),
        mutation: { allowedHosts: ['localhost'] },
      }),
    );
    const handle = await server.start();
    const allowed = await server.app.request(BROWSER_SESSION_PATH, {
      headers: { ...authHeaders, host: 'localhost:9000' },
    });
    expect(allowed.status).toBe(200);
    const denied = await server.app.request(BROWSER_SESSION_PATH, {
      headers: { ...authHeaders, host: 'evil.example' },
    });
    expect(denied.status).toBe(403);
    await handle.close();
  });
});

// ─── Source Studio route ─────────────────────────────────────────────────────

describe('source studio route', () => {
  it('serves Host-derived accepted projection and working descriptors only', async () => {
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions() }));
    const handle = await server.start();
    const res = await server.app.request('/api/v1/projects/proj-a/source', {
      headers: authHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SourceStudioStateV1;
    expect(body).toEqual(sourceStudio);
    expect(body.accepted).toEqual(projection);
    expect(body.working.documents.map((document) => document.documentId)).toEqual([
      'chapters/chapter_01/_chapter.yaml',
      'scenes/E1.md',
    ]);
    const serialized = JSON.stringify(body);
    // Never raw source/Yjs bytes, filesystem paths, Git, SQLite, credentials,
    // capability tokens, or operation output paths.
    expect(serialized).not.toContain('rootLabel');
    expect(serialized).not.toContain('rootPath');
    expect(serialized).not.toContain('/home/');
    expect(serialized).not.toContain('credential');
    expect(serialized).not.toContain('capabilityToken');
    expect(serialized).not.toContain('git');
    expect(serialized).not.toContain('sqlite');
    expect(serialized).not.toContain('.nova/');
    expect(serialized).not.toContain('stateVector');
    expect(serialized).not.toContain('"update"');
    await handle.close();
  });

  it('returns 404 for an authorized-but-unlisted project without calling the source port', async () => {
    const ports = fakePorts();
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions(ports) }));
    const handle = await server.start();
    const res = await server.app.request('/api/v1/projects/proj-b/source', {
      headers: authHeaders,
    });
    await expectError(res, 404, 'PROJECT_NOT_FOUND');
    expect(ports.sourceCalls).toHaveLength(0);
    await handle.close();
  });

  it('denies cross-project source reads with 403 before the source port is reached', async () => {
    const ports = fakePorts();
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions(ports) }));
    const handle = await server.start();
    const res = await server.app.request('/api/v1/projects/secret-project/source', {
      headers: authHeaders,
    });
    await expectError(res, 403, 'PROJECT_MISMATCH');
    expect(ports.sourceCalls).toHaveLength(0);
    await handle.close();
  });

  it('rejects unauthenticated source reads with 401 before the source port is reached', async () => {
    const ports = fakePorts();
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions(ports) }));
    const handle = await server.start();
    for (const headers of [{}, { [BROWSER_SESSION_HEADER]: 'unknown-session' }]) {
      const res = await server.app.request('/api/v1/projects/proj-a/source', { headers });
      await expectError(res, 401, 'SESSION_NOT_FOUND');
    }
    expect(ports.sourceCalls).toHaveLength(0);
    await handle.close();
  });

  it('returns 404 when the source port cannot resolve a listed project (defense in depth)', async () => {
    const ports = fakePorts({
      source: { loadSourceStudio: async () => null },
    });
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions(ports) }));
    const handle = await server.start();
    const res = await server.app.request('/api/v1/projects/proj-a/source', {
      headers: authHeaders,
    });
    await expectError(res, 404, 'PROJECT_NOT_FOUND');
    await handle.close();
  });

  it('maps source port failures to 503 SOURCE_UNAVAILABLE', async () => {
    const ports = fakePorts({
      source: {
        loadSourceStudio: async () => {
          throw new Error('host source exploded');
        },
      },
    });
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions(ports) }));
    const handle = await server.start();
    const res = await server.app.request('/api/v1/projects/proj-a/source', {
      headers: authHeaders,
    });
    await expectError(res, 503, 'SOURCE_UNAVAILABLE');
    await handle.close();
  });
});

// ─── Strict graph selector handling ──────────────────────────────────────────

describe('graphs endpoint route selector', () => {
  const graphsUrl = (raw: string): string =>
    `/api/v1/projects/proj-a/graphs?${BROWSER_GRAPH_ROUTE_QUERY}=${encodeURIComponent(raw)}`;

  it('delegates a valid selector to the injected projector and returns its view', async () => {
    const ports = fakePorts();
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions(ports) }));
    const handle = await server.start();
    const selector = {
      version: 1,
      branchPath: {
        decisions: [{ atEventId: 'E2', choiceId: 'trust_seraphine', narrativeOrder: 1 }],
      },
      discourseBranch: 'main',
    };
    const res = await server.app.request(graphsUrl(JSON.stringify(selector)), {
      headers: authHeaders,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(graphProjection);
    expect(ports.graphCalls).toHaveLength(1);
    expect(ports.graphCalls[0]).toEqual({ projectId: 'proj-a', selector });
    await handle.close();
  });

  it('defaults an absent discourseBranch to the parser level and passes it through', async () => {
    const ports = fakePorts();
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions(ports) }));
    const handle = await server.start();
    const res = await server.app.request(
      graphsUrl(JSON.stringify({ version: 1, branchPath: { decisions: [] } })),
      { headers: authHeaders },
    );
    expect(res.status).toBe(200);
    expect(ports.graphCalls[0]?.selector).toEqual({
      version: 1,
      branchPath: { decisions: [] },
    });
    await handle.close();
  });

  it('rejects a missing selector without calling the projector', async () => {
    const ports = fakePorts();
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions(ports) }));
    const handle = await server.start();
    const res = await server.app.request('/api/v1/projects/proj-a/graphs', {
      headers: authHeaders,
    });
    await expectError(res, 400, 'INVALID_ROUTE_SELECTOR');
    expect(ports.graphCalls).toHaveLength(0);
    await handle.close();
  });

  it('rejects malformed JSON, wrong version, unknown keys, and bad decisions', async () => {
    const ports = fakePorts();
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions(ports) }));
    const handle = await server.start();
    const invalid = [
      'not-json',
      JSON.stringify({ version: 2, branchPath: { decisions: [] } }),
      JSON.stringify({ version: 1, branchPath: { decisions: [] }, extra: true }),
      JSON.stringify({ version: 1, branchPath: 'linear' }),
      JSON.stringify({
        version: 1,
        branchPath: { decisions: [{ atEventId: 'E1', choiceId: 'x', narrativeOrder: -1 }] },
      }),
      JSON.stringify({
        version: 1,
        branchPath: { decisions: [{ atEventId: 'E1', choiceId: 'x' }] },
      }),
      JSON.stringify({
        version: 1,
        branchPath: {
          decisions: [{ atEventId: 'E1', choiceId: 'x', narrativeOrder: 1, extra: true }],
        },
      }),
      JSON.stringify({ version: 1, branchPath: { decisions: [] }, discourseBranch: '' }),
    ];
    for (const raw of invalid) {
      const res = await server.app.request(graphsUrl(raw), { headers: authHeaders });
      await expectError(res, 400, 'INVALID_ROUTE_SELECTOR');
    }
    expect(ports.graphCalls).toHaveLength(0);
    await handle.close();
  });

  it('rejects multiple route query parameters', async () => {
    const ports = fakePorts();
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions(ports) }));
    const handle = await server.start();
    const one = JSON.stringify({ version: 1, branchPath: { decisions: [] } });
    const res = await server.app.request(
      `/api/v1/projects/proj-a/graphs?${BROWSER_GRAPH_ROUTE_QUERY}=${encodeURIComponent(one)}&${BROWSER_GRAPH_ROUTE_QUERY}=${encodeURIComponent(one)}`,
      { headers: authHeaders },
    );
    await expectError(res, 400, 'INVALID_ROUTE_SELECTOR');
    expect(ports.graphCalls).toHaveLength(0);
    await handle.close();
  });

  it('maps listed-project projector failures to 503 GRAPH_UNAVAILABLE', async () => {
    const ports = fakePorts({
      catalog: {
        listProjects: async () => [
          {
            version: 1,
            projectId: 'proj-a',
            displayName: 'Alpha',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
            open: true,
          },
          {
            version: 1,
            projectId: 'exploding',
            displayName: 'Exploding',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
            open: true,
          },
        ],
      },
    });
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions(ports) }));
    const handle = await server.start();
    const res = await server.app.request(
      graphsUrl(JSON.stringify({ version: 1, branchPath: { decisions: [] } })),
      { headers: { ...authHeaders } },
    );
    // The fake projector throws for the 'exploding' project id.
    const exploding = await server.app.request(
      '/api/v1/projects/exploding/graphs?route=' +
        encodeURIComponent(JSON.stringify({ version: 1, branchPath: { decisions: [] } })),
      { headers: authHeaders },
    );
    expect(exploding.status).toBe(503);
    const body = (await exploding.json()) as BrowserApiErrorV1;
    expect(body.error.code).toBe('GRAPH_UNAVAILABLE');
    expect(res.status).toBe(200);
    await handle.close();
  });
});

// ─── Selector parser unit behavior ───────────────────────────────────────────

describe('parseBrowserGraphRouteSelector', () => {
  it('accepts the documented shape with and without discourseBranch', () => {
    const parsed = parseBrowserGraphRouteSelector(
      JSON.stringify({ version: 1, branchPath: { decisions: [] } }),
    );
    expect(parsed).toEqual({ ok: true, selector: { version: 1, branchPath: { decisions: [] } } });
    const withBranch = parseBrowserGraphRouteSelector(
      JSON.stringify({
        version: 1,
        branchPath: { decisions: [{ atEventId: 'E1', choiceId: 'c1', narrativeOrder: 1 }] },
        discourseBranch: 'main',
      }),
    );
    expect(withBranch).toMatchObject({
      ok: true,
      selector: {
        version: 1,
        discourseBranch: 'main',
        branchPath: { decisions: [{ atEventId: 'E1', choiceId: 'c1', narrativeOrder: 1 }] },
      },
    });
  });

  it('rejects null, empty, and non-object payloads', () => {
    for (const raw of [null, undefined, '', 'null', '[]', '42', '"x"']) {
      expect(parseBrowserGraphRouteSelector(raw).ok).toBe(false);
    }
  });
});

// ─── Listener/server read seam ───────────────────────────────────────────────

describe('guarded read route seam', () => {
  it('registers GET-only guarded read routes projected in endpoints', async () => {
    const listener = trackListener(createHostListener({ port: 0 }));
    listener.registerReadRoute('/api/v1/custom', (c) => c.json({ ok: true }));
    expect(listener.endpoints().reads).toEqual([
      { method: 'GET', path: '/api/v1/custom', kind: 'read', guarded: true },
    ]);
    const handle = await listener.start();
    const res = await listener.app.request('/api/v1/custom');
    expect(res.status).toBe(200);
    const post = await listener.app.request('/api/v1/custom', { method: 'POST' });
    expect(post.status).toBe(404);
    await handle.close();
  });

  it('rejects invalid paths and late registration', async () => {
    const listener = createHostListener();
    expect(() => listener.registerReadRoute('api/v1/x', (c) => c.text('no'))).toThrow(
      HostListenerError,
    );
    expect(() => listener.registerReadRoute('', (c) => c.text('no'))).toThrow(HostListenerError);
    const started = trackListener(createHostListener({ port: 0 }));
    const handle = await started.start();
    expect(() => started.registerReadRoute('/api/v1/x', (c) => c.text('no'))).toThrow(
      HostListenerStateError,
    );
    await handle.close();
  });

  it('exposes read route registration through the server facade', async () => {
    const server = trackServer(createHostServer({ port: 0 }));
    server.registerReadRoute('/api/v1/ping', (c) => c.json({ ok: true }));
    expect(server.endpoints().reads).toEqual([
      { method: 'GET', path: '/api/v1/ping', kind: 'read', guarded: true },
    ]);
    const handle = await server.start();
    const res = await server.app.request('/api/v1/ping');
    expect(res.status).toBe(200);
    await handle.close();
  });

  it('projects mounted browser routes in the status body', async () => {
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions() }));
    const handle = await server.start();
    const res = await server.app.request('/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { endpoints: { reads: unknown[] } };
    expect(body.endpoints.reads).toEqual([
      { method: 'GET', path: BROWSER_SESSION_PATH, kind: 'read', guarded: true },
      { method: 'GET', path: BROWSER_PROJECTS_PATH, kind: 'read', guarded: true },
      { method: 'GET', path: BROWSER_PROJECT_OVERVIEW_PATH, kind: 'read', guarded: true },
      { method: 'GET', path: BROWSER_PROJECT_GRAPHS_PATH, kind: 'read', guarded: true },
      { method: 'GET', path: BROWSER_PROJECT_SOURCE_PATH, kind: 'read', guarded: true },
    ]);
    await handle.close();
  });
});

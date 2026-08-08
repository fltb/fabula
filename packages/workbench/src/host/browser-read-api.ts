/**
 * Host browser read surface: guarded GET routes mounted through the
 * listener's guarded pre-start read seam. Every route resolves identity
 * server-side from the request (the `x-fabula-session` header) through an
 * injected principal resolver and then gates project reads through an
 * injected authorization port — the caller never supplies an actor, project
 * path, credential, or capability token. Missing/unknown sessions and expired
 * sessions are 401; a valid session without access to the requested project
 * is 403; a project outside the caller's server-scoped catalog is 404.
 *
 * The graph route accepts exactly one strict documented route selector and
 * delegates to an injected graph projector; the source studio route
 * delegates to an injected Source Studio source — this module never compiles
 * or parses client bytes, never reconstructs graph/route semantics, and
 * never materializes raw source. All six ports are injected at construction;
 * without them the surface is never created, so an unconfigured Host exposes
 * no browser API at all.
 */

import type { Context, Handler } from 'hono';
import { REFERENCE_MCP_LIMITS_V1 } from '@novalistically/workbench-protocol';
import {
  BROWSER_API_VERSION,
  BROWSER_GRAPH_ROUTE_QUERY,
  BROWSER_PROJECT_CAPABILITIES_PATH,
  BROWSER_PROJECT_GRAPHS_PATH,
  BROWSER_PROJECT_OVERVIEW_PATH,
  BROWSER_PROJECT_REFERENCE_CONTENT_PATH,
  BROWSER_PROJECT_REFERENCE_PATH,
  BROWSER_PROJECT_REFERENCES_PATH,
  BROWSER_PROJECT_ROLE_PATH,
  BROWSER_PROJECT_SCENE_ADOPTION_PATH,
  BROWSER_PROJECT_SCENE_MAP_PATH,
  BROWSER_PROJECT_SCENE_PATH,
  BROWSER_PROJECTS_PATH,
  BROWSER_SESSION_HEADER,
  BROWSER_SESSION_PATH,
  BROWSER_SCENE_ADOPTION_EVENT_QUERY,
  BROWSER_SCENE_ADOPTION_REVISION_QUERY,
  type BrowserApiErrorV1,
  type BrowserGraphRouteSelectorV1,
  type BrowserProjectCapabilitiesV1,
  type BrowserProjectReferenceGetResultV1,
  type BrowserProjectReferenceReadQueryV1,
  type BrowserProjectReferenceReadResultV1,
  type BrowserProjectRoleV1,
  type BrowserProjectListV1,
  type BrowserProjectOverviewV1,
  type BrowserProjectReferenceListQueryV1,
  type BrowserProjectReferenceListV1,
  type BrowserProjectSummaryV1,
  type BrowserSessionPrincipalV1,
} from '../contracts/browser-api.js';
import type { WorkbenchGraphProjectionV1 } from '../contracts/graph.js';
import type { UserState } from '../contracts/persistence.js';
import type {
  SceneAdoptionViewV1,
  SceneMapViewV1,
} from '../contracts/scene.js';
import type { SceneDetailLoadResult } from './scene-map-service.js';
import {
  BROWSER_PROJECT_SOURCE_PATH,
  type SourceStudioStateV1,
} from '../contracts/source-studio.js';
import type { LocalAuthService } from './auth/service.js';
import type { HostListenerEnv } from './listener.js';
import type { ProjectAccessRequiredRole, ProjectAccessService } from './project-access-service.js';
import type { ProjectAccessRole } from '../contracts/configuration.js';
import type { SceneAdoptionFailureCode, SceneAdoptionPreparation } from './scene-adoption.js';

// ─── Injected ports ──────────────────────────────────────────────────────────

/** One browser read request resolved to a safe current-session principal. */
export type BrowserPrincipalResolution =
  | { readonly ok: true; readonly principal: BrowserSessionPrincipalV1 }
  | { readonly ok: false; readonly failure: 'SESSION_NOT_FOUND' | 'SESSION_EXPIRED' };

/**
 * Server-side identity resolution. The resolver reads the session credential
 * off the raw request and returns a safe principal (no session id, no
 * credential); the transport never chooses the actor.
 */
export interface BrowserPrincipalResolver {
  resolve(request: Request): Promise<BrowserPrincipalResolution>;
}

export interface BrowserPrincipalResolverOptions {
  /** Session lookup; a missing row means the session never existed or was revoked. */
  readonly sessions: Pick<LocalAuthService, 'getSession'>;
  /** Safe user lookup for the session's user (never the password-bearing record). */
  readonly users: { loadUser(userId: string): Promise<UserState | null> };
  /** Timestamp source for session expiry checks; defaults to the host clock. */
  readonly now?: () => string;
}

/**
 * Default principal resolver over the Host session store. Revoked sessions
 * are deleted, so they resolve exactly like unknown sessions
 * (`SESSION_NOT_FOUND`); expired sessions still have a row and are rejected
 * with `SESSION_EXPIRED`. The principal is assembled server-side and never
 * echoes the session id back.
 */
export function createBrowserPrincipalResolver(
  options: BrowserPrincipalResolverOptions,
): BrowserPrincipalResolver {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async resolve(request: Request): Promise<BrowserPrincipalResolution> {
      const sessionId = request.headers.get(BROWSER_SESSION_HEADER);
      if (sessionId === null || sessionId.length === 0) {
        return { ok: false, failure: 'SESSION_NOT_FOUND' };
      }
      const session = await options.sessions.getSession(sessionId);
      if (session === null) return { ok: false, failure: 'SESSION_NOT_FOUND' };
      if (session.expiresAt <= now()) return { ok: false, failure: 'SESSION_EXPIRED' };
      const user = await options.users.loadUser(session.userId);
      if (user === null) return { ok: false, failure: 'SESSION_NOT_FOUND' };
      return {
        ok: true,
        principal: {
          version: BROWSER_API_VERSION,
          userId: user.userId,
          role: user.role,
          displayName: user.displayName,
          capabilityVersion: user.capabilityVersion,
          expiresAt: session.expiresAt,
        },
      };
    },
  };
}

/**
 * Per-user project authorization, resolved server-side from the principal.
 * Denial is 403 before any project data is loaded.
 */
export interface BrowserProjectAuthorization {
  canAccessProject(
    userId: string,
    projectId: string,
    requiredRole?: ProjectAccessRequiredRole,
  ): boolean | Promise<boolean>;
}

/**
 * Server-scoped project catalog. The port receives the already-resolved
 * principal and returns only the projects that principal may see; the API
 * never filters on caller-supplied actor data.
 */
export interface BrowserProjectCatalog {
  listProjects(principal: BrowserSessionPrincipalV1): Promise<readonly BrowserProjectSummaryV1[]>;
}

/**
 * Overview source for one project. Returns null when the project is not in
 * the caller's catalog (404); otherwise the safe metadata + accepted session
 * projection + activity state.
 */
export interface BrowserProjectOverviewSource {
  loadOverview(projectId: string): Promise<BrowserProjectOverviewV1 | null>;
}

/**
 * Per-project capability projection source for one project. Returns null
 * when the project is not in the caller's catalog (404 — a second membership
 * boundary after the route's own gate). The feature list is derived by the
 * Host from already-registered services, never from front-end constants or
 * configuration alone.
 */
export interface BrowserProjectCapabilitiesSource {
  loadCapabilities(projectId: string): Promise<BrowserProjectCapabilitiesV1 | null>;
}

/**
 * Canonical graph projector. Produces the detached compiler-owned graph
 * projection for one strict route selector; the API never compiles or parses
 * client bytes and never rebuilds graph/route semantics.
 */
export interface BrowserGraphProjector {
  project(
    projectId: string,
    selector: BrowserGraphRouteSelectorV1,
  ): Promise<WorkbenchGraphProjectionV1>;
}

/**
 * Source Studio state source for one project. Returns null when the project
 * is not in the caller's catalog (404 — a second membership boundary after
 * the route's own gate, so an authorized-but-unlisted project can never
 * reveal data even if a caller bypasses the route). The returned state is
 * Host-derived only: accepted projection identity/diagnostics plus working
 * document descriptors, never raw source or Yjs bytes, filesystem paths,
 * Git, credentials, or capability tokens.
 */
export interface BrowserSourceStudioSource {
  loadSourceStudio(projectId: string): Promise<SourceStudioStateV1 | null>;
}

/**
 * Browser-safe reference library source for one project. The list route is
 * always present; `get` and `readContent` are optional until the Host wires
 * the full reference port, so the get/content routes register only when
 * their method is supplied.
 */
export interface BrowserReferenceLibrarySource {
  loadReferences(
    projectId: string,
    query: BrowserProjectReferenceListQueryV1,
  ): Promise<BrowserProjectReferenceListV1 | null>;
  get?(
    projectId: string,
    referenceId: string,
  ): Promise<BrowserProjectReferenceGetResultV1 | null>;
  readContent?(
    projectId: string,
    referenceId: string,
    query: BrowserProjectReferenceReadQueryV1,
  ): Promise<BrowserProjectReferenceReadResultV1 | null>;
}

/**
 * Scene adoption preparation source for one project (plan 5.2). It bridges
 * the Host-only `prepareSceneAdoption` service; the route projects only
 * the safe {@link SceneAdoptionViewV1} and maps failures to browser codes.
 */
export interface BrowserSceneAdoptionSource {
  prepare(input: {
    readonly projectId: string;
    readonly eventId: string;
    readonly revisionId: string;
  }): Promise<SceneAdoptionPreparation>;
}

/**
 * Scene Map surface for one project (plan 9.2). `loadSceneMap` returns null
 * when the surface cannot be produced for the project (no open session or no
 * canonical state projection); the route maps that to 503. `loadSceneDetail`
 * distinguishes an unknown event (404) from an unavailable surface (503).
 * The port is Host-only: it never receives caller-supplied source, hashes, or
 * capability tokens.
 */
export interface BrowserSceneMapSource {
  loadSceneMap(projectId: string): Promise<SceneMapViewV1 | null>;
  loadSceneDetail(projectId: string, eventId: string): Promise<SceneDetailLoadResult>;
}

/** All injected ports of the browser read surface. */
export interface BrowserReadApiOptions {
  readonly principal: BrowserPrincipalResolver;
  /** Shared ACL/lifecycle service. When present it is the authoritative gate. */
  readonly access?: Pick<ProjectAccessService, 'authorize' | 'listProjects'>;
  readonly authorization: BrowserProjectAuthorization;
  readonly catalog: BrowserProjectCatalog;
  readonly overview: BrowserProjectOverviewSource;
  readonly graph: BrowserGraphProjector;
  readonly source: BrowserSourceStudioSource;
  /**
   * Per-project capability projection. Optional until the Host wires a
   * capability source; the capabilities route is registered only when the
   * port is present (mirroring the optional references port).
   */
  readonly capabilities?: BrowserProjectCapabilitiesSource;
  /** Optional until the Host wires a scene-adoption source for the project. */
  readonly sceneAdoption?: BrowserSceneAdoptionSource;
  /**
   * Scene Map surface (plan 9.2): the scene-map and scene-detail GET routes
   * register only when the port is present, mirroring the optional
   * scene-adoption and references ports.
   */
  readonly sceneMap?: BrowserSceneMapSource;
  /** Optional until the durable reference port is configured for the project. */
  readonly references?: BrowserReferenceLibrarySource;
}

/** One GET route the surface exposes, mounted through the guarded read seam. */
export interface BrowserReadRoute {
  readonly path: string;
  readonly handler: Handler<HostListenerEnv>;
}

/**
 * The mounted browser read surface: the six fixed GET routes plus the
 * optional references, capabilities, and scene-adoption routes when their
 * ports are present.
 */
export interface BrowserReadApi {
  readonly routes: readonly BrowserReadRoute[];
}

// ─── Error mapping ───────────────────────────────────────────────────────────

const BROWSER_ERROR_STATUS: Readonly<Record<BrowserApiErrorV1['error']['code'], number>> = {
  SESSION_NOT_FOUND: 401,
  SESSION_EXPIRED: 401,
  PROJECT_MISMATCH: 403,
  PROJECT_NOT_FOUND: 404,
  INVALID_ROUTE_SELECTOR: 400,
  GRAPH_UNAVAILABLE: 503,
  SOURCE_UNAVAILABLE: 503,
  REFERENCE_NOT_FOUND: 404,
  REFERENCE_INVALID: 400,
  REFERENCE_UNAVAILABLE: 503,
  REFERENCE_CONFLICT: 409,
  REFERENCE_IMPORT_FAILED: 500,
  REFERENCE_SIZE_EXCEEDED: 413,
  REVIEW_COMMENT_NOT_FOUND: 404,
  REVIEW_INVALID: 400,
  REVIEW_UNAVAILABLE: 503,
  GATE_NOT_FOUND: 404,
  GATE_NOT_OPEN: 409,
  GATE_DECISION_INVALID: 400,
  PUBLICATION_NOT_FOUND: 404,
  PUBLICATION_INVALID: 400,
  PUBLICATION_UNAVAILABLE: 503,
  PUBLICATION_CONFLICT: 409,
  AGENT_CHAT_UNAVAILABLE: 503,
  AGENT_CHAT_CONVERSATION_NOT_FOUND: 404,
  AGENT_CHAT_RUN_NOT_FOUND: 404,
  AGENT_CHAT_INVALID: 400,
  AGENT_CHAT_RUN_TERMINAL: 409,
  AGENT_CHAT_QUEUE_FULL: 409,
  SCENE_ADOPTION_NOT_FOUND: 404,
  SCENE_ADOPTION_INVALID: 400,
  SCENE_ADOPTION_UNAVAILABLE: 503,
  SCENE_NOT_FOUND: 404,
  SCENE_RENDER_INVALID: 400,
  SCENE_RENDER_QUEUE_FULL: 409,
  SCENE_RENDER_UNAVAILABLE: 503,
  SCENE_MAP_UNAVAILABLE: 503,
  PROJECT_IMPORT_NOT_FOUND: 404,
  PROJECT_IMPORT_INVALID: 400,
  PROJECT_IMPORT_CONFLICT: 409,
};

export function errorResponse(code: BrowserApiErrorV1['error']['code'], message: string): Response {
  const body: BrowserApiErrorV1 = { error: { code, message } };
  return new Response(JSON.stringify(body), {
    status: BROWSER_ERROR_STATUS[code],
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}


// ─── Strict route selector parsing ───────────────────────────────────────────

export type BrowserRouteSelectorParseResult =
  | { readonly ok: true; readonly selector: BrowserGraphRouteSelectorV1 }
  | { readonly ok: false; readonly code: 'INVALID_ROUTE_SELECTOR'; readonly message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Exactly one decision shape: `{ atEventId, choiceId, narrativeOrder }`. */
function parseDecision(value: unknown, index: number): string | null {
  if (!isPlainObject(value)) return `route decision ${index} must be an object`;
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !('atEventId' in value) ||
    !('choiceId' in value) ||
    !('narrativeOrder' in value)
  ) {
    return `route decision ${index} must contain exactly atEventId, choiceId, narrativeOrder`;
  }
  const { atEventId, choiceId, narrativeOrder } = value;
  if (typeof atEventId !== 'string' || atEventId.length === 0) {
    return `route decision ${index} atEventId must be a non-empty string`;
  }
  if (typeof choiceId !== 'string' || choiceId.length === 0) {
    return `route decision ${index} choiceId must be a non-empty string`;
  }
  if (
    typeof narrativeOrder !== 'number' ||
    !Number.isSafeInteger(narrativeOrder) ||
    narrativeOrder < 0
  ) {
    return `route decision ${index} narrativeOrder must be a non-negative integer`;
  }
  return null;
}

/**
 * Parse and strictly validate the `route` query parameter of the graphs
 * endpoint. Accepts exactly the documented selector shape (see
 * {@link BrowserGraphRouteSelectorV1}); anything else — missing parameter,
 * malformed JSON, unknown keys, wrong types, malformed decisions — is
 * rejected. This is pure route identity validation; no graph or project data
 * is compiled or parsed here.
 */
export function parseBrowserGraphRouteSelector(
  raw: string | null | undefined,
): BrowserRouteSelectorParseResult {
  if (raw === null || raw === undefined || raw.length === 0) {
    return {
      ok: false,
      code: 'INVALID_ROUTE_SELECTOR',
      message: `missing ${BROWSER_GRAPH_ROUTE_QUERY} query parameter carrying the route selector`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {
      ok: false,
      code: 'INVALID_ROUTE_SELECTOR',
      message: `${BROWSER_GRAPH_ROUTE_QUERY} must be URL-encoded JSON`,
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      code: 'INVALID_ROUTE_SELECTOR',
      message: `${BROWSER_GRAPH_ROUTE_QUERY} must be a JSON object`,
    };
  }
  const topKeys = Object.keys(parsed);
  if (
    topKeys.length < 2 ||
    !('version' in parsed) ||
    !('branchPath' in parsed) ||
    (topKeys.length === 3 && !('discourseBranch' in parsed)) ||
    topKeys.length > 3 ||
    topKeys.some((key) => key !== 'version' && key !== 'branchPath' && key !== 'discourseBranch')
  ) {
    return {
      ok: false,
      code: 'INVALID_ROUTE_SELECTOR',
      message: `${BROWSER_GRAPH_ROUTE_QUERY} must contain exactly version and branchPath, with optional discourseBranch`,
    };
  }
  if (parsed.version !== BROWSER_API_VERSION) {
    return {
      ok: false,
      code: 'INVALID_ROUTE_SELECTOR',
      message: `${BROWSER_GRAPH_ROUTE_QUERY} version must be ${BROWSER_API_VERSION}`,
    };
  }
  const branchPath = parsed.branchPath;
  if (
    !isPlainObject(branchPath) ||
    Object.keys(branchPath).length !== 1 ||
    !('decisions' in branchPath) ||
    !Array.isArray(branchPath.decisions)
  ) {
    return {
      ok: false,
      code: 'INVALID_ROUTE_SELECTOR',
      message: `${BROWSER_GRAPH_ROUTE_QUERY} branchPath must contain exactly a decisions array`,
    };
  }
  const decisions: Array<{
    readonly atEventId: string;
    readonly choiceId: string;
    readonly narrativeOrder: number;
  }> = [];
  for (let index = 0; index < branchPath.decisions.length; index++) {
    const error = parseDecision(branchPath.decisions[index], index);
    if (error !== null) {
      return { ok: false, code: 'INVALID_ROUTE_SELECTOR', message: error };
    }
    const decision = branchPath.decisions[index] as Record<string, unknown>;
    decisions.push({
      atEventId: decision.atEventId as string,
      choiceId: decision.choiceId as string,
      narrativeOrder: decision.narrativeOrder as number,
    });
  }
  let discourseBranch: string | undefined;
  if ('discourseBranch' in parsed) {
    const value = parsed.discourseBranch;
    if (typeof value !== 'string' || value.length === 0) {
      return {
        ok: false,
        code: 'INVALID_ROUTE_SELECTOR',
        message: `${BROWSER_GRAPH_ROUTE_QUERY} discourseBranch must be a non-empty string`,
      };
    }
    discourseBranch = value;
  }
  return {
    ok: true,
    selector: {
      version: BROWSER_API_VERSION,
      branchPath: { decisions },
      ...(discourseBranch === undefined ? {} : { discourseBranch }),
    },
  };
}

// ─── Route construction ──────────────────────────────────────────────────────

/** Resolve the principal or short-circuit with the 401 error response. */
async function resolveOrDeny(
  api: BrowserReadApiImpl,
  c: Context<HostListenerEnv>,
): Promise<Response | BrowserSessionPrincipalV1> {
  const resolution = await api.options.principal.resolve(c.req.raw);
  if (!resolution.ok) {
    return errorResponse(
      resolution.failure,
      resolution.failure === 'SESSION_EXPIRED'
        ? 'The session has expired.'
        : 'The session is missing, revoked, or unknown.',
    );
  }
  return resolution.principal;
}

function sessionHandler(api: BrowserReadApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const principal = await resolveOrDeny(api, c);
    if (principal instanceof Response) return principal;
    return c.json(principal);
  };
}

function projectsHandler(api: BrowserReadApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const principal = await resolveOrDeny(api, c);
    if (principal instanceof Response) return principal;
    const projects = await api.options.catalog.listProjects(principal);
    const body: BrowserProjectListV1 = { version: BROWSER_API_VERSION, projects };
    return c.json(body);
  };
}

/** Catalog membership is a second server-side boundary after authorization. */
async function projectIsListed(
  api: BrowserReadApiImpl,
  principal: BrowserSessionPrincipalV1,
  projectId: string,
): Promise<boolean> {
  const projects =
    api.options.access !== undefined
      ? await api.options.access.listProjects(principal)
      : await api.options.catalog.listProjects(principal);
  return projects.some((project) => project.projectId === projectId);
}

async function canAccess(
  api: BrowserReadApiImpl,
  principal: BrowserSessionPrincipalV1,
  projectId: string,
): Promise<boolean> {
  if (api.options.access !== undefined) {
    return (
      await api.options.access.authorize({
        userId: principal.userId,
        projectId,
        requiredRole: 'reader',
      })
    ).ok;
  }
  return await api.options.authorization.canAccessProject(principal.userId, projectId);
}

function overviewHandler(api: BrowserReadApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const principal = await resolveOrDeny(api, c);
    if (principal instanceof Response) return principal;
    const projectId = c.req.param('projectId');
    if (projectId === undefined || projectId.length === 0) {
      return errorResponse('PROJECT_NOT_FOUND', "The project is not in this session's catalog.");
    }
    if (!(await canAccess(api, principal, projectId))) {
      return c.json(
        {
          error: {
            code: 'PROJECT_MISMATCH',
            message: 'The session is not authorized for this project.',
          },
        } satisfies BrowserApiErrorV1,
        403,
      );
    }
    if (!(await projectIsListed(api, principal, projectId))) {
      return c.json(
        {
          error: {
            code: 'PROJECT_NOT_FOUND',
            message: "The project is not in this session's catalog.",
          },
        } satisfies BrowserApiErrorV1,
        404,
      );
    }
    const overview = await api.options.overview.loadOverview(projectId);
    if (overview === null) {
      return c.json(
        {
          error: {
            code: 'PROJECT_NOT_FOUND',
            message: "The project is not in this session's catalog.",
          },
        } satisfies BrowserApiErrorV1,
        404,
      );
    }
    return c.json(overview);
  };
}

function capabilitiesHandler(api: BrowserReadApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    // Strict order: identity, authorization, catalog membership, then the
    // capability port — an authorized-but-unlisted project never reaches it.
    const principal = await resolveOrDeny(api, c);
    if (principal instanceof Response) return principal;
    const projectId = c.req.param('projectId');
    if (projectId === undefined || projectId.length === 0) {
      return errorResponse('PROJECT_NOT_FOUND', "The project is not in this session's catalog.");
    }
    if (!(await canAccess(api, principal, projectId))) {
      return errorResponse('PROJECT_MISMATCH', 'The session is not authorized for this project.');
    }
    if (!(await projectIsListed(api, principal, projectId))) {
      return errorResponse('PROJECT_NOT_FOUND', "The project is not in this session's catalog.");
    }
    if (api.options.capabilities === undefined) {
      return errorResponse('PROJECT_NOT_FOUND', "The project is not in this session's catalog.");
    }
    const capabilities = await api.options.capabilities.loadCapabilities(projectId);
    if (capabilities === null) {
      return errorResponse('PROJECT_NOT_FOUND', "The project is not in this session's catalog.");
    }
    return c.json(capabilities);
  };
}

function graphsHandler(api: BrowserReadApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const principal = await resolveOrDeny(api, c);
    if (principal instanceof Response) return principal;
    const projectId = c.req.param('projectId');
    if (projectId === undefined || projectId.length === 0) {
      return errorResponse('PROJECT_NOT_FOUND', "The project is not in this session's catalog.");
    }
    if (!(await canAccess(api, principal, projectId))) {
      return c.json(
        {
          error: {
            code: 'PROJECT_MISMATCH',
            message: 'The session is not authorized for this project.',
          },
        } satisfies BrowserApiErrorV1,
        403,
      );
    }
    if (!(await projectIsListed(api, principal, projectId))) {
      return c.json(
        {
          error: {
            code: 'PROJECT_NOT_FOUND',
            message: "The project is not in this session's catalog.",
          },
        } satisfies BrowserApiErrorV1,
        404,
      );
    }
    // Strict single-selector rule: exactly one `route` query parameter.
    const values = c.req.queries(BROWSER_GRAPH_ROUTE_QUERY);
    const raw = values === undefined || values.length === 0 ? null : values[0];
    if (values !== undefined && values.length > 1) {
      return errorResponse(
        'INVALID_ROUTE_SELECTOR',
        `exactly one ${BROWSER_GRAPH_ROUTE_QUERY} query parameter is accepted`,
      );
    }
    const parsed = parseBrowserGraphRouteSelector(raw);
    if (!parsed.ok) return errorResponse(parsed.code, parsed.message);
    try {
      const projection = await api.options.graph.project(projectId, parsed.selector);
      return c.json(projection);
    } catch {
      return errorResponse(
        'GRAPH_UNAVAILABLE',
        'The requested route could not be projected by the host.',
      );
    }
  };
}

function sourceStudioHandler(api: BrowserReadApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    // Strict order: identity, authorization, catalog membership, then the
    // source port — an authorized-but-unlisted project never reaches it.
    const principal = await resolveOrDeny(api, c);
    if (principal instanceof Response) return principal;
    const projectId = c.req.param('projectId');
    if (projectId === undefined || projectId.length === 0) {
      return errorResponse('PROJECT_NOT_FOUND', "The project is not in this session's catalog.");
    }
    if (!(await canAccess(api, principal, projectId))) {
      return c.json(
        {
          error: {
            code: 'PROJECT_MISMATCH',
            message: 'The session is not authorized for this project.',
          },
        } satisfies BrowserApiErrorV1,
        403,
      );
    }
    if (!(await projectIsListed(api, principal, projectId))) {
      return c.json(
        {
          error: {
            code: 'PROJECT_NOT_FOUND',
            message: "The project is not in this session's catalog.",
          },
        } satisfies BrowserApiErrorV1,
        404,
      );
    }
    try {
      const state = await api.options.source.loadSourceStudio(projectId);
      // The port is a second membership boundary: a listed project whose
      // state the port cannot resolve is still never revealed as data.
      if (state === null) {
        return c.json(
          {
            error: {
              code: 'PROJECT_NOT_FOUND',
              message: "The project is not in this session's catalog.",
            },
          } satisfies BrowserApiErrorV1,
          404,
        );
      }
      return c.json(state);
    } catch {
      return errorResponse(
        'SOURCE_UNAVAILABLE',
        'The Source Studio state could not be loaded by the host.',
      );
    }
  };
}

function referencesHandler(api: BrowserReadApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const principal = await resolveOrDeny(api, c);
    if (principal instanceof Response) return principal;
    const projectId = c.req.param('projectId');
    if (projectId === undefined || projectId.length === 0) {
      return errorResponse('PROJECT_NOT_FOUND', "The project is not in this session's catalog.");
    }
    if (!(await canAccess(api, principal, projectId))) {
      return errorResponse('PROJECT_MISMATCH', 'The session is not authorized for this project.');
    }
    if (!(await projectIsListed(api, principal, projectId))) {
      return errorResponse('PROJECT_NOT_FOUND', "The project is not in this session's catalog.");
    }
    if (api.options.references === undefined) {
      return errorResponse(
        'REFERENCE_UNAVAILABLE',
        'The reference library is not enabled for this project.',
      );
    }
    const rawPageSize = c.req.query('pageSize');
    const rawCursor = c.req.query('cursor');
    const pageSize =
      rawPageSize === undefined
        ? undefined
        : /^[1-9][0-9]*$/.test(rawPageSize)
          ? Number(rawPageSize)
          : NaN;
    if (
      (pageSize !== undefined && (!Number.isSafeInteger(pageSize) || pageSize > 50)) ||
      (rawCursor !== undefined && (rawCursor.length === 0 || rawCursor.length > 256))
    ) {
      return errorResponse('REFERENCE_INVALID', 'Reference pagination query is invalid.');
    }
    const query: BrowserProjectReferenceListQueryV1 = {
      ...(pageSize === undefined ? {} : { pageSize }),
      ...(rawCursor === undefined ? {} : { cursor: rawCursor }),
    };
    try {
      const references = await api.options.references.loadReferences(projectId, query);
      if (references === null) {
        return errorResponse(
          'REFERENCE_UNAVAILABLE',
          'The reference library is not enabled for this project.',
        );
      }
      return c.json(references);
    } catch {
      return errorResponse(
        'REFERENCE_UNAVAILABLE',
        'The reference library could not be loaded by the host.',
      );
    }
  };
}

/**
 * Shared guard chain for the one-reference and content routes: principal →
 * project ACL → catalog listing → reference port presence. Returns the
 * resolved project id on success, or an error Response to short-circuit.
 */
async function referenceRouteGuard(
  api: BrowserReadApiImpl,
  c: Context<HostListenerEnv>,
): Promise<Response | { readonly projectId: string; readonly referenceId: string }> {
  const principal = await resolveOrDeny(api, c);
  if (principal instanceof Response) return principal;
  const projectId = c.req.param('projectId');
  const referenceId = c.req.param('referenceId');
  if (projectId === undefined || projectId.length === 0) {
    return errorResponse('PROJECT_NOT_FOUND', "The project is not in this session's catalog.");
  }
  if (referenceId === undefined || referenceId.length === 0 || referenceId.length > 128) {
    return errorResponse('REFERENCE_INVALID', 'The reference id is missing or exceeds its bound.');
  }
  if (!(await canAccess(api, principal, projectId))) {
    return errorResponse('PROJECT_MISMATCH', 'The session is not authorized for this project.');
  }
  if (!(await projectIsListed(api, principal, projectId))) {
    return errorResponse('PROJECT_NOT_FOUND', "The project is not in this session's catalog.");
  }
  if (api.options.references === undefined) {
    return errorResponse(
      'REFERENCE_UNAVAILABLE',
      'The reference library is not enabled for this project.',
    );
  }
  return { projectId, referenceId };
}

function referenceGetHandler(api: BrowserReadApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const guarded = await referenceRouteGuard(api, c);
    if (guarded instanceof Response) return guarded;
    try {
      const result = await api.options.references!.get?.(guarded.projectId, guarded.referenceId);
      if (result === null || result === undefined) {
        return errorResponse('REFERENCE_NOT_FOUND', 'The requested reference does not exist.');
      }
      return c.json(result);
    } catch {
      return errorResponse(
        'REFERENCE_UNAVAILABLE',
        'The reference library could not be read by the host.',
      );
    }
  };
}

function referenceContentHandler(api: BrowserReadApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const guarded = await referenceRouteGuard(api, c);
    if (guarded instanceof Response) return guarded;
    const rawOffset = c.req.query('offset');
    const rawLimit = c.req.query('limit');
    const offset = rawOffset === undefined ? undefined : Number(rawOffset);
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    if (
      offset === undefined ||
      limit === undefined ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > REFERENCE_MCP_LIMITS_V1.maxRangeBytes
    ) {
      return errorResponse(
        'REFERENCE_INVALID',
        'The content read requires a bounded offset and limit.',
      );
    }
    const query: BrowserProjectReferenceReadQueryV1 = { offset, limit };
    try {
      const result = await api.options.references!.readContent?.(
        guarded.projectId,
        guarded.referenceId,
        query,
      );
      if (result === null || result === undefined) {
        return errorResponse('REFERENCE_NOT_FOUND', 'The requested reference does not exist.');
      }
      return c.json(result);
    } catch {
      return errorResponse(
        'REFERENCE_UNAVAILABLE',
        'The reference content could not be read by the host.',
      );
    }
  };
}

// ─── Scene adoption query parsing ────────────────────────────────────────────

type SceneAdoptionQueryParse =
  | { readonly ok: true; readonly eventId: string; readonly revisionId: string }
  | { readonly ok: false; readonly message: string };

/** Exactly one non-empty, bounded `eventId` and `revisionId` query value. */
function parseSceneAdoptionQuery(c: Context<HostListenerEnv>): SceneAdoptionQueryParse {
  const eventValues = c.req.queries(BROWSER_SCENE_ADOPTION_EVENT_QUERY);
  const revisionValues = c.req.queries(BROWSER_SCENE_ADOPTION_REVISION_QUERY);
  if (
    eventValues === undefined ||
    eventValues.length !== 1 ||
    revisionValues === undefined ||
    revisionValues.length !== 1
  ) {
    return {
      ok: false,
      message: 'exactly one eventId and one revisionId query parameter is required',
    };
  }
  const eventId = eventValues[0] ?? '';
  const revisionId = revisionValues[0] ?? '';
  if (
    eventId.length === 0 ||
    eventId.length > 256 ||
    revisionId.length === 0 ||
    revisionId.length > 256
  ) {
    return {
      ok: false,
      message: 'eventId and revisionId must be non-empty strings of at most 256 characters',
    };
  }
  return { ok: true, eventId, revisionId };
}

/** Map a Host adoption failure to the browser error code for the surface. */
const SCENE_ADOPTION_ERROR_CODE: Readonly<
  Record<SceneAdoptionFailureCode, BrowserApiErrorV1['error']['code']>
> = {
  REVISION_NOT_FOUND: 'SCENE_ADOPTION_NOT_FOUND',
  REVISION_MISMATCH: 'SCENE_ADOPTION_NOT_FOUND',
  REVISION_INVALID: 'SCENE_ADOPTION_UNAVAILABLE',
  REVISION_UNRELEASED: 'SCENE_ADOPTION_UNAVAILABLE',
  PROSE_HASH_MISMATCH: 'SCENE_ADOPTION_UNAVAILABLE',
};

function sceneAdoptionHandler(api: BrowserReadApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    // Strict order: identity, authorization, catalog membership, then the
    // adoption port — an authorized-but-unlisted project never reaches it.
    const principal = await resolveOrDeny(api, c);
    if (principal instanceof Response) return principal;
    const projectId = c.req.param('projectId');
    if (projectId === undefined || projectId.length === 0) {
      return errorResponse('PROJECT_NOT_FOUND', "The project is not in this session's catalog.");
    }
    if (!(await canAccess(api, principal, projectId))) {
      return errorResponse('PROJECT_MISMATCH', 'The session is not authorized for this project.');
    }
    if (!(await projectIsListed(api, principal, projectId))) {
      return errorResponse('PROJECT_NOT_FOUND', "The project is not in this session's catalog.");
    }
    if (api.options.sceneAdoption === undefined) {
      return errorResponse(
        'SCENE_ADOPTION_UNAVAILABLE',
        'The scene adoption surface is not enabled for this project.',
      );
    }
    const query = parseSceneAdoptionQuery(c);
    if (!query.ok) return errorResponse('SCENE_ADOPTION_INVALID', query.message);
    try {
      const preparation = await api.options.sceneAdoption.prepare({
        projectId,
        eventId: query.eventId,
        revisionId: query.revisionId,
      });
      if (!preparation.ok) {
        return errorResponse(SCENE_ADOPTION_ERROR_CODE[preparation.code], preparation.message);
      }
      // Only the safe view crosses the browser boundary: no claim, no entry
      // bytes, no authoring-manifest material.
      const view: SceneAdoptionViewV1 = {
        version: 1,
        eventId: preparation.claim.eventId,
        revisionId: preparation.claim.revisionId,
        proseHash: preparation.claim.proseHash,
        released: preparation.claim.released,
        disclosure: preparation.disclosure,
      };
      return c.json(view);
    } catch {
      return errorResponse(
        'SCENE_ADOPTION_UNAVAILABLE',
        'The scene adoption preview could not be produced by the host.',
      );
    }
  };
}

/**
 * Shared guard chain for the scene-map and scene-detail routes: identity →
 * project ACL → catalog listing → scene-map port presence. Returns the
 * resolved project id on success, or an error Response to short-circuit.
 */
async function sceneRouteGuard(
  api: BrowserReadApiImpl,
  c: Context<HostListenerEnv>,
): Promise<Response | { readonly projectId: string }> {
  const principal = await resolveOrDeny(api, c);
  if (principal instanceof Response) return principal;
  const projectId = c.req.param('projectId');
  if (projectId === undefined || projectId.length === 0) {
    return errorResponse('PROJECT_NOT_FOUND', "The project is not in this session's catalog.");
  }
  if (!(await canAccess(api, principal, projectId))) {
    return errorResponse('PROJECT_MISMATCH', 'The session is not authorized for this project.');
  }
  if (!(await projectIsListed(api, principal, projectId))) {
    return errorResponse('PROJECT_NOT_FOUND', "The project is not in this session's catalog.");
  }
  if (api.options.sceneMap === undefined) {
    return errorResponse(
      'SCENE_MAP_UNAVAILABLE',
      'The Scene Map surface is not enabled for this project.',
    );
  }
  return { projectId };
}

function sceneMapHandler(api: BrowserReadApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const guard = await sceneRouteGuard(api, c);
    if (guard instanceof Response) return guard;
    try {
      const view = await api.options.sceneMap!.loadSceneMap(guard.projectId);
      if (view === null) {
        return errorResponse(
          'SCENE_MAP_UNAVAILABLE',
          'The Scene Map could not be produced for this project.',
        );
      }
      return c.json(view);
    } catch {
      return errorResponse(
        'SCENE_MAP_UNAVAILABLE',
        'The Scene Map could not be produced for this project.',
      );
    }
  };
}

function sceneDetailHandler(api: BrowserReadApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const guard = await sceneRouteGuard(api, c);
    if (guard instanceof Response) return guard;
    const eventId = c.req.param('eventId');
    if (eventId === undefined || eventId.length === 0 || eventId.length > 256) {
      return errorResponse('SCENE_NOT_FOUND', 'A bounded scene event id is required.');
    }
    try {
      const outcome = await api.options.sceneMap!.loadSceneDetail(guard.projectId, eventId);
      if (!outcome.ok) {
        return errorResponse(
          outcome.code === 'SCENE_NOT_FOUND' ? 'SCENE_NOT_FOUND' : 'SCENE_MAP_UNAVAILABLE',
          outcome.message,
        );
      }
      return c.json(outcome.view);
    } catch {
      return errorResponse(
        'SCENE_MAP_UNAVAILABLE',
        'The scene detail could not be produced for this project.',
      );
    }
  };
}

/**
 * Resolve the caller's ACL role for one project through the shared access
 * port. The Host's implicit owner override is normalized to `maintainer`,
 * matching the Agent chat role resolver.
 */
async function resolveProjectRole(
  api: BrowserReadApiImpl,
  principal: BrowserSessionPrincipalV1,
  projectId: string,
): Promise<ProjectAccessRole | null> {
  if (api.options.access === undefined) return null;
  const result = await api.options.access.authorize({
    userId: principal.userId,
    projectId,
    requiredRole: 'reader',
  });
  if (!result.ok) return null;
  const role = result.grant.role;
  return role === 'owner' ? 'maintainer' : role;
}

function projectRoleHandler(api: BrowserReadApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const principal = await resolveOrDeny(api, c);
    if (principal instanceof Response) return principal;
    const projectId = c.req.param('projectId');
    if (projectId === undefined || projectId.length === 0) {
      return errorResponse('PROJECT_NOT_FOUND', "The project is not in this session's catalog.");
    }
    if (!(await canAccess(api, principal, projectId))) {
      return errorResponse('PROJECT_MISMATCH', 'The session is not authorized for this project.');
    }
    if (!(await projectIsListed(api, principal, projectId))) {
      return errorResponse('PROJECT_NOT_FOUND', "The project is not in this session's catalog.");
    }
    const role = await resolveProjectRole(api, principal, projectId);
    const body: BrowserProjectRoleV1 = { version: BROWSER_API_VERSION, role };
    return c.json(body);
  };
}

class BrowserReadApiImpl {
  constructor(readonly options: BrowserReadApiOptions) {}
}

/**
 * Create the browser read surface over the injected ports. The surface is a
 * list of guarded GET route registrations; the Host mounts them through the
 * listener's pre-start read seam during server construction, so an API is
 * never created (and no route is ever exposed) without every port.
 */
export function createBrowserReadApi(options: BrowserReadApiOptions): BrowserReadApi {
  const api = new BrowserReadApiImpl(options);
  return {
    routes: [
      { path: BROWSER_SESSION_PATH, handler: sessionHandler(api) },
      { path: BROWSER_PROJECTS_PATH, handler: projectsHandler(api) },
      { path: BROWSER_PROJECT_OVERVIEW_PATH, handler: overviewHandler(api) },
      ...(options.capabilities === undefined
        ? []
        : [{ path: BROWSER_PROJECT_CAPABILITIES_PATH, handler: capabilitiesHandler(api) }]),
      { path: BROWSER_PROJECT_GRAPHS_PATH, handler: graphsHandler(api) },
      { path: BROWSER_PROJECT_SOURCE_PATH, handler: sourceStudioHandler(api) },
      ...(options.sceneAdoption === undefined
        ? []
        : [{ path: BROWSER_PROJECT_SCENE_ADOPTION_PATH, handler: sceneAdoptionHandler(api) }]),
      ...(options.sceneMap === undefined
        ? []
        : [
            { path: BROWSER_PROJECT_SCENE_MAP_PATH, handler: sceneMapHandler(api) },
            { path: BROWSER_PROJECT_SCENE_PATH, handler: sceneDetailHandler(api) },
          ]),
      { path: BROWSER_PROJECT_ROLE_PATH, handler: projectRoleHandler(api) },
      ...(options.references === undefined
        ? []
        : [
            { path: BROWSER_PROJECT_REFERENCES_PATH, handler: referencesHandler(api) },
            ...(options.references.get === undefined
              ? []
              : [{ path: BROWSER_PROJECT_REFERENCE_PATH, handler: referenceGetHandler(api) }]),
            ...(options.references.readContent === undefined
              ? []
              : [
                  {
                    path: BROWSER_PROJECT_REFERENCE_CONTENT_PATH,
                    handler: referenceContentHandler(api),
                  },
                ]),
          ]),
    ],
  };
}

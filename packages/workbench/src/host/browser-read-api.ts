/**
 * Host browser read surface: five authenticated GET routes mounted through
 * the listener's guarded pre-start read seam. Every route resolves identity
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
import {
  BROWSER_API_VERSION,
  BROWSER_GRAPH_ROUTE_QUERY,
  BROWSER_PROJECT_GRAPHS_PATH,
  BROWSER_PROJECT_OVERVIEW_PATH,
  BROWSER_PROJECT_REFERENCES_PATH,
  BROWSER_PROJECTS_PATH,
  BROWSER_SESSION_HEADER,
  BROWSER_SESSION_PATH,
  type BrowserApiErrorV1,
  type BrowserGraphRouteSelectorV1,
  type BrowserProjectListV1,
  type BrowserProjectOverviewV1,
  type BrowserProjectReferenceListQueryV1,
  type BrowserProjectReferenceListV1,
  type BrowserProjectSummaryV1,
  type BrowserSessionPrincipalV1,
} from '../contracts/browser-api.js';
import type { WorkbenchGraphProjectionV1 } from '../contracts/graph.js';
import type { UserState } from '../contracts/persistence.js';
import {
  BROWSER_PROJECT_SOURCE_PATH,
  type SourceStudioStateV1,
} from '../contracts/source-studio.js';
import type { LocalAuthService } from './auth/service.js';
import type { HostListenerEnv } from './listener.js';
import type { ProjectAccessRequiredRole, ProjectAccessService } from './project-access-service.js';

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

/** Browser-safe reference catalog source for one project. */
export interface BrowserReferenceLibrarySource {
  loadReferences(
    projectId: string,
    query: BrowserProjectReferenceListQueryV1,
  ): Promise<BrowserProjectReferenceListV1 | null>;
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
  /** Optional until the durable reference port is configured for the project. */
  readonly references?: BrowserReferenceLibrarySource;
}

/** One GET route the surface exposes, mounted through the guarded read seam. */
export interface BrowserReadRoute {
  readonly path: string;
  readonly handler: Handler<HostListenerEnv>;
}

/** The mounted browser read surface: exactly the five fixed GET routes. */
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
};

function errorResponse(code: BrowserApiErrorV1['error']['code'], message: string): Response {
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
      { path: BROWSER_PROJECT_GRAPHS_PATH, handler: graphsHandler(api) },
      { path: BROWSER_PROJECT_SOURCE_PATH, handler: sourceStudioHandler(api) },
      ...(options.references === undefined
        ? []
        : [{ path: BROWSER_PROJECT_REFERENCES_PATH, handler: referencesHandler(api) }]),
    ],
  };
}

/**
 * Browser-safe versioned read API contract. These DTOs are the only payloads
 * the Host browser read surface (`../host/browser-read-api.ts`) returns, and
 * the only read types client code may consume (re-exported through
 * `./index.ts`). The boundary rules are absolute: a principal never carries a
 * session id or cookie; a project summary/overview never carries a root label
 * or any filesystem path; no Git, SQLite, credential, capability token, Yjs
 * byte, or operation output path ever crosses this boundary. UI preferences
 * stay browser-local and are deliberately absent here.
 */

import type { ProjectSessionProjectionV1 } from '@novalistically/workbench-protocol';
import type { UserRole } from './persistence.js';
export type { ProjectAccessRole } from './configuration.js';


/** Version of the browser read API contract carried by every response DTO. */
export const BROWSER_API_VERSION = 1 as const;
export type BrowserApiVersion = typeof BROWSER_API_VERSION;

/**
 * Request header carrying the server-issued session identity for browser
 * reads. The Host resolves the principal from this header server-side; the
 * value itself (a session id) is never reflected in any response DTO.
 * Mirrors the MCP transport's session header so browser and MCP surfaces
 * share one identity carrier.
 */
import type { WorkbenchRouteSelectorV1 } from './graph.js';
export const BROWSER_SESSION_HEADER = 'x-fabula-session';

/** Base path of the versioned browser read surface. */
export const BROWSER_API_BASE_PATH = '/api/v1';

/** `GET /api/v1/session` — safe current-session principal. */
export const BROWSER_SESSION_PATH = `${BROWSER_API_BASE_PATH}/session`;
/** `GET /api/v1/projects` — server-scoped project catalog. */
export const BROWSER_PROJECTS_PATH = `${BROWSER_API_BASE_PATH}/projects`;
/** `GET /api/v1/projects/:projectId/overview` — project overview. */
export const BROWSER_PROJECT_OVERVIEW_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/overview`;
/** `GET /api/v1/projects/:projectId/graphs` — canonical graph for one route. */
export const BROWSER_PROJECT_GRAPHS_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/graphs`;

/** Query parameter carrying the strict route selector on the graphs endpoint. */
export const BROWSER_GRAPH_ROUTE_QUERY = 'route';

/**
 * Safe current-session principal. Identity + role + display fields only:
 * never the session id/cookie, never a credential or capability token, never
 * any Host/filesystem material.
 */
export interface BrowserSessionPrincipalV1 {
  readonly version: BrowserApiVersion;
  readonly userId: string;
  readonly role: UserRole;
  readonly displayName: string;
  /** Monotonic capability version the user's grants were issued under. */
  readonly capabilityVersion: number;
  /** Session expiry timestamp; present so the client can show stale-auth state. */
  readonly expiresAt: string;
}

/**
 * One server-scoped project catalog entry. `rootLabel` and every filesystem
 * path are Host-internal and deliberately absent; `open` reports whether a
 * ProjectSession is currently open for the project (host state, not a path).
 */
export interface BrowserProjectSummaryV1 {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly open: boolean;
}

/** Versioned project catalog envelope. */
export interface BrowserProjectListV1 {
  readonly version: BrowserApiVersion;
  readonly projects: readonly BrowserProjectSummaryV1[];
}

/**
 * Safe status/activity state of one project: host-only surfaces that are
 * absent from {@link ProjectSessionProjectionV1}. No operation output path,
 * checkpoint, journal, or queue detail is ever included.
 */
export interface BrowserProjectActivityV1 {
  /** True while the project session has operations queued or in flight. */
  readonly busy: boolean;
  /** True while any human presence (browser, mcp, or yjs surface) is attached. */
  readonly hasHumanPresence: boolean;
}

/**
 * One project overview: display metadata plus the accepted session projection
 * and safe activity state. `projection` is null when no ProjectSession is
 * open for the project yet (the client models that honestly as "no accepted
 * source" rather than inventing one). Never carries rootLabel/path, Git,
 * SQLite, credentials, capability tokens, Yjs bytes, or output paths.
 */
export interface BrowserProjectOverviewV1 {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  readonly metadata: {
    readonly displayName: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  /** Accepted last-valid session projection, or null when the project is not open. */
  readonly projection: ProjectSessionProjectionV1 | null;
  readonly activity: BrowserProjectActivityV1;
  readonly generatedAt: string;
}
/**
 * Strict documented route selector for `GET /api/v1/projects/:projectId/graphs`.
 * Single source of truth: the graph contract's {@link WorkbenchRouteSelectorV1},
 * aliased here as the browser API's wire selector.
 *
 * The endpoint accepts exactly ONE query parameter, `route`, carrying a
 * URL-encoded JSON document of precisely that shape. Everything else is
 * rejected with 400 `INVALID_ROUTE_SELECTOR` before any graph work happens:
 * unknown keys, wrong types, missing `branchPath`, malformed decisions,
 * non-integer `narrativeOrder`, and non-string ids. The endpoint never
 * compiles or parses client bytes — the selector is pure route identity, and
 * the graph itself is produced by the injected host projector.
 */
export type BrowserGraphRouteSelectorV1 = WorkbenchRouteSelectorV1;

/** Typed browser read API error codes, grouped by HTTP status class. */
export type BrowserApiErrorCode =
  /** 401 — the presented session is missing, revoked, or unknown. */
  | 'SESSION_NOT_FOUND'
  /** 401 — the presented session exists but has expired. */
  | 'SESSION_EXPIRED'
  /** 403 — the session is valid but the user cannot access this project. */
  | 'PROJECT_MISMATCH'
  /** 404 — the project is not in the caller's server-scoped catalog. */
  | 'PROJECT_NOT_FOUND'
  /** 400 — the `route` selector is missing or violates the documented shape. */
  | 'INVALID_ROUTE_SELECTOR'
  /** 503 — the injected graph projector could not produce the requested route. */
  | 'GRAPH_UNAVAILABLE'
  /** 503 — the injected Source Studio source could not produce project state. */
  | 'SOURCE_UNAVAILABLE';
/** Secret-free error envelope for every non-2xx browser read response. */
export interface BrowserApiErrorV1 {
  readonly error: {
    readonly code: BrowserApiErrorCode;
    readonly message: string;
  };
}

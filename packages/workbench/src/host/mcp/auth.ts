/**
 * Host-only MCP authentication boundary.
 *
 * Every external MCP request must derive its identity from server-side
 * sources and nothing else. Two mutually exclusive modes:
 *
 *   1. Browser mode — a live, nonexpired Host session (`x-fabula-session`),
 *      looked up through an injected session store, plus an opaque capability
 *      token (`Authorization: Bearer`), validated by the shared
 *      AgentCapabilityService at the exact project and requested scopes. The
 *      grant bound to the token must name the same user as the live session;
 *      any mismatch is a typed `USER_MISMATCH` denial.
 *   2. Device mode — an owner-paired one-time device credential (no session
 *      header at all), verified against the durable hash-only verifier store
 *      through the injected device pairing service. Device identity is
 *      separate from browser sessions; the actor is the issuing owner,
 *      resolved server-side, and the credential's persisted scope set is the
 *      grant.
 *
 * On success the port returns only safe server-derived caller fields
 * (sessionId or device identity, userId, and the secret-free grant
 * projection) — never the token, its digest, or any caller-chosen
 * actor/project/scope. Failure codes are typed and nonsecret; the HTTP status
 * mapping (401 vs 403) is exposed for the transport via
 * {@link mcpAuthFailureStatus}.
 */
import {
  MCP_ADMIN_SCOPE,
  PROJECT_ACCESS_ROLE_GRANTS,
  PROJECT_ACCESS_ROLES,
} from '../../contracts/configuration.js';
import type { AuthUserRecord, CapabilityState } from '../../contracts/persistence.js';
import type {
  AgentCapabilityFailureCode,
  AgentCapabilityGrant,
  AgentCapabilityService,
} from '../agent/index.js';
import type { LocalAuthService } from '../auth/index.js';
import type {
  ProjectAccessPrincipalRole,
  ProjectAccessRole,
  ProjectAccessService,
} from '../project-access-service.js';
import type { McpDevicePairingService } from './device-pairing.js';

/** Server-derived identity for one authorized MCP request. No token, no digest. */
export interface McpAuthorizedCaller {
  /** The live session id that authenticated this request; null for device callers. */
  readonly sessionId: string | null;
  /** The session user (or the issuing owner for devices); equals `grant.userId` by construction. */
  readonly userId: string;
  /** Server-derived project ACL role. */
  readonly role?: ProjectAccessPrincipalRole;
  /** Server-derived project grant; never taken from request input. */
  readonly projectGrant?: { readonly projectId: string; readonly role: ProjectAccessPrincipalRole };
  /** The validated grant: actor/project/scopes/version/expiry truth. */
  readonly grant: AgentCapabilityGrant;
  /** Present for device-credential callers; browser callers carry no device identity. */
  readonly device?: { readonly deviceId: string };
}

/**
 * Typed, nonsecret MCP authentication denials. Codes split into two status
 * classes: the presented credentials are missing/invalid/revoked/expired
 * (401), or the credentials are valid but do not authorize this user/project/
 * scope (403).
 */
export type McpAuthFailureCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'TOKEN_INVALID'
  | 'TOKEN_REVOKED'
  | 'TOKEN_EXPIRED'
  | 'USER_MISMATCH'
  | 'PROJECT_MISMATCH'
  | 'SCOPE_MISMATCH'
  | 'INSUFFICIENT_ROLE'
  | 'ADMIN_ROUTE_REQUIRED';

export interface McpAuthFailure {
  readonly code: McpAuthFailureCode;
  /** Human-readable, secret-free explanation; safe for client display. */
  readonly message: string;
}

export type McpRouteKind = 'project' | 'admin';

export interface McpAuthorizeInput {
  /** Session id from the `x-fabula-session` header; null for device credentials. */
  readonly sessionId: string | null;
  /** Opaque capability token or owner-paired device credential. */
  readonly token: string;
  /** Exact project the request targets; never caller-chosen beyond the route. */
  readonly projectId: string;
  /** Server-mounted MCP route; never inferred from the project id. */
  readonly route: McpRouteKind;
  /** Exact scopes this request needs; every one must be covered by the grant. */
  readonly scopes: readonly string[];
}

export type McpAuthorizationResult =
  | { readonly ok: true; readonly caller: McpAuthorizedCaller }
  | { readonly ok: false; readonly failure: McpAuthFailure };

/** Session + capability validation the transport consumes; never rebuilt per request. */
export interface McpAuthorizationPort {
  authorize(input: McpAuthorizeInput): Promise<McpAuthorizationResult>;
}

export interface McpAuthorizationPortOptions {
  /**
   * Session lookup for browser mode; a missing row means the session never
   * existed or was revoked (revocation deletes the row), and an expired row
   * is rejected here. Mirrors the Yjs `SessionAuthPortOptions` contract.
   */
  readonly sessions: Pick<LocalAuthService, 'getSession'>;
  /**
   * Shared AgentCapabilityService: validates the opaque token at
   * project/scopes for browser mode, and persists the server-derived device
   * grant row for device mode.
   */
  readonly capabilities: Pick<AgentCapabilityService, 'validate' | 'persistGrant'>;
  /** Shared project ACL/lifecycle gate, checked before capability/resource use. */
  readonly access?: Pick<ProjectAccessService, 'authorize'>;
  /** Durable device-credential verification for device mode (owner-paired). */
  readonly devices?: Pick<McpDevicePairingService, 'verifyCredential'>;
  /** Server-scoped owner resolution for device mode; the actor is never caller-chosen. */
  readonly owner?: { readonly loadOwner: () => Promise<AuthUserRecord | null> };
  /** Timestamp source for session expiry checks; defaults to the host clock. */
  readonly now?: () => string;
}

const FAILURE_MESSAGES: Record<McpAuthFailureCode, string> = {
  SESSION_NOT_FOUND: 'The session is missing, revoked, or unknown.',
  SESSION_EXPIRED: 'The session has expired.',
  TOKEN_INVALID: 'The presented capability token is not recognized.',
  TOKEN_REVOKED: 'The capability token has been revoked.',
  TOKEN_EXPIRED: 'The capability token has expired.',
  USER_MISMATCH: 'The capability token does not belong to the authenticated session user.',
  PROJECT_MISMATCH: 'The capability token is not granted for this project.',
  SCOPE_MISMATCH: 'The capability token does not cover the requested scopes.',
  INSUFFICIENT_ROLE: 'The caller does not have the project role required for the requested scopes.',
  ADMIN_ROUTE_REQUIRED: 'The device credential is restricted to the admin route.',
};

/**
 * Server-side failure to persist the device-mode capability grant. The
 * presented credential itself verified; the request fails so the caller
 * retries instead of receiving a confusing NOT_FOUND denial when the session
 * gate re-loads the durable row for the enqueued operation.
 */
export class DeviceGrantPersistenceError extends Error {
  override readonly name = 'DeviceGrantPersistenceError';
  readonly code = 'DEVICE_GRANT_PERSIST_FAILED';

  constructor(cause: unknown) {
    super('The device capability grant could not be persisted; retry the request.', { cause });
  }
}

/**
 * HTTP status for each typed denial. 401: the presented credentials are
 * missing/invalid/expired/revoked. 403: credentials are valid but the caller
 * is not authorized for this user/project/scope.
 */
export const MCP_AUTH_FAILURE_STATUS: Readonly<Record<McpAuthFailureCode, 401 | 403>> = {
  SESSION_NOT_FOUND: 401,
  SESSION_EXPIRED: 401,
  TOKEN_INVALID: 401,
  TOKEN_REVOKED: 401,
  TOKEN_EXPIRED: 401,
  USER_MISMATCH: 403,
  PROJECT_MISMATCH: 403,
  SCOPE_MISMATCH: 403,
  INSUFFICIENT_ROLE: 403,
  ADMIN_ROUTE_REQUIRED: 403,
};

export function mcpAuthFailureStatus(code: McpAuthFailureCode): 401 | 403 {
  return MCP_AUTH_FAILURE_STATUS[code];
}

function failure(code: McpAuthFailureCode): McpAuthFailure {
  return { code, message: FAILURE_MESSAGES[code] };
}

/** Map a capability-service failure onto the transport-facing MCP denial class. */
function mapCapabilityFailure(code: AgentCapabilityFailureCode): McpAuthFailureCode {
  switch (code) {
    case 'INVALID_TOKEN':
    case 'NOT_FOUND':
    case 'VERSION_MISMATCH':
      return 'TOKEN_INVALID';
    case 'REVOKED':
      return 'TOKEN_REVOKED';
    case 'EXPIRED':
      return 'TOKEN_EXPIRED';
    case 'PROJECT_MISMATCH':
      return 'PROJECT_MISMATCH';
    case 'SCOPE_MISMATCH':
      return 'SCOPE_MISMATCH';
  }
}

/**
 * Inverse of {@link PROJECT_ACCESS_ROLE_GRANTS}: every grantable project
 * scope → the least project role that grants it. Derived from the single
 * grants constant so role rules never diverge; `mcp:admin` is owner-only and
 * handled separately by the route check.
 */
const MCP_SCOPE_REQUIRED_ROLE: Readonly<Record<string, ProjectAccessRole>> = (() => {
  const inverse: Record<string, ProjectAccessRole> = {};
  for (const role of PROJECT_ACCESS_ROLES) {
    for (const scope of PROJECT_ACCESS_ROLE_GRANTS[role].scopes) {
      const current = inverse[scope];
      if (
        current === undefined ||
        PROJECT_ACCESS_ROLE_GRANTS[role].rank < PROJECT_ACCESS_ROLE_GRANTS[current].rank
      ) {
        inverse[scope] = role;
      }
    }
  }
  return inverse;
})();

/** Resolve the highest project role represented by every requested scope. */
function requiredProjectRole(
  route: McpRouteKind,
  scopes: readonly string[],
): ProjectAccessRole | 'admin' | null {
  if (route === 'admin') {
    return scopes.length === 1 && scopes[0] === MCP_ADMIN_SCOPE ? 'admin' : null;
  }
  let required: ProjectAccessRole = 'reader';
  for (const scope of scopes) {
    if (scope === MCP_ADMIN_SCOPE) return 'admin';
    const scopeRole = MCP_SCOPE_REQUIRED_ROLE[scope];
    if (scopeRole === undefined) return null;
    if (PROJECT_ACCESS_ROLE_GRANTS[scopeRole].rank > PROJECT_ACCESS_ROLE_GRANTS[required].rank) {
      required = scopeRole;
    }
  }
  return required;
}

async function projectGrant(
  access: Pick<ProjectAccessService, 'authorize'> | undefined,
  userId: string,
  projectId: string,
  requiredRole: ProjectAccessRole,
  principalRole?: ProjectAccessPrincipalRole,
): Promise<{ readonly projectId: string; readonly role: ProjectAccessPrincipalRole } | null> {
  if (access === undefined) return null;
  const result = await access.authorize({
    userId,
    projectId,
    requiredRole,
    principalRole,
  });
  return result.ok ? { projectId, role: result.grant.role } : null;
}

/**
 * Default MCP authorization port over the Host session store, the shared
 * AgentCapabilityService, and the durable device verifier. Browser mode
 * requires a live session plus a matching capability token; device mode
 * verifies an owner-paired credential against the durable hash-only store and
 * derives the actor from the issuing owner. Fails closed on malformed input
 * (missing session, empty token, empty scopes) and on any mismatch.
 */
export function createMcpAuthorizationPort(
  options: McpAuthorizationPortOptions,
): McpAuthorizationPort {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async authorize(input: McpAuthorizeInput): Promise<McpAuthorizationResult> {
      const { sessionId, token, projectId, route, scopes } = input;
      if (typeof token !== 'string' || token.length === 0) {
        return { ok: false, failure: failure('TOKEN_INVALID') };
      }
      if (
        (route !== 'project' && route !== 'admin') ||
        typeof projectId !== 'string' ||
        projectId.length === 0
      ) {
        return { ok: false, failure: failure('PROJECT_MISMATCH') };
      }
      if (!Array.isArray(scopes) || scopes.length === 0) {
        return { ok: false, failure: failure('SCOPE_MISMATCH') };
      }
      const requiredRole = requiredProjectRole(route, scopes);
      if (requiredRole === null) {
        return { ok: false, failure: failure('SCOPE_MISMATCH') };
      }
      if (requiredRole === 'admin' && sessionId !== null) {
        return { ok: false, failure: failure('ADMIN_ROUTE_REQUIRED') };
      }
      const projectRequiredRole = requiredRole === 'admin' ? 'reader' : requiredRole;

      if (sessionId === null) {
        // Device mode: the credential is its own grant; no browser session.
        if (options.devices === undefined || options.owner === undefined) {
          return { ok: false, failure: failure('TOKEN_INVALID') };
        }
        const verified = await options.devices.verifyCredential({
          credential: token,
          scopes,
          ...(route === 'project' ? { projectId } : {}),
          route,
        });
        if (!verified.ok) return { ok: false, failure: failure(verified.code) };
        const owner = await options.owner.loadOwner();
        if (owner === null) return { ok: false, failure: failure('TOKEN_INVALID') };
        if (verified.device.ownerUserId !== owner.userId) {
          return { ok: false, failure: failure('TOKEN_INVALID') };
        }
        const deviceProjectGrant = await projectGrant(
          options.access,
          owner.userId,
          projectId,
          projectRequiredRole,
          'owner',
        );
        if (deviceProjectGrant === null)
          return { ok: false, failure: failure('INSUFFICIENT_ROLE') };

        // The device credential is authoritative: mirror it into the durable
        // capability store so the session's per-effect gate (`checkGrant`,
        // which re-loads the row) accepts the device caller instead of
        // denying with NOT_FOUND. The upsert is idempotent — a re-pair or
        // scope/expiry change overwrites the previous row. A failed persist
        // is a server-side storage failure, not a credential failure: throw a
        // typed error so the caller retries rather than later receiving a
        // confusing NOT_FOUND denial from the session gate.
        const deviceGrant: CapabilityState = {
          capabilityId: `device:${verified.device.deviceId}`,
          userId: owner.userId,
          projectId,
          scope: [...verified.device.scopes],
          version: 1,
          expiresAt: verified.device.expiresAt,
        };
        try {
          await options.capabilities.persistGrant(deviceGrant);
        } catch (cause) {
          throw new DeviceGrantPersistenceError(cause);
        }

        return {
          ok: true,
          caller: {
            sessionId: null,
            userId: owner.userId,
            role: deviceProjectGrant.role,
            projectGrant: deviceProjectGrant,
            grant: {
              capabilityId: `device:${verified.device.deviceId}`,
              userId: owner.userId,
              projectId,
              scopes: verified.device.scopes,
              version: 1,
              expiresAt: verified.device.expiresAt,
            },
            device: {
              deviceId: verified.device.deviceId,
            },
          },
        };
      }

      if (sessionId.length === 0) {
        return { ok: false, failure: failure('SESSION_NOT_FOUND') };
      }
      const session = await options.sessions.getSession(sessionId);
      if (session === null) return { ok: false, failure: failure('SESSION_NOT_FOUND') };
      if (session.expiresAt <= now()) return { ok: false, failure: failure('SESSION_EXPIRED') };
      const sessionProjectGrant = await projectGrant(
        options.access,
        session.userId,
        projectId,
        projectRequiredRole,
      );
      if (sessionProjectGrant === null) return { ok: false, failure: failure('INSUFFICIENT_ROLE') };

      const validation = await options.capabilities.validate({ token, projectId, scopes });
      if (!validation.ok) {
        return { ok: false, failure: failure(mapCapabilityFailure(validation.failure.code)) };
      }
      if (validation.grant.userId !== session.userId) {
        return { ok: false, failure: failure('USER_MISMATCH') };
      }

      return {
        ok: true,
        caller: {
          sessionId: session.sessionId,
          userId: session.userId,
          role: sessionProjectGrant.role,
          projectGrant: sessionProjectGrant,
          grant: validation.grant,
        },
      };
    },
  };
}

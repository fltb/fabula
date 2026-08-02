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
import type {
  AgentCapabilityFailureCode,
  AgentCapabilityGrant,
  AgentCapabilityService,
} from '../agent/index.js';
import type { LocalAuthService } from '../auth/index.js';
import type { AuthUserRecord } from '../../contracts/persistence.js';
import type { McpDevicePairingService } from './device-pairing.js';

/** Server-derived identity for one authorized MCP request. No token, no digest. */
export interface McpAuthorizedCaller {
  /** The live session id that authenticated this request; null for device callers. */
  readonly sessionId: string | null;
  /** The session user (or the issuing owner for devices); equals `grant.userId` by construction. */
  readonly userId: string;
  /** The validated grant: actor/project/scopes/version/expiry truth. */
  readonly grant: AgentCapabilityGrant;
  /** Present for device-credential callers; browser callers carry no device identity. */
  readonly device?: { readonly deviceId: string; readonly clientLabel: string };
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
  | 'SCOPE_MISMATCH';

export interface McpAuthFailure {
  readonly code: McpAuthFailureCode;
  /** Human-readable, secret-free explanation; safe for client display. */
  readonly message: string;
}

export interface McpAuthorizeInput {
  /** Session id from the `x-fabula-session` header; null for device credentials. */
  readonly sessionId: string | null;
  /** Opaque capability token or owner-paired device credential. */
  readonly token: string;
  /** Exact project the request targets; never caller-chosen beyond the route. */
  readonly projectId: string;
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
  /** Shared AgentCapabilityService; validates the opaque token at project/scopes. */
  readonly capabilities: Pick<AgentCapabilityService, 'validate'>;
  /** Durable device-credential verification for device mode (owner-paired). */
  readonly devices?: Pick<McpDevicePairingService, 'verifyCredential'>;
  /** Server-side owner resolution for device mode; the actor is never caller-chosen. */
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
};

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
      const { sessionId, token, projectId, scopes } = input;
      if (typeof token !== 'string' || token.length === 0) {
        return { ok: false, failure: failure('TOKEN_INVALID') };
      }
      if (typeof projectId !== 'string' || projectId.length === 0) {
        return { ok: false, failure: failure('PROJECT_MISMATCH') };
      }
      if (!Array.isArray(scopes) || scopes.length === 0) {
        return { ok: false, failure: failure('SCOPE_MISMATCH') };
      }

      if (sessionId === null) {
        // Device mode: the credential is its own grant; no browser session.
        if (options.devices === undefined || options.owner === undefined) {
          return { ok: false, failure: failure('TOKEN_INVALID') };
        }
        const verified = await options.devices.verifyCredential({ credential: token, scopes });
        if (!verified.ok) return { ok: false, failure: failure(verified.code) };
        const owner = await options.owner.loadOwner();
        if (owner === null) return { ok: false, failure: failure('TOKEN_INVALID') };
        return {
          ok: true,
          caller: {
            sessionId: null,
            userId: owner.userId,
            grant: {
              capabilityId: `device:${verified.device.deviceId}`,
              userId: owner.userId,
              projectId,
              scopes: verified.device.scope,
              version: 1,
              expiresAt: verified.device.expiresAt,
            },
            device: {
              deviceId: verified.device.deviceId,
              clientLabel: verified.device.clientLabel,
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
          grant: validation.grant,
        },
      };
    },
  };
}

/**
 * Host-only Agent capability boundary: server-side issuance, validation,
 * revocation, and audit-effect construction for opaque capability tokens.
 *
 * Capabilities are opaque, versioned, revocable server-side grants:
 * - Issue generates a fresh 256-bit token and persists ONLY the grant metadata
 *   (`CapabilityState`) plus an in-process SHA-256 digest of the token. The raw
 *   token never reaches persistence, audit records, or the browser.
 * - Validate takes a client-presented token plus the project/scopes an effect
 *   needs and re-loads the persisted grant on every call. Each validate checks
 *   the server-held token digest, then the persisted row's existence, version,
 *   revocation, expiry, project, and scope.
 * - Callers can never choose the actor or the granted permissions: issue,
 *   validate, and checkGrant reject unknown input fields (e.g. `actorId`,
 *   `permissions`) outright, and the persisted row is the only source of
 *   actor/scope truth.
 * - The token digest registry is deliberately process-held: a Host restart
 *   invalidates every outstanding token (fail closed) because the durable
 *   capabilities row has no digest column and this layer owns no SQL. Durable
 *   grant metadata still round-trips through the existing typed capability
 *   persistence operations (`upsertCapability`/`loadCapability`/
 *   `revokeCapability`); this module never touches the persistence worker
 *   internals directly.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { CapabilityState } from '../../contracts/persistence.js';
import type { PersistenceWorkerClient } from '../../persistence/worker-client.js';

/** How many random bytes make up the opaque token secret (256 bits). */
export const CAPABILITY_TOKEN_BYTES = 32;
/** Fixed human-recognizable prefix; the remainder is pure randomness, no claims. */
export const CAPABILITY_TOKEN_PREFIX = 'fc_';
export const DEFAULT_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;

/** Persistent-grant domain operations this service is allowed to use. */
export interface CapabilityPersistence {
  upsertCapability(state: CapabilityState): Promise<CapabilityState>;
  loadCapability(input: { capabilityId: string }): Promise<CapabilityState | null>;
  revokeCapability(input: { capabilityId: string; reason?: string }): Promise<{ revoked: true }>;
}

/** Typed domain adapter over the persistence worker; keeps SQL out of this layer. */
export function createCapabilityPersistence(
  client: PersistenceWorkerClient,
): CapabilityPersistence {
  return {
    upsertCapability: (state) => client.request('upsertCapability', state),
    loadCapability: (input) => client.request('loadCapability', input),
    revokeCapability: (input) => client.request('revokeCapability', input),
  };
}

/** Safe grant projection returned to callers; never carries the token or its digest. */
export interface AgentCapabilityGrant {
  capabilityId: string;
  /** Server-assigned actor; callers can never supply this. */
  userId: string;
  projectId: string;
  scopes: readonly string[];
  version: number;
  expiresAt: string;
}

export type AgentCapabilityFailureCode =
  | 'INVALID_TOKEN'
  | 'NOT_FOUND'
  | 'VERSION_MISMATCH'
  | 'REVOKED'
  | 'EXPIRED'
  | 'PROJECT_MISMATCH'
  | 'SCOPE_MISMATCH';

export interface AgentCapabilityFailure {
  code: AgentCapabilityFailureCode;
  message: string;
}

export type AgentCapabilityValidationResult =
  | { ok: true; grant: AgentCapabilityGrant }
  | { ok: false; failure: AgentCapabilityFailure };

/** Server-side per-effect gate verdict; the `grant` doubles as actor/scope/version truth. */
export type AgentCapabilityCheckResult =
  | { allowed: true; grant: AgentCapabilityGrant }
  | { allowed: false; reason: AgentCapabilityFailureCode };

/** Typed audit metadata for one effect. Secret-free by construction: no token, no digest. */
export interface AgentAuditEffect {
  capabilityId: string;
  actorId: string;
  projectId: string;
  scopes: readonly string[];
  version: number;
  kind: string;
  detail?: string;
  at: string;
}

export interface IssueCapabilityInput {
  /** Server-resolved actor binding; the Host passes the authenticated user's id, never a client payload. */
  userId: string;
  projectId: string;
  scopes: readonly string[];
  ttlMs?: number;
}

export interface ValidateCapabilityInput {
  token: string;
  projectId: string;
  scopes: readonly string[];
}

export interface CheckCapabilityInput {
  capabilityId: string;
  projectId: string;
  scopes: readonly string[];
  /** Optional binding: when given, a persisted version different from this fails the gate. */
  expectedVersion?: number;
}

export interface AuditEffectInput {
  /** Must come from a successful `validate`/`checkGrant`; the projection has no token to leak. */
  grant: AgentCapabilityGrant;
  kind: string;
  detail?: string;
  at: string;
}

export interface AgentCapabilityServiceOptions {
  persistence: CapabilityPersistence;
  now?: () => number;
  newId?: () => string;
  ttlMs?: number;
}

/** Malformed caller input (unknown fields, empty scopes, bad ttl); no side effects were produced. */
export class CapabilityInputError extends Error {
  override readonly name = 'CapabilityInputError';
}

const ISSUE_FIELDS = ['userId', 'projectId', 'scopes', 'ttlMs'] as const;
const VALIDATE_FIELDS = ['token', 'projectId', 'scopes'] as const;
const CHECK_FIELDS = ['capabilityId', 'projectId', 'scopes', 'expectedVersion'] as const;

const FAILURE_MESSAGES: Record<AgentCapabilityFailureCode, string> = {
  INVALID_TOKEN: 'The presented capability token is not recognized.',
  NOT_FOUND: 'The capability record no longer exists.',
  VERSION_MISMATCH: 'The capability version no longer matches the issued grant.',
  REVOKED: 'The capability has been revoked.',
  EXPIRED: 'The capability has expired.',
  PROJECT_MISMATCH: 'The capability is not granted for this project.',
  SCOPE_MISMATCH: 'The capability does not cover the requested scopes.',
};

function failure(code: AgentCapabilityFailureCode): AgentCapabilityFailure {
  return { code, message: FAILURE_MESSAGES[code] };
}

/** Builds typed audit metadata for one effect. Requires a validated grant. Deterministic. */
export function buildAuditEffect(input: AuditEffectInput): AgentAuditEffect {
  const { grant, kind, detail, at } = input;
  return {
    capabilityId: grant.capabilityId,
    actorId: grant.userId,
    projectId: grant.projectId,
    scopes: grant.scopes,
    version: grant.version,
    kind,
    ...(detail != null ? { detail } : {}),
    at,
  };
}

/**
 * Issuance, validation, revocation, and per-effect gating for opaque Agent
 * capability tokens over typed capability persistence operations. Construct
 * once per Host process: this service holds the in-process token digest
 * registry and must be shared, never rebuilt per request.
 */
export class AgentCapabilityService {
  readonly #persistence: CapabilityPersistence;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #ttlMs: number;
  /** Server-held token digests (sha256 hex of the opaque token) -> issued grant binding. */
  readonly #digests = new Map<string, { capabilityId: string; version: number }>();

  constructor(options: AgentCapabilityServiceOptions) {
    this.#persistence = options.persistence;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? randomUUID;
    this.#ttlMs = options.ttlMs ?? DEFAULT_CAPABILITY_TTL_MS;
  }

  /**
   * Issues a new opaque capability. The actor (`userId`) is a server-side
   * binding and the granted scopes are fixed at issuance; any client-supplied
   * actor/permission field is rejected before any side effect.
   */
  async issue(
    input: IssueCapabilityInput,
  ): Promise<{ token: string; grant: AgentCapabilityGrant }> {
    this.#rejectUnknownKeys(input, ISSUE_FIELDS, 'issue');
    if (input.userId.length === 0 || input.projectId.length === 0) {
      throw new CapabilityInputError('userId and projectId must be non-empty.');
    }
    if (input.scopes.length === 0) {
      throw new CapabilityInputError('A capability must grant at least one scope.');
    }
    const ttlMs = input.ttlMs ?? this.#ttlMs;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new CapabilityInputError('ttlMs must be a positive number of milliseconds.');
    }
    const token =
      CAPABILITY_TOKEN_PREFIX + randomBytes(CAPABILITY_TOKEN_BYTES).toString('base64url');
    const at = this.#now();
    const state: CapabilityState = {
      capabilityId: this.#newId(),
      userId: input.userId,
      projectId: input.projectId,
      scope: [...new Set(input.scopes)],
      version: 1,
      expiresAt: new Date(at + ttlMs).toISOString(),
    };
    await this.#persistence.upsertCapability(state);
    this.#digests.set(createHash('sha256').update(token, 'utf8').digest('hex'), {
      capabilityId: state.capabilityId,
      version: state.version,
    });
    return { token, grant: this.#project(state) };
  }

  /**
   * Validates a client-presented token against the server-held digest and the
   * current persisted grant (existence, version, revocation, expiry, project,
   * scope). Called before every effect that consumes a client token.
   */
  async validate(input: ValidateCapabilityInput): Promise<AgentCapabilityValidationResult> {
    this.#rejectUnknownKeys(input, VALIDATE_FIELDS, 'validate');
    if (typeof input.token !== 'string' || input.token.length === 0) {
      throw new CapabilityInputError('A non-empty token is required.');
    }
    if (input.scopes.length === 0) {
      throw new CapabilityInputError('At least one requested scope is required.');
    }
    const entry = this.#digests.get(createHash('sha256').update(input.token, 'utf8').digest('hex'));
    if (!entry) return { ok: false, failure: failure('INVALID_TOKEN') };
    const state = await this.#persistence.loadCapability({ capabilityId: entry.capabilityId });
    if (state == null) return { ok: false, failure: failure('NOT_FOUND') };
    if (state.version !== entry.version) return { ok: false, failure: failure('VERSION_MISMATCH') };
    if (state.revokedAt != null) return { ok: false, failure: failure('REVOKED') };
    if (new Date(state.expiresAt).getTime() <= this.#now())
      return { ok: false, failure: failure('EXPIRED') };
    if (state.projectId !== input.projectId)
      return { ok: false, failure: failure('PROJECT_MISMATCH') };
    if (input.scopes.some((scope) => !state.scope.includes(scope))) {
      return { ok: false, failure: failure('SCOPE_MISMATCH') };
    }
    return { ok: true, grant: this.#project(state) };
  }

  /**
   * Server-side per-effect gate for capabilities that were already validated
   * (e.g. the built-in Agent Composer, which never holds a token). Re-loads the
   * persisted grant on every effect so a revocation, version bump, or expiry
   * stops the next effect at the next safe checkpoint.
   */
  async checkGrant(input: CheckCapabilityInput): Promise<AgentCapabilityCheckResult> {
    this.#rejectUnknownKeys(input, CHECK_FIELDS, 'checkGrant');
    if (input.capabilityId.length === 0 || input.projectId.length === 0) {
      throw new CapabilityInputError('capabilityId and projectId must be non-empty.');
    }
    if (input.scopes.length === 0) {
      throw new CapabilityInputError('At least one requested scope is required.');
    }
    const state = await this.#persistence.loadCapability({ capabilityId: input.capabilityId });
    if (state == null) return { allowed: false, reason: 'NOT_FOUND' };
    if (input.expectedVersion != null && state.version !== input.expectedVersion) {
      return { allowed: false, reason: 'VERSION_MISMATCH' };
    }
    if (state.revokedAt != null) return { allowed: false, reason: 'REVOKED' };
    if (new Date(state.expiresAt).getTime() <= this.#now())
      return { allowed: false, reason: 'EXPIRED' };
    if (state.projectId !== input.projectId) return { allowed: false, reason: 'PROJECT_MISMATCH' };
    if (input.scopes.some((scope) => !state.scope.includes(scope)))
      return { allowed: false, reason: 'SCOPE_MISMATCH' };
    return { allowed: true, grant: this.#project(state) };
  }

  /** Durable revocation. The digest entry is kept so later validates report REVOKED from persisted state. */
  async revoke(capabilityId: string, reason?: string): Promise<void> {
    await this.#persistence.revokeCapability({ capabilityId, reason });
  }

  /** Maps a persisted grant row to the safe client projection (no token, no digest, no internals). */
  #project(state: CapabilityState): AgentCapabilityGrant {
    return {
      capabilityId: state.capabilityId,
      userId: state.userId,
      projectId: state.projectId,
      scopes: state.scope,
      version: state.version,
      expiresAt: state.expiresAt,
    };
  }

  /** Fail-closed input guard: actor and permissions are assigned server-side, never accepted from callers. */
  #rejectUnknownKeys(input: object, allowed: readonly string[], method: string): void {
    for (const key of Object.keys(input)) {
      if (!allowed.includes(key)) {
        throw new CapabilityInputError(
          `Unknown field "${key}" passed to ${method}; actor and permissions are assigned by the server.`,
        );
      }
    }
  }
}

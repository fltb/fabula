/**
 * Host-only Agent capability boundary: server-side issuance, validation,
 * revocation, and audit-effect construction for opaque capability tokens.
 *
 * Capabilities are opaque, versioned, revocable server-side grants:
 * - Issue generates a fresh 256-bit token and persists the grant metadata
 *   (`CapabilityState`) plus a durable, hash-only verifier row (the SHA-256
 *   digest of the token, keyed `capability:<capabilityId>:v<version>` in the
 *   capability verifier store). The raw token never reaches persistence,
 *   audit records, or the browser, and the digest is never returned by any
 *   result.
 * - Validate takes a client-presented token plus the project/scopes an effect
 *   needs, resolves the token's digest through the durable verifier store,
 *   and re-loads the persisted grant on every call. Each validate checks the
 *   verifier row's existence, then the persisted row's version, revocation,
 *   expiry, project, and scope. Because the digest registry is durable, a
 *   Host restart keeps outstanding tokens valid — the verifier row carries
 *   only the hash, never the token.
 * - Callers can never choose the actor or the granted permissions: issue,
 *   validate, and checkGrant reject unknown input fields (e.g. `actorId`,
 *   `permissions`) outright, and the persisted row is the only source of
 *   actor/scope truth.
 * - Grant metadata and digests round-trip exclusively through the typed
 *   capability and device-verifier persistence operations
 *   (`upsertCapability`/`loadCapability`/`revokeCapability` and
 *   `createDeviceVerifier`/`loadDeviceVerifierByTokenHash`/`revokeDeviceVerifier`);
 *   this module never touches the persistence worker internals directly.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  CapabilityState,
  CapabilityVerifierReadState,
  CapabilityVerifierRecord,
  McpDeviceVerifierReadState,
} from '../../contracts/persistence.js';
import type { PersistenceWorkerClient } from '../../persistence/worker-client.js';

/** How many random bytes make up the opaque token secret (256 bits). */
export const CAPABILITY_TOKEN_BYTES = 32;
/** Fixed human-recognizable prefix; the remainder is pure randomness, no claims. */
export const CAPABILITY_TOKEN_PREFIX = 'fc_';
export const DEFAULT_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;

export interface CapabilityPersistence {
  upsertCapability(state: CapabilityState): Promise<CapabilityState>;
  loadCapability(input: { capabilityId: string }): Promise<CapabilityState | null>;
  revokeCapability(input: { capabilityId: string; reason?: string }): Promise<{ revoked: true }>;
  /** Durable, hash-only capability token-digest registry. */
  createVerifier(record: CapabilityVerifierRecord): Promise<CapabilityVerifierReadState>;
  loadVerifierByTokenHash(input: {
    tokenHash: string;
  }): Promise<CapabilityVerifierReadState | null>;
  revokeVerifier(input: { deviceId: string; revokedAt: string }): Promise<{ revoked: true }>;
}

function isCapabilityVerifierReadState(
  value: CapabilityVerifierReadState | McpDeviceVerifierReadState,
): value is CapabilityVerifierReadState {
  return 'scope' in value && !('scopes' in value) && !('kind' in value);
}

function requireCapabilityVerifierReadState(
  value: CapabilityVerifierReadState | McpDeviceVerifierReadState,
): CapabilityVerifierReadState {
  if (!isCapabilityVerifierReadState(value)) {
    throw new Error('Persistence returned an MCP verifier for a capability store request.');
  }
  return value;
}

function requireCapabilityVerifierReadStateOrNull(
  value: CapabilityVerifierReadState | McpDeviceVerifierReadState | null,
): CapabilityVerifierReadState | null {
  return value === null ? null : requireCapabilityVerifierReadState(value);
}

/** Typed domain adapter over the persistence worker; keeps SQL out of this layer. */
export function createCapabilityPersistence(
  client: PersistenceWorkerClient,
): CapabilityPersistence {
  return {
    upsertCapability: (state) => client.request('upsertCapability', state),
    loadCapability: (input) => client.request('loadCapability', input),
    revokeCapability: (input) => client.request('revokeCapability', input),
    createVerifier: async (record) =>
      requireCapabilityVerifierReadState(
        await client.request('createDeviceVerifier', { ...record, store: 'capability' }),
      ),
    loadVerifierByTokenHash: async (input) =>
      requireCapabilityVerifierReadStateOrNull(
        await client.request('loadDeviceVerifierByTokenHash', { ...input, store: 'capability' }),
      ),
    revokeVerifier: (input) =>
      client.request('revokeDeviceVerifier', { ...input, store: 'capability' }),
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
const PERSIST_FIELDS = [
  'capabilityId',
  'userId',
  'projectId',
  'scope',
  'version',
  'expiresAt',
  'revokedAt',
] as const;

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

/** Verifier-row key binding one capability grant to its token digest. */
function capabilityVerifierKey(capabilityId: string, version: number): string {
  return `capability:${capabilityId}:v${version}`;
}

/** Inverts {@link capabilityVerifierKey}; null for any non-capability row. */
function parseCapabilityVerifierKey(
  deviceId: string,
): { readonly capabilityId: string; readonly version: number } | null {
  const match = /^capability:([^:]+):v(\d+)$/.exec(deviceId);
  if (match === null) return null;
  return { capabilityId: match[1], version: Number(match[2]) };
}

/**
 * Issuance, validation, revocation, and per-effect gating for opaque Agent
 * capability tokens over typed capability persistence operations. Construct
 * once per Host process and share it: every validate/checkGrant re-loads the
 * durable grant and the hash-only verifier row, so a revocation, version
 * bump, or expiry stops the next authorize/effect at its next checkpoint —
 * even after a Host restart, because the digest registry is durable.
 */
export class AgentCapabilityService {
  readonly #persistence: CapabilityPersistence;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #ttlMs: number;

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
    // Durable, hash-only digest registry: the token itself never persists;
    // the verifier row is keyed by the issued grant so a restart can still
    // resolve the token and re-check the persisted grant row.
    await this.#persistence.createVerifier({
      deviceId: capabilityVerifierKey(state.capabilityId, state.version),
      tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
      scope: state.scope,
      expiresAt: state.expiresAt,
      clientLabel: 'capability grant',
      createdAt: new Date(at).toISOString(),
    });
    return { token, grant: this.#project(state) };
  }

  /**
   * Validates a client-presented token against the durable hash-only verifier
   * and the current persisted grant (existence, version, revocation, expiry,
   * project, scope). Called before every effect that consumes a client token.
   */
  async validate(input: ValidateCapabilityInput): Promise<AgentCapabilityValidationResult> {
    this.#rejectUnknownKeys(input, VALIDATE_FIELDS, 'validate');
    if (typeof input.token !== 'string' || input.token.length === 0) {
      throw new CapabilityInputError('A non-empty token is required.');
    }
    if (input.scopes.length === 0) {
      throw new CapabilityInputError('At least one requested scope is required.');
    }
    const verifier = await this.#persistence.loadVerifierByTokenHash({
      tokenHash: createHash('sha256').update(input.token, 'utf8').digest('hex'),
    });
    if (verifier === null) return { ok: false, failure: failure('INVALID_TOKEN') };
    const binding = parseCapabilityVerifierKey(verifier.deviceId);
    if (binding === null) return { ok: false, failure: failure('INVALID_TOKEN') };
    const state = await this.#persistence.loadCapability({ capabilityId: binding.capabilityId });
    if (state == null) return { ok: false, failure: failure('NOT_FOUND') };
    if (state.version !== binding.version) {
      return { ok: false, failure: failure('VERSION_MISMATCH') };
    }
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

  /**
   * Persists a server-derived grant row directly into the durable capability
   * store — the exact row {@link checkGrant} re-loads for every effect.
   * Unlike {@link issue}, no token or verifier row is produced: the caller's
   * identity was already proven server-side (e.g. an owner-paired device
   * credential), so the persisted metadata alone is the grant. The input is
   * the full `CapabilityState` with the same fail-closed discipline as
   * `issue` — unknown keys are rejected and the documented fields are
   * required — and the upsert is idempotent: re-persisting with a new
   * expiry/scope/version overwrites the previous row.
   */
  async persistGrant(state: CapabilityState): Promise<CapabilityState> {
    this.#rejectUnknownKeys(state, PERSIST_FIELDS, 'persistGrant');
    if (
      state.capabilityId.length === 0 ||
      state.userId.length === 0 ||
      state.projectId.length === 0
    ) {
      throw new CapabilityInputError('capabilityId, userId, and projectId must be non-empty.');
    }
    if (
      !Array.isArray(state.scope) ||
      state.scope.length === 0 ||
      state.scope.some((scope) => typeof scope !== 'string' || scope.length === 0)
    ) {
      throw new CapabilityInputError('A capability must grant at least one non-empty scope.');
    }
    if (!Number.isSafeInteger(state.version) || state.version <= 0) {
      throw new CapabilityInputError('version must be a positive integer.');
    }
    if (typeof state.expiresAt !== 'string' || Number.isNaN(Date.parse(state.expiresAt))) {
      throw new CapabilityInputError('expiresAt must be a valid timestamp string.');
    }
    if (state.revokedAt !== undefined && typeof state.revokedAt !== 'string') {
      throw new CapabilityInputError('revokedAt must be a string when present.');
    }
    return this.#persistence.upsertCapability(state);
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

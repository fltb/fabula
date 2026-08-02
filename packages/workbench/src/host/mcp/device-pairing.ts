/**
 * Host-only MCP device pairing and durable device-credential verification.
 *
 * Owner-managed, one-time device pairing:
 * - `createPairing` issues a short-lived, single-use pairing code (only its
 *   SHA-256 hash is held, and only in this process). The code is a bootstrap
 *   artifact, never a credential: losing it (or a Host restart) only burns
 *   that pairing, never an issued device.
 * - `claim` redeems the code exactly once and returns an opaque device
 *   credential shown exactly once. ONLY the credential's SHA-256 hash plus
 *   scope/expiry/label/revocation is persisted (as a
 *   `DeviceVerifierRecord` through typed persistence operations); the raw
 *   credential never reaches SQLite, audit, output, or any read DTO.
 * - `verifyCredential` re-checks the durable verifier on every authorize and
 *   every effect: existence, revocation, expiry, and exact scope coverage.
 *   A Host restart keeps every issued device valid because the verifier row
 *   is hash-only and durable.
 *
 * Device identity is deliberately separate from browser sessions: the
 * credential carries its own scope grant and never requires an
 * `x-fabula-session`. Only the owner may pair devices (`ownerUserId` is a
 * server-side binding on every pairing), which is the sole path to the
 * `mcp:admin` scope; author/submit/admin scopes can never substitute for one
 * another because every tool declares its exact scope set.
 *
 * The capability layer shares this durable verifier table for its token
 * digests (deviceId keyed `capability:<capabilityId>:v<version>`); this
 * service filters those rows out of device listings and rejects them during
 * credential verification so the two stores can never cross-accept.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  DeviceVerifierReadState,
  DeviceVerifierRecord,
} from '../../contracts/persistence.js';
import type { PersistenceWorkerClient } from '../../persistence/worker-client.js';

/** How many random bytes make up the one-time device credential (256 bits). */
export const DEVICE_CREDENTIAL_BYTES = 32;
/** Fixed human-recognizable prefix; the remainder is pure randomness, no claims. */
export const DEVICE_CREDENTIAL_PREFIX = 'wbd_';
/** How many random bytes make up a one-time pairing code (192 bits). */
export const DEVICE_PAIRING_CODE_BYTES = 24;
/** Fixed pairing-code prefix; the remainder is pure randomness, no claims. */
export const DEVICE_PAIRING_CODE_PREFIX = 'wbp_';
/** Default window in which a pairing code may be claimed. */
export const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;
/** Ceiling on a device credential lifetime (90 days). */
export const MAX_DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Maximum length of the client label shown in device listings. */
export const MAX_DEVICE_LABEL_LENGTH = 120;
/** Host-internal verifier-row namespace used by the capability layer. */
export const CAPABILITY_VERIFIER_KEY_PREFIX = 'capability:';

/** The finite MCP scope vocabulary a pairing may request. */
export const KNOWN_MCP_SCOPES = [
  'mcp:read',
  'mcp:render',
  'mcp:author',
  'mcp:submit',
  'mcp:admin',
] as const;
export type KnownMcpScope = (typeof KNOWN_MCP_SCOPES)[number];

/** Persistent-verifier domain operations (hash-only by contract). */
export interface DeviceVerifierPersistence {
  createVerifier(record: DeviceVerifierRecord): Promise<DeviceVerifierReadState>;
  loadVerifierByTokenHash(input: { tokenHash: string }): Promise<DeviceVerifierReadState | null>;
  listVerifiers(): Promise<DeviceVerifierReadState[]>;
  revokeVerifier(input: { deviceId: string; revokedAt: string }): Promise<{ revoked: true }>;
}

/** Typed domain adapter over the persistence worker; keeps SQL out of this layer. */
export function createDeviceVerifierPersistence(
  client: PersistenceWorkerClient,
): DeviceVerifierPersistence {
  return {
    createVerifier: (record) => client.request('createDeviceVerifier', record),
    loadVerifierByTokenHash: (input) => client.request('loadDeviceVerifierByTokenHash', input),
    listVerifiers: () => client.request('listDeviceVerifiers', undefined),
    revokeVerifier: (input) => client.request('revokeDeviceVerifier', input),
  };
}

/** Malformed pairing input (unknown fields, empty label, bad scopes/ttl); no side effects. */
export class DevicePairingInputError extends Error {
  override readonly name = 'DevicePairingInputError';
}

export type McpDeviceClaimFailureCode =
  | 'PAIRING_NOT_FOUND'
  | 'PAIRING_EXPIRED'
  | 'SCOPE_INVALID'
  | 'INVALID_INPUT';

export type McpDeviceClaimResult =
  | { readonly ok: true; readonly credential: string; readonly device: DeviceVerifierReadState }
  | { readonly ok: false; readonly code: McpDeviceClaimFailureCode };

/** Typed credential-verification denials; names mirror the MCP auth failure codes. */
export type McpDeviceVerifyFailureCode =
  | 'TOKEN_INVALID'
  | 'TOKEN_REVOKED'
  | 'TOKEN_EXPIRED'
  | 'SCOPE_MISMATCH';

export type McpDeviceVerifyResult =
  | { readonly ok: true; readonly device: DeviceVerifierReadState }
  | { readonly ok: false; readonly code: McpDeviceVerifyFailureCode };

export interface CreateMcpDevicePairingInput {
  /** Server-side owner binding; only the owner may issue MCP devices. */
  readonly ownerUserId: string;
  /** Window in which the code may be claimed; defaults to {@link DEFAULT_PAIRING_TTL_MS}. */
  readonly ttlMs?: number;
}

export interface ClaimMcpDeviceInput {
  readonly pairingCode: string;
  readonly clientLabel: string;
  /** Least-scope grant for the device; every scope must be a known MCP scope. */
  readonly scopes: readonly string[];
  /** Credential lifetime; bounded by {@link MAX_DEVICE_TTL_MS}. */
  readonly ttlMs: number;
}

export interface VerifyDeviceCredentialInput {
  readonly credential: string;
  /** Exact scopes the current request needs; every one must be covered. */
  readonly scopes: readonly string[];
}

export interface McpDevicePairingServiceOptions {
  readonly persistence: DeviceVerifierPersistence;
  /** Timestamp source for pairing/credential expiry; defaults to the host clock. */
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly pairingTtlMs?: number;
  readonly maxDeviceTtlMs?: number;
}

/**
 * Owner-managed one-time MCP device pairing over the durable hash-only
 * verifier store. Construct once per Host process; the pending pairing-code
 * registry is deliberately process-held (a restart only burns unclaimed
 * codes), while issued device credentials survive restart via the verifier.
 */
export interface McpDevicePairingService {
  createPairing(input: CreateMcpDevicePairingInput): Promise<{
    readonly pairingCode: string;
    readonly expiresAt: string;
  }>;
  claim(input: ClaimMcpDeviceInput): Promise<McpDeviceClaimResult>;
  verifyCredential(input: VerifyDeviceCredentialInput): Promise<McpDeviceVerifyResult>;
  /** Safe read views of paired devices; never includes the credential or its hash. */
  listDevices(): Promise<DeviceVerifierReadState[]>;
  revoke(deviceId: string, revokedAt?: string): Promise<void>;
}

const CREATE_PAIRING_FIELDS = ['ownerUserId', 'ttlMs'] as const;
const CLAIM_FIELDS = ['pairingCode', 'clientLabel', 'scopes', 'ttlMs'] as const;
const VERIFY_FIELDS = ['credential', 'scopes'] as const;

function rejectUnknownKeys(value: object, allowed: readonly string[], method: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new DevicePairingInputError(
        `Unknown field "${key}" passed to ${method}; pairing fields are fixed and server-assigned.`,
      );
    }
  }
}

/** SHA-256 hex of an opaque secret; the only thing ever persisted. */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function createMcpDevicePairingService(
  options: McpDevicePairingServiceOptions,
): McpDevicePairingService {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? randomUUID;
  const pairingTtlMs = options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS;
  const maxDeviceTtlMs = options.maxDeviceTtlMs ?? MAX_DEVICE_TTL_MS;
  /** sha256(pairing code) -> server-side pairing intent (never the code itself). */
  const pending = new Map<string, { ownerUserId: string; expiresAt: number }>();

  function claimFailure(code: McpDeviceClaimFailureCode): McpDeviceClaimResult {
    return { ok: false, code };
  }

  return {
    async createPairing(input: CreateMcpDevicePairingInput) {
      rejectUnknownKeys(input, CREATE_PAIRING_FIELDS, 'createPairing');
      if (typeof input.ownerUserId !== 'string' || input.ownerUserId.length === 0) {
        throw new DevicePairingInputError('ownerUserId is a required server-side binding.');
      }
      const ttlMs = input.ttlMs ?? pairingTtlMs;
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new DevicePairingInputError('ttlMs must be a positive number of milliseconds.');
      }
      const code =
        DEVICE_PAIRING_CODE_PREFIX + randomBytes(DEVICE_PAIRING_CODE_BYTES).toString('base64url');
      const at = now();
      pending.set(sha256(code), { ownerUserId: input.ownerUserId, expiresAt: at + ttlMs });
      return { pairingCode: code, expiresAt: new Date(at + ttlMs).toISOString() };
    },

    async claim(input: ClaimMcpDeviceInput): Promise<McpDeviceClaimResult> {
      try {
        rejectUnknownKeys(input, CLAIM_FIELDS, 'claim');
      } catch {
        // Unknown fields are a typed client failure on the wire, never a throw.
        return claimFailure('INVALID_INPUT');
      }
      if (typeof input.pairingCode !== 'string' || input.pairingCode.length === 0) {
        return claimFailure('INVALID_INPUT');
      }
      if (
        typeof input.clientLabel !== 'string' ||
        input.clientLabel.trim().length === 0 ||
        input.clientLabel.length > MAX_DEVICE_LABEL_LENGTH
      ) {
        return claimFailure('INVALID_INPUT');
      }
      if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
        return claimFailure('INVALID_INPUT');
      }
      if (
        !input.scopes.every(
          (scope) =>
            typeof scope === 'string' && (KNOWN_MCP_SCOPES as readonly string[]).includes(scope),
        )
      ) {
        return claimFailure('SCOPE_INVALID');
      }
      if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > maxDeviceTtlMs) {
        return claimFailure('INVALID_INPUT');
      }

      const codeHash = sha256(input.pairingCode);
      const intent = pending.get(codeHash);
      if (intent === undefined) return claimFailure('PAIRING_NOT_FOUND');
      if (intent.expiresAt <= now()) {
        pending.delete(codeHash);
        return claimFailure('PAIRING_EXPIRED');
      }
      // The code is single-use: consume it before any side effect so a retry
      // can never mint a second device from the same code.
      pending.delete(codeHash);

      const scopes = [...new Set(input.scopes)] as string[];
      const at = now();
      const credential =
        DEVICE_CREDENTIAL_PREFIX + randomBytes(DEVICE_CREDENTIAL_BYTES).toString('base64url');
      const device = await options.persistence.createVerifier({
        deviceId: newId(),
        tokenHash: sha256(credential),
        scope: scopes,
        expiresAt: new Date(at + input.ttlMs).toISOString(),
        clientLabel: input.clientLabel.trim(),
        createdAt: new Date(at).toISOString(),
      });
      return { ok: true, credential, device };
    },

    async verifyCredential(input: VerifyDeviceCredentialInput): Promise<McpDeviceVerifyResult> {
      rejectUnknownKeys(input, VERIFY_FIELDS, 'verifyCredential');
      if (typeof input.credential !== 'string' || input.credential.length === 0) {
        return { ok: false, code: 'TOKEN_INVALID' };
      }
      if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
        return { ok: false, code: 'SCOPE_MISMATCH' };
      }
      const row = await options.persistence.loadVerifierByTokenHash({
        tokenHash: sha256(input.credential),
      });
      if (row === null) return { ok: false, code: 'TOKEN_INVALID' };
      // Capability-layer digests share the table; a capability token is never
      // a device credential and vice versa.
      if (row.deviceId.startsWith(CAPABILITY_VERIFIER_KEY_PREFIX)) {
        return { ok: false, code: 'TOKEN_INVALID' };
      }
      if (row.revokedAt != null) return { ok: false, code: 'TOKEN_REVOKED' };
      if (new Date(row.expiresAt).getTime() <= now()) return { ok: false, code: 'TOKEN_EXPIRED' };
      if (input.scopes.some((scope) => !row.scope.includes(scope))) {
        return { ok: false, code: 'SCOPE_MISMATCH' };
      }
      return { ok: true, device: row };
    },

    async listDevices(): Promise<DeviceVerifierReadState[]> {
      const rows = await options.persistence.listVerifiers();
      return rows.filter((row) => !row.deviceId.startsWith(CAPABILITY_VERIFIER_KEY_PREFIX));
    },

    async revoke(deviceId: string, revokedAt?: string): Promise<void> {
      if (typeof deviceId !== 'string' || deviceId.length === 0) {
        throw new DevicePairingInputError('deviceId must be a non-empty string.');
      }
      await options.persistence.revokeVerifier({
        deviceId,
        revokedAt: revokedAt ?? new Date(now()).toISOString(),
      });
    },
  };
}

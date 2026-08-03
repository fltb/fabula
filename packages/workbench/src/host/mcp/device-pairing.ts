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
 * Capability verifiers use a separate persistence store and are never queried
 * by this service. The adapter selects the MCP store for every create, read,
 * list, and revoke operation.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PersistenceWorkerClient } from '../../persistence/worker-client.js';
import type {
  McpDeviceVerifierReadState,
  McpDeviceVerifierRecord,
} from '../../contracts/persistence.js';
import {
  PROJECT_ACCESS_ROLE_GRANTS,
  PROJECT_ACCESS_ROLES,
} from '../../contracts/configuration.js';
import type { ProjectAccessRole } from '../../contracts/configuration.js';


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

/** The finite MCP scope vocabulary a pairing may request. */
export const KNOWN_MCP_SCOPES = [
  'mcp:read',
  'mcp:render',
  'mcp:author',
  'mcp:submit',
  'mcp:admin',
] as const;
export type KnownMcpScope = (typeof KNOWN_MCP_SCOPES)[number];

/** Typed MCP persistence boundary; labels and roles never cross this boundary. */
export interface DeviceVerifierPersistence {
  createVerifier(record: McpDeviceVerifierRecord): Promise<McpDeviceVerifierReadState>;
  loadVerifierByTokenHash(input: { tokenHash: string }): Promise<McpDeviceVerifierReadState | null>;
  listVerifiers(): Promise<McpDeviceVerifierReadState[]>;
  revokeVerifier(input: { deviceId: string; revokedAt: string }): Promise<{ revoked: true }>;
}
function isMcpDeviceVerifierReadState(value: unknown): value is McpDeviceVerifierReadState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.deviceId === 'string' &&
    ((row.kind === 'project' &&
      typeof row.projectId === 'string' &&
      row.projectId.length > 0) ||
      (row.kind === 'admin' && row.projectId === undefined)) &&
    typeof row.ownerUserId === 'string' &&
    Array.isArray(row.scopes) &&
    row.scopes.every((scope) => typeof scope === 'string') &&
    Number.isSafeInteger(row.grantRevision) &&
    typeof row.expiresAt === 'string' &&
    (row.revokedAt === undefined || typeof row.revokedAt === 'string') &&
    typeof row.createdAt === 'string' &&
    !('tokenHash' in row) &&
    !('scope' in row) &&
    !('clientLabel' in row)
  );
}

function requireMcpDeviceVerifierReadState(value: unknown): McpDeviceVerifierReadState {
  if (!isMcpDeviceVerifierReadState(value)) {
    throw new Error('Persistence returned a capability verifier for an MCP store request.');
  }
  return value;
}

function requireMcpDeviceVerifierReadStateOrNull(
  value: unknown,
): McpDeviceVerifierReadState | null {
  return value === null ? null : requireMcpDeviceVerifierReadState(value);
}

function requireMcpDeviceVerifierReadStates(value: unknown): McpDeviceVerifierReadState[] {
  if (!Array.isArray(value)) {
    throw new Error('Persistence returned a non-list result for an MCP store request.');
  }
  return value.map(requireMcpDeviceVerifierReadState);
}


/** Typed domain adapter over the persistence worker; keeps SQL out of this layer. */
export function createDeviceVerifierPersistence(
  client: PersistenceWorkerClient,
): DeviceVerifierPersistence {
  return {
    createVerifier: async (record) =>
      requireMcpDeviceVerifierReadState(
        await client.request('createDeviceVerifier', { ...record, store: 'mcp' }),
      ),
    loadVerifierByTokenHash: async (input) =>
      requireMcpDeviceVerifierReadStateOrNull(
        await client.request('loadDeviceVerifierByTokenHash', { ...input, store: 'mcp' }),
      ),
    listVerifiers: async () =>
      requireMcpDeviceVerifierReadStates(
        await client.request('listDeviceVerifiers', { store: 'mcp' }),
      ),
    revokeVerifier: (input) =>
      client.request('revokeDeviceVerifier', { ...input, store: 'mcp' }),
  };
}

/** Malformed pairing input (unknown fields, empty label, bad scopes/ttl); no side effects. */
export class DevicePairingInputError extends Error {
  override readonly name = 'DevicePairingInputError';
}

export type McpDeviceKind = 'project' | 'admin';
export type McpDeviceRole = ProjectAccessRole;

export type McpDeviceClaimFailureCode =
  | 'PAIRING_NOT_FOUND'
  | 'PAIRING_EXPIRED'
  | 'SCOPE_INVALID'
  | 'INVALID_INPUT';

export type McpDeviceClaimResult =
  | {
      readonly ok: true;
      readonly credential: string;
      /** One-time claim metadata; never part of persistence or later reads. */
      readonly label: string;
      readonly device: McpDeviceVerifierReadState;
    }
  | { readonly ok: false; readonly code: McpDeviceClaimFailureCode };

/** Typed credential-verification denials; names mirror the MCP auth failure codes. */
export type McpDeviceVerifyFailureCode =
  | 'TOKEN_INVALID'
  | 'TOKEN_REVOKED'
  | 'TOKEN_EXPIRED'
  | 'PROJECT_MISMATCH'
  | 'SCOPE_MISMATCH'
  | 'ADMIN_ROUTE_REQUIRED';

export type McpDeviceVerifyResult =
  | { readonly ok: true; readonly device: McpDeviceVerifierReadState }
  | { readonly ok: false; readonly code: McpDeviceVerifyFailureCode };

export type CreateMcpDevicePairingInput =
  | {
      /** Server-side owner binding; only the owner may issue MCP devices. */
      readonly ownerUserId: string;
      readonly kind: 'project';
      readonly projectId: string;
      /** Scope policy for project devices; defaults to reader. */
      readonly role?: ProjectAccessRole;
      readonly ttlMs?: number;
    }
  | {
      /** Server-side owner binding; only the owner may issue MCP devices. */
      readonly ownerUserId: string;
      readonly kind: 'admin';
      readonly projectId?: never;
      readonly role?: never;
      readonly ttlMs?: number;
    };

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
  /** Project route binding; required for project devices. */
  readonly projectId?: string;
  /** Admin devices are accepted only by an explicitly admin route. */
  readonly route?: 'project' | 'admin';
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
  listDevices(): Promise<McpDeviceVerifierReadState[]>;
  revoke(deviceId: string, revokedAt?: string): Promise<void>;
}

function isProjectAccessRole(value: unknown): value is ProjectAccessRole {
  return (
    typeof value === 'string' &&
    (PROJECT_ACCESS_ROLES as readonly string[]).includes(value)
  );
}


const CREATE_PAIRING_FIELDS = ['ownerUserId', 'kind', 'projectId', 'role', 'ttlMs'] as const;
const CLAIM_FIELDS = ['pairingCode', 'clientLabel', 'scopes', 'ttlMs'] as const;
const VERIFY_FIELDS = ['credential', 'scopes', 'projectId', 'route'] as const;


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
  const pending = new Map<
    string,
    {
      ownerUserId: string;
      kind: McpDeviceKind;
      projectId?: string;
      role?: ProjectAccessRole;
      expiresAt: number;
    }
  >();

  function claimFailure(code: McpDeviceClaimFailureCode): McpDeviceClaimResult {
    return { ok: false, code };
  }

  return {
    async createPairing(input: CreateMcpDevicePairingInput) {
      rejectUnknownKeys(input, CREATE_PAIRING_FIELDS, 'createPairing');
      if (typeof input.ownerUserId !== 'string' || input.ownerUserId.length === 0) {
        throw new DevicePairingInputError('ownerUserId is a required server-side binding.');
      }
      if (input.kind !== 'project' && input.kind !== 'admin') {
        throw new DevicePairingInputError('kind must be project or admin.');
      }
      const role =
        input.kind === 'project' ? (input.role ?? 'reader') : undefined;
      if (input.role !== undefined && !isProjectAccessRole(input.role)) {
        throw new DevicePairingInputError('role is invalid.');
      }
      if (
        input.kind === 'project'
          ? typeof input.projectId !== 'string' || input.projectId.length === 0
          : Object.hasOwn(input, 'projectId') || Object.hasOwn(input, 'role')
      ) {
        throw new DevicePairingInputError(
          input.kind === 'project'
            ? 'project devices require a projectId.'
            : 'admin devices cannot carry a projectId or project role.',
        );
      }
      const ttlMs = input.ttlMs ?? pairingTtlMs;
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new DevicePairingInputError('ttlMs must be a positive number of milliseconds.');
      }
      const code =
        DEVICE_PAIRING_CODE_PREFIX + randomBytes(DEVICE_PAIRING_CODE_BYTES).toString('base64url');
      const at = now();
      pending.set(sha256(code), {
        ownerUserId: input.ownerUserId,
        kind: input.kind,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(role === undefined ? {} : { role }),
        expiresAt: at + ttlMs,
      });
      return { pairingCode: code, expiresAt: new Date(at + ttlMs).toISOString() };
    },
    async claim(input: ClaimMcpDeviceInput): Promise<McpDeviceClaimResult> {
      try {
        rejectUnknownKeys(input, CLAIM_FIELDS, 'claim');
      } catch {
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
      const scopes = [...new Set(input.scopes)] as string[];
      if (intent.kind === 'admin') {
        if (scopes.length !== 1 || scopes[0] !== 'mcp:admin') return claimFailure('SCOPE_INVALID');
      } else {
        const allowed = PROJECT_ACCESS_ROLE_GRANTS[intent.role ?? 'reader'].scopes as readonly string[];
        if (scopes.some((scope) => !allowed.includes(scope))) return claimFailure('SCOPE_INVALID');
      }
      pending.delete(codeHash);
      const at = now();
      const credential =
        DEVICE_CREDENTIAL_PREFIX + randomBytes(DEVICE_CREDENTIAL_BYTES).toString('base64url');
      const device = await options.persistence.createVerifier({
        deviceId: newId(),
        tokenHash: sha256(credential),
        kind: intent.kind,
        ...(intent.projectId === undefined ? {} : { projectId: intent.projectId }),
        ownerUserId: intent.ownerUserId,
        scopes,
        grantRevision: 1,
        expiresAt: new Date(at + input.ttlMs).toISOString(),
        createdAt: new Date(at).toISOString(),
      });
      return { ok: true, credential, label: input.clientLabel.trim(), device };
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
      if (row === null) {
        return { ok: false, code: 'TOKEN_INVALID' };
      }
      if (row.kind !== 'project' && row.kind !== 'admin') {
        return { ok: false, code: 'TOKEN_INVALID' };
      }
      if (row.revokedAt != null) return { ok: false, code: 'TOKEN_REVOKED' };
      if (new Date(row.expiresAt).getTime() <= now()) return { ok: false, code: 'TOKEN_EXPIRED' };
      if (row.kind === 'project') {
        if (
          typeof input.projectId !== 'string' ||
          input.projectId.length === 0 ||
          input.projectId !== row.projectId ||
          input.route === 'admin' ||
          input.scopes.includes('mcp:admin')
        ) {
          return { ok: false, code: 'PROJECT_MISMATCH' };
        }
      } else if (
        input.route !== 'admin' ||
        input.projectId !== undefined ||
        input.scopes.some((scope) => scope !== 'mcp:admin') ||
        input.scopes.length !== 1
      ) {
        return { ok: false, code: 'ADMIN_ROUTE_REQUIRED' };
      }
      if (input.scopes.some((scope) => !row.scopes.includes(scope))) {
        return { ok: false, code: 'SCOPE_MISMATCH' };
      }
      return { ok: true, device: row };
    },
    async listDevices(): Promise<McpDeviceVerifierReadState[]> {
      const rows = await options.persistence.listVerifiers();
      return rows.filter((row) => row.kind === 'project' || row.kind === 'admin');
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

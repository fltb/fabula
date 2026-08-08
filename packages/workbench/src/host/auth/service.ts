/**
 * Host-only local authentication service. It depends exclusively on typed
 * persistence domain methods (never SQL, Kysely, or a database handle) and on
 * the async argon2id password primitives. Browser code never imports this
 * module; Hono route handlers (a later slice) consume only its results.
 */
import { randomUUID } from 'node:crypto';
import type { ProjectAccessRole } from '../../contracts/configuration.js';
import { PROJECT_ACCESS_ROLES } from '../../contracts/configuration.js';
import type {
  AcceptInviteUserResult,
  AuthBackoffState,
  AuthUserRecord,
  ConsumeInviteResult,
  InviteState,
  PasswordHashRecord,
  SessionState,
} from '../../contracts/persistence.js';

import type { PersistenceWorkerClient } from '../../persistence/worker-client.js';
import { type BackoffPolicy, backoffDelayMs, DEFAULT_BACKOFF_POLICY } from './backoff.js';
import {
  type Argon2Parameters,
  DEFAULT_ARGON2_PARAMETERS,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPassword,
} from './password.js';
export interface AuthPersistence {
  getAuthState(): Promise<{ ownerUserId: string | null }>;
  bootstrapOwner(input: {
    userId: string;
    displayName: string;
    passwordHash: PasswordHashRecord;
    capabilityVersion: number;
    createdAt: string;
  }): Promise<AuthUserRecord>;
  acceptInviteUser(input: {
    inviteId: string;
    consumedAt: string;
    userId: string;
    displayName: string;
    passwordHash: PasswordHashRecord;
    capabilityVersion: number;
    createdAt: string;
    session: SessionState;
  }): Promise<AcceptInviteUserResult>;
  loadUser(input: { userId: string }): Promise<AuthUserRecord | null>;
  loadOwner(): Promise<AuthUserRecord | null>;
  resetOwnerPassword(input: {
    userId: string;
    passwordHash: PasswordHashRecord;
    capabilityVersion: number;
    at: string;
  }): Promise<{ user: AuthUserRecord; revokedSessions: number; revokedCapabilities: number }>;
  recordAuthFailure(input: { subject: string; at: string }): Promise<AuthBackoffState>;
  loadAuthBackoff(input: { subject: string }): Promise<AuthBackoffState | null>;
  clearAuthBackoff(input: { subject: string }): Promise<{ cleared: true }>;
  createSession(state: SessionState): Promise<SessionState>;
  loadSession(input: { sessionId: string }): Promise<SessionState | null>;
  revokeSession(input: { sessionId: string; reason?: string }): Promise<{ revoked: true }>;
  createInvite(state: InviteState): Promise<InviteState>;
  consumeInvite(input: { inviteId: string; consumedAt: string }): Promise<ConsumeInviteResult>;
}

export function createAuthPersistence(client: PersistenceWorkerClient): AuthPersistence {
  return {
    getAuthState: () => client.request('getAuthState', undefined),
    bootstrapOwner: (input) => client.request('bootstrapOwner', input),
    acceptInviteUser: (input) => client.request('acceptInviteUser', input),
    loadUser: (input) => client.request('loadUser', input),
    loadOwner: () => client.request('loadOwner', undefined),
    resetOwnerPassword: (input) => client.request('resetOwnerPassword', input),
    recordAuthFailure: (input) => client.request('recordAuthFailure', input),
    loadAuthBackoff: (input) => client.request('loadAuthBackoff', input),
    clearAuthBackoff: (input) => client.request('clearAuthBackoff', input),
    createSession: (state) => client.request('createSession', state),
    loadSession: (input) => client.request('loadSession', input),
    revokeSession: (input) => client.request('revokeSession', input),
    createInvite: (state) => client.request('createInvite', state),
    consumeInvite: (input) => client.request('consumeInvite', input),
  };
}

export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
export const AUTH_FAILURE_MESSAGE = 'Invalid username or password.';

export interface LocalAuthServiceOptions {
  persistence: AuthPersistence;
  /** Epoch milliseconds; injectable for deterministic tests. */
  now?: () => number;
  newId?: () => string;
  backoff?: BackoffPolicy;
  sessionTtlMs?: number;
  inviteTtlMs?: number;
  passwordParameters?: Argon2Parameters;
}

export interface BootstrapResult {
  user: AuthUserRecord;
  session: SessionState;
}
export interface AuthenticateFailure {
  code: 'AUTH_FAILED';
  message: typeof AUTH_FAILURE_MESSAGE;
  retryable: true;
  /** Present only while the subject is locked; uniform code/message otherwise. */
  retryAfterMs?: number;
  lockedUntil?: string;
}
export type AuthenticateResult =
  | { ok: true; session: SessionState }
  | { ok: false; failure: AuthenticateFailure };
export type AcceptInviteResult =
  | { status: 'accepted'; user: AuthUserRecord; session: SessionState }
  | { status: 'already-consumed' | 'expired' | 'not-found' };
export interface ResetOwnerPasswordResult {
  user: AuthUserRecord;
  revokedSessions: number;
  revokedCapabilities: number;
}

export class OwnerAlreadyExistsError extends Error {
  readonly code = 'OWNER_EXISTS';
  constructor() {
    super('An owner account already exists');
    this.name = 'OwnerAlreadyExistsError';
  }
}
export class NotOwnerAccountError extends Error {
  readonly code = 'NOT_OWNER_ACCOUNT';
  constructor() {
    super('Password reset is only available for the owner account');
    this.name = 'NotOwnerAccountError';
  }
}

export class LocalAuthService {
  readonly #persistence: AuthPersistence;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #backoff: BackoffPolicy;
  readonly #sessionTtlMs: number;
  readonly #inviteTtlMs: number;
  readonly #parameters: Argon2Parameters;

  constructor(options: LocalAuthServiceOptions) {
    this.#persistence = options.persistence;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? randomUUID;
    this.#backoff = options.backoff ?? DEFAULT_BACKOFF_POLICY;
    this.#sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#inviteTtlMs = options.inviteTtlMs ?? DEFAULT_INVITE_TTL_MS;
    this.#parameters = options.passwordParameters ?? DEFAULT_ARGON2_PARAMETERS;
  }

  async getAuthState(): Promise<{ ownerExists: boolean }> {
    const state = await this.#persistence.getAuthState();
    return { ownerExists: state.ownerUserId != null };
  }

  /** First-run owner bootstrap. Once an owner exists this throws `OwnerAlreadyExistsError`. */
  async bootstrapOwner(input: {
    password?: string;
    displayName?: string;
  }): Promise<BootstrapResult> {
    const { ownerExists } = await this.getAuthState();
    if (ownerExists) throw new OwnerAlreadyExistsError();
    const now = new Date(this.#now()).toISOString();
    // An empty password creates a passwordless owner: a dummy, unverifiable
    // hash keeps the "owner exists" invariant while interactive login stays
    // impossible. Browser sessions for passwordless owners come from the
    // setup bootstrap session (loopback device trust); LAN login requires a
    // real password set through the owner dashboard.
    const passwordHash =
      input.password === undefined || input.password.length === 0
        ? DUMMY_PASSWORD_HASH
        : await hashPassword(input.password, this.#parameters);
    const user = await this.#persistence.bootstrapOwner({
      userId: this.#newId(),
      displayName: input.displayName ?? 'Owner',
      passwordHash,
      capabilityVersion: 1,
      createdAt: now,
    });
    const session = await this.#persistence.createSession(this.#newSession(user));
    return { user, session };
  }

  /**
   * Loopback device trust for passwordless owners. An owner whose hash is the
   * dummy (unverifiable) sentinel cannot log in interactively, so a local
   * process on the loopback listener may mint a fresh owner session instead.
   * Owners with a real password must authenticate normally; the launch only
   * registers this endpoint for pure loopback bindings (never LAN/unix).
   * Returns null when there is no owner or the owner has a real password.
   */
  async loopbackSession(): Promise<BootstrapResult | null> {
    const state = await this.getAuthState();
    if (!state.ownerExists) return null;
    const owner = await this.#persistence.loadOwner();
    if (owner === null || owner.passwordHash?.hashBase64 !== DUMMY_PASSWORD_HASH.hashBase64) {
      return null;
    }
    const session = await this.#persistence.createSession(this.#newSession(owner));
    return { user: owner, session };
  }

  /**
   * Authenticates a user and creates a NEW session on success (multi-session
   * support: every successful login is its own session). Failures are uniform
   * regardless of whether the user exists, and every failed verification is
   * recorded into a persisted incremental backoff subject.
   */
  async authenticate(input: { userId: string; password: string }): Promise<AuthenticateResult> {
    const at = this.#now();
    const subject = `user:${input.userId}`;
    const backoff = await this.#persistence.loadAuthBackoff({ subject });
    const lockedUntil = this.#lockedUntil(backoff);
    if (lockedUntil != null && lockedUntil > at) {
      return this.#failure(lockedUntil, at);
    }
    const user = await this.#persistence.loadUser({ userId: input.userId });
    const valid =
      user?.passwordHash != null
        ? await verifyPassword(input.password, user.passwordHash)
        : await verifyPassword(input.password, DUMMY_PASSWORD_HASH);
    if (!valid) {
      const state = await this.#persistence.recordAuthFailure({
        subject,
        at: new Date(at).toISOString(),
      });
      return this.#failure(this.#lockedUntil(state) ?? 0, at);
    }
    // A verified password implies the user exists; the dummy record never verifies.
    if (user == null) return this.#failure(0, at);
    await this.#persistence.clearAuthBackoff({ subject });
    const session = await this.#persistence.createSession(this.#newSession(user));
    return { ok: true, session };
  }

  async getSession(sessionId: string): Promise<SessionState | null> {
    return this.#persistence.loadSession({ sessionId });
  }

  async revokeSession(sessionId: string, reason?: string): Promise<void> {
    await this.#persistence.revokeSession({ sessionId, reason });
  }

  async createInvite(input: {
    projectId: string;
    role: ProjectAccessRole;
    ttlMs?: number;
  }): Promise<InviteState> {
    if (
      typeof input.projectId !== 'string' ||
      input.projectId.length === 0 ||
      !(PROJECT_ACCESS_ROLES as readonly string[]).includes(input.role)
    ) {
      throw new TypeError('An invite requires a projectId and a canonical project role.');
    }
    const at = this.#now();
    const ttlMs = input.ttlMs ?? this.#inviteTtlMs;
    return this.#persistence.createInvite({
      inviteId: this.#newId(),
      projectId: input.projectId,
      role: input.role,
      expiresAt: new Date(at + ttlMs).toISOString(),
    });
  }

  /**
   * Hashes before persistence, then atomically consumes the invite, creates
   * the user, and creates the first session in one worker transaction.
   */
  async acceptInvite(input: {
    inviteId: string;
    password: string;
    displayName?: string;
  }): Promise<AcceptInviteResult> {
    const now = new Date(this.#now()).toISOString();
    const passwordHash = await hashPassword(input.password, this.#parameters);
    const userId = this.#newId();
    const session: SessionState = {
      sessionId: this.#newId(),
      userId,
      expiresAt: new Date(this.#now() + this.#sessionTtlMs).toISOString(),
      capabilityVersion: 1,
    };
    const accepted = await this.#persistence.acceptInviteUser({
      inviteId: input.inviteId,
      consumedAt: now,
      userId,
      displayName: input.displayName ?? 'User',
      passwordHash,
      capabilityVersion: 1,
      createdAt: now,
      session,
    });
    if (accepted.status !== 'accepted') return accepted;
    return { status: 'accepted', user: accepted.user, session: accepted.session };
  }

  /**
   * Owner password reset. Only the owner account can be reset through this
   * path; the persistence worker atomically replaces the password hash, bumps
   * the capability version, deletes the owner's sessions and revokes the
   * owner's capabilities in one transaction.
   */
  async resetOwnerPassword(input: {
    userId: string;
    newPassword: string;
  }): Promise<ResetOwnerPasswordResult> {
    const owner = await this.#persistence.loadOwner();
    if (owner == null || owner.userId !== input.userId) throw new NotOwnerAccountError();
    const at = new Date(this.#now()).toISOString();
    const passwordHash = await hashPassword(input.newPassword, this.#parameters);
    return this.#persistence.resetOwnerPassword({
      userId: input.userId,
      passwordHash,
      capabilityVersion: owner.capabilityVersion + 1,
      at,
    });
  }

  #newSession(user: AuthUserRecord): SessionState {
    return {
      sessionId: this.#newId(),
      userId: user.userId,
      expiresAt: new Date(this.#now() + this.#sessionTtlMs).toISOString(),
      capabilityVersion: user.capabilityVersion,
    };
  }

  #lockedUntil(backoff: AuthBackoffState | null): number | null {
    if (backoff == null) return null;
    const lockMs =
      new Date(backoff.updatedAt).getTime() + backoffDelayMs(backoff.failures, this.#backoff);
    return Number.isFinite(lockMs) ? lockMs : null;
  }

  #failure(lockedUntilMs: number, at: number): AuthenticateResult {
    const failure: AuthenticateFailure = {
      code: 'AUTH_FAILED',
      message: AUTH_FAILURE_MESSAGE,
      retryable: true,
    };
    if (lockedUntilMs > at) {
      failure.retryAfterMs = lockedUntilMs - at;
      failure.lockedUntil = new Date(lockedUntilMs).toISOString();
    }
    return { ok: false, failure };
  }
}

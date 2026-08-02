/**
 * Host-only auth foundation: local identity, sessions, invites, backoff, and
 * owner password reset over typed persistence domain methods. Never imported
 * by the browser client.
 */

export type { BackoffPolicy } from './backoff.js';
export { backoffDelayMs, DEFAULT_BACKOFF_POLICY } from './backoff.js';
export type { Argon2Parameters, PasswordHashRecord } from './password.js';
export {
  DEFAULT_ARGON2_PARAMETERS,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  PASSWORD_HASH_ALGORITHM,
  PASSWORD_HASH_VERSION,
  verifyPassword,
} from './password.js';
export type {
  AcceptInviteResult,
  AuthenticateFailure,
  AuthenticateResult,
  AuthPersistence,
  BootstrapResult,
  LocalAuthServiceOptions,
  ResetOwnerPasswordResult,
} from './service.js';
export {
  AUTH_FAILURE_MESSAGE,
  createAuthPersistence,
  DEFAULT_INVITE_TTL_MS,
  DEFAULT_SESSION_TTL_MS,
  LocalAuthService,
  NotOwnerAccountError,
  OwnerAlreadyExistsError,
} from './service.js';

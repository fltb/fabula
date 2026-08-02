/**
 * Host-only password hashing: Node 26 async `crypto.argon2` (argon2id) with
 * versioned parameters and a random per-hash salt. Never imported by the
 * browser client. Verification re-derives the key from the stored salt and
 * parameters and compares with a timing-safe equality.
 */
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PasswordHashRecord } from '../../contracts/persistence.js';

export type { PasswordHashRecord } from '../../contracts/persistence.js';

export const PASSWORD_HASH_VERSION = 1 as const;
export const PASSWORD_HASH_ALGORITHM = 'argon2id' as const;
export const SALT_BYTES = 16;

export interface Argon2Parameters { memory: number; passes: number; parallelism: number; tagLength: number }

export const DEFAULT_ARGON2_PARAMETERS: Argon2Parameters = { memory: 65536, passes: 3, parallelism: 1, tagLength: 32 };

function deriveKey(message: string, nonce: Uint8Array, parameters: Argon2Parameters): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      PASSWORD_HASH_ALGORITHM,
      { message, nonce, memory: parameters.memory, passes: parameters.passes, parallelism: parameters.parallelism, tagLength: parameters.tagLength },
      (error, derivedKey) => { if (error) reject(error); else resolve(Buffer.from(derivedKey)); },
    );
  });
}

export async function hashPassword(password: string, parameters: Argon2Parameters = DEFAULT_ARGON2_PARAMETERS): Promise<PasswordHashRecord> {
  const salt = randomBytes(SALT_BYTES);
  const derivedKey = await deriveKey(password, salt, parameters);
  return {
    version: PASSWORD_HASH_VERSION,
    algorithm: PASSWORD_HASH_ALGORITHM,
    saltBase64: salt.toString('base64'),
    hashBase64: derivedKey.toString('base64'),
    ...parameters,
  };
}

export async function verifyPassword(password: string, record: PasswordHashRecord): Promise<boolean> {
  if (record.version !== PASSWORD_HASH_VERSION || record.algorithm !== PASSWORD_HASH_ALGORITHM) return false;
  const salt = Buffer.from(record.saltBase64, 'base64');
  const expected = Buffer.from(record.hashBase64, 'base64');
  if (salt.length === 0 || expected.length === 0) return false;
  const derivedKey = await deriveKey(password, salt, { memory: record.memory, passes: record.passes, parallelism: record.parallelism, tagLength: record.tagLength });
  return derivedKey.length === expected.length && timingSafeEqual(derivedKey, expected);
}

/**
 * Fixed-cost dummy record used when a credential does not name a known user,
 * so that unknown-user and wrong-password attempts take indistinguishable time.
 */
export const DUMMY_PASSWORD_HASH: PasswordHashRecord = {
  version: PASSWORD_HASH_VERSION,
  algorithm: PASSWORD_HASH_ALGORITHM,
  saltBase64: randomBytes(SALT_BYTES).toString('base64'),
  hashBase64: Buffer.alloc(DEFAULT_ARGON2_PARAMETERS.tagLength).toString('base64'),
  ...DEFAULT_ARGON2_PARAMETERS,
};

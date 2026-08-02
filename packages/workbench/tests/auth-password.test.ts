import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ARGON2_PARAMETERS,
  hashPassword,
  PASSWORD_HASH_ALGORITHM,
  PASSWORD_HASH_VERSION,
  verifyPassword,
} from '../src/host/auth/password.js';

const sourcePath = (name: string): string => fileURLToPath(new URL(`../src/host/auth/${name}.ts`, import.meta.url));

describe('host auth password primitives', () => {
  it('hashes and verifies a password with argon2id and a random salt', async () => {
    const record = await hashPassword('correct horse battery staple');
    expect(record.version).toBe(PASSWORD_HASH_VERSION);
    expect(record.algorithm).toBe(PASSWORD_HASH_ALGORITHM);
    expect(record.saltBase64).toBeTruthy();
    expect(record.hashBase64).toBeTruthy();
    await expect(verifyPassword('correct horse battery staple', record)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', record)).resolves.toBe(false);
  });

  it('derives a different salt and hash per call for the same password', async () => {
    const first = await hashPassword('same password');
    const second = await hashPassword('same password');
    expect(first.saltBase64).not.toBe(second.saltBase64);
    expect(first.hashBase64).not.toBe(second.hashBase64);
  });

  it('records versioned parameters in the hash record', async () => {
    const record = await hashPassword('pw');
    expect(record).toMatchObject(DEFAULT_ARGON2_PARAMETERS);
  });

  it('fails closed on unsupported versions, algorithms, or empty material', async () => {
    const record = await hashPassword('pw');
    await expect(verifyPassword('pw', { ...record, version: 99 })).resolves.toBe(false);
    await expect(verifyPassword('pw', { ...record, algorithm: 'argon2i' })).resolves.toBe(false);
    await expect(verifyPassword('pw', { ...record, hashBase64: '' })).resolves.toBe(false);
    await expect(verifyPassword('pw', { ...record, saltBase64: '' })).resolves.toBe(false);
  });

  it('uses only the async Node 26 argon2 API — never argon2Sync', async () => {
    const source = await readFile(sourcePath('password'), 'utf8');
    expect(source).not.toMatch(/argon2Sync/);
    expect(source).toMatch(/argon2id/);
    expect(source).toMatch(/from 'node:crypto'/);
  });
});

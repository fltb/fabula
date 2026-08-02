import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackoffPolicy } from '../src/host/auth/backoff.js';
import {
  AUTH_FAILURE_MESSAGE,
  type AuthenticateResult,
  createAuthPersistence,
  LocalAuthService,
  NotOwnerAccountError,
  OwnerAlreadyExistsError,
} from '../src/host/auth/service.js';
import { createRealPersistence, type RealPersistenceHarness } from './helpers/real-persistence.js';

const TINY_BACKOFF: BackoffPolicy = { initialDelayMs: 10, factor: 2, maxDelayMs: 1000 };

describe('LocalAuthService over the real persistence worker', () => {
  let harness: RealPersistenceHarness;
  let now: number;
  let service: LocalAuthService;

  beforeEach(() => {
    harness = createRealPersistence();
    now = 1_700_000_000_000;
    service = new LocalAuthService({
      persistence: createAuthPersistence(harness.client),
      now: () => now,
      newId: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
      backoff: TINY_BACKOFF,
      sessionTtlMs: 60_000,
      inviteTtlMs: 60_000,
    });
  });

  afterEach(() => {
    harness.dispose();
  });

  it('bootstraps the owner once and closes the bootstrap path afterwards', async () => {
    await expect(service.getAuthState()).resolves.toEqual({ ownerExists: false });
    const result = await service.bootstrapOwner({
      password: 'owner-password',
      displayName: 'Owner',
    });
    expect(result.user.role).toBe('owner');
    expect(result.session.userId).toBe(result.user.userId);
    expect(result.session.capabilityVersion).toBe(1);
    await expect(service.getAuthState()).resolves.toEqual({ ownerExists: true });
    await expect(service.bootstrapOwner({ password: 'second' })).rejects.toBeInstanceOf(
      OwnerAlreadyExistsError,
    );
  });

  it('returns a uniform failure for unknown users and wrong passwords', async () => {
    const owner = await service.bootstrapOwner({ password: 'owner-password' });
    const unknown = await service.authenticate({ userId: 'does-not-exist', password: 'anything' });
    const wrong = await service.authenticate({ userId: owner.user.userId, password: 'wrong' });
    expect(unknown.ok).toBe(false);
    expect(wrong.ok).toBe(false);
    if (unknown.ok || wrong.ok) throw new Error('expected failures');
    expect(unknown.failure).toEqual(wrong.failure);
    expect(unknown.failure.code).toBe('AUTH_FAILED');
    expect(unknown.failure.message).toBe(AUTH_FAILURE_MESSAGE);
    expect(unknown.failure.retryable).toBe(true);
  });

  it('accumulates persisted incremental backoff and locks the subject', async () => {
    const owner = await service.bootstrapOwner({ password: 'owner-password' });
    const userId = owner.user.userId;
    const failures: AuthenticateResult[] = [];
    // Spacing each attempt past the previous lock window keeps the count
    // accumulating: delay(1)=10ms, delay(2)=20ms, delay(3)=40ms, delay(4)=80ms.
    for (let i = 1; i <= 4; i++) {
      now += 100;
      failures.push(await service.authenticate({ userId, password: 'wrong' }));
    }
    for (const failure of failures) {
      expect(failure.ok).toBe(false);
    }
    // Fourth failure locked the subject: delay(4) = 10 * 2^3 = 80ms.
    const locked = failures[3];
    if (locked.ok) throw new Error('expected failure');
    expect(locked.failure.retryAfterMs).toBe(80);
    expect(locked.failure.lockedUntil).toBe(new Date(now + 80).toISOString());
    const backoff = await harness.client.request('loadAuthBackoff', { subject: `user:${userId}` });
    expect(backoff).toEqual({
      subject: `user:${userId}`,
      failures: 4,
      updatedAt: new Date(now).toISOString(),
    });

    // Locked attempts fail fast with the same uniform failure and do not extend the count.
    now += 10;
    const during = await service.authenticate({ userId, password: 'still-wrong' });
    if (during.ok) throw new Error('expected failure');
    expect(during.failure.retryAfterMs).toBe(70);
    await expect(
      harness.client.request('loadAuthBackoff', { subject: `user:${userId}` }),
    ).resolves.toMatchObject({ failures: 4 });

    // A second service instance over the same database still sees the lock (persisted backoff).
    const secondService = new LocalAuthService({
      persistence: createAuthPersistence(harness.client),
      now: () => now,
      newId: () => 'other-id',
      backoff: TINY_BACKOFF,
    });
    const persisted = await secondService.authenticate({ userId, password: 'wrong' });
    if (persisted.ok) throw new Error('expected failure');
    expect(persisted.failure.retryAfterMs).toBe(70);

    // Once the window passes, the correct password succeeds and clears the backoff.
    now += 200;
    const success = await service.authenticate({ userId, password: 'owner-password' });
    expect(success.ok).toBe(true);
    await expect(
      harness.client.request('loadAuthBackoff', { subject: `user:${userId}` }),
    ).resolves.toBeNull();
  });

  it('creates multiple independent sessions and revokes them individually', async () => {
    const owner = await service.bootstrapOwner({ password: 'owner-password' });
    const first = await service.authenticate({
      userId: owner.user.userId,
      password: 'owner-password',
    });
    const second = await service.authenticate({
      userId: owner.user.userId,
      password: 'owner-password',
    });
    if (!first.ok || !second.ok) throw new Error('expected successes');
    expect(first.session.sessionId).not.toBe(second.session.sessionId);
    await expect(service.getSession(first.session.sessionId)).resolves.toEqual(first.session);
    await expect(service.getSession(second.session.sessionId)).resolves.toEqual(second.session);
    await service.revokeSession(first.session.sessionId);
    await expect(service.getSession(first.session.sessionId)).resolves.toBeNull();
    await expect(service.getSession(second.session.sessionId)).resolves.toEqual(second.session);
  });

  it('enforces single-use and expiry on invites', async () => {
    const owner = await service.bootstrapOwner({ password: 'owner-password' });
    expect(owner.user.role).toBe('owner');

    const invite = await service.createInvite({ ttlMs: 1000 });
    now += 100;
    const accepted = await service.acceptInvite({
      inviteId: invite.inviteId,
      password: 'invited-password',
    });
    expect(accepted.status).toBe('accepted');
    if (accepted.status !== 'accepted') throw new Error('expected accepted');
    expect(accepted.user.role).toBe('user');
    expect(accepted.session.userId).toBe(accepted.user.userId);

    // Second consumption of the same invite is rejected atomically.
    const reused = await service.acceptInvite({ inviteId: invite.inviteId, password: 'another' });
    expect(reused.status).toBe('already-consumed');

    // Expired invite.
    const short = await service.createInvite({ ttlMs: 100 });
    now += 500;
    const expired = await service.acceptInvite({ inviteId: short.inviteId, password: 'x' });
    expect(expired.status).toBe('expired');

    const missing = await service.acceptInvite({ inviteId: 'no-such-invite', password: 'x' });
    expect(missing.status).toBe('not-found');
  });

  it('keeps an invite usable when atomic user creation fails', async () => {
    const owner = await service.bootstrapOwner({ password: 'owner-password' });
    const invite = await service.createInvite();
    const collidingService = new LocalAuthService({
      persistence: createAuthPersistence(harness.client),
      now: () => now,
      newId: () => owner.user.userId,
      backoff: TINY_BACKOFF,
    });

    await expect(
      collidingService.acceptInvite({ inviteId: invite.inviteId, password: 'invited-password' }),
    ).rejects.toMatchObject({ retryable: false });

    await expect(
      service.acceptInvite({ inviteId: invite.inviteId, password: 'invited-password' }),
    ).resolves.toMatchObject({ status: 'accepted' });
  });

  it("resets the owner password and revokes that owner's sessions and capabilities", async () => {
    const owner = await service.bootstrapOwner({ password: 'owner-password' });
    const first = await service.authenticate({
      userId: owner.user.userId,
      password: 'owner-password',
    });
    const second = await service.authenticate({
      userId: owner.user.userId,
      password: 'owner-password',
    });
    if (!first.ok || !second.ok) throw new Error('expected successes');

    const capability = await harness.client.request('upsertCapability', {
      capabilityId: 'cap-1',
      userId: owner.user.userId,
      projectId: 'proj-1',
      scope: ['project:read'],
      version: 1,
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    expect(capability.capabilityId).toBe('cap-1');
    const reset = await service.resetOwnerPassword({
      userId: owner.user.userId,
      newPassword: 'fresh-password',
    });
    expect(reset.revokedSessions).toBe(3);
    expect(reset.revokedCapabilities).toBe(1);
    expect(reset.user.capabilityVersion).toBe(2);

    // Sessions are gone, capability is revoked.
    await expect(service.getSession(first.session.sessionId)).resolves.toBeNull();
    await expect(service.getSession(second.session.sessionId)).resolves.toBeNull();
    const revoked = await harness.client.request('loadCapability', { capabilityId: 'cap-1' });
    expect(revoked?.revokedAt).toBeTruthy();

    // Old password no longer works; the new one does, with the bumped capability version.
    const oldAttempt = await service.authenticate({
      userId: owner.user.userId,
      password: 'owner-password',
    });
    expect(oldAttempt.ok).toBe(false);
    now += 200;
    const newLogin = await service.authenticate({
      userId: owner.user.userId,
      password: 'fresh-password',
    });
    expect(newLogin.ok).toBe(true);
    if (newLogin.ok) expect(newLogin.session.capabilityVersion).toBe(2);
  });

  it('only permits resetting the owner account', async () => {
    const owner = await service.bootstrapOwner({ password: 'owner-password' });
    const invite = await service.createInvite();
    const accepted = await service.acceptInvite({
      inviteId: invite.inviteId,
      password: 'user-password',
    });
    if (accepted.status !== 'accepted') throw new Error('expected accepted');
    await expect(
      service.resetOwnerPassword({ userId: accepted.user.userId, newPassword: 'x' }),
    ).rejects.toBeInstanceOf(NotOwnerAccountError);
    await expect(
      service.resetOwnerPassword({ userId: owner.user.userId, newPassword: 'x' }),
    ).resolves.toMatchObject({ revokedSessions: 1 });
  });
});

describe('host auth boundaries', () => {
  const srcDir = fileURLToPath(new URL('../src', import.meta.url));

  it('keeps the auth service free of sync argon2 and database access', async () => {
    for (const name of await readdir(fileURLToPath(new URL('../src/host/auth', import.meta.url)))) {
      const source = await readFile(
        `${fileURLToPath(new URL('../src/host/auth', import.meta.url))}/${name}`,
        'utf8',
      );
      expect(source, name).not.toMatch(/argon2Sync/);
      expect(source, name).not.toMatch(/DatabaseSync|node:sqlite|kysely/);
      expect(source, name).not.toMatch(/from 'node:sqlite'/);
    }
  });

  it('confines the database driver to the persistence worker', async () => {
    const files = await readdir(srcDir, { recursive: true });
    const offenders: string[] = [];
    for (const name of files) {
      if (!String(name).endsWith('.ts')) continue;
      const source = await readFile(`${srcDir}/${name}`, 'utf8');
      if (source.includes('node:sqlite') || source.includes('DatabaseSync'))
        offenders.push(String(name));
    }
    expect(offenders).toEqual(['persistence/worker.ts']);
  });

  it('keeps client code clear of auth and persistence imports', async () => {
    const clientDir = fileURLToPath(new URL('../src/client', import.meta.url));
    const files = await readdir(clientDir, { recursive: true });
    for (const name of files) {
      if (!String(name).endsWith('.ts') && !String(name).endsWith('.tsx')) continue;
      const source = await readFile(`${clientDir}/${name}`, 'utf8');
      expect(source, String(name)).not.toMatch(/host\/auth|persistence/);
    }
  });

  it('does not expose password hash records through the browser contract barrel', async () => {
    const barrel = await readFile(
      fileURLToPath(new URL('../src/contracts/index.ts', import.meta.url)),
      'utf8',
    );
    expect(barrel).not.toMatch(
      /PasswordHashRecord|PersistencePayloads|PersistenceResults|PersistenceOperation/,
    );
  });
});

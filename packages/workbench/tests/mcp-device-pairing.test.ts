import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  AgentCapabilityService,
  createCapabilityPersistence,
} from '../src/host/agent/index.js';
import {
  createDeviceVerifierPersistence,
  createMcpDevicePairingService,
  DEVICE_CREDENTIAL_PREFIX,
  DevicePairingInputError,
  MAX_DEVICE_TTL_MS,
  type McpDevicePairingService,
  sha256,
} from '../src/host/mcp/index.js';
import { createRealPersistence, type RealPersistenceHarness } from './helpers/real-persistence.js';

const OWNER = 'owner-1';

describe('McpDevicePairingService over the real persistence worker', () => {
  let harness: RealPersistenceHarness;
  let now: number;
  let devices: McpDevicePairingService;
  let deviceCounter = 0;

  beforeEach(() => {
    harness = createRealPersistence();
    now = Date.parse('2026-08-02T00:00:00.000Z');
    deviceCounter = 0;
    devices = createMcpDevicePairingService({
      persistence: createDeviceVerifierPersistence(harness.client),
      now: () => now,
      newId: () => `device-${++deviceCounter}`,
    });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('claims a pairing exactly once and returns a one-time opaque credential', async () => {
    const pairing = await devices.createPairing({
      ownerUserId: OWNER,
      kind: 'project',
      projectId: 'p1',
      role: 'reader',
    });
    expect(pairing.pairingCode).toMatch(/^wbp_[A-Za-z0-9_-]{32}$/);

    const claimed = await devices.claim({
      pairingCode: pairing.pairingCode,
      clientLabel: 'editor-laptop',
      scopes: ['mcp:read'],
      ttlMs: 60_000,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.credential).toMatch(/^wbd_[A-Za-z0-9_-]{43}$/);
    expect(claimed.credential).not.toContain(pairing.pairingCode);
    expect(claimed.device).toEqual({
      deviceId: 'device-1',
      kind: 'project',
      projectId: 'p1',
      ownerUserId: OWNER,
      scopes: ['mcp:read'],
      grantRevision: 1,
      expiresAt: new Date(now + 60_000).toISOString(),
      createdAt: new Date(now).toISOString(),
    });
    // The claim label is transient metadata, never part of the persisted DTO.
    expect(claimed.label).toBe('editor-laptop');
    // The safe view never carries the credential or its hash.
    expect(Object.keys(claimed.device)).not.toContain('tokenHash');
    expect(JSON.stringify(claimed.device)).not.toContain(claimed.credential);
    expect(JSON.stringify(claimed.device)).not.toContain(sha256(claimed.credential));

    // The code is single-use: a retry can never mint a second device.
    await expect(
      devices.claim({
        pairingCode: pairing.pairingCode,
        clientLabel: 'second-try',
        scopes: ['mcp:read'],
        ttlMs: 60_000,
      }),
    ).resolves.toEqual({ ok: false, code: 'PAIRING_NOT_FOUND' });
    expect(await devices.listDevices()).toHaveLength(1);
  });

  it('verifies the credential only for covered scopes and rejects unknown, revoked, and expired credentials', async () => {
    const pairing = await devices.createPairing({
      ownerUserId: OWNER,
      kind: 'project',
      projectId: 'p1',
      role: 'reader',
    });
    const claimed = await devices.claim({
      pairingCode: pairing.pairingCode,
      clientLabel: 'cli',
      scopes: ['mcp:read', 'mcp:render'],
      ttlMs: 60_000,
    });
    if (!claimed.ok) throw new Error('claim failed');

    await expect(
      devices.verifyCredential({
        credential: claimed.credential,
        scopes: ['mcp:read'],
        projectId: 'p1',
        route: 'project',
      }),
    ).resolves.toMatchObject({ ok: true, device: { deviceId: 'device-1' } });
    await expect(
      devices.verifyCredential({
        credential: claimed.credential,
        scopes: ['mcp:read', 'mcp:submit'],
        projectId: 'p1',
        route: 'project',
      }),
    ).resolves.toEqual({ ok: false, code: 'SCOPE_MISMATCH' });
    await expect(
      devices.verifyCredential({
        credential: 'wbd_unknown',
        scopes: ['mcp:read'],
        projectId: 'p1',
        route: 'project',
      }),
    ).resolves.toEqual({ ok: false, code: 'TOKEN_INVALID' });

    await devices.revoke('device-1');
    await expect(
      devices.verifyCredential({
        credential: claimed.credential,
        scopes: ['mcp:read'],
        projectId: 'p1',
        route: 'project',
      }),
    ).resolves.toEqual({ ok: false, code: 'TOKEN_REVOKED' });

    const expiring = await devices.createPairing({
      ownerUserId: OWNER,
      kind: 'project',
      projectId: 'p1',
      role: 'reader',
    });
    const short = await devices.claim({
      pairingCode: expiring.pairingCode,
      clientLabel: 'short-lived',
      scopes: ['mcp:read'],
      ttlMs: 1000,
    });
    if (!short.ok) throw new Error('claim failed');
    now += 1001;
    await expect(
      devices.verifyCredential({
        credential: short.credential,
        scopes: ['mcp:read'],
        projectId: 'p1',
        route: 'project',
      }),
    ).resolves.toEqual({ ok: false, code: 'TOKEN_EXPIRED' });
  });

  it('enforces least-scope pairing and rejects malformed claims without side effects', async () => {
    const pairing = await devices.createPairing({
      ownerUserId: OWNER,
      kind: 'project',
      projectId: 'p1',
      role: 'reader',
    });

    // Unknown scopes, empty scopes, over-long labels, and unbounded lifetimes fail closed.
    await expect(
      devices.claim({
        pairingCode: pairing.pairingCode,
        clientLabel: 'cli',
        scopes: ['mcp:filesystem'],
        ttlMs: 60_000,
      }),
    ).resolves.toEqual({ ok: false, code: 'SCOPE_INVALID' });
    await expect(
      devices.claim({ pairingCode: pairing.pairingCode, clientLabel: 'cli', scopes: [], ttlMs: 60_000 }),
    ).resolves.toEqual({ ok: false, code: 'INVALID_INPUT' });
    await expect(
      devices.claim({ pairingCode: pairing.pairingCode, clientLabel: '  ', scopes: ['mcp:read'], ttlMs: 60_000 }),
    ).resolves.toEqual({ ok: false, code: 'INVALID_INPUT' });
    await expect(
      devices.claim({
        pairingCode: pairing.pairingCode,
        clientLabel: 'cli',
        scopes: ['mcp:read'],
        ttlMs: MAX_DEVICE_TTL_MS + 1,
      }),
    ).resolves.toEqual({ ok: false, code: 'INVALID_INPUT' });
    // Malformed unknown fields never reach the store.
    await expect(
      devices.claim({
        pairingCode: pairing.pairingCode,
        clientLabel: 'cli',
        scopes: ['mcp:read'],
        ttlMs: 60_000,
        actorId: 'attacker',
      } as never),
    ).resolves.toEqual({ ok: false, code: 'INVALID_INPUT' });

    // The code is still claimable with a valid request; nothing above burned it.
    const claimed = await devices.claim({
      pairingCode: pairing.pairingCode,
      clientLabel: 'cli',
      scopes: ['mcp:read', 'mcp:read', 'mcp:render'],
      ttlMs: 60_000,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    // Scopes are deduplicated into a stable least-scope set.
    expect(claimed.device.scopes).toEqual(['mcp:read', 'mcp:render']);
  });

  it('only the owner may pair, and owner pairings may carry mcp:admin', async () => {
    await expect(
      devices.createPairing({
        ownerUserId: '',
        kind: 'project',
        projectId: 'p1',
        role: 'reader',
      }),
    ).rejects.toBeInstanceOf(DevicePairingInputError);
    await expect(
      devices.createPairing({
        ownerUserId: OWNER,
        kind: 'project',
        projectId: 'p1',
        role: 'reader',
        ttlMs: 0,
      }),
    ).rejects.toBeInstanceOf(DevicePairingInputError);
    await expect(
      devices.createPairing({
        ownerUserId: OWNER,
        kind: 'project',
        projectId: 'p1',
        role: 'admin',
        ttlMs: 60_000,
      } as never),
    ).rejects.toBeInstanceOf(DevicePairingInputError);

    const pairing = await devices.createPairing({
      ownerUserId: OWNER,
      kind: 'admin',
    });
    const claimed = await devices.claim({
      pairingCode: pairing.pairingCode,
      clientLabel: 'owner-mcp',
      scopes: ['mcp:admin'],
      ttlMs: 60_000,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    await expect(
      devices.verifyCredential({
        credential: claimed.credential,
        scopes: ['mcp:admin'],
        route: 'admin',
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      devices.verifyCredential({
        credential: claimed.credential,
        scopes: ['mcp:admin'],
        projectId: 'p1',
        route: 'project',
      }),
    ).resolves.toEqual({ ok: false, code: 'ADMIN_ROUTE_REQUIRED' });
    // mcp:admin can never substitute for author or submit scopes.
    await expect(
      devices.verifyCredential({
        credential: claimed.credential,
        scopes: ['mcp:submit'],
        route: 'admin',
      }),
    ).resolves.toEqual({ ok: false, code: 'ADMIN_ROUTE_REQUIRED' });
  });

  it('expires unclaimed pairing codes without creating a verifier', async () => {
    const pairing = await devices.createPairing({
      ownerUserId: OWNER,
      kind: 'project',
      projectId: 'p1',
      role: 'reader',
      ttlMs: 1000,
    });
    now += 1001;
    await expect(
      devices.claim({
        pairingCode: pairing.pairingCode,
        clientLabel: 'late',
        scopes: ['mcp:read'],
        ttlMs: 60_000,
      }),
    ).resolves.toEqual({ ok: false, code: 'PAIRING_EXPIRED' });
    expect(await devices.listDevices()).toEqual([]);
  });

  it('survives a Host restart for issued devices while burning unclaimed pairing codes', async () => {
    const pairing = await devices.createPairing({
      ownerUserId: OWNER,
      kind: 'project',
      projectId: 'p1',
      role: 'author',
    });
    const claimed = await devices.claim({
      pairingCode: pairing.pairingCode,
      clientLabel: 'restart-safe',
      scopes: ['mcp:read', 'mcp:author'],
      ttlMs: 60_000,
    });
    if (!claimed.ok) throw new Error('claim failed');
    const pending = await devices.createPairing({
      ownerUserId: OWNER,
      kind: 'project',
      projectId: 'p1',
      role: 'reader',
    });

    await harness.dispose();
    harness = createRealPersistence(harness.databasePath);
    deviceCounter = 1000;
    const restarted = createMcpDevicePairingService({
      persistence: createDeviceVerifierPersistence(harness.client),
      now: () => now,
      newId: () => `device-${++deviceCounter}`,
    });

    // The issued credential verifies from the durable hash-only row alone.
    await expect(
      restarted.verifyCredential({
        credential: claimed.credential,
        scopes: ['mcp:author'],
        projectId: 'p1',
        route: 'project',
      }),
    ).resolves.toMatchObject({ ok: true, device: { deviceId: 'device-1' } });
    const listed = await restarted.listDevices();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(claimed.credential);

    // Pending pairing codes are process-held: a restart burns a code issued
    // before the restart without affecting the durable credential above.
    await expect(
      restarted.claim({
        pairingCode: pending.pairingCode,
        clientLabel: 'pre-restart-code',
        scopes: ['mcp:read'],
        ttlMs: 60_000,
      }),
    ).resolves.toEqual({ ok: false, code: 'PAIRING_NOT_FOUND' });
  });

  it('never cross-accepts capability digests as device credentials or vice versa', async () => {
    const capabilities = new AgentCapabilityService({
      persistence: createCapabilityPersistence(harness.client),
      now: () => now,
    });
    const { token } = await capabilities.issue({
      userId: OWNER,
      projectId: 'p1',
      scopes: ['edit:prose'],
    });
    // A capability token is not a device credential...
    await expect(
      devices.verifyCredential({
        credential: token,
        scopes: ['mcp:read'],
        projectId: 'p1',
        route: 'project',
      }),
    ).resolves.toEqual({ ok: false, code: 'TOKEN_INVALID' });
    // ...and capability rows never surface in device listings.
    expect(await devices.listDevices()).toEqual([]);

    const pairing = await devices.createPairing({
      ownerUserId: OWNER,
      kind: 'project',
      projectId: 'p1',
      role: 'reader',
    });
    const claimed = await devices.claim({
      pairingCode: pairing.pairingCode,
      clientLabel: 'cli',
      scopes: ['mcp:read'],
      ttlMs: 60_000,
    });
    if (!claimed.ok) throw new Error('claim failed');
    // A device credential is not a capability token.
    await expect(
      capabilities.validate({ token: claimed.credential, projectId: 'p1', scopes: ['edit:prose'] }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: 'INVALID_TOKEN' },
    });
    // The verifier row stores only the SHA-256 hash of the credential.
    const stored = await harness.client.request('loadDeviceVerifierByTokenHash', {
      tokenHash: createHash('sha256').update(claimed.credential, 'utf8').digest('hex'),
      store: 'mcp',
    });
    expect(stored).toEqual({
      deviceId: 'device-1',
      kind: 'project',
      projectId: 'p1',
      ownerUserId: OWNER,
      scopes: ['mcp:read'],
      grantRevision: 1,
      expiresAt: new Date(now + 60_000).toISOString(),
      createdAt: new Date(now).toISOString(),
    });
    expect(Object.keys(stored ?? {})).not.toContain('tokenHash');
    expect(Object.keys(stored ?? {})).not.toContain('clientLabel');
    expect(Object.keys(stored ?? {})).not.toContain('role');
    expect(JSON.stringify(stored)).not.toContain(claimed.credential);
  });
});

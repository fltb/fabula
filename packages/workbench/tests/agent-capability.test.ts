import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CapabilityState } from '../src/contracts/persistence.js';
import {
  AgentCapabilityService,
  buildAuditEffect,
  CapabilityInputError,
  type CheckCapabilityInput,
  createCapabilityPersistence,
  DEFAULT_CAPABILITY_TTL_MS,
  type IssueCapabilityInput,
  type ValidateCapabilityInput,
} from '../src/host/agent/index.js';
import { createRealPersistence, type RealPersistenceHarness } from './helpers/real-persistence.js';

describe('AgentCapabilityService over the real persistence worker', () => {
  let harness: RealPersistenceHarness;
  let now: number;
  let service: AgentCapabilityService;

  beforeEach(() => {
    harness = createRealPersistence();
    now = Date.parse('2026-08-02T00:00:00.000Z');
    service = new AgentCapabilityService({
      persistence: createCapabilityPersistence(harness.client),
      now: () => now,
    });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('issues an opaque grant bound to actor/project/scope/version/expiry and validates it', async () => {
    const { token, grant } = await service.issue({
      userId: 'u1',
      projectId: 'p1',
      scopes: ['edit:prose'],
      ttlMs: 60_000,
    });
    expect(token).toMatch(/^fc_[A-Za-z0-9_-]{43}$/);
    expect(grant).toEqual({
      capabilityId: expect.any(String),
      userId: 'u1',
      projectId: 'p1',
      scopes: ['edit:prose'],
      version: 1,
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    // The token is opaque: it never embeds the capability id.
    expect(token).not.toContain(grant.capabilityId);

    const result = await service.validate({ token, projectId: 'p1', scopes: ['edit:prose'] });
    expect(result).toEqual({ ok: true, grant });
  });

  it('uses the default ttl when none is given', async () => {
    const { grant } = await service.issue({
      userId: 'u1',
      projectId: 'p1',
      scopes: ['edit:prose'],
    });
    expect(grant.expiresAt).toBe(new Date(now + DEFAULT_CAPABILITY_TTL_MS).toISOString());
  });

  it('rejects tokens presented for the wrong project or uncovered scopes', async () => {
    const { token } = await service.issue({
      userId: 'u1',
      projectId: 'p1',
      scopes: ['edit:prose'],
    });
    await expect(
      service.validate({ token, projectId: 'p2', scopes: ['edit:prose'] }),
    ).resolves.toEqual({
      ok: false,
      failure: { code: 'PROJECT_MISMATCH', message: expect.any(String) },
    });
    await expect(
      service.validate({ token, projectId: 'p1', scopes: ['render:novel'] }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: 'SCOPE_MISMATCH' },
    });
    // A request mixing a covered and an uncovered scope also fails.
    await expect(
      service.validate({ token, projectId: 'p1', scopes: ['edit:prose', 'render:novel'] }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: 'SCOPE_MISMATCH' },
    });
  });

  it('fails capabilities past their expiry', async () => {
    const { token } = await service.issue({
      userId: 'u1',
      projectId: 'p1',
      scopes: ['edit:prose'],
      ttlMs: 1000,
    });
    now += 1001;
    await expect(
      service.validate({ token, projectId: 'p1', scopes: ['edit:prose'] }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: 'EXPIRED' },
    });
  });

  it('fails capabilities revoked through the persistence layer and through the service', async () => {
    const direct = await service.issue({ userId: 'u1', projectId: 'p1', scopes: ['edit:prose'] });
    await harness.client.request('revokeCapability', { capabilityId: direct.grant.capabilityId });
    await expect(
      service.validate({ token: direct.token, projectId: 'p1', scopes: ['edit:prose'] }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: 'REVOKED' },
    });
    await expect(
      service.checkGrant({
        capabilityId: direct.grant.capabilityId,
        projectId: 'p1',
        scopes: ['edit:prose'],
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: 'REVOKED',
    });

    const viaService = await service.issue({
      userId: 'u1',
      projectId: 'p1',
      scopes: ['edit:prose'],
    });
    await service.revoke(viaService.grant.capabilityId, 'owner decision');
    await expect(
      service.validate({ token: viaService.token, projectId: 'p1', scopes: ['edit:prose'] }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: 'REVOKED' },
    });
  });

  it('fails when the persisted capability version no longer matches the issued grant', async () => {
    const { token, grant } = await service.issue({
      userId: 'u1',
      projectId: 'p1',
      scopes: ['edit:prose'],
    });
    const bumped: CapabilityState = {
      capabilityId: grant.capabilityId,
      userId: grant.userId,
      projectId: grant.projectId,
      scope: [...grant.scopes],
      version: 2,
      expiresAt: grant.expiresAt,
    };
    await harness.client.request('upsertCapability', bumped);

    await expect(
      service.validate({ token, projectId: 'p1', scopes: ['edit:prose'] }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: 'VERSION_MISMATCH' },
    });
    // The server-side gate also honors an expected-version binding.
    await expect(
      service.checkGrant({
        capabilityId: grant.capabilityId,
        projectId: 'p1',
        scopes: ['edit:prose'],
        expectedVersion: 1,
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: 'VERSION_MISMATCH',
    });
  });

  it('cannot forge, guess, or derive tokens', async () => {
    const a = await service.issue({ userId: 'u1', projectId: 'p1', scopes: ['edit:prose'] });
    const b = await service.issue({ userId: 'u1', projectId: 'p1', scopes: ['edit:prose'] });
    expect(a.token).not.toBe(b.token);
    expect(a.grant.capabilityId).not.toBe(b.grant.capabilityId);

    // An unknown token is rejected.
    await expect(
      service.validate({ token: `fc_${'A'.repeat(43)}`, projectId: 'p1', scopes: ['edit:prose'] }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: 'INVALID_TOKEN' },
    });
    // Flipping one character of a valid token breaks the digest match.
    const flipped = a.token.slice(0, -1) + (a.token.endsWith('A') ? 'B' : 'A');
    await expect(
      service.validate({ token: flipped, projectId: 'p1', scopes: ['edit:prose'] }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: 'INVALID_TOKEN' },
    });

    // The raw token never reaches persistence or the safe projection.
    const row = await harness.client.request('loadCapability', {
      capabilityId: a.grant.capabilityId,
    });
    expect(JSON.stringify(row)).not.toContain(a.token);
    expect(JSON.stringify(a.grant)).not.toContain(a.token);
  });

  it('rejects client-provided actor and permission fields before any side effect', async () => {
    const issueInput = (extra: Record<string, unknown>): IssueCapabilityInput =>
      ({ userId: 'u1', projectId: 'p1', scopes: ['edit:prose'], ...extra }) as IssueCapabilityInput;
    await expect(service.issue(issueInput({ actorId: 'u2' }))).rejects.toBeInstanceOf(
      CapabilityInputError,
    );
    await expect(service.issue(issueInput({ permissions: ['admin'] }))).rejects.toBeInstanceOf(
      CapabilityInputError,
    );
    await expect(service.issue(issueInput({ role: 'owner' }))).rejects.toBeInstanceOf(
      CapabilityInputError,
    );

    const { token } = await service.issue({
      userId: 'u1',
      projectId: 'p1',
      scopes: ['edit:prose'],
    });
    const validateInput = (extra: Record<string, unknown>): ValidateCapabilityInput =>
      ({ token, projectId: 'p1', scopes: ['edit:prose'], ...extra }) as ValidateCapabilityInput;
    await expect(service.validate(validateInput({ actorId: 'u2' }))).rejects.toBeInstanceOf(
      CapabilityInputError,
    );

    const checkInput = (extra: Record<string, unknown>): CheckCapabilityInput =>
      ({
        capabilityId: 'c1',
        projectId: 'p1',
        scopes: ['edit:prose'],
        ...extra,
      }) as CheckCapabilityInput;
    await expect(service.checkGrant(checkInput({ permissions: ['admin'] }))).rejects.toBeInstanceOf(
      CapabilityInputError,
    );

    // Malformed grants are rejected before any grant can be issued.
    await expect(
      service.issue({ userId: 'u1', projectId: 'p1', scopes: [], ttlMs: 1000 }),
    ).rejects.toBeInstanceOf(CapabilityInputError);
    await expect(
      service.issue({ userId: 'u1', projectId: 'p1', scopes: ['edit:prose'], ttlMs: 0 }),
    ).rejects.toBeInstanceOf(CapabilityInputError);
  });

  it('gates server-side effects by current persisted state without a token', async () => {
    const { grant } = await service.issue({
      userId: 'u1',
      projectId: 'p1',
      scopes: ['edit:prose', 'edit:yaml'],
      ttlMs: 1000,
    });
    await expect(
      service.checkGrant({
        capabilityId: grant.capabilityId,
        projectId: 'p1',
        scopes: ['edit:yaml'],
        expectedVersion: 1,
      }),
    ).resolves.toEqual({
      allowed: true,
      grant,
    });
    await expect(
      service.checkGrant({
        capabilityId: grant.capabilityId,
        projectId: 'p2',
        scopes: ['edit:yaml'],
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: 'PROJECT_MISMATCH',
    });
    await expect(
      service.checkGrant({
        capabilityId: grant.capabilityId,
        projectId: 'p1',
        scopes: ['render:novel'],
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: 'SCOPE_MISMATCH',
    });
    now += 1001;
    await expect(
      service.checkGrant({
        capabilityId: grant.capabilityId,
        projectId: 'p1',
        scopes: ['edit:prose'],
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: 'EXPIRED',
    });
  });

  it('keeps outstanding tokens valid across a Host restart through the durable hash-only verifier store', async () => {
    const { token, grant } = await service.issue({
      userId: 'u1',
      projectId: 'p1',
      scopes: ['edit:prose'],
    });
    // The digest registry is durable: a fresh service over the same store
    // (a Host restart) still resolves the token by its SHA-256 hash.
    const restarted = new AgentCapabilityService({
      persistence: createCapabilityPersistence(harness.client),
      now: () => now,
    });
    await expect(
      restarted.validate({ token, projectId: 'p1', scopes: ['edit:prose'] }),
    ).resolves.toEqual({ ok: true, grant });

    // The verifier row is hash-only: no read result ever contains the raw
    // token, its digest, or the binding key it is stored under.
    const rows = await harness.client.request('listDeviceVerifiers', { store: 'capability' });
    const capabilityRows = rows.filter((row) => row.deviceId.startsWith('capability:'));
    expect(capabilityRows).toHaveLength(1);
    expect(capabilityRows[0].deviceId).toBe(`capability:${grant.capabilityId}:v1`);
    expect(JSON.stringify(capabilityRows[0])).not.toContain(token);
    expect(Object.keys(capabilityRows[0])).not.toContain('tokenHash');
    // The stored digest itself is never returned either (sha256 of the token).
    const digest = createHash('sha256').update(token, 'utf8').digest('hex');
    expect(JSON.stringify(capabilityRows[0])).not.toContain(digest);
    const byHash = await harness.client.request('loadDeviceVerifierByTokenHash', {
      tokenHash: digest,
      store: 'capability',
    });
    expect(Object.keys(byHash ?? {})).not.toContain('tokenHash');
    expect(JSON.stringify(byHash)).not.toContain(token);
  });

  it('builds equivalent secret-free audit metadata from a validated grant', async () => {
    const { token, grant } = await service.issue({
      userId: 'u1',
      projectId: 'p1',
      scopes: ['edit:prose'],
    });
    const validated = await service.validate({ token, projectId: 'p1', scopes: ['edit:prose'] });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const at = '2026-08-02T00:01:00.000Z';
    const first = buildAuditEffect({
      grant: validated.grant,
      kind: 'yjs-update',
      detail: 'clock=42;diff=+2',
      at,
    });
    const second = buildAuditEffect({
      grant: validated.grant,
      kind: 'yjs-update',
      detail: 'clock=42;diff=+2',
      at,
    });
    expect(second).toEqual(first);
    expect(first).toEqual({
      capabilityId: grant.capabilityId,
      actorId: 'u1',
      projectId: 'p1',
      scopes: ['edit:prose'],
      version: 1,
      kind: 'yjs-update',
      detail: 'clock=42;diff=+2',
      at,
    });
    // Typed audit metadata carries no token, digest, or persistence internals.
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain(token);
    expect(Object.keys(first)).not.toContain('token');
    expect(serialized).not.toMatch(/digest|sql|database|secret/);
  });
});

describe('host agent capability boundaries', () => {
  const agentDir = fileURLToPath(new URL('../src/host/agent', import.meta.url));

  it('keeps the capability boundary free of database and sync-secret imports', async () => {
    for (const name of await readdir(agentDir)) {
      const source = await readFile(`${agentDir}/${name}`, 'utf8');
      expect(source, name).not.toMatch(/DatabaseSync|node:sqlite|kysely|argon2Sync/);
      expect(source, name).not.toMatch(/from 'node:sqlite'/);
    }
  });

  it('does not expose tokens, digests, or persistence internals through the browser contract barrel', async () => {
    const barrel = await readFile(
      fileURLToPath(new URL('../src/contracts/index.ts', import.meta.url)),
      'utf8',
    );
    expect(barrel).not.toMatch(
      /CapabilityToken|TokenDigest|PersistencePayloads|PersistenceResults|PersistenceOperation|AgentCapabilityService/,
    );
  });
});

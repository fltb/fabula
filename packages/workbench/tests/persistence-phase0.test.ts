import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { persistenceSchema } from '../src/persistence/schema.js';
import { createWorkerDatabase, migrate } from '../src/persistence/worker.js';
import type { AuditRecord } from '../src/contracts/persistence.js';
import { createRealPersistence } from './helpers/real-persistence.js';

/** Re-applies ONLY the version-1 migration DDL, mirroring the worker's loop. */
function applyV1Only(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL);',
    );
    const v1 = persistenceSchema[0];
    if (!v1 || v1.version !== 1) throw new Error('V1 migration missing from persistence schema');
    for (const table of v1.tables) {
      const composite = table.primaryKey;
      const columns = table.columns
        .map(
          (column) =>
            `${column.name} ${column.type === 'integer' ? 'INTEGER' : column.type === 'blob' ? 'BLOB' : 'TEXT'}${column.nullable ? '' : ' NOT NULL'}${column.primaryKey && !composite ? ' PRIMARY KEY' : ''}`,
        )
        .join(', ');
      const primaryKeyClause =
        composite && composite.length > 0 ? `, PRIMARY KEY (${composite.join(', ')})` : '';
      db.exec(`CREATE TABLE IF NOT EXISTS ${table.name} (${columns}${primaryKeyClause})`);
    }
    db.prepare(
      'INSERT INTO schema_migrations(version, description, applied_at) VALUES (?, ?, ?)',
    ).run(1, v1.description, '2026-01-01T00:00:00.000Z');
  } finally {
    db.close();
  }
}

describe('Phase 0 persistence contracts', () => {
  it('migrates a V1 database through V4 without losing any V1 rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fabula-phase0-v1-'));
    try {
      const databasePath = join(dir, 'workbench.sqlite');
      // Simulate a database created by the previous Host version: only the V1
      // migration applied, with real V1 rows on disk.
      applyV1Only(databasePath);
      const v1db = new DatabaseSync(databasePath);
      const passwordHash = JSON.stringify({
        version: 1,
        algorithm: 'argon2id',
        saltBase64: 'c2FsdA==',
        hashBase64: 'aGFzaA==',
        memory: 65536,
        passes: 3,
        parallelism: 1,
        tagLength: 32,
      });
      v1db
        .prepare(
          'INSERT INTO users(user_id,role,display_name,password_hash,capability_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          'owner-1',
          'owner',
          'Owner',
          passwordHash,
          1,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        );
      v1db
        .prepare(
          "INSERT INTO yjs_documents(project_id,document_id,state_vector,document_update,updated_at) VALUES('p-1','d-1',X'01',X'02','2026-01-01T00:00:00.000Z')",
        )
        .run();
      v1db.close();

      // The real worker migration now upgrades the V1 database through V4.
      const db = createWorkerDatabase(databasePath);
      try {
        migrate(db);
        const versions = (
          db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
            version: number;
          }[]
        ).map((row) => row.version);
        expect(versions).toEqual([1, 2, 3, 4]);

        // V1 rows survive every later migration untouched.
        const user = db
          .prepare('SELECT * FROM users WHERE user_id=?')
          .get('owner-1') as Record<string, unknown> | undefined;
        expect(user?.role).toBe('owner');
        expect(user?.password_hash).toBe(passwordHash);
        const doc = db
          .prepare('SELECT * FROM yjs_documents WHERE project_id=? AND document_id=?')
          .get('p-1', 'd-1') as Record<string, unknown> | undefined;
        expect(doc).toBeDefined();
        expect(Buffer.from(doc?.document_update as Uint8Array).equals(Buffer.from([2]))).toBe(true);

        // V2–V4 tables exist.
        const tables = (
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all() as { name: string }[]
        ).map((row) => row.name);
        for (const table of [
          'configuration_operations',
          'authoring_state',
          'audit_log',
          'device_verifiers',
          'source_revisions',
          'project_memberships',
          'capability_verifiers',
          'mcp_device_verifiers',
        ]) {
          expect(tables).toContain(table);
        }
      } finally {
        await db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to migrate a database whose schema is newer than the bundled schema', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fabula-phase0-future-'));
    try {
      const databasePath = join(dir, 'workbench.sqlite');
      applyV1Only(databasePath);
      // Simulate a database already migrated by a FUTURE Host version: the
      // schema_migrations table is ahead of everything this build knows.
      const future = new DatabaseSync(databasePath);
      future
        .prepare(
          'INSERT INTO schema_migrations(version, description, applied_at) VALUES (?, ?, ?)',
        )
        .run(99, 'written by a future Host', '2027-01-01T00:00:00.000Z');
      future.close();

      const db = createWorkerDatabase(databasePath);
      try {
        let caught: unknown;
        try {
          migrate(db);
        } catch (error) {
          caught = error;
        }
        expect(caught).toMatchObject({
          code: 'SCHEMA_VERSION_TOO_NEW',
          retryable: false,
        });
        // Nothing was written: no migration rows, no new tables.
        const versions = (
          db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
            version: number;
          }[]
        ).map((row) => row.version);
        expect(versions).toEqual([1, 99]);
      } finally {
        await db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('boots a fresh database through migrations 1–4 in order', async () => {
    const harness = createRealPersistence();
    try {
      const db = new DatabaseSync(harness.databasePath, { readOnly: true });
      try {
        const versions = (
          db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
            version: number;
          }[]
        ).map((row) => row.version);
        expect(versions).toEqual([1, 2, 3, 4]);
        const capabilityDdl = db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='capability_verifiers'")
          .get() as { sql: string };
        expect(capabilityDdl.sql).toContain('token_hash');
        expect(capabilityDdl.sql).toContain('client_label');
        const mcpDdl = db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mcp_device_verifiers'")
          .get() as { sql: string };
        expect(mcpDdl.sql).toContain('verifier');
        expect(mcpDdl.sql).toContain('kind');
      } finally {
        db.close();
      }
    } finally {
      await harness.dispose();
    }
  });

  it('rejects unknown payload fields and unknown operations with typed failures', async () => {
    const harness = createRealPersistence();
    try {
      const client = harness.client as unknown as {
        request(operation: string, payload: unknown): Promise<unknown>;
      };
      // A payload with an undeclared field fails closed before any side effect.
      await expect(
        client.request('saveAuthoringState', {
          projectId: 'p-1',
          phase: 'clean',
          candidateValid: false,
          conflicts: [],
          updatedAt: '2026-01-01T00:00:00.000Z',
          unexpectedField: 'x',
        }),
      ).rejects.toMatchObject({ code: 'UNKNOWN_FIELD', retryable: false });
      // A payload for an operation that takes none also fails closed.
      await expect(client.request('getAuthState', { ownerUserId: 'owner-1' })).rejects.toMatchObject(
        { code: 'UNKNOWN_FIELD', retryable: false },
      );
      // Unknown operations remain a typed failure, never a bogus success.
      await expect(client.request('dropTable', { name: 'users' })).rejects.toMatchObject({
        code: 'UNKNOWN_OPERATION',
        retryable: false,
      });
      // The same operation with only declared fields still works.
      await expect(
        harness.client.request('saveAuthoringState', {
          projectId: 'p-1',
          phase: 'clean',
          candidateValid: false,
          conflicts: [],
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      ).resolves.toMatchObject({ projectId: 'p-1', phase: 'clean' });
    } finally {
      await harness.dispose();
    }
  });

  it('never exposes a device verifier token hash through any write or read result', async () => {
    const harness = createRealPersistence();
    try {
      const tokenHash = 'a'.repeat(64);
      const created = await harness.client.request('createDeviceVerifier', {
        store: 'capability',
        deviceId: 'dev-1',
        tokenHash,
        scope: ['mcp:author'],
        expiresAt: '2026-02-01T00:00:00.000Z',
        clientLabel: 'test-agent',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      expect('tokenHash' in created).toBe(false);
      expect(JSON.stringify(created)).not.toContain(tokenHash);
      expect(created).toEqual({
        deviceId: 'dev-1',
        scope: ['mcp:author'],
        expiresAt: '2026-02-01T00:00:00.000Z',
        clientLabel: 'test-agent',
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      const byHash = await harness.client.request('loadDeviceVerifierByTokenHash', {
        tokenHash,
        store: 'capability',
      });
      expect(byHash).not.toBeNull();
      expect('tokenHash' in (byHash ?? {})).toBe(false);
      expect(JSON.stringify(byHash)).not.toContain(tokenHash);

      const all = await harness.client.request('listDeviceVerifiers', { store: 'capability' });
      expect(all).toHaveLength(1);
      expect(JSON.stringify(all[0])).not.toContain(tokenHash);

      // Revocation is visible through the read view but still never leaks the hash.
      await harness.client.request('revokeDeviceVerifier', {
        deviceId: 'dev-1',
        revokedAt: '2026-01-02T00:00:00.000Z',
        store: 'capability',
      });
      const revoked = await harness.client.request('loadDeviceVerifierByTokenHash', {
        tokenHash,
        store: 'capability',
      });
      expect(revoked).toMatchObject({ revokedAt: '2026-01-02T00:00:00.000Z' });
      expect(JSON.stringify(revoked)).not.toContain(tokenHash);

      // Unknown hashes resolve to null; the raw credential itself never round-trips.
      await expect(
        harness.client.request('loadDeviceVerifierByTokenHash', {
          tokenHash: 'b'.repeat(64),
          store: 'capability',
        }),
      ).resolves.toBeNull();
      expect(
        JSON.stringify(await harness.client.request('listDeviceVerifiers', { store: 'capability' })),
      ).not.toContain(tokenHash);
    } finally {
      await harness.dispose();
    }
  });

  it('roundtrips configuration operations, append-only audit, authoring state, and session listing', async () => {
    const harness = createRealPersistence();
    try {
      // Configuration operation metadata round-trips with typed status/revisions.
      const record = {
        operationId: 'cfg-op-1',
        origin: 'setup',
        status: 'applied',
        activeRevision: 'rev-1',
        candidateRevision: 'rev-1',
        changedFields: ['network.port'],
        diagnostics: [{ code: 'OK', message: 'applied' }],
        actorId: 'owner-1',
        at: '2026-01-01T00:00:00.000Z',
      };
      await expect(harness.client.request('createConfigurationOperation', record)).resolves.toEqual(
        record,
      );
      await expect(
        harness.client.request('listConfigurationOperations', { limit: 10 }),
      ).resolves.toEqual([record]);

      // The audit log is append-only: a retried append with the same id
      // returns the stored row unchanged and never overwrites it.
      const audit: AuditRecord = {
        auditId: 'audit-1',
        at: '2026-01-01T00:00:00.000Z',
        actorId: 'owner-1',
        surface: 'submit',
        operationKind: 'submit',
        outcome: 'completed',
        projectId: 'p-1',
        workspaceDigest: 'digest-1',
        capabilityVersion: 1,
      };
      await expect(harness.client.request('appendAudit', audit)).resolves.toEqual(audit);
      await harness.client.request('appendAudit', { ...audit, at: '2026-01-02T00:00:00.000Z' });
      const listed = await harness.client.request('listAudit', { limit: 10 });
      expect(listed).toEqual([audit]);
      await expect(harness.client.request('listAudit', { limit: 10, surface: 'mcp' })).resolves.toEqual(
        [],
      );

      // Dashboard session listing.
      await harness.client.request('createSession', {
        sessionId: 's-1',
        userId: 'owner-1',
        expiresAt: '2026-02-01T00:00:00.000Z',
        capabilityVersion: 1,
      });
      await harness.client.request('createSession', {
        sessionId: 's-2',
        userId: 'user-1',
        expiresAt: '2026-02-01T00:00:00.000Z',
        capabilityVersion: 1,
      });
      await expect(harness.client.request('listSessions', { userId: 'owner-1' })).resolves.toEqual([
        expect.objectContaining({ sessionId: 's-1', userId: 'owner-1' }),
      ]);
      await expect(harness.client.request('listSessions', {})).resolves.toHaveLength(2);

      // Authoring coordinator metadata round-trips with hashes, conflicts and
      // Git identity — never source content.
      await harness.client.request('saveAuthoringState', {
        projectId: 'p-1',
        phase: 'working-dirty',
        acceptedSourceHash: 'source-1',
        workspaceDigest: 'digest-1',
        candidateHash: 'candidate-1',
        candidateValid: true,
        conflicts: [
          {
            logicalPath: 'nova.yaml',
            kind: 'working-vs-external',
            baseSourceHash: 'source-1',
            workingHash: 'work-1',
            externalHash: 'ext-1',
          },
        ],
        fixedGitHead: 'git-head-1',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      await expect(
        harness.client.request('loadAuthoringState', { projectId: 'p-1' }),
      ).resolves.toEqual({
        projectId: 'p-1',
        phase: 'working-dirty',
        acceptedSourceHash: 'source-1',
        workspaceDigest: 'digest-1',
        candidateHash: 'candidate-1',
        candidateValid: true,
        conflicts: [
          {
            logicalPath: 'nova.yaml',
            kind: 'working-vs-external',
            baseSourceHash: 'source-1',
            workingHash: 'work-1',
            externalHash: 'ext-1',
          },
        ],
        fixedGitHead: 'git-head-1',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      await expect(
        harness.client.request('loadAuthoringState', { projectId: 'p-2' }),
      ).resolves.toBeNull();

      // A stale unknown phase written by a previous Host version reads as
      // recovery-required instead of fabricating a known phase.
      await harness.client.request('saveAuthoringState', {
        projectId: 'p-1',
        phase: 'mystery-phase',
        candidateValid: false,
        conflicts: [],
        updatedAt: '2026-01-02T00:00:00.000Z',
      });
      await expect(
        harness.client.request('loadAuthoringState', { projectId: 'p-1' }),
      ).resolves.toMatchObject({ phase: 'recovery-required' });
    } finally {
      await harness.dispose();
    }
  });
});

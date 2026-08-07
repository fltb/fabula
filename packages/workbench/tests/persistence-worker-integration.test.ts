import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type {
  AgentConversationRecordV1,
  AgentRunRecordV1,
  AgentToolCallRecordV1,
  ProjectOperationRecordV1,
  ProjectOperationStatusV1,
  ProjectPublicationRecordV1,
} from '../src/contracts/persistence.js';
import {
  GIT_SUBMISSION_PHASE_COMPLETE,
  GIT_SUBMISSION_PHASE_CONFLICT,
} from '../src/contracts/persistence.js';
import { type AgentStore, createAgentStore } from '../src/persistence/agent-store.js';
import {
  createProjectOperationStore,
  type ProjectOperationStore,
} from '../src/persistence/project-operation-store.js';
import { createProjectPublicationStore } from '../src/persistence/project-publication-store.js';
import { createRealPersistence } from './helpers/real-persistence.js';

function rawRowCount(databasePath: string, sql: string): number {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Number((db.prepare(sql).get() as { count: number }).count);
  } finally {
    db.close();
  }
}

function yjsUpdate(text: string, label: string): { update: Uint8Array; stateVector: Uint8Array } {
  const doc = new Y.Doc();
  doc.getText(label).insert(0, text);
  return { update: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
}

describe('real persistence worker initialization', () => {
  it('boots the worker module, runs migrations, and creates the composite-key yjs_documents table', async () => {
    const harness = createRealPersistence();
    try {
      const db = new DatabaseSync(harness.databasePath, { readOnly: true });
      try {
        const migrations = db
          .prepare('SELECT version FROM schema_migrations ORDER BY version')
          .all() as { version: number }[];
        expect(migrations.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        const v2Tables = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('configuration_operations', 'authoring_state', 'audit_log', 'device_verifiers') ORDER BY name",
          )
          .all() as { name: string }[];
        expect(v2Tables.map((table) => table.name)).toEqual([
          'audit_log',
          'authoring_state',
          'configuration_operations',
          'device_verifiers',
        ]);
        const ddl = db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='yjs_documents'")
          .get() as { sql: string };
        expect(ddl.sql).toContain('PRIMARY KEY (project_id, document_id)');
        const operationsDdl = db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='project_operations'")
          .get() as { sql: string };
        expect(operationsDdl.sql).toContain('PRIMARY KEY (project_id, operation_id)');
        expect(operationsDdl.sql).toContain('idempotency_key');
        const publicationsDdl = db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='project_publications'",
          )
          .get() as { sql: string };
        expect(publicationsDdl.sql).toContain('PRIMARY KEY (project_id, publication_id)');
        expect(publicationsDdl.sql).toContain("CHECK (kind IN ('canonical', 'custom'))");
        expect(publicationsDdl.sql).toContain("CHECK (status IN ('current', 'stale'))");
        const publicationIndexes = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='project_publications' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as { name: string }[];
        expect(publicationIndexes.map((index) => index.name)).toEqual([
          'project_publications_updated',
        ]);
        const indexes = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='project_operations' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as { name: string }[];
        expect(indexes.map((index) => index.name)).toEqual([
          'project_operations_idempotency',
          'project_operations_status_updated',
        ]);
      } finally {
        db.close();
      }
    } finally {
      await harness.dispose();
    }
  });

  it('roundtrips real Yjs updates with a composite key and upserts without duplicates', async () => {
    const harness = createRealPersistence();
    try {
      const first = yjsUpdate('chapter one', 'prose');
      const saved = await harness.client.request('persistYjsUpdate', {
        projectId: 'proj-1',
        documentId: 'doc-1',
        update: first.update,
        stateVector: first.stateVector,
      });
      expect(Buffer.from(saved.update).equals(Buffer.from(first.update))).toBe(true);

      const loaded = await harness.client.request('loadWorkingDocument', {
        projectId: 'proj-1',
        documentId: 'doc-1',
      });
      expect(loaded).not.toBeNull();
      const doc = new Y.Doc();
      Y.applyUpdate(doc, loaded.update);
      expect(doc.getText('prose').toString()).toBe('chapter one');
      expect(Buffer.from(loaded.stateVector).equals(Buffer.from(first.stateVector))).toBe(true);

      // Upsert on the same composite key replaces, and a second document coexists.
      const second = yjsUpdate('chapter one v2', 'prose');
      await harness.client.request('persistYjsUpdate', {
        projectId: 'proj-1',
        documentId: 'doc-1',
        update: second.update,
      });
      await harness.client.request('persistYjsUpdate', {
        projectId: 'proj-1',
        documentId: 'doc-2',
        update: yjsUpdate('other', 'prose').update,
      });
      expect(rawRowCount(harness.databasePath, 'SELECT COUNT(*) AS count FROM yjs_documents')).toBe(
        2,
      );
      const reloaded = await harness.client.request('loadWorkingDocument', {
        projectId: 'proj-1',
        documentId: 'doc-1',
      });
      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, reloaded.update);
      expect(doc2.getText('prose').toString()).toBe('chapter one v2');
    } finally {
      await harness.dispose();
    }
  });

  it('recovers persisted Yjs state across a worker restart on the same database file', async () => {
    let harness = createRealPersistence();
    const { update, stateVector } = yjsUpdate('survives restart', 'prose');
    await harness.client.request('persistYjsUpdate', {
      projectId: 'proj-1',
      documentId: 'doc-1',
      update,
      stateVector,
    });
    const databasePath = harness.databasePath;
    // The worker disposer must release the DatabaseSync handle before the
    // same path is reopened by the restarted harness.
    await harness.dispose();
    harness = createRealPersistence(databasePath);

    try {
      const loaded = await harness.client.request('loadWorkingDocument', {
        projectId: 'proj-1',
        documentId: 'doc-1',
      });
      const doc = new Y.Doc();
      Y.applyUpdate(doc, loaded.update);
      expect(doc.getText('prose').toString()).toBe('survives restart');
    } finally {
      await harness.dispose();
    }
  });

  it('dispose is idempotent and releases the worker database for a same-path reopen', async () => {
    let harness = createRealPersistence();
    const { update } = yjsUpdate('kept across dispose', 'prose');
    await harness.client.request('persistYjsUpdate', {
      projectId: 'proj-1',
      documentId: 'doc-1',
      update,
    });
    const databasePath = harness.databasePath;
    const firstDispose = harness.dispose();
    const secondDispose = harness.dispose();
    expect(secondDispose).toBe(firstDispose);
    await firstDispose;

    harness = createRealPersistence(databasePath);
    try {
      const loaded = await harness.client.request('loadWorkingDocument', {
        projectId: 'proj-1',
        documentId: 'doc-1',
      });
      expect(loaded).not.toBeNull();
      const doc = new Y.Doc();
      Y.applyUpdate(doc, loaded.update);
      expect(doc.getText('prose').toString()).toBe('kept across dispose');
    } finally {
      await harness.dispose();
    }
  });

  it('exposes the auth wire operations with atomic guards', async () => {
    const harness = createRealPersistence();
    try {
      await expect(harness.client.request('getAuthState', undefined)).resolves.toEqual({
        ownerUserId: null,
      });
      const owner = await harness.client.request('bootstrapOwner', {
        userId: 'owner-1',
        displayName: 'Owner',
        passwordHash: {
          version: 1,
          algorithm: 'argon2id',
          saltBase64: 'c2FsdA==',
          hashBase64: 'aGFzaA==',
          memory: 64,
          passes: 3,
          parallelism: 1,
          tagLength: 32,
        },
        capabilityVersion: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      expect(owner.role).toBe('owner');
      await expect(
        harness.client.request('bootstrapOwner', {
          userId: 'owner-2',
          displayName: 'Other',
          passwordHash: owner.passwordHash as never,
          capabilityVersion: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
      ).rejects.toMatchObject({ code: 'OWNER_EXISTS', retryable: false });
      await expect(harness.client.request('getAuthState', undefined)).resolves.toEqual({
        ownerUserId: 'owner-1',
      });
      await expect(harness.client.request('loadOwner', undefined)).resolves.toMatchObject({
        userId: 'owner-1',
      });
      await expect(
        harness.client.request('loadUser', { userId: 'owner-1' }),
      ).resolves.toMatchObject({ userId: 'owner-1' });

      // Backoff increments persist per subject.
      await harness.client.request('recordAuthFailure', {
        subject: 'user:owner-1',
        at: '2026-01-01T00:00:00.000Z',
      });
      await harness.client.request('recordAuthFailure', {
        subject: 'user:owner-1',
        at: '2026-01-01T00:00:01.000Z',
      });
      await expect(
        harness.client.request('loadAuthBackoff', { subject: 'user:owner-1' }),
      ).resolves.toMatchObject({ failures: 2 });
      await harness.client.request('clearAuthBackoff', { subject: 'user:owner-1' });
      await expect(
        harness.client.request('loadAuthBackoff', { subject: 'user:owner-1' }),
      ).resolves.toBeNull();

      // Invite consumption is single-use and expiry-aware at the wire level.
      await harness.client.request('createInvite', {
        inviteId: 'inv-1',
        projectId: 'proj-1',
        role: 'reader',
        expiresAt: '2026-01-02T00:00:00.000Z',
      });
      await expect(
        harness.client.request('consumeInvite', {
          inviteId: 'inv-1',
          consumedAt: '2026-01-01T12:00:00.000Z',
        }),
      ).resolves.toMatchObject({ status: 'accepted' });
      await expect(
        harness.client.request('consumeInvite', {
          inviteId: 'inv-1',
          consumedAt: '2026-01-01T12:00:01.000Z',
        }),
      ).resolves.toEqual({ status: 'already-consumed' });
      await harness.client.request('createInvite', {
        inviteId: 'inv-expired',
        projectId: 'proj-1',
        role: 'reader',
        expiresAt: '2026-01-01T00:00:00.000Z',
      });
      await expect(
        harness.client.request('consumeInvite', {
          inviteId: 'inv-expired',
          consumedAt: '2026-01-01T12:00:00.000Z',
        }),
      ).resolves.toEqual({ status: 'expired' });
      await expect(
        harness.client.request('consumeInvite', {
          inviteId: 'inv-missing',
          consumedAt: '2026-01-01T12:00:00.000Z',
        }),
      ).resolves.toEqual({ status: 'not-found' });

      // Owner password reset revokes sessions and capabilities in one transaction.
      await harness.client.request('createSession', {
        sessionId: 's-1',
        userId: 'owner-1',
        expiresAt: '2026-02-01T00:00:00.000Z',
        capabilityVersion: 1,
      });
      await harness.client.request('createSession', {
        sessionId: 's-2',
        userId: 'owner-1',
        expiresAt: '2026-02-01T00:00:00.000Z',
        capabilityVersion: 1,
      });
      await harness.client.request('upsertCapability', {
        capabilityId: 'cap-1',
        userId: 'owner-1',
        projectId: 'proj-1',
        scope: ['project:read'],
        version: 1,
        expiresAt: '2026-02-01T00:00:00.000Z',
      });
      const reset = await harness.client.request('resetOwnerPassword', {
        userId: 'owner-1',
        passwordHash: {
          version: 1,
          algorithm: 'argon2id',
          saltBase64: 'c2FsdA==',
          hashBase64: 'bmV3aGFzaA==',
          memory: 64,
          passes: 3,
          parallelism: 1,
          tagLength: 32,
        },
        capabilityVersion: 2,
        at: '2026-01-01T12:00:00.000Z',
      });
      expect(reset).toMatchObject({ revokedSessions: 2, revokedCapabilities: 1 });
      expect(reset.user.capabilityVersion).toBe(2);
      await expect(harness.client.request('loadSession', { sessionId: 's-1' })).resolves.toBeNull();
      await expect(harness.client.request('loadSession', { sessionId: 's-2' })).resolves.toBeNull();
      await expect(
        harness.client.request('loadCapability', { capabilityId: 'cap-1' }),
      ).resolves.toMatchObject({ userId: 'owner-1', revokedAt: '2026-01-01T12:00:00.000Z' });
      await expect(
        harness.client.request('resetOwnerPassword', {
          userId: 'missing',
          passwordHash: reset.user.passwordHash as never,
          capabilityVersion: 1,
          at: '2026-01-01T12:00:00.000Z',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await harness.dispose();
    }
  });

  it('serves loadGitSubmission over the wire, null for unknown and journal for known', async () => {
    const harness = createRealPersistence();
    try {
      await expect(
        harness.client.request('loadGitSubmission', { submitId: 'missing' }),
      ).resolves.toBeNull();
      await harness.client.request('beginGitSubmission', {
        submitId: 'submit-1',
        projectId: 'proj-1',
        phase: 'candidate-materialized',
        expectedGitHead: 'head-before',
        candidateCommit: 'tree-candidate',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      await expect(
        harness.client.request('loadGitSubmission', { submitId: 'submit-1' }),
      ).resolves.toEqual({
        submitId: 'submit-1',
        projectId: 'proj-1',
        phase: 'candidate-materialized',
        expectedGitHead: 'head-before',
        candidateCommit: 'tree-candidate',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
    } finally {
      await harness.dispose();
    }
  });

  it('rolls back acceptInviteUser atomically when a mid-transaction insert fails', async () => {
    const harness = createRealPersistence();
    try {
      const passwordHash = {
        version: 1,
        algorithm: 'argon2id',
        saltBase64: 'c2FsdA==',
        hashBase64: 'aGFzaA==',
        memory: 64,
        passes: 3,
        parallelism: 1,
        tagLength: 32,
      };
      await harness.client.request('bootstrapOwner', {
        userId: 'owner-1',
        displayName: 'Owner',
        passwordHash,
        capabilityVersion: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      await harness.client.request('createInvite', {
        inviteId: 'inv-atomic',
        projectId: 'proj-1',
        role: 'reader',
        expiresAt: '2026-02-01T00:00:00.000Z',
      });

      // The user insert collides with the owner's primary key after the invite
      // has already been marked consumed inside the same transaction. The
      // ROLLBACK must undo the consumption and leave no partial rows.
      await expect(
        harness.client.request('acceptInviteUser', {
          inviteId: 'inv-atomic',
          consumedAt: '2026-01-01T12:00:00.000Z',
          userId: 'owner-1',
          displayName: 'Intruder',
          passwordHash,
          capabilityVersion: 1,
          createdAt: '2026-01-01T12:00:00.000Z',
          session: {
            sessionId: 's-collide',
            userId: 'owner-1',
            expiresAt: '2026-02-01T00:00:00.000Z',
            capabilityVersion: 1,
          },
        }),
      ).rejects.toMatchObject({ code: 'ERR_SQLITE_ERROR', retryable: false });

      await expect(
        harness.client.request('loadSession', { sessionId: 's-collide' }),
      ).resolves.toBeNull();
      await expect(
        harness.client.request('consumeInvite', {
          inviteId: 'inv-atomic',
          consumedAt: '2026-01-01T12:00:01.000Z',
        }),
      ).resolves.toMatchObject({ status: 'accepted' });
    } finally {
      await harness.dispose();
    }
  });
});

describe('real persistence worker project memberships', () => {
  it('persists canonical roles, active-only reads, revisions, and capability/session invalidation', async () => {
    const harness = createRealPersistence();
    try {
      const projectA = {
        projectId: 'project-a',
        displayName: 'Project A',
        rootLabel: 'project-a-root',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      const projectB = {
        projectId: 'project-b',
        displayName: 'Project B',
        rootLabel: 'project-b-root',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      await harness.client.request('upsertProject', projectA);
      await harness.client.request('upsertProject', projectB);
      await harness.client.request('createInvite', {
        inviteId: 'membership-seed-invite',
        projectId: projectB.projectId,
        role: 'reader',
        expiresAt: '2026-02-01T00:00:00.000Z',
      });
      await expect(
        harness.client.request('acceptInviteUser', {
          inviteId: 'membership-seed-invite',
          consumedAt: '2026-01-01T00:00:00.000Z',
          userId: 'member-1',
          displayName: 'Member',
          passwordHash: {
            version: 1,
            algorithm: 'argon2id',
            saltBase64: 'c2FsdA==',
            hashBase64: 'aGFzaA==',
            memory: 64,
            passes: 3,
            parallelism: 1,
            tagLength: 32,
          },
          capabilityVersion: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          session: {
            sessionId: 'member-session',
            userId: 'member-1',
            expiresAt: '2026-02-01T00:00:00.000Z',
            capabilityVersion: 1,
          },
        }),
      ).resolves.toMatchObject({ status: 'accepted' });

      await expect(
        harness.client.request('loadProjectMembership', {
          userId: 'member-1',
          projectId: projectA.projectId,
        }),
      ).resolves.toBeNull();
      await expect(
        harness.client.request('listProjectMemberships', { projectId: projectA.projectId }),
      ).resolves.toEqual([]);
      await expect(harness.client.request('listProjectMemberships', {})).resolves.toMatchObject([
        {
          userId: 'member-1',
          projectId: projectB.projectId,
          role: 'reader',
          revision: 1,
          capabilityVersion: 1,
        },
      ]);

      await harness.client.request('upsertCapability', {
        capabilityId: 'capability-a-initial',
        userId: 'member-1',
        projectId: projectA.projectId,
        scope: ['project:read'],
        version: 1,
        expiresAt: '2026-02-01T00:00:00.000Z',
      });
      await harness.client.request('upsertCapability', {
        capabilityId: 'capability-b',
        userId: 'member-1',
        projectId: projectB.projectId,
        scope: ['project:read'],
        version: 1,
        expiresAt: '2026-02-01T00:00:00.000Z',
      });

      // The worker validates identities and roles before mutating membership state.
      const untypedClient = harness.client as unknown as {
        request(operation: string, payload: unknown): Promise<unknown>;
      };
      await expect(
        untypedClient.request('upsertProjectMembership', {
          userId: 'member-1',
          projectId: projectA.projectId,
          role: 'owner',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT', retryable: false });
      await expect(
        untypedClient.request('loadProjectMembership', {
          userId: '',
          projectId: projectA.projectId,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT', retryable: false });
      await expect(
        untypedClient.request('listProjectMemberships', { projectId: '' }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT', retryable: false });
      await expect(
        harness.client.request('upsertProjectMembership', {
          userId: 'missing-user',
          projectId: projectA.projectId,
          role: 'reader',
          at: '2026-01-01T00:00:01.000Z',
        }),
      ).rejects.toMatchObject({ code: 'USER_NOT_FOUND', retryable: false });
      await expect(
        harness.client.request('upsertProjectMembership', {
          userId: 'member-1',
          projectId: 'missing-project',
          role: 'reader',
          at: '2026-01-01T00:00:02.000Z',
        }),
      ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', retryable: false });

      const first = await harness.client.request('upsertProjectMembership', {
        userId: 'member-1',
        projectId: projectA.projectId,
        role: 'reader',
        at: '2026-01-01T00:01:00.000Z',
      });
      expect(first).toMatchObject({
        capabilityVersion: 2,
        revokedCapabilities: 1,
        membership: {
          userId: 'member-1',
          projectId: projectA.projectId,
          role: 'reader',
          createdAt: '2026-01-01T00:01:00.000Z',
          revision: 1,
          capabilityVersion: 2,
        },
      });
      await expect(
        harness.client.request('loadSession', { sessionId: 'member-session' }),
      ).resolves.toMatchObject({ userId: 'member-1', capabilityVersion: 2 });
      await expect(
        harness.client.request('loadCapability', { capabilityId: 'capability-a-initial' }),
      ).resolves.toMatchObject({
        userId: 'member-1',
        projectId: projectA.projectId,
        revokedAt: '2026-01-01T00:01:00.000Z',
      });
      await expect(
        harness.client.request('loadCapability', { capabilityId: 'capability-b' }),
      ).resolves.toMatchObject({ userId: 'member-1', projectId: projectB.projectId });
      await expect(
        harness.client.request('loadProjectMembership', {
          userId: 'member-1',
          projectId: projectA.projectId,
        }),
      ).resolves.toMatchObject({ role: 'reader', revision: 1, capabilityVersion: 2 });

      await harness.client.request('upsertCapability', {
        capabilityId: 'capability-a-second',
        userId: 'member-1',
        projectId: projectA.projectId,
        scope: ['project:write'],
        version: 2,
        expiresAt: '2026-02-01T00:00:00.000Z',
      });
      const second = await harness.client.request('upsertProjectMembership', {
        userId: 'member-1',
        projectId: projectA.projectId,
        role: 'maintainer',
        at: '2026-01-01T00:02:00.000Z',
      });
      expect(second).toMatchObject({
        capabilityVersion: 3,
        revokedCapabilities: 1,
        membership: {
          role: 'maintainer',
          createdAt: '2026-01-01T00:01:00.000Z',
          revision: 2,
          capabilityVersion: 3,
        },
      });
      await expect(
        harness.client.request('loadSession', { sessionId: 'member-session' }),
      ).resolves.toMatchObject({ capabilityVersion: 3 });
      await expect(
        harness.client.request('loadCapability', { capabilityId: 'capability-a-second' }),
      ).resolves.toMatchObject({ revokedAt: '2026-01-01T00:02:00.000Z' });
      await expect(
        harness.client.request('listProjectMemberships', { projectId: projectA.projectId }),
      ).resolves.toMatchObject([
        { projectId: projectA.projectId, role: 'maintainer', revision: 2, capabilityVersion: 3 },
      ]);

      await harness.client.request('upsertCapability', {
        capabilityId: 'capability-a-third',
        userId: 'member-1',
        projectId: projectA.projectId,
        scope: ['project:maintain'],
        version: 3,
        expiresAt: '2026-02-01T00:00:00.000Z',
      });
      const revoked = await harness.client.request('revokeProjectMembership', {
        userId: 'member-1',
        projectId: projectA.projectId,
        at: '2026-01-01T00:03:00.000Z',
      });
      expect(revoked).toMatchObject({
        capabilityVersion: 4,
        revokedCapabilities: 1,
        membership: {
          role: 'maintainer',
          revision: 3,
          revokedAt: '2026-01-01T00:03:00.000Z',
          capabilityVersion: 4,
        },
      });
      await expect(
        harness.client.request('loadProjectMembership', {
          userId: 'member-1',
          projectId: projectA.projectId,
        }),
      ).resolves.toBeNull();
      await expect(
        harness.client.request('listProjectMemberships', { projectId: projectA.projectId }),
      ).resolves.toEqual([]);
      await expect(harness.client.request('listProjectMemberships', {})).resolves.toEqual([
        {
          userId: 'member-1',
          projectId: projectB.projectId,
          role: 'reader',
          createdAt: '2026-01-01T00:00:00.000Z',
          revision: 1,
          capabilityVersion: 4,
        },
      ]);
      await expect(
        harness.client.request('loadSession', { sessionId: 'member-session' }),
      ).resolves.toMatchObject({ capabilityVersion: 4 });
      await expect(
        harness.client.request('loadCapability', { capabilityId: 'capability-a-third' }),
      ).resolves.toMatchObject({ revokedAt: '2026-01-01T00:03:00.000Z' });
      const unaffectedCapability = await harness.client.request('loadCapability', {
        capabilityId: 'capability-b',
      });
      expect(unaffectedCapability).toMatchObject({ projectId: projectB.projectId });
      expect(unaffectedCapability).not.toHaveProperty('revokedAt');

      // Re-adding a revoked row increments its revision and accepts the final
      // canonical role, while restoring it to active reads.
      const reactivated = await harness.client.request('upsertProjectMembership', {
        userId: 'member-1',
        projectId: projectA.projectId,
        role: 'author',
        at: '2026-01-01T00:04:00.000Z',
      });
      expect(reactivated).toMatchObject({
        capabilityVersion: 5,
        revokedCapabilities: 0,
        membership: {
          role: 'author',
          revision: 4,
          capabilityVersion: 5,
        },
      });
      await expect(
        harness.client.request('loadProjectMembership', {
          userId: 'member-1',
          projectId: projectA.projectId,
        }),
      ).resolves.toMatchObject({ role: 'author', revision: 4, capabilityVersion: 5 });

      await expect(
        harness.client.request('revokeProjectMembership', {
          userId: 'missing-user',
          projectId: projectA.projectId,
          at: '2026-01-01T00:05:00.000Z',
        }),
      ).rejects.toMatchObject({ code: 'USER_NOT_FOUND', retryable: false });
      await expect(
        harness.client.request('revokeProjectMembership', {
          userId: 'member-1',
          projectId: 'missing-project',
          at: '2026-01-01T00:05:00.000Z',
        }),
      ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', retryable: false });
    } finally {
      await harness.dispose();
    }
  });
});

describe('git submission journal exact-once', () => {
  it('persists one immutable receipt per submitId and replays it across a worker restart', async () => {
    const submitId = 'submit-journal-1';
    const projectId = 'proj-git-1';
    const receipt = {
      submitId,
      projectId,
      commit: 'candidate-commit-1',
      sourceHash: 'source-hash-1',
      receiptHash: 'receipt-hash-1',
      acceptedAt: '2026-08-02T00:00:01.000Z',
    };
    let harness = createRealPersistence();
    try {
      // Journal lookup before any submit: no record.
      await expect(harness.client.request('loadGitSubmission', { submitId })).resolves.toBeNull();

      // Typed domain calls drive the journal through the submit protocol.
      const begun = await harness.client.request('beginGitSubmission', {
        submitId,
        projectId,
        phase: 'yjs-acked',
        expectedGitHead: 'base-head-1',
        updatedAt: '2026-08-02T00:00:00.000Z',
      });
      expect(begun).toMatchObject({
        submitId,
        projectId,
        phase: 'yjs-acked',
        expectedGitHead: 'base-head-1',
      });

      const committed = await harness.client.request('checkpointGitSubmission', {
        submitId,
        projectId,
        phase: 'commit-created',
        expectedGitHead: 'base-head-1',
        candidateCommit: receipt.commit,
        receiptHash: receipt.receiptHash,
        updatedAt: '2026-08-02T00:00:00.500Z',
      });
      expect(committed).toMatchObject({
        phase: 'commit-created',
        candidateCommit: receipt.commit,
        receiptHash: receipt.receiptHash,
      });

      await expect(harness.client.request('completeGitSubmission', receipt)).resolves.toEqual(
        receipt,
      );

      // A retry of the completion returns the same stored receipt (exact-once).
      await expect(harness.client.request('completeGitSubmission', receipt)).resolves.toEqual(
        receipt,
      );

      // begin/checkpoint after completion never clobber the immutable receipt.
      const rebegun = await harness.client.request('beginGitSubmission', {
        submitId,
        projectId,
        phase: 'yjs-acked',
        expectedGitHead: 'other-head',
        updatedAt: '2026-08-02T00:00:02.000Z',
      });
      expect(rebegun.phase).toBe(GIT_SUBMISSION_PHASE_COMPLETE);
      const recheckpointed = await harness.client.request('checkpointGitSubmission', {
        submitId,
        projectId,
        phase: 'commit-created',
        expectedGitHead: 'other-head',
        candidateCommit: 'another-commit',
        receiptHash: 'another-hash',
        updatedAt: '2026-08-02T00:00:02.000Z',
      });
      expect(recheckpointed.phase).toBe(GIT_SUBMISSION_PHASE_COMPLETE);
      await expect(harness.client.request('loadGitSubmission', { submitId })).resolves.toEqual(
        receipt,
      );

      // Worker restart on the same database file: the journal lookup returns
      // the same prior accepted receipt, never a second one.
      const databasePath = harness.databasePath;
      await harness.dispose();
      harness = createRealPersistence(databasePath);
      await expect(harness.client.request('loadGitSubmission', { submitId })).resolves.toEqual(
        receipt,
      );
      await expect(harness.client.request('completeGitSubmission', receipt)).resolves.toEqual(
        receipt,
      );
      expect(rawRowCount(databasePath, 'SELECT COUNT(*) AS count FROM git_submissions')).toBe(1);
    } finally {
      await harness.dispose();
    }
  });

  it('answers only typed domain operations through the real worker client', async () => {
    const harness = createRealPersistence();
    try {
      const client = harness.client as unknown as {
        request(operation: string, payload: unknown): Promise<unknown>;
      };
      // The client surface exposes domain calls, never generic SQL.
      expect((harness.client as unknown as Record<string, unknown>).query).toBeUndefined();
      // Malformed wire input fails closed with a typed error instead of being
      // answered as a bogus success.
      await expect(client.request('dropTable', { name: 'users' })).rejects.toMatchObject({
        code: 'UNKNOWN_OPERATION',
        retryable: false,
      });
    } finally {
      await harness.dispose();
    }
  });

  it('replays a recorded typed conflict outcome across a worker restart', async () => {
    const submitId = 'submit-conflict-1';
    const projectId = 'proj-git-2';
    const journalEntry = {
      submitId,
      projectId,
      phase: GIT_SUBMISSION_PHASE_CONFLICT,
      expectedGitHead: 'base-head-2',
      candidateCommit: 'candidate-commit-2',
      updatedAt: '2026-08-02T00:00:00.000Z',
    };
    let harness = createRealPersistence();
    try {
      await harness.client.request('beginGitSubmission', {
        submitId,
        projectId,
        phase: 'commit-created',
        expectedGitHead: 'base-head-2',
        candidateCommit: 'candidate-commit-2',
        receiptHash: 'rh-2',
        updatedAt: '2026-08-02T00:00:00.000Z',
      });
      const recorded = await harness.client.request('checkpointGitSubmission', journalEntry);
      expect(recorded).toMatchObject({
        phase: GIT_SUBMISSION_PHASE_CONFLICT,
        candidateCommit: 'candidate-commit-2',
      });
      await expect(
        harness.client.request('loadGitSubmission', { submitId }),
      ).resolves.toMatchObject({ phase: GIT_SUBMISSION_PHASE_CONFLICT });

      const databasePath = harness.databasePath;
      await harness.dispose();
      harness = createRealPersistence(databasePath);
      // After a restart the same submitId replays the same typed conflict; a
      // completion of a non-accepted submit stays a no-op failure, never a receipt.
      await expect(
        harness.client.request('loadGitSubmission', { submitId }),
      ).resolves.toMatchObject({ phase: GIT_SUBMISSION_PHASE_CONFLICT });
      await expect(
        harness.client.request('completeGitSubmission', {
          submitId,
          projectId,
          commit: 'candidate-commit-2',
          sourceHash: 'source-hash-2',
          receiptHash: 'rh-2',
          acceptedAt: '2026-08-02T00:00:01.000Z',
        }),
      ).rejects.toMatchObject({ code: 'GIT_SUBMISSION_NOT_COMPLETABLE' });
      expect(rawRowCount(databasePath, 'SELECT COUNT(*) AS count FROM git_submissions')).toBe(1);
    } finally {
      await harness.dispose();
    }
  });
});

describe('real persistence worker project operations', () => {
  const projectId = 'proj-ops-1';
  const record = (overrides: Partial<ProjectOperationRecordV1> = {}): ProjectOperationRecordV1 => ({
    version: 1,
    projectId,
    operationId: 'op-1',
    idempotencyKey: 'idem-1',
    kind: 'render',
    status: 'queued',
    actorId: 'actor-1',
    capabilityVersion: 3,
    sourceHash: null,
    acceptedRevisionId: null,
    progress: null,
    resultRef: null,
    errorCode: null,
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    ...overrides,
  });

  /** Drive a fresh row through the legal path to `target` (or throw). */
  const seedStatus = async (
    store: ProjectOperationStore,
    operationId: string,
    target: ProjectOperationStatusV1,
    forProjectId: string = projectId,
  ): Promise<void> => {
    const base = record({
      projectId: forProjectId,
      operationId,
      idempotencyKey: `idem-${operationId}`,
    });
    await store.upsert({ record: base });
    if (target === 'queued') return;
    await store.upsert({
      record: { ...base, status: 'running', updatedAt: '2026-08-06T00:01:00.000Z' },
      expectedStatus: 'queued',
    });
    if (target === 'running') return;
    if (target === 'interrupted') {
      await store.markAllInterrupted(forProjectId, '2026-08-06T00:02:00.000Z');
      return;
    }
    await store.upsert({
      record: { ...base, status: target, updatedAt: '2026-08-06T00:02:00.000Z' },
      expectedStatus: 'running',
    });
  };

  it('roundtrips a queued operation and its transitions through the store facade', async () => {
    const harness = createRealPersistence();
    try {
      const store = createProjectOperationStore(harness.client);
      const created = await store.upsert({ record: record() });
      expect(created).toMatchObject({ created: true, applied: true });
      expect(created.record).toEqual(record());

      await expect(store.get(projectId, 'op-1')).resolves.toEqual(record());
      await expect(store.get(projectId, 'missing')).resolves.toBeNull();
      await expect(store.getByIdempotencyKey(projectId, 'render', 'idem-1')).resolves.toEqual(
        record(),
      );
      await expect(store.getByIdempotencyKey(projectId, 'render', 'other-key')).resolves.toBeNull();

      const running = await store.upsert({
        record: record({ status: 'running', updatedAt: '2026-08-06T00:00:01.000Z' }),
        expectedStatus: 'queued',
      });
      expect(running).toMatchObject({ created: false, applied: true });
      expect(running.record.status).toBe('running');

      const succeeded = await store.upsert({
        record: record({
          status: 'succeeded',
          acceptedRevisionId: 'rev-9',
          progress: { completed: 3, total: 3 },
          resultRef: 'candidate://rev-9',
          updatedAt: '2026-08-06T00:00:02.000Z',
        }),
        expectedStatus: 'running',
      });
      expect(succeeded).toMatchObject({ created: false, applied: true });
      expect(succeeded.record).toMatchObject({
        status: 'succeeded',
        acceptedRevisionId: 'rev-9',
        progress: { completed: 3, total: 3 },
        resultRef: 'candidate://rev-9',
        errorCode: null,
        sourceHash: null,
        version: 1,
      });
      await expect(store.countByStatus(projectId)).resolves.toEqual({ count: 1 });
      await expect(store.countByStatus(projectId, 'succeeded')).resolves.toEqual({ count: 1 });
      await expect(store.countByStatus(projectId, 'running')).resolves.toEqual({ count: 0 });
    } finally {
      await harness.dispose();
    }
  });

  it('rejects illegal status transitions with a typed error and leaves the row untouched', async () => {
    const harness = createRealPersistence();
    try {
      const store = createProjectOperationStore(harness.client);
      const illegal: Array<[ProjectOperationStatusV1, ProjectOperationStatusV1]> = [
        ['queued', 'queued'],
        ['queued', 'succeeded'],
        ['queued', 'failed'],
        ['running', 'queued'],
        ['running', 'running'],
        ['succeeded', 'running'],
        ['succeeded', 'queued'],
        ['failed', 'queued'],
        ['stale', 'queued'],
        ['cancelled', 'queued'],
        ['interrupted', 'running'],
        ['interrupted', 'succeeded'],
        ['interrupted', 'failed'],
      ];
      for (const [from, to] of illegal) {
        const operationId = `op-illegal-${from}-${to}`;
        await seedStatus(store, operationId, from);
        await expect(
          store.upsert({
            record: record({
              operationId,
              idempotencyKey: `idem-${operationId}`,
              status: to,
              updatedAt: '2026-08-06T00:03:00.000Z',
            }),
          }),
        ).rejects.toMatchObject({ code: 'ILLEGAL_OPERATION_TRANSITION', retryable: false });
        expect((await store.get(projectId, operationId))?.status).toBe(from);
      }

      // Creation outside `queued` and malformed progress fail closed.
      await expect(
        store.upsert({ record: record({ operationId: 'op-running-create', status: 'running' }) }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT', retryable: false });
      await expect(
        store.upsert({
          record: record({
            operationId: 'op-bad-progress',
            progress: { completed: 2, total: 1 },
          }),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT', retryable: false });

      // Immutable identity fields cannot be rewritten on a transition.
      await store.upsert({ record: record({ operationId: 'op-identity' }) });
      await expect(
        store.upsert({
          record: record({
            operationId: 'op-identity',
            idempotencyKey: 'idem-identity',
            actorId: 'actor-2',
            status: 'running',
            updatedAt: '2026-08-06T00:03:00.000Z',
          }),
          expectedStatus: 'queued',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT', retryable: false });
    } finally {
      await harness.dispose();
    }
  });

  it('allows queue-time cancellation/staleness and post-restart cancellation', async () => {
    const harness = createRealPersistence();
    try {
      const store = createProjectOperationStore(harness.client);
      await store.upsert({
        record: record({ operationId: 'op-cancel', idempotencyKey: 'idem-cancel' }),
      });
      const cancelled = await store.upsert({
        record: record({
          operationId: 'op-cancel',
          idempotencyKey: 'idem-cancel',
          status: 'cancelled',
          updatedAt: '2026-08-06T00:00:01.000Z',
        }),
        expectedStatus: 'queued',
      });
      expect(cancelled).toMatchObject({ applied: true, created: false });
      expect(cancelled.record.status).toBe('cancelled');

      // A queued render superseded by a newer accepted source is marked stale
      // without ever running.
      await store.upsert({
        record: record({ operationId: 'op-stale', idempotencyKey: 'idem-stale' }),
      });
      const staled = await store.upsert({
        record: record({
          operationId: 'op-stale',
          idempotencyKey: 'idem-stale',
          status: 'stale',
          updatedAt: '2026-08-06T00:00:02.000Z',
        }),
        expectedStatus: 'queued',
      });
      expect(staled).toMatchObject({ applied: true });
      expect(staled.record.status).toBe('stale');

      // Post-restart: interrupted work may be discarded explicitly.
      await store.upsert({ record: record({ operationId: 'op-int', idempotencyKey: 'idem-int' }) });
      await store.upsert({
        record: record({
          operationId: 'op-int',
          idempotencyKey: 'idem-int',
          status: 'running',
          updatedAt: '2026-08-06T00:00:03.000Z',
        }),
        expectedStatus: 'queued',
      });
      await store.markAllInterrupted(projectId, '2026-08-06T00:00:04.000Z');
      const discarded = await store.upsert({
        record: record({
          operationId: 'op-int',
          idempotencyKey: 'idem-int',
          status: 'cancelled',
          updatedAt: '2026-08-06T00:00:05.000Z',
        }),
        expectedStatus: 'interrupted',
      });
      expect(discarded).toMatchObject({ applied: true });
      expect(discarded.record.status).toBe('cancelled');
    } finally {
      await harness.dispose();
    }
  });

  it('honors the expectedStatus CAS and the per-key idempotency unique constraint', async () => {
    const harness = createRealPersistence();
    try {
      const store = createProjectOperationStore(harness.client);
      await store.upsert({ record: record() });

      // CAS miss: the stored row is returned unmodified with applied:false.
      const miss = await store.upsert({
        record: record({ status: 'running', updatedAt: '2026-08-06T00:00:01.000Z' }),
        expectedStatus: 'succeeded',
      });
      expect(miss).toMatchObject({ created: false, applied: false });
      expect(miss.record.status).toBe('queued');
      expect((await store.get(projectId, 'op-1'))?.status).toBe('queued');

      // CAS hit proceeds with the transition.
      const hit = await store.upsert({
        record: record({ status: 'running', updatedAt: '2026-08-06T00:00:02.000Z' }),
        expectedStatus: 'queued',
      });
      expect(hit).toMatchObject({ created: false, applied: true });
      expect(hit.record.status).toBe('running');

      // A second row claiming the same idempotency key is refused, while the
      // same key under a different kind or project is legal.
      await expect(
        store.upsert({
          record: record({
            operationId: 'op-duplicate',
            idempotencyKey: 'idem-1',
            updatedAt: '2026-08-06T00:00:03.000Z',
          }),
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', retryable: false });
      await expect(store.get(projectId, 'op-duplicate')).resolves.toBeNull();

      const otherKind = await store.upsert({
        record: record({
          operationId: 'op-publish',
          idempotencyKey: 'idem-1',
          kind: 'publish',
          updatedAt: '2026-08-06T00:00:03.000Z',
        }),
      });
      expect(otherKind).toMatchObject({ created: true });
      await expect(
        store.upsert({
          record: record({
            operationId: 'op-other-project',
            idempotencyKey: 'idem-1',
            projectId: 'proj-ops-2',
            updatedAt: '2026-08-06T00:00:03.000Z',
          }),
        }),
      ).resolves.toMatchObject({ created: true });
    } finally {
      await harness.dispose();
    }
  });

  it('sweeps queued/running work to interrupted (surviving a restart) and allows explicit retry', async () => {
    let harness = createRealPersistence();
    const base = record();
    await harness.client.request('upsertProjectOperation', { record: base });
    await harness.client.request('upsertProjectOperation', {
      record: { ...base, status: 'running', updatedAt: '2026-08-06T00:00:01.000Z' },
      expectedStatus: 'queued',
    });
    const databasePath = harness.databasePath;
    await harness.dispose();
    harness = createRealPersistence(databasePath);
    try {
      const store = createProjectOperationStore(harness.client);
      // The restart sweep marks the crashed running operation interrupted.
      await expect(
        store.markAllInterrupted(projectId, '2026-08-06T00:00:02.000Z'),
      ).resolves.toEqual({ updated: 1 });
      const interrupted = await store.get(projectId, 'op-1');
      expect(interrupted).toMatchObject({
        status: 'interrupted',
        updatedAt: '2026-08-06T00:00:02.000Z',
      });

      // The same idempotency key may explicitly re-enter the queue.
      const retried = await store.upsert({
        record: { ...base, status: 'queued', updatedAt: '2026-08-06T00:00:03.000Z' },
        expectedStatus: 'interrupted',
      });
      expect(retried).toMatchObject({ applied: true, created: false });
      expect(retried.record.status).toBe('queued');

      // The retried run can complete the full cycle and terminal rows are
      // never swept.
      await store.upsert({
        record: { ...base, status: 'running', updatedAt: '2026-08-06T00:00:04.000Z' },
        expectedStatus: 'queued',
      });
      await store.upsert({
        record: { ...base, status: 'succeeded', updatedAt: '2026-08-06T00:00:05.000Z' },
        expectedStatus: 'running',
      });
      await expect(
        store.markAllInterrupted(projectId, '2026-08-06T00:00:06.000Z'),
      ).resolves.toEqual({ updated: 0 });
      expect((await store.get(projectId, 'op-1'))?.status).toBe('succeeded');
    } finally {
      await harness.dispose();
    }
  });

  it('sweeps only queued/running rows and leaves terminal rows alone', async () => {
    const harness = createRealPersistence();
    try {
      const store = createProjectOperationStore(harness.client);
      await store.upsert({ record: record({ operationId: 'op-a', idempotencyKey: 'idem-a' }) });
      await seedStatus(store, 'op-b', 'running');
      await seedStatus(store, 'op-c', 'succeeded');
      await seedStatus(store, 'op-d', 'failed');
      await store.upsert({ record: record({ operationId: 'op-e', idempotencyKey: 'idem-e' }) });

      await expect(
        store.markAllInterrupted(projectId, '2026-08-06T00:05:00.000Z'),
      ).resolves.toEqual({ updated: 3 });
      await expect(store.countByStatus(projectId, 'queued')).resolves.toEqual({ count: 0 });
      await expect(store.countByStatus(projectId, 'running')).resolves.toEqual({ count: 0 });
      await expect(store.countByStatus(projectId, 'interrupted')).resolves.toEqual({ count: 3 });
      await expect(store.countByStatus(projectId, 'succeeded')).resolves.toEqual({ count: 1 });
      await expect(store.countByStatus(projectId, 'failed')).resolves.toEqual({ count: 1 });
      await expect(store.countByStatus(projectId)).resolves.toEqual({ count: 5 });
      // A second sweep is a no-op.
      await expect(
        store.markAllInterrupted(projectId, '2026-08-06T00:05:01.000Z'),
      ).resolves.toEqual({ updated: 0 });
    } finally {
      await harness.dispose();
    }
  });

  it('pages the queue newest-updated first with cursors, limit clamping and status filters', async () => {
    const harness = createRealPersistence();
    try {
      const store = createProjectOperationStore(harness.client);
      const pageProject = 'proj-page';
      // op-c and op-d share an updatedAt to exercise the operationId tie-break.
      const seeds = [
        { id: 'op-a', at: '2026-08-06T00:00:01.000Z' },
        { id: 'op-b', at: '2026-08-06T00:00:02.000Z' },
        { id: 'op-c', at: '2026-08-06T00:00:03.000Z' },
        { id: 'op-d', at: '2026-08-06T00:00:03.000Z' },
        { id: 'op-e', at: '2026-08-06T00:00:04.000Z' },
      ] as const;
      for (const seed of seeds) {
        await store.upsert({
          record: record({
            projectId: pageProject,
            operationId: seed.id,
            idempotencyKey: `idem-${seed.id}`,
            updatedAt: seed.at,
          }),
        });
      }

      const first = await store.list({ projectId: pageProject, limit: 2 });
      expect(first.map((op) => op.operationId)).toEqual(['op-e', 'op-d']);
      const second = await store.list({
        projectId: pageProject,
        limit: 2,
        before: `${first[1].updatedAt}|${first[1].operationId}`,
      });
      expect(second.map((op) => op.operationId)).toEqual(['op-c', 'op-b']);
      const third = await store.list({
        projectId: pageProject,
        limit: 2,
        before: `${second[1].updatedAt}|${second[1].operationId}`,
      });
      expect(third.map((op) => op.operationId)).toEqual(['op-a']);

      // Limit clamping: 0 clamps to 1, oversized clamps to the page ceiling.
      expect(
        (await store.list({ projectId: pageProject, limit: 0 })).map((op) => op.operationId),
      ).toEqual(['op-e']);
      expect(await store.list({ projectId: pageProject, limit: 200 })).toHaveLength(5);

      // Malformed cursors fail closed.
      for (const before of ['no-separator', '|op-x', '2026-08-06T00:00:00.000Z|']) {
        await expect(store.list({ projectId: pageProject, before })).rejects.toMatchObject({
          code: 'INVALID_INPUT',
          retryable: false,
        });
      }

      // Status filter + count after legal transitions (rows already exist).
      const complete = async (id: string): Promise<void> => {
        const base = record({
          projectId: pageProject,
          operationId: id,
          idempotencyKey: `idem-${id}`,
        });
        await store.upsert({
          record: { ...base, status: 'running', updatedAt: '2026-08-06T00:06:00.000Z' },
          expectedStatus: 'queued',
        });
        await store.upsert({
          record: { ...base, status: 'succeeded', updatedAt: '2026-08-06T00:07:00.000Z' },
          expectedStatus: 'running',
        });
      };
      await complete('op-a');
      await complete('op-b');
      const succeeded = await store.list({ projectId: pageProject, status: 'succeeded' });
      expect(succeeded.map((op) => op.operationId)).toEqual(['op-b', 'op-a']);
      await expect(store.countByStatus(pageProject, 'succeeded')).resolves.toEqual({ count: 2 });
      await expect(store.countByStatus(pageProject, 'interrupted')).resolves.toEqual({ count: 0 });
    } finally {
      await harness.dispose();
    }
  });
});

describe('real persistence worker project publications', () => {
  const projectId = 'proj-pub-1';
  const customId = 'b'.repeat(64);
  const record = (
    publicationId: string,
    kind: 'canonical' | 'custom',
    overrides: Partial<ProjectPublicationRecordV1> = {},
  ): ProjectPublicationRecordV1 => ({
    version: 1,
    projectId,
    publicationId,
    kind,
    value: {
      sourceHash: 's'.repeat(64),
      scopeHash: 'c'.repeat(64),
      revisionIds: ['rev-1'],
      novelHash: 'n'.repeat(64),
      relativeOutputPath: kind === 'canonical' ? 'output/novel.md' : `output/${publicationId}.md`,
      byteLength: 42,
      actorId: 'actor-1',
      operationId: 'op-1',
      createdAt: '2026-08-06T00:00:00.000Z',
      status: 'current',
    },
    updatedAt: '2026-08-06T00:00:00.000Z',
    ...overrides,
  });

  it('roundtrips canonical/custom rows through the typed store facade with CAS transitions', async () => {
    const harness = createRealPersistence();
    try {
      const store = createProjectPublicationStore(harness.client);

      const canonical = await store.upsert({ record: record('canonical', 'canonical') });
      expect(canonical).toMatchObject({ created: true, applied: true });
      expect(canonical.record).toMatchObject({
        projectId,
        publicationId: 'canonical',
        kind: 'canonical',
        value: { relativeOutputPath: 'output/novel.md', status: 'current' },
      });

      const custom = await store.upsert({ record: record(customId, 'custom') });
      expect(custom).toMatchObject({
        created: true,
        applied: true,
        record: { publicationId: customId, kind: 'custom' },
      });

      // Read-backs agree with what was written.
      await expect(store.get(projectId, 'canonical')).resolves.toMatchObject({
        publicationId: 'canonical',
        value: { novelHash: 'n'.repeat(64), byteLength: 42 },
      });
      await expect(store.get(projectId, 'missing')).resolves.toBeNull();

      // CAS mismatch is a typed no-op that returns the stored row.
      await expect(
        store.upsert({ record: record('canonical', 'canonical'), expectedStatus: 'stale' }),
      ).resolves.toMatchObject({ created: false, applied: false });

      // Demotion with the correct CAS replaces the value wholesale.
      const demoted = await store.upsert({
        record: {
          ...record('canonical', 'canonical'),
          value: { ...record('canonical', 'canonical').value, status: 'stale' },
          updatedAt: '2026-08-06T00:00:01.000Z',
        },
        expectedStatus: 'current',
      });
      expect(demoted).toMatchObject({ created: false, applied: true });
      await expect(store.get(projectId, 'canonical')).resolves.toMatchObject({
        value: { status: 'stale' },
        updatedAt: '2026-08-06T00:00:01.000Z',
      });

      // Idempotent re-publication re-activates the same row with a new value.
      const republished = await store.upsert({
        record: {
          ...record('canonical', 'canonical'),
          value: {
            ...record('canonical', 'canonical').value,
            novelHash: 'm'.repeat(64),
            createdAt: '2026-08-06T00:00:02.000Z',
          },
          updatedAt: '2026-08-06T00:00:02.000Z',
        },
        expectedStatus: 'stale',
      });
      expect(republished).toMatchObject({ created: false, applied: true });
      await expect(store.get(projectId, 'canonical')).resolves.toMatchObject({
        value: { status: 'current', novelHash: 'm'.repeat(64) },
      });

      // Unknown ids and malformed values fail closed at the worker.
      await expect(store.upsert({ record: record('not-hex!', 'custom') })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        retryable: false,
      });
      await expect(
        store.upsert({
          record: {
            ...record('canonical', 'canonical'),
            value: { ...record('canonical', 'canonical').value, byteLength: -5 },
          },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT', retryable: false });
    } finally {
      await harness.dispose();
    }
  });

  it('pages publications newest-updated first with a keyset cursor across a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fabula-pub-paging-'));
    const databasePath = join(dir, 'workbench.sqlite');
    try {
      const ids = ['c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)];
      {
        const harness = createRealPersistence(databasePath);
        try {
          const store = createProjectPublicationStore(harness.client);
          for (let index = 0; index < ids.length; index += 1) {
            await store.upsert({
              record: {
                ...record(ids[index], 'custom'),
                value: {
                  ...record(ids[index], 'custom').value,
                  createdAt: `2026-08-06T00:00:0${index}.000Z`,
                },
                updatedAt: `2026-08-06T00:00:0${index}.000Z`,
              },
            });
          }
          const pageOne = await store.list({ projectId, limit: 2 });
          expect(pageOne.map((pub) => pub.publicationId)).toEqual([ids[2], ids[1]]);
          const cursor = `${pageOne[1].updatedAt}|${pageOne[1].publicationId}`;
          const pageTwo = await store.list({ projectId, limit: 2, before: cursor });
          expect(pageTwo.map((pub) => pub.publicationId)).toEqual([ids[0]]);
        } finally {
          await harness.dispose();
        }
      }
      // The pages survive a worker restart against the same database file.
      {
        const harness = createRealPersistence(databasePath);
        try {
          const store = createProjectPublicationStore(harness.client);
          await expect(store.list({ projectId })).resolves.toHaveLength(3);
          await expect(store.get(projectId, ids[2])).resolves.toMatchObject({
            value: { status: 'current' },
          });
          await expect(
            store.upsert({
              record: {
                ...record('canonical', 'canonical'),
                value: {
                  ...record('canonical', 'canonical').value,
                  sourceHash: 's2'.repeat(32),
                  createdAt: '2026-08-06T00:00:03.000Z',
                },
                updatedAt: '2026-08-06T00:00:03.000Z',
              },
            }),
          ).resolves.toMatchObject({ created: true, applied: true });
          const all = await store.list({ projectId });
          expect(all.map((pub) => pub.publicationId)).toEqual([
            'canonical',
            ids[2],
            ids[1],
            ids[0],
          ]);
        } finally {
          await harness.dispose();
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('real persistence worker agent records', () => {
  const projectId = 'proj-agent-1';
  const hash = 'd'.repeat(64);
  const conversation = (
    overrides: Partial<AgentConversationRecordV1> = {},
  ): AgentConversationRecordV1 => ({
    version: 1,
    conversationId: 'conv-1',
    projectId,
    principalUserId: 'user-1',
    role: 'maintainer',
    title: null,
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    ...overrides,
  });
  const run = (overrides: Partial<AgentRunRecordV1> = {}): AgentRunRecordV1 => ({
    version: 1,
    runId: 'run-1',
    conversationId: 'conv-1',
    projectId,
    operationId: 'op-1',
    principalUserId: 'user-1',
    role: 'maintainer',
    status: 'queued',
    turn: 0,
    maxTurns: 16,
    toolCalls: 0,
    maxToolCalls: 64,
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    ...overrides,
  });
  const toolCall = (overrides: Partial<AgentToolCallRecordV1> = {}): AgentToolCallRecordV1 => ({
    version: 1,
    runId: 'run-1',
    callIndex: 0,
    toolName: 'nova_status',
    sanitizedArgsHash: hash,
    resultRef: null,
    turn: 1,
    status: 'pending',
    createdAt: '2026-08-06T00:00:00.100Z',
    ...overrides,
  });

  it('roundtrips conversations, runs and tool calls through the typed store facade', async () => {
    const harness = createRealPersistence();
    try {
      const store: AgentStore = createAgentStore(harness.client);

      // Conversations: create (duplicate refused), get, append, page.
      await expect(store.createConversation(conversation())).resolves.toEqual(conversation());
      await expect(store.createConversation(conversation())).rejects.toMatchObject({
        code: 'CONVERSATION_EXISTS',
        retryable: false,
      });
      await expect(store.getConversation('missing')).resolves.toBeNull();
      const appended = await store.appendConversation({
        conversationId: 'conv-1',
        at: '2026-08-06T00:00:01.000Z',
        title: 'Draft review',
      });
      expect(appended).toMatchObject({
        title: 'Draft review',
        updatedAt: '2026-08-06T00:00:01.000Z',
      });
      await expect(
        store.appendConversation({ conversationId: 'missing', at: '2026-08-06T00:00:01.000Z' }),
      ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
      await store.createConversation(
        conversation({
          conversationId: 'conv-2',
          principalUserId: 'user-2',
          createdAt: '2026-08-06T00:00:02.000Z',
          updatedAt: '2026-08-06T00:00:02.000Z',
        }),
      );
      const convPage = await store.listConversations({ projectId, limit: 1 });
      expect(convPage.map((item) => item.conversationId)).toEqual(['conv-2']);
      const convCursor = `${convPage[0].updatedAt}|${convPage[0].conversationId}`;
      await expect(
        store.listConversations({ projectId, before: convCursor }),
      ).resolves.toMatchObject([{ conversationId: 'conv-1' }]);

      // Runs: create (queued only, existing conversation with matching project).
      await expect(store.createRun(run())).resolves.toEqual(run());
      await expect(store.createRun(run())).rejects.toMatchObject({
        code: 'RUN_EXISTS',
        retryable: false,
      });
      await expect(store.createRun(run({ conversationId: 'missing' }))).rejects.toMatchObject({
        code: 'CONVERSATION_NOT_FOUND',
      });
      await expect(store.createRun(run({ projectId: 'other-project' }))).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      await expect(store.createRun(run({ status: 'running' }))).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      await expect(store.getRun('missing')).resolves.toBeNull();

      // Transitions with the expectedStatus CAS and monotonic counters.
      const started = await store.transitionRun({
        runId: 'run-1',
        status: 'running',
        expectedStatus: 'queued',
        turn: 1,
        at: '2026-08-06T00:00:01.000Z',
      });
      expect(started).toMatchObject({ applied: true, record: { status: 'running', turn: 1 } });
      const miss = await store.transitionRun({
        runId: 'run-1',
        status: 'succeeded',
        expectedStatus: 'queued',
        at: '2026-08-06T00:00:02.000Z',
      });
      expect(miss).toMatchObject({ applied: false });
      expect(miss.record.status).toBe('running');
      await expect(
        store.transitionRun({
          runId: 'run-1',
          status: 'succeeded',
          expectedStatus: 'running',
          turn: 0,
          at: '2026-08-06T00:00:02.000Z',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

      // Checkpoint advances turn without a status change; counters never
      // decrease and never exceed the stored bounds.
      const checkpointed = await store.checkpointRun({
        runId: 'run-1',
        turn: 2,
        at: '2026-08-06T00:00:02.000Z',
      });
      expect(checkpointed).toMatchObject({ status: 'running', turn: 2 });
      await expect(
        store.checkpointRun({ runId: 'run-1', turn: 99, at: '2026-08-06T00:00:03.000Z' }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

      // Tool calls are appended strictly sequentially and the run's toolCalls
      // counter tracks the row count atomically.
      await expect(store.appendToolCall(toolCall())).resolves.toMatchObject({
        callIndex: 0,
        status: 'pending',
        resultRef: null,
      });
      await expect(store.getRun('run-1')).resolves.toMatchObject({ toolCalls: 1 });
      await expect(store.appendToolCall(toolCall({ callIndex: 0 }))).rejects.toMatchObject({
        code: 'TOOL_CALL_APPEND_VIOLATION',
        retryable: false,
      });
      await expect(store.appendToolCall(toolCall({ callIndex: 3 }))).rejects.toMatchObject({
        code: 'TOOL_CALL_APPEND_VIOLATION',
      });
      await expect(
        store.appendToolCall(toolCall({ callIndex: 1, toolName: 'nova_graph' })),
      ).resolves.toMatchObject({ callIndex: 1, toolName: 'nova_graph' });
      await expect(
        store.appendToolCall(
          toolCall({ callIndex: 2, status: 'succeeded', resultRef: 'result://x' }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(
        store.appendToolCall(toolCall({ callIndex: 2, turn: 99 })),
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });

      // Pending calls complete exactly once; success requires a result ref.
      await expect(
        store.updateToolCallStatus({
          runId: 'run-1',
          callIndex: 0,
          status: 'succeeded',
          resultRef: null,
          at: '2026-08-06T00:00:03.000Z',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(
        store.updateToolCallStatus({
          runId: 'run-1',
          callIndex: 0,
          status: 'succeeded',
          resultRef: 'result://status',
          at: '2026-08-06T00:00:03.000Z',
        }),
      ).resolves.toMatchObject({ status: 'succeeded', resultRef: 'result://status' });
      await expect(
        store.updateToolCallStatus({
          runId: 'run-1',
          callIndex: 0,
          status: 'failed',
          resultRef: null,
          at: '2026-08-06T00:00:04.000Z',
        }),
      ).rejects.toMatchObject({ code: 'ILLEGAL_TOOL_CALL_TRANSITION' });

      // Tool calls list in append order with an `after` keyset.
      await expect(store.listToolCalls({ runId: 'run-1' })).resolves.toMatchObject([
        { callIndex: 0, toolName: 'nova_status' },
        { callIndex: 1, toolName: 'nova_graph' },
      ]);
      await expect(
        store.listToolCalls({ runId: 'run-1', after: 0, limit: 1 }),
      ).resolves.toMatchObject([{ callIndex: 1 }]);

      // The run finishes with final counters; reads filter by project/status/conversation.
      const finished = await store.transitionRun({
        runId: 'run-1',
        status: 'succeeded',
        expectedStatus: 'running',
        turn: 3,
        toolCalls: 2,
        at: '2026-08-06T00:00:04.000Z',
      });
      expect(finished).toMatchObject({
        applied: true,
        record: { status: 'succeeded', turn: 3, toolCalls: 2 },
      });
      await expect(store.getRun('run-1')).resolves.toMatchObject({ status: 'succeeded' });
      await expect(store.listRuns({ projectId, status: 'succeeded' })).resolves.toHaveLength(1);
      await expect(store.listRuns({ conversationId: 'conv-1' })).resolves.toHaveLength(1);
      await expect(store.listRuns({ projectId, status: 'running' })).resolves.toHaveLength(0);
    } finally {
      await harness.dispose();
    }
  });

  it('sweeps queued/running runs to interrupted across a restart and retries explicitly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fabula-agent-restart-'));
    const databasePath = join(dir, 'workbench.sqlite');
    try {
      {
        const harness = createRealPersistence(databasePath);
        try {
          const store = createAgentStore(harness.client);
          await store.createConversation(conversation());
          await store.createRun(run({ runId: 'run-a', updatedAt: '2026-08-06T00:00:00.000Z' }));
          await store.createRun(run({ runId: 'run-b', updatedAt: '2026-08-06T00:00:00.000Z' }));
          await store.transitionRun({
            runId: 'run-b',
            status: 'running',
            expectedStatus: 'queued',
            at: '2026-08-06T00:00:01.000Z',
          });
          await store.createRun(run({ runId: 'run-c', updatedAt: '2026-08-06T00:00:00.000Z' }));
          await store.transitionRun({
            runId: 'run-c',
            status: 'running',
            expectedStatus: 'queued',
            at: '2026-08-06T00:00:01.000Z',
          });
          await store.transitionRun({
            runId: 'run-c',
            status: 'succeeded',
            expectedStatus: 'running',
            at: '2026-08-06T00:00:02.000Z',
          });
        } finally {
          await harness.dispose();
        }
      }
      {
        const harness = createRealPersistence(databasePath);
        try {
          const store = createAgentStore(harness.client);
          // The restart sweep marks only queued/running runs interrupted.
          await expect(
            store.markRunsInterrupted(projectId, '2026-08-06T00:00:03.000Z'),
          ).resolves.toEqual({ updated: 2 });
          await expect(store.getRun('run-a')).resolves.toMatchObject({
            status: 'interrupted',
            updatedAt: '2026-08-06T00:00:03.000Z',
          });
          await expect(store.getRun('run-b')).resolves.toMatchObject({ status: 'interrupted' });
          await expect(store.getRun('run-c')).resolves.toMatchObject({ status: 'succeeded' });

          // A retry is explicit: interrupted -> queued with the matching CAS.
          const retried = await store.transitionRun({
            runId: 'run-a',
            status: 'queued',
            expectedStatus: 'interrupted',
            at: '2026-08-06T00:00:04.000Z',
          });
          expect(retried).toMatchObject({ applied: true });
          expect(retried.record.status).toBe('queued');
          // The re-queued run is swept again by a later restart, terminal rows are not.
          await expect(
            store.markRunsInterrupted(projectId, '2026-08-06T00:00:05.000Z'),
          ).resolves.toEqual({ updated: 1 });
          await expect(store.getRun('run-b')).resolves.toMatchObject({ status: 'interrupted' });
          await expect(store.getRun('run-c')).resolves.toMatchObject({ status: 'succeeded' });
        } finally {
          await harness.dispose();
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never persists capability tokens or provider keys in agent records', async () => {
    const harness = createRealPersistence();
    try {
      const store = createAgentStore(harness.client);
      await store.createConversation(conversation());
      await store.createRun(run());
      await store.transitionRun({
        runId: 'run-1',
        status: 'running',
        expectedStatus: 'queued',
        at: '2026-08-06T00:00:01.000Z',
      });
      await store.appendToolCall(toolCall());
      await store.appendToolCall(
        toolCall({ callIndex: 1, toolName: 'nova_graph', sanitizedArgsHash: 'e'.repeat(64) }),
      );
      await store.updateToolCallStatus({
        runId: 'run-1',
        callIndex: 0,
        status: 'succeeded',
        resultRef: 'result://status',
        at: '2026-08-06T00:00:02.000Z',
      });

      // Every record the store returns carries principal identity + hashes
      // only: no capability token, provider key, credential or raw arguments.
      const records = [
        await store.getConversation('conv-1'),
        await store.getRun('run-1'),
        ...(await store.listToolCalls({ runId: 'run-1' })),
      ];
      const present = records.filter(
        (record): record is NonNullable<(typeof records)[number]> => record !== null,
      );
      expect(present).toHaveLength(4);
      const secretPattern = /token|secret|credential|apikey|provider|password|api_key/i;
      for (const record of present) {
        for (const key of Object.keys(record)) expect(key).not.toMatch(secretPattern);
      }
      // The only argument material stored is the sanitized sha256-shaped hash.
      for (const call of await store.listToolCalls({ runId: 'run-1' })) {
        expect(call.sanitizedArgsHash).toMatch(/^[0-9a-f]{64}$/);
      }

      // The physical tables expose no secret columns either.
      const db = new DatabaseSync(harness.databasePath, { readOnly: true });
      try {
        for (const table of ['agent_conversations', 'agent_runs', 'agent_tool_calls']) {
          const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
          for (const column of columns) expect(column.name).not.toMatch(secretPattern);
        }
      } finally {
        db.close();
      }
    } finally {
      await harness.dispose();
    }
  });
});

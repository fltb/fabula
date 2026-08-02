import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import { GIT_SUBMISSION_PHASE_COMPLETE, GIT_SUBMISSION_PHASE_CONFLICT } from '../src/contracts/persistence.js';
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
        const migrations = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[];
        expect(migrations.map(m => m.version)).toEqual([1]);
        const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='yjs_documents'").get() as { sql: string };
        expect(ddl.sql).toContain('PRIMARY KEY (project_id, document_id)');
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
      const saved = await harness.client.request('persistYjsUpdate', { projectId: 'proj-1', documentId: 'doc-1', update: first.update, stateVector: first.stateVector });
      expect(Buffer.from(saved.update).equals(Buffer.from(first.update))).toBe(true);

      const loaded = await harness.client.request('loadWorkingDocument', { projectId: 'proj-1', documentId: 'doc-1' });
      expect(loaded).not.toBeNull();
      const doc = new Y.Doc();
      Y.applyUpdate(doc, loaded.update);
      expect(doc.getText('prose').toString()).toBe('chapter one');
      expect(Buffer.from(loaded.stateVector).equals(Buffer.from(first.stateVector))).toBe(true);

      // Upsert on the same composite key replaces, and a second document coexists.
      const second = yjsUpdate('chapter one v2', 'prose');
      await harness.client.request('persistYjsUpdate', { projectId: 'proj-1', documentId: 'doc-1', update: second.update });
      await harness.client.request('persistYjsUpdate', { projectId: 'proj-1', documentId: 'doc-2', update: yjsUpdate('other', 'prose').update });
      expect(rawRowCount(harness.databasePath, 'SELECT COUNT(*) AS count FROM yjs_documents')).toBe(2);
      const reloaded = await harness.client.request('loadWorkingDocument', { projectId: 'proj-1', documentId: 'doc-1' });
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
    await harness.client.request('persistYjsUpdate', { projectId: 'proj-1', documentId: 'doc-1', update, stateVector });
    const databasePath = harness.databasePath;
    // The worker disposer must release the DatabaseSync handle before the
    // same path is reopened by the restarted harness.
    await harness.dispose();
    harness = createRealPersistence(databasePath);

    try {
      const loaded = await harness.client.request('loadWorkingDocument', { projectId: 'proj-1', documentId: 'doc-1' });
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
    await harness.client.request('persistYjsUpdate', { projectId: 'proj-1', documentId: 'doc-1', update });
    const databasePath = harness.databasePath;
    const firstDispose = harness.dispose();
    const secondDispose = harness.dispose();
    expect(secondDispose).toBe(firstDispose);
    await firstDispose;

    harness = createRealPersistence(databasePath);
    try {
      const loaded = await harness.client.request('loadWorkingDocument', { projectId: 'proj-1', documentId: 'doc-1' });
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
      await expect(harness.client.request('getAuthState', undefined)).resolves.toEqual({ ownerUserId: null });
      const owner = await harness.client.request('bootstrapOwner', {
        userId: 'owner-1',
        displayName: 'Owner',
        passwordHash: { version: 1, algorithm: 'argon2id', saltBase64: 'c2FsdA==', hashBase64: 'aGFzaA==', memory: 64, passes: 3, parallelism: 1, tagLength: 32 },
        capabilityVersion: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      expect(owner.role).toBe('owner');
      await expect(harness.client.request('bootstrapOwner', {
        userId: 'owner-2',
        displayName: 'Other',
        passwordHash: owner.passwordHash as never,
        capabilityVersion: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      })).rejects.toMatchObject({ code: 'OWNER_EXISTS', retryable: false });
      await expect(harness.client.request('getAuthState', undefined)).resolves.toEqual({ ownerUserId: 'owner-1' });
      await expect(harness.client.request('loadOwner', undefined)).resolves.toMatchObject({ userId: 'owner-1' });
      await expect(harness.client.request('loadUser', { userId: 'owner-1' })).resolves.toMatchObject({ userId: 'owner-1' });

      // Backoff increments persist per subject.
      await harness.client.request('recordAuthFailure', { subject: 'user:owner-1', at: '2026-01-01T00:00:00.000Z' });
      await harness.client.request('recordAuthFailure', { subject: 'user:owner-1', at: '2026-01-01T00:00:01.000Z' });
      await expect(harness.client.request('loadAuthBackoff', { subject: 'user:owner-1' })).resolves.toMatchObject({ failures: 2 });
      await harness.client.request('clearAuthBackoff', { subject: 'user:owner-1' });
      await expect(harness.client.request('loadAuthBackoff', { subject: 'user:owner-1' })).resolves.toBeNull();

      // Invite consumption is single-use and expiry-aware at the wire level.
      await harness.client.request('createInvite', { inviteId: 'inv-1', role: 'user', expiresAt: '2026-01-02T00:00:00.000Z' });
      await expect(harness.client.request('consumeInvite', { inviteId: 'inv-1', consumedAt: '2026-01-01T12:00:00.000Z' })).resolves.toMatchObject({ status: 'accepted' });
      await expect(harness.client.request('consumeInvite', { inviteId: 'inv-1', consumedAt: '2026-01-01T12:00:01.000Z' })).resolves.toEqual({ status: 'already-consumed' });
      await harness.client.request('createInvite', { inviteId: 'inv-expired', role: 'user', expiresAt: '2026-01-01T00:00:00.000Z' });
      await expect(harness.client.request('consumeInvite', { inviteId: 'inv-expired', consumedAt: '2026-01-01T12:00:00.000Z' })).resolves.toEqual({ status: 'expired' });
      await expect(harness.client.request('consumeInvite', { inviteId: 'inv-missing', consumedAt: '2026-01-01T12:00:00.000Z' })).resolves.toEqual({ status: 'not-found' });

      // Owner password reset revokes sessions and capabilities in one transaction.
      await harness.client.request('createSession', { sessionId: 's-1', userId: 'owner-1', expiresAt: '2026-02-01T00:00:00.000Z', capabilityVersion: 1 });
      await harness.client.request('createSession', { sessionId: 's-2', userId: 'owner-1', expiresAt: '2026-02-01T00:00:00.000Z', capabilityVersion: 1 });
      await harness.client.request('upsertCapability', { capabilityId: 'cap-1', userId: 'owner-1', projectId: 'proj-1', scope: ['project:read'], version: 1, expiresAt: '2026-02-01T00:00:00.000Z' });
      const reset = await harness.client.request('resetOwnerPassword', {
        userId: 'owner-1',
        passwordHash: { version: 1, algorithm: 'argon2id', saltBase64: 'c2FsdA==', hashBase64: 'bmV3aGFzaA==', memory: 64, passes: 3, parallelism: 1, tagLength: 32 },
        capabilityVersion: 2,
        at: '2026-01-01T12:00:00.000Z',
      });
      expect(reset).toMatchObject({ revokedSessions: 2, revokedCapabilities: 1 });
      expect(reset.user.capabilityVersion).toBe(2);
      await expect(harness.client.request('loadSession', { sessionId: 's-1' })).resolves.toBeNull();
      await expect(harness.client.request('loadSession', { sessionId: 's-2' })).resolves.toBeNull();
      await expect(harness.client.request('loadCapability', { capabilityId: 'cap-1' })).resolves.toMatchObject({ userId: 'owner-1', revokedAt: '2026-01-01T12:00:00.000Z' });
      await expect(harness.client.request('resetOwnerPassword', {
        userId: 'missing',
        passwordHash: reset.user.passwordHash as never,
        capabilityVersion: 1,
        at: '2026-01-01T12:00:00.000Z',
      })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await harness.dispose();
    }
  });

  it('serves loadGitSubmission over the wire, null for unknown and journal for known', async () => {
    const harness = createRealPersistence();
    try {
      await expect(harness.client.request('loadGitSubmission', { submitId: 'missing' })).resolves.toBeNull();
      await harness.client.request('beginGitSubmission', {
        submitId: 'submit-1',
        projectId: 'proj-1',
        phase: 'candidate-materialized',
        expectedGitHead: 'head-before',
        candidateCommit: 'tree-candidate',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      await expect(harness.client.request('loadGitSubmission', { submitId: 'submit-1' })).resolves.toEqual({
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
      const passwordHash = { version: 1, algorithm: 'argon2id', saltBase64: 'c2FsdA==', hashBase64: 'aGFzaA==', memory: 64, passes: 3, parallelism: 1, tagLength: 32 };
      await harness.client.request('bootstrapOwner', { userId: 'owner-1', displayName: 'Owner', passwordHash, capabilityVersion: 1, createdAt: '2026-01-01T00:00:00.000Z' });
      await harness.client.request('createInvite', { inviteId: 'inv-atomic', role: 'user', expiresAt: '2026-02-01T00:00:00.000Z' });

      // The user insert collides with the owner's primary key after the invite
      // has already been marked consumed inside the same transaction. The
      // ROLLBACK must undo the consumption and leave no partial rows.
      await expect(harness.client.request('acceptInviteUser', {
        inviteId: 'inv-atomic',
        consumedAt: '2026-01-01T12:00:00.000Z',
        userId: 'owner-1',
        displayName: 'Intruder',
        passwordHash,
        capabilityVersion: 1,
        createdAt: '2026-01-01T12:00:00.000Z',
        session: { sessionId: 's-collide', userId: 'owner-1', expiresAt: '2026-02-01T00:00:00.000Z', capabilityVersion: 1 },
      })).rejects.toMatchObject({ code: 'ERR_SQLITE_ERROR', retryable: false });

      await expect(harness.client.request('loadSession', { sessionId: 's-collide' })).resolves.toBeNull();
      await expect(harness.client.request('consumeInvite', { inviteId: 'inv-atomic', consumedAt: '2026-01-01T12:00:01.000Z' })).resolves.toMatchObject({ status: 'accepted' });
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
      expect(begun).toMatchObject({ submitId, projectId, phase: 'yjs-acked', expectedGitHead: 'base-head-1' });

      const committed = await harness.client.request('checkpointGitSubmission', {
        submitId,
        projectId,
        phase: 'commit-created',
        expectedGitHead: 'base-head-1',
        candidateCommit: receipt.commit,
        receiptHash: receipt.receiptHash,
        updatedAt: '2026-08-02T00:00:00.500Z',
      });
      expect(committed).toMatchObject({ phase: 'commit-created', candidateCommit: receipt.commit, receiptHash: receipt.receiptHash });

      await expect(harness.client.request('completeGitSubmission', receipt)).resolves.toEqual(receipt);

      // A retry of the completion returns the same stored receipt (exact-once).
      await expect(harness.client.request('completeGitSubmission', receipt)).resolves.toEqual(receipt);

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
      await expect(harness.client.request('loadGitSubmission', { submitId })).resolves.toEqual(receipt);

      // Worker restart on the same database file: the journal lookup returns
      // the same prior accepted receipt, never a second one.
      const databasePath = harness.databasePath;
      await harness.dispose();
      harness = createRealPersistence(databasePath);
      await expect(harness.client.request('loadGitSubmission', { submitId })).resolves.toEqual(receipt);
      await expect(harness.client.request('completeGitSubmission', receipt)).resolves.toEqual(receipt);
      expect(rawRowCount(databasePath, 'SELECT COUNT(*) AS count FROM git_submissions')).toBe(1);
    } finally {
      await harness.dispose();
    }
  });

  it('answers only typed domain operations through the real worker client', async () => {
    const harness = createRealPersistence();
    try {
      const client = harness.client as unknown as { request(operation: string, payload: unknown): Promise<unknown> };
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
      expect(recorded).toMatchObject({ phase: GIT_SUBMISSION_PHASE_CONFLICT, candidateCommit: 'candidate-commit-2' });
      await expect(harness.client.request('loadGitSubmission', { submitId })).resolves.toMatchObject({ phase: GIT_SUBMISSION_PHASE_CONFLICT });

      const databasePath = harness.databasePath;
      await harness.dispose();
      harness = createRealPersistence(databasePath);
      // After a restart the same submitId replays the same typed conflict; a
      // completion of a non-accepted submit stays a no-op failure, never a receipt.
      await expect(harness.client.request('loadGitSubmission', { submitId })).resolves.toMatchObject({ phase: GIT_SUBMISSION_PHASE_CONFLICT });
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

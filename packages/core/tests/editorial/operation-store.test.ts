// ============================================================================
// OperationStore — V1 lifecycle tests
//
// All tests use FakeClock, MemoryStorage, and ProjectTransactionCoordinator.
// No live LLM, filesystem, or network access.
// ============================================================================

import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  OperationStore,
  ProjectTransactionCoordinator,
  resolveProjectPaths,
  stableJson,
} from '../../src/editorial/index.ts';
import type { ProjectPaths } from '../../src/editorial/paths.ts';
import { StorageConflictError } from '../../src/errors.ts';
import { computeContentHash } from '../../src/storage/hash.ts';
import { MemoryStorage } from '../../src/storage/memory-storage.ts';
import type {
  Clock,
  EditorialError,
  EditorialOperationKind,
  EditorialOperationV1,
} from '../../src/types/editorial.ts';

// ─── Fake Clock ────────────────────────────────────────────────────────────

class FakeClock implements Clock {
  private _now: number;

  constructor(initialTime?: number) {
    this._now = initialTime ?? Date.parse('2026-07-28T00:00:00.000Z');
  }

  now(): number {
    return this._now;
  }

  advance(ms: number): void {
    this._now += ms;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const TEST_ACTOR = 'test-worker';
const BASE_TIME = Date.parse('2026-07-28T00:00:00.000Z');

function sha256Hex(): string {
  return crypto.randomBytes(32).toString('hex');
}

function uuid(): string {
  return crypto.randomUUID();
}

function makePaths(): ProjectPaths {
  return resolveProjectPaths('/test-project');
}

function makeStore(): { store: OperationStore; clock: FakeClock; storage: MemoryStorage } {
  const clock = new FakeClock(BASE_TIME);
  const storage = new MemoryStorage();
  const coordinator = new ProjectTransactionCoordinator(storage, makePaths());
  const store = new OperationStore(coordinator, makePaths(), clock);
  return { store, clock, storage };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('OperationStore', () => {
  describe('register', () => {
    it('creates a new running operation with 30m lease', () => {
      const { store } = makeStore();
      const opId = uuid();
      const rhs = sha256Hex();

      const op = store.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: rhs,
      });

      expect(op.operationId).toBe(opId);
      expect(op.kind).toBe('render');
      expect(op.actorId).toBe(TEST_ACTOR);
      expect(op.requestHash).toBe(rhs);
      expect(op.status).toBe('running');
      expect(op.startedAt).toBe('2026-07-28T00:00:00.000Z');
      expect(op.heartbeatAt).toBe('2026-07-28T00:00:00.000Z');
      expect(op.leaseExpiresAt).toBe('2026-07-28T00:30:00.000Z');
      expect(op.result).toBeNull();
      expect(op.errors).toEqual([]);
      expect(op.lastSequence).toBeUndefined();
      expect(op.completedAt).toBeUndefined();
    });

    it('returns existing terminal operation with same ID and hash (idempotent)', () => {
      const { store, clock } = makeStore();
      const opId = uuid();
      const rhs = sha256Hex();

      store.register({ operationId: opId, kind: 'revise', actorId: TEST_ACTOR, requestHash: rhs });
      clock.advance(1000);
      store.succeed(opId, TEST_ACTOR, null);

      const result = store.register({
        operationId: opId,
        kind: 'revise',
        actorId: TEST_ACTOR,
        requestHash: rhs,
      });

      expect(result.status).toBe('succeeded');
      expect(result.lastSequence).toBe(1);
    });

    it('returns existing interrupted operation with same ID and hash', () => {
      const { store, clock } = makeStore();
      const opId = uuid();
      const rhs = sha256Hex();

      // Create and let lease expire
      store.register({ operationId: opId, kind: 'render', actorId: TEST_ACTOR, requestHash: rhs });
      clock.advance(31 * 60 * 1000);

      // Re-register with same hash — recovers expired running to interrupted, creates new
      const result = store.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: rhs,
      });

      // The new operation is running
      expect(result.status).toBe('running');
      expect(result.requestHash).toBe(rhs);
    });

    it('throws INVALID_OPERATION when same ID, different hash, and terminal', () => {
      const { store } = makeStore();
      const opId = uuid();
      const rhs1 = sha256Hex();

      store.register({ operationId: opId, kind: 'render', actorId: TEST_ACTOR, requestHash: rhs1 });
      store.succeed(opId, TEST_ACTOR, null);

      expect(() =>
        store.register({
          operationId: opId,
          kind: 'render',
          actorId: TEST_ACTOR,
          requestHash: sha256Hex(),
        }),
      ).toThrow(/completed or interrupted with a different request/);
    });

    it('throws INVALID_OPERATION when same ID, different hash, and interrupted still exists', () => {
      const { store, clock } = makeStore();
      const opId = uuid();
      const rhs1 = sha256Hex();

      store.register({ operationId: opId, kind: 'render', actorId: TEST_ACTOR, requestHash: rhs1 });

      // Expire lease then register with different hash — triggers recovery + creation
      clock.advance(31 * 60 * 1000);
      store.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });

      // Now operation is running with different hash. Succeed it.
      store.succeed(opId, TEST_ACTOR, null);

      // Try to register with original hash — should fail because terminal has different hash
      expect(() =>
        store.register({
          operationId: opId,
          kind: 'render',
          actorId: TEST_ACTOR,
          requestHash: rhs1,
        }),
      ).toThrow(/completed or interrupted with a different request/);
    });

    it('throws OPERATION_IN_PROGRESS on running unexpired operation with same hash', () => {
      const { store } = makeStore();
      const opId = uuid();
      const rhs = sha256Hex();

      store.register({ operationId: opId, kind: 'render', actorId: TEST_ACTOR, requestHash: rhs });

      expect(() =>
        store.register({
          operationId: opId,
          kind: 'render',
          actorId: TEST_ACTOR,
          requestHash: rhs,
        }),
      ).toThrow(/already running/);
    });

    it('throws OPERATION_IN_PROGRESS on running unexpired operation with different hash', () => {
      const { store } = makeStore();
      const opId = uuid();
      const rhs1 = sha256Hex();

      store.register({ operationId: opId, kind: 'render', actorId: TEST_ACTOR, requestHash: rhs1 });

      expect(() =>
        store.register({
          operationId: opId,
          kind: 'render',
          actorId: TEST_ACTOR,
          requestHash: sha256Hex(),
        }),
      ).toThrow(/running with a different request/);
    });

    it('recovers expired running to interrupted and creates new running (same hash)', () => {
      const { store, clock, storage } = makeStore();
      const opId = uuid();
      const rhs = sha256Hex();

      store.register({ operationId: opId, kind: 'render', actorId: TEST_ACTOR, requestHash: rhs });
      clock.advance(31 * 60 * 1000);

      const result = store.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: rhs,
      });

      expect(result.status).toBe('running');
      expect(result.requestHash).toBe(rhs);
      expect(result.startedAt).toBe('2026-07-28T00:31:00.000Z');

      // Conflict evidence was written
      const paths = makePaths();
      const conflictDir = storage.resolvePath(paths.conflictsDir);
      const conflicts = storage.listFiles(conflictDir);
      expect(conflicts.length).toBeGreaterThan(0);
      const conflictContent = JSON.parse(storage.read(conflictDir + '/' + conflicts[0]));
      expect(conflictContent.operationId).toBe(opId);
      expect(conflictContent.previousStatus).toBe('running');
    });

    it('recovers expired running to interrupted and creates new (different hash)', () => {
      const { store, clock } = makeStore();
      const opId = uuid();

      store.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      clock.advance(31 * 60 * 1000);

      const rhs2 = sha256Hex();
      const result = store.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: rhs2,
      });

      expect(result.status).toBe('running');
      expect(result.requestHash).toBe(rhs2);
    });

    it('overwrites orphaned malformed persisted record', () => {
      const { store, storage } = makeStore();
      const opId = uuid();
      const rhs = sha256Hex();
      const paths = makePaths();
      const dir = storage.resolvePath(paths.operationsDir);
      storage.mkdirp(paths.operationsDir);
      storage.write(dir + '/' + opId + '.json', 'not valid json');

      const result = store.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: rhs,
      });

      expect(result.status).toBe('running');
      expect(result.operationId).toBe(opId);
    });

    it('succeeds when re-registering after interrupted+promote+succeed (idempotent)', () => {
      const { store, clock } = makeStore();
      const opId = uuid();
      const rhs = sha256Hex();

      store.register({ operationId: opId, kind: 'render', actorId: TEST_ACTOR, requestHash: rhs });
      clock.advance(31 * 60 * 1000);

      // Recover and create new
      store.register({ operationId: opId, kind: 'render', actorId: TEST_ACTOR, requestHash: rhs });
      clock.advance(1000);

      // Succeed
      store.succeed(opId, TEST_ACTOR, null);

      // Re-register — should be idempotent
      const result = store.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: rhs,
      });

      expect(result.status).toBe('succeeded');
    });

    it('rejects different hash on interrupted operation', () => {
      const { storage } = makeStore();
      const opId = uuid();
      const rhs = sha256Hex();
      const paths = makePaths();

      const dir = storage.resolvePath(paths.operationsDir);
      storage.mkdirp(paths.operationsDir);
      const interruptedOp: EditorialOperationV1 = {
        version: 1,
        operationId: opId,
        kind: 'render',
        actorId: 'worker-a',
        requestHash: rhs,
        status: 'interrupted',
        startedAt: '2026-07-28T00:00:00.000Z',
        heartbeatAt: '2026-07-28T00:00:00.000Z',
        leaseExpiresAt: '2026-07-28T00:30:00.000Z',
        completedAt: '2026-07-28T01:00:00.000Z',
        result: null,
        errors: [{ code: 'OPERATION_INTERRUPTED' as const, message: 'expired', operationId: opId }],
      };
      storage.write(dir + '/' + opId + '.json', stableJson(interruptedOp));

      const coordinator = new ProjectTransactionCoordinator(storage, paths);
      const store = new OperationStore(coordinator, paths, new FakeClock(BASE_TIME));

      expect(() =>
        store.register({
          operationId: opId,
          kind: 'render',
          actorId: 'worker-b',
          requestHash: sha256Hex(),
        }),
      ).toThrow(/completed or interrupted with a different request/);
    });

    it('recovers missing active operation from publication manifest', () => {
      const { store, storage } = makeStore();
      const opId = uuid();
      const rhs = sha256Hex();
      const paths = makePaths();

      // Set up publication manifest referencing a missing operation
      storage.mkdirp(paths.workDir);
      storage.write(
        paths.publicationPath,
        stableJson({
          version: 1,
          status: 'current',
          branch_scope_hash: 'test-scope',
          novel_hash: null,
          revision_ids: {},
          last_assembled_at: null,
          active_operation_id: opId,
          reasons: [],
        }),
      );

      // Register with same operationId — should recover the stale reference
      const result = store.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: rhs,
      });

      expect(result.status).toBe('running');

      // Conflict evidence was written for the missing operation
      const conflictDir = storage.resolvePath(paths.conflictsDir);
      const conflicts = storage.listFiles(conflictDir);
      expect(conflicts.length).toBeGreaterThan(0);
      const conflictContent = JSON.parse(storage.read(conflictDir + '/' + conflicts[0]));
      expect(conflictContent.reason).toMatch(/missing/);

      // Recovery evidence remains stale while the replacement operation owns the lease.
      const pub = JSON.parse(storage.read(paths.publicationPath));
      expect(pub.status).toBe('stale');
      expect(pub.active_operation_id).toBe(opId);
    });

    it('recovers malformed active operation from publication manifest', () => {
      const { store, storage } = makeStore();
      const opId = uuid();
      const rhs = sha256Hex();
      const paths = makePaths();

      // Set up publication manifest referencing the operation
      storage.mkdirp(paths.workDir);
      storage.write(
        paths.publicationPath,
        stableJson({
          version: 1,
          status: 'current',
          branch_scope_hash: 'test-scope',
          novel_hash: null,
          revision_ids: {},
          last_assembled_at: null,
          active_operation_id: opId,
          reasons: [],
        }),
      );

      // Write a malformed operation file
      const dir = storage.resolvePath(paths.operationsDir);
      storage.mkdirp(paths.operationsDir);
      storage.write(dir + '/' + opId + '.json', 'not valid json');

      // Register — should recover and create new
      const result = store.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: rhs,
      });

      expect(result.status).toBe('running');

      // Conflict evidence was written
      const conflictDir = storage.resolvePath(paths.conflictsDir);
      const conflicts = storage.listFiles(conflictDir);
      expect(conflicts.length).toBeGreaterThan(0);
    });
  });

  describe('get', () => {
    it('returns a parsed operation by ID', () => {
      const { store } = makeStore();
      const opId = uuid();

      store.register({
        operationId: opId,
        kind: 'revise',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });

      const loaded = store.get(opId);
      expect(loaded.operationId).toBe(opId);
      expect(loaded.status).toBe('running');
    });

    it('throws on missing operation', () => {
      const { store } = makeStore();
      expect(() => store.get('nonexistent-id')).toThrow();
    });

    it('throws on malformed operation file', () => {
      const { store, storage } = makeStore();
      const opId = uuid();
      const paths = makePaths();
      const dir = storage.resolvePath(paths.operationsDir);
      storage.mkdirp(paths.operationsDir);
      storage.write(dir + '/' + opId + '.json', '{bad json}');

      expect(() => store.get(opId)).toThrow(/Malformed operation record/);
    });
  });

  describe('list', () => {
    it('returns empty array when no operations', () => {
      const { store } = makeStore();
      expect(store.list()).toEqual([]);
    });

    it('returns operations sorted by startedAt', () => {
      const { store, clock } = makeStore();
      const rhs = sha256Hex();

      const idA = uuid();
      store.register({ operationId: idA, kind: 'render', actorId: TEST_ACTOR, requestHash: rhs });
      clock.advance(5000);

      const idB = uuid();
      store.register({
        operationId: idB,
        kind: 'revise',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      clock.advance(2000);

      const idC = uuid();
      store.register({
        operationId: idC,
        kind: 'render_tree',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });

      const ops = store.list();
      expect(ops).toHaveLength(3);
      expect(ops[0].operationId).toBe(idA);
      expect(ops[1].operationId).toBe(idB);
      expect(ops[2].operationId).toBe(idC);
    });

    it('skips non-JSON files and _sequence', () => {
      const { store, storage } = makeStore();
      const opId = uuid();

      store.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });

      const paths = makePaths();
      const dir = storage.resolvePath(paths.operationsDir);
      storage.write(dir + '/readme.txt', 'not an operation');
      storage.write(dir + '/_sequence', '1\n');

      const ops = store.list();
      expect(ops).toHaveLength(1);
      expect(ops[0].operationId).toBe(opId);
    });

    it('skips malformed JSON files silently', () => {
      const { store, storage } = makeStore();
      const paths = makePaths();
      const dir = storage.resolvePath(paths.operationsDir);
      storage.mkdirp(paths.operationsDir);
      storage.write(dir + '/bad.json', '{bad json}');

      store.register({
        operationId: uuid(),
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });

      expect(store.list()).toHaveLength(1);
    });
  });

  describe('heartbeat', () => {
    it('extends lease and updates heartbeatAt', () => {
      const { store, clock } = makeStore();
      const opId = uuid();

      store.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      clock.advance(5 * 60 * 1000);

      const result = store.heartbeat(opId, TEST_ACTOR);

      expect(result.heartbeatAt).toBe('2026-07-28T00:05:00.000Z');
      expect(result.leaseExpiresAt).toBe('2026-07-28T00:35:00.000Z');
      expect(result.status).toBe('running');
    });

    it('throws when worker does not own the operation', () => {
      const { store } = makeStore();
      const opId = uuid();

      store.register({
        operationId: opId,
        kind: 'render',
        actorId: 'worker-a',
        requestHash: sha256Hex(),
      });

      expect(() => store.heartbeat(opId, 'worker-b')).toThrow(/does not own/);
    });

    it('throws on terminal operation', () => {
      const { store } = makeStore();
      const opId = uuid();

      store.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      store.succeed(opId, TEST_ACTOR, null);

      expect(() => store.heartbeat(opId, TEST_ACTOR)).toThrow(/Cannot heartbeat terminal/);
    });

    it('throws on interrupted operation', () => {
      const { store, clock } = makeStore();
      const opId = uuid();

      store.register({
        operationId: opId,
        kind: 'render',
        actorId: 'worker-a',
        requestHash: sha256Hex(),
      });
      clock.advance(31 * 60 * 1000);

      // Recover + create new with worker-b
      store.register({
        operationId: opId,
        kind: 'render',
        actorId: 'worker-b',
        requestHash: sha256Hex(),
      });

      // worker-a no longer owns the running operation
      expect(() => store.heartbeat(opId, 'worker-a')).toThrow(/does not own/);
    });

    it('CAS prevents concurrent recovery of the same expired operation', () => {
      const { store, clock, storage } = makeStore();
      const opId = uuid();
      const rhs = sha256Hex();
      const paths = makePaths();

      // Worker A creates a running operation
      store.register({ operationId: opId, kind: 'render', actorId: 'worker-a', requestHash: rhs });
      clock.advance(31 * 60 * 1000); // Expire lease

      // Worker A's register is still valid (stale content), but another worker
      // already recovered it. Simulate by taking the current hash and modifying
      // the file behind the store's back.
      const dir = storage.resolvePath(paths.operationsDir);
      const opPath = dir + '/' + opId + '.json';

      // Read the current stale running content and its hash
      const staleContent = storage.read(opPath);

      // Another worker recovers the operation directly (simulating concurrent recovery)
      const altCoordinator = new ProjectTransactionCoordinator(storage, paths);
      const altStore = new OperationStore(altCoordinator, paths, clock);
      altStore.register({
        operationId: opId,
        kind: 'render',
        actorId: 'worker-b',
        requestHash: rhs,
      });

      // Now try to register again with the stale content hash — CAS should fail
      // because the file content changed when worker-b recovered it.
      const op: EditorialOperationV1 = {
        version: 1,
        operationId: opId,
        kind: 'render',
        actorId: 'worker-a',
        requestHash: rhs,
        status: 'running',
        startedAt: '2026-07-28T00:31:00.000Z',
        heartbeatAt: '2026-07-28T00:31:00.000Z',
        leaseExpiresAt: '2026-07-28T01:01:00.000Z',
        result: null,
        errors: [],
      };

      // Try to write with the stale expectedHash
      expect(() =>
        storage.commitBatch({
          transactionId: uuid(),
          lockPath: paths.transactionLockPath,
          journalPath: storage.resolvePath(paths.transactionsDir) + '/' + uuid() + '.json',
          conflictDir: paths.conflictsDir,
          readSet: [],
          writes: [
            {
              type: 'put',
              path: opPath,
              content: stableJson(op),
              expectedHash: computeContentHash(staleContent),
            },
          ],
        }),
      ).toThrow(StorageConflictError);
    });
  });

  describe('promote', () => {
    it('transitions interrupted operation to running with new worker', () => {
      const { storage } = makeStore();
      const opId = uuid();
      const rhs = sha256Hex();
      const paths = makePaths();

      // Create an interrupted record directly in storage
      const dir = storage.resolvePath(paths.operationsDir);
      storage.mkdirp(paths.operationsDir);
      const interruptedOp: EditorialOperationV1 = {
        version: 1,
        operationId: opId,
        kind: 'render',
        actorId: 'worker-a',
        requestHash: rhs,
        status: 'interrupted',
        startedAt: '2026-07-28T00:00:00.000Z',
        heartbeatAt: '2026-07-28T00:00:00.000Z',
        leaseExpiresAt: '2026-07-28T00:30:00.000Z',
        completedAt: '2026-07-28T01:00:00.000Z',
        result: null,
        errors: [
          { code: 'OPERATION_INTERRUPTED' as const, message: 'Lease expired', operationId: opId },
        ],
      };
      storage.write(dir + '/' + opId + '.json', stableJson(interruptedOp));

      const coordinator = new ProjectTransactionCoordinator(storage, paths);
      const store = new OperationStore(coordinator, paths, new FakeClock(BASE_TIME));

      const promoted = store.promote(opId, 'worker-b');
      expect(promoted.status).toBe('running');
      expect(promoted.actorId).toBe('worker-b');
      expect(promoted.leaseExpiresAt).toBe('2026-07-28T00:30:00.000Z');
    });

    it('throws when operation is not interrupted', () => {
      const { store } = makeStore();
      const opId = uuid();

      store.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });

      expect(() => store.promote(opId, TEST_ACTOR)).toThrow(/Cannot promote/);
    });

    it('throws on succeeded operation', () => {
      const { store } = makeStore();
      const opId = uuid();

      store.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      store.succeed(opId, TEST_ACTOR, null);

      expect(() => store.promote(opId, TEST_ACTOR)).toThrow(/Cannot promote/);
    });
  });

  describe('terminal transitions', () => {
    describe('succeed', () => {
      it('marks operation as succeeded with lastSequence', () => {
        const { store } = makeStore();
        const opId = uuid();

        store.register({
          operationId: opId,
          kind: 'render',
          actorId: TEST_ACTOR,
          requestHash: sha256Hex(),
        });
        const result = store.succeed(opId, TEST_ACTOR, null);

        expect(result.status).toBe('succeeded');
        expect(result.lastSequence).toBe(1);
        expect(result.completedAt).toBe('2026-07-28T00:00:00.000Z');
        expect(result.result).toBeNull();
      });

      it('starts lastSequence at one for each operation', () => {
        const { store, clock } = makeStore();

        const id1 = uuid();
        store.register({
          operationId: id1,
          kind: 'render',
          actorId: TEST_ACTOR,
          requestHash: sha256Hex(),
        });
        clock.advance(1000);
        store.succeed(id1, TEST_ACTOR, null);

        const id2 = uuid();
        store.register({
          operationId: id2,
          kind: 'revise',
          actorId: TEST_ACTOR,
          requestHash: sha256Hex(),
        });
        clock.advance(1000);
        store.succeed(id2, TEST_ACTOR, null);

        expect(store.get(id1).lastSequence).toBe(1);
        expect(store.get(id2).lastSequence).toBe(1);
      });
    });

    describe('fail', () => {
      it('marks operation as failed with errors and lastSequence', () => {
        const { store } = makeStore();
        const opId = uuid();

        store.register({
          operationId: opId,
          kind: 'render',
          actorId: TEST_ACTOR,
          requestHash: sha256Hex(),
        });

        const errors: EditorialError[] = [
          { code: 'PROVIDER_REQUIRED', message: 'LLM provider not configured' },
        ];
        const result = store.fail(opId, TEST_ACTOR, errors);

        expect(result.status).toBe('failed');
        expect(result.lastSequence).toBe(1);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].code).toBe('PROVIDER_REQUIRED');
      });
    });

    describe('cancel', () => {
      it('marks operation as cancelled with lastSequence', () => {
        const { store } = makeStore();
        const opId = uuid();

        store.register({
          operationId: opId,
          kind: 'render',
          actorId: TEST_ACTOR,
          requestHash: sha256Hex(),
        });
        const result = store.cancel(opId, TEST_ACTOR);

        expect(result.status).toBe('cancelled');
        expect(result.lastSequence).toBe(1);
        expect(result.result).toBeNull();
      });
    });

    describe('ownership and status guards', () => {
      it('throws on succeed when worker does not own the operation', () => {
        const { store } = makeStore();
        const opId = uuid();

        store.register({
          operationId: opId,
          kind: 'render',
          actorId: 'worker-a',
          requestHash: sha256Hex(),
        });

        expect(() => store.succeed(opId, 'worker-b', null)).toThrow(/does not own/);
      });

      it('throws on fail when worker does not own the operation', () => {
        const { store } = makeStore();
        const opId = uuid();

        store.register({
          operationId: opId,
          kind: 'render',
          actorId: 'worker-a',
          requestHash: sha256Hex(),
        });

        expect(() => store.fail(opId, 'worker-b', [])).toThrow(/does not own/);
      });

      it('throws on cancel when worker does not own the operation', () => {
        const { store } = makeStore();
        const opId = uuid();

        store.register({
          operationId: opId,
          kind: 'render',
          actorId: 'worker-a',
          requestHash: sha256Hex(),
        });

        expect(() => store.cancel(opId, 'worker-b')).toThrow(/does not own/);
      });

      it('is idempotent when succeeding an already-succeeded operation', () => {
        const { store } = makeStore();
        const opId = uuid();

        store.register({
          operationId: opId,
          kind: 'render',
          actorId: TEST_ACTOR,
          requestHash: sha256Hex(),
        });
        const first = store.succeed(opId, TEST_ACTOR, null);
        const second = store.succeed(opId, TEST_ACTOR, null);

        expect(second.status).toBe('succeeded');
        expect(second.lastSequence).toBe(first.lastSequence);
      });

      it('is idempotent when failing an already-failed operation', () => {
        const { store } = makeStore();
        const opId = uuid();

        store.register({
          operationId: opId,
          kind: 'render',
          actorId: TEST_ACTOR,
          requestHash: sha256Hex(),
        });
        const first = store.fail(opId, TEST_ACTOR, [
          { code: 'PROVIDER_REQUIRED', message: 'no provider' },
        ]);
        const second = store.fail(opId, TEST_ACTOR, [
          { code: 'PROVIDER_REQUIRED', message: 'no provider' },
        ]);

        expect(second.status).toBe('failed');
        expect(second.lastSequence).toBe(first.lastSequence);
      });

      it('is idempotent when cancelling an already-cancelled operation', () => {
        const { store } = makeStore();
        const opId = uuid();

        store.register({
          operationId: opId,
          kind: 'render',
          actorId: TEST_ACTOR,
          requestHash: sha256Hex(),
        });
        const first = store.cancel(opId, TEST_ACTOR);
        const second = store.cancel(opId, TEST_ACTOR);

        expect(second.status).toBe('cancelled');
        expect(second.lastSequence).toBe(first.lastSequence);
      });
    });

    it('terminal transition clears active_operation_id from publication manifest', () => {
      const { store, storage } = makeStore();
      const opId = uuid();
      const rhs = sha256Hex();
      const paths = makePaths();

      store.register({ operationId: opId, kind: 'render', actorId: TEST_ACTOR, requestHash: rhs });

      // Manifest should have active_operation_id after register
      let pub = JSON.parse(storage.read(paths.publicationPath));
      expect(pub.status).toBe('stale');
      expect(pub.active_operation_id).toBe(opId);

      // Succeed — should clear active_operation_id
      store.succeed(opId, TEST_ACTOR, null);
      pub = JSON.parse(storage.read(paths.publicationPath));
      expect(pub.active_operation_id).toBeUndefined();
      expect(pub.status).toBe('stale');
    });

    it('fail clears active_operation_id from publication manifest', () => {
      const { store, storage } = makeStore();
      const opId = uuid();
      const paths = makePaths();

      store.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });

      // Manifest should have active_operation_id
      let pub = JSON.parse(storage.read(paths.publicationPath));
      expect(pub.active_operation_id).toBe(opId);

      store.fail(opId, TEST_ACTOR, [{ code: 'PROVIDER_REQUIRED', message: 'fail' }]);
      pub = JSON.parse(storage.read(paths.publicationPath));
      expect(pub.active_operation_id).toBeUndefined();
    });

    it('cancel clears active_operation_id from publication manifest', () => {
      const { store, storage } = makeStore();
      const opId = uuid();
      const paths = makePaths();

      store.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });

      let pub = JSON.parse(storage.read(paths.publicationPath));
      expect(pub.active_operation_id).toBe(opId);

      store.cancel(opId, TEST_ACTOR);
      pub = JSON.parse(storage.read(paths.publicationPath));
      expect(pub.active_operation_id).toBeUndefined();
    });
  });

  describe('checkpointSequence', () => {
    it('updates lastSequence with valid monotonic sequence', () => {
      const { store } = makeStore();
      const opId = uuid();

      store.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      store.checkpointSequence(opId, TEST_ACTOR, 5);

      const op = store.get(opId);
      expect(op.lastSequence).toBe(5);
    });

    it('rejects non-monotonic sequence', () => {
      const { store } = makeStore();
      const opId = uuid();

      store.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      store.checkpointSequence(opId, TEST_ACTOR, 5);

      expect(() => store.checkpointSequence(opId, TEST_ACTOR, 5)).toThrow(/not greater than/);
      expect(() => store.checkpointSequence(opId, TEST_ACTOR, 3)).toThrow(/not greater than/);
    });

    it('rejects when worker does not own the operation', () => {
      const { store } = makeStore();
      const opId = uuid();

      store.register({
        operationId: opId,
        kind: 'render',
        actorId: 'worker-a',
        requestHash: sha256Hex(),
      });

      expect(() => store.checkpointSequence(opId, 'worker-b', 1)).toThrow(/does not own/);
    });

    it('rejects on terminal operation', () => {
      const { store } = makeStore();
      const opId = uuid();

      store.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      store.succeed(opId, TEST_ACTOR, null);

      expect(() => store.checkpointSequence(opId, TEST_ACTOR, 1)).toThrow(
        /Cannot checkpoint terminal/,
      );
    });

    it('rejects on interrupted operation', () => {
      const { storage } = makeStore();
      const opId = uuid();
      const rhs = sha256Hex();
      const paths = makePaths();

      const dir = storage.resolvePath(paths.operationsDir);
      storage.mkdirp(paths.operationsDir);
      const interruptedOp: EditorialOperationV1 = {
        version: 1,
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: rhs,
        status: 'interrupted',
        startedAt: '2026-07-28T00:00:00.000Z',
        heartbeatAt: '2026-07-28T00:00:00.000Z',
        leaseExpiresAt: '2026-07-28T00:30:00.000Z',
        completedAt: '2026-07-28T01:00:00.000Z',
        result: null,
        errors: [{ code: 'OPERATION_INTERRUPTED' as const, message: 'expired', operationId: opId }],
      };
      storage.write(dir + '/' + opId + '.json', stableJson(interruptedOp));

      const coordinator = new ProjectTransactionCoordinator(storage, paths);
      const store = new OperationStore(coordinator, paths, new FakeClock(BASE_TIME));

      expect(() => store.checkpointSequence(opId, TEST_ACTOR, 1)).toThrow(
        /Cannot checkpoint interrupted/,
      );
    });
  });

  describe('takeover and old-worker rejection', () => {
    it('old worker heartbeat fails after operation is taken over via promote', () => {
      const { storage } = makeStore();
      const opId = uuid();
      const rhs = sha256Hex();
      const paths = makePaths();

      // Create interrupted record directly
      const dir = storage.resolvePath(paths.operationsDir);
      storage.mkdirp(paths.operationsDir);
      const interruptedOp: EditorialOperationV1 = {
        version: 1,
        operationId: opId,
        kind: 'render',
        actorId: 'worker-a',
        requestHash: rhs,
        status: 'interrupted',
        startedAt: '2026-07-28T00:00:00.000Z',
        heartbeatAt: '2026-07-28T00:00:00.000Z',
        leaseExpiresAt: '2026-07-28T00:30:00.000Z',
        completedAt: '2026-07-28T01:00:00.000Z',
        result: null,
        errors: [{ code: 'OPERATION_INTERRUPTED' as const, message: 'expired', operationId: opId }],
      };
      storage.write(dir + '/' + opId + '.json', stableJson(interruptedOp));

      const coordinator = new ProjectTransactionCoordinator(storage, paths);
      const clock = new FakeClock(BASE_TIME + 3600000);
      const store = new OperationStore(coordinator, paths, clock);

      // New worker promotes
      store.promote(opId, 'worker-b');
      expect(store.get(opId).actorId).toBe('worker-b');

      // Old worker's heartbeat fails
      expect(() => store.heartbeat(opId, 'worker-a')).toThrow(/does not own/);
    });

    it('recovery via register correctly transitions stale running', () => {
      const { store, clock, storage } = makeStore();
      const opId = uuid();
      const rhs = sha256Hex();

      store.register({ operationId: opId, kind: 'render', actorId: 'worker-a', requestHash: rhs });
      clock.advance(31 * 60 * 1000);

      // Worker B registers — triggers recovery of A's stale operation
      const result = store.register({
        operationId: opId,
        kind: 'render',
        actorId: 'worker-b',
        requestHash: rhs,
      });

      expect(result.status).toBe('running');
      expect(result.actorId).toBe('worker-b');

      // Conflict evidence was written
      const paths = makePaths();
      const conflictDir = storage.resolvePath(paths.conflictsDir);
      expect(storage.listFiles(conflictDir).length).toBeGreaterThan(0);

      // Old worker cannot heartbeat
      expect(() => store.heartbeat(opId, 'worker-a')).toThrow(/does not own/);
    });

    it('register takes over an interrupted operation with same hash', () => {
      const { storage } = makeStore();
      const opId = uuid();
      const rhs = sha256Hex();
      const paths = makePaths();

      // Create an interrupted record directly in storage
      const dir = storage.resolvePath(paths.operationsDir);
      storage.mkdirp(paths.operationsDir);
      const interruptedOp: EditorialOperationV1 = {
        version: 1,
        operationId: opId,
        kind: 'render',
        actorId: 'worker-a',
        requestHash: rhs,
        status: 'interrupted',
        startedAt: '2026-07-28T00:00:00.000Z',
        heartbeatAt: '2026-07-28T00:00:00.000Z',
        leaseExpiresAt: '2026-07-28T00:30:00.000Z',
        completedAt: '2026-07-28T01:00:00.000Z',
        result: null,
        errors: [{ code: 'OPERATION_INTERRUPTED' as const, message: 'expired', operationId: opId }],
      };
      storage.write(dir + '/' + opId + '.json', stableJson(interruptedOp));

      const coordinator = new ProjectTransactionCoordinator(storage, paths);
      const store = new OperationStore(coordinator, paths, new FakeClock(BASE_TIME));

      // Register with same hash — should transition interrupted to running
      const result = store.register({
        operationId: opId,
        kind: 'render',
        actorId: 'worker-b',
        requestHash: rhs,
      });

      expect(result.status).toBe('running');
      expect(result.actorId).toBe('worker-b');
      expect(result.requestHash).toBe(rhs);

      // Old worker cannot heartbeat
      expect(() => store.heartbeat(opId, 'worker-a')).toThrow(/does not own/);
    });
    it('recovery marks publication as stale with preserved fields', () => {
      const { store, clock, storage } = makeStore();
      const opId = uuid();
      const rhs = sha256Hex();
      const paths = makePaths();

      // Set up a publication manifest with data to preserve
      const novelHash = 'abcd1234ef567890abcd1234ef567890abcd1234ef567890abcd1234ef567890';
      const revId = uuid();
      const pubDir = storage.resolvePath(paths.workDir);
      storage.mkdirp(pubDir);
      storage.write(
        paths.publicationPath,
        stableJson({
          version: 1,
          status: 'current',
          branch_scope_hash: 'test-branch-hash',
          novel_hash: novelHash,
          revision_ids: { ch1: revId },
          last_assembled_at: '2026-07-28T00:15:00.000Z',
          reasons: [],
        }),
      );

      store.register({ operationId: opId, kind: 'render', actorId: TEST_ACTOR, requestHash: rhs });
      clock.advance(31 * 60 * 1000);

      // Trigger recovery
      store.register({ operationId: opId, kind: 'render', actorId: TEST_ACTOR, requestHash: rhs });

      // Publication was marked stale with preserved fields
      const pub = JSON.parse(storage.read(paths.publicationPath));
      expect(pub.status).toBe('stale');
      expect(pub.novel_hash).toBe(novelHash);
      expect(pub.revision_ids).toEqual({ ch1: revId });
      expect(pub.last_assembled_at).toBe('2026-07-28T00:15:00.000Z');
      expect(pub.active_operation_id).toBe(opId);
      expect(pub.reasons.some((r: { code: string }) => r.code === 'OPERATION_INTERRUPTED')).toBe(
        true,
      );
    });
  });

  describe('JSON round-trip', () => {
    it('operation survives register → get round-trip', () => {
      const { store } = makeStore();
      const opId = uuid();
      const rhs = sha256Hex();

      const registered = store.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: rhs,
      });
      const loaded = store.get(opId);

      expect(loaded.operationId).toBe(registered.operationId);
      expect(loaded.kind).toBe(registered.kind);
      expect(loaded.actorId).toBe(registered.actorId);
      expect(loaded.requestHash).toBe(registered.requestHash);
      expect(loaded.status).toBe(registered.status);
      expect(loaded.startedAt).toBe(registered.startedAt);
      expect(loaded.heartbeatAt).toBe(registered.heartbeatAt);
      expect(loaded.leaseExpiresAt).toBe(registered.leaseExpiresAt);
    });

    it('operation survives register → succeed → get round-trip', () => {
      const { store } = makeStore();
      const opId = uuid();

      store.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      store.succeed(opId, TEST_ACTOR, null);

      const loaded = store.get(opId);
      expect(loaded.status).toBe('succeeded');
      expect(loaded.lastSequence).toBe(1);
      expect(loaded.completedAt).toBeDefined();
    });

    it('operation survives register → fail → get round-trip', () => {
      const { store } = makeStore();
      const opId = uuid();

      store.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      store.fail(opId, TEST_ACTOR, [{ code: 'PROVIDER_REQUIRED', message: 'no provider' }]);

      const loaded = store.get(opId);
      expect(loaded.status).toBe('failed');
      expect(loaded.errors).toHaveLength(1);
    });
  });
});

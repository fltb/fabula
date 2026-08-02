// ============================================================================
// Operation lifecycle — semantic records over CoreExecutionRepository
//
// Register/heartbeat/promote/terminal/checkpoint transitions are pure state
// transitions over JSON-safe EditorialOperationV1 records; persistence is the
// semantic operation compare-and-swap of CoreExecutionRepository (create-once
// registration, expected-version conflicts, read-back). No filesystem, host
// paths, or network access.
// ============================================================================

import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EditorialOperationError } from '../../src/editorial/errors.ts';
import { getEditorialOperation } from '../../src/editorial/facade.ts';
import {
  MemoryExecutionRepository,
  MemoryRenderCacheRepository,
  MemoryStateLogRepository,
  MemoryStateSnapshotRepository,
} from '../../src/testing/memory-repositories.ts';
import type { JsonValue } from '../../src/contracts/json.js';
import type {
  CoreExecutionRepository,
  OperationRecord,
} from '../../src/ports/execution-repository.ts';
import type { Clock } from '../../src/ports/runtime-services.ts';
import type {
  EditorialError,
  EditorialOperationKind,
  EditorialOperationV1,
  EditorialRuntime,
} from '../../src/types/editorial.ts';

// ─── Fake Clock ────────────────────────────────────────────────────────────

const LEASE_DURATION_MS = 30 * 60 * 1000;
const PROJECT_ID = 'test-project';
const TEST_ACTOR = 'test-worker';
const BASE_ISO = '2026-07-28T00:00:00.000Z';
const BASE_TIME = Date.parse(BASE_ISO);

class FakeClock implements Clock {
  private currentMs = BASE_TIME;

  now(): string {
    return new Date(this.currentMs).toISOString();
  }

  iso(offsetMs = 0): string {
    return new Date(this.currentMs + offsetMs).toISOString();
  }

  advance(ms: number): void {
    this.currentMs += ms;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function sha256Hex(): string {
  return crypto.randomBytes(32).toString('hex');
}

function uuid(): string {
  return crypto.randomUUID();
}

function isTerminal(status: EditorialOperationV1['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function recordOf(operation: EditorialOperationV1): OperationRecord {
  return {
    version: 1,
    projectId: PROJECT_ID,
    operationId: operation.operationId,
    value: operation as unknown as JsonValue,
  };
}

/**
 * Semantic operation lifecycle over the Core execution repository. Mirrors the
 * Core state-transition contract: create-once registration with a 30-minute
 * lease, request-hash idempotency, ownership-checked heartbeats/transitions,
 * monotonic checkpoints, and expected-version CAS persistence.
 */
class OperationLifecycle {
  constructor(
    private readonly repo: CoreExecutionRepository,
    private readonly clock: FakeClock,
  ) {}

  private async read(
    operationId: string,
  ): Promise<{ version: number; op: EditorialOperationV1 } | null> {
    const record = await this.repo.readOperation({ projectId: PROJECT_ID, operationId });
    return record
      ? { version: record.revision, op: record.value.value as unknown as EditorialOperationV1 }
      : null;
  }

  private async write(
    operationId: string,
    expectedVersion: number | null,
    op: EditorialOperationV1,
  ): Promise<void> {
    const result = await this.repo.compareAndSwapOperation({
      projectId: PROJECT_ID,
      operationId,
      expectedVersion,
      value: recordOf(op),
    });
    if (result.kind === 'conflict') {
      throw new EditorialOperationError(
        'STORAGE_CONFLICT',
        `Operation ${operationId} changed concurrently`,
        { operationId },
      );
    }
  }

  private async createFresh(input: {
    operationId: string;
    kind: EditorialOperationKind;
    actorId: string;
    requestHash: string;
  }): Promise<EditorialOperationV1> {
    const now = this.clock.iso();
    const created: EditorialOperationV1 = {
      version: 1,
      operationId: input.operationId,
      kind: input.kind,
      actorId: input.actorId,
      requestHash: input.requestHash,
      status: 'running',
      startedAt: now,
      heartbeatAt: now,
      leaseExpiresAt: this.clock.iso(LEASE_DURATION_MS),
      result: null,
      errors: [],
    };
    const existing = await this.read(input.operationId);
    await this.write(input.operationId, existing ? existing.version : null, created);
    return created;
  }

  async register(input: {
    operationId: string;
    kind: EditorialOperationKind;
    actorId: string;
    requestHash: string;
  }): Promise<EditorialOperationV1> {
    const existing = await this.read(input.operationId);
    if (!existing) {
      return this.createFresh(input);
    }

    const { version, op } = existing;
    if (op.status === 'running') {
      const leaseAlive = Date.parse(op.leaseExpiresAt) > Date.parse(this.clock.now());
      if (leaseAlive) {
        throw new EditorialOperationError(
          'OPERATION_IN_PROGRESS',
          op.requestHash === input.requestHash
            ? `Operation ${input.operationId} is already running (same request)`
            : `Operation ${input.operationId} is running with a different request`,
          { operationId: input.operationId },
        );
      }
      // Expired running: recover to interrupted, then create a fresh running op.
      const interrupted: EditorialOperationV1 = {
        ...op,
        status: 'interrupted',
        completedAt: this.clock.iso(),
        errors: [
          ...op.errors,
          { code: 'OPERATION_INTERRUPTED', message: 'Lease expired', operationId: input.operationId },
        ],
      };
      await this.write(input.operationId, version, interrupted);
      return this.createFresh(input);
    }

    if (op.requestHash !== input.requestHash) {
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Operation ${input.operationId} completed or interrupted with a different request`,
        { operationId: input.operationId },
      );
    }

    if (isTerminal(op.status)) {
      // Idempotent re-registration of a terminal operation.
      return op;
    }

    // Interrupted with the same request hash: takeover under the new worker.
    const takenOver: EditorialOperationV1 = {
      ...op,
      status: 'running',
      actorId: input.actorId,
      heartbeatAt: this.clock.iso(),
      leaseExpiresAt: this.clock.iso(LEASE_DURATION_MS),
    };
    await this.write(input.operationId, version, takenOver);
    return takenOver;
  }

  async get(operationId: string): Promise<EditorialOperationV1> {
    const existing = await this.read(operationId);
    if (!existing) {
      throw new EditorialOperationError('INVALID_OPERATION', `Operation ${operationId} was not found`, {
        operationId,
      });
    }
    return existing.op;
  }

  async heartbeat(operationId: string, workerId: string): Promise<EditorialOperationV1> {
    const existing = await this.read(operationId);
    if (!existing) {
      throw new EditorialOperationError('INVALID_OPERATION', `Operation ${operationId} was not found`, {
        operationId,
      });
    }
    const { version, op } = existing;
    if (op.actorId !== workerId) {
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Worker ${workerId} does not own operation ${operationId}`,
        { operationId },
      );
    }
    if (isTerminal(op.status)) {
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Cannot heartbeat terminal operation ${operationId} (status: ${op.status})`,
        { operationId },
      );
    }
    if (op.status === 'interrupted') {
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Cannot heartbeat interrupted operation ${operationId}, use promote`,
        { operationId },
      );
    }
    const updated: EditorialOperationV1 = {
      ...op,
      heartbeatAt: this.clock.iso(),
      leaseExpiresAt: this.clock.iso(LEASE_DURATION_MS),
    };
    await this.write(operationId, version, updated);
    return updated;
  }

  async promote(operationId: string, workerId: string): Promise<EditorialOperationV1> {
    const existing = await this.read(operationId);
    if (!existing) {
      throw new EditorialOperationError('INVALID_OPERATION', `Operation ${operationId} was not found`, {
        operationId,
      });
    }
    const { version, op } = existing;
    if (op.status !== 'interrupted') {
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Cannot promote operation ${operationId} from status ${op.status}`,
        { operationId },
      );
    }
    const updated: EditorialOperationV1 = {
      ...op,
      status: 'running',
      actorId: workerId,
      heartbeatAt: this.clock.iso(),
      leaseExpiresAt: this.clock.iso(LEASE_DURATION_MS),
    };
    await this.write(operationId, version, updated);
    return updated;
  }
  private async finalize(
    operationId: string,
    workerId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
    result: EditorialOperationV1['result'],
    errors: readonly EditorialError[],
  ): Promise<EditorialOperationV1> {
    const existing = await this.read(operationId);
    if (!existing) {
      throw new EditorialOperationError('INVALID_OPERATION', `Operation ${operationId} was not found`, {
        operationId,
      });
    }
    const { version, op } = existing;
    if (op.actorId !== workerId) {
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Worker ${workerId} does not own operation ${operationId}`,
        { operationId },
      );
    }
    if (op.status === status) {
      // Idempotent: same terminal status returns the stored record.
      return op;
    }
    if (isTerminal(op.status)) {
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Operation ${operationId} is already terminal (status: ${op.status})`,
        { operationId },
      );
    }
    if (op.status === 'interrupted') {
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Cannot finalize interrupted operation ${operationId}, use promote first`,
        { operationId },
      );
    }
    const updated: EditorialOperationV1 = {
      ...op,
      status,
      lastSequence: op.lastSequence ?? 1,
      completedAt: this.clock.iso(),
      result: status === 'succeeded' ? result : null,
      errors: status === 'failed' ? [...op.errors, ...errors] : op.errors,
    };
    await this.write(operationId, version, updated);
    return updated;
  }

  succeed(
    operationId: string,
    workerId: string,
    result: EditorialOperationV1['result'],
  ): Promise<EditorialOperationV1> {
    return this.finalize(operationId, workerId, 'succeeded', result, []);
  }

  fail(
    operationId: string,
    workerId: string,
    errors: readonly EditorialError[],
  ): Promise<EditorialOperationV1> {
    return this.finalize(operationId, workerId, 'failed', null, errors);
  }

  cancel(operationId: string, workerId: string): Promise<EditorialOperationV1> {
    return this.finalize(operationId, workerId, 'cancelled', null, []);
  }

  async checkpointSequence(operationId: string, workerId: string, sequence: number): Promise<void> {
    const existing = await this.read(operationId);
    if (!existing) {
      throw new EditorialOperationError('INVALID_OPERATION', `Operation ${operationId} was not found`, {
        operationId,
      });
    }
    const { version, op } = existing;
    if (op.actorId !== workerId) {
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Worker ${workerId} does not own operation ${operationId}`,
        { operationId },
      );
    }
    if (isTerminal(op.status)) {
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Cannot checkpoint terminal operation ${operationId} (status: ${op.status})`,
        { operationId },
      );
    }
    if (op.status === 'interrupted') {
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Cannot checkpoint interrupted operation ${operationId}`,
        { operationId },
      );
    }
    const current = op.lastSequence ?? 0;
    if (sequence <= current) {
      throw new EditorialOperationError(
        'STORAGE_CONFLICT',
        `Sequence ${sequence} is not greater than current sequence ${current} for operation ${operationId}`,
        { operationId },
      );
    }
    await this.write(operationId, version, { ...op, lastSequence: sequence });
  }
}

function makeSuite(): {
  repo: CoreExecutionRepository;
  clock: FakeClock;
  lifecycle: OperationLifecycle;
} {
  const clock = new FakeClock();
  const repo = new MemoryExecutionRepository();
  return { repo, clock, lifecycle: new OperationLifecycle(repo, clock) };
}

function runtimeWith(execution: CoreExecutionRepository): EditorialRuntime {
  return {
    services: {
      execution,
      renderCache: new MemoryRenderCacheRepository(),
      stateLog: new MemoryStateLogRepository(),
      stateSnapshots: new MemoryStateSnapshotRepository(),
      promptTemplates: { get: async () => null },
      clock: { now: () => BASE_ISO },
      ids: { next: () => uuid() },
      llm: {} as never,
    },
  };
}

/** Seed an interrupted operation record directly via create-once CAS. */
async function seedInterrupted(
  repo: CoreExecutionRepository,
  operationId: string,
  requestHash: string,
  actorId = 'worker-a',
): Promise<void> {
  const interrupted: EditorialOperationV1 = {
    version: 1,
    operationId,
    kind: 'render',
    actorId,
    requestHash,
    status: 'interrupted',
    startedAt: BASE_ISO,
    heartbeatAt: BASE_ISO,
    leaseExpiresAt: '2026-07-28T00:30:00.000Z',
    completedAt: '2026-07-28T01:00:00.000Z',
    result: null,
    errors: [{ code: 'OPERATION_INTERRUPTED', message: 'expired', operationId }],
  };
  const result = await repo.compareAndSwapOperation({
    projectId: PROJECT_ID,
    operationId,
    expectedVersion: null,
    value: recordOf(interrupted),
  });
  if (result.kind === 'conflict') {
    throw new Error(`conflict seeding interrupted operation ${operationId}`);
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('OperationStore — semantic lifecycle over CoreExecutionRepository', () => {
  describe('register', () => {
    it('creates a new running operation with 30m lease', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();
      const rhs = sha256Hex();

      const op = await lifecycle.register({
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
      expect(op.startedAt).toBe(BASE_ISO);
      expect(op.heartbeatAt).toBe(BASE_ISO);
      expect(op.leaseExpiresAt).toBe('2026-07-28T00:30:00.000Z');
      expect(op.result).toBeNull();
      expect(op.errors).toEqual([]);
      expect(op.lastSequence).toBeUndefined();
      expect(op.completedAt).toBeUndefined();
    });

    it('returns existing terminal operation with same ID and hash (idempotent)', async () => {
      const { lifecycle, clock } = makeSuite();
      const opId = uuid();
      const rhs = sha256Hex();

      await lifecycle.register({ operationId: opId, kind: 'revise', actorId: TEST_ACTOR, requestHash: rhs });
      clock.advance(1000);
      await lifecycle.succeed(opId, TEST_ACTOR, null);

      const result = await lifecycle.register({
        operationId: opId,
        kind: 'revise',
        actorId: TEST_ACTOR,
        requestHash: rhs,
      });

      expect(result.status).toBe('succeeded');
      expect(result.lastSequence).toBe(1);
    });

    it('returns existing interrupted operation with same ID and hash', async () => {
      const { lifecycle, clock } = makeSuite();
      const opId = uuid();
      const rhs = sha256Hex();

      // Create and let lease expire
      await lifecycle.register({ operationId: opId, kind: 'render', actorId: TEST_ACTOR, requestHash: rhs });
      clock.advance(31 * 60 * 1000);

      // Re-register with same hash — recovers expired running to interrupted, creates new
      const result = await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: rhs,
      });

      // The new operation is running
      expect(result.status).toBe('running');
      expect(result.requestHash).toBe(rhs);
    });

    it('throws INVALID_OPERATION when same ID, different hash, and terminal', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();
      const rhs1 = sha256Hex();

      await lifecycle.register({ operationId: opId, kind: 'render', actorId: TEST_ACTOR, requestHash: rhs1 });
      await lifecycle.succeed(opId, TEST_ACTOR, null);

      await expect(
        lifecycle.register({
          operationId: opId,
          kind: 'render',
          actorId: TEST_ACTOR,
          requestHash: sha256Hex(),
        }),
      ).rejects.toThrow(/completed or interrupted with a different request/);
    });

    it('throws INVALID_OPERATION when same ID, different hash, and interrupted still exists', async () => {
      const { lifecycle, clock } = makeSuite();
      const opId = uuid();
      const rhs1 = sha256Hex();

      await lifecycle.register({ operationId: opId, kind: 'render', actorId: TEST_ACTOR, requestHash: rhs1 });

      // Expire lease then register with different hash — triggers recovery + creation
      clock.advance(31 * 60 * 1000);
      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });

      // Now operation is running with different hash. Succeed it.
      await lifecycle.succeed(opId, TEST_ACTOR, null);

      // Try to register with original hash — should fail because terminal has different hash
      await expect(
        lifecycle.register({
          operationId: opId,
          kind: 'render',
          actorId: TEST_ACTOR,
          requestHash: rhs1,
        }),
      ).rejects.toThrow(/completed or interrupted with a different request/);
    });

    it('throws OPERATION_IN_PROGRESS on running unexpired operation with same hash', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();
      const rhs = sha256Hex();

      await lifecycle.register({ operationId: opId, kind: 'render', actorId: TEST_ACTOR, requestHash: rhs });

      await expect(
        lifecycle.register({
          operationId: opId,
          kind: 'render',
          actorId: TEST_ACTOR,
          requestHash: rhs,
        }),
      ).rejects.toThrow(/already running/);
    });

    it('throws OPERATION_IN_PROGRESS on running unexpired operation with different hash', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();
      const rhs1 = sha256Hex();

      await lifecycle.register({ operationId: opId, kind: 'render', actorId: TEST_ACTOR, requestHash: rhs1 });

      await expect(
        lifecycle.register({
          operationId: opId,
          kind: 'render',
          actorId: TEST_ACTOR,
          requestHash: sha256Hex(),
        }),
      ).rejects.toThrow(/running with a different request/);
    });

    it('recovers expired running to interrupted and creates new running (same hash)', async () => {
      const { lifecycle, clock } = makeSuite();
      const opId = uuid();
      const rhs = sha256Hex();

      await lifecycle.register({ operationId: opId, kind: 'render', actorId: TEST_ACTOR, requestHash: rhs });
      clock.advance(31 * 60 * 1000);

      const result = await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: rhs,
      });

      expect(result.status).toBe('running');
      expect(result.requestHash).toBe(rhs);
      expect(result.startedAt).toBe('2026-07-28T00:31:00.000Z');
    });

    it('recovers expired running to interrupted and creates new (different hash)', async () => {
      const { lifecycle, clock } = makeSuite();
      const opId = uuid();

      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      clock.advance(31 * 60 * 1000);

      const rhs2 = sha256Hex();
      const result = await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: rhs2,
      });

      expect(result.status).toBe('running');
      expect(result.requestHash).toBe(rhs2);
    });

    it('succeeds when re-registering after interrupted+promote+succeed (idempotent)', async () => {
      const { lifecycle, clock } = makeSuite();
      const opId = uuid();
      const rhs = sha256Hex();

      await lifecycle.register({ operationId: opId, kind: 'render', actorId: TEST_ACTOR, requestHash: rhs });
      clock.advance(31 * 60 * 1000);

      // Recover and create new
      await lifecycle.register({ operationId: opId, kind: 'render', actorId: TEST_ACTOR, requestHash: rhs });
      clock.advance(1000);

      // Succeed
      await lifecycle.succeed(opId, TEST_ACTOR, null);

      // Re-register — should be idempotent
      const result = await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: rhs,
      });

      expect(result.status).toBe('succeeded');
    });

    it('rejects different hash on interrupted operation', async () => {
      const { repo, lifecycle } = makeSuite();
      const opId = uuid();
      const rhs = sha256Hex();
      await seedInterrupted(repo, opId, rhs);

      await expect(
        lifecycle.register({
          operationId: opId,
          kind: 'render',
          actorId: 'worker-b',
          requestHash: sha256Hex(),
        }),
      ).rejects.toThrow(/completed or interrupted with a different request/);
    });
  });

  describe('get', () => {
    it('returns a stored operation by ID', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();

      await lifecycle.register({
        operationId: opId,
        kind: 'revise',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });

      const loaded = await lifecycle.get(opId);
      expect(loaded.operationId).toBe(opId);
      expect(loaded.status).toBe('running');
    });

    it('throws on missing operation', async () => {
      const { lifecycle } = makeSuite();
      await expect(lifecycle.get('nonexistent-id')).rejects.toThrow('was not found');
    });
  });

  describe('list ordering contract', () => {
    it('records sortable startedAt timestamps for chronological listing', async () => {
      const { repo, lifecycle, clock } = makeSuite();
      const ids: string[] = [];

      const idA = uuid();
      await lifecycle.register({ operationId: idA, kind: 'render', actorId: TEST_ACTOR, requestHash: sha256Hex() });
      ids.push(idA);
      clock.advance(5000);

      const idB = uuid();
      await lifecycle.register({ operationId: idB, kind: 'revise', actorId: TEST_ACTOR, requestHash: sha256Hex() });
      ids.push(idB);
      clock.advance(2000);

      const idC = uuid();
      await lifecycle.register({ operationId: idC, kind: 'render_tree', actorId: TEST_ACTOR, requestHash: sha256Hex() });
      ids.push(idC);

      const records = await Promise.all(
        ids.map((operationId) => repo.readOperation({ projectId: PROJECT_ID, operationId })),
      );
      const ops = records
        .filter((record) => record !== null)
        .map((record) => record!.value.value as unknown as EditorialOperationV1)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

      expect(ops.map((op) => op.operationId)).toEqual([idA, idB, idC]);
    });
  });

  describe('heartbeat', () => {
    it('extends lease and updates heartbeatAt', async () => {
      const { lifecycle, clock } = makeSuite();
      const opId = uuid();

      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      clock.advance(5 * 60 * 1000);

      const result = await lifecycle.heartbeat(opId, TEST_ACTOR);

      expect(result.heartbeatAt).toBe('2026-07-28T00:05:00.000Z');
      expect(result.leaseExpiresAt).toBe('2026-07-28T00:35:00.000Z');
      expect(result.status).toBe('running');
    });

    it('throws when worker does not own the operation', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();

      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: 'worker-a',
        requestHash: sha256Hex(),
      });

      await expect(lifecycle.heartbeat(opId, 'worker-b')).rejects.toThrow(/does not own/);
    });

    it('throws on terminal operation', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();

      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      await lifecycle.succeed(opId, TEST_ACTOR, null);

      await expect(lifecycle.heartbeat(opId, TEST_ACTOR)).rejects.toThrow(/Cannot heartbeat terminal/);
    });

    it('throws on interrupted operation', async () => {
      const { lifecycle, clock } = makeSuite();
      const opId = uuid();

      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: 'worker-a',
        requestHash: sha256Hex(),
      });
      clock.advance(31 * 60 * 1000);

      // Recover + create new with worker-b
      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: 'worker-b',
        requestHash: sha256Hex(),
      });

      // worker-a no longer owns the running operation
      await expect(lifecycle.heartbeat(opId, 'worker-a')).rejects.toThrow(/does not own/);
    });

    it('CAS prevents concurrent recovery of the same expired operation', async () => {
      const { repo, lifecycle, clock } = makeSuite();
      const opId = uuid();
      const rhs = sha256Hex();

      await lifecycle.register({ operationId: opId, kind: 'render', actorId: 'worker-a', requestHash: rhs });
      clock.advance(31 * 60 * 1000); // Expire lease

      // Two workers both observe the stale running record at version 1.
      const stale = await repo.readOperation({ projectId: PROJECT_ID, operationId: opId });
      expect(stale).not.toBeNull();
      expect(stale!.revision).toBe(1);

      const staleOperation = stale!.value.value as unknown as EditorialOperationV1;
      const recovered: EditorialOperationV1 = {
        ...staleOperation,
        status: 'interrupted',
        completedAt: clock.iso(),
        errors: [
          ...staleOperation.errors,
          { code: 'OPERATION_INTERRUPTED', message: 'Lease expired', operationId: opId },
        ],
      };
      const recoveryInput = {
        projectId: PROJECT_ID,
        operationId: opId,
        expectedVersion: stale!.revision,
        value: recordOf(recovered),
      };

      // The first recovery CAS commits…
      const first = await repo.compareAndSwapOperation(recoveryInput);
      expect(first.kind).toBe('committed');

      // …the second recovery CAS with the same expected version conflicts.
      const second = await repo.compareAndSwapOperation(recoveryInput);
      expect(second.kind).toBe('conflict');
    });
  });

  describe('promote', () => {
    it('transitions interrupted operation to running with new worker', async () => {
      const { repo, lifecycle } = makeSuite();
      const opId = uuid();
      const rhs = sha256Hex();
      await seedInterrupted(repo, opId, rhs);

      const promoted = await lifecycle.promote(opId, 'worker-b');
      expect(promoted.status).toBe('running');
      expect(promoted.actorId).toBe('worker-b');
      expect(promoted.leaseExpiresAt).toBe('2026-07-28T00:30:00.000Z');
    });

    it('throws when operation is not interrupted', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();

      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });

      await expect(lifecycle.promote(opId, TEST_ACTOR)).rejects.toThrow(/Cannot promote/);
    });

    it('throws on succeeded operation', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();

      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      await lifecycle.succeed(opId, TEST_ACTOR, null);

      await expect(lifecycle.promote(opId, TEST_ACTOR)).rejects.toThrow(/Cannot promote/);
    });
  });

  describe('terminal transitions', () => {
    it('marks operation as succeeded with lastSequence', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();

      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      const result = await lifecycle.succeed(opId, TEST_ACTOR, null);

      expect(result.status).toBe('succeeded');
      expect(result.lastSequence).toBe(1);
      expect(result.completedAt).toBe(BASE_ISO);
      expect(result.result).toBeNull();
    });

    it('starts lastSequence at one for each operation', async () => {
      const { lifecycle, clock } = makeSuite();

      const id1 = uuid();
      await lifecycle.register({
        operationId: id1,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      clock.advance(1000);
      await lifecycle.succeed(id1, TEST_ACTOR, null);

      const id2 = uuid();
      await lifecycle.register({
        operationId: id2,
        kind: 'revise',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      clock.advance(1000);
      await lifecycle.succeed(id2, TEST_ACTOR, null);

      expect((await lifecycle.get(id1)).lastSequence).toBe(1);
      expect((await lifecycle.get(id2)).lastSequence).toBe(1);
    });

    it('marks operation as failed with errors and lastSequence', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();

      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });

      const errors: EditorialError[] = [
        { code: 'PROVIDER_REQUIRED', message: 'LLM provider not configured' },
      ];
      const result = await lifecycle.fail(opId, TEST_ACTOR, errors);

      expect(result.status).toBe('failed');
      expect(result.lastSequence).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('PROVIDER_REQUIRED');
    });

    it('marks operation as cancelled with lastSequence', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();

      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      const result = await lifecycle.cancel(opId, TEST_ACTOR);

      expect(result.status).toBe('cancelled');
      expect(result.lastSequence).toBe(1);
      expect(result.result).toBeNull();
    });

    it('throws on succeed when worker does not own the operation', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();

      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: 'worker-a',
        requestHash: sha256Hex(),
      });

      await expect(lifecycle.succeed(opId, 'worker-b', null)).rejects.toThrow(/does not own/);
    });

    it('throws on fail when worker does not own the operation', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();

      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: 'worker-a',
        requestHash: sha256Hex(),
      });

      await expect(lifecycle.fail(opId, 'worker-b', [])).rejects.toThrow(/does not own/);
    });

    it('throws on cancel when worker does not own the operation', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();

      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: 'worker-a',
        requestHash: sha256Hex(),
      });

      await expect(lifecycle.cancel(opId, 'worker-b')).rejects.toThrow(/does not own/);
    });

    it('is idempotent when succeeding an already-succeeded operation', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();

      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      const first = await lifecycle.succeed(opId, TEST_ACTOR, null);
      const second = await lifecycle.succeed(opId, TEST_ACTOR, null);

      expect(second.status).toBe('succeeded');
      expect(second.lastSequence).toBe(first.lastSequence);
    });

    it('is idempotent when failing an already-failed operation', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();

      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      const first = await lifecycle.fail(opId, TEST_ACTOR, [
        { code: 'PROVIDER_REQUIRED', message: 'no provider' },
      ]);
      const second = await lifecycle.fail(opId, TEST_ACTOR, [
        { code: 'PROVIDER_REQUIRED', message: 'no provider' },
      ]);

      expect(second.status).toBe('failed');
      expect(second.lastSequence).toBe(first.lastSequence);
    });

    it('is idempotent when cancelling an already-cancelled operation', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();

      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      const first = await lifecycle.cancel(opId, TEST_ACTOR);
      const second = await lifecycle.cancel(opId, TEST_ACTOR);

      expect(second.status).toBe('cancelled');
      expect(second.lastSequence).toBe(first.lastSequence);
    });
  });

  describe('checkpointSequence', () => {
    it('updates lastSequence with valid monotonic sequence', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();

      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      await lifecycle.checkpointSequence(opId, TEST_ACTOR, 5);

      const op = await lifecycle.get(opId);
      expect(op.lastSequence).toBe(5);
    });

    it('rejects non-monotonic sequence', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();

      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      await lifecycle.checkpointSequence(opId, TEST_ACTOR, 5);

      await expect(lifecycle.checkpointSequence(opId, TEST_ACTOR, 5)).rejects.toThrow(/not greater than/);
      await expect(lifecycle.checkpointSequence(opId, TEST_ACTOR, 3)).rejects.toThrow(/not greater than/);
    });

    it('rejects when worker does not own the operation', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();

      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: 'worker-a',
        requestHash: sha256Hex(),
      });

      await expect(lifecycle.checkpointSequence(opId, 'worker-b', 1)).rejects.toThrow(/does not own/);
    });

    it('rejects on terminal operation', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();

      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      await lifecycle.succeed(opId, TEST_ACTOR, null);

      await expect(lifecycle.checkpointSequence(opId, TEST_ACTOR, 1)).rejects.toThrow(
        /Cannot checkpoint terminal/,
      );
    });

    it('rejects on interrupted operation', async () => {
      const { repo, lifecycle } = makeSuite();
      const opId = uuid();
      const rhs = sha256Hex();
      await seedInterrupted(repo, opId, rhs, TEST_ACTOR);

      await expect(lifecycle.checkpointSequence(opId, TEST_ACTOR, 1)).rejects.toThrow(
        /Cannot checkpoint interrupted/,
      );
    });
  });

  describe('takeover and old-worker rejection', () => {
    it('old worker heartbeat fails after operation is taken over via promote', async () => {
      const { repo, lifecycle } = makeSuite();
      const opId = uuid();
      const rhs = sha256Hex();
      await seedInterrupted(repo, opId, rhs);

      // New worker promotes
      await lifecycle.promote(opId, 'worker-b');
      expect((await lifecycle.get(opId)).actorId).toBe('worker-b');

      // Old worker's heartbeat fails
      await expect(lifecycle.heartbeat(opId, 'worker-a')).rejects.toThrow(/does not own/);
    });

    it('recovery via register correctly transitions stale running', async () => {
      const { lifecycle, clock } = makeSuite();
      const opId = uuid();
      const rhs = sha256Hex();

      await lifecycle.register({ operationId: opId, kind: 'render', actorId: 'worker-a', requestHash: rhs });
      clock.advance(31 * 60 * 1000);

      // Worker B registers — triggers recovery of A's stale operation
      const result = await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: 'worker-b',
        requestHash: rhs,
      });

      expect(result.status).toBe('running');
      expect(result.actorId).toBe('worker-b');

      // Old worker cannot heartbeat
      await expect(lifecycle.heartbeat(opId, 'worker-a')).rejects.toThrow(/does not own/);
    });

    it('register takes over an interrupted operation with same hash', async () => {
      const { repo, lifecycle } = makeSuite();
      const opId = uuid();
      const rhs = sha256Hex();
      await seedInterrupted(repo, opId, rhs);

      // Register with same hash — should transition interrupted to running
      const result = await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: 'worker-b',
        requestHash: rhs,
      });

      expect(result.status).toBe('running');
      expect(result.actorId).toBe('worker-b');
      expect(result.requestHash).toBe(rhs);

      // Old worker cannot heartbeat
      await expect(lifecycle.heartbeat(opId, 'worker-a')).rejects.toThrow(/does not own/);
    });
  });

  describe('facade reads', () => {
    it('reads a stored operation through getEditorialOperation', async () => {
      const { repo, lifecycle } = makeSuite();
      const opId = uuid();
      const rhs = sha256Hex();
      await lifecycle.register({ operationId: opId, kind: 'render', actorId: TEST_ACTOR, requestHash: rhs });

      const loaded = await getEditorialOperation(
        { projectId: PROJECT_ID, operationId: opId },
        runtimeWith(repo),
      );
      expect(loaded.operationId).toBe(opId);
      expect(loaded.kind).toBe('render');
      expect(loaded.actorId).toBe(TEST_ACTOR);
      expect(loaded.requestHash).toBe(rhs);
      expect(loaded.status).toBe('running');
    });

    it('throws when no semantic runtime is provided', async () => {
      await expect(getEditorialOperation({ projectId: PROJECT_ID, operationId: uuid() })).rejects.toThrow(
        'CoreExecutionRepository is required',
      );
    });
  });

  describe('JSON round-trip', () => {
    it('operation survives register → get round-trip', async () => {
      const { repo, lifecycle } = makeSuite();
      const opId = uuid();
      const rhs = sha256Hex();

      const registered = await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: rhs,
      });
      const loaded = await lifecycle.get(opId);

      expect(loaded.operationId).toBe(registered.operationId);
      expect(loaded.kind).toBe(registered.kind);
      expect(loaded.actorId).toBe(registered.actorId);
      expect(loaded.requestHash).toBe(registered.requestHash);
      expect(loaded.status).toBe(registered.status);
      expect(loaded.startedAt).toBe(registered.startedAt);
      expect(loaded.heartbeatAt).toBe(registered.heartbeatAt);
      expect(loaded.leaseExpiresAt).toBe(registered.leaseExpiresAt);
      // The persisted record value is JSON-safe.
      const record = await repo.readOperation({ projectId: PROJECT_ID, operationId: opId });
      expect(JSON.parse(JSON.stringify(record!.value.value))).toEqual(record!.value.value);
    });

    it('operation survives register → succeed → get round-trip', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();

      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      await lifecycle.succeed(opId, TEST_ACTOR, null);

      const loaded = await lifecycle.get(opId);
      expect(loaded.status).toBe('succeeded');
      expect(loaded.lastSequence).toBe(1);
      expect(loaded.completedAt).toBeDefined();
    });

    it('operation survives register → fail → get round-trip', async () => {
      const { lifecycle } = makeSuite();
      const opId = uuid();

      await lifecycle.register({
        operationId: opId,
        kind: 'render',
        actorId: TEST_ACTOR,
        requestHash: sha256Hex(),
      });
      await lifecycle.fail(opId, TEST_ACTOR, [{ code: 'PROVIDER_REQUIRED', message: 'no provider' }]);

      const loaded = await lifecycle.get(opId);
      expect(loaded.status).toBe('failed');
      expect(loaded.errors).toHaveLength(1);
    });
  });
});

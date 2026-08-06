import type {
  CoreExecutionRepository,
  CoreRuntimeServices,
  LLMProvider,
  ProjectCompilation,
  ProjectSourceSnapshotV1,
  RenderCacheRepository,
  StateLogRepository,
  StateSnapshotRepository,
} from '@novalistically/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectOperationRecordV1 } from '../src/contracts/persistence.js';
import type {
  AgentCapabilityCheckResult,
  AgentCapabilityService,
  CheckCapabilityInput,
} from '../src/host/agent/index.js';
import { createProjectCoreRuntime } from '../src/host/core-runtime.js';
import {
  createProjectOperationService,
  createRenderConcurrencyLimiter,
  type ProjectOperationService,
} from '../src/host/operation-service.js';
import { createProjectSession, type ProjectSession } from '../src/host/project-session.js';
import { createProjectOperationStore } from '../src/persistence/project-operation-store.js';
import { createRealPersistence, type RealPersistenceHarness } from './helpers/real-persistence.js';

// ─── Test doubles ────────────────────────────────────────────────────────────

function fakeServices(): CoreRuntimeServices {
  let sequence = 0;
  return {
    execution: {} as CoreExecutionRepository,
    renderCache: {} as RenderCacheRepository,
    stateLog: {} as StateLogRepository,
    stateSnapshots: {} as StateSnapshotRepository,
    promptTemplates: {
      async get() {
        return null;
      },
    },
    clock: { now: () => '2026-08-02T00:00:00.000Z' },
    ids: { next: (input) => `${input?.kind ?? 'id'}-${++sequence}` },
    llm: {} as LLMProvider,
  };
}

function makeSnapshot(sourceHash: string): ProjectSourceSnapshotV1 {
  return {
    version: 1,
    sourceHash,
    documents: [
      {
        version: 1 as const,
        logicalPath: 'definitions/test-0.yaml',
        content: 'key0: value',
        contentHash: 'content-0',
        parseResult: { status: 'parsed' as const, value: { key: 'value' } },
        diagnostics: [],
      },
    ],
  };
}

function allowedVerdict(
  userId: string,
  projectId: string,
  scopes: readonly string[],
): AgentCapabilityCheckResult {
  return {
    allowed: true,
    grant: {
      capabilityId: 'cap-1',
      userId,
      projectId,
      scopes,
      version: 1,
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  };
}

function createTestSession(projectId: string): ProjectSession {
  return createProjectSession({
    projectId,
    runtime: createProjectCoreRuntime({
      projectId,
      services: fakeServices(),
      compile: (snapshot) =>
        ({ events: snapshot.documents.length }) as unknown as ProjectCompilation,
    }),
    capabilities: {
      checkGrant: async (input: CheckCapabilityInput) =>
        allowedVerdict('user-1', projectId, ['scene:edit']),
    },
    audit: { record: () => undefined },
    derive: (input) => ({
      version: 1,
      projectId: input.projectId,
      revision: input.revision,
      sourceHash: input.snapshot?.sourceHash ?? null,
      documents: input.snapshot?.documents.length ?? 0,
      events: input.snapshot?.documents.length ?? 0,
      rendered: 0,
      pending: 0,
      blocked: 0,
      errorCount: 0,
      warningCount: 0,
      diagnostics: [],
      presence: input.presence,
      generatedAt: input.generatedAt,
    }),
    initialSource: makeSnapshot('hash-a'),
  });
}

interface ServiceFixture {
  harness: RealPersistenceHarness;
  service: ProjectOperationService;
  session: ProjectSession;
}

function createServiceFixture(
  overrides: {
    readonly projectId?: string;
    readonly maxQueuedPerProject?: number;
    readonly maxConcurrentRendersPerHost?: number;
    readonly databasePath?: string;
    readonly concurrencyLimiter?: ReturnType<typeof createRenderConcurrencyLimiter>;
  } = {},
): ServiceFixture {
  const harness = createRealPersistence(overrides.databasePath);
  const session = createTestSession(overrides.projectId ?? 'project-a');
  const service = createProjectOperationService({
    projectId: session.projectId,
    store: createProjectOperationStore(harness.client),
    session,
    limits: {
      maxQueuedPerProject: overrides.maxQueuedPerProject ?? 64,
      maxConcurrentRendersPerHost: overrides.maxConcurrentRendersPerHost ?? 2,
    },
    ...(overrides.concurrencyLimiter === undefined
      ? {}
      : { concurrencyLimiter: overrides.concurrencyLimiter }),
  });
  return { harness, service, session };
}

function gate(): { promise: Promise<void>; release: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, release: resolve };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message = 'condition',
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
}

async function waitForTerminal(
  service: ProjectOperationService,
  operationId: string,
): Promise<ProjectOperationRecordV1> {
  let record: ProjectOperationRecordV1 | null = null;
  await waitFor(async () => {
    record = await service.get(operationId);
    return record !== null && record.status !== 'queued' && record.status !== 'running';
  }, `operation ${operationId} to reach a terminal status`);
  if (record === null) throw new Error(`operation ${operationId} disappeared`);
  return record;
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  const pending = [...cleanup];
  cleanup.length = 0;
  for (const dispose of pending.reverse()) await dispose();
});

function track(fixture: ServiceFixture): ServiceFixture {
  cleanup.push(async () => {
    await fixture.service.close();
    await fixture.harness.dispose();
  });
  return fixture;
}

// ─── Queue semantics ─────────────────────────────────────────────────────────

describe('ProjectOperationService queue', () => {
  it('runs queued render operations in FIFO order with per-project concurrency 1', async () => {
    const fixture = track(createServiceFixture());
    const { service } = fixture;
    await service.start();

    const started: string[] = [];
    const finished: string[] = [];
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const makeRunner =
      (name: string) =>
      async (): Promise<{
        status: 'succeeded';
        result: string;
      }> => {
        started.push(name);
        active += 1;
        maxActive = Math.max(maxActive, active);
        const { promise, resolve } = Promise.withResolvers<void>();
        releases.push(() => {
          active -= 1;
          finished.push(name);
          resolve();
        });
        await promise;
        return { status: 'succeeded', result: name };
      };

    const first = await service.enqueue({
      kind: 'render',
      idempotencyKey: 'k1',
      actorId: 'u1',
      capabilityVersion: 1,
      sourceHash: 'hash-a',
      acceptedRevisionId: null,
      requestHash: 'r1',
      runner: makeRunner('a'),
    });
    const second = await service.enqueue({
      kind: 'render',
      idempotencyKey: 'k2',
      actorId: 'u1',
      capabilityVersion: 1,
      sourceHash: 'hash-a',
      acceptedRevisionId: null,
      requestHash: 'r2',
      runner: makeRunner('b'),
    });
    const third = await service.enqueue({
      kind: 'render',
      idempotencyKey: 'k3',
      actorId: 'u1',
      capabilityVersion: 1,
      sourceHash: 'hash-a',
      acceptedRevisionId: null,
      requestHash: 'r3',
      runner: makeRunner('c'),
    });
    expect(first.status).toBe('queued');
    expect(second.status).toBe('queued');
    expect(third.status).toBe('queued');
    if (first.status !== 'queued' || second.status !== 'queued' || third.status !== 'queued')
      return;

    await waitFor(() => started.length === 1, 'first render to start');
    expect(started).toEqual(['a']);
    expect(maxActive).toBe(1);

    const releaseA = releases[0];
    if (releaseA === undefined) throw new Error('release a missing');
    releaseA();
    await waitFor(() => started.length === 2, 'second render to start');
    expect(started).toEqual(['a', 'b']);
    expect(maxActive).toBe(1);

    const releaseB = releases[1];
    if (releaseB === undefined) throw new Error('release b missing');
    releaseB();
    await waitFor(() => started.length === 3, 'third render to start');
    expect(started).toEqual(['a', 'b', 'c']);

    const releaseC = releases[2];
    if (releaseC === undefined) throw new Error('release c missing');
    releaseC();

    expect((await waitForTerminal(service, first.operationHandle)).status).toBe('succeeded');
    expect((await waitForTerminal(service, second.operationHandle)).status).toBe('succeeded');
    expect((await waitForTerminal(service, third.operationHandle)).status).toBe('succeeded');
    expect(finished).toEqual(['a', 'b', 'c']);
    expect(service.getResult(first.operationHandle)).toBe('a');
    expect(maxActive).toBe(1);
  });

  it('rejects enqueue with OPERATION_QUEUE_FULL at the queue limit', async () => {
    const fixture = track(createServiceFixture({ maxQueuedPerProject: 1 }));
    const { service } = fixture;
    await service.start();
    const hang = gate();

    const first = await service.enqueue({
      kind: 'render',
      idempotencyKey: 'k1',
      actorId: 'u1',
      capabilityVersion: 1,
      sourceHash: null,
      acceptedRevisionId: null,
      requestHash: 'r1',
      runner: async () => {
        await hang.promise;
        return { status: 'succeeded', result: 'x' };
      },
    });
    expect(first.status).toBe('queued');
    if (first.status !== 'queued') return;

    const second = await service.enqueue({
      kind: 'render',
      idempotencyKey: 'k2',
      actorId: 'u1',
      capabilityVersion: 1,
      sourceHash: null,
      acceptedRevisionId: null,
      requestHash: 'r2',
      runner: async () => ({ status: 'succeeded', result: 'y' }),
    });
    expect(second).toMatchObject({ status: 'queue-full', errorCode: 'OPERATION_QUEUE_FULL' });
    hang.release();
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe('ProjectOperationService idempotency', () => {
  it('replays the stored result for the same idempotency key and request hash and conflicts otherwise', async () => {
    const fixture = track(createServiceFixture());
    const { service } = fixture;
    await service.start();
    let runs = 0;

    const enqueued = await service.enqueue({
      kind: 'render',
      idempotencyKey: 'key-1',
      actorId: 'u1',
      capabilityVersion: 1,
      sourceHash: 'hash-a',
      acceptedRevisionId: null,
      requestHash: 'req-1',
      runner: async () => {
        runs += 1;
        return { status: 'succeeded', result: { ok: true } };
      },
    });
    expect(enqueued.status).toBe('queued');
    if (enqueued.status !== 'queued') return;
    await waitForTerminal(service, enqueued.operationHandle);
    expect(runs).toBe(1);
    expect(service.getResult(enqueued.operationHandle)).toEqual({ ok: true });

    // Same key + same request hash: the stored result is replayed, the new
    // runner never runs.
    const replay = await service.enqueue({
      kind: 'render',
      idempotencyKey: 'key-1',
      actorId: 'u1',
      capabilityVersion: 1,
      sourceHash: 'hash-a',
      acceptedRevisionId: null,
      requestHash: 'req-1',
      runner: async () => {
        runs += 1;
        return { status: 'succeeded', result: { bad: true } };
      },
    });
    expect(replay.status).toBe('replayed');
    expect(runs).toBe(1);
    expect(service.getResult(enqueued.operationHandle)).toEqual({ ok: true });

    // Same key + different request hash: IDEMPOTENCY_CONFLICT.
    const conflict = await service.enqueue({
      kind: 'render',
      idempotencyKey: 'key-1',
      actorId: 'u1',
      capabilityVersion: 1,
      sourceHash: 'hash-a',
      acceptedRevisionId: null,
      requestHash: 'req-2',
      runner: async () => ({ status: 'succeeded', result: {} }),
    });
    expect(conflict.status).toBe('conflict');
    expect(runs).toBe(1);
  });
});

// ─── Cancellation ────────────────────────────────────────────────────────────

describe('ProjectOperationService cancel', () => {
  it('cancels queued and running operations; a late result can never overwrite the cancelled row', async () => {
    const fixture = track(createServiceFixture());
    const { service } = fixture;
    await service.start();
    const hang = gate();

    const first = await service.enqueue({
      kind: 'render',
      idempotencyKey: 'k1',
      actorId: 'u1',
      capabilityVersion: 1,
      sourceHash: 'hash-a',
      acceptedRevisionId: null,
      requestHash: 'r1',
      runner: async (context) => {
        await hang.promise;
        return context.signal.aborted
          ? { status: 'cancelled' }
          : { status: 'succeeded', result: 'a' };
      },
    });
    expect(first.status).toBe('queued');
    if (first.status !== 'queued') return;
    await waitFor(
      async () => (await service.get(first.operationHandle))?.status === 'running',
      'first render to start running',
    );

    // The drain loop is stuck on the first runner, so the second op stays queued.
    const second = await service.enqueue({
      kind: 'render',
      idempotencyKey: 'k2',
      actorId: 'u1',
      capabilityVersion: 1,
      sourceHash: 'hash-a',
      acceptedRevisionId: null,
      requestHash: 'r2',
      runner: async () => ({ status: 'succeeded', result: 'b' }),
    });
    expect(second.status).toBe('queued');
    if (second.status !== 'queued') return;
    expect((await service.get(second.operationHandle))?.status).toBe('queued');

    const queuedCancel = await service.cancel(second.operationHandle);
    expect(queuedCancel.status).toBe('cancelled');
    expect((await service.get(second.operationHandle))?.status).toBe('cancelled');

    const runningCancel = await service.cancel(first.operationHandle);
    expect(runningCancel.status).toBe('cancelled');
    expect((await service.get(first.operationHandle))?.status).toBe('cancelled');

    // The late runner outcome (after the abort) is archived, never promoted.
    hang.release();
    await waitFor(async () => {
      const record = await service.get(first.operationHandle);
      return record?.status === 'cancelled' && record.updatedAt !== record.createdAt;
    }, 'late outcome to settle');
    expect((await service.get(first.operationHandle))?.status).toBe('cancelled');
    expect(service.getResult(first.operationHandle)).toBeNull();

    // Terminal rows report terminal; unknown ids report not-found.
    expect((await service.cancel(second.operationHandle)).status).toBe('terminal');
    expect((await service.cancel('missing-op')).status).toBe('not-found');
  });
});

// ─── Restart recovery ────────────────────────────────────────────────────────

describe('ProjectOperationService restart recovery', () => {
  it('marks queued/running rows interrupted on start and never auto-replays; same key retries explicitly', async () => {
    const first = track(createServiceFixture());
    const databasePath = first.harness.databasePath;
    const hang = gate();
    const enqueued = await first.service.enqueue({
      kind: 'render',
      idempotencyKey: 'restart-key',
      actorId: 'u1',
      capabilityVersion: 1,
      sourceHash: 'hash-a',
      acceptedRevisionId: null,
      requestHash: 'restart-req',
      runner: async () => {
        await hang.promise;
        return { status: 'succeeded', result: 'never-replayed' };
      },
    });
    expect(enqueued.status).toBe('queued');
    if (enqueued.status !== 'queued') return;
    const idempotencyKey = enqueued.record.idempotencyKey;
    const requestHash = enqueued.record.resultRef ?? 'restart-req';
    await first.service.close();
    await first.harness.dispose();

    // A fresh Host over the same database: the interrupted sweep runs on
    // start; nothing is auto-replayed.
    const second = createServiceFixture({ databasePath });
    cleanup.push(async () => {
      await second.service.close();
      await second.harness.dispose();
    });
    const sweep = await second.service.start();
    expect(sweep.updated).toBeGreaterThan(0);
    const recovered = await second.service.get(enqueued.operationHandle);
    expect(recovered?.status).toBe('interrupted');

    // A different request hash on the same key conflicts even after restart.
    const conflict = await second.service.enqueue({
      kind: 'render',
      idempotencyKey,
      actorId: 'u1',
      capabilityVersion: 1,
      sourceHash: 'hash-a',
      acceptedRevisionId: null,
      requestHash: 'different-req',
      runner: async () => ({ status: 'succeeded', result: 'x' }),
    });
    expect(conflict.status).toBe('conflict');

    // Explicit retry with the same key + request hash re-enters the queue.
    const retried = await second.service.enqueue({
      kind: 'render',
      idempotencyKey,
      actorId: 'u1',
      capabilityVersion: 1,
      sourceHash: 'hash-a',
      acceptedRevisionId: null,
      requestHash,
      runner: async () => ({ status: 'succeeded', result: 'retried-ok' }),
    });
    expect(retried.status).toBe('queued');
    if (retried.status !== 'queued') return;
    expect(retried.operationHandle).toBe(enqueued.operationHandle);
    expect((await second.service.get(enqueued.operationHandle))?.status).toBe('queued');
    const terminal = await waitForTerminal(second.service, enqueued.operationHandle);
    expect(terminal.status).toBe('succeeded');
    expect(second.service.getResult(enqueued.operationHandle)).toBe('retried-ok');
  });
});

// ─── Host-wide render concurrency ────────────────────────────────────────────

describe('ProjectOperationService host-wide concurrency', () => {
  it('enforces the shared host-wide render limit across projects', async () => {
    const limiter = createRenderConcurrencyLimiter(1);
    const fixtureA = track(
      createServiceFixture({ projectId: 'project-a', concurrencyLimiter: limiter }),
    );
    const fixtureB = track(
      createServiceFixture({ projectId: 'project-b', concurrencyLimiter: limiter }),
    );
    await fixtureA.service.start();
    await fixtureB.service.start();
    const started: string[] = [];
    const hang = gate();

    const opA = await fixtureA.service.enqueue({
      kind: 'render',
      idempotencyKey: 'a1',
      actorId: 'u1',
      capabilityVersion: 1,
      sourceHash: 'hash-a',
      acceptedRevisionId: null,
      requestHash: 'a-req',
      runner: async () => {
        started.push('a');
        await hang.promise;
        return { status: 'succeeded', result: 'a' };
      },
    });
    expect(opA.status).toBe('queued');
    if (opA.status !== 'queued') return;
    await waitFor(() => started.includes('a'), 'project A render to start');

    const opB = await fixtureB.service.enqueue({
      kind: 'render',
      idempotencyKey: 'b1',
      actorId: 'u1',
      capabilityVersion: 1,
      sourceHash: 'hash-a',
      acceptedRevisionId: null,
      requestHash: 'b-req',
      runner: async () => {
        started.push('b');
        return { status: 'succeeded', result: 'b' };
      },
    });
    expect(opB.status).toBe('queued');
    if (opB.status !== 'queued') return;

    // Project B's render waits on the single host slot: it must not start.
    const { promise: settle, resolve: settleDone } = Promise.withResolvers<void>();
    setTimeout(settleDone, 30);
    await settle;
    expect(started).toEqual(['a']);

    hang.release();
    await waitFor(() => started.includes('b'), 'project B render to start after release');
    expect(started).toEqual(['a', 'b']);
  });

  it('never allows the shared limiter to deadlock when the capacity is configured to zero', async () => {
    const limiter = createRenderConcurrencyLimiter(0);
    const fixture = track(createServiceFixture({ concurrencyLimiter: limiter }));
    await fixture.service.start();
    const enqueued = await fixture.service.enqueue({
      kind: 'render',
      idempotencyKey: 'z1',
      actorId: 'u1',
      capabilityVersion: 1,
      sourceHash: null,
      acceptedRevisionId: null,
      requestHash: 'z-req',
      runner: async () => ({ status: 'succeeded', result: 'z' }),
    });
    expect(enqueued.status).toBe('queued');
    if (enqueued.status !== 'queued') return;
    expect((await waitForTerminal(fixture.service, enqueued.operationHandle)).status).toBe(
      'succeeded',
    );
  });
});

// ─── Store-first SSE broadcast ───────────────────────────────────────────────

describe('ProjectOperationService store-first SSE broadcast', () => {
  it('derives the receipt broadcast after every persisted transition (plan 4.7)', async () => {
    const harness = createRealPersistence();
    const session = createTestSession('project-a');
    const store = createProjectOperationStore(harness.client);
    const broadcasts: Array<{
      record: ProjectOperationRecordV1;
      storedAtBroadcast: ProjectOperationRecordV1 | null;
    }> = [];
    const serviceWithObserver = createProjectOperationService({
      projectId: session.projectId,
      store,
      session,
      limits: {
        maxQueuedPerProject: 64,
        maxConcurrentRendersPerHost: 2,
      },
      onStatusChange: (record) => {
        // The launch wires this observer to the authoring SSE event source;
        // snapshot the durable row at the moment the SSE event would be
        // delivered: the observer must never fire before the upsert lands.
        void store.get(record.projectId, record.operationId).then((storedAtBroadcast) => {
          broadcasts.push({ record, storedAtBroadcast });
        });
      },
    });
    cleanup.push(async () => {
      await serviceWithObserver.close();
      await harness.dispose();
    });
    await serviceWithObserver.start();

    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const queued = await serviceWithObserver.enqueue({
      kind: 'render',
      idempotencyKey: 'sse-1',
      actorId: 'u1',
      capabilityVersion: 1,
      sourceHash: 'hash-a',
      acceptedRevisionId: null,
      requestHash: 'sse-req',
      runner: async () => {
        await gate;
        return { status: 'succeeded', result: 'ok' };
      },
    });
    expect(queued.status).toBe('queued');
    if (queued.status !== 'queued') return;

    await waitFor(() => broadcasts.some((b) => b.record.status === 'running'));
    release?.();
    await waitForTerminal(serviceWithObserver, queued.operationHandle);

    // queued (enqueue) → running → succeeded: every persisted transition is
    // broadcast exactly once, and every broadcast already has its durable row.
    await waitFor(() => broadcasts.length >= 3, 'all three transitions to broadcast');
    expect(broadcasts.map((b) => b.record.status)).toEqual(['queued', 'running', 'succeeded']);
    expect(broadcasts.map((b) => b.record.kind)).toEqual(['render', 'render', 'render']);
    for (const { record, storedAtBroadcast } of broadcasts) {
      expect(storedAtBroadcast).not.toBeNull();
      // Store-first: the durable row already carries the broadcast status.
      expect(storedAtBroadcast?.status).toBe(record.status);
      expect(storedAtBroadcast?.operationId).toBe(record.operationId);
      // updatedAt is the transition time, so a broadcast after persist implies
      // the row's update timestamp equals the observer's record timestamp.
      expect(storedAtBroadcast?.updatedAt).toBe(record.updatedAt);
    }
    // The SSE wire shape: receipt-derived kind/status/errorCode/resultRef.
    const last = broadcasts[broadcasts.length - 1];
    expect(last.record.status).toBe('succeeded');
    expect(last.record.resultRef).toBe('sse-req');
    expect(last.record.errorCode).toBeNull();
  });
});

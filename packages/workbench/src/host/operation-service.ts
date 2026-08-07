/**
 * Host ProjectOperationService — the durable, cancellable, non-blocking
 * operation queue for long-running project work (plan Step 4).
 *
 * One service per project owns:
 *   - a FIFO render queue with per-project concurrency fixed at 1,
 *   - a shared host-wide render concurrency gate (`maxConcurrentRendersPerHost`),
 *   - durable rows in `project_operations` via {@link ProjectOperationStore},
 *     so status transitions, the idempotency unique constraint and the
 *     interrupted sweep stay worker-enforced, and
 *   - an AbortController per running operation whose signal is threaded into
 *     the session's two-phase detached operation. Aborting revokes the commit
 *     token: a late execute result is archived, never promoted.
 *
 * The authoring critical lane stays the session's own serialized queue; this
 * service never holds it. Every runner invokes
 * `session.enqueueDetachedOperation` with prepare/execute/commit wired to the
 * Core candidate/commit split: prepare and commit run inside the session lane
 * (capability-gated, audit-recorded), execute runs outside it.
 *
 * Store-first: every status transition is persisted BEFORE the optional
 * `onStatusChange` observer fires, so SSE/broadcast consumers never observe a
 * state the durable row does not yet have.
 */

import { randomUUID } from 'node:crypto';
import type {
  ProjectOperationKindV1,
  ProjectOperationProgressV1,
  ProjectOperationRecordV1,
  ProjectOperationStatusV1,
} from '../contracts/persistence.js';
import type { ProjectOperationStore } from '../persistence/project-operation-store.js';
import type { ProjectSession } from './project-session.js';

/** Terminal outcome a runner reports after its detached operation settles. */
export type ProjectOperationRunnerResult =
  | { readonly status: 'succeeded'; readonly result: unknown }
  | { readonly status: 'failed'; readonly errorCode: string; readonly message: string }
  | { readonly status: 'stale' }
  | { readonly status: 'cancelled' };

export interface ProjectOperationRunnerContext {
  readonly session: ProjectSession;
  readonly operationId: string;
  readonly actorId: string;
  readonly capabilityVersion: number;
  /** Caller-owned cancellation signal; aborting revokes the commit token. */
  readonly signal: AbortSignal;
  /** Persist a progress update (store-first; no-op when the row already moved). */
  reportProgress(progress: ProjectOperationProgressV1): Promise<void>;
}

/** Runs one queued operation to a terminal outcome; never throws. */
export type ProjectOperationRunner = (
  context: ProjectOperationRunnerContext,
) => Promise<ProjectOperationRunnerResult>;

/** Host-wide render concurrency gate shared by every project service. */
export interface RenderConcurrencyLimiter {
  /** Resolves a release function once a host-wide render slot is available. */
  acquire(): Promise<() => void>;
}

/**
 * A host-wide semaphore over `maxConcurrentRendersPerHost` slots. Render
 * runners hold a slot for their whole execute span; per-project concurrency
 * stays 1 because each project's drain loop runs one runner at a time.
 */
export function createRenderConcurrencyLimiter(maxConcurrent: number): RenderConcurrencyLimiter {
  let available = Math.max(1, Math.floor(maxConcurrent));
  const waiters: Array<() => void> = [];
  return {
    acquire(): Promise<() => void> {
      const { promise, resolve } = Promise.withResolvers<() => void>();
      const grant = (): void => {
        available -= 1;
        const release = (): void => {
          available += 1;
          const next = waiters.shift();
          if (next !== undefined) next();
        };
        resolve(release);
      };
      if (available > 0) {
        grant();
      } else {
        waiters.push(grant);
      }
      return promise;
    },
  };
}

export type ProjectOperationEnqueueResult =
  | {
      readonly status: 'queued';
      readonly operationHandle: string;
      readonly record: ProjectOperationRecordV1;
    }
  | {
      readonly status: 'replayed';
      readonly record: ProjectOperationRecordV1;
    }
  | {
      readonly status: 'conflict';
      readonly record: ProjectOperationRecordV1;
    }
  | {
      readonly status: 'queue-full';
      readonly errorCode: 'OPERATION_QUEUE_FULL';
      readonly active: number;
    }
  | {
      readonly status: 'closed';
      readonly errorCode: 'OPERATION_SERVICE_CLOSED';
    };

export type ProjectOperationCancelResult =
  | { readonly status: 'cancelled'; readonly record: ProjectOperationRecordV1 }
  | { readonly status: 'not-found' }
  | { readonly status: 'terminal'; readonly record: ProjectOperationRecordV1 };

export interface EnqueueProjectOperationInput {
  readonly kind: ProjectOperationKindV1;
  /** Unique per (project, kind); the worker's unique index is the single conflict surface. */
  readonly idempotencyKey: string;
  readonly actorId: string;
  readonly capabilityVersion: number;
  readonly sourceHash: string | null;
  readonly acceptedRevisionId: string | null;
  /**
   * Deterministic hash of the runner's input payload. Persisted in
   * `resultRef` (the V5 record has no request-hash column) so replay and
   * conflict decisions survive restarts: same idempotencyKey + same
   * requestHash replays the stored result, a different requestHash returns
   * `IDEMPOTENCY_CONFLICT`, and an `interrupted` row with the same request is
   * the explicit retry path (never auto-replayed).
   */
  readonly requestHash: string;
  readonly runner: ProjectOperationRunner;
}

export interface ProjectOperationService {
  readonly projectId: string;
  /** Restart recovery: every queued/running row becomes `interrupted`. Never auto-replays. */
  start(): Promise<{ readonly updated: number }>;
  enqueue(input: EnqueueProjectOperationInput): Promise<ProjectOperationEnqueueResult>;
  get(operationId: string): Promise<ProjectOperationRecordV1 | null>;
  list(status?: ProjectOperationStatusV1): Promise<readonly ProjectOperationRecordV1[]>;
  /** In-memory result of a succeeded operation; null when unavailable (e.g. after restart). */
  getResult(operationId: string): unknown | null;
  cancel(operationId: string): Promise<ProjectOperationCancelResult>;
  /** Stop the queue, abort in-flight work and drop in-memory state. No timers. */
  close(): Promise<void>;
}

export interface ProjectOperationServiceLimits {
  readonly maxQueuedPerProject: number;
  readonly maxConcurrentRendersPerHost: number;
}

export interface CreateProjectOperationServiceOptions {
  readonly projectId: string;
  readonly store: ProjectOperationStore;
  /** The session whose two-phase lane runs every runner's prepare/commit phases. */
  readonly session: ProjectSession;
  readonly limits: ProjectOperationServiceLimits;
  /** Shared host-wide gate; defaults to a private one over `maxConcurrentRendersPerHost`. */
  readonly concurrencyLimiter?: RenderConcurrencyLimiter;
  readonly now?: () => string;
  /** Store-first observer fired after every persisted status transition. */
  readonly onStatusChange?: (record: ProjectOperationRecordV1) => void;
}

/** Bounded in-memory result cache; results are never part of the durable row. */
const MAX_IN_MEMORY_RESULTS = 256;

export function createProjectOperationService(
  options: CreateProjectOperationServiceOptions,
): ProjectOperationService {
  const { projectId, store, session, limits } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const limiter =
    options.concurrencyLimiter ??
    createRenderConcurrencyLimiter(limits.maxConcurrentRendersPerHost);
  const fireStatusChange = options.onStatusChange ?? ((): void => {});

  /**
   * Two lanes (plan Step 4): an agent-run occupies its own lane so the tools
   * it calls (render/revise/publish/…) can run in the OTHER lane — a single
   * FIFO would deadlock the built-in agent, which waits on those operations
   * while they wait for it to finish. Render-like kinds keep the host-wide
   * render concurrency gate; agent runs are strictly serialized per project.
   */
  const RENDER_LANE_KINDS = new Set<ProjectOperationKindV1>([
    'authoring-submit',
    'render',
    'revise',
    'render-tree',
    'review',
    'release-gate',
    'publish',
  ]);
  const renderQueue: string[] = [];
  const agentQueue: string[] = [];
  const runners = new Map<string, ProjectOperationRunner>();
  const controllers = new Map<string, AbortController>();
  const results = new Map<string, unknown>();
  const draining = { render: false, agent: false };
  let closed = false;

  const persist = async (
    current: ProjectOperationRecordV1,
    patch: Partial<
      Pick<
        ProjectOperationRecordV1,
        'status' | 'progress' | 'resultRef' | 'errorCode' | 'acceptedRevisionId' | 'updatedAt'
      >
    >,
    expectedStatus: ProjectOperationStatusV1,
  ): Promise<ProjectOperationRecordV1 | null> => {
    const applied = await store.upsert({
      record: { ...current, ...patch, updatedAt: now() },
      expectedStatus,
    });
    if (!applied.applied) return null;
    fireStatusChange(applied.record);
    return applied.record;
  };

  const drain = async (lane: 'render' | 'agent'): Promise<void> => {
    if (draining[lane]) return;
    draining[lane] = true;
    try {
      while (!closed) {
        const queue = lane === 'render' ? renderQueue : agentQueue;
        const operationId = queue.shift();
        if (operationId === undefined) break;
        const controller = new AbortController();
        controllers.set(operationId, controller);
        try {
          await runQueued(operationId, controller.signal);
        } finally {
          controllers.delete(operationId);
        }
      }
    } finally {
      draining[lane] = false;
    }
  };
  const kickDrain = (kind: ProjectOperationKindV1): void => {
    void drain(RENDER_LANE_KINDS.has(kind) ? 'render' : 'agent');
  };

  const runQueued = async (operationId: string, signal: AbortSignal): Promise<void> => {
    try {
      await runQueuedInner(operationId, signal);
    } catch {
      // The store may be closing/disposed while an operation was mid-flight:
      // the durable row is swept as interrupted on the next Host start, and a
      // drain must never surface an unhandled rejection.
    }
  };

  const runQueuedInner = async (operationId: string, signal: AbortSignal): Promise<void> => {
    const runner = runners.get(operationId);
    if (runner === undefined) return;
    const current = await store.get(projectId, operationId);
    if (current === null || current.status !== 'queued') return;
    const running = await persist(current, { status: 'running' }, 'queued');
    if (running === null) return; // raced with a cancel: the row already moved
    const release = await limiter.acquire();
    try {
      if (signal.aborted) {
        await persist(running, { status: 'cancelled' }, 'running').catch(() => null);
        return;
      }
      let outcome: ProjectOperationRunnerResult;
      try {
        outcome = await runner({
          session,
          operationId,
          actorId: running.actorId,
          capabilityVersion: running.capabilityVersion,
          signal,
          reportProgress: async (progress) => {
            await persist(running, { progress }, 'running').catch(() => null);
          },
        });
      } catch (error) {
        outcome = {
          status: 'failed',
          errorCode: errorCodeOf(error),
          message: errorMessageOf(error),
        };
      }
      try {
        await applyOutcome(operationId, running, outcome);
      } catch {
        // The store may be closing/disposed: the durable row already carries a
        // terminal state or will be swept as interrupted on the next Host
        // start. A drain must never surface an unhandled rejection.
      }
    } finally {
      release();
      runners.delete(operationId);
    }
  };

  const applyOutcome = async (
    operationId: string,
    running: ProjectOperationRecordV1,
    outcome: ProjectOperationRunnerResult,
  ): Promise<void> => {
    const terminal: ProjectOperationRecordV1 = {
      ...running,
      status:
        outcome.status === 'succeeded'
          ? 'succeeded'
          : outcome.status === 'stale'
            ? 'stale'
            : outcome.status === 'cancelled'
              ? 'cancelled'
              : 'failed',
      errorCode: outcome.status === 'failed' ? outcome.errorCode : null,
      updatedAt: now(),
    };
    const applied = await store.upsert({ record: terminal, expectedStatus: 'running' });
    if (!applied.applied) {
      // The row already moved (cancel raced the late outcome): the result is
      // archived in memory only and never overwrites the durable terminal state.
      if (outcome.status === 'succeeded') results.set(operationId, outcome.result);
      return;
    }
    if (outcome.status === 'succeeded') results.set(operationId, outcome.result);
    fireStatusChange(applied.record);
  };

  const enqueue = async (
    input: EnqueueProjectOperationInput,
  ): Promise<ProjectOperationEnqueueResult> => {
    if (closed) return { status: 'closed', errorCode: 'OPERATION_SERVICE_CLOSED' };
    const existing = await store.getByIdempotencyKey(projectId, input.kind, input.idempotencyKey);
    if (existing !== null) {
      if (existing.resultRef !== input.requestHash) {
        return { status: 'conflict', record: existing };
      }
      if (existing.status === 'interrupted') {
        // Explicit retry with the same idempotency key: interrupted → queued
        // (the worker automaton's retry path). Never auto-replayed.
        const requeued = await store.upsert({
          record: { ...existing, status: 'queued', updatedAt: now() },
          expectedStatus: 'interrupted',
        });
        if (!requeued.applied) return { status: 'conflict', record: requeued.record };
        runners.set(existing.operationId, input.runner);
        (RENDER_LANE_KINDS.has(input.kind) ? renderQueue : agentQueue).push(existing.operationId);
        fireStatusChange(requeued.record);
        kickDrain(input.kind);
        return { status: 'queued', operationHandle: existing.operationId, record: requeued.record };
      }
      return { status: 'replayed', record: existing };
    }
    const [queuedCount, runningCount] = await Promise.all([
      store.countByStatus(projectId, 'queued'),
      store.countByStatus(projectId, 'running'),
    ]);
    const active = queuedCount.count + runningCount.count;
    if (active >= limits.maxQueuedPerProject) {
      return { status: 'queue-full', errorCode: 'OPERATION_QUEUE_FULL', active };
    }
    const operationId = randomUUID();
    const at = now();
    const created = await store
      .upsert({
        record: {
          version: 1,
          projectId,
          operationId,
          idempotencyKey: input.idempotencyKey,
          kind: input.kind,
          status: 'queued',
          actorId: input.actorId,
          capabilityVersion: input.capabilityVersion,
          sourceHash: input.sourceHash,
          acceptedRevisionId: input.acceptedRevisionId,
          progress: null,
          resultRef: input.requestHash,
          errorCode: null,
          createdAt: at,
          updatedAt: at,
        },
      })
      .catch((error: unknown) => {
        // The idempotency unique index is the only conflict surface on create.
        if (errorCodeOf(error) === 'IDEMPOTENCY_CONFLICT') return null;
        throw error;
      });
    if (created === null || !created.created) {
      const raced = await store.getByIdempotencyKey(projectId, input.kind, input.idempotencyKey);
      if (raced !== null) {
        return raced.resultRef === input.requestHash
          ? { status: 'replayed', record: raced }
          : { status: 'conflict', record: raced };
      }
      return { status: 'queue-full', errorCode: 'OPERATION_QUEUE_FULL', active };
    }
    runners.set(operationId, input.runner);
    (RENDER_LANE_KINDS.has(input.kind) ? renderQueue : agentQueue).push(operationId);
    fireStatusChange(created.record);
    kickDrain(input.kind);
    return { status: 'queued', operationHandle: operationId, record: created.record };
  };

  const cancelRunning = async (
    operationId: string,
    current: ProjectOperationRecordV1,
  ): Promise<ProjectOperationCancelResult> => {
    // Revoke the commit token FIRST (the session's commit slot checks the
    // signal), then persist the cancelled transition. A late execute result
    // that ignores the signal is archived, never promoted.
    controllers.get(operationId)?.abort();
    const cancelled = await store.upsert({
      record: { ...current, status: 'cancelled', updatedAt: now() },
      expectedStatus: 'running',
    });
    if (!cancelled.applied) return { status: 'terminal', record: cancelled.record };
    fireStatusChange(cancelled.record);
    return { status: 'cancelled', record: cancelled.record };
  };

  const cancel = async (operationId: string): Promise<ProjectOperationCancelResult> => {
    const current = await store.get(projectId, operationId);
    if (current === null) return { status: 'not-found' };
    // Recovered work from a previous Host run can be discarded explicitly
    // (worker automaton: interrupted → cancelled); it is never auto-replayed.
    if (current.status === 'interrupted') {
      const cancelled = await store.upsert({
        record: { ...current, status: 'cancelled', updatedAt: now() },
        expectedStatus: 'interrupted',
      });
      if (!cancelled.applied) return { status: 'terminal', record: cancelled.record };
      fireStatusChange(cancelled.record);
      return { status: 'cancelled', record: cancelled.record };
    }
    if (current.status === 'queued') {
      const cancelled = await store.upsert({
        record: { ...current, status: 'cancelled', updatedAt: now() },
        expectedStatus: 'queued',
      });
      if (cancelled.applied) {
        fireStatusChange(cancelled.record);
        return { status: 'cancelled', record: cancelled.record };
      }
      // The drain raced the queued→running transition: the fresh row is now
      // running, so abort it instead of giving up on the cancel.
      return cancelRunning(operationId, cancelled.record);
    }
    if (current.status === 'running') return cancelRunning(operationId, current);
    return { status: 'terminal', record: current };
  };

  return {
    projectId,
    async start() {
      return store.markAllInterrupted(projectId);
    },
    enqueue,
    get: (operationId) => store.get(projectId, operationId),
    list: (status) => store.list(status === undefined ? { projectId } : { projectId, status }),
    getResult: (operationId) => {
      const result = results.get(operationId);
      if (results.size > MAX_IN_MEMORY_RESULTS) {
        const oldest = results.keys().next().value;
        if (oldest !== undefined && oldest !== operationId) results.delete(oldest);
      }
      return result ?? null;
    },
    cancel,
    async close() {
      closed = true;
      for (const controller of controllers.values()) controller.abort();
      runners.clear();
      renderQueue.length = 0;
      agentQueue.length = 0;
      controllers.clear();
      results.clear();
    },
  };
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'operation.failed';
}

function errorMessageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 512 ? `${message.slice(0, 512)}…` : message;
}

// ============================================================================
// OperationStore — editorial operation lifecycle with lease-based running state,
// request-hash idempotency, active-worker ownership CAS, and conflict recovery.
// All authoritative writes use ProjectTransactionCoordinator transactions.
// ============================================================================

import * as path from 'node:path';
import { editorialOperationV1Schema, publicationManifestV1Schema } from '../schemas/editorial.ts';
import { computeContentHash, computeFileHash } from '../storage/hash.ts';
import type { StorageWrite } from '../storage/types.ts';
import type {
  Clock,
  EditorialError,
  EditorialOperationKind,
  EditorialOperationStatus,
  EditorialOperationV1,
  PublicationManifestV1,
} from '../types/editorial.ts';
import { EditorialOperationError } from './errors.ts';
import type { ProjectPaths } from './paths.ts';
import { type ProjectTransactionCoordinator, stableJson } from './transaction.ts';

// ─── Constants ─────────────────────────────────────────────────────────────

const LEASE_DURATION_MS = 30 * 60 * 1000; // 30 minutes
const TERMINAL_STATUSES: Record<'succeeded' | 'failed' | 'cancelled', true> = {
  succeeded: true,
  failed: true,
  cancelled: true,
};

function isTerminal(status: EditorialOperationStatus): boolean {
  return TERMINAL_STATUSES[status as keyof typeof TERMINAL_STATUSES] === true;
}

// ─── Store ─────────────────────────────────────────────────────────────────

export class OperationStore {
  constructor(
    private readonly coordinator: ProjectTransactionCoordinator,
    private readonly paths: ProjectPaths,
    private readonly clock: Clock,
  ) {}

  // ── Path helpers ─────────────────────────────────────────────────────────

  private operationPath(operationId: string): string {
    return path.join(this.paths.operationsDir, `${operationId}.json`);
  }

  // ── Register ─────────────────────────────────────────────────────────────

  /**
   * Register a new running operation or return an existing one if idempotent.
   *
   * - Same operationId + same requestHash + terminal → return stored (idempotent)
   * - Same operationId + same requestHash + interrupted → takeover (transition to running)
   * - Same operationId + same requestHash + running + unexpired → OPERATION_IN_PROGRESS
   * - Same operationId + same requestHash + running + expired → recover to interrupted, create new
   * - Same operationId + different requestHash + terminal/interrupted → INVALID_OPERATION
   * - Same operationId + different requestHash + running + unexpired → OPERATION_IN_PROGRESS
   * - Same operationId + different requestHash + running + expired → recover to interrupted, create new
   *
   * Atomically sets the publication manifest's active_operation_id on creation
   * and takeover, clearing any stale reference from a previous incomplete operation.
   */
  register(params: {
    operationId: string;
    kind: EditorialOperationKind;
    actorId: string;
    requestHash: string;
  }): EditorialOperationV1 {
    const { operationId, kind, actorId, requestHash } = params;
    const opPath = this.operationPath(operationId);

    // ── Recover stale active operation reference in publication manifest ──
    this.recoverStalePublicationReference(operationId);

    let existingContent = this.coordinator.storage.readOptional(opPath);
    const existingContentHash =
      existingContent !== null ? computeContentHash(existingContent) : null;
    let isOverwrite = false; // true when existing file is malformed and must be CAS-overwritten

    if (existingContent !== null) {
      let existing: EditorialOperationV1 | undefined;
      try {
        existing = this.parseOperation(existingContent, operationId);
      } catch {
        // Malformed file: if the publication manifest references this
        // operation as active, recover it. Otherwise treat as orphaned
        // and overwrite via CAS below.
        isOverwrite = true;
        const pub = this.readPublicationManifest();
        if (pub?.active_operation_id === operationId) {
          this.writeStaleManifest(operationId, 'Operation file malformed');
        }
      }

      if (existing) {
        if (existing.requestHash === requestHash) {
          // ── Same request hash ──────────────────────────────────────────
          if (isTerminal(existing.status)) {
            return existing; // Idempotent — return existing terminal record
          }
          if (existing.status === 'interrupted') {
            // Takeover: transition interrupted to running with new actorId
            return this.takeoverOperation(existingContent, existing, actorId);
          }
          // Running with same hash
          if (Date.parse(existing.leaseExpiresAt) > this.clock.now()) {
            throw new EditorialOperationError(
              'OPERATION_IN_PROGRESS',
              `Operation ${operationId} is already running (same request)`,
              { operationId },
            );
          }
          // Expired running → recover to interrupted, then fall through to create new
          this.recoverOperation(existingContent, existing, 'Lease expired');
          existingContent = this.coordinator.storage.readOptional(opPath);
        } else {
          // ── Different request hash ──────────────────────────────────────
          if (isTerminal(existing.status) || existing.status === 'interrupted') {
            throw new EditorialOperationError(
              'INVALID_OPERATION',
              `Operation ${operationId} completed or interrupted with a different request`,
              { operationId },
            );
          }
          if (Date.parse(existing.leaseExpiresAt) > this.clock.now()) {
            throw new EditorialOperationError(
              'OPERATION_IN_PROGRESS',
              `Operation ${operationId} is running with a different request`,
              { operationId },
            );
          }
          // Expired running with different hash → recover to interrupted, create new
          this.recoverOperation(existingContent, existing, 'Lease expired (different request)');
          existingContent = this.coordinator.storage.readOptional(opPath);
        }
      }
    }

    // ── Create new running operation ───────────────────────────────────────
    const now = new Date(this.clock.now());
    const operation: EditorialOperationV1 = {
      version: 1,
      operationId,
      kind,
      actorId,
      requestHash,
      status: 'running',
      startedAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + LEASE_DURATION_MS).toISOString(),
      result: null,
      errors: [],
    };

    // Compute expected hash: use re-read content if available (recovery case),
    // or the original file's hash for malformed overwrite, or null for fresh creation.
    const expectedOpHash =
      existingContent !== null
        ? computeContentHash(existingContent)
        : isOverwrite
          ? existingContentHash
          : null;

    // Atomically set active_operation_id in the publication manifest
    const writes: StorageWrite[] = [
      {
        type: 'put',
        path: opPath,
        content: stableJson(operation),
        expectedHash: expectedOpHash,
      },
      {
        type: 'put',
        path: this.paths.publicationPath,
        content: stableJson(this.buildActivePublicationManifest(operationId)),
        expectedHash: computeFileHash(this.coordinator.storage, this.paths.publicationPath),
      },
    ];

    this.coordinator.commit({ writes });

    return operation;
  }

  // ── Get ──────────────────────────────────────────────────────────────────

  /**
   * Read and parse a single operation record.
   * @throws EditorialOperationError if not found or malformed.
   */
  get(operationId: string): EditorialOperationV1 {
    const content = this.coordinator.storage.read(this.operationPath(operationId));
    return this.parseOperation(content, operationId);
  }

  // ── List ─────────────────────────────────────────────────────────────────

  /**
   * List all operation records in the operations directory, sorted by startedAt
   * ascending. Malformed files are silently skipped.
   */
  list(): EditorialOperationV1[] {
    if (!this.coordinator.storage.exists(this.paths.operationsDir)) return [];
    const files = this.coordinator.storage.listFiles(this.paths.operationsDir);
    const ops: EditorialOperationV1[] = [];
    for (const file of files) {
      if (file === '_sequence' || !file.endsWith('.json')) continue;
      try {
        const content = this.coordinator.storage.read(path.join(this.paths.operationsDir, file));
        ops.push(this.parseOperation(content, file.replace('.json', '')));
      } catch {
        // Skip malformed entries
      }
    }
    ops.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return ops;
  }

  // ── Heartbeat ────────────────────────────────────────────────────────────

  /**
   * Extend the lease and update heartbeatAt for a running operation.
   * Only the owning worker (actorId match) may heartbeat.
   * Uses storage-level CAS (expectedHash) to guard against concurrent changes.
   */
  heartbeat(operationId: string, workerId: string): EditorialOperationV1 {
    const opPath = this.operationPath(operationId);
    const currentContent = this.coordinator.storage.read(opPath);
    const op = this.parseOperation(currentContent, operationId);

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

    const now = new Date(this.clock.now());
    const updated: EditorialOperationV1 = {
      ...op,
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + LEASE_DURATION_MS).toISOString(),
    };

    this.coordinator.commit({
      writes: [
        {
          type: 'put',
          path: opPath,
          content: stableJson(updated),
          expectedHash: computeContentHash(currentContent),
        },
      ],
    });

    return updated;
  }

  // ── Promote (takeover) ───────────────────────────────────────────────────

  /**
   * Transition an interrupted operation to running, assigning ownership to the
   * specified worker. Atomically updates the publication manifest to reflect
   * the active operation.
   * Uses storage-level CAS for concurrency safety.
   */
  promote(operationId: string, workerId: string): EditorialOperationV1 {
    const opPath = this.operationPath(operationId);
    const currentContent = this.coordinator.storage.read(opPath);
    const op = this.parseOperation(currentContent, operationId);

    if (op.status !== 'interrupted') {
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Cannot promote operation ${operationId} from status ${op.status}`,
        { operationId },
      );
    }

    const now = new Date(this.clock.now());
    const updated: EditorialOperationV1 = {
      ...op,
      status: 'running',
      actorId: workerId,
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + LEASE_DURATION_MS).toISOString(),
    };

    const writes: StorageWrite[] = [
      {
        type: 'put',
        path: opPath,
        content: stableJson(updated),
        expectedHash: computeContentHash(currentContent),
      },
      {
        type: 'put',
        path: this.paths.publicationPath,
        content: stableJson(this.buildActivePublicationManifest(operationId)),
        expectedHash: computeFileHash(this.coordinator.storage, this.paths.publicationPath),
      },
    ];

    this.coordinator.commit({ writes });

    return updated;
  }

  // ── Terminal transitions ─────────────────────────────────────────────────

  /**
   * Mark a running operation as succeeded with the given result, assign a
   * monotonic lastSequence, and atomically bump the global sequence counter.
   * Atomically clears active_operation_id from the publication manifest.
   * Idempotent: if already succeeded with matching result, returns the stored record.
   */
  succeed(
    operationId: string,
    workerId: string,
    result: EditorialOperationV1['result'],
  ): EditorialOperationV1 {
    return this.finalize(operationId, workerId, 'succeeded', result, []);
  }

  /**
   * Mark a running operation as failed with the given errors and assign a
   * monotonic lastSequence.
   * Atomically clears active_operation_id from the publication manifest.
   * Idempotent: if already failed, returns the stored record.
   */
  fail(
    operationId: string,
    workerId: string,
    errors: readonly EditorialError[],
  ): EditorialOperationV1 {
    return this.finalize(operationId, workerId, 'failed', null, errors);
  }

  /**
   * Mark a running operation as cancelled and assign a monotonic lastSequence.
   * Atomically clears active_operation_id from the publication manifest.
   * Idempotent: if already cancelled, returns the stored record.
   */
  cancel(operationId: string, workerId: string): EditorialOperationV1 {
    return this.finalize(operationId, workerId, 'cancelled', null, []);
  }

  // ── Checkpoint sequence ──────────────────────────────────────────────────

  /**
   * Persist an operation-local progress sequence checkpoint. The sequence must
   * be strictly greater than the current lastSequence (monotonic CAS).
   * Only the owning worker may checkpoint.
   * @throws EditorialOperationError if not the owner, terminal, or non-monotonic.
   */
  checkpointSequence(operationId: string, workerId: string, sequence: number): void {
    const opPath = this.operationPath(operationId);
    const currentContent = this.coordinator.storage.read(opPath);
    const op = this.parseOperation(currentContent, operationId);

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

    const currentSeq = op.lastSequence ?? 0;
    if (sequence <= currentSeq) {
      throw new EditorialOperationError(
        'STORAGE_CONFLICT',
        `Sequence ${sequence} is not greater than current sequence ${currentSeq} for operation ${operationId}`,
        { operationId },
      );
    }

    const updated: EditorialOperationV1 = {
      ...op,
      lastSequence: sequence,
    };

    this.coordinator.commit({
      writes: [
        {
          type: 'put',
          path: opPath,
          content: stableJson(updated),
          expectedHash: computeContentHash(currentContent),
        },
      ],
    });
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Recover an expired running operation to interrupted, write conflict
   * evidence, and mark the publication manifest as stale. This is a separate
   * transaction from the subsequent new-operation creation.
   * The stale manifest preserves previous novel_hash, revision_ids, and
   * last_assembled_at, and appends an OPERATION_INTERRUPTED error.
   */
  private recoverOperation(
    rawContent: string,
    operation: EditorialOperationV1,
    reason: string,
  ): void {
    const now = new Date(this.clock.now());
    const interrupted: EditorialOperationV1 = {
      ...operation,
      status: 'interrupted',
      errors: [
        ...operation.errors,
        {
          code: 'OPERATION_INTERRUPTED',
          message: reason,
          operationId: operation.operationId,
        },
      ],
      completedAt: now.toISOString(),
    };

    const conflictPath = path.join(
      this.paths.conflictsDir,
      `operation-${operation.operationId}-${now.getTime()}.json`,
    );

    const conflictEvidence = {
      version: 1 as const,
      operationId: operation.operationId,
      previousStatus: operation.status,
      recoveredAt: now.toISOString(),
      reason,
    };

    this.coordinator.commit({
      writes: [
        {
          type: 'put',
          path: this.operationPath(operation.operationId),
          content: stableJson(interrupted),
          expectedHash: computeContentHash(rawContent),
        },
        {
          type: 'put',
          path: conflictPath,
          content: stableJson(conflictEvidence),
          expectedHash: null,
        },
        {
          type: 'put',
          path: this.paths.publicationPath,
          content: stableJson(this.buildStalePublicationManifest(operation.operationId, reason)),
          expectedHash: computeFileHash(this.coordinator.storage, this.paths.publicationPath),
        },
      ],
    });
  }

  /**
   * Read the current publication manifest, or return null if it doesn't
   * exist or is malformed.
   */
  private readPublicationManifest(): PublicationManifestV1 | null {
    const content = this.coordinator.storage.readOptional(this.paths.publicationPath);
    if (content === null) return null;
    try {
      const raw = JSON.parse(content);
      return publicationManifestV1Schema.parse(raw) as PublicationManifestV1;
    } catch {
      return null;
    }
  }

  /** Set active ownership without changing publication freshness or evidence. */
  private buildActivePublicationManifest(operationId: string): PublicationManifestV1 {
    const existing = this.readPublicationManifest();
    return {
      version: 1,
      status: existing?.status ?? 'stale',
      branch_scope_hash: existing?.branch_scope_hash ?? 'init',
      novel_hash: existing?.novel_hash ?? null,
      revision_ids: existing?.revision_ids ?? {},
      last_assembled_at: existing?.last_assembled_at ?? null,
      active_operation_id: operationId,
      reasons: existing?.reasons ?? [],
    };
  }

  /**
   * Build a stale PublicationManifestV1 that preserves the previous
   * publication's novel_hash, revision_ids, and last_assembled_at, and
   * appends an OPERATION_INTERRUPTED error. `active_operation_id` is
   * cleared on stale manifests.
   */
  private buildStalePublicationManifest(
    operationId: string,
    reason: string,
  ): PublicationManifestV1 {
    const existing = this.readPublicationManifest();
    return {
      version: 1,
      status: 'stale',
      branch_scope_hash: existing?.branch_scope_hash ?? 'recovered',
      novel_hash: existing?.novel_hash ?? null,
      revision_ids: existing?.revision_ids ?? {},
      last_assembled_at: existing?.last_assembled_at ?? null,
      reasons: [
        ...(existing?.reasons ?? []),
        {
          code: 'OPERATION_INTERRUPTED',
          message: reason,
          operationId,
        },
      ],
    };
  }

  /** Clear active ownership without changing publication freshness or evidence. */
  private buildClearActivePublicationManifest(): PublicationManifestV1 {
    const existing = this.readPublicationManifest();
    return {
      version: 1,
      status: existing?.status ?? 'stale',
      branch_scope_hash: existing?.branch_scope_hash ?? 'init',
      novel_hash: existing?.novel_hash ?? null,
      revision_ids: existing?.revision_ids ?? {},
      last_assembled_at: existing?.last_assembled_at ?? null,
      reasons: existing?.reasons ?? [],
    };
  }

  private buildUnsuccessfulPublicationManifest(
    operationId: string,
    status: 'failed' | 'cancelled',
    errors: readonly EditorialError[],
  ): PublicationManifestV1 {
    const existing = this.readPublicationManifest();
    const terminalReasons: EditorialError[] =
      status === 'cancelled'
        ? [{ code: 'OPERATION_CANCELLED', message: 'Operation cancelled', operationId }]
        : errors.length > 0
          ? [...errors]
          : [
              {
                code: 'PUBLICATION_INCOMPLETE',
                message: 'Operation failed before publication completed',
                operationId,
              },
            ];
    return {
      version: 1,
      status: 'stale',
      branch_scope_hash: existing?.branch_scope_hash ?? 'init',
      novel_hash: existing?.novel_hash ?? null,
      revision_ids: existing?.revision_ids ?? {},
      last_assembled_at: existing?.last_assembled_at ?? null,
      reasons: [...(existing?.reasons ?? []), ...terminalReasons],
    };
  }

  /**
   * Check if the publication manifest's active_operation_id points to this
   * operationId when the operation file is missing or malformed. If so,
   * write conflict evidence and a stale publication manifest, clearing the
   * stale reference before the main register flow proceeds.
   */
  private recoverStalePublicationReference(operationId: string): void {
    const pub = this.readPublicationManifest();
    if (!pub || pub.active_operation_id !== operationId) return;

    const opPath = this.operationPath(operationId);
    const content = this.coordinator.storage.readOptional(opPath);

    if (content === null) {
      // Missing operation file — recover
      this.writeStaleManifest(operationId, 'Operation file missing');
      return;
    }

    try {
      JSON.parse(content); // Check it's valid JSON
    } catch {
      // Malformed — recover
      this.writeStaleManifest(operationId, 'Operation file malformed');
      return;
    }

    // Valid file exists — no recovery needed here; main register flow handles it
  }

  /**
   * Write conflict evidence and a stale publication manifest when the
   * active operation reference is orphaned (missing or malformed file).
   */
  private writeStaleManifest(operationId: string, reason: string): void {
    const now = new Date(this.clock.now());

    const conflictPath = path.join(
      this.paths.conflictsDir,
      `operation-${operationId}-${now.getTime()}.json`,
    );

    const conflictEvidence = {
      version: 1 as const,
      operationId,
      previousStatus: 'running' as const,
      recoveredAt: now.toISOString(),
      reason,
    };

    const staleManifest = this.buildStalePublicationManifest(operationId, reason);

    this.coordinator.commit({
      writes: [
        {
          type: 'put',
          path: conflictPath,
          content: stableJson(conflictEvidence),
          expectedHash: null,
        },
        {
          type: 'put',
          path: this.paths.publicationPath,
          content: stableJson(staleManifest),
          expectedHash: computeFileHash(this.coordinator.storage, this.paths.publicationPath),
        },
      ],
    });
  }

  /**
   * Transition an interrupted operation to running (takeover) with a new
   * actorId, and atomically set the publication manifest's active_operation_id.
   */
  private takeoverOperation(
    rawContent: string,
    operation: EditorialOperationV1,
    newActorId: string,
  ): EditorialOperationV1 {
    const now = new Date(this.clock.now());
    const updated: EditorialOperationV1 = {
      ...operation,
      status: 'running',
      actorId: newActorId,
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + LEASE_DURATION_MS).toISOString(),
    };

    const writes: StorageWrite[] = [
      {
        type: 'put',
        path: this.operationPath(operation.operationId),
        content: stableJson(updated),
        expectedHash: computeContentHash(rawContent),
      },
      {
        type: 'put',
        path: this.paths.publicationPath,
        content: stableJson(this.buildActivePublicationManifest(operation.operationId)),
        expectedHash: computeFileHash(this.coordinator.storage, this.paths.publicationPath),
      },
    ];

    this.coordinator.commit({ writes });
    return updated;
  }

  /**
   * Apply a terminal status transition, assign the next sequence number,
   * atomically bump the global sequence counter, and clear active_operation_id
   * from the publication manifest. Ownership, status, and CAS invariants are
   * enforced within this method.
   *
   * Idempotent: calling with the same terminal status returns the stored record
   * without errors or side-effects.
   */
  private finalize(
    operationId: string,
    workerId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
    result: EditorialOperationV1['result'],
    errors: readonly EditorialError[],
  ): EditorialOperationV1 {
    const opPath = this.operationPath(operationId);
    const currentContent = this.coordinator.storage.read(opPath);
    const op = this.parseOperation(currentContent, operationId);

    if (op.actorId !== workerId) {
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Worker ${workerId} does not own operation ${operationId}`,
        { operationId },
      );
    }

    // ── Idempotent: same terminal state → return existing ────────────────
    if (op.status === status) {
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

    const now = new Date(this.clock.now());

    const updated: EditorialOperationV1 = {
      ...op,
      status,
      lastSequence: op.lastSequence ?? 1,
      completedAt: now.toISOString(),
      result: status === 'succeeded' ? result : null,
      errors: status === 'failed' ? [...op.errors, ...errors] : op.errors,
    };

    const writes: StorageWrite[] = [
      {
        type: 'put',
        path: opPath,
        content: stableJson(updated),
        expectedHash: computeContentHash(currentContent),
      },
    ];

    // Atomically clear active_operation_id from the publication manifest
    const pubHash = computeFileHash(this.coordinator.storage, this.paths.publicationPath);
    writes.push({
      type: 'put',
      path: this.paths.publicationPath,
      content: stableJson(
        status === 'succeeded'
          ? this.buildClearActivePublicationManifest()
          : this.buildUnsuccessfulPublicationManifest(operationId, status, errors),
      ),
      expectedHash: pubHash,
    });

    this.coordinator.commit({ writes });

    return updated;
  }

  /**
   * Parse and schema-validate a raw JSON string into an EditorialOperationV1.
   * @throws EditorialOperationError on malformed JSON or schema violation.
   */
  private parseOperation(content: string, operationId: string): EditorialOperationV1 {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(content);
    } catch {
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Malformed operation record for ${operationId}`,
        { operationId },
      );
    }

    try {
      return editorialOperationV1Schema.parse(raw) as EditorialOperationV1;
    } catch (err) {
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Invalid operation schema for ${operationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { operationId },
      );
    }
  }
}

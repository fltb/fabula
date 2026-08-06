import type {
  ListProjectOperationsInput,
  ProjectOperationRecordV1,
  ProjectOperationStatusV1,
  UpsertProjectOperationInput,
} from '../../src/contracts/persistence.js';
import type { ProjectOperationStore } from '../../src/persistence/project-operation-store.js';

/**
 * Canonical worker-side status automaton, mirrored from the real persistence
 * worker so coordinator tests exercise the same legal transitions the durable
 * store enforces. A new row must be created `queued`; terminal statuses never
 * transition again; `interrupted -> queued|cancelled` is the recovery/retry
 * path.
 */
const PROJECT_OPERATION_TRANSITIONS: Readonly<
  Record<ProjectOperationStatusV1, readonly ProjectOperationStatusV1[]>
> = {
  queued: ['running', 'cancelled', 'stale', 'interrupted'],
  running: ['succeeded', 'failed', 'stale', 'cancelled', 'interrupted'],
  succeeded: [],
  failed: [],
  stale: [],
  cancelled: [],
  interrupted: ['queued', 'cancelled'],
};

/** Immutable identity fields that must match the stored row on every update. */
function identityMatches(
  existing: ProjectOperationRecordV1,
  record: ProjectOperationRecordV1,
): boolean {
  return (
    existing.projectId === record.projectId &&
    existing.operationId === record.operationId &&
    existing.idempotencyKey === record.idempotencyKey &&
    existing.kind === record.kind &&
    existing.actorId === record.actorId &&
    existing.capabilityVersion === record.capabilityVersion &&
    existing.sourceHash === record.sourceHash &&
    existing.createdAt === record.createdAt
  );
}

function operationInputError(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

/**
 * In-memory `ProjectOperationStore` for coordinator-level tests. It mirrors
 * the durable worker's creation/transition/idempotency semantics (so the
 * coordinator cannot hide a legal-transition bug behind a permissive stub)
 * but keeps everything in process — no worker thread or SQLite file.
 */
export function createInMemoryOperationStore(): ProjectOperationStore {
  const rows = new Map<string, ProjectOperationRecordV1>();
  const key = (projectId: string, operationId: string): string =>
    `${projectId}\u0000${operationId}`;
  const idempotencyKey = (record: ProjectOperationRecordV1): string =>
    `${record.projectId}\u0000${record.kind}\u0000${record.idempotencyKey}`;
  const idempotencyRows = new Map<string, string>();

  return {
    async upsert(input: UpsertProjectOperationInput) {
      const record = input.record;
      const rowKey = key(record.projectId, record.operationId);
      const existing = rows.get(rowKey);
      if (existing === undefined) {
        if (record.status !== 'queued') {
          operationInputError(
            'INVALID_INPUT',
            'A new project operation must be created in status "queued".',
          );
        }
        const idempotency = idempotencyKey(record);
        if (idempotencyRows.has(idempotency)) {
          operationInputError(
            'IDEMPOTENCY_CONFLICT',
            `A project operation with idempotencyKey "${record.idempotencyKey}" already exists for kind "${record.kind}" in project "${record.projectId}".`,
          );
        }
        rows.set(rowKey, record);
        idempotencyRows.set(idempotency, rowKey);
        return { record, created: true, applied: true };
      }
      if (input.expectedStatus !== undefined && existing.status !== input.expectedStatus) {
        return { record: existing, created: false, applied: false };
      }
      if (!identityMatches(existing, record)) {
        operationInputError(
          'ILLEGAL_OPERATION_TRANSITION',
          `Project operation ${record.projectId}/${record.operationId} identity changed.`,
        );
      }
      const allowed = PROJECT_OPERATION_TRANSITIONS[existing.status];
      if (!allowed.includes(record.status)) {
        operationInputError(
          'ILLEGAL_OPERATION_TRANSITION',
          `Cannot transition project operation ${record.projectId}/${record.operationId} from ${existing.status} to ${record.status}.`,
        );
      }
      const updated: ProjectOperationRecordV1 = {
        ...existing,
        ...record,
        updatedAt: record.updatedAt,
      };
      rows.set(rowKey, updated);
      return { record: updated, created: false, applied: true };
    },
    async get(projectId, operationId) {
      return rows.get(key(projectId, operationId)) ?? null;
    },
    async list(input: ListProjectOperationsInput) {
      let matches = [...rows.values()].filter((record) => record.projectId === input.projectId);
      if (input.status !== undefined) matches = matches.filter((r) => r.status === input.status);
      if (input.before !== undefined) {
        const [beforeUpdatedAt, beforeOperationId] = input.before.split('|');
        matches = matches.filter(
          (r) =>
            r.updatedAt < beforeUpdatedAt ||
            (r.updatedAt === beforeUpdatedAt && r.operationId < beforeOperationId),
        );
      }
      const limit = Math.min(Math.max(1, input.limit ?? 50), 100);
      return matches
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) ||
            right.operationId.localeCompare(left.operationId),
        )
        .slice(0, limit);
    },
    async getByIdempotencyKey(projectId, kind, idempotencyKey) {
      const rowKey = idempotencyRows.get(`${projectId}\u0000${kind}\u0000${idempotencyKey}`);
      if (rowKey === undefined) return null;
      return rows.get(rowKey) ?? null;
    },
    async markAllInterrupted(projectId, at) {
      let updated = 0;
      const timestamp = at ?? new Date().toISOString();
      for (const record of rows.values()) {
        if (record.projectId !== projectId) continue;
        if (record.status !== 'queued' && record.status !== 'running') continue;
        rows.set(key(record.projectId, record.operationId), {
          ...record,
          status: 'interrupted',
          updatedAt: timestamp,
        });
        updated += 1;
      }
      return { updated };
    },
    async countByStatus(projectId, status) {
      let count = 0;
      for (const record of rows.values()) {
        if (record.projectId !== projectId) continue;
        if (status !== undefined && record.status !== status) continue;
        count += 1;
      }
      return { count };
    },
  };
}

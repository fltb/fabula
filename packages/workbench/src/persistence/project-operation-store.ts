import type {
  ListProjectOperationsInput,
  ProjectOperationKindV1,
  ProjectOperationRecordV1,
  ProjectOperationStatusV1,
  UpsertProjectOperationInput,
  UpsertProjectOperationResult,
} from '../contracts/persistence.js';
import type { PersistenceWorkerClient } from './worker-client.js';

/**
 * Host-facing typed facade over the durable project operation queue
 * (`project_operations`). Host services (ProjectOperationService, the
 * authoring coordinator's operation surface, the browser Operation Center)
 * call these methods instead of raw RPC strings; every method maps 1:1 to a
 * typed persistence operation, so status transitions, the idempotency unique
 * constraint and the interrupted sweep stay enforced worker-side.
 */
export interface ProjectOperationStore {
  /**
   * Create a `queued` operation or transition an existing row. Creation
   * rejects a duplicate idempotency key with `IDEMPOTENCY_CONFLICT`; updates
   * reject illegal status transitions with `ILLEGAL_OPERATION_TRANSITION`
   * and return `applied:false` when `expectedStatus` does not match the
   * stored status.
   */
  upsert(input: UpsertProjectOperationInput): Promise<UpsertProjectOperationResult>;
  /** Read one row by its composite key; null when absent. */
  get(projectId: string, operationId: string): Promise<ProjectOperationRecordV1 | null>;
  /** Page a project's queue newest-updated first, optionally filtered by status. */
  list(input: ListProjectOperationsInput): Promise<readonly ProjectOperationRecordV1[]>;
  /**
   * Idempotency lookup. The unique `(projectId, kind, idempotencyKey)` index
   * guarantees at most one row per key, so a caller can replay an existing
   * result instead of enqueueing a second operation.
   */
  getByIdempotencyKey(
    projectId: string,
    kind: ProjectOperationKindV1,
    idempotencyKey: string,
  ): Promise<ProjectOperationRecordV1 | null>;
  /** Host-restart sweep: every queued/running row becomes `interrupted`. */
  markAllInterrupted(projectId: string, at?: string): Promise<{ updated: number }>;
  /** Queue-depth check (e.g. `OPERATION_QUEUE_FULL` backpressure). */
  countByStatus(projectId: string, status?: ProjectOperationStatusV1): Promise<{ count: number }>;
}

export function createProjectOperationStore(
  client: PersistenceWorkerClient,
): ProjectOperationStore {
  return {
    upsert: (input) => client.request('upsertProjectOperation', input),
    get: (projectId, operationId) =>
      client.request('getProjectOperation', { projectId, operationId }),
    list: (input) => client.request('listProjectOperations', input),
    getByIdempotencyKey: (projectId, kind, idempotencyKey) =>
      client.request('getProjectOperationByIdempotencyKey', { projectId, kind, idempotencyKey }),
    markAllInterrupted: (projectId, at) =>
      client.request('markProjectOperationsInterrupted', {
        projectId,
        ...(at !== undefined ? { at } : {}),
      }),
    countByStatus: (projectId, status) =>
      client.request(
        'countProjectOperations',
        status === undefined ? { projectId } : { projectId, status },
      ),
  };
}

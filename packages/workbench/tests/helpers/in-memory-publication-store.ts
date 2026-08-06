import type {
  ListProjectPublicationsInput,
  ProjectPublicationRecordV1,
  PublicationStatusV1,
  UpsertProjectPublicationInput,
  UpsertProjectPublicationResult,
} from '../../src/contracts/persistence.js';
import type { ProjectPublicationStore } from '../../src/persistence/project-publication-store.js';

/**
 * In-memory `ProjectPublicationStore` for host service tests. It mirrors the
 * real persistence worker: creation is unconditional, updates replace the
 * value wholesale (identity fields immutable), `expectedStatus` guards the
 * update path (mismatch → `applied:false` with the stored row), and the
 * status automaton allows current↔stale in both directions.
 */
const PUBLICATION_TRANSITIONS: Readonly<
  Record<PublicationStatusV1, readonly PublicationStatusV1[]>
> = {
  current: ['current', 'stale'],
  stale: ['stale', 'current'],
};

export function createInMemoryPublicationStore(): ProjectPublicationStore {
  const rows = new Map<string, ProjectPublicationRecordV1>();
  const key = (projectId: string, publicationId: string): string =>
    `${projectId}\u0000${publicationId}`;
  return {
    async upsert(input: UpsertProjectPublicationInput): Promise<UpsertProjectPublicationResult> {
      const existing = rows.get(key(input.record.projectId, input.record.publicationId));
      if (existing === undefined) {
        rows.set(key(input.record.projectId, input.record.publicationId), input.record);
        return { record: input.record, created: true, applied: true };
      }
      if (input.expectedStatus !== undefined && existing.value.status !== input.expectedStatus) {
        return { record: existing, created: false, applied: false };
      }
      if (
        existing.projectId !== input.record.projectId ||
        existing.publicationId !== input.record.publicationId ||
        existing.kind !== input.record.kind
      ) {
        throw new Error('IDEMPOTENCY_CONFLICT: publication identity changed');
      }
      const from = existing.value.status;
      const to = input.record.value.status;
      if (!PUBLICATION_TRANSITIONS[from].includes(to)) {
        throw new Error(`ILLEGAL_OPERATION_TRANSITION: ${from} -> ${to}`);
      }
      rows.set(key(input.record.projectId, input.record.publicationId), input.record);
      return { record: input.record, created: false, applied: true };
    },
    async get(projectId, publicationId) {
      return rows.get(key(projectId, publicationId)) ?? null;
    },
    async list(input: ListProjectPublicationsInput) {
      const all = [...rows.values()]
        .filter((row) => row.projectId === input.projectId)
        .sort((a, b) =>
          a.updatedAt === b.updatedAt
            ? a.publicationId.localeCompare(b.publicationId)
            : a.updatedAt < b.updatedAt
              ? 1
              : -1,
        );
      if (input.before !== undefined) {
        const cursor = input.before.split('|');
        const beforeUpdatedAt = cursor[0];
        const beforeId = cursor[1];
        const filtered = all.filter(
          (row) =>
            row.updatedAt < beforeUpdatedAt ||
            (row.updatedAt === beforeUpdatedAt && row.publicationId < beforeId),
        );
        return filtered.slice(0, input.limit ?? 50);
      }
      return all.slice(0, input.limit ?? 50);
    },
  };
}

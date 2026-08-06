import type {
  ListProjectPublicationsInput,
  ProjectPublicationRecordV1,
  UpsertProjectPublicationInput,
  UpsertProjectPublicationResult,
} from '../contracts/persistence.js';
import type { PersistenceWorkerClient } from './worker-client.js';

/**
 * Host-facing typed facade over the durable per-project publication
 * repository (`project_publications`). Host services (ProjectPublicationService,
 * the publication browser view, the status projection) call these methods
 * instead of raw RPC strings; every method maps 1:1 to a typed persistence
 * operation, so the canonical/custom id rules, the `expectedStatus` CAS and
 * the `current`/`stale` status automaton stay enforced worker-side.
 */
export interface ProjectPublicationStore {
  /**
   * Create a publication row or replace the value of an existing row.
   * Creation is unconditional; updates validate the immutable identity
   * (projectId/publicationId/kind) and return `applied:false` when
   * `expectedStatus` does not match the stored status.
   */
  upsert(input: UpsertProjectPublicationInput): Promise<UpsertProjectPublicationResult>;
  /** Read one row by its composite key; null when absent. */
  get(projectId: string, publicationId: string): Promise<ProjectPublicationRecordV1 | null>;
  /** Page a project's publications newest-updated first. */
  list(input: ListProjectPublicationsInput): Promise<readonly ProjectPublicationRecordV1[]>;
}

export function createProjectPublicationStore(
  client: PersistenceWorkerClient,
): ProjectPublicationStore {
  return {
    upsert: (input) => client.request('upsertProjectPublication', input),
    get: (projectId, publicationId) =>
      client.request('getProjectPublication', { projectId, publicationId }),
    list: (input) => client.request('listProjectPublications', input),
  };
}

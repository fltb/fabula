/**
 * Host-only durable project membership adapter.
 *
 * ProjectAccessService, owner membership administration, and invite-created
 * access all use this one worker-backed port. It never keeps an in-memory ACL
 * and it exposes only the safe membership projection returned by persistence.
 */

import type { ProjectAccessRole } from '../contracts/configuration.js';
import type {
  ProjectMembershipState,
  RevokeProjectMembershipInput,
  UpsertProjectMembershipInput,
} from '../contracts/persistence.js';
import type { PersistenceWorkerClient } from '../persistence/worker-client.js';

export interface ProjectMembershipAdminService {
  list(input?: { projectId?: string }): Promise<readonly ProjectMembershipState[]>;
  upsert(
    input: Pick<UpsertProjectMembershipInput, 'userId' | 'projectId' | 'role'>,
  ): Promise<ProjectMembershipState>;
  revoke(input: Pick<RevokeProjectMembershipInput, 'userId' | 'projectId'>): Promise<void>;
}

export interface DurableProjectMembershipService extends ProjectMembershipAdminService {
  getMembership(userId: string, projectId: string): Promise<ProjectAccessRole | null>;
  listMemberships(userId: string): Promise<readonly ProjectMembershipState[]>;
}

export function createProjectMembershipService(
  client: PersistenceWorkerClient,
): DurableProjectMembershipService {
  const list = async (input?: { projectId?: string }): Promise<readonly ProjectMembershipState[]> =>
    client.request('listProjectMemberships', input ?? {});
  return {
    async getMembership(userId, projectId): Promise<ProjectAccessRole | null> {
      const membership = await client.request('loadProjectMembership', { userId, projectId });
      return membership?.role ?? null;
    },
    async listMemberships(userId): Promise<readonly ProjectMembershipState[]> {
      const memberships = await list();
      return memberships.filter((membership) => membership.userId === userId);
    },
    list,
    async upsert(input): Promise<ProjectMembershipState> {
      const result = await client.request('upsertProjectMembership', input);
      if (result.membership === null)
        throw new Error('Persistence returned no active membership after upsert.');
      return result.membership;
    },
    async revoke(input): Promise<void> {
      await client.request('revokeProjectMembership', input);
    },
  };
}

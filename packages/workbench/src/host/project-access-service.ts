/**
 * Host-only project authorization boundary.
 *
 * Project IDs are resolved here, before a session/resource registry is touched.
 * Membership is an ACL (reader < author < maintainer); the owner role is an
 * implicit host-wide override. The service owns the only catalog projection,
 * so callers cannot turn an arbitrary project id into a resource lookup.
 */
import type { BrowserProjectSummaryV1, BrowserSessionPrincipalV1 } from '../contracts/browser-api.js';
import {
  PROJECT_ACCESS_ROLE_GRANTS,
  PROJECT_ACCESS_ROLES,
} from '../contracts/configuration.js';
import type { ProjectAccessRole } from '../contracts/configuration.js';

export { PROJECT_ACCESS_ROLE_GRANTS, PROJECT_ACCESS_ROLES };
export type { ProjectAccessRole };
export type ProjectAccessRequiredRole = ProjectAccessRole | 'owner';
export type ProjectAccessPrincipalRole = ProjectAccessRole | 'owner';
export interface ProjectAccessRequest {
  readonly userId: string;
  readonly projectId: string;
  readonly requiredRole: ProjectAccessRequiredRole;
  readonly principalRole?: ProjectAccessPrincipalRole;
}

function isProjectMembershipPort(source: ProjectMembershipSource): source is ProjectMembershipPort {
  return !Array.isArray(source) && typeof source === 'object' && source !== null;
}


/** ACL entry. The server, never a request body, supplies this value. */
export interface ProjectMembership {
  readonly projectId: string;
  readonly userId: string;
  readonly role: ProjectAccessRole;
}

/** Host-known project metadata. It deliberately has no root/path field. */
export interface ProjectAccessProject {
  readonly projectId: string;
  readonly displayName: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  /** Explicit lifecycle state; omitted means the injected open-state port decides. */
  readonly state?: 'open' | 'closed';
  /** Compatibility projection for callers which already have an open flag. */
  readonly open?: boolean;
}

export type ProjectAccessDenyReason =
  | 'UNKNOWN_PROJECT'
  | 'PROJECT_CLOSED'
  | 'INSUFFICIENT_ROLE';

export interface ProjectAccessGrant {
  readonly userId: string;
  readonly projectId: string;
  readonly role: ProjectAccessPrincipalRole;
}

export type ProjectAccessResult =
  | { readonly ok: true; readonly grant: ProjectAccessGrant; readonly project: ProjectAccessProject }
  | { readonly ok: false; readonly reason: ProjectAccessDenyReason };

export interface ProjectMembershipPort {
  getMembership(userId: string, projectId: string): ProjectAccessRole | null | Promise<ProjectAccessRole | null>;
  listMemberships?(userId: string): readonly ProjectMembership[] | Promise<readonly ProjectMembership[]>;
}

export type ProjectMembershipSource = ProjectMembershipPort | readonly ProjectMembership[];

export interface ProjectAccessServiceOptions {
  /** Canonical configured project source, never a caller-provided project id. */
  readonly projects: readonly ProjectAccessProject[] | (() => readonly ProjectAccessProject[] | Promise<readonly ProjectAccessProject[]>);
  /** ACL source. Missing membership means no access for non-owners. */
  readonly memberships?: ProjectMembershipSource;
  /** Owner identity source. A principal with role owner is also an owner. */
  readonly ownerUserId?: string | null | (() => string | null | Promise<string | null>);
  /** Runtime lifecycle state; false closes the project before resource lookup. */
  readonly isOpen?: (projectId: string) => boolean | Promise<boolean>;
}

function isProjectAccessRole(value: unknown): value is ProjectAccessRole {
  return (
    typeof value === 'string' &&
    (PROJECT_ACCESS_ROLES as readonly string[]).includes(value)
  );
}

function roleAtLeast(
  actual: ProjectAccessPrincipalRole | null,
  required: ProjectAccessRequiredRole,
): boolean {
  if (actual === 'owner') return true;
  if (actual === null || required === 'owner' || !isProjectAccessRole(actual)) return false;
  return PROJECT_ACCESS_ROLE_GRANTS[actual].rank >= PROJECT_ACCESS_ROLE_GRANTS[required].rank;
}

function principalRole(
  principal:
    | Pick<BrowserSessionPrincipalV1, 'role'>
    | { role?: ProjectAccessPrincipalRole },
): ProjectAccessPrincipalRole | null {
  const role = principal.role;
  if (role === 'owner') return role;
  return isProjectAccessRole(role) ? role : null;
}

/**
 * One shared project authorization service. Construct it once per Host and
 * pass its ports to browser, MCP, Yjs and launch/resource seams.
 */
export class ProjectAccessService {
  readonly #options: ProjectAccessServiceOptions;

  constructor(options: ProjectAccessServiceOptions) {
    if (options === null || typeof options !== 'object' || options.projects === undefined) {
      throw new TypeError('ProjectAccessService requires a configured project source');
    }
    this.#options = options;
  }

  async #projects(): Promise<readonly ProjectAccessProject[]> {
    const source = this.#options.projects;
    const projects = typeof source === 'function' ? await source() : source;
    return projects.filter((project) => typeof project.projectId === 'string' && project.projectId.length > 0);
  }

  async #ownerUserId(): Promise<string | null> {
    const owner = this.#options.ownerUserId;
    return owner === undefined || owner === null
      ? null
      : typeof owner === 'function'
        ? await owner()
        : owner;
  }

  async #role(
    userId: string,
    projectId: string,
    suppliedRole?: ProjectAccessPrincipalRole,
  ): Promise<ProjectAccessPrincipalRole | null> {
    if (suppliedRole === 'owner' || (await this.#ownerUserId()) === userId) return 'owner';
    const memberships = this.#options.memberships;
    if (memberships === undefined) return null;
    const role = isProjectMembershipPort(memberships)
      ? await memberships.getMembership(userId, projectId)
      : memberships.find(
          (membership) => membership.userId === userId && membership.projectId === projectId,
        )?.role ?? null;
    return isProjectAccessRole(role) ? role : null;
  }

  async #isOpen(project: ProjectAccessProject): Promise<boolean> {
    if (project.state !== undefined) return project.state === 'open';
    if (project.open !== undefined) return project.open;
    return this.#options.isOpen === undefined ? true : await this.#options.isOpen(project.projectId);
  }
  /** Resolve ACL, project identity, and lifecycle state without touching a resource. */
  async authorize(input: ProjectAccessRequest): Promise<ProjectAccessResult> {
    if (
      typeof input.userId !== 'string' ||
      input.userId.length === 0 ||
      typeof input.projectId !== 'string' ||
      input.projectId.length === 0
    ) {
      return { ok: false, reason: 'UNKNOWN_PROJECT' };
    }
    const project = (await this.#projects()).find((candidate) => candidate.projectId === input.projectId);
    if (project === undefined) return { ok: false, reason: 'UNKNOWN_PROJECT' };
    const role = await this.#role(input.userId, input.projectId, input.principalRole);
    if (role === null || !roleAtLeast(role, input.requiredRole)) {
      return { ok: false, reason: 'INSUFFICIENT_ROLE' };
    }
    if (!(await this.#isOpen(project))) return { ok: false, reason: 'PROJECT_CLOSED' };
    return { ok: true, grant: { userId: input.userId, projectId: project.projectId, role }, project };
  }

  canAccessProject(
    userId: string,
    projectId: string,
    requiredRole: ProjectAccessRequiredRole = 'reader',
  ): Promise<boolean> {
    return this.authorize({ userId, projectId, requiredRole }).then((result) => result.ok);
  }

  /** List only projects visible to this server-derived principal. */
  async listProjects(principal: Pick<BrowserSessionPrincipalV1, 'userId' | 'role'>): Promise<readonly BrowserProjectSummaryV1[]> {
    const role = principalRole(principal);
    const projects = await this.#projects();
    const visible: BrowserProjectSummaryV1[] = [];
    for (const project of projects) {
      const result = await this.authorize({
        userId: principal.userId,
        projectId: project.projectId,
        requiredRole: 'reader',
        ...(role === null ? {} : { principalRole: role }),
      });
      if (!result.ok && result.reason !== 'PROJECT_CLOSED') continue;
      visible.push({
        version: 1,
        projectId: project.projectId,
        displayName: project.displayName,
        createdAt: project.createdAt ?? new Date(0).toISOString(),
        updatedAt: project.updatedAt ?? new Date(0).toISOString(),
        open: await this.#isOpen(project),
      });
    }
    return visible;
  }

  /** Resolve a project, then invoke the resource callback only when authorized and open. */
  async resolve<T>(input: ProjectAccessRequest & {
    readonly resource: (grant: ProjectAccessGrant, project: ProjectAccessProject) => Promise<T> | T;
  }): Promise<
    | { readonly ok: true; readonly value: T; readonly grant: ProjectAccessGrant }
    | { readonly ok: false; readonly reason: ProjectAccessDenyReason }
  > {
    const access = await this.authorize(input);
    if (!access.ok) return access;
    return { ok: true, value: await input.resource(access.grant, access.project), grant: access.grant };
  }
}

export function createProjectAccessService(options: ProjectAccessServiceOptions): ProjectAccessService {
  return new ProjectAccessService(options);
}

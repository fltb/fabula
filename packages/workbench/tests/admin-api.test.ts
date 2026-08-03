import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchConfigurationV1 } from '../src/contracts/configuration.js';
import { createAdminApi, type MembershipAdminPort } from '../src/host/admin-api.js';
import type { ConfigurationChangeService } from '../src/host/configuration-service.js';
import { createHostServer, type HostServer } from '../src/host/server.js';
import type { RuntimeAdminPort } from '../src/host/workbench-runtime.js';

const servers: HostServer[] = [];
const project = { projectId: 'project-a', displayName: 'Project A', root: '/private/project-a' };
const configuration: WorkbenchConfigurationV1 = {
  version: 1,
  projects: [project],
  defaultProjectId: project.projectId,
  provider: null,
  network: {
    mode: 'loopback',
    port: 8787,
    allowedHosts: [],
    allowedOrigins: [],
    unixSocket: null,
  },
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function createHarness(status: 'stale' | 'invalid' | 'throw', memberships?: MembershipAdminPort) {
  let open = true;
  const runtime: RuntimeAdminPort = {
    isOpen: () => open,
    listOpen: () => (open ? [{ projectId: project.projectId }] : []),
    open: vi.fn(async () => {
      open = true;
      return { projectId: project.projectId };
    }),
    close: vi.fn(async () => {
      open = false;
      return true;
    }),
  };
  const active = { configuration, revision: 'revision-a' };
  const configurationService = {
    readActive: vi.fn(async () => active),
    apply: vi.fn(async () => {
      if (status === 'throw') throw new Error('persistence unavailable');
      return {
        version: 1,
        operationId: 'config-operation',
        status,
        activeRevision: active.revision,
        candidateRevision: 'revision-b',
        changedFields: ['projects.project-a'],
        diagnostics:
          status === 'invalid'
            ? [{ code: 'CONFIG_INVALID', message: 'candidate rejected' }]
            : [{ code: 'CONFIG_STALE', message: 'candidate changed' }],
        origin: 'dashboard',
        at: '2026-08-02T00:00:00.000Z',
      };
    }),
  } as unknown as ConfigurationChangeService;
  const server = createHostServer({ port: 0 });
  servers.push(server);
  createAdminApi({
    resolver: {
      resolve: async () => ({
        ok: true as const,
        principal: {
          version: 1 as const,
          userId: 'owner-1',
          role: 'owner' as const,
          displayName: 'Owner',
          capabilityVersion: 1,
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      }),
    },
    configuration: configurationService,
    auth: {} as never,
    credentials: {} as never,
    devices: {} as never,
    memberships,
    runtime,
    operations: { list: async () => ({ configuration: [], audit: [] }) },
    status: {} as never,
    loadOwnerProfile: async () => null,
    listenerStatus: () => ({ mode: 'loopback', port: 8787 }),
  }).register(server);
  return { server, runtime, isOpen: () => open };
}

describe('admin project deletion rollback', () => {
  it.each(['stale', 'invalid'] as const)(
    'restores the configured runtime when deletion apply is %s',
    async (status) => {
      const h = createHarness(status);
      const response = await h.server.app.request(`/api/v1/admin/projects/${project.projectId}`, {
        method: 'DELETE',
        headers: { host: '127.0.0.1' },
      });

      expect(response.status).toBe(status === 'stale' ? 409 : 400);
      expect(h.runtime.close).toHaveBeenCalledWith(project.projectId);
      expect(h.runtime.open).toHaveBeenCalledWith(project);
      expect(h.isOpen()).toBe(true);
    },
  );

  it('restores the configured runtime when deletion apply throws', async () => {
    const h = createHarness('throw');
    const response = await h.server.app.request(`/api/v1/admin/projects/${project.projectId}`, {
      method: 'DELETE',
      headers: { host: '127.0.0.1' },
    });

    expect(response.status).toBe(500);
    expect(h.runtime.close).toHaveBeenCalledWith(project.projectId);
    expect(h.runtime.open).toHaveBeenCalledWith(project);
    expect(h.isOpen()).toBe(true);
  });
});
describe('admin owner membership routes', () => {
  it('registers list, upsert, and revoke routes through the owner guard', async () => {
    const listed = [
      { userId: 'member-1', projectId: project.projectId, role: 'reader' as const, capabilityVersion: 7 },
    ];
    const memberships: MembershipAdminPort = {
      list: vi.fn(async () => listed),
      upsert: vi.fn(async (input) => ({ ...input, capabilityVersion: 8 })),
      revoke: vi.fn(async () => undefined),
    };
    const h = createHarness('stale', memberships);

    const listResponse = await h.server.app.request(
      `/api/v1/admin/memberships?projectId=${project.projectId}`,
      { headers: { host: '127.0.0.1' } },
    );
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual({ version: 1, memberships: listed });
    expect(memberships.list).toHaveBeenCalledWith({ projectId: project.projectId });

    const upsertResponse = await h.server.app.request('/api/v1/admin/memberships', {
      method: 'PUT',
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        userId: 'member-1',
        projectId: project.projectId,
        role: 'author',
      }),
    });
    expect(upsertResponse.status).toBe(200);
    await expect(upsertResponse.json()).resolves.toEqual({
      version: 1,
      membership: {
        userId: 'member-1',
        projectId: project.projectId,
        role: 'author',
        capabilityVersion: 8,
      },
    });
    expect(memberships.upsert).toHaveBeenCalledWith({
      userId: 'member-1',
      projectId: project.projectId,
      role: 'author',
    });

    const revokeResponse = await h.server.app.request('/api/v1/admin/memberships', {
      method: 'DELETE',
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, userId: 'member-1', projectId: project.projectId }),
    });
    expect(revokeResponse.status).toBe(200);
    await expect(revokeResponse.json()).resolves.toEqual({
      version: 1,
      userId: 'member-1',
      projectId: project.projectId,
      revoked: true,
    });
    expect(memberships.revoke).toHaveBeenCalledWith({
      userId: 'member-1',
      projectId: project.projectId,
    });
  });
});

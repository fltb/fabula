import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchConfigurationV1 } from '../src/contracts/configuration.js';
import { createAdminApi } from '../src/host/admin-api.js';
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

function createHarness(status: 'stale' | 'invalid' | 'throw') {
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
    operations: { list: async () => ({ configuration: [], audit: [] }) },
    runtime,
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

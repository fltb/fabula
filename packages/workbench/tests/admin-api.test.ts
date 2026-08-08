import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WORKBENCH_AGENT_CONFIGURATION,
  DEFAULT_WORKBENCH_OPERATION_LIMITS,
  DEFAULT_WORKBENCH_REFERENCE_LIMITS,
  DEFAULT_WORKBENCH_RENDER_POLICY,
  type WorkbenchConfigurationV1,
  type WorkbenchProjectConfigurationV1,
} from '../src/contracts/configuration.js';
import {
  createAdminApi,
  type DiscoveredPluginAdminViewV1,
  type MembershipAdminPort,
} from '../src/host/admin-api.js';
import type { ConfigurationChangeService } from '../src/host/configuration-service.js';
import { createHostServer, type HostServer } from '../src/host/server.js';
import type { RuntimeAdminPort } from '../src/host/workbench-runtime.js';

const servers: HostServer[] = [];
const project: WorkbenchProjectConfigurationV1 = {
  projectId: 'project-a',
  displayName: 'Project A',
  revisionMirror: { mode: 'disabled' },
  providerProfile: 'default',
  trustedPlugins: [],
};
const configuration: WorkbenchConfigurationV1 = {
  version: 1,
  projects: [project],
  defaultProjectId: project.projectId,
  providers: {},
  network: {
    mode: 'loopback',
    port: 8787,
    allowedHosts: [],
    allowedOrigins: [],
    unixSocket: null,
  },
  referenceLimits: { ...DEFAULT_WORKBENCH_REFERENCE_LIMITS },
  operationLimits: { ...DEFAULT_WORKBENCH_OPERATION_LIMITS },
  agent: { ...DEFAULT_WORKBENCH_AGENT_CONFIGURATION },
  renderPolicy: { ...DEFAULT_WORKBENCH_RENDER_POLICY },
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
      {
        userId: 'member-1',
        projectId: project.projectId,
        role: 'reader' as const,
        capabilityVersion: 7,
      },
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

describe('admin configuration domains', () => {
  const v1Configuration: WorkbenchConfigurationV1 = {
    version: 1,
    projects: [
      {
        projectId: 'project-a',
        displayName: 'Project A',
        revisionMirror: { mode: 'disabled' },
        providerProfile: 'default',
        trustedPlugins: [{ name: 'arc', version: '1.0.0', moduleHash: 'abc123', required: true }],
      },
    ],
    defaultProjectId: 'project-a',
    providers: {
      default: { kind: 'pi', baseUrl: 'https://api.example.com/v1', model: 'deepseek-chat' },
    },
    network: {
      mode: 'loopback',
      port: 8787,
      allowedHosts: [],
      allowedOrigins: [],
      unixSocket: null,
    },
    referenceLimits: { ...DEFAULT_WORKBENCH_REFERENCE_LIMITS },
    operationLimits: {
      maxQueuedPerProject: 8,
      maxConcurrentRendersPerProject: 1,
      maxConcurrentRendersPerHost: 2,
    },
    agent: { enabled: false, maxTurns: 8, maxToolCalls: 24 },
    renderPolicy: { ...DEFAULT_WORKBENCH_RENDER_POLICY },
  };

  function createConfigHarness(options: {
    validate?: 'valid' | 'invalid';
    applyStatus?: 'applied' | 'restart-required' | 'stale';
    configuredProfiles?: readonly string[];
    configuration?: WorkbenchConfigurationV1;
    /** Host-discovered plugin identities; wires the discovery port when provided. */
    discoveredPlugins?: readonly DiscoveredPluginAdminViewV1[];
  }) {
    const active = {
      configuration: options.configuration ?? v1Configuration,
      revision: 'revision-a',
    };
    const appliedCandidates: WorkbenchConfigurationV1[] = [];
    const credentials = {
      get: vi.fn(async (providerId: string) =>
        (options.configuredProfiles ?? []).includes(providerId.replace(/^ai-sdk:/, ''))
          ? 'sk-secret-value'
          : null,
      ),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const configurationService = {
      readActive: vi.fn(async () => active),
      validateCandidate: vi.fn(async (_candidate: WorkbenchConfigurationV1) =>
        options.validate === 'invalid'
          ? { ok: false as const, diagnostics: [{ code: 'CONFIG_INVALID', message: 'rejected' }] }
          : { ok: true as const, revision: 'candidate-revision' },
      ),
      apply: vi.fn(async (input: { candidate: WorkbenchConfigurationV1 }) => {
        appliedCandidates.push(input.candidate);
        const status = options.applyStatus ?? 'restart-required';
        return {
          version: 1,
          operationId: 'config-operation',
          status,
          activeRevision: active.revision,
          candidateRevision: 'candidate-revision',
          changedFields: ['operationLimits.maxQueuedPerProject'],
          diagnostics:
            status === 'stale' ? [{ code: 'CONFIG_STALE', message: 'candidate changed' }] : [],
          origin: 'dashboard',
          at: '2026-08-02T00:00:00.000Z',
        };
      }),
    } as unknown as ConfigurationChangeService;
    const runtime: RuntimeAdminPort = {
      isOpen: () => true,
      listOpen: () => [{ projectId: 'project-a' }],
      open: vi.fn(async () => ({ projectId: 'project-a' })),
      close: vi.fn(async () => true),
    };
    const providerTest = { test: vi.fn(async () => ({ ok: true as const })) };
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
      credentials: credentials as never,
      devices: {} as never,
      runtime,
      operations: { list: async () => ({ configuration: [], audit: [] }) },
      status: {} as never,
      loadOwnerProfile: async () => null,
      listenerStatus: () => ({ mode: 'loopback', port: 8787 }),
      providerTest,
      ...(options.discoveredPlugins === undefined
        ? {}
        : {
            plugins: {
              discover: vi.fn(async (input: { projectId: string }) => {
                if (input.projectId !== 'project-a') {
                  throw new Error(`Project "${input.projectId}" is not registered.`);
                }
                return options.discoveredPlugins ?? [];
              }),
            },
          }),
    }).register(server);
    return { server, configurationService, appliedCandidates, credentials, providerTest };
  }

  it('reads masked configuration domains without leaking credentials', async () => {
    const h = createConfigHarness({ configuredProfiles: ['default'] });
    const response = await h.server.app.request('/api/v1/admin/config/advanced', {
      headers: { host: '127.0.0.1' },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.version).toBe(1);
    expect(body.providers).toEqual([
      {
        profileId: 'default',
        kind: 'pi',
        configured: true,
        endpoint: 'https://api.example.com/***',
        model: 'de****t',
        lastValidation: 'valid',
        lastValidatedAt: null,
      },
    ]);
    expect(body.projects).toEqual([
      {
        projectId: 'project-a',
        displayName: 'Project A',
        providerProfile: 'default',
        trustedPlugins: [{ name: 'arc', version: '1.0.0', moduleHash: 'abc123', required: true }],
      },
    ]);
    expect(body.operationLimits).toEqual({
      maxQueuedPerProject: 8,
      maxConcurrentRendersPerProject: 1,
      maxConcurrentRendersPerHost: 2,
    });
    expect(body.agent).toEqual({ enabled: false, maxTurns: 8, maxToolCalls: 24 });
    expect(JSON.stringify(body)).not.toContain('sk-secret-value');
    expect(JSON.stringify(body)).not.toContain('api.example.com/v1');
  });

  it('previews a configuration-domain patch without applying it', async () => {
    const h = createConfigHarness({});
    const response = await h.server.app.request('/api/v1/admin/config/preview', {
      method: 'POST',
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        operationLimits: { maxQueuedPerProject: 16, maxConcurrentRendersPerHost: 3 },
        agent: { enabled: true, maxTurns: 4, maxToolCalls: 8 },
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      version: 1,
      valid: true,
      diagnostics: [],
      changedFields: [
        'operationLimits.maxQueuedPerProject',
        'operationLimits.maxConcurrentRendersPerHost',
        'agent.enabled',
        'agent.maxTurns',
        'agent.maxToolCalls',
      ],
      restartRequired: true,
      candidateRevision: 'candidate-revision',
    });
    expect(h.configurationService.apply).not.toHaveBeenCalled();
  });

  it('returns typed diagnostics when a preview candidate is invalid', async () => {
    const h = createConfigHarness({ validate: 'invalid' });
    const response = await h.server.app.request('/api/v1/admin/config/preview', {
      method: 'POST',
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, agent: { enabled: true, maxTurns: 4, maxToolCalls: 8 } }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: 1,
      valid: false,
      diagnostics: [{ code: 'CONFIG_INVALID', message: 'rejected' }],
      changedFields: [],
      restartRequired: false,
      candidateRevision: null,
    });
    expect(h.configurationService.apply).not.toHaveBeenCalled();
  });

  it('applies operation limits, agent, and per-project patches through the CAS', async () => {
    const h = createConfigHarness({});
    const response = await h.server.app.request('/api/v1/admin/config/advanced', {
      method: 'PUT',
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        operationLimits: { maxQueuedPerProject: 16, maxConcurrentRendersPerHost: 4 },
        agent: { enabled: true, maxTurns: 4, maxToolCalls: 8 },
        projects: [
          {
            projectId: 'project-a',
            providerProfile: 'fast',
            trustedPlugins: [
              { name: 'arc', version: '1.0.0', moduleHash: 'abc123', required: false },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.version).toBe(1);
    expect(body.receipt.status).toBe('restart-required');
    const candidate = h.appliedCandidates[0] as WorkbenchConfigurationV1;
    expect(candidate.version).toBe(1);
    expect(candidate.operationLimits).toEqual({
      maxQueuedPerProject: 16,
      maxConcurrentRendersPerProject: 1,
      maxConcurrentRendersPerHost: 4,
    });
    expect(candidate.agent).toEqual({ enabled: true, maxTurns: 4, maxToolCalls: 8 });
    expect(candidate.projects[0]?.providerProfile).toBe('fast');
    expect(candidate.projects[0]?.trustedPlugins[0]?.required).toBe(false);
  });

  it('rejects an advanced patch that names an unknown project', async () => {
    const h = createConfigHarness({});
    const response = await h.server.app.request('/api/v1/admin/config/advanced', {
      method: 'PUT',
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        projects: [{ projectId: 'ghost', providerProfile: 'fast' }],
      }),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'PROJECT_NOT_FOUND', message: 'Project "ghost" is not registered.' },
    });
    expect(h.configurationService.apply).not.toHaveBeenCalled();
  });

  it('rejects a stale advanced apply with CONFIG_STALE', async () => {
    const h = createConfigHarness({ applyStatus: 'stale' });
    const response = await h.server.app.request('/api/v1/admin/config/advanced', {
      method: 'PUT',
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, agent: { enabled: true, maxTurns: 4, maxToolCalls: 8 } }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'CONFIG_STALE', message: 'The configuration changed; re-read and retry.' },
    });
  });

  it('upserts a provider profile and returns a masked view', async () => {
    const h = createConfigHarness({});
    const response = await h.server.app.request('/api/v1/admin/providers/fast', {
      method: 'PUT',
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        kind: 'pi',
        baseUrl: 'https://fast.example.com/v1',
        model: 'fast-model',
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.profile).toEqual({
      profileId: 'fast',
      kind: 'pi',
      configured: false,
      endpoint: 'https://fast.example.com/***',
      model: 'fa****l',
      lastValidation: 'unvalidated',
      lastValidatedAt: null,
    });
    const candidate = h.appliedCandidates[0] as WorkbenchConfigurationV1;
    expect(candidate.providers.fast).toEqual({
      kind: 'pi',
      baseUrl: 'https://fast.example.com/v1',
      model: 'fast-model',
    });
  });

  it('deletes an unreferenced provider profile and its credential', async () => {
    const h = createConfigHarness({ configuredProfiles: ['fast'] });
    const deleteUnreferenced = await h.server.app.request('/api/v1/admin/providers/other', {
      method: 'DELETE',
      headers: { host: '127.0.0.1' },
    });
    expect(deleteUnreferenced.status).toBe(400);
    await expect(deleteUnreferenced.json()).resolves.toEqual({
      error: { code: 'CONFIG_INVALID', message: 'Provider profile "other" does not exist.' },
    });

    const deleteReferenced = await h.server.app.request('/api/v1/admin/providers/default', {
      method: 'DELETE',
      headers: { host: '127.0.0.1' },
    });
    expect(deleteReferenced.status).toBe(400);
    await expect(deleteReferenced.json()).resolves.toEqual({
      error: {
        code: 'CONFIG_INVALID',
        message: 'Provider profile "default" is used by project "project-a" and cannot be removed.',
      },
    });
    expect(h.configurationService.apply).not.toHaveBeenCalled();
  });

  it('deletes an unreferenced profile after its binding moved', async () => {
    const rebound: WorkbenchConfigurationV1 = {
      ...v1Configuration,
      projects: [
        {
          projectId: 'project-a',
          displayName: 'Project A',
          revisionMirror: { mode: 'disabled' },
          providerProfile: 'fast',
          trustedPlugins: [{ name: 'arc', version: '1.0.0', moduleHash: 'abc123', required: true }],
        },
      ],
      providers: {
        ...v1Configuration.providers,
        fast: { kind: 'pi', baseUrl: null, model: null },
      },
    };
    const h = createConfigHarness({ configuration: rebound, configuredProfiles: ['fast'] });
    const response = await h.server.app.request('/api/v1/admin/providers/default', {
      method: 'DELETE',
      headers: { host: '127.0.0.1' },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      version: 1,
      profileId: 'default',
      removed: true,
      receipt: expect.objectContaining({ status: 'restart-required' }),
    });
    const candidate = h.appliedCandidates[0] as WorkbenchConfigurationV1;
    expect(candidate.providers.default).toBeUndefined();
    expect(h.credentials.remove).toHaveBeenCalledWith('ai-sdk:default');
  });

  it('stores a profile credential one-way and never echoes the key', async () => {
    const h = createConfigHarness({});
    const response = await h.server.app.request('/api/v1/admin/providers/fast/credential', {
      method: 'POST',
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, apiKey: 'sk-secret-value' }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      version: 1,
      profileId: 'fast',
      configured: true,
    });
    expect(h.credentials.set).toHaveBeenCalledWith('ai-sdk:fast', 'sk-secret-value');
    expect(JSON.stringify(body)).not.toContain('sk-secret-value');
  });

  it('clears and tests a provider profile credential without echoing it', async () => {
    const h = createConfigHarness({ configuredProfiles: ['default'] });
    const clear = await h.server.app.request('/api/v1/admin/providers/default/credential', {
      method: 'DELETE',
      headers: { host: '127.0.0.1' },
    });
    expect(clear.status).toBe(200);
    const clearBody = await clear.json();
    expect(clearBody).toEqual({ version: 1, profileId: 'default', configured: false });
    expect(h.credentials.remove).toHaveBeenCalledWith('ai-sdk:default');

    const test = await h.server.app.request('/api/v1/admin/providers/default/test', {
      method: 'POST',
      headers: { host: '127.0.0.1' },
    });
    expect(test.status).toBe(200);
    const testBody = await test.json();
    expect(testBody.validation).toBe('valid');
    expect(h.providerTest.test).toHaveBeenCalledWith({
      baseUrl: 'https://api.example.com/v1',
      model: 'deepseek-chat',
      apiKey: 'sk-secret-value',
    });
    expect(JSON.stringify(testBody)).not.toContain('sk-secret-value');
  });

  describe('admin trusted plugin discovery', () => {
    const discovered: readonly DiscoveredPluginAdminViewV1[] = [
      {
        name: 'arc',
        version: '1.0.0',
        manifestHash: 'manifest-hash-1',
        moduleHash: 'abc123',
        hookNames: ['transform'],
      },
      {
        name: 'novel-prose',
        version: '2.1.0',
        manifestHash: 'manifest-hash-2',
        moduleHash: 'def456',
        hookNames: ['observe'],
      },
    ];

    it('serves the Host-discovered plugin identities per project (no paths or code)', async () => {
      const h = createConfigHarness({ discoveredPlugins: discovered });
      const response = await h.server.app.request('/api/v1/admin/plugins/discovered/project-a', {
        headers: { host: '127.0.0.1' },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ version: 1, projectId: 'project-a', plugins: discovered });
      // Browser-safe: identity fields only, never the project root or any fs path.
      expect(JSON.stringify(body)).not.toContain('/private');
    });

    it('returns PROJECT_NOT_FOUND when the discovery port is absent', async () => {
      const h = createConfigHarness({});
      const response = await h.server.app.request('/api/v1/admin/plugins/discovered/project-a', {
        headers: { host: '127.0.0.1' },
      });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: 'Plugin discovery is not available on this Host.',
        },
      });
    });

    it('returns PROJECT_NOT_FOUND for an unregistered project', async () => {
      const h = createConfigHarness({ discoveredPlugins: discovered });
      const response = await h.server.app.request('/api/v1/admin/plugins/discovered/ghost', {
        headers: { host: '127.0.0.1' },
      });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: { code: 'PROJECT_NOT_FOUND', message: 'Project "ghost" is not registered.' },
      });
    });

    it('applies trustedPlugins whose name/version/moduleHash exactly match a discovered plugin', async () => {
      const h = createConfigHarness({ discoveredPlugins: discovered });
      const response = await h.server.app.request('/api/v1/admin/config/advanced', {
        method: 'PUT',
        headers: { host: '127.0.0.1', 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          projects: [
            {
              projectId: 'project-a',
              trustedPlugins: [
                { name: 'arc', version: '1.0.0', moduleHash: 'abc123', required: false },
              ],
            },
          ],
        }),
      });
      expect(response.status).toBe(200);
      expect(h.configurationService.apply).toHaveBeenCalledTimes(1);
      const candidate = h.appliedCandidates[0] as WorkbenchConfigurationV1;
      expect(candidate.projects[0]?.trustedPlugins[0]).toEqual({
        name: 'arc',
        version: '1.0.0',
        moduleHash: 'abc123',
        required: false,
      });
    });

    it('rejects a trustedPlugins apply whose entry is not Host-discovered', async () => {
      const h = createConfigHarness({ discoveredPlugins: discovered });
      const response = await h.server.app.request('/api/v1/admin/config/advanced', {
        method: 'PUT',
        headers: { host: '127.0.0.1', 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          projects: [
            {
              projectId: 'project-a',
              trustedPlugins: [
                { name: 'arc', version: '1.0.0', moduleHash: 'deadbeef', required: true },
              ],
            },
          ],
        }),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'PLUGIN_NOT_DISCOVERED',
          message:
            'Plugin "arc@1.0.0" is not discovered on this Host; only Host-discovered plugins can be trusted.',
        },
      });
      expect(h.configurationService.apply).not.toHaveBeenCalled();
    });

    it('rejects a discovered-name entry whose version does not match', async () => {
      const h = createConfigHarness({ discoveredPlugins: discovered });
      const response = await h.server.app.request('/api/v1/admin/config/advanced', {
        method: 'PUT',
        headers: { host: '127.0.0.1', 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          projects: [
            {
              projectId: 'project-a',
              trustedPlugins: [
                { name: 'arc', version: '9.9.9', moduleHash: 'abc123', required: true },
              ],
            },
          ],
        }),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'PLUGIN_NOT_DISCOVERED',
          message:
            'Plugin "arc@9.9.9" is not discovered on this Host; only Host-discovered plugins can be trusted.',
        },
      });
      expect(h.configurationService.apply).not.toHaveBeenCalled();
    });

    it('previews reject non-discovered entries without applying', async () => {
      const h = createConfigHarness({ discoveredPlugins: discovered });
      const response = await h.server.app.request('/api/v1/admin/config/preview', {
        method: 'POST',
        headers: { host: '127.0.0.1', 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          projects: [
            {
              projectId: 'project-a',
              trustedPlugins: [
                { name: 'ghost', version: '1.0.0', moduleHash: 'nope', required: false },
              ],
            },
          ],
        }),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'PLUGIN_NOT_DISCOVERED',
          message:
            'Plugin "ghost@1.0.0" is not discovered on this Host; only Host-discovered plugins can be trusted.',
        },
      });
      expect(h.configurationService.apply).not.toHaveBeenCalled();
    });

    it('accepts a discovered plugin whose module is missing from disk only after it is removed', async () => {
      // A discovered entry with a null moduleHash can never match; clearing the
      // allowlist to an empty array is still allowed.
      const h = createConfigHarness({ discoveredPlugins: [{ ...discovered[0]!, moduleHash: null }] });
      const rejected = await h.server.app.request('/api/v1/admin/config/advanced', {
        method: 'PUT',
        headers: { host: '127.0.0.1', 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          projects: [
            {
              projectId: 'project-a',
              trustedPlugins: [
                { name: 'arc', version: '1.0.0', moduleHash: 'abc123', required: true },
              ],
            },
          ],
        }),
      });
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toEqual({
        error: {
          code: 'PLUGIN_NOT_DISCOVERED',
          message:
            'Plugin "arc@1.0.0" is not discovered on this Host; only Host-discovered plugins can be trusted.',
        },
      });
      expect(h.configurationService.apply).not.toHaveBeenCalled();

      const cleared = await h.server.app.request('/api/v1/admin/config/advanced', {
        method: 'PUT',
        headers: { host: '127.0.0.1', 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          projects: [{ projectId: 'project-a', trustedPlugins: [] }],
        }),
      });
      expect(cleared.status).toBe(200);
      expect(h.configurationService.apply).toHaveBeenCalledTimes(1);
    });
  });
});

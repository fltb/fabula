import { cleanup, render, screen, waitFor } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccessDevicesPage } from '../../src/client/admin/AccessDevicesPage';
import { AdminShell } from '../../src/client/admin/AdminShell';
import { AdvancedPage } from '../../src/client/admin/AdvancedPage';
import {
  type AdminApiError,
  type AdminFetch,
  createAdminClient,
} from '../../src/client/admin/admin-client';
import { ProviderPage } from '../../src/client/admin/ProviderPage';
import { SystemPage } from '../../src/client/admin/SystemPage';
import type { WorkbenchAdminOverviewV1 } from '../../src/contracts/index.js';

const overview: WorkbenchAdminOverviewV1 = {
  version: 1,
  setup: {
    version: 1,
    phase: 'ready',
    configurationPresent: true,
    configurationRevision: 'active-revision',
    ownerCreated: true,
    projects: [],
    defaultProjectId: null,
    provider: {
      kind: 'pi',
      configured: false,
      endpoint: 'https://********/v1',
      model: 'de****h',
      lastValidation: 'unvalidated',
      lastValidatedAt: null,
    },
    network: {
      mode: 'loopback',
      port: 8787,
      allowedHosts: [],
      allowedOrigins: [],
      unixSocket: false,
      listenerActive: true,
      restartRequired: false,
    },
    generatedAt: '2026-08-03T00:00:00.000Z',
    hostHome: '/state/fabula/workbench',
  },
  hostStatus: 'ready',
  owner: { displayName: 'Owner', capabilityVersion: 2 },
  workerReady: true,
  openProjects: 0,
  restartRequired: false,
  generatedAt: '2026-08-03T00:00:00.000Z',
};

const inviteOverview: WorkbenchAdminOverviewV1 = {
  ...overview,
  setup: {
    ...overview.setup,
    projects: [
      {
        projectId: 'p-1',
        displayName: 'One',
        validation: 'valid',
        open: false,
        defaultProject: true,
      },
    ],
    defaultProjectId: 'p-1',
  },
};

const advancedResponse = {
  version: 1,
  providers: [
    {
      profileId: 'default',
      kind: 'pi',
      configured: false,
      endpoint: 'https://api.****/v1',
      model: 'de****t',
      lastValidation: 'unvalidated',
      lastValidatedAt: null,
    },
    {
      profileId: 'fast',
      kind: 'pi',
      configured: true,
      endpoint: 'https://fa****/v1',
      model: 'fa****l',
      lastValidation: 'valid',
      lastValidatedAt: null,
    },
  ],
  projects: [
    { projectId: 'p-1', displayName: 'One', providerProfile: 'default', trustedPlugins: [] },
  ],
  operationLimits: {
    maxQueuedPerProject: 8,
    maxConcurrentRendersPerProject: 1,
    maxConcurrentRendersPerHost: 2,
  },
  agent: { enabled: false, maxTurns: 8, maxToolCalls: 24 },
  generatedAt: '2026-08-03T00:00:00.000Z',
};

const appliedReceipt = {
  status: 'applied',
  activeRevision: 'a',
  candidateRevision: 'b',
  changedFields: [],
  diagnostics: [],
};

const discoveredResponse = {
  version: 1,
  projectId: 'p-1',
  plugins: [
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
  ],
};

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  // The Kobalte Tabs indicator (owner AdminShell tabs) needs ResizeObserver.
  if (typeof globalThis.ResizeObserver === 'undefined') {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('owner admin client contracts', () => {
  it('uses exact project and provider routes without generic patch fields', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetch: AdminFetch = async (input, init) => {
      calls.push({ input, init });
      return json({
        version: 1,
        project: null,
        provider: overview.setup.provider,
        receipt: {
          status: 'applied',
          activeRevision: 'a',
          candidateRevision: 'b',
          changedFields: [],
          diagnostics: [],
        },
      });
    };
    const client = createAdminClient({ fetch, initialAuthorization: 'owner' });

    await client.createProject({ projectId: 'p-1', displayName: 'One' });
    expect(calls[0]?.input).toBe('/api/v1/admin/projects');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      version: 1,
      projectId: 'p-1',
      displayName: 'One',
    });

    await client.updateProvider({
      kind: 'pi',
      baseUrl: 'https://provider.test',
      model: 'model-a',
    });
    expect(calls[1]?.input).toBe('/api/v1/admin/providers/ai-sdk');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      version: 1,
      kind: 'pi',
      baseUrl: 'https://provider.test',
      model: 'model-a',
    });
    expect(String(calls[1]?.init?.body)).not.toContain('patch');
  });

  it('rejects a known non-owner before a mutation reaches fetch', async () => {
    const fetch = vi.fn<AdminFetch>(async () => json({ version: 1 }));
    const client = createAdminClient({ fetch, initialAuthorization: 'user' });

    expect(() => client.clearProviderCredential()).toThrow(
      expect.objectContaining({
        name: 'AdminApiError',
        status: 403,
        code: 'FORBIDDEN',
      } satisfies Partial<AdminApiError>),
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('owner admin surfaces', () => {
  it('renders explicit non-owner authorization and sends no read or mutation request', () => {
    const fetch = vi.fn<AdminFetch>(async () => json({ version: 1 }));
    const client = createAdminClient({ fetch, initialAuthorization: 'user' });
    render(() => <AdminShell client={client} authorization="user" />);

    expect(
      screen.getByRole('heading', { name: 'Owner authorization required' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/only the owner can view or change Host administration/i),
    ).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires a project and sends the canonical reader role for invites', async () => {
    const user = userEvent.setup();
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetch: AdminFetch = async (input, init) => {
      calls.push({ input, init });
      if (String(input) === '/api/v1/admin/mcp-devices') return json({ version: 1, devices: [] });
      return json({
        version: 1,
        invite: {
          inviteId: 'invite-1',
          projectId: 'p-1',
          role: 'reader',
          expiresAt: '2026-08-04T00:00:00.000Z',
          consumedAt: null,
        },
      });
    };
    const client = createAdminClient({ fetch, initialAuthorization: 'owner' });
    render(() => (
      <AccessDevicesPage overview={inviteOverview} client={client} authorization="owner" />
    ));

    const createButton = screen.getByRole('button', { name: 'Create invite' });
    expect(createButton).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Choose invite project/i }));
    await user.click(await screen.findByRole('option', { name: 'One' }));
    await user.click(createButton);
    await screen.findByText('Invite created');

    const request = calls.find((call) => String(call.input) === '/api/v1/admin/invites');
    const body = String(request?.init?.body ?? '');
    expect(JSON.parse(body)).toEqual({
      version: 1,
      projectId: 'p-1',
      role: 'reader',
      ttlMs: 86400000,
    });
    expect(body).not.toMatch(/"role":"(?:user|owner)"/);
  });

  it('keeps config-source status explicitly unavailable instead of deriving it', () => {
    render(() => <SystemPage overview={overview} />);

    expect(screen.getByTestId('config-source-panel')).toHaveTextContent('unavailable');
    expect(screen.getByText(/typed safe configuration-source DTO/i)).toBeInTheDocument();
    expect(screen.getByText('Active revision')).toBeInTheDocument();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
    expect(screen.queryByText('/absolute/path/on-host')).not.toBeInTheDocument();
    expect(screen.queryByText('active-revision')).not.toBeInTheDocument();
  });

  it('clears a provider profile secret after a successful one-way credential write', async () => {
    const user = userEvent.setup();
    const bodies: string[] = [];
    const singleProfile = {
      ...advancedResponse,
      providers: advancedResponse.providers.slice(0, 1),
    };
    const fetch: AdminFetch = async (input, init) => {
      if (String(input).endsWith('/config/advanced')) return json(singleProfile);
      bodies.push(String(init?.body ?? ''));
      return json({ version: 1, profileId: 'default', configured: true });
    };
    const client = createAdminClient({ fetch, initialAuthorization: 'owner' });
    render(() => <ProviderPage overview={overview} client={client} authorization="owner" />);

    const input = await screen.findByLabelText('Provider API key for default');
    await user.type(input, 'secret-value');
    await user.click(screen.getByRole('button', { name: 'Store credential' }));

    expect(bodies.some((body) => body.includes('secret-value'))).toBe(true);
    await waitFor(() => expect(input).toHaveValue(''));
    expect(window.localStorage.getItem('novalistically.workbench.preferences')).toBeNull();
    expect(
      await screen.findByText(/not displayed or retained by this browser/i),
    ).toBeInTheDocument();
  });

  it('applies a project provider profile binding through the advanced CAS', async () => {
    const user = userEvent.setup();
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetch: AdminFetch = async (input, init) => {
      calls.push({ input, init });
      if (String(input).endsWith('/config/advanced') && (init?.method ?? 'GET') === 'GET') {
        return json(advancedResponse);
      }
      return json({ version: 1, receipt: appliedReceipt });
    };
    const client = createAdminClient({ fetch, initialAuthorization: 'owner' });
    render(() => <ProviderPage overview={overview} client={client} authorization="owner" />);

    const select = await screen.findByLabelText(/Provider profile/);
    await user.selectOptions(select, 'fast');

    const request = calls.find(
      (call) =>
        String(call.input) === '/api/v1/admin/config/advanced' && call.init?.method === 'PUT',
    );
    expect(JSON.parse(String(request?.init?.body ?? ''))).toEqual({
      version: 1,
      projects: [{ projectId: 'p-1', providerProfile: 'fast' }],
    });
  });
});

describe('owner advanced configuration surface', () => {
  it('renders operation limits, agent settings, and the plugin allowlist from the read view', async () => {
    const fetch: AdminFetch = async (input) => {
      if (String(input).includes('/plugins/discovered/')) return json(discoveredResponse);
      return json(advancedResponse);
    };
    const client = createAdminClient({ fetch, initialAuthorization: 'owner' });
    render(() => <AdvancedPage client={client} authorization="owner" />);

    await screen.findByTestId('admin-advanced-page');
    await waitFor(() =>
      expect(screen.getByLabelText('Max queued operations per project')).toHaveValue(8),
    );
    expect(screen.getByLabelText('Max concurrent renders per host')).toHaveValue(2);
    expect(screen.getByLabelText('Enable the workbench agent')).not.toBeChecked();
    expect(screen.getByLabelText('Max turns')).toHaveValue(8);
    expect(screen.getByLabelText('Max tool calls')).toHaveValue(24);
    expect(await screen.findByText('One')).toBeInTheDocument();
  });

  it('applies operation limit and agent changes through the CAS', async () => {
    const user = userEvent.setup();
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetch: AdminFetch = async (input, init) => {
      calls.push({ input, init });
      if (String(input).endsWith('/config/advanced') && (init?.method ?? 'GET') === 'GET') {
        return json(advancedResponse);
      }
      return json({ version: 1, receipt: appliedReceipt });
    };
    const client = createAdminClient({ fetch, initialAuthorization: 'owner' });
    render(() => <AdvancedPage client={client} authorization="owner" />);

    const queued = await screen.findByLabelText('Max queued operations per project');
    await waitFor(() => expect(queued).toHaveValue(8));
    await user.clear(queued);
    await user.type(queued, '16');
    await user.click(screen.getByRole('button', { name: 'Save operation limits' }));
    await screen.findByText(/Operation limits saved/i);

    await waitFor(() => expect(screen.getByLabelText('Max turns')).toHaveValue(8));
    await user.click(screen.getByRole('button', { name: 'Save agent settings' }));

    const requests = calls.filter(
      (call) =>
        String(call.input) === '/api/v1/admin/config/advanced' && call.init?.method === 'PUT',
    );
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const bodies = requests.map((call) => JSON.parse(String(call.init?.body ?? '')));
    expect(bodies).toContainEqual({
      version: 1,
      operationLimits: { maxQueuedPerProject: 16, maxConcurrentRendersPerHost: 2 },
    });
    expect(bodies).toContainEqual({
      version: 1,
      agent: { enabled: false, maxTurns: 8, maxToolCalls: 24 },
    });
  });

  it('previews agent and limits changes without applying them', async () => {
    const user = userEvent.setup();
    const previewBodies: string[] = [];
    let applied = false;
    const fetch: AdminFetch = async (input, init) => {
      if (String(input).endsWith('/config/advanced')) return json(advancedResponse);
      if (String(input).includes('/plugins/discovered/')) return json(discoveredResponse);
      if (String(input).endsWith('/config/preview')) {
        previewBodies.push(String(init?.body ?? ''));
        return json({
          version: 1,
          valid: true,
          diagnostics: [],
          changedFields: ['agent.enabled'],
          restartRequired: true,
          candidateRevision: 'candidate-revision',
        });
      }
      applied = true;
      return json({ version: 1, receipt: appliedReceipt });
    };
    const client = createAdminClient({ fetch, initialAuthorization: 'owner' });
    render(() => <AdvancedPage client={client} authorization="owner" />);

    await screen.findByTestId('admin-advanced-page');
    await user.click(screen.getByRole('button', { name: 'Preview' }));

    await screen.findByTestId('advanced-config-preview');
    expect(screen.getByText('valid')).toBeInTheDocument();
    expect(screen.getByText('agent.enabled')).toBeInTheDocument();
    expect(screen.getByText('yes')).toBeInTheDocument();
    expect(applied).toBe(false);
    expect(JSON.parse(previewBodies[0] ?? '{}')).toEqual({
      version: 1,
      operationLimits: { maxQueuedPerProject: 8, maxConcurrentRendersPerHost: 2 },
      agent: { enabled: false, maxTurns: 8, maxToolCalls: 24 },
    });
  });

  it('adds a trusted plugin to the selected project allowlist from the discovered set only', async () => {
    const user = userEvent.setup();
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const withPlugin = {
      ...advancedResponse,
      projects: [
        {
          ...advancedResponse.projects[0],
          trustedPlugins: [
            { name: 'arc', version: '1.0.0', moduleHash: 'abc123', required: false },
          ],
        },
      ],
    };
    let trusted = false;
    const fetch: AdminFetch = async (input, init) => {
      calls.push({ input, init });
      if (String(input).endsWith('/config/advanced') && (init?.method ?? 'GET') === 'GET') {
        return json(trusted ? withPlugin : advancedResponse);
      }
      if (String(input).includes('/plugins/discovered/')) return json(discoveredResponse);
      trusted = true;
      return json({ version: 1, receipt: appliedReceipt });
    };
    const client = createAdminClient({ fetch, initialAuthorization: 'owner' });
    render(() => <AdvancedPage client={client} authorization="owner" />);

    await screen.findByTestId('admin-advanced-page');
    await screen.findByTestId('discovered-plugins-table');
    await user.click(screen.getByRole('button', { name: 'Trust plugin arc' }));
    // Wait for the apply + refresh cycle before asserting the trusted state.
    await screen.findByText('Trusted');

    const request = calls.find(
      (call) =>
        String(call.input) === '/api/v1/admin/config/advanced' && call.init?.method === 'PUT',
    );
    expect(JSON.parse(String(request?.init?.body ?? ''))).toEqual({
      version: 1,
      projects: [
        {
          projectId: 'p-1',
          trustedPlugins: [
            { name: 'arc', version: '1.0.0', moduleHash: 'abc123', required: false },
          ],
        },
      ],
    });
    // The trusted entry now renders as already trusted in the discovered table.
    expect(screen.getByRole('button', { name: 'Trust plugin arc' })).toBeDisabled();
    expect(screen.getByText('Trusted')).toBeInTheDocument();
    // The refreshed allowlist shows the entry with its applied required status.
    expect(screen.getByRole('checkbox', { name: 'Require plugin arc' })).not.toBeChecked();
  });

  it('offers only Host-discovered plugins and never exposes path or URL inputs', async () => {
    const fetch: AdminFetch = async (input) => {
      if (String(input).endsWith('/config/advanced')) return json(advancedResponse);
      if (String(input).includes('/plugins/discovered/')) return json(discoveredResponse);
      return json({ version: 1 });
    };
    const client = createAdminClient({ fetch, initialAuthorization: 'owner' });
    render(() => <AdvancedPage client={client} authorization="owner" />);

    await screen.findByTestId('discovered-plugins-table');
    expect(screen.getByText('arc')).toBeInTheDocument();
    expect(screen.getByText('novel-prose')).toBeInTheDocument();
    expect(screen.getByText('transform')).toBeInTheDocument();
    expect(screen.getByText('observe')).toBeInTheDocument();
    // No free-text identity fields exist: the UI cannot submit a path or URL.
    expect(screen.queryByLabelText('Plugin name')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Plugin version')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Module hash')).not.toBeInTheDocument();
  });

  it('toggles the required flag and surfaces the restart-required receipt', async () => {
    const user = userEvent.setup();
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const restartReceipt = {
      ...appliedReceipt,
      status: 'restart-required',
      changedFields: ['projects.p-1.trustedPlugins'],
    };
    const withPlugin = {
      ...advancedResponse,
      projects: [
        {
          ...advancedResponse.projects[0],
          trustedPlugins: [
            { name: 'arc', version: '1.0.0', moduleHash: 'abc123', required: false },
          ],
        },
      ],
    };
    const fetch: AdminFetch = async (input, init) => {
      calls.push({ input, init });
      if (String(input).endsWith('/config/advanced') && (init?.method ?? 'GET') === 'GET') {
        return json(withPlugin);
      }
      if (String(input).includes('/plugins/discovered/')) return json(discoveredResponse);
      return json({ version: 1, receipt: restartReceipt });
    };
    const client = createAdminClient({ fetch, initialAuthorization: 'owner' });
    render(() => <AdvancedPage client={client} authorization="owner" />);

    await screen.findByTestId('admin-advanced-page');
    await screen.findByTestId('trusted-plugins-table');
    const toggle = await screen.findByRole('checkbox', { name: 'Require plugin arc' });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);

    await screen.findByTestId('advanced-restart-receipt');
    expect(screen.getByText('Saved — restart required')).toBeInTheDocument();
    expect(screen.getByText('projects.p-1.trustedPlugins')).toBeInTheDocument();
    const request = calls.find(
      (call) =>
        String(call.input) === '/api/v1/admin/config/advanced' && call.init?.method === 'PUT',
    );
    expect(JSON.parse(String(request?.init?.body ?? ''))).toEqual({
      version: 1,
      projects: [
        {
          projectId: 'p-1',
          trustedPlugins: [{ name: 'arc', version: '1.0.0', moduleHash: 'abc123', required: true }],
        },
      ],
    });
  });

  it('mounts the advanced section for an owner session', async () => {
    const user = userEvent.setup();
    const fetch: AdminFetch = async (input) => {
      if (String(input) === '/api/v1/admin/overview') return json(overview);
      if (String(input) === '/api/v1/admin/operations') {
        return json({
          version: 1,
          configurationOperations: [],
          audit: [],
          generatedAt: '2026-08-03T00:00:00.000Z',
        });
      }
      if (String(input).endsWith('/config/advanced')) return json(advancedResponse);
      return json({ version: 1 });
    };
    const client = createAdminClient({ fetch, initialAuthorization: 'owner' });
    render(() => <AdminShell client={client} authorization="owner" />);

    await screen.findByRole('heading', { name: 'Workbench administration' });
    await user.click(screen.getByRole('tab', { name: /Advanced/i }));
    expect(await screen.findByTestId('admin-advanced-page')).toBeInTheDocument();
  });
});

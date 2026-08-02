import { cleanup, render, screen } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchAdminOverviewV1 } from '../../src/contracts/index.js';
import {
  createAdminClient,
  type AdminApiError,
  type AdminFetch,
} from '../../src/client/admin/admin-client';
import { AdminShell } from '../../src/client/admin/AdminShell';
import { ProviderPage } from '../../src/client/admin/ProviderPage';
import { SystemPage } from '../../src/client/admin/SystemPage';

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
      kind: 'ai-sdk',
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
  },
  hostStatus: 'ready',
  owner: { displayName: 'Owner', capabilityVersion: 2 },
  workerReady: true,
  openProjects: 0,
  restartRequired: false,
  generatedAt: '2026-08-03T00:00:00.000Z',
};

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('owner admin client contracts', () => {
  it('uses exact project and provider routes without generic patch fields', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetch: AdminFetch = async (input, init) => {
      calls.push({ input, init });
      return json({ version: 1, project: null, provider: overview.setup.provider, receipt: { status: 'applied', activeRevision: 'a', candidateRevision: 'b', changedFields: [], diagnostics: [] } });
    };
    const client = createAdminClient({ fetch, initialAuthorization: 'owner' });

    await client.createProject({ projectId: 'p-1', displayName: 'One', root: '/private/project' });
    expect(calls[0]?.input).toBe('/api/v1/admin/projects');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ version: 1, projectId: 'p-1', displayName: 'One', root: '/private/project' });

    await client.updateProvider({ kind: 'ai-sdk', baseUrl: 'https://provider.test', model: 'model-a' });
    expect(calls[1]?.input).toBe('/api/v1/admin/providers/ai-sdk');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ version: 1, kind: 'ai-sdk', baseUrl: 'https://provider.test', model: 'model-a' });
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

    expect(screen.getByRole('heading', { name: 'Owner authorization required' })).toBeInTheDocument();
    expect(screen.getByText(/only the owner can view or change Host administration/i)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
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

  it('clears a provider secret after a successful one-way credential write', async () => {
    const user = userEvent.setup();
    let requestBody = '';
    const fetch: AdminFetch = async (_input, init) => {
      requestBody = String(init?.body ?? '');
      return json({ version: 1, providerId: 'ai-sdk', configured: true });
    };
    const client = createAdminClient({ fetch, initialAuthorization: 'owner' });
    render(() => <ProviderPage overview={overview} client={client} authorization="owner" />);

    const input = screen.getByLabelText('Provider API key');
    await user.type(input, 'secret-value');
    await user.click(screen.getByRole('button', { name: 'Store credential' }));

    expect(requestBody).toContain('secret-value');
    expect(input).toHaveValue('');
    expect(window.localStorage.getItem('novalistically.workbench.preferences')).toBeNull();
    expect(screen.getByText(/not displayed or retained/i)).toBeInTheDocument();
  });
});

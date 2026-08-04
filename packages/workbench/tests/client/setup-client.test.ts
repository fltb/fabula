import { describe, expect, it } from 'vitest';
import type { BrowserFetch } from '../../src/client/browser-read-client';
import { createSetupClient, SetupApiError } from '../../src/client/setup-client';

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('createSetupClient', () => {
  it('uses exact setup paths and sends one-way inputs without retaining response material', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetch: BrowserFetch = async (input, init) => {
      calls.push({ input, init });
      return json({ version: 1, validation: 'valid', projectId: 'project-a' });
    };
    const client = createSetupClient({ fetch, baseUrl: 'http://host.test' });

    await client.validateProject({
      projectId: 'project-a',
      displayName: 'A Project',
      root: '/private/project-root',
    });

    expect(calls[0]?.input).toBe('http://host.test/api/v1/setup/projects/validate');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      version: 1,
      projectId: 'project-a',
      displayName: 'A Project',
      root: '/private/project-root',
    });
  });

  it('normalizes setup diagnostics so secret and root values never reach a UI error', async () => {
    const client = createSetupClient({
      fetch: async () =>
        json(
          {
            error: {
              code: 'PROJECT_INVALID_ROOT',
              message: '/private/project-root and sk-live-secret should not be shown',
            },
          },
          400,
        ),
    });

    await expect(
      client.validateProject({
        projectId: 'project-a',
        displayName: 'A Project',
        root: '/private/project-root',
      }),
    ).rejects.toMatchObject({
      name: 'SetupApiError',
      code: 'PROJECT_INVALID_ROOT',
      field: 'project',
      message: 'The Host could not validate this project.',
    });
    try {
      await client.validateProject({
        projectId: 'project-a',
        displayName: 'A Project',
        root: '/private/project-root',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(SetupApiError);
      expect(String(error)).not.toContain('/private/project-root');
      expect(String(error)).not.toContain('sk-live-secret');
    }
  });

  it('maps transport failure to a host-scoped safe error', async () => {
    const client = createSetupClient({
      fetch: async () => {
        throw new Error('network internals');
      },
    });
    await expect(client.getStatus()).rejects.toMatchObject({
      name: 'SetupApiError',
      field: 'host',
      message: 'The Workbench Host could not be reached.',
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  type BrowserFetch,
  BrowserReadApiError,
  createBrowserReadClient,
} from '../../src/client/browser-read-client';

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('createBrowserReadClient', () => {
  it('uses the transient session only for a same-origin Host read request', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetch: BrowserFetch = async (input, init) => {
      calls.push({ input, init });
      return json({ version: 1, projects: [] });
    };
    const client = createBrowserReadClient({
      baseUrl: 'http://host.test',
      getSessionId: () => 'live-session',
      fetch,
    });

    await expect(client.listProjects()).resolves.toEqual({ version: 1, projects: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('http://host.test/api/v1/projects');
    expect(new Headers(calls[0]?.init?.headers).get('x-fabula-session')).toBe('live-session');
    expect(calls[0]?.init?.credentials).toBe('same-origin');
  });

  it('encodes only the documented route selector for graph reads', async () => {
    let requested = '';
    const client = createBrowserReadClient({
      fetch: async (input) => {
        requested = String(input);
        return json({ version: 1, story: {}, discourse: {}, route: {} });
      },
    });

    await client.getGraphs('project/id', {
      version: 1,
      branchPath: { decisions: [{ atEventId: 'E0', choiceId: 'accept', narrativeOrder: 0 }] },
      discourseBranch: 'main',
    });

    expect(requested).toContain('/api/v1/projects/project%2Fid/graphs?route=');
    expect(requested).toContain(encodeURIComponent('"discourseBranch":"main"'));
  });

  it('reads Source Studio state from the project source route', async () => {
    let requested = '';
    const state = {
      version: 1,
      projectId: 'proj-a',
      accepted: null,
      working: { documents: [] },
      generatedAt: '2026-08-02T00:00:00.000Z',
    };
    const client = createBrowserReadClient({
      fetch: async (input) => {
        requested = String(input);
        return json(state);
      },
    });

    await expect(client.getSourceStudio('proj/a')).resolves.toEqual(state);
    expect(requested).toBe('/api/v1/projects/proj%2Fa/source');
  });

  it('encodes only documented pagination for reference library reads', async () => {
    let requested = '';
    const client = createBrowserReadClient({
      fetch: async (input) => {
        requested = String(input);
        return json({ version: 1, projectId: 'proj-a', items: [], nextCursor: null });
      },
    });
    await client.listReferences('proj/a', { pageSize: 2, cursor: 'next' });
    expect(requested).toBe('/api/v1/projects/proj%2Fa/references?pageSize=2&cursor=next');
  });

  it('decodes SOURCE_UNAVAILABLE as a typed Host error', async () => {
    const client = createBrowserReadClient({
      fetch: async () =>
        json({ error: { code: 'SOURCE_UNAVAILABLE', message: 'host failed' } }, 503),
    });
    await expect(client.getSourceStudio('proj-a')).rejects.toMatchObject({
      name: 'BrowserReadApiError',
      status: 503,
      code: 'SOURCE_UNAVAILABLE',
      message: 'host failed',
    });
  });

  it('accepts only declared Host error codes as typed failures', async () => {
    const known = createBrowserReadClient({
      fetch: async () => json({ error: { code: 'SESSION_EXPIRED', message: 'expired' } }, 401),
    });
    await expect(known.getSession()).rejects.toMatchObject({
      name: 'BrowserReadApiError',
      status: 401,
      code: 'SESSION_EXPIRED',
      message: 'expired',
    });

    const unknown = createBrowserReadClient({
      fetch: async () => json({ error: { code: 'INJECTED', message: 'untrusted' } }, 502),
    });
    try {
      await unknown.getSession();
      throw new Error('expected BrowserReadApiError');
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserReadApiError);
      expect((error as BrowserReadApiError).code).toBeNull();
      expect((error as BrowserReadApiError).message).toContain('HTTP 502');
    }
  });
});

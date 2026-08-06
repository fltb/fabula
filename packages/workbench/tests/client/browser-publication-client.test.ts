import { describe, expect, it } from 'vitest';
import { createBrowserPublicationClient } from '../../src/client/browser-publication-api';
import type { BrowserFetch } from '../../src/client/browser-read-client';

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const record = {
  version: 1,
  projectId: 'proj-a',
  publicationId: 'canonical',
  kind: 'canonical',
  status: 'current',
  sourceHash: 'source-hash',
  scopeHash: 'scope-hash',
  revisionIds: ['rev-1'],
  novelHash: 'novel-hash',
  relativeOutputPath: 'output/novel.md',
  byteLength: 1234,
  sceneCount: 8,
  wordCount: 1200,
  staleReasons: [],
  operationId: 'op-pub-1',
  createdAt: '2026-08-06T00:00:00.000Z',
  updatedAt: '2026-08-06T00:00:00.000Z',
} as const;

describe('createBrowserPublicationClient', () => {
  it('uses the transient session only for a same-origin publication read', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetch: BrowserFetch = async (input, init) => {
      calls.push({ input, init });
      return json({ version: 1, projectId: 'proj-a', publications: [], generatedAt: 'now' });
    };
    const client = createBrowserPublicationClient({
      baseUrl: 'http://host.test',
      getSessionId: () => 'live-session',
      fetch,
    });

    await expect(client.list('proj-a')).resolves.toMatchObject({ publications: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('http://host.test/api/v1/projects/proj-a/publications');
    expect(new Headers(calls[0]?.init?.headers).get('x-fabula-session')).toBe('live-session');
    expect(calls[0]?.init?.credentials).toBe('same-origin');
  });

  it('routes publication reads to the list, record and bounded content paths', async () => {
    const requested: string[] = [];
    const client = createBrowserPublicationClient({
      fetch: async (input) => {
        const url = String(input);
        requested.push(url);
        if (url.includes('/content')) {
          return json({
            version: 1,
            projectId: 'proj-a',
            publicationId: 'canonical',
            offset: 0,
            limit: 100,
            content: '# Chapter One\n',
            byteLength: 15,
            totalByteLength: 1234,
          });
        }
        if (url.includes('/publications/')) {
          return json({ version: 1, publication: record });
        }
        return json({
          version: 1,
          projectId: 'proj-a',
          publications: [record],
          generatedAt: 'now',
        });
      },
    });

    await client.list('proj/a');
    await client.get('proj/a', 'canonical');
    await client.read('proj/a', 'canonical', { offset: 0, limit: 100 });

    expect(requested).toEqual([
      '/api/v1/projects/proj%2Fa/publications',
      '/api/v1/projects/proj%2Fa/publications/canonical',
      '/api/v1/projects/proj%2Fa/publications/canonical/content?offset=0&limit=100',
    ]);
  });

  it('posts the publish request to the publications path and returns the result', async () => {
    let requested = '';
    let body = '';
    const client = createBrowserPublicationClient({
      fetch: async (input, init) => {
        requested = String(input);
        body = String(init?.body);
        return json({
          version: 1,
          projectId: 'proj-a',
          publicationId: 'canonical',
          kind: 'canonical',
          outcome: 'queued',
          operationId: 'op-pub-1',
          staleReasons: [],
        });
      },
    });

    await expect(client.publish({ version: 1, projectId: 'proj-a' })).resolves.toMatchObject({
      outcome: 'queued',
      operationId: 'op-pub-1',
    });

    expect(requested).toBe('/api/v1/projects/proj-a/publications');
    expect(JSON.parse(body)).toEqual({ version: 1, projectId: 'proj-a' });
  });

  it('posts custom branch identity fields for a custom publication', async () => {
    let body = '';
    const client = createBrowserPublicationClient({
      fetch: async (_input, init) => {
        body = String(init?.body);
        return json({
          version: 1,
          projectId: 'proj-a',
          publicationId: 'custom-id',
          kind: 'custom',
          outcome: 'queued',
          operationId: 'op-pub-2',
          staleReasons: [],
        });
      },
    });

    await client.publish({
      version: 1,
      projectId: 'proj-a',
      branchPath: {
        version: 1,
        branchPath: { decisions: [{ atEventId: 'E1', choiceId: 'c1', narrativeOrder: 1 }] },
      },
      discourseBranch: 'alternate',
      title: 'Alternate Ending',
    });

    expect(JSON.parse(body)).toEqual({
      version: 1,
      projectId: 'proj-a',
      branchPath: {
        version: 1,
        branchPath: { decisions: [{ atEventId: 'E1', choiceId: 'c1', narrativeOrder: 1 }] },
      },
      discourseBranch: 'alternate',
      title: 'Alternate Ending',
    });
  });

  it('decodes typed publication failures from the Host error envelope', async () => {
    const client = createBrowserPublicationClient({
      fetch: async () =>
        json({ error: { code: 'PUBLICATION_NOT_FOUND', message: 'no such publication' } }, 404),
    });

    await expect(client.get('proj-a', 'missing')).rejects.toMatchObject({
      name: 'BrowserPublicationApiError',
      status: 404,
      code: 'PUBLICATION_NOT_FOUND',
    });

    const unavailable = createBrowserPublicationClient({
      fetch: async () =>
        json({ error: { code: 'PUBLICATION_UNAVAILABLE', message: 'store down' } }, 503),
    });
    await expect(unavailable.list('proj-a')).rejects.toMatchObject({
      status: 503,
      code: 'PUBLICATION_UNAVAILABLE',
    });

    const unknown = createBrowserPublicationClient({
      fetch: async () => json({ error: { code: 'MYSTERY_CODE', message: '?' } }, 500),
    });
    await expect(unknown.list('proj-a')).rejects.toMatchObject({ status: 500, code: null });
  });
});

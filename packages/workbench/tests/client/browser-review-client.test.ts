import { describe, expect, it } from 'vitest';
import type { BrowserFetch } from '../../src/client/browser-read-client';
import { createBrowserReviewClient } from '../../src/client/browser-review-api';

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const comment = {
  version: 1,
  commentId: 'review-1',
  eventId: 'E1',
  targetType: 'scene',
  severity: 'suggestion',
  category: 'style',
  content: 'The prose is rushed.',
  status: 'open',
  author: 'human',
  createdAt: '2026-08-06T00:00:00.000Z',
  resolvedAt: null,
  supersedesId: null,
  applications: [
    {
      eventId: 'E1',
      revisionId: 'rev-2',
      operationId: 'op-2',
      appliedAt: '2026-08-06T01:00:00.000Z',
    },
  ],
} as const;

describe('createBrowserReviewClient', () => {
  it('uses the transient session only for a same-origin review request', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetch: BrowserFetch = async (input, init) => {
      calls.push({ input, init });
      return json({ version: 1, projectId: 'proj-a', comments: [], generatedAt: 'now' });
    };
    const client = createBrowserReviewClient({
      baseUrl: 'http://host.test',
      getSessionId: () => 'live-session',
      fetch,
    });

    await expect(client.list('proj-a')).resolves.toMatchObject({ comments: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('http://host.test/api/v1/projects/proj-a/reviews');
    expect(new Headers(calls[0]?.init?.headers).get('x-fabula-session')).toBe('live-session');
    expect(calls[0]?.init?.credentials).toBe('same-origin');
  });

  it('routes review reads to the comment and history paths with the event filter', async () => {
    const requested: string[] = [];
    const client = createBrowserReviewClient({
      fetch: async (input) => {
        const url = String(input);
        requested.push(url);
        if (url.includes('/reviews/history')) {
          return json({ version: 1, projectId: 'proj-a', entries: [], generatedAt: 'now' });
        }
        if (url.includes('/reviews/')) {
          return json({ version: 1, comment });
        }
        return json({ version: 1, projectId: 'proj-a', comments: [comment], generatedAt: 'now' });
      },
    });

    await client.list('proj/a', { eventId: 'E1' });
    await client.get('proj/a', 'review-1');
    await client.history('proj/a');

    expect(requested).toEqual([
      '/api/v1/projects/proj%2Fa/reviews?eventId=E1',
      '/api/v1/projects/proj%2Fa/reviews/review-1',
      '/api/v1/projects/proj%2Fa/reviews/history',
    ]);
  });

  it('posts the add request to the reviews path and returns the comment', async () => {
    let requested = '';
    let body = '';
    const client = createBrowserReviewClient({
      fetch: async (input, init) => {
        requested = String(input);
        body = String(init?.body);
        return json({ version: 1, comment });
      },
    });

    await expect(
      client.add({
        version: 1,
        projectId: 'proj-a',
        eventId: 'E1',
        severity: 'blocking',
        category: 'plot_logic',
        content: 'Plot hole.',
      }),
    ).resolves.toMatchObject({ comment: { commentId: 'review-1' } });

    expect(requested).toBe('/api/v1/projects/proj-a/reviews');
    expect(JSON.parse(body)).toEqual({
      version: 1,
      projectId: 'proj-a',
      eventId: 'E1',
      severity: 'blocking',
      category: 'plot_logic',
      content: 'Plot hole.',
    });
  });

  it('posts update actions to the per-comment path without invented fields', async () => {
    let requested = '';
    let body = '';
    const client = createBrowserReviewClient({
      fetch: async (input, init) => {
        requested = String(input);
        body = String(init?.body);
        return json({ version: 1, comment });
      },
    });

    await client.update({
      version: 1,
      projectId: 'proj-a',
      commentId: 'review-1',
      action: 'resolve',
    });

    expect(requested).toBe('/api/v1/projects/proj-a/reviews/review-1');
    expect(JSON.parse(body)).toEqual({
      version: 1,
      projectId: 'proj-a',
      commentId: 'review-1',
      action: 'resolve',
    });
  });

  it('lists gates and posts a gate decision to the per-gate decision path', async () => {
    const requested: string[] = [];
    const gate = {
      version: 1,
      gateId: 'gate-1',
      eventId: 'E1',
      sourceHash: 'source-hash',
      proseHash: 'prose-hash',
      scopeHash: 'scope-hash',
      validationIdentity: 'validation-id',
      warningFingerprints: ['w1'],
      revisionId: 'rev-1',
      status: 'open',
      decision: null,
      openedAt: '2026-08-06T00:00:00.000Z',
      supersededAt: null,
    };
    const client = createBrowserReviewClient({
      fetch: async (input, _init) => {
        requested.push(String(input));
        return String(input).includes('/decision')
          ? json({
              version: 1,
              projectId: 'proj-a',
              gateId: 'gate-1',
              eventId: 'E1',
              outcome: 'accepted',
              decisionStatus: 'accepted',
              decidedAt: '2026-08-06T02:00:00.000Z',
            })
          : json({ version: 1, projectId: 'proj-a', gates: [gate], generatedAt: 'now' });
      },
    });

    await expect(client.gateList('proj/a', { eventId: 'E1' })).resolves.toMatchObject({
      gates: [{ gateId: 'gate-1' }],
    });
    await expect(
      client.gateDecide({
        version: 1,
        projectId: 'proj-a',
        gateId: 'gate-1',
        decision: 'accept',
        reason: 'Warnings acceptable.',
      }),
    ).resolves.toMatchObject({ outcome: 'accepted' });

    expect(requested).toEqual([
      '/api/v1/projects/proj%2Fa/gates?eventId=E1',
      '/api/v1/projects/proj-a/gates/gate-1/decision',
    ]);
  });

  it('decodes typed review and gate failures from the Host error envelope', async () => {
    const denied = createBrowserReviewClient({
      fetch: async () =>
        json({ error: { code: 'GATE_NOT_OPEN', message: 'already decided' } }, 409),
    });
    await expect(denied.gateList('proj-a')).rejects.toMatchObject({
      name: 'BrowserReviewApiError',
      status: 409,
      code: 'GATE_NOT_OPEN',
      message: 'already decided',
    });

    const missing = createBrowserReviewClient({
      fetch: async () =>
        json({ error: { code: 'REVIEW_COMMENT_NOT_FOUND', message: 'gone' } }, 404),
    });
    await expect(missing.get('proj-a', 'review-x')).rejects.toMatchObject({
      status: 404,
      code: 'REVIEW_COMMENT_NOT_FOUND',
    });

    const unknown = createBrowserReviewClient({
      fetch: async () => json({ error: { code: 'INJECTED', message: 'untrusted' } }, 502),
    });
    try {
      await unknown.list('proj-a');
      throw new Error('expected BrowserReviewApiError');
    } catch (error) {
      expect(error).toMatchObject({ name: 'BrowserReviewApiError', status: 502, code: null });
    }
  });
});

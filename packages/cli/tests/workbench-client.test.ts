import { describe, expect, it } from 'vitest';
import {
  resolveWorkbenchMode,
  WorkbenchClient,
  WorkbenchClientError,
} from '../src/workbench-client.ts';

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('typed Workbench CLI client', () => {
  it('dispatches catalogued tools to the project-scoped Host route', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const client = new WorkbenchClient({
      host: 'http://127.0.0.1:8787/',
      projectId: 'novel/one',
      credential: 'opaque-device-token',
      fetch: async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return response({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }] },
        });
      },
    });

    await expect(client.status()).resolves.toEqual({ status: 'ok' });
    expect(requestUrl).toBe('http://127.0.0.1:8787/mcp/projects/novel%2Fone');
    expect(requestInit?.method).toBe('POST');
    expect(new Headers(requestInit?.headers).get('authorization')).toBe(
      'Bearer opaque-device-token',
    );
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'nova_status', arguments: {} },
    });
  });

  it('serializes render reference selectors without Host-resolved chunk fields', async () => {
    let requestBody = '';
    const client = new WorkbenchClient({
      projectId: 'novel',
      credential: 'opaque-device-token',
      fetch: async (_input, init) => {
        requestBody = String(init?.body);
        return response({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify({ status: 'queued' }) }] },
        });
      },
    });

    await expect(
      client.render({
        sceneSelector: { type: 'all' },
        referenceChunks: [{ referenceId: 'guide', chunkId: 'guide:0' }],
      }),
    ).resolves.toEqual({ status: 'queued' });

    expect(JSON.parse(requestBody)).toMatchObject({
      params: {
        name: 'nova_render',
        arguments: {
          sceneSelector: { type: 'all' },
          referenceChunks: [{ referenceId: 'guide', chunkId: 'guide:0' }],
        },
      },
    });
  });

  it('rejects identity smuggling before issuing a Host request', async () => {
    let calls = 0;
    const client = new WorkbenchClient({
      projectId: 'novel',
      credential: 'opaque-device-token',
      fetch: async () => {
        calls += 1;
        return response({});
      },
    });

    await expect(client.call('nova_status', { actorId: 'spoofed' })).rejects.toThrow(
      'Unknown field "actorId"',
    );
    expect(calls).toBe(0);
  });

  it('maps typed Host authorization and CAS failures to CLI errors', async () => {
    const unauthorized = new WorkbenchClient({
      projectId: 'novel',
      credential: 'opaque-device-token',
      fetch: async () => response({ error: { code: 'SCOPE_MISMATCH', message: 'denied' } }, 403),
    });
    await expect(unauthorized.status()).rejects.toMatchObject({
      code: 'SCOPE_MISMATCH',
      exitCode: 4,
    });

    const conflict = new WorkbenchClient({
      projectId: 'novel',
      credential: 'opaque-device-token',
      fetch: async () =>
        response({
          jsonrpc: '2.0',
          id: 1,
          result: {
            isError: true,
            content: [
              { type: 'text', text: JSON.stringify({ code: 'WORKSPACE_STALE', message: 'retry' }) },
            ],
          },
        }),
    });
    await expect(conflict.status()).rejects.toBeInstanceOf(WorkbenchClientError);
    await expect(conflict.status()).rejects.toMatchObject({ code: 'WORKSPACE_STALE', exitCode: 5 });
  });

  it('dispatches working-layer validation to nova_authoring_validate', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new WorkbenchClient({
      projectId: 'novel',
      credential: 'opaque-device-token',
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return response({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  version: 2,
                  layer: 'working',
                  passed: true,
                  candidateSourceHash: 'candidate-hash',
                }),
              },
            ],
          },
        });
      },
    });

    await expect(
      client.authoringValidate({
        version: 2,
        expectedWorkspaceDigest: 'digest-1',
        expectedAcceptedSourceHash: 'accepted-hash',
      }),
    ).resolves.toMatchObject({
      layer: 'working',
      passed: true,
      candidateSourceHash: 'candidate-hash',
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      params: {
        name: 'nova_authoring_validate',
        arguments: {
          version: 2,
          expectedWorkspaceDigest: 'digest-1',
          expectedAcceptedSourceHash: 'accepted-hash',
        },
      },
    });
  });

  it('passes the submit message through and omits it when absent', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new WorkbenchClient({
      projectId: 'novel',
      credential: 'opaque-device-token',
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return response({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ status: 'queued', receipt: { operationId: 'op-1' } }),
              },
            ],
          },
        });
      },
    });

    await expect(
      client.authoringSubmit({ version: 2, expectedWorkspaceDigest: 'digest-1', message: 'hello' }),
    ).resolves.toMatchObject({ status: 'queued' });
    expect(bodies[0]).toMatchObject({
      params: {
        name: 'nova_authoring_submit',
        arguments: { version: 2, expectedWorkspaceDigest: 'digest-1', message: 'hello' },
      },
    });

    await client.authoringSubmit({ version: 2, expectedWorkspaceDigest: 'digest-1' });
    expect(bodies[1]).toMatchObject({
      params: {
        name: 'nova_authoring_submit',
        arguments: { version: 2, expectedWorkspaceDigest: 'digest-1' },
      },
    });
    const secondParams = bodies[1].params;
    expect(
      typeof secondParams === 'object' && secondParams !== null && 'arguments' in secondParams
        ? secondParams.arguments
        : undefined,
    ).not.toHaveProperty('message');
  });

  it('queries one Host operation by handle', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new WorkbenchClient({
      projectId: 'novel',
      credential: 'opaque-device-token',
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return response({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  version: 2,
                  operationId: 'op-1',
                  receipt: { status: 'completed', revisionId: 'rev-1' },
                }),
              },
            ],
          },
        });
      },
    });

    await expect(
      client.operationGet({ version: 2, operationHandle: 'op-1' }),
    ).resolves.toMatchObject({
      operationId: 'op-1',
      receipt: { status: 'completed', revisionId: 'rev-1' },
    });
    expect(bodies[0]).toMatchObject({
      params: { name: 'nova_operation_get', arguments: { version: 2, operationHandle: 'op-1' } },
    });
  });

  it('dispatches conflict resolution with the predefined choice', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new WorkbenchClient({
      projectId: 'novel',
      credential: 'opaque-device-token',
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return response({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ status: 'queued', receipt: { operationId: 'op-2' } }),
              },
            ],
          },
        });
      },
    });

    await expect(
      client.conflictResolve({
        version: 2,
        choice: 'apply-proposed-disjoint-merge',
        candidateHash: 'candidate-hash',
      }),
    ).resolves.toMatchObject({ status: 'queued' });
    expect(bodies[0]).toMatchObject({
      params: {
        name: 'nova_conflict_resolve',
        arguments: {
          version: 2,
          choice: 'apply-proposed-disjoint-merge',
          candidateHash: 'candidate-hash',
        },
      },
    });
  });

  it('passes revise instruction and review ids to nova_revise only', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new WorkbenchClient({
      projectId: 'novel',
      credential: 'opaque-device-token',
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return response({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ status: 'queued', receipt: { operationId: 'op-3' } }),
              },
            ],
          },
        });
      },
    });

    await expect(
      client.revise({
        sceneSelector: { type: 'all' },
        instruction: 'Make it darker',
        reviewIds: ['review-1', 'review-2'],
      }),
    ).resolves.toMatchObject({ status: 'queued' });
    expect(bodies[0]).toMatchObject({
      params: {
        name: 'nova_revise',
        arguments: {
          sceneSelector: { type: 'all' },
          instruction: 'Make it darker',
          reviewIds: ['review-1', 'review-2'],
        },
      },
    });

    // `nova_render` has a distinct schema: instruction/reviewIds must never leak there.
    await expect(
      client.render({ sceneSelector: { type: 'all' }, instruction: 'x' }),
    ).rejects.toThrow('Unknown field "instruction"');
  });

  it('returns the before/after/changed event state diff', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new WorkbenchClient({
      projectId: 'novel',
      credential: 'opaque-device-token',
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return response({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  eventId: 'E1',
                  before: { info: { currentEra: 'initial' } },
                  after: { info: { currentEra: 'war' } },
                  changed: ['info.currentEra'],
                }),
              },
            ],
          },
        });
      },
    });

    await expect(client.eventStateDiff({ eventId: 'E1' })).resolves.toMatchObject({
      eventId: 'E1',
      changed: ['info.currentEra'],
    });
    expect(bodies[0]).toMatchObject({
      params: { name: 'nova_event_state_diff', arguments: { eventId: 'E1' } },
    });
  });

  it('routes revision history methods to their catalogued tools', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new WorkbenchClient({
      projectId: 'novel',
      credential: 'opaque-device-token',
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return response({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: '{}' }] },
        });
      },
    });

    await client.revisionList({ version: 2 });
    await client.revisionGet({ version: 2, revisionId: 'rev-1' });
    await client.revisionDiff({ version: 2, fromRevisionId: 'rev-1', toRevisionId: 'rev-2' });
    await client.revisionRestore({ version: 2, revisionId: 'rev-2' });

    expect(bodies[0]).toMatchObject({
      params: { name: 'nova_revision_list', arguments: { version: 2 } },
    });
    expect(bodies[1]).toMatchObject({
      params: { name: 'nova_revision_get', arguments: { version: 2, revisionId: 'rev-1' } },
    });
    expect(bodies[2]).toMatchObject({
      params: {
        name: 'nova_revision_diff',
        arguments: { version: 2, fromRevisionId: 'rev-1', toRevisionId: 'rev-2' },
      },
    });
    expect(bodies[3]).toMatchObject({
      params: { name: 'nova_revision_restore', arguments: { version: 2, revisionId: 'rev-2' } },
    });
  });

  it('requires explicit project and credential inputs for Host mode', () => {
    expect(resolveWorkbenchMode({ mode: 'standalone' })).toEqual({ mode: 'standalone' });
    expect(
      resolveWorkbenchMode({
        mode: 'via-workbench',
        projectId: 'novel',
        host: 'http://127.0.0.1:8787',
      }),
    ).toEqual({ mode: 'via-workbench', projectId: 'novel', host: 'http://127.0.0.1:8787' });
    expect(() => resolveWorkbenchMode({ mode: 'via-workbench' })).toThrow(/project/);
  });

  it('dispatches review reads and history to nova_review_list/get', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new WorkbenchClient({
      projectId: 'novel',
      credential: 'opaque-device-token',
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return response({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ version: 1, items: [] }) }],
          },
        });
      },
    });

    await expect(client.reviewList()).resolves.toEqual({ version: 1, items: [] });
    await expect(client.reviewList({ version: 1, eventId: 'E1' })).resolves.toEqual({
      version: 1,
      items: [],
    });
    await expect(client.reviewHistory({ version: 1, eventId: 'E1' })).resolves.toEqual({
      version: 1,
      items: [],
    });
    await expect(client.reviewGet({ version: 1, commentId: 'review-1' })).resolves.toEqual({
      version: 1,
      items: [],
    });

    expect(bodies.map((body) => body.params)).toEqual([
      { name: 'nova_review_list', arguments: { version: 1 } },
      { name: 'nova_review_list', arguments: { version: 1, eventId: 'E1' } },
      { name: 'nova_review_list', arguments: { version: 1, eventId: 'E1' } },
      { name: 'nova_review_get', arguments: { version: 1, commentId: 'review-1' } },
    ]);
  });

  it('dispatches review mutations to nova_review_add/update with strict inputs', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new WorkbenchClient({
      projectId: 'novel',
      credential: 'opaque-device-token',
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return response({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [
              { type: 'text', text: JSON.stringify({ version: 1, comment: { id: 'review-2' } }) },
            ],
          },
        });
      },
    });

    await expect(
      client.reviewAdd({
        version: 1,
        target: { type: 'scene', id: 'E1' },
        severity: 'blocking',
        category: 'plot_logic',
        content: 'Plot hole.',
      }),
    ).resolves.toMatchObject({ comment: { id: 'review-2' } });
    await expect(
      client.reviewUpdate({
        version: 1,
        commentId: 'review-1',
        action: 'escalate',
      }),
    ).resolves.toMatchObject({ comment: { id: 'review-2' } });

    expect(bodies.map((body) => body.params)).toEqual([
      {
        name: 'nova_review_add',
        arguments: {
          version: 1,
          target: { type: 'scene', id: 'E1' },
          severity: 'blocking',
          category: 'plot_logic',
          content: 'Plot hole.',
        },
      },
      {
        name: 'nova_review_update',
        arguments: { version: 1, commentId: 'review-1', action: 'escalate' },
      },
    ]);

    await expect(
      client.reviewAdd({
        version: 1,
        target: { type: 'scene', id: 'E1' },
        severity: 'suggestion',
        category: 'style',
        content: 'Tighten.',
        actorId: 'spoofed',
      }),
    ).rejects.toThrow('Unknown field "actorId"');
  });

  it('dispatches gate reads and decisions to nova_release_gate_*', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new WorkbenchClient({
      projectId: 'novel',
      credential: 'opaque-device-token',
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return response({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  version: 1,
                  resolution: { outcome: 'accepted' },
                }),
              },
            ],
          },
        });
      },
    });

    await expect(client.gateList({ version: 1, eventId: 'E1' })).resolves.toMatchObject({
      version: 1,
    });
    await expect(
      client.gateDecide({
        version: 1,
        eventId: 'E1',
        candidateRevisionId: 'rev-1',
        decision: 'accept',
        reason: 'Warnings acceptable.',
      }),
    ).resolves.toMatchObject({ resolution: { outcome: 'accepted' } });

    expect(bodies.map((body) => body.params)).toEqual([
      { name: 'nova_release_gate_list', arguments: { version: 1, eventId: 'E1' } },
      {
        name: 'nova_release_gate_decide',
        arguments: {
          version: 1,
          eventId: 'E1',
          candidateRevisionId: 'rev-1',
          decision: 'accept',
          reason: 'Warnings acceptable.',
        },
      },
    ]);

    await expect(
      client.gateDecide({
        version: 1,
        eventId: 'E1',
        candidateRevisionId: 'rev-1',
        decision: 'accept',
        reason: 'Warnings acceptable.',
        actorId: 'spoofed',
      }),
    ).rejects.toThrow('Unknown field "actorId"');
  });

  it('dispatches publish and publication reads to nova_publish/nova_publication_*', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new WorkbenchClient({
      projectId: 'novel',
      credential: 'opaque-device-token',
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return response({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  version: 1,
                  publicationId: 'canonical',
                  status: 'queued',
                  operationHandle: 'op-pub-1',
                }),
              },
            ],
          },
        });
      },
    });

    await expect(client.publicationPublish({ version: 1 })).resolves.toMatchObject({
      status: 'queued',
      operationHandle: 'op-pub-1',
    });
    await expect(
      client.publicationPublish({
        version: 1,
        branchPath: {
          version: 1,
          branchPath: { decisions: [{ atEventId: 'E1', choiceId: 'c1', narrativeOrder: 1 }] },
        },
        discourseBranch: 'alternate',
        title: 'Alternate Ending',
      }),
    ).resolves.toMatchObject({ status: 'queued' });
    await expect(
      client.publicationGet({ version: 1, publicationId: 'canonical' }),
    ).resolves.toMatchObject({ publicationId: 'canonical' });
    await expect(
      client.publicationRead({ version: 1, publicationId: 'canonical', offset: 10, limit: 100 }),
    ).resolves.toMatchObject({ status: 'queued' });

    expect(bodies.map((body) => body.params)).toEqual([
      { name: 'nova_publish', arguments: { version: 1 } },
      {
        name: 'nova_publish',
        arguments: {
          version: 1,
          branchPath: {
            version: 1,
            branchPath: { decisions: [{ atEventId: 'E1', choiceId: 'c1', narrativeOrder: 1 }] },
          },
          discourseBranch: 'alternate',
          title: 'Alternate Ending',
        },
      },
      { name: 'nova_publication_get', arguments: { version: 1, publicationId: 'canonical' } },
      {
        name: 'nova_publication_read',
        arguments: { version: 1, publicationId: 'canonical', offset: 10, limit: 100 },
      },
    ]);

    await expect(
      client.publicationPublish({ version: 1, publicationId: 'spoofed' }),
    ).rejects.toThrow('Unknown field "publicationId"');
  });
});

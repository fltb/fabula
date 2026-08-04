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
});

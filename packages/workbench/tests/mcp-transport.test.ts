import { describe, expect, it } from 'vitest';
import type {
  McpAuthorizationPort,
  McpAuthorizationResult,
  McpAuthorizedCaller,
} from '../src/host/mcp/auth.js';
import {
  MCP_READ_SCOPE,
  MCP_RENDER_SCOPE,
  type McpJsonInputSchema,
  type McpToolDefinition,
  type McpToolRegistry,
} from '../src/host/mcp/registry.js';
import {
  createMcpStreamableEndpoint,
  MCP_CAPABILITY_SCHEME,
  MCP_SESSION_HEADER,
  mountMcpStreamableEndpoint,
} from '../src/host/mcp/transport.js';
import { createHostServer } from '../src/host/server.js';

const PROJECT_ID = 'project-a';
const SESSION_ID = 'session-a';
const TOKEN = 'fc_test';
const caller: McpAuthorizedCaller = {
  sessionId: SESSION_ID,
  userId: 'user-a',
  grant: {
    capabilityId: 'capability-a',
    userId: 'user-a',
    projectId: PROJECT_ID,
    scopes: [MCP_READ_SCOPE, MCP_RENDER_SCOPE],
    version: 1,
    expiresAt: '2099-01-01T00:00:00.000Z',
  },
};
const inputSchema: McpJsonInputSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

function rpc(method: string, params: Record<string, unknown> = {}): Request {
  return new Request('http://workbench.test/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      [MCP_SESSION_HEADER]: SESSION_ID,
      authorization: `${MCP_CAPABILITY_SCHEME} ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

function tool(name: string, requiredScopes: readonly string[]): McpToolDefinition {
  return {
    name,
    description: `${name} tool`,
    requiredScopes,
    inputSchema,
    run: async (_caller, input) => ({ ok: true, data: { name, input } }),
  };
}

function authorization(
  authorize: (
    input: Parameters<McpAuthorizationPort['authorize']>[0],
  ) => Promise<McpAuthorizationResult>,
): McpAuthorizationPort {
  return { authorize };
}

function registry(definitions: readonly McpToolDefinition[]): McpToolRegistry {
  return {
    projectId: PROJECT_ID,
    session: {} as McpToolRegistry['session'],
    availableScopes: [...new Set(definitions.flatMap((definition) => definition.requiredScopes))],
    list: (scopes) =>
      definitions.filter((definition) =>
        definition.requiredScopes.every((scope) => scopes.includes(scope)),
      ),
    get: (name) => definitions.find((definition) => definition.name === name) ?? null,
    run: async (name, currentCaller, input) => {
      const definition = definitions.find((candidate) => candidate.name === name);
      if (definition === undefined) {
        return { ok: false, error: { code: 'TOOL_NOT_FOUND', message: `Unknown tool: ${name}` } };
      }
      return definition.run(currentCaller, input);
    },
  };
}

describe('MCP Streamable HTTP endpoint', () => {
  it('rejects missing session/token headers before JSON-RPC negotiation', async () => {
    const endpoint = createMcpStreamableEndpoint({
      route: 'project',
      registry: registry([tool('nova_status', [MCP_READ_SCOPE])]),
      authorization: authorization(async () => ({ ok: true, caller })),
    });

    const response = await endpoint.handle(
      new Request('http://workbench.test/mcp', { method: 'POST', body: '{}' }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    await expect(response.json()).resolves.toEqual({ error: { code: 'SESSION_NOT_FOUND' } });
  });

  it('returns an HTTP authorization denial before exposing tools', async () => {
    const endpoint = createMcpStreamableEndpoint({
      route: 'project',
      registry: registry([tool('nova_status', [MCP_READ_SCOPE])]),
      authorization: authorization(async () => ({
        ok: false,
        failure: { code: 'SCOPE_MISMATCH', message: 'not granted' },
      })),
    });

    const response = await endpoint.handle(rpc('tools/list'));

    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: { code: 'SCOPE_MISMATCH' } });
  });

  it('does not retry discovery after a non-scope authorization failure', async () => {
    const calls: Parameters<McpAuthorizationPort['authorize']>[0][] = [];
    const endpoint = createMcpStreamableEndpoint({
      route: 'project',
      registry: registry([tool('nova_status', [MCP_READ_SCOPE])]),
      authorization: authorization(async (input) => {
        calls.push(input);
        return { ok: false, failure: { code: 'TOKEN_INVALID', message: 'invalid token' } };
      }),
    });

    const response = await endpoint.handle(rpc('tools/list'));

    expect(response.status).toBe(401);
    expect(calls.map((call) => call.scopes)).toEqual([[MCP_READ_SCOPE]]);
  });

  it('lists only tool definitions covered by the server-derived capability', async () => {
    const endpoint = createMcpStreamableEndpoint({
      route: 'project',
      registry: registry([
        tool('nova_status', [MCP_READ_SCOPE]),
        tool('nova_render', [MCP_RENDER_SCOPE]),
      ]),
      authorization: authorization(async (input) => {
        expect(input).toMatchObject({ sessionId: SESSION_ID, token: TOKEN, projectId: PROJECT_ID });
        return {
          ok: true,
          caller: {
            ...caller,
            grant: { ...caller.grant, scopes: [MCP_READ_SCOPE] },
          },
        };
      }),
    });

    const response = await endpoint.handle(rpc('tools/list'));
    const payload = (await response.json()) as { result?: { tools?: Array<{ name: string }> } };

    expect(response.status).toBe(200);
    expect(payload.result?.tools).toEqual([expect.objectContaining({ name: 'nova_status' })]);
  });

  it('reauthorizes the exact selected tool scope before executing with server-derived identity', async () => {
    const calls: Parameters<McpAuthorizationPort['authorize']>[0][] = [];
    let seenCaller: McpAuthorizedCaller | null = null;
    const render = tool('nova_render', [MCP_RENDER_SCOPE]);
    const originalRun = render.run;
    render.run = async (currentCaller, input) => {
      seenCaller = currentCaller;
      return originalRun(currentCaller, input);
    };
    const endpoint = createMcpStreamableEndpoint({
      route: 'project',
      registry: registry([tool('nova_status', [MCP_READ_SCOPE]), render]),
      authorization: authorization(async (input) => {
        calls.push(input);
        return { ok: true, caller };
      }),
    });

    const response = await endpoint.handle(
      rpc('tools/call', { name: 'nova_render', arguments: {} }),
    );
    const payload = (await response.json()) as { result?: { content?: Array<{ text: string }> } };

    expect(response.status).toBe(200);
    expect(calls.map((call) => call.scopes)).toEqual([[MCP_READ_SCOPE], [MCP_RENDER_SCOPE]]);
    expect(seenCaller).toEqual(caller);
    expect(JSON.parse(payload.result?.content?.[0]?.text ?? '{}')).toEqual({
      name: 'nova_render',
      input: {},
    });
  });

  it('accepts a case-insensitive bearer scheme with a single credential', async () => {
    const endpoint = createMcpStreamableEndpoint({
      route: 'project',
      registry: registry([tool('nova_status', [MCP_READ_SCOPE])]),
      authorization: authorization(async (input) => {
        expect(input.token).toBe(TOKEN);
        return { ok: true, caller };
      }),
    });

    const response = await endpoint.handle(
      new Request('http://workbench.test/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          [MCP_SESSION_HEADER]: SESSION_ID,
          authorization: `bearer ${TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    );

    expect(response.status).toBe(200);
  });

  it('rejects multiple credential tokens in the authorization header', async () => {
    let authorized = false;
    const endpoint = createMcpStreamableEndpoint({
      route: 'project',
      registry: registry([tool('nova_status', [MCP_READ_SCOPE])]),
      authorization: authorization(async () => {
        authorized = true;
        return { ok: true, caller };
      }),
    });

    const response = await endpoint.handle(
      new Request('http://workbench.test/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          [MCP_SESSION_HEADER]: SESSION_ID,
          authorization: `${MCP_CAPABILITY_SCHEME} ${TOKEN} extra`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: { code: 'SESSION_NOT_FOUND' } });
    expect(authorized).toBe(false);
  });

  it('serves discovery and calls for a render-only grant through finite-scope authorization', async () => {
    const renderGrant = { ...caller, grant: { ...caller.grant, scopes: [MCP_RENDER_SCOPE] } };
    const calls: Parameters<McpAuthorizationPort['authorize']>[0][] = [];
    const endpoint = createMcpStreamableEndpoint({
      route: 'project',
      registry: registry([
        tool('nova_status', [MCP_READ_SCOPE]),
        tool('nova_render', [MCP_RENDER_SCOPE]),
      ]),
      authorization: authorization(async (input) => {
        calls.push(input);
        if (input.scopes.includes(MCP_READ_SCOPE)) {
          return { ok: false, failure: { code: 'SCOPE_MISMATCH', message: 'not granted' } };
        }
        return { ok: true, caller: renderGrant };
      }),
    });

    const listResponse = await endpoint.handle(rpc('tools/list'));
    const listPayload = (await listResponse.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    expect(listResponse.status).toBe(200);
    expect(listPayload.result?.tools).toEqual([expect.objectContaining({ name: 'nova_render' })]);

    const callResponse = await endpoint.handle(
      rpc('tools/call', { name: 'nova_render', arguments: {} }),
    );
    const callPayload = (await callResponse.json()) as {
      result?: { content?: Array<{ text: string }> };
    };
    expect(callResponse.status).toBe(200);
    expect(calls.map((call) => call.scopes)).toEqual([
      [MCP_READ_SCOPE],
      [MCP_RENDER_SCOPE],
      [MCP_READ_SCOPE],
      [MCP_RENDER_SCOPE],
      [MCP_RENDER_SCOPE],
    ]);
    expect(JSON.parse(callPayload.result?.content?.[0]?.text ?? '{}')).toEqual({
      name: 'nova_render',
      input: {},
    });
  });

  it('returns a JSON-RPC TOOL_NOT_FOUND CallToolResult for unknown tool names', async () => {
    const endpoint = createMcpStreamableEndpoint({
      route: 'project',
      registry: registry([tool('nova_status', [MCP_READ_SCOPE])]),
      authorization: authorization(async () => ({ ok: true, caller })),
    });

    const response = await endpoint.handle(
      rpc('tools/call', { name: 'nova_missing', arguments: {} }),
    );
    const payload = (await response.json()) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> };
    };

    expect(response.status).toBe(200);
    expect(payload.result?.isError).toBe(true);
    expect(JSON.parse(payload.result?.content?.[0]?.text ?? '{}')).toEqual({
      code: 'TOOL_NOT_FOUND',
      message: 'Unknown tool: nova_missing',
    });
  });

  it('mounts through the Host guarded MCP route rather than direct Hono access', async () => {
    const endpoint = createMcpStreamableEndpoint({
      route: 'project',
      registry: registry([tool('nova_status', [MCP_READ_SCOPE])]),
      authorization: authorization(async () => ({ ok: true, caller })),
    });
    const host = createHostServer({ mutation: { allowedHosts: ['localhost'] } });
    mountMcpStreamableEndpoint(host, endpoint);
    const request = {
      method: 'POST',
      headers: {
        host: 'localhost:8787',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        [MCP_SESSION_HEADER]: SESSION_ID,
        authorization: `${MCP_CAPABILITY_SCHEME} ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    };

    expect((await host.app.request('/mcp', request)).status).toBe(200);
    expect(
      (
        await host.app.request('/mcp', {
          ...request,
          headers: { ...request.headers, host: 'evil.example' },
        })
      ).status,
    ).toBe(403);
  });

  it('serves discovery and calls for an owner-paired device credential without a session header', async () => {
    const deviceCaller: McpAuthorizedCaller = {
      ...caller,
      sessionId: null,
      grant: { ...caller.grant, scopes: [MCP_READ_SCOPE] },
      device: { deviceId: 'device-1', clientLabel: 'editor-laptop' },
    };
    const seen: Parameters<McpAuthorizationPort['authorize']>[0][] = [];
    const endpoint = createMcpStreamableEndpoint({
      route: 'project',
      registry: registry([tool('nova_status', [MCP_READ_SCOPE])]),
      authorization: authorization(async (input) => {
        seen.push(input);
        expect(input.sessionId).toBeNull();
        expect(input.token).toBe('wbd_device-credential');
        return { ok: true, caller: deviceCaller };
      }),
    });

    const request = new Request('http://workbench.test/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `${MCP_CAPABILITY_SCHEME} wbd_device-credential`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'nova_status', arguments: {} },
      }),
    });
    const response = await endpoint.handle(request);
    const payload = (await response.json()) as {
      result?: { content?: Array<{ text: string }> };
    };

    expect(response.status).toBe(200);
    expect(seen.map((call) => call.scopes)).toEqual([[MCP_READ_SCOPE], [MCP_READ_SCOPE]]);
    expect(JSON.parse(payload.result?.content?.[0]?.text ?? '{}')).toEqual({
      name: 'nova_status',
      input: {},
    });
  });

  it('discovers author-scoped tools for a device whose grant covers only mcp:author', async () => {
    const authorGrant = {
      ...caller,
      sessionId: null as string | null,
      grant: { ...caller.grant, scopes: ['mcp:author'] as string[] },
    };
    const calls: Parameters<McpAuthorizationPort['authorize']>[0][] = [];
    const endpoint = createMcpStreamableEndpoint({
      route: 'project',
      registry: registry([
        tool('nova_status', [MCP_READ_SCOPE]),
        tool('nova_render', [MCP_RENDER_SCOPE]),
        tool('nova_authoring_status', ['mcp:author']),
      ]),
      authorization: authorization(async (input) => {
        calls.push(input);
        if (!input.scopes.includes('mcp:author')) {
          return { ok: false, failure: { code: 'SCOPE_MISMATCH', message: 'not granted' } };
        }
        return { ok: true, caller: authorGrant };
      }),
    });

    const response = await endpoint.handle(
      new Request('http://workbench.test/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `${MCP_CAPABILITY_SCHEME} wbd_author-device`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    );
    const payload = (await response.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };

    expect(response.status).toBe(200);
    expect(payload.result?.tools).toEqual([
      expect.objectContaining({ name: 'nova_authoring_status' }),
    ]);
    // Discovery walked the finite scope union: read/render first, author last.
    expect(calls.map((call) => call.scopes)).toEqual([['mcp:read'], ['mcp:render'], ['mcp:author']]);
  });
});

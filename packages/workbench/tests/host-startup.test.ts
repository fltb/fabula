import { afterEach, describe, expect, it } from 'vitest';
import type { HostStartHandle } from '../src/host/main.js';
import { startHostServer } from '../src/host/main.js';
import type { McpAuthorizedCaller } from '../src/host/mcp/auth.js';
import {
  MCP_READ_SCOPE,
  type McpJsonInputSchema,
  type McpToolDefinition,
  type McpToolRegistry,
} from '../src/host/mcp/registry.js';
import {
  createMcpStreamableEndpoint,
  MCP_CAPABILITY_SCHEME,
  MCP_SESSION_HEADER,
  type McpStreamableEndpoint,
} from '../src/host/mcp/transport.js';

const open: HostStartHandle[] = [];

const track = (host: HostStartHandle): HostStartHandle => {
  open.push(host);
  return host;
};

const MCP_PROJECT_ID = 'startup-project';
const MCP_SESSION_ID = 'startup-session';
const MCP_TOKEN = 'startup-token';

const mcpCaller: McpAuthorizedCaller = {
  sessionId: MCP_SESSION_ID,
  userId: 'user-a',
  grant: {
    capabilityId: 'capability-a',
    userId: 'user-a',
    projectId: MCP_PROJECT_ID,
    scopes: [MCP_READ_SCOPE],
    version: 1,
    expiresAt: '2099-01-01T00:00:00.000Z',
  },
};

const mcpInputSchema: McpJsonInputSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const novaStatus: McpToolDefinition = {
  name: 'nova_status',
  description: 'nova_status tool',
  requiredScopes: [MCP_READ_SCOPE],
  inputSchema: mcpInputSchema,
  run: async (_caller, input) => ({ ok: true, data: { name: 'nova_status', input } }),
};

const mcpRegistry: McpToolRegistry = {
  projectId: MCP_PROJECT_ID,
  session: {} as McpToolRegistry['session'],
  list: (scopes) => (scopes.includes(MCP_READ_SCOPE) ? [novaStatus] : []),
  get: (name) => (name === novaStatus.name ? novaStatus : null),
  run: async (name, currentCaller, input) =>
    name === novaStatus.name
      ? novaStatus.run(currentCaller, input)
      : { ok: false, error: { code: 'TOOL_NOT_FOUND', message: `Unknown tool: ${name}` } },
};

function authenticatedMcpEndpoint(): McpStreamableEndpoint {
  return createMcpStreamableEndpoint({
    registry: mcpRegistry,
    authorization: { authorize: async () => ({ ok: true, caller: mcpCaller }) },
  });
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((host) => host.close()));
});

describe('Host process startup', () => {
  it('starts the default loopback listener on an ephemeral port and serves health', async () => {
    const host = track(await startHostServer({ port: 0 }));

    expect(host.handle.mode).toBe('loopback');
    expect(host.handle.host).toBe('127.0.0.1');
    expect(host.handle.port).toBeGreaterThan(0);
    expect(host.healthPath).toBe('/health');
    expect(host.endpoint).toBe(`http://127.0.0.1:${host.handle.port}`);
    // Fail closed: no MCP options were supplied, so no MCP route exists.
    expect(host.server.endpoints().mcp).toEqual([]);

    expect(host.server.status()).toMatchObject({
      running: true,
      mode: 'loopback',
      host: '127.0.0.1',
      lan: false,
      tls: false,
      trustForwardedHeaders: false,
    });

    const res = await host.server.app.request(host.healthPath);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'ok',
      listener: { running: true, mode: 'loopback' },
      protocol: { protocol: 'http', source: 'socket', trustForwardedHeaders: false },
    });
  });

  it('serves an injected authenticated MCP endpoint on /mcp, guarded, after start', async () => {
    const host = track(
      await startHostServer({
        port: 0,
        mutation: { allowedHosts: ['127.0.0.1'] },
        mcp: { endpoint: authenticatedMcpEndpoint() },
      }),
    );

    // Present: registered through the guarded MCP route during construction,
    // so the projection already lists GET/POST/DELETE at the default path.
    expect(host.server.endpoints().mcp).toEqual([
      { method: 'GET', path: '/mcp', kind: 'mcp', guarded: true },
      { method: 'POST', path: '/mcp', kind: 'mcp', guarded: true },
      { method: 'DELETE', path: '/mcp', kind: 'mcp', guarded: true },
    ]);

    // Callable after start: an authorized JSON-RPC round trip through the
    // running listener returns the discovery result.
    const response = await fetch(`${host.endpoint}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        [MCP_SESSION_HEADER]: MCP_SESSION_ID,
        authorization: `${MCP_CAPABILITY_SCHEME} ${MCP_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { result?: { tools?: Array<{ name: string }> } };
    expect(payload.result?.tools).toEqual([expect.objectContaining({ name: 'nova_status' })]);

    // Guarded: a host outside the allowlist is rejected before the endpoint runs.
    const denied = await host.server.app.request('/mcp', {
      method: 'POST',
      headers: {
        host: 'evil.example',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        [MCP_SESSION_HEADER]: MCP_SESSION_ID,
        authorization: `${MCP_CAPABILITY_SCHEME} ${MCP_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(denied.status).toBe(403);
  });

  it('closes cleanly and idempotently', async () => {
    const host = track(await startHostServer({ port: 0 }));
    await host.close();
    expect(host.server.status().running).toBe(false);
    await expect(host.close()).resolves.toBeUndefined();
  });
});

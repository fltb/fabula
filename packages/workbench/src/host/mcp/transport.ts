import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { HostServer } from '../server.js';
import {
  type McpAuthorizationPort,
  type McpAuthorizationResult,
  type McpRouteKind,
  mcpAuthFailureStatus,
} from './auth.js';
import {
  MCP_ADMIN_SCOPE,
  MCP_READ_SCOPE,
  MCP_RENDER_SCOPE,
  type McpToolDefinition,
  type McpToolRegistry,
  type McpToolResult,
} from './registry.js';

/** Required request header carrying the server-issued browser/session identity. */
export const MCP_SESSION_HEADER = 'x-fabula-session';
/** HTTP authorization scheme carrying an opaque AgentCapabilityService token. */
export const MCP_CAPABILITY_SCHEME = 'Bearer';

export interface McpStreamableEndpoint {
  /** Fetch-native handler, mounted by Hono as `endpoint.handle(c.req.raw)`. */
  handle(request: Request): Promise<Response>;
}
export interface CreateMcpStreamableEndpointOptions {
  /** Static registry for a fixed endpoint; omitted when resolving per request. */
  readonly registry?: McpToolRegistry;
  readonly authorization: McpAuthorizationPort;
  /** Resolve a project/admin registry only after route authorization succeeds. */
  readonly resolveRegistry?: (
    request: Request,
    projectId: string,
    route: McpRouteKind,
  ) => Promise<McpToolRegistry | null>;
  /** Fixed route identity supplied by the server mount. */
  readonly route: McpRouteKind;
  /** Server-derived project identity for fixed endpoints. */
  readonly projectId?: string;
  /** Server-derived project identity for dynamic project endpoints. */
  readonly projectIdResolver?: (request: Request) => string | null;
  /** Finite scopes used for the pre-registry authorization gate. */
  readonly availableScopes?: readonly string[];
  readonly serverInfo?: { readonly name: string; readonly version: string };
}

interface PresentedCredentials {
  readonly sessionId: string | null;
  readonly token: string;
}

function responseJson(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
function extractCredentials(request: Request): PresentedCredentials | null {
  const sessionId = request.headers.get(MCP_SESSION_HEADER);
  const authorization = request.headers.get('authorization');
  if (sessionId === '' || authorization === null) return null;
  const prefix = `${MCP_CAPABILITY_SCHEME} `;
  // The scheme is case-insensitive per RFC 9110, but the credential must be
  // exactly one non-empty token: extra tokens or other material are rejected.
  if (!authorization.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const token = authorization.slice(prefix.length);
  if (token.length === 0 || /\s/.test(token)) return null;
  return { sessionId, token };
}

function toolResult(result: McpToolResult): {
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }];
  readonly isError?: boolean;
} {
  return result.ok
    ? { content: [{ type: 'text', text: JSON.stringify(result.data) }] }
    : {
        content: [{ type: 'text', text: JSON.stringify(result.error) }],
        isError: true,
      };
}

function mcpTool(definition: McpToolDefinition): {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: McpToolDefinition['inputSchema'];
} {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
  };
}

/**
 * Authenticate discovery traffic (tools/list, batches, malformed bodies,
 * unknown tool names) against the finite MCP tool scopes, accepting the first
 * success. Never sends an empty scope set.
 */
async function authorizeDiscovery(
  authorization: McpAuthorizationPort,
  credentials: PresentedCredentials,
  projectId: string,
  route: McpRouteKind,
  scopes: readonly string[],
): Promise<McpAuthorizationResult> {
  let last: McpAuthorizationResult | null = null;
  for (const scope of scopes) {
    const result = await authorization.authorize({
      sessionId: credentials.sessionId,
      token: credentials.token,
      projectId,
      route,
      scopes: [scope],
    });
    if (result.ok || result.failure.code !== 'SCOPE_MISMATCH') return result;
    last = result;
  }
  return (
    last ?? {
      ok: false,
      failure: {
        code: 'SCOPE_MISMATCH',
        message: 'The presented credential does not cover any discoverable MCP scope.',
      },
    }
  );
}

function authorizationFailure(status: 401 | 403, code: string): Response {
  const response = responseJson(status, { error: { code } });
  if (status === 401) response.headers.set('www-authenticate', MCP_CAPABILITY_SCHEME);
  return response;
}

/**
 * Fetch-native, stateless Streamable HTTP MCP endpoint. A fresh Server and
 * transport per request avoids a second mutable runtime and forces session +
 * opaque capability validation for every call. JSON responses are deliberate:
 * Workbench operation/SSE is the long-running progress channel.
 */
export function createMcpStreamableEndpoint(
  options: CreateMcpStreamableEndpointOptions,
): McpStreamableEndpoint {
  const { registry, authorization, resolveRegistry, route } = options;
  if (registry === undefined && resolveRegistry === undefined) {
    throw new TypeError('MCP endpoint requires a registry or registry resolver');
  }
  const serverInfo = options.serverInfo ?? { name: 'fabula-workbench', version: '0.1.0' };

  return {
    async handle(request: Request): Promise<Response> {
      const projectId =
        options.projectIdResolver?.(request) ?? options.projectId ?? registry?.projectId ?? null;
      if (projectId === null || projectId.length === 0) {
        return responseJson(404, { error: { code: 'PROJECT_NOT_FOUND' } });
      }
      const credentials = extractCredentials(request);
      if (credentials === null) return authorizationFailure(401, 'SESSION_NOT_FOUND');

      // This is intentionally a finite, registry-independent gate. It
      // authenticates the route/project ACL before resolving a project session
      // or constructing its registry, preventing unknown and closed projects
      // from triggering any registry lookup.
      const discovery = await authorizeDiscovery(
        authorization,
        credentials,
        projectId,
        route,
        options.availableScopes ??
          registry?.availableScopes ??
          (route === 'admin' ? [MCP_ADMIN_SCOPE] : [MCP_READ_SCOPE, MCP_RENDER_SCOPE]),
      );
      if (!discovery.ok) {
        return authorizationFailure(
          mcpAuthFailureStatus(discovery.failure.code),
          discovery.failure.code,
        );
      }

      const resolved = resolveRegistry
        ? await resolveRegistry(request, projectId, route)
        : (registry ?? null);
      if (resolved === null) {
        return responseJson(404, { error: { code: 'PROJECT_NOT_FOUND' } });
      }

      const server = new Server(serverInfo, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: resolved.list(discovery.caller.grant.scopes).map(mcpTool),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (message) => {
        const definition = resolved.get(message.params.name);
        if (definition === null) {
          return toolResult({
            ok: false,
            error: { code: 'TOOL_NOT_FOUND', message: `Unknown tool: ${message.params.name}` },
          });
        }
        const reauthorized = await authorization.authorize({
          sessionId: credentials.sessionId,
          token: credentials.token,
          projectId,
          route,
          scopes: definition.requiredScopes,
        });
        if (!reauthorized.ok) {
          return toolResult({
            ok: false,
            error: {
              code: reauthorized.failure.code,
              message: reauthorized.failure.message,
            },
          });
        }
        return toolResult(
          await resolved.run(
            message.params.name,
            reauthorized.caller,
            message.params.arguments ?? {},
          ),
        );
      });

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      return transport.handleRequest(request);
    },
  };
}

/** Default authenticated Streamable HTTP endpoint on the shared Host. */
export const DEFAULT_MCP_STREAMABLE_PATH = '/mcp';

/**
 * Mount one Fetch-native MCP endpoint through the Host's guarded route
 * registration. The Host owns lifecycle and allowlist enforcement; this
 * function never mutates the Hono app directly.
 */
export function mountMcpStreamableEndpoint(
  host: Pick<HostServer, 'registerMcpRoute'>,
  endpoint: McpStreamableEndpoint,
  path = DEFAULT_MCP_STREAMABLE_PATH,
): void {
  host.registerMcpRoute(path, (context) => endpoint.handle(context.req.raw));
}

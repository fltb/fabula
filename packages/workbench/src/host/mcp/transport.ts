import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { HostServer } from '../server.js';
import {
  type McpAuthorizationPort,
  type McpAuthorizationResult,
  mcpAuthFailureStatus,
} from './auth.js';
import {
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
  readonly registry: McpToolRegistry;
  readonly authorization: McpAuthorizationPort;
  readonly serverInfo?: { readonly name: string; readonly version: string };
}

interface PresentedCredentials {
  readonly sessionId: string;
  readonly token: string;
}

interface ToolCallEnvelope {
  readonly method?: unknown;
  readonly params?: { readonly name?: unknown };
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
  if (sessionId === null || sessionId.length === 0 || authorization === null) return null;
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

async function requestedToolName(request: Request): Promise<string | null> {
  if (request.method !== 'POST') return null;
  try {
    const envelope = (await request.clone().json()) as ToolCallEnvelope;
    return envelope.method === 'tools/call' && typeof envelope.params?.name === 'string'
      ? envelope.params.name
      : null;
  } catch {
    // The SDK owns JSON-RPC syntax errors. This preflight only extracts a
    // well-formed tool name in order to choose the exact authorization scope.
    return null;
  }
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
): Promise<McpAuthorizationResult> {
  const read = await authorization.authorize({
    sessionId: credentials.sessionId,
    token: credentials.token,
    projectId,
    scopes: [MCP_READ_SCOPE],
  });
  if (read.ok || read.failure.code !== 'SCOPE_MISMATCH') return read;
  return authorization.authorize({
    sessionId: credentials.sessionId,
    token: credentials.token,
    projectId,
    scopes: [MCP_RENDER_SCOPE],
  });
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
  const { registry, authorization } = options;
  const serverInfo = options.serverInfo ?? { name: 'fabula-workbench', version: '0.1.0' };

  return {
    async handle(request: Request): Promise<Response> {
      const credentials = extractCredentials(request);
      if (credentials === null) return authorizationFailure(401, 'SESSION_NOT_FOUND');

      // Known tools/call requests preflight with their exact required scopes;
      // everything else (list, batch, malformed bodies, unknown tool names)
      // authenticates against the finite MCP tool scopes and accepts the first
      // success, so a render-only grant still reaches discovery. Unknown tool
      // names fall through to the SDK, which answers with a JSON-RPC
      // TOOL_NOT_FOUND CallToolResult instead of an HTTP 404. The handler
      // rechecks the exact scopes at the effect boundary to close revocation
      // races.
      const selectedName = await requestedToolName(request);
      const selected = selectedName === null ? null : registry.get(selectedName);
      const discovery =
        selected !== null && selected.requiredScopes.length > 0
          ? await authorization.authorize({
              sessionId: credentials.sessionId,
              token: credentials.token,
              projectId: registry.projectId,
              scopes: selected.requiredScopes,
            })
          : await authorizeDiscovery(authorization, credentials, registry.projectId);
      if (!discovery.ok) {
        return authorizationFailure(
          mcpAuthFailureStatus(discovery.failure.code),
          discovery.failure.code,
        );
      }

      const server = new Server(serverInfo, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: registry.list(discovery.caller.grant.scopes).map(mcpTool),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (message) => {
        const definition = registry.get(message.params.name);
        if (definition === null) {
          return toolResult({
            ok: false,
            error: { code: 'TOOL_NOT_FOUND', message: `Unknown tool: ${message.params.name}` },
          });
        }
        const reauthorized = await authorization.authorize({
          sessionId: credentials.sessionId,
          token: credentials.token,
          projectId: registry.projectId,
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
          await registry.run(
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

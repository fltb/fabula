/**
 * Typed MCP Streamable-HTTP test client over the `@modelcontextprotocol/sdk`.
 *
 * The Workbench Host authenticates MCP traffic with the owner-paired device
 * credential (`Authorization: Bearer <credential>`, no session header —
 * "device mode" in `src/host/mcp/auth.ts`). This wrapper builds an SDK
 * `Client` over `StreamableHTTPClientTransport` pointed at the project route
 * (`/mcp/projects/:projectId`) and exposes the two surfaces the E2E specs
 * need: `listTools()` and `call(name, input)`.
 *
 * The endpoint is stateless (the Host constructs a fresh Server + transport
 * per request, `src/host/mcp/transport.ts`), so the client never manages an
 * `mcp-session-id`; every request carries the credential.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** One tool advertised by `tools/list` (subset of the SDK's tool shape). */
export interface McpToolInfo {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

/** Typed result of one `tools/call`; the Host wraps payloads as JSON text. */
export interface McpCallResult {
  readonly ok: boolean;
  /** Parsed tool payload (or parsed error envelope when `ok` is false). */
  readonly data: unknown;
  /** Present on tool errors: the Host's `{ code, message }` error shape. */
  readonly error?: { readonly code: string; readonly message: string };
}

export interface McpTestClientOptions {
  /** Full MCP endpoint URL, e.g. `http://127.0.0.1:PORT/mcp/projects/zhu-fu`. */
  readonly url: string;
  /** Owner-paired device credential; sent as `Authorization: Bearer`. */
  readonly credential: string;
  readonly name?: string;
  readonly version?: string;
}

function parsePayload(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isErrorEnvelope(
  value: unknown,
): value is { readonly error: { readonly code: string; readonly message: string } } {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('error' in value)) {
    return false;
  }
  const error = value.error;
  if (typeof error !== 'object' || error === null || !('code' in error) || !('message' in error)) {
    return false;
  }
  return typeof error.code === 'string' && typeof error.message === 'string';
}

/**
 * Typed Streamable-HTTP MCP client bound to one project route with one device
 * credential. Create through `HostFixture.mcpClient(...)` — specs should not
 * construct this directly.
 */
export class McpTestClient {
  readonly #transport: StreamableHTTPClientTransport;
  readonly #client: Client;
  #closed = false;

  constructor(options: McpTestClientOptions) {
    this.#transport = new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: {
        headers: { authorization: `Bearer ${options.credential}` },
      },
    });
    this.#client = new Client({
      name: options.name ?? 'fabula-workbench-e2e',
      version: options.version ?? '1.0.0',
    });
  }

  /** Connect (MCP `initialize` handshake). Called once; throws on failure. */
  async connect(): Promise<void> {
    await this.#client.connect(this.#transport);
  }

  /** `tools/list` — the exact tool set the credential's scopes unlock. */
  async listTools(): Promise<readonly McpToolInfo[]> {
    const result = await this.#client.listTools();
    return (result.tools ?? []) as readonly McpToolInfo[];
  }

  /**
   * `tools/call` — invoke one tool and unwrap the Host's JSON-text payload.
   * Tool-level errors (e.g. `TOOL_NOT_FOUND`, scope denials) come back as
   * `{ ok: false, error: { code, message } }`, never as thrown exceptions.
   */
  async call(name: string, input?: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.#client.callTool({ name, arguments: input ?? {} });
    const content = result.content as readonly unknown[] | undefined;
    const text = (content ?? [])
      .flatMap((item): string[] => {
        if (typeof item !== 'object' || item === null || !('type' in item) || !('text' in item)) {
          return [];
        }
        if (item.type !== 'text' || typeof item.text !== 'string') return [];
        return [item.text];
      })
      .join('\n');
    const parsed = parsePayload(text);
    if ('isError' in result && result.isError === true) {
      return {
        ok: false,
        data: parsed,
        ...(isErrorEnvelope(parsed)
          ? { error: parsed.error }
          : { error: { code: 'TOOL_ERROR', message: text } }),
      };
    }
    return { ok: true, data: parsed };
  }

  /** Close the SDK client and its transport; safe to call repeatedly. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#client.close();
    } catch {
      // The Host endpoint is stateless; a failed DELETE teardown is harmless.
    }
  }
}

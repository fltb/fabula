import {
  CLI_EXIT_CODES_V1,
  MCP_TOOL_CATALOG_V1,
  WORKBENCH_DEVICE_CREDENTIAL_ENV,
  type McpToolDescriptorV1,
  type NovaViaWorkbenchModeV1,
} from '@novalistically/workbench-protocol';

/** The Host MCP endpoint speaks standard JSON-RPC 2.0 over Streamable HTTP. */
export const WORKBENCH_MCP_JSONRPC_VERSION = '2.0' as const;
export const WORKBENCH_MCP_DEFAULT_HOST = 'http://127.0.0.1:8787' as const;

export type WorkbenchToolName = (typeof MCP_TOOL_CATALOG_V1)[number]['name'];
export type WorkbenchJsonObject = Record<string, unknown>;

export interface WorkbenchMcpCallRequestV1<Name extends string = string> {
  readonly jsonrpc: typeof WORKBENCH_MCP_JSONRPC_VERSION;
  readonly id: number;
  readonly method: 'tools/call';
  readonly params: {
    readonly name: Name;
    readonly arguments: WorkbenchJsonObject;
  };
}

export interface WorkbenchMcpTextContentV1 {
  readonly type: 'text';
  readonly text: string;
}

export interface WorkbenchMcpCallResultV1 {
  readonly content: readonly WorkbenchMcpTextContentV1[];
  readonly isError?: boolean;
}

export interface WorkbenchMcpResponseV1 {
  readonly jsonrpc: typeof WORKBENCH_MCP_JSONRPC_VERSION;
  readonly id: number;
  readonly result?: WorkbenchMcpCallResultV1;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export interface WorkbenchClientOptions {
  /** Base Host URL, for example `http://127.0.0.1:8787`. */
  readonly host?: string;
  readonly projectId: string;
  /** Opaque MCP device credential; it is retained only in the client instance. */
  readonly credential: string;
  /** Optional session identity for a session-backed Host credential. */
  readonly sessionId?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class WorkbenchClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly exitCode: number;
  readonly operationId?: string;

  constructor(input: {
    readonly status: number;
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
    readonly operationId?: string;
  }) {
    super(input.message);
    this.name = 'WorkbenchClientError';
    this.status = input.status;
    this.code = input.code;
    this.retryable = input.retryable ?? (input.status >= 500 || input.status === 408);
    this.exitCode = exitCodeForWorkbenchError(this.status, this.code);
    this.operationId = input.operationId;
  }
}

/** Map typed Host/MCP failures onto the shared CLI exit-code contract. */
export function exitCodeForWorkbenchError(status: number, code: string): number {
  if (status === 401 || status === 403 || /AUTH|TOKEN|SESSION|SCOPE|FORBIDDEN|UNAUTHORIZED/i.test(code)) {
    return CLI_EXIT_CODES_V1.authenticationOrAuthorization;
  }
  if (
    status === 409 ||
    /CONFLICT|STALE|CAS|SOURCE_.*MISMATCH|WORKSPACE_.*STALE|AUTHORITY/i.test(code)
  ) {
    return CLI_EXIT_CODES_V1.authorityCasOrConflict;
  }
  if (status === 404 || status === 502 || status === 503 || status === 504) {
    return CLI_EXIT_CODES_V1.hostUnavailable;
  }
  if (status >= 400 && status < 500) return CLI_EXIT_CODES_V1.usageOrLocalInput;
  return CLI_EXIT_CODES_V1.hostUnavailable;
}

function isObject(value: unknown): value is WorkbenchJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textPayload(value: unknown): unknown {
  if (!isObject(value)) throw new Error('Workbench response is not a JSON object.');
  const content = value.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error('Workbench response has no MCP content.');
  }
  const first = content[0];
  if (!isObject(first) || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('Workbench response contains unsupported MCP content.');
  }
  try {
    return JSON.parse(first.text) as unknown;
  } catch {
    throw new Error('Workbench response content is not JSON.');
  }
}

function hostUrl(host: string): string {
  const normalized = host.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(normalized)) throw new TypeError('Workbench host must be an HTTP(S) URL.');
  return normalized;
}

function descriptor(name: WorkbenchToolName): McpToolDescriptorV1 {
  const found = MCP_TOOL_CATALOG_V1.find((item) => item.name === name);
  if (found === undefined) throw new TypeError(`Unknown Workbench MCP tool: ${name}`);
  return found;
}

function assertObjectInput(name: WorkbenchToolName, input: WorkbenchJsonObject): void {
  const schema = descriptor(name).inputSchema;
  const properties = Object.keys(schema.properties);
  for (const key of Object.keys(input)) {
    if (!properties.includes(key)) throw new TypeError(`Unknown field "${key}" for ${name}.`);
  }
  for (const required of schema.required ?? []) {
    if (!(required in input)) throw new TypeError(`Missing field "${required}" for ${name}.`);
  }
}

/**
 * Typed, Host-bound MCP client used by the CLI's `via-workbench` mode. It
 * contains no filesystem or Core adapters: every operation is sent through
 * the authenticated project MCP route owned by the Host.
 */
export class WorkbenchClient {
  readonly #host: string;
  readonly #projectId: string;
  readonly #credential: string;
  readonly #sessionId?: string;
  readonly #fetch: typeof globalThis.fetch;
  #nextRequestId = 1;

  constructor(options: WorkbenchClientOptions) {
    if (!options || typeof options.projectId !== 'string' || options.projectId.length === 0)
      throw new TypeError('Workbench client requires a projectId.');
    if (typeof options.credential !== 'string' || options.credential.length === 0)
      throw new TypeError('Workbench client requires an opaque device credential.');
    this.#host = hostUrl(options.host ?? WORKBENCH_MCP_DEFAULT_HOST);
    this.#projectId = options.projectId;
    this.#credential = options.credential;
    this.#sessionId = options.sessionId;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get projectId(): string {
    return this.#projectId;
  }

  get endpoint(): string {
    return `${this.#host}/mcp/projects/${encodeURIComponent(this.#projectId)}`;
  }

  /** Invoke one protocol-catalogued Host MCP tool with strict client input. */
  async call<Name extends WorkbenchToolName>(
    name: Name,
    input: WorkbenchJsonObject = {},
  ): Promise<unknown> {
    assertObjectInput(name, input);
    const request: WorkbenchMcpCallRequestV1<Name> = {
      jsonrpc: WORKBENCH_MCP_JSONRPC_VERSION,
      id: this.#nextRequestId++,
      method: 'tools/call',
      params: { name, arguments: { ...input } },
    };
    let response: Response;
    try {
      response = await this.#fetch(this.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          authorization: `Bearer ${this.#credential}`,
          ...(this.#sessionId === undefined ? {} : { 'x-fabula-session': this.#sessionId }),
        },
        body: JSON.stringify(request),
      });
    } catch (error) {
      throw new WorkbenchClientError({
        status: 503,
        code: 'HOST_UNAVAILABLE',
        message: error instanceof Error ? error.message : 'Workbench Host is unavailable.',
      });
    }

    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const envelope = isObject(body) && isObject(body.error) ? body.error : null;
      const code = envelope && typeof envelope.code === 'string' ? envelope.code : `HTTP_${response.status}`;
      const message = envelope && typeof envelope.message === 'string'
        ? envelope.message
        : `Workbench Host returned HTTP ${response.status}.`;
      throw new WorkbenchClientError({ status: response.status, code, message });
    }
    if (!isObject(body) || body.jsonrpc !== WORKBENCH_MCP_JSONRPC_VERSION) {
      throw new WorkbenchClientError({ status: 502, code: 'INVALID_HOST_RESPONSE', message: 'Workbench Host returned an invalid JSON-RPC response.' });
    }
    const envelope = body as unknown as WorkbenchMcpResponseV1;
    if (envelope.error !== undefined) {
      throw new WorkbenchClientError({
        status: 502,
        code: `MCP_${envelope.error.code}`,
        message: envelope.error.message,
      });
    }
    if (envelope.result === undefined) {
      throw new WorkbenchClientError({ status: 502, code: 'INVALID_HOST_RESPONSE', message: 'Workbench Host returned no MCP result.' });
    }
    const payload = textPayload(envelope.result);
    if (envelope.result.isError) {
      const failure = isObject(payload) ? payload : {};
      const code = typeof failure.code === 'string' ? failure.code : 'HOST_OPERATION_FAILED';
      const message =
        typeof failure.message === 'string' ? failure.message : 'Workbench operation failed.';
      const operationId = typeof failure.operationId === 'string' ? failure.operationId : undefined;
      const status =
        /INVALID|NOT_FOUND|NO_ACCEPTED_SOURCE/.test(code)
          ? 400
          : /CONFLICT|STALE|CAS|MISMATCH/.test(code)
            ? 409
            : 500;
      throw new WorkbenchClientError({ status, code, message, operationId });
    }
    return payload;
  }
  status(): Promise<unknown> {
    return this.call('nova_status');
  }
  validate(): Promise<unknown> {
    return this.call('nova_validate');
  }
  sourceList(): Promise<unknown> {
    return this.call('nova_source_list');
  }
  sourceGet(input: WorkbenchSourceGetInputV1): Promise<unknown> {
    return this.call('nova_source_get', input);
  }
  sourcePreview(input: WorkbenchSourcePreviewInputV1): Promise<unknown> {
    return this.call('nova_source_preview', input);
  }
  entityList(input: WorkbenchEntityListInputV1 = {}): Promise<unknown> {
    return this.call('nova_entity_list', input);
  }
  entityGet(input: WorkbenchEntityGetInputV1): Promise<unknown> {
    return this.call('nova_entity_get', input);
  }
  graph(): Promise<unknown> {
    return this.call('nova_graph');
  }
  render(input: WorkbenchRenderInputV1): Promise<unknown> {
    return this.call('nova_render', input);
  }
  revise(input: WorkbenchRenderInputV1): Promise<unknown> {
    return this.call('nova_revise', input);
  }
  renderTree(input: WorkbenchRenderInputV1): Promise<unknown> {
    return this.call('nova_render_tree', input);
  }
  authoringDocumentList(): Promise<unknown> {
    return this.call('nova_authoring_document_list', { version: 2 });
  }
  authoringDocumentRead(input: WorkbenchAuthoringDocumentReadInputV1): Promise<unknown> {
    return this.call('nova_authoring_document_read', input);
  }
  authoringStatus(): Promise<unknown> {
    return this.call('nova_authoring_status', { version: 2 });
  }
  authoringDocumentEdit(input: WorkbenchAuthoringDocumentEditInputV1): Promise<unknown> {
    return this.call('nova_authoring_document_edit', input);
  }
}

export interface WorkbenchSourceGetInputV1 extends WorkbenchJsonObject {
  readonly logicalPath: string;
  readonly offset?: number;
  readonly limit?: number;
}
export interface WorkbenchSourcePreviewInputV1 extends WorkbenchJsonObject {
  readonly changes: readonly WorkbenchJsonObject[];
}
export interface WorkbenchEntityListInputV1 extends WorkbenchJsonObject {
  readonly kind?: string;
}
export interface WorkbenchEntityGetInputV1 extends WorkbenchJsonObject {
  readonly entityId: string;
}
export interface WorkbenchRenderInputV1 extends WorkbenchJsonObject {
  readonly sceneSelector: {
    readonly type: 'all' | 'chapter' | 'events';
    readonly chapter?: number;
    readonly eventIds?: readonly string[];
  };
  readonly model?: string;
}
export interface WorkbenchAuthoringDocumentListInputV1 extends WorkbenchJsonObject {
  readonly version: 2;
}
export interface WorkbenchAuthoringDocumentReadInputV1 extends WorkbenchJsonObject {
  readonly version: 2;
  readonly documentId: string;
  readonly offset?: number;
  readonly limit?: number;
}
export interface WorkbenchAuthoringDocumentEditInputV1 extends WorkbenchJsonObject {
  readonly version: 2;
  readonly documentId: string;
  readonly expectedWorkspaceDigest: string;
  readonly expectedAcceptedSourceHash: string | null;
  readonly expectedStateVectorHash: string;
  readonly replacementText?: string;
  readonly edits?: readonly {
    readonly start: number;
    readonly end: number;
    readonly replacementText: string;
  }[];
}

/** Resolve the explicit CLI mode without putting credentials into the mode DTO. */
export function resolveWorkbenchMode(options: {
  readonly mode?: string;
  readonly projectId?: string;
  readonly host?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): NovaViaWorkbenchModeV1 | { readonly mode: 'standalone' } {
  const env = options.env ?? process.env;
  const mode = options.mode ?? env.NOVALISTICALLY_MODE ?? 'standalone';
  if (mode === 'standalone') return { mode: 'standalone' };
  if (mode !== 'via-workbench') throw new TypeError(`Unsupported execution mode: ${mode}`);
  const projectId = options.projectId ?? env.NOVALISTICALLY_WORKBENCH_PROJECT;
  if (projectId === undefined || projectId.length === 0)
    throw new TypeError('via-workbench mode requires --project <projectId>.');
  return {
    mode,
    projectId,
    ...(options.host === undefined ? {} : { host: options.host }),
  };
}

export function workbenchCredential(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const credential = env[WORKBENCH_DEVICE_CREDENTIAL_ENV];
  if (credential === undefined || credential.length === 0)
    throw new TypeError(`via-workbench mode requires ${WORKBENCH_DEVICE_CREDENTIAL_ENV}.`);
  return credential;
}

export function createWorkbenchClient(
  mode: NovaViaWorkbenchModeV1,
  options: { readonly credential?: string; readonly sessionId?: string; readonly fetch?: typeof globalThis.fetch; readonly env?: Readonly<Record<string, string | undefined>> } = {},
): WorkbenchClient {
  return new WorkbenchClient({
    host: mode.host,
    projectId: mode.projectId,
    credential: options.credential ?? workbenchCredential(options.env),
    sessionId: options.sessionId,
    fetch: options.fetch,
  });
}

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Handler } from 'hono';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import type { WorkingDocumentState } from '../contracts/persistence.js';
import type { BrowserReadApi, BrowserReadApiOptions } from './browser-read-api.js';
import { createBrowserReadApi } from './browser-read-api.js';
import type {
  HostEndpointProjection,
  HostListener,
  HostListenerApp,
  HostListenerConfig,
  HostListenerEnv,
  HostListenerHandle,
  HostListenerStatus,
  HostUpgradeListener,
  MutationHttpMethod,
  SetupHttpMethod,
} from './listener.js';
import { createHostListener, HostListenerStateError } from './listener.js';
import { DEFAULT_MCP_STREAMABLE_PATH, type McpStreamableEndpoint } from './mcp/index.js';
import type { ProjectSessionRegistry } from './project-session.js';
import {
  createYjsGateway,
  type YjsApplyResult,
  type YjsAuthPort,
  type YjsConnectionRequest,
  type YjsConnectionScope,
  type YjsDenialReason,
  type YjsGateway,
  type YjsGatewayConnection,
  type YjsPersistencePort,
  type YjsWorkingDocumentCore,
} from './yjs/index.js';

export type { Handler, MiddlewareHandler } from 'hono';
export type {
  EffectiveProtocol,
  HostEndpointProjection,
  HostHealthPayload,
  HostHttpMethod,
  HostListener,
  HostListenerApp,
  HostListenerConfig,
  HostListenerEnv,
  HostListenerHandle,
  HostListenerMode,
  HostListenerStatus,
  HostStatusPayload,
  HostUpgradeListener,
  MutationAllowlist,
  MutationHttpMethod,
  RequestProtocol,
  SetupHttpMethod,
} from './listener.js';
export type {
  SessionAuthPortOptions,
  YjsApplyFailureReason,
  YjsApplyResult,
  YjsAuthPort,
  YjsConnectFailureReason,
  YjsConnectionRequest,
  YjsConnectionScope,
  YjsDenialReason,
  YjsGateway,
  YjsGatewayConnection,
  YjsGatewayConnectResult,
  YjsGatewayOptions,
  YjsPersistencePort,
  YjsScopeResolution,
  YjsServiceFailureReason,
} from './yjs/index.js';
export {
  createSessionAuthPort,
  createYjsGateway,
  createYjsPersistencePort,
} from './yjs/index.js';

/**
 * Optional authenticated Yjs gateway wiring. Absent = no Yjs surface at all:
 * the Host fails closed and no unauthenticated document access is possible.
 */
export interface HostYjsOptions {
  /** Typed Yjs persistence port over the persistence worker. */
  readonly persistence: YjsPersistencePort;
  /** Open project sessions; working/presence join and leave land here. */
  readonly sessions: ProjectSessionRegistry;
  /** Injected session authentication resolving user/project/document scope. */
  readonly auth: YjsAuthPort;
  /** Timestamp source for presence updates; defaults to the host clock. */
  /** Host-wide shared core also injected into coordinator document stores. */
  readonly core?: YjsWorkingDocumentCore;
  readonly now?: () => string;
}

/**
 * Optional prebuilt authenticated MCP endpoint wiring. Absent = no MCP
 * surface at all: the Host fails closed and no route is exposed.
 */
export interface HostServerMcpOptions {
  /** Prebuilt authenticated Streamable HTTP MCP endpoint to mount. */
  readonly endpoint: McpStreamableEndpoint;
  /** Exact guarded route path; defaults to the MCP module's `/mcp`. */
  readonly path?: string;
  /** Additional exact guarded MCP mounts, such as the separate admin route. */
  readonly routes?: readonly {
    readonly path: string;
    readonly endpoint: McpStreamableEndpoint;
  }[];
}

export interface HostServerOptions extends HostListenerConfig {
  /** Mount an authenticated Yjs gateway on this Host; defaults to none (fail closed). */
  readonly yjs?: HostYjsOptions;
  /** Mount a prebuilt authenticated MCP endpoint on this Host; defaults to none (fail closed). */
  readonly mcp?: HostServerMcpOptions;
  /**
   * Mount the injected browser read surface on this Host; defaults to none
   * (fail closed — an unconfigured Host exposes no browser API at all).
   */
  readonly browser?: BrowserReadApiOptions;
}

export interface HostServer {
  /** The underlying listener; future Host surfaces mount on `listener.app`. */
  readonly listener: HostListener;
  readonly app: HostListenerApp;
  /**
   * Authenticated Yjs working-layer gateway mounted on this Host, or null
   * when no `yjs` options were provided. When present, the listener's
   * upgrade seam accepts the fixed Yjs path, authenticates and scopes the
   * connection, then binds sockets through `yjs.connect(...)`; no separate
   * y-websocket server is ever started.
   */
  readonly yjs: YjsGateway | null;
  /**
   * The mounted browser read surface (the five fixed authenticated GET
   * routes), or null when no `browser` options were provided. Absent =
   * no browser API is exposed at all (fail closed).
   */
  readonly browser: BrowserReadApi | null;
  start(): Promise<HostListenerHandle>;
  close(): Promise<void>;
  status(): HostListenerStatus;
  endpoints(): HostEndpointProjection;
  registerMutationRoute(
    method: MutationHttpMethod,
    path: string,
    handler: Handler<HostListenerEnv>,
  ): void;
  /**
   * Register an MCP transport route on the listener: GET/POST/DELETE at one
   * exact path, each behind the same Host/Origin allowlist guard.
   */
  registerMcpRoute(path: string, handler: Handler<HostListenerEnv>): void;
  registerReadRoute(path: string, handler: Handler<HostListenerEnv>): void;
  /** Register one unguarded static GET/HEAD route before start. */
  registerPublicStaticRoute(path: string, handler: Handler<HostListenerEnv>): void;
  /** Register one explicit unauthenticated auth POST before start. */
  registerPublicAuthPostRoute(path: string, handler: Handler<HostListenerEnv>): void;
  /** Register one pre-start-only setup wizard route under `/api/v1/setup/*`. */
  registerSetupRoute(
    method: SetupHttpMethod,
    path: string,
    handler: Handler<HostListenerEnv>,
  ): void;
  isMutationAllowed(host: string | undefined, origin: string | undefined): boolean;
}

// ─── Authenticated Yjs WebSocket transport ────────────────────────────────────

/** Fixed upgrade path carrying the authenticated Yjs working layer. */
export const HOST_YJS_UPGRADE_PATH = '/yjs';

/** Query parameters carrying the server-derived connection scope. */
const YJS_QUERY_TICKET = 'ticket';
const YJS_QUERY_PROJECT = 'project';
const YJS_QUERY_DOCUMENT = 'document';

/**
 * y-websocket wire protocol (y-protocols compatible): every message starts
 * with a varuint message type; sync messages continue with a varuint sync
 * step and a varuint-prefixed byte payload. Sync step 2 and the standard
 * `messageYjsUpdate` (subtype 2) both carry a client update and are accepted
 * through the same canonical apply/persist/broadcast path. The remaining
 * message types (awareness/auth) are owned by the gateway's presence layer
 * and are deliberately never exchanged on this transport.
 */
const MESSAGE_SYNC = 0;
const SYNC_STEP_1 = 0;
const SYNC_STEP_2 = 1;
const SYNC_UPDATE = 2;

/** Append one unsigned LEB128 varuint (lib0 `writeVarUint` compatible). */
function writeVarUint(target: number[], value: number): void {
  let num = value >>> 0;
  while (num > 0x7f) {
    target.push((num & 0x7f) | 0x80);
    num >>>= 7;
  }
  target.push(num);
}

/** Read one unsigned LEB128 varuint; throws on truncated or oversized input. */
function readVarUint(bytes: Uint8Array, cursor: { offset: number }): number {
  let num = 0;
  let shift = 0;
  for (;;) {
    if (cursor.offset >= bytes.length) throw new Error('yjs message truncated');
    const byte = bytes[cursor.offset];
    cursor.offset += 1;
    num |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return num >>> 0;
    shift += 7;
    if (shift > 28) throw new Error('yjs varuint overflow');
  }
}

/** Read one varuint-prefixed byte payload; throws when it exceeds the frame. */
function readVarUint8Array(bytes: Uint8Array, cursor: { offset: number }): Uint8Array {
  const length = readVarUint(bytes, cursor);
  if (length > bytes.length - cursor.offset) throw new Error('yjs payload truncated');
  const payload = bytes.subarray(cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return payload;
}

function encodeSyncFrame(syncType: number, payload: Uint8Array): Uint8Array {
  const header: number[] = [];
  writeVarUint(header, MESSAGE_SYNC);
  writeVarUint(header, syncType);
  writeVarUint(header, payload.byteLength);
  const frame = new Uint8Array(header.length + payload.byteLength);
  frame.set(header, 0);
  frame.set(payload, header.length);
  return frame;
}

/** Encode a y-protocols sync step 1 message (client state-vector request). */
export function encodeYjsSyncStep1(stateVector: Uint8Array): Uint8Array {
  return encodeSyncFrame(SYNC_STEP_1, stateVector);
}

/** Encode a y-protocols sync step 2 message carrying one Yjs update. */
export function encodeYjsSyncStep2(update: Uint8Array): Uint8Array {
  return encodeSyncFrame(SYNC_STEP_2, update);
}

/** Encode a y-protocols `messageYjsUpdate` frame (sync subtype 2) carrying one Yjs update. */
export function encodeYjsMessageUpdate(update: Uint8Array): Uint8Array {
  return encodeSyncFrame(SYNC_UPDATE, update);
}

/** One parsed y-protocols sync message from the wire. */
export interface YjsSyncFrame {
  readonly syncType: number;
  readonly payload: Uint8Array;
}

/**
 * Parse one y-protocols message. Non-sync frames (awareness/auth, owned by
 * the gateway presence layer) yield null; malformed frames throw.
 */
export function parseYjsSyncFrame(bytes: Uint8Array): YjsSyncFrame | null {
  const cursor = { offset: 0 };
  const messageType = readVarUint(bytes, cursor);
  if (messageType !== MESSAGE_SYNC) return null;
  const syncType = readVarUint(bytes, cursor);
  const payload = readVarUint8Array(bytes, cursor);
  return { syncType, payload };
}

const UPGRADE_REJECTION_REASONS: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  503: 'Service Unavailable',
};

/** Reject an upgrade before `handleUpgrade`: HTTP error response, then close. */
function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  const reason = UPGRADE_REJECTION_REASONS[status] ?? 'Error';
  const body = `${message}\n`;
  const response =
    `HTTP/1.1 ${status} ${reason}\r\n` +
    'Connection: close\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    '\r\n' +
    body;
  // `end()` flushes the response before closing; destroying immediately could
  // drop the buffered rejection bytes before the client reads them.
  socket.once('finish', () => socket.destroy());
  socket.end(response);
}

type ExtractedYjsScope =
  | { readonly ok: true; readonly request: YjsConnectionRequest }
  | { readonly ok: false; readonly status: number; readonly message: string };

/**
 * Server-side scope extraction from the upgrade URL. The one-time Yjs ticket
 * and requested project/document are derived from the request; every value is
 * re-validated by the gateway auth port before any frame can be exchanged.
 */
function extractYjsScope(request: IncomingMessage): ExtractedYjsScope {
  let url: URL;
  try {
    url = new URL(request.url ?? '', 'http://localhost');
  } catch {
    return { ok: false, status: 400, message: 'malformed upgrade request url' };
  }
  if (url.pathname !== HOST_YJS_UPGRADE_PATH) {
    return { ok: false, status: 404, message: `no upgrade surface at ${url.pathname}` };
  }
  const ticket = url.searchParams.get(YJS_QUERY_TICKET);
  const projectId = url.searchParams.get(YJS_QUERY_PROJECT);
  const documentId = url.searchParams.get(YJS_QUERY_DOCUMENT);
  if (ticket === null || ticket.length === 0) {
    return { ok: false, status: 401, message: 'missing yjs ticket' };
  }
  if (projectId === null || projectId.length === 0) {
    return { ok: false, status: 400, message: 'missing project scope' };
  }
  if (documentId === null || documentId.length === 0) {
    return { ok: false, status: 400, message: 'missing document scope' };
  }
  return { ok: true, request: { ticket, projectId, documentId } };
}

function denialStatus(
  reason: YjsDenialReason | 'STORAGE_UNAVAILABLE' | 'CONNECTION_CLOSED',
): number {
  switch (reason) {
    case 'UNAUTHENTICATED':
    case 'EXPIRED':
      return 401;
    case 'PROJECT_MISMATCH':
      return 403;
    case 'INVALID_DOCUMENT':
      return 404;
    case 'STORAGE_UNAVAILABLE':
    case 'CONNECTION_CLOSED':
      return 503;
  }
}

function toUint8Array(data: RawData): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  let total = 0;
  for (const part of data) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of data) {
    out.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Per-socket transport state. `latestState` is the most recent authoritative
 * persisted state known to this socket: the state hydrated at bind time,
 * advanced by every accepted update.
 */
interface YjsSocketRuntime {
  latestState: WorkingDocumentState | null;
}

/** One live socket bound to a gateway connection, grouped for broadcast. */
interface YjsSocketBinding {
  readonly ws: WebSocket;
  readonly runtime: YjsSocketRuntime;
}

/** Live sockets grouped by the exact project/document scope of their connection. */
type YjsBroadcastGroups = Map<string, Set<YjsSocketBinding>>;

/** Broadcast group key: the exact project/document scope, never wider. */
const scopeKey = (scope: YjsConnectionScope): string =>
  `${scope.projectId}\u0000${scope.documentId}`;

/**
 * Deliver one authoritative persisted state to every other live socket bound
 * to the exact same project/document scope. The initiating socket is skipped
 * (its acknowledgement is written by the caller), and closed sockets are
 * removed from the group at close/error; the readyState guard covers the race
 * where a socket closes between removal and delivery.
 */
function broadcastYjsState(
  groups: YjsBroadcastGroups,
  key: string,
  sender: WebSocket,
  state: WorkingDocumentState,
): void {
  const group = groups.get(key);
  if (group === undefined) return;
  const frame = encodeYjsSyncStep2(state.update);
  for (const peer of group) {
    if (peer.ws === sender || peer.ws.readyState !== WebSocket.OPEN) continue;
    peer.runtime.latestState = state;
    peer.ws.send(frame);
  }
}

/**
 * Handle one binary client frame. Only sync step 1, sync step 2 and the
 * standard `messageYjsUpdate` (subtype 2) participate in the gateway
 * lifecycle; the server stays the single authority for state, so every
 * response carries the authoritative merged state.
 */
async function handleYjsMessage(
  ws: WebSocket,
  runtime: YjsSocketRuntime,
  connection: YjsGatewayConnection,
  groups: YjsBroadcastGroups,
  key: string,
  data: Uint8Array,
): Promise<void> {
  let frame: YjsSyncFrame | null;
  try {
    frame = parseYjsSyncFrame(data);
  } catch {
    ws.close(1002, 'malformed yjs message');
    return;
  }
  if (frame === null) return; // awareness/auth frames: gateway-owned, ignored.
  if (frame.syncType === SYNC_STEP_1) {
    // The canonical document is gateway-owned, so the best diff answerable
    // here is the latest authoritative full state for the bound scope.
    if (runtime.latestState !== null) {
      ws.send(encodeYjsSyncStep2(runtime.latestState.update));
    }
    return;
  }
  if (frame.syncType === SYNC_STEP_2 || frame.syncType === SYNC_UPDATE) {
    // Step 2 and messageYjsUpdate are the two standard y-protocols update
    // carriers; both merge into the canonical working document through the
    // same authenticated apply/persist path and reach exact-scope peers.
    let result: YjsApplyResult;
    try {
      result = await connection.applyUpdate(frame.payload);
    } catch {
      ws.close(1011, 'yjs gateway failure');
      return;
    }
    if (!result.ok) {
      // The persisted state stays authoritative: a rejected update must not
      // leave the client silently diverged, so drop the socket and let a
      // reconnect re-sync from the persisted state.
      ws.close(1008, `update rejected: ${result.reason}`);
      return;
    }
    runtime.latestState = result.state;
    ws.send(encodeYjsSyncStep2(result.state.update));
    broadcastYjsState(groups, key, ws, result.state);
    return;
  }
  ws.close(1003, `unsupported yjs sync step ${frame.syncType}`);
}

/**
 * Bind one accepted socket to its gateway connection and register it in the
 * broadcast group for its exact project/document scope. Every accepted
 * update is applied and persisted through the gateway; the sender is
 * acknowledged with the authoritative merged state, every other live socket
 * on the same scope receives the same state, and the client converges to the
 * server across updates and reconnects.
 */
function attachYjsSocket(
  ws: WebSocket,
  connection: YjsGatewayConnection,
  initialState: WorkingDocumentState | null,
  groups: YjsBroadcastGroups,
): void {
  const runtime: YjsSocketRuntime = { latestState: initialState };
  const binding: YjsSocketBinding = { ws, runtime };
  const key = scopeKey(connection.scope);
  const group = groups.get(key) ?? new Set<YjsSocketBinding>();
  group.add(binding);
  groups.set(key, group);
  if (initialState !== null) {
    ws.send(encodeYjsSyncStep2(initialState.update));
  }
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return; // only binary yjs frames are meaningful here.
    void handleYjsMessage(ws, runtime, connection, groups, key, toUint8Array(data));
  });
  // A socket leaves the broadcast group at close/error, before any later
  // broadcast can target it; disconnect is idempotent when both events fire.
  const release = (): void => {
    group.delete(binding);
    if (group.size === 0) groups.delete(key);
    connection.disconnect();
  };
  ws.on('close', release);
  ws.on('error', release);
}

/**
 * Build the Host's authenticated Yjs upgrade seam over one gateway. No
 * standalone WebSocket server is ever created: upgrades ride the existing
 * Host HTTP listener, auth/scope resolution happens before `handleUpgrade`,
 * and `close()` terminates every socket and the ws server before the
 * listener stops accepting.
 *
 * The surface is per-listen-cycle: `open()` (invoked by the listener on every
 * `start()`) rebuilds the ws server and broadcast groups, so a close/start
 * cycle re-enables exactly one safe upgrade handler instead of permanently
 * shutting the surface down or leaking a second one beside a stale first.
 */
function createYjsUpgradeHandler(gateway: YjsGateway): HostUpgradeListener {
  /** One live listen cycle; replaced on every `open()`, cleared on `close()`. */
  let surface: { wss: WebSocketServer; groups: YjsBroadcastGroups; closed: boolean } | null = null;

  const open = (): void => {
    surface = {
      wss: new WebSocketServer({ noServer: true }),
      /** Live sockets grouped by exact project/document scope; dies with the cycle. */
      groups: new Map(),
      closed: false,
    };
  };

  return {
    open,
    async handle(request, socket, head) {
      const current = surface;
      if (current === null || current.closed) {
        rejectUpgrade(socket, 503, 'host is shutting down');
        return;
      }
      const extracted = extractYjsScope(request);
      if (!extracted.ok) {
        rejectUpgrade(socket, extracted.status, extracted.message);
        return;
      }
      const result = await gateway.connect(extracted.request);
      if (!result.ok) {
        rejectUpgrade(
          socket,
          denialStatus(result.reason),
          `yjs connection denied: ${result.reason}`,
        );
        return;
      }
      let upgraded = false;
      try {
        current.wss.handleUpgrade(request, socket, head, (ws) => {
          upgraded = true;
          attachYjsSocket(ws, result.connection, result.initialState, current.groups);
        });
      } catch (error) {
        // handleUpgrade failed without accepting; never leak the bound
        // gateway connection.
        result.connection.disconnect();
        throw error;
      }
      if (!upgraded) {
        // ws aborted the handshake (invalid headers, dead socket): the
        // gateway connection was bound pre-upgrade, so release it now.
        result.connection.disconnect();
      }
    },
    async close() {
      const current = surface;
      if (current === null) return;
      current.closed = true;
      // wss.close() only settles once every client is gone, so terminate all
      // sockets first; their gateway connections release via 'close'.
      for (const client of current.wss.clients) client.terminate();
      const { promise, resolve } = Promise.withResolvers<void>();
      current.wss.close(() => resolve());
      await promise;
      surface = null;
    },
  };
}

/**
 * Forward-compatible gateway re-arm seam. The gateway closure contract adds
 * an explicit `open()` that unblocks `connect()` after a terminal `close()`;
 * until that lands, the optional member is absent and reopening is a no-op.
 */
type ReopenableYjsGateway = YjsGateway & { readonly open?: () => void | Promise<void> };

/**
 * Create the composed Host server. All configuration flows through the
 * listener's fail-closed transport validation (loopback default, explicit
 * LAN opt-in, Unix proxy-only forwarded headers, no implicit TLS). When
 * `yjs` options are provided, an authenticated Yjs gateway is mounted and
 * its WebSocket upgrade surface is attached to the listener's upgrade seam:
 * `close()` disconnects every Yjs connection (presence cleanup), terminates
 * every WebSocket and the ws server, then stops the HTTP listener. A later
 * `start()` reopens the surface for a fresh listen cycle, so close/start
 * sequences are safe and never duplicate the upgrade handler. When `mcp`
 * options are provided, the prebuilt authenticated MCP endpoint is mounted
 * through the listener's guarded MCP route during construction, before any
 * start; without `mcp` options the Host exposes no MCP surface (fail closed).
 * When `browser` options are provided, the injected browser read surface is
 * mounted through the listener's guarded read routes during construction;
 * without `browser` options the Host exposes no browser API at all.
 */
export function createHostServer(options: HostServerOptions = {}): HostServer {
  const yjs = options.yjs === undefined ? null : createYjsGateway(options.yjs);
  // The authenticated Yjs upgrade surface is the only upgrade handler the
  // Host installs when yjs is configured; it supersedes any caller-provided
  // seam so no second, less-guarded upgrade path can exist beside it.
  const upgrade = yjs === null ? options.upgrade : createYjsUpgradeHandler(yjs);
  const listener = createHostListener({ ...options, upgrade });
  const mcp = options.mcp;
  if (mcp !== undefined) {
    listener.registerMcpRoute(mcp.path ?? DEFAULT_MCP_STREAMABLE_PATH, (context) =>
      mcp.endpoint.handle(context.req.raw),
    );
    for (const route of mcp.routes ?? []) {
      listener.registerMcpRoute(route.path, (context) => route.endpoint.handle(context.req.raw));
    }
  }
  // Mount the injected browser read surface through the guarded read route
  // while the listener is still unstarted: registration happens during
  // construction so the surface exists before `start()` and an unconfigured
  // Host never registers a browser route at all.
  const browser = options.browser === undefined ? null : createBrowserReadApi(options.browser);
  if (browser !== null) {
    for (const route of browser.routes) {
      listener.registerReadRoute(route.path, route.handler);
    }
  }
  return {
    listener,
    app: listener.app,
    yjs,
    browser,
    start: async () => {
      // Re-arm the gateway before the listener rebinds its upgrade seam: a
      // previous close() may be terminal, so connect() must be unblocked
      // before any upgrade can reach the listener. A running listener is
      // never reopened — the guard mirrors the listener's own.
      if (listener.status().running) {
        throw new HostListenerStateError('listener is already running');
      }
      await (yjs as ReopenableYjsGateway | null)?.open?.();
      return listener.start();
    },
    close: async () => {
      // The gateway close is awaited: in-flight per-document operations drain
      // and every connection disconnects before the listener stops accepting,
      // so no upgrade socket or in-memory working document outlives shutdown.
      await yjs?.close();
      await listener.close();
    },
    status: () => listener.status(),
    endpoints: () => listener.endpoints(),
    registerMutationRoute: (method, path, handler) =>
      listener.registerMutationRoute(method, path, handler),
    registerMcpRoute: (path, handler) => listener.registerMcpRoute(path, handler),
    registerReadRoute: (path, handler) => listener.registerReadRoute(path, handler),
    registerPublicStaticRoute: (path, handler) => listener.registerPublicStaticRoute(path, handler),
    registerPublicAuthPostRoute: (path, handler) =>
      listener.registerPublicAuthPostRoute(path, handler),
    registerSetupRoute: (method, path, handler) =>
      listener.registerSetupRoute(method, path, handler),
    isMutationAllowed: (host, origin) => listener.isMutationAllowed(host, origin),
  };
}

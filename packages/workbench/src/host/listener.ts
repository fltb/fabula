/**
 * Workbench Host HTTP listener lifecycle: an explicit loopback / LAN / Unix
 * proxy binding matrix with fail-closed security defaults. Direct HTTP listens
 * on loopback by default; LAN binding requires an explicit `lan: true`
 * opt-in; Unix-domain proxy mode is the only mode permitted to trust
 * forwarded protocol headers. The listener never derives its authority (host
 * or protocol) from client-supplied headers, and it never terminates TLS
 * itself. Identity, Yjs and MCP surfaces are out of scope for this module;
 * the Host server facade (`./server.ts`) is the composition seam where they
 * will mount.
 */

import { createAdaptorServer, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { Hono, type Context, type Handler, type MiddlewareHandler } from 'hono';

export type HostListenerMode = 'loopback' | 'lan' | 'unix';
export type EffectiveProtocol = 'http' | 'https';
export type HostHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type MutationHttpMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type HostEndpointKind = 'health' | 'status' | 'mutation';

export const DEFAULT_HOST_LISTENER_PORT = 8787;
export const DEFAULT_HOST_HEALTH_PATH = '/health';
export const HOST_STATUS_PATH = '/status';
export const MUTATION_METHODS: readonly MutationHttpMethod[] = [
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
];

/** Host/Origin values that never expose the listener on the network. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return (
    h === 'localhost' ||
    h === '::1' ||
    h === '[::1]' ||
    h === '127.0.0.1' ||
    h.startsWith('127.')
  );
}

export interface HostListenerConfig {
  /** Direct HTTP TCP port; `0` selects an ephemeral port. Unix mode ignores it. Default {@link DEFAULT_HOST_LISTENER_PORT}. */
  readonly port?: number;
  /** Bind target: `'loopback'` (default), `'lan'`, or an explicit host/IP. */
  readonly host?: 'loopback' | 'lan' | string;
  /** Explicit opt-in required for any non-loopback direct binding. Default false. */
  readonly lan?: boolean;
  /** Unix-domain socket path that switches the listener into proxy mode. */
  readonly unixSocket?: string;
  /**
   * Trust `x-forwarded-proto`. Permitted ONLY in Unix proxy mode; direct
   * listeners reject this option. Default false.
   */
  readonly trustForwardedHeaders?: boolean;
  /** Health endpoint path. Default {@link DEFAULT_HOST_HEALTH_PATH}. */
  readonly healthPath?: string;
  /** Host/Origin allowlist enforced on mutation route requests. */
  readonly mutation?: MutationAllowlist;
}

export interface MutationAllowlist {
  /**
   * Exact `Host` header values (optionally with port) allowed to reach
   * mutation routes. An entry without a port matches any port on that host.
   * Empty (default) = no host restriction.
   */
  readonly allowedHosts?: readonly string[];
  /**
   * Exact `Origin` header values allowed to reach mutation routes. Requests
   * without an Origin header (MCP, CLI) remain permitted. Empty (default) =
   * no origin restriction.
   */
  readonly allowedOrigins?: readonly string[];
}

export interface HostListenerStatus {
  readonly mode: HostListenerMode;
  /** Effective bind host (`127.0.0.1`, `0.0.0.0`, explicit host, or the projected authority in Unix mode). */
  readonly host: string;
  /** Bound TCP port when running, configured port before start, null in Unix mode. */
  readonly port: number | null;
  readonly unixSocket: string | null;
  readonly lan: boolean;
  /** The direct listener never terminates TLS; this is always `false`. */
  readonly tls: false;
  readonly trustForwardedHeaders: boolean;
  readonly running: boolean;
}

export interface HostEndpoint {
  readonly method: HostHttpMethod;
  readonly path: string;
  readonly kind: HostEndpointKind;
  /** True for mutation routes, which are allowlist-guarded. */
  readonly guarded: boolean;
}

export interface HostEndpointProjection {
  readonly health: HostEndpoint;
  readonly status: HostEndpoint;
  readonly mutations: readonly HostEndpoint[];
}

export interface HostHealthPayload {
  readonly status: 'ok';
  readonly listener: HostListenerStatus;
  readonly protocol: RequestProtocol;
}

export interface HostStatusPayload extends HostHealthPayload {
  readonly endpoints: HostEndpointProjection;
}

export interface RequestProtocol {
  readonly protocol: EffectiveProtocol;
  /** `'socket'` = derived from the connection; `'forwarded'` = from a trusted proxy header. */
  readonly source: 'socket' | 'forwarded';
  readonly trustForwardedHeaders: boolean;
}

export interface HostListenerVariables {
  readonly effectiveProtocol: RequestProtocol;
}

export type HostListenerEnv = { Variables: HostListenerVariables };
export type HostListenerApp = Hono<HostListenerEnv>;

export interface HostListenerHandle {
  /** The underlying Node HTTP server (plain `http.Server`; never TLS). */
  readonly server: ServerType;
  /** `AddressInfo` for TCP, the socket path string for Unix mode. */
  readonly address: AddressInfo | string | null;
  readonly port: number | null;
  readonly host: string;
  readonly mode: HostListenerMode;
  close(): Promise<void>;
}

export interface HostListener {
  readonly config: Readonly<HostListenerConfig>;
  /** Root Hono app: protocol middleware, health and status endpoints, mutation routes. */
  readonly app: HostListenerApp;
  /** Bind the configured transport and resolve a launch handle. */
  start(): Promise<HostListenerHandle>;
  /** Close the transport; idempotent. */
  close(): Promise<void>;
  /** Live typed status projection. */
  status(): HostListenerStatus;
  /** Typed endpoint projection (health, status, registered mutations). */
  endpoints(): HostEndpointProjection;
  /**
   * Register a mutation route under the Host/Origin allowlist. Only mutation
   * methods (`POST`/`PUT`/`PATCH`/`DELETE`) are accepted, and registration
   * must happen before `start()`.
   */
  registerMutationRoute(
    method: MutationHttpMethod,
    path: string,
    handler: Handler<HostListenerEnv>,
  ): void;
  isMutationAllowed(host: string | undefined, origin: string | undefined): boolean;
}

export class HostListenerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostListenerError';
  }
}

export class HostListenerConfigError extends HostListenerError {
  constructor(message: string) {
    super(message);
    this.name = 'HostListenerConfigError';
  }
}

export class HostListenerStateError extends HostListenerError {
  constructor(message: string) {
    super(message);
    this.name = 'HostListenerStateError';
  }
}

/**
 * Split a `host[:port]` value (bracket-aware for IPv6) into its parts,
 * lowercased. A missing or empty port yields `port: null`.
 */
export function splitHostPort(value: string): { readonly host: string; readonly port: string | null } {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end === -1) return { host: trimmed, port: null };
    const rest = trimmed.slice(end + 1);
    return { host: trimmed.slice(0, end + 1), port: rest.startsWith(':') ? rest.slice(1) : null };
  }
  const colon = trimmed.indexOf(':');
  if (colon === -1) return { host: trimmed, port: null };
  return { host: trimmed.slice(0, colon), port: trimmed.slice(colon + 1) || null };
}

/** True when `host` matches an allowlist entry (an entry without a port matches any port). */
export function isHostAllowed(host: string | undefined, allowedHosts: readonly string[]): boolean {
  if (allowedHosts.length === 0) return true;
  if (host === undefined) return false;
  const request = splitHostPort(host);
  return allowedHosts.some((entry) => {
    const allowed = splitHostPort(entry);
    return allowed.port === null
      ? request.host === allowed.host
      : request.host === allowed.host && request.port === allowed.port;
  });
}

function normalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin.trim());
    const defaultPort = url.protocol === 'https:' ? '443' : '80';
    const port = url.port !== '' && url.port !== defaultPort ? `:${url.port}` : '';
    return `${url.protocol}//${url.hostname.toLowerCase()}${port}`;
  } catch {
    return origin.trim().toLowerCase();
  }
}

/** True when `origin` matches an allowlist entry; requests without an Origin remain allowed. */
export function isOriginAllowed(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  if (allowedOrigins.length === 0) return true;
  if (origin === undefined) return true;
  const normalized = normalizeOrigin(origin);
  return allowedOrigins.some((entry) => normalized === normalizeOrigin(entry));
}

/** Combined mutation guard: host and origin must each pass their allowlist. */
export function isMutationAllowed(
  host: string | undefined,
  origin: string | undefined,
  allowlist: MutationAllowlist,
): boolean {
  return (
    isHostAllowed(host, allowlist.allowedHosts ?? []) &&
    isOriginAllowed(origin, allowlist.allowedOrigins ?? [])
  );
}

/**
 * Resolve the effective request protocol. Forwarded headers are only ever
 * consulted when `trustForwardedHeaders` is true (Unix proxy mode); invalid
 * or missing values fail closed to the socket-derived protocol. The listener
 * never reads client-supplied authority (host) headers.
 */
export function resolveRequestProtocol(
  request: { readonly headers: Headers },
  trustForwardedHeaders: boolean,
): RequestProtocol {
  const forwarded = request.headers.get('x-forwarded-proto');
  if (trustForwardedHeaders && forwarded !== null) {
    const proto = forwarded.split(',')[0]?.trim().toLowerCase();
    if (proto === 'http' || proto === 'https') {
      return { protocol: proto, source: 'forwarded', trustForwardedHeaders };
    }
  }
  return { protocol: 'http', source: 'socket', trustForwardedHeaders };
}

/** Read the per-request effective protocol installed by the listener middleware. */
export function getRequestProtocol(c: Context<HostListenerEnv>): RequestProtocol {
  return c.get('effectiveProtocol');
}

interface ResolvedListenerConfig {
  readonly mode: HostListenerMode;
  readonly bindHost: string;
  readonly projectedHost: string;
  readonly bindPort: number;
  readonly unixSocket: string | null;
  readonly trustForwardedHeaders: boolean;
  readonly healthPath: string;
  readonly allowlist: MutationAllowlist;
}

function normalizeStringList(value: readonly string[] | undefined, name: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new HostListenerConfigError(`${name} must be an array of strings`);
  }
  return [...value];
}
function resolveListenerConfig(config: HostListenerConfig): ResolvedListenerConfig {
  // Fail closed against untyped callers smuggling a TLS option into a typed config.
  const tlsRequested = (config as { readonly tls?: unknown }).tls;
  if (tlsRequested === true) {
    throw new HostListenerConfigError(
      'the direct listener never terminates TLS; terminate TLS at a trusted reverse proxy',
    );
  }
  const healthPath = config.healthPath ?? DEFAULT_HOST_HEALTH_PATH;
  if (typeof healthPath !== 'string' || healthPath.length === 0 || !healthPath.startsWith('/')) {
    throw new HostListenerConfigError(
      `healthPath must be a non-empty path starting with '/'; got ${JSON.stringify(healthPath)}`,
    );
  }
  const unixSocket = config.unixSocket ?? null;
  if (unixSocket !== null && (typeof unixSocket !== 'string' || unixSocket.length === 0)) {
    throw new HostListenerConfigError('unixSocket must be a non-empty filesystem path');
  }
  const trustForwardedHeaders = config.trustForwardedHeaders === true;
  const allowlist: MutationAllowlist = {
    allowedHosts: normalizeStringList(config.mutation?.allowedHosts, 'mutation.allowedHosts'),
    allowedOrigins: normalizeStringList(config.mutation?.allowedOrigins, 'mutation.allowedOrigins'),
  };

  if (unixSocket !== null) {
    if (config.lan === true || config.host === 'lan') {
      throw new HostListenerConfigError(
        'unixSocket proxy mode is incompatible with lan: true / host: "lan"',
      );
    }
    const projectedHost =
      config.host !== undefined && config.host !== 'loopback' ? config.host : 'localhost';
    return {
      mode: 'unix',
      bindHost: projectedHost,
      projectedHost,
      bindPort: DEFAULT_HOST_LISTENER_PORT,
      unixSocket,
      trustForwardedHeaders,
      healthPath,
      allowlist,
    };
  }

  if (trustForwardedHeaders) {
    throw new HostListenerConfigError(
      'direct listeners must not trust forwarded headers; enable unixSocket proxy mode to trust x-forwarded-proto',
    );
  }
  const host = config.host ?? (config.lan === true ? 'lan' : 'loopback');
  if (config.lan === true && host !== 'lan' && (host === 'loopback' || isLoopbackHost(host))) {
    throw new HostListenerConfigError(
      'lan: true contradicts a loopback bind host; remove one of them',
    );
  }
  const bindHost = host === 'lan' ? '0.0.0.0' : host === 'loopback' ? '127.0.0.1' : host;
  const needsLan = host === 'lan' || !isLoopbackHost(bindHost);
  if (needsLan && config.lan !== true) {
    throw new HostListenerConfigError(
      `binding ${bindHost} exposes the host on the network; set lan: true to enable LAN direct HTTP explicitly`,
    );
  }
  const port = config.port ?? DEFAULT_HOST_LISTENER_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new HostListenerConfigError(
      `port must be an integer between 0 and 65535; got ${JSON.stringify(port)}`,
    );
  }
  return {
    mode: needsLan ? 'lan' : 'loopback',
    bindHost,
    projectedHost: bindHost,
    bindPort: port,
    unixSocket: null,
    trustForwardedHeaders: false,
    healthPath,
    allowlist,
  };
}

interface ListenerRuntimeState {
  readonly running: boolean;
  readonly server: ServerType | null;
  readonly address: AddressInfo | string | null;
  readonly port: number | null;
}

function protocolMiddleware(trustForwardedHeaders: boolean): MiddlewareHandler<HostListenerEnv> {
  return async (c, next) => {
    const resolved = resolveRequestProtocol(c.req.raw, trustForwardedHeaders);
    if (resolved.source === 'forwarded') {
      c.set('effectiveProtocol', resolved);
    } else {
      const env = c.env as
        | { readonly incoming?: { readonly socket?: { readonly encrypted?: boolean } } }
        | undefined;
      const encrypted = env?.incoming?.socket?.encrypted === true;
      c.set('effectiveProtocol', {
        protocol: encrypted ? 'https' : 'http',
        source: 'socket',
        trustForwardedHeaders,
      });
    }
    await next();
  };
}

function mutationGuard(listener: HostListenerImpl): MiddlewareHandler<HostListenerEnv> {
  return async (c, next) => {
    if (!listener.isMutationAllowed(c.req.header('host'), c.req.header('origin'))) {
      return c.json(
        { error: 'mutation denied: host/origin is not on the listener allowlist' },
        403,
      );
    }
    await next();
  };
}

function healthHandler(listener: HostListenerImpl): Handler<HostListenerEnv> {
  return (c) =>
    c.json({ status: 'ok', listener: listener.status(), protocol: getRequestProtocol(c) }, 200);
}

function statusHandler(listener: HostListenerImpl): Handler<HostListenerEnv> {
  return (c) =>
    c.json(
      {
        status: 'ok',
        listener: listener.status(),
        endpoints: listener.endpoints(),
        protocol: getRequestProtocol(c),
      },
      200,
    );
}
function listenOnce(
  server: ServerType,
  target: string | { readonly port: number; readonly host: string },
): Promise<AddressInfo | string | null> {
  const { promise, resolve, reject } = Promise.withResolvers<AddressInfo | string | null>();
  const onError = (error: Error): void => {
    server.off('listening', onListening);
    reject(error);
  };
  const onListening = (): void => {
    server.off('error', onError);
    resolve(server.address());
  };
  server.once('error', onError);
  server.once('listening', onListening);
  try {
    if (typeof target === 'string') {
      server.listen(target);
    } else {
      server.listen(target.port, target.host);
    }
  } catch (error) {
    server.off('error', onError);
    server.off('listening', onListening);
    reject(error instanceof Error ? error : new Error(String(error)));
  }
  return promise;
}

class HostListenerImpl implements HostListener {
  readonly config: Readonly<HostListenerConfig>;
  readonly app: HostListenerApp;
  private readonly resolved: ResolvedListenerConfig;
  private state: ListenerRuntimeState = {
    running: false,
    server: null,
    address: null,
    port: null,
  };
  private readonly mutationEndpoints: HostEndpoint[] = [];

  constructor(config: HostListenerConfig) {
    this.config = { ...config };
    this.resolved = resolveListenerConfig(config);
    this.app = new Hono<HostListenerEnv>();
    this.app.use('*', protocolMiddleware(this.resolved.trustForwardedHeaders));
    this.app.get(this.resolved.healthPath, healthHandler(this));
    this.app.get(HOST_STATUS_PATH, statusHandler(this));
  }

  async start(): Promise<HostListenerHandle> {
    if (this.state.running) {
      throw new HostListenerStateError('listener is already running');
    }
    const { mode, bindHost, projectedHost, bindPort, unixSocket } = this.resolved;
    const server = createAdaptorServer({
      fetch: (request, env) => this.app.fetch(request, env),
      hostname: projectedHost,
      overrideGlobalObjects: false,
    });
    const address = await (mode === 'unix'
      ? listenOnce(server, unixSocket as string)
      : listenOnce(server, { port: bindPort, host: bindHost }));
    const port = address !== null && typeof address !== 'string' ? address.port : null;
    this.state = { running: true, server, address, port };
    return {
      server,
      address,
      port,
      host: mode === 'unix' ? projectedHost : bindHost,
      mode,
      close: () => this.close(),
    };
  }

  async close(): Promise<void> {
    const server = this.state.server;
    if (server === null) return;
    this.state = { running: false, server: null, address: null, port: null };
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close((error) => (error ? reject(error) : resolve()));
    // Force-close keep-alive connections so close() never waits on idle sockets.
    const withCloseAllConnections = server as { closeAllConnections?: () => void };
    withCloseAllConnections.closeAllConnections?.();
    await promise;
  }

  status(): HostListenerStatus {
    const { mode, bindHost, projectedHost, bindPort, unixSocket, trustForwardedHeaders } =
      this.resolved;
    const { running, port } = this.state;
    return {
      mode,
      host: mode === 'unix' ? projectedHost : bindHost,
      port: mode === 'unix' ? null : running ? port : bindPort,
      unixSocket: mode === 'unix' ? unixSocket : null,
      lan: mode === 'lan',
      tls: false,
      trustForwardedHeaders,
      running,
    };
  }

  endpoints(): HostEndpointProjection {
    return {
      health: {
        method: 'GET',
        path: this.resolved.healthPath,
        kind: 'health',
        guarded: false,
      },
      status: { method: 'GET', path: HOST_STATUS_PATH, kind: 'status', guarded: false },
      mutations: [...this.mutationEndpoints],
    };
  }

  registerMutationRoute(
    method: MutationHttpMethod,
    path: string,
    handler: Handler<HostListenerEnv>,
  ): void {
    if (!(MUTATION_METHODS as readonly string[]).includes(method)) {
      throw new HostListenerError(
        `mutation routes require one of ${MUTATION_METHODS.join(', ')}; got ${JSON.stringify(method)}`,
      );
    }
    if (typeof path !== 'string' || path.length === 0 || !path.startsWith('/')) {
      throw new HostListenerError(
        `mutation route path must start with '/'; got ${JSON.stringify(path)}`,
      );
    }
    if (this.state.running) {
      throw new HostListenerStateError('mutation routes must be registered before start()');
    }
    this.mutationEndpoints.push({ method, path, kind: 'mutation', guarded: true });
    this.app.on(method, path, mutationGuard(this), handler);
  }

  isMutationAllowed(host: string | undefined, origin: string | undefined): boolean {
    return isMutationAllowed(host, origin, this.resolved.allowlist);
  }
}

/** Create a Host listener with fail-closed transport defaults. */
export function createHostListener(config: HostListenerConfig = {}): HostListener {
  return new HostListenerImpl(config);
}

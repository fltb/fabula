import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type {
  HostListener,
  HostListenerConfig,
  HostUpgradeListener,
} from '../src/host/listener.js';
import {
  createHostListener,
  DEFAULT_HOST_LISTENER_PORT,
  HostListenerConfigError,
  HostListenerError,
  HostListenerStateError,
  isHostAllowed,
  isMutationAllowed,
  isOriginAllowed,
  resolveRequestProtocol,
  splitHostPort,
} from '../src/host/listener.js';
import { createHostServer } from '../src/host/server.js';

const open: HostListener[] = [];

const track = (listener: HostListener): HostListener => {
  open.push(listener);
  return listener;
};

const tempSocket = (): string => join(mkdtempSync(join(tmpdir(), 'wb-host-')), 'host.sock');

const startTracked = async (config: HostListenerConfig = { port: 0 }) => {
  const listener = track(createHostListener(config));
  return { listener, handle: await listener.start() };
};

afterEach(async () => {
  await Promise.all(open.splice(0).map((listener) => listener.close()));
});

describe('Host listener lifecycle', () => {
  it('defaults to loopback direct HTTP and projects typed status', () => {
    const listener = createHostListener();
    expect(listener.status()).toEqual({
      mode: 'loopback',
      host: '127.0.0.1',
      port: DEFAULT_HOST_LISTENER_PORT,
      unixSocket: null,
      lan: false,
      tls: false,
      trustForwardedHeaders: false,
      running: false,
    });
  });

  it('starts loopback HTTP on an ephemeral port and closes cleanly', async () => {
    const { listener, handle } = await startTracked();
    expect(handle.mode).toBe('loopback');
    expect(handle.host).toBe('127.0.0.1');
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.address).toMatchObject({ address: '127.0.0.1' });
    expect(listener.status()).toMatchObject({
      mode: 'loopback',
      host: '127.0.0.1',
      port: handle.port,
      running: true,
    });
    await handle.close();
    expect(listener.status().running).toBe(false);
  });

  it('rejects a second start while running', async () => {
    const { listener, handle } = await startTracked();
    await expect(listener.start()).rejects.toThrow(HostListenerStateError);
    await handle.close();
  });

  it('rejects LAN binding without an explicit lan: true opt-in', () => {
    expect(() => createHostListener({ host: 'lan' })).toThrow(HostListenerConfigError);
    expect(() => createHostListener({ host: '0.0.0.0' })).toThrow(HostListenerConfigError);
    expect(() => createHostListener({ host: '192.168.1.42' })).toThrow(HostListenerConfigError);
    expect(() => createHostListener({ port: 8787, lan: true })).not.toThrow();
    expect(() => createHostListener({ host: 'lan', lan: true })).not.toThrow();
  });

  it('binds LAN only when explicitly enabled', async () => {
    const { listener, handle } = await startTracked({ host: 'lan', lan: true });
    expect(handle.mode).toBe('lan');
    expect(handle.host).toBe('0.0.0.0');
    expect(handle.address).toMatchObject({ address: '0.0.0.0' });
    expect(listener.status()).toMatchObject({ lan: true, running: true });
    await handle.close();
  });

  it('rejects contradictory lan/loopback configuration', () => {
    expect(() => createHostListener({ lan: true, host: 'loopback' })).toThrow(
      HostListenerConfigError,
    );
    expect(() => createHostListener({ lan: true, host: '127.0.0.1' })).toThrow(
      HostListenerConfigError,
    );
  });

  it('never activates TLS implicitly and rejects explicit TLS config', async () => {
    const { listener, handle } = await startTracked();
    expect(listener.status().tls).toBe(false);
    expect('setSecureContext' in handle.server).toBe(false);
    await handle.close();
    expect(() => createHostListener({ tls: true } as HostListenerConfig)).toThrow(
      HostListenerConfigError,
    );
  });
});

describe('Host listener HTTP surface', () => {
  it('serves a typed health endpoint and 404s unknown routes', async () => {
    const { listener, handle } = await startTracked();
    const res = await listener.app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'ok',
      listener: { running: true, mode: 'loopback' },
      protocol: { protocol: 'http', source: 'socket', trustForwardedHeaders: false },
    });
    const missing = await listener.app.request('/definitely-not-a-route');
    expect(missing.status).toBe(404);
    await handle.close();
  });

  it('projects typed endpoints including registered mutation routes', async () => {
    const listener = track(createHostListener({ port: 0, healthPath: '/_health' }));
    listener.registerMutationRoute('POST', '/api/scenes', (c) => c.json({ ok: true }));
    expect(listener.endpoints()).toEqual({
      health: { method: 'GET', path: '/_health', kind: 'health', guarded: false },
      status: { method: 'GET', path: '/status', kind: 'status', guarded: false },
      mutations: [{ method: 'POST', path: '/api/scenes', kind: 'mutation', guarded: true }],
      mcp: [],
    });
    const handle = await listener.start();
    const res = await listener.app.request('/status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.endpoints.mutations).toEqual([
      { method: 'POST', path: '/api/scenes', kind: 'mutation', guarded: true },
    ]);
    expect(body.listener.running).toBe(true);
    await handle.close();
  });
});

describe('forwarded protocol trust boundary', () => {
  it('distrusts forwarded headers on the direct listener', async () => {
    const { listener, handle } = await startTracked();
    const res = await listener.app.request('/health', {
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.protocol).toEqual({
      protocol: 'http',
      source: 'socket',
      trustForwardedHeaders: false,
    });
    // The projected authority is config-derived, never client-supplied.
    expect(body.listener.host).toBe('127.0.0.1');
    expect(body.listener.tls).toBe(false);
    await handle.close();
  });

  it('rejects trustForwardedHeaders in direct mode', () => {
    expect(() => createHostListener({ trustForwardedHeaders: true })).toThrow(
      HostListenerConfigError,
    );
  });

  it('trusts forwarded protocol only in unix proxy mode with explicit trust', async () => {
    const sock = tempSocket();
    const listener = track(createHostListener({ unixSocket: sock, trustForwardedHeaders: true }));
    const handle = await listener.start();
    expect(handle.mode).toBe('unix');
    expect(handle.address).toBe(sock);
    expect(handle.port).toBeNull();
    expect(listener.status()).toMatchObject({
      mode: 'unix',
      unixSocket: sock,
      port: null,
      lan: false,
      trustForwardedHeaders: true,
      running: true,
    });
    expect(existsSync(sock)).toBe(true);
    const res = await listener.app.request('/health', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    const body = await res.json();
    expect(body.protocol).toEqual({
      protocol: 'https',
      source: 'forwarded',
      trustForwardedHeaders: true,
    });
    await handle.close();
    expect(existsSync(sock)).toBe(false);
  });

  it('ignores forwarded headers in unix mode without explicit trust', async () => {
    const sock = tempSocket();
    const listener = track(createHostListener({ unixSocket: sock }));
    const handle = await listener.start();
    const res = await listener.app.request('/health', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    const body = await res.json();
    expect(body.protocol).toEqual({
      protocol: 'http',
      source: 'socket',
      trustForwardedHeaders: false,
    });
    await handle.close();
  });

  it('rejects contradictory unix/lan configuration', () => {
    expect(() => createHostListener({ unixSocket: '/tmp/x.sock', lan: true })).toThrow(
      HostListenerConfigError,
    );
    expect(() => createHostListener({ unixSocket: '/tmp/x.sock', host: 'lan' })).toThrow(
      HostListenerConfigError,
    );
  });
});

describe('mutation route allowlist', () => {
  it('enforces the Host allowlist on mutation routes', async () => {
    const listener = track(
      createHostListener({
        port: 0,
        mutation: { allowedHosts: ['localhost', 'localhost:8787'] },
      }),
    );
    listener.registerMutationRoute('POST', '/api/scenes', (c) => c.json({ ok: true }));
    const handle = await listener.start();

    const allowed = await listener.app.request('/api/scenes', {
      method: 'POST',
      headers: { host: 'localhost:9000' },
    });
    expect(allowed.status).toBe(200);

    const denied = await listener.app.request('/api/scenes', {
      method: 'POST',
      headers: { host: 'evil.example' },
    });
    expect(denied.status).toBe(403);

    const noHost = await listener.app.request('/api/scenes', { method: 'POST' });
    expect(noHost.status).toBe(403);
    await handle.close();
  });

  it('enforces the Origin allowlist while allowing non-browser clients', async () => {
    const listener = track(
      createHostListener({
        port: 0,
        mutation: { allowedOrigins: ['http://localhost:5173'] },
      }),
    );
    listener.registerMutationRoute('PUT', '/api/scenes/1', (c) => c.json({ ok: true }));
    const handle = await listener.start();

    const allowed = await listener.app.request('/api/scenes/1', {
      method: 'PUT',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(allowed.status).toBe(200);

    const denied = await listener.app.request('/api/scenes/1', {
      method: 'PUT',
      headers: { origin: 'http://evil.example' },
    });
    expect(denied.status).toBe(403);

    const noOrigin = await listener.app.request('/api/scenes/1', { method: 'PUT' });
    expect(noOrigin.status).toBe(200);
    await handle.close();
  });

  it('lets mutation routes through when no allowlist is configured', async () => {
    const listener = track(createHostListener({ port: 0 }));
    listener.registerMutationRoute('PATCH', '/api/scenes/1', (c) => c.json({ ok: true }));
    const handle = await listener.start();
    const res = await listener.app.request('/api/scenes/1', {
      method: 'PATCH',
      headers: { host: 'whatever.example' },
    });
    expect(res.status).toBe(200);
    await handle.close();
  });

  it('rejects non-mutation methods and late registration', async () => {
    const listener = createHostListener();
    expect(() =>
      listener.registerMutationRoute('GET' as never, '/api/scenes', (c) => c.text('no')),
    ).toThrow(HostListenerError);

    const started = track(createHostListener({ port: 0 }));
    const handle = await started.start();
    expect(() => started.registerMutationRoute('POST', '/api/late', (c) => c.text('no'))).toThrow(
      HostListenerStateError,
    );
    await handle.close();
  });
});

describe('MCP route registration', () => {
  it('mounts GET, POST and DELETE behind the Host/Origin guard', async () => {
    const listener = track(
      createHostListener({
        port: 0,
        mutation: { allowedHosts: ['localhost'] },
      }),
    );
    const hits: string[] = [];
    listener.registerMcpRoute('/mcp', (c) => {
      hits.push(c.req.method);
      return c.json({ ok: true, method: c.req.method });
    });
    const handle = await listener.start();

    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      const res = await listener.app.request('/mcp', {
        method,
        headers: { host: 'localhost:9000' },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, method });
    }
    expect(hits).toEqual(['GET', 'POST', 'DELETE']);

    // A disallowed host is rejected on every MCP method and never reaches the handler.
    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      const denied = await listener.app.request('/mcp', {
        method,
        headers: { host: 'evil.example' },
      });
      expect(denied.status).toBe(403);
    }
    expect(hits).toEqual(['GET', 'POST', 'DELETE']);
    await handle.close();
  });

  it('guards MCP routes by Origin while allowing non-browser clients', async () => {
    const listener = track(
      createHostListener({ port: 0, mutation: { allowedOrigins: ['http://localhost:5173'] } }),
    );
    let reached = false;
    listener.registerMcpRoute('/mcp', (c) => {
      reached = true;
      return c.json({ ok: true });
    });
    const handle = await listener.start();

    const allowed = await listener.app.request('/mcp', {
      method: 'POST',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(allowed.status).toBe(200);
    expect(reached).toBe(true);

    reached = false;
    const denied = await listener.app.request('/mcp', {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
    });
    expect(denied.status).toBe(403);
    expect(reached).toBe(false);
    await handle.close();
  });

  it('projects MCP routes as guarded endpoints in the status body', async () => {
    const listener = track(createHostListener({ port: 0 }));
    listener.registerMcpRoute('/mcp', (c) => c.json({ ok: true }));
    expect(listener.endpoints().mcp).toEqual([
      { method: 'GET', path: '/mcp', kind: 'mcp', guarded: true },
      { method: 'POST', path: '/mcp', kind: 'mcp', guarded: true },
      { method: 'DELETE', path: '/mcp', kind: 'mcp', guarded: true },
    ]);
    const handle = await listener.start();
    const res = await listener.app.request('/status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.endpoints.mcp).toEqual([
      { method: 'GET', path: '/mcp', kind: 'mcp', guarded: true },
      { method: 'POST', path: '/mcp', kind: 'mcp', guarded: true },
      { method: 'DELETE', path: '/mcp', kind: 'mcp', guarded: true },
    ]);
    await handle.close();
  });

  it('rejects invalid paths and late registration like mutation routes', async () => {
    const listener = createHostListener();
    expect(() => listener.registerMcpRoute('mcp', (c) => c.text('no'))).toThrow(HostListenerError);
    expect(() => listener.registerMcpRoute('', (c) => c.text('no'))).toThrow(HostListenerError);
    expect(() => listener.registerMcpRoute(undefined as never, (c) => c.text('no'))).toThrow(
      HostListenerError,
    );

    const started = track(createHostListener({ port: 0 }));
    const handle = await started.start();
    expect(() => started.registerMcpRoute('/mcp', (c) => c.text('no'))).toThrow(
      HostListenerStateError,
    );
    await handle.close();
  });
});

describe('allowlist and protocol primitives', () => {
  it('splits hosts and matches portless allowlist entries', () => {
    expect(splitHostPort('LOCALHOST:9000')).toEqual({ host: 'localhost', port: '9000' });
    expect(splitHostPort('[::1]:8787')).toEqual({ host: '[::1]', port: '8787' });
    expect(splitHostPort('127.0.0.1')).toEqual({ host: '127.0.0.1', port: null });
    expect(isHostAllowed('localhost:9000', ['localhost'])).toBe(true);
    expect(isHostAllowed('localhost:9000', ['localhost:8787'])).toBe(false);
    expect(isHostAllowed('127.0.0.1:8787', ['127.0.0.1'])).toBe(true);
    expect(isHostAllowed('localhost:9000', ['[::1]'])).toBe(false);
    expect(isHostAllowed(undefined, ['localhost'])).toBe(false);
    expect(isHostAllowed('evil.example', [])).toBe(true);
  });

  it('normalizes origins and lets Origin-less clients through', () => {
    expect(isOriginAllowed('HTTP://LOCALHOST:5173', ['http://localhost:5173'])).toBe(true);
    expect(isOriginAllowed('http://localhost:80', ['http://localhost'])).toBe(true);
    expect(isOriginAllowed('http://localhost:5173', ['http://localhost'])).toBe(false);
    expect(isOriginAllowed('http://localhost:5173', ['http://localhost:8080'])).toBe(false);
    expect(isOriginAllowed(undefined, ['http://localhost'])).toBe(true);
  });

  it('combines host and origin checks', () => {
    const allowlist = {
      allowedHosts: ['localhost'],
      allowedOrigins: ['http://localhost:5173'],
    };
    expect(isMutationAllowed('localhost:9000', 'http://localhost:5173', allowlist)).toBe(true);
    expect(isMutationAllowed('evil.example', 'http://localhost:5173', allowlist)).toBe(false);
    expect(isMutationAllowed('localhost:9000', 'http://evil.example', allowlist)).toBe(false);
  });

  it('resolves forwarded proto only when explicitly trusted', () => {
    const headers = new Headers({ 'x-forwarded-proto': 'https' });
    expect(resolveRequestProtocol({ headers }, false)).toEqual({
      protocol: 'http',
      source: 'socket',
      trustForwardedHeaders: false,
    });
    expect(resolveRequestProtocol({ headers }, true)).toEqual({
      protocol: 'https',
      source: 'forwarded',
      trustForwardedHeaders: true,
    });
    const none = new Headers();
    expect(resolveRequestProtocol({ headers: none }, true)).toEqual({
      protocol: 'http',
      source: 'socket',
      trustForwardedHeaders: true,
    });
    const bad = new Headers({ 'x-forwarded-proto': 'ftp' });
    expect(resolveRequestProtocol({ headers: bad }, true)).toEqual({
      protocol: 'http',
      source: 'socket',
      trustForwardedHeaders: true,
    });
  });
});

describe('Host server facade', () => {
  it('composes the listener and delegates lifecycle and surface', async () => {
    const server = createHostServer({ port: 0 });
    const handle = await server.start();
    expect(handle.port).toBeGreaterThan(0);
    expect(server.status().running).toBe(true);
    expect(server.listener.status()).toEqual(server.status());
    const res = await server.app.request('/health');
    expect(res.status).toBe(200);
    await server.close();
    expect(server.status().running).toBe(false);
  });

  it('registers mutation routes under the allowlist through the facade', async () => {
    const server = createHostServer({
      port: 0,
      mutation: { allowedHosts: ['localhost'] },
    });
    server.registerMutationRoute('DELETE', '/api/scenes/1', (c) => c.json({ ok: true }));
    const handle = await server.start();
    const allowed = await server.app.request('/api/scenes/1', {
      method: 'DELETE',
      headers: { host: 'localhost:9000' },
    });
    expect(allowed.status).toBe(200);
    const denied = await server.app.request('/api/scenes/1', {
      method: 'DELETE',
      headers: { host: 'evil.example' },
    });
    expect(denied.status).toBe(403);
    await handle.close();
  });

  it('exposes MCP route registration through the facade under the guard', async () => {
    const server = createHostServer({
      port: 0,
      mutation: { allowedHosts: ['localhost'] },
    });
    server.registerMcpRoute('/mcp', (c) => c.json({ ok: true }));
    const handle = await server.start();
    expect(server.endpoints().mcp).toHaveLength(3);
    const allowed = await server.app.request('/mcp', {
      method: 'POST',
      headers: { host: 'localhost:9000' },
    });
    expect(allowed.status).toBe(200);
    const denied = await server.app.request('/mcp', {
      method: 'POST',
      headers: { host: 'evil.example' },
    });
    expect(denied.status).toBe(403);
    await handle.close();
  });
});

describe('Host listener upgrade seam', () => {
  const openSockets: WebSocket[] = [];

  afterEach(() => {
    for (const ws of openSockets.splice(0)) ws.terminate();
  });

  /** Resolve on a real open; reject with the HTTP status when refused. */
  const openSocket = (url: string): Promise<WebSocket> => {
    const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
    const ws = new WebSocket(url);
    ws.once('open', () => {
      openSockets.push(ws);
      resolve(ws);
    });
    ws.once('error', (error) => reject(error));
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      ws.terminate();
      reject(new Error(`upgrade rejected with HTTP ${response.statusCode}`));
    });
    return promise;
  };

  it('wires raw upgrades through the configured seam', async () => {
    const wss = new WebSocketServer({ noServer: true });
    let handled = 0;
    const { listener, handle } = await startTracked({
      upgrade: {
        handle: (request, socket, head) => {
          handled += 1;
          wss.handleUpgrade(request, socket, head, () => undefined);
        },
        close: async () => {
          for (const client of wss.clients) client.terminate();
          const { promise, resolve } = Promise.withResolvers<void>();
          wss.close(() => resolve());
          await promise;
        },
      },
    });
    const ws = await openSocket(`ws://127.0.0.1:${handle.port}/yjs?session=s`);
    expect(handled).toBe(1);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    await handle.close();
    expect(listener.status().running).toBe(false);
  });

  it('reopens the upgrade seam on every start cycle', async () => {
    const events: string[] = [];
    let wss: WebSocketServer | null = null;
    const { listener, handle: first } = await startTracked({
      upgrade: {
        open: () => {
          events.push('open');
          wss = new WebSocketServer({ noServer: true });
        },
        handle: (request, socket, head) => {
          if (wss === null) throw new Error('seam is not open');
          wss.handleUpgrade(request, socket, head, () => undefined);
        },
        close: async () => {
          events.push('close');
          if (wss === null) return;
          for (const client of wss.clients) client.terminate();
          const { promise, resolve } = Promise.withResolvers<void>();
          wss.close(() => resolve());
          await promise;
          wss = null;
        },
      },
    });
    expect(events).toEqual(['open']);
    const ws1 = await openSocket(`ws://127.0.0.1:${first.port}/yjs?session=s`);
    expect(ws1.readyState).toBe(WebSocket.OPEN);
    await first.close();
    expect(events).toEqual(['open', 'close']);
    expect(listener.status().running).toBe(false);

    // The listener rebuilds the surface on the next start: the seam accepts a
    // fresh upgrade instead of staying permanently closed after close().
    const second = await listener.start();
    expect(events).toEqual(['open', 'close', 'open']);
    const ws2 = await openSocket(`ws://127.0.0.1:${second.port}/yjs?session=s`);
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    await second.close();
    expect(events).toEqual(['open', 'close', 'open', 'close']);
  });

  it('closes upgraded resources before the HTTP server stops', async () => {
    const order: string[] = [];
    const wss = new WebSocketServer({ noServer: true });
    const { listener, handle } = await startTracked({
      upgrade: {
        handle: (request, socket, head) => {
          wss.handleUpgrade(request, socket, head, (ws) => {
            ws.on('close', () => order.push('socket-closed'));
          });
        },
        close: async () => {
          for (const client of wss.clients) client.terminate();
          const { promise, resolve } = Promise.withResolvers<void>();
          wss.close(() => resolve());
          await promise;
          order.push('seam-closed');
        },
      },
    });
    const ws = await openSocket(`ws://127.0.0.1:${handle.port}/yjs?session=s`);
    const { promise: clientClosed, resolve: resolveClosed } = Promise.withResolvers<void>();
    ws.once('close', () => resolveClosed());
    await handle.close();
    await clientClosed;
    // The upgraded socket and the seam closed before the HTTP server stopped.
    expect(order).toEqual(['socket-closed', 'seam-closed']);
    expect(listener.status().running).toBe(false);
  });

  it('destroys the socket when the seam handler throws', async () => {
    const { listener, handle } = await startTracked({
      upgrade: {
        handle: () => {
          throw new Error('boom');
        },
        close: async () => undefined,
      },
    });
    await expect(openSocket(`ws://127.0.0.1:${handle.port}/yjs?session=s`)).rejects.toThrow();
    await handle.close();
    expect(listener.status().running).toBe(false);
  });

  it('closes upgrade sockets when no seam is configured (fail closed)', async () => {
    const { listener, handle } = await startTracked();
    await expect(openSocket(`ws://127.0.0.1:${handle.port}/yjs?session=s`)).rejects.toThrow();
    await handle.close();
    expect(listener.status().running).toBe(false);
  });

  it('rejects an upgrade seam without handle/close functions', () => {
    expect(() => createHostListener({ upgrade: {} as HostUpgradeListener })).toThrow(
      HostListenerConfigError,
    );
  });

  it('rejects an upgrade seam whose open hook is not a function', () => {
    expect(() =>
      createHostListener({
        upgrade: {
          handle: () => undefined,
          close: async () => undefined,
          open: 'not-a-function' as never,
        },
      }),
    ).toThrow(HostListenerConfigError);
  });
});

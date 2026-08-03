import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RawData, WebSocket } from 'ws';
import * as Y from 'yjs';
import type { WorkingDocumentState } from '../src/contracts/persistence.js';
import type { ProjectSessionRegistry } from '../src/host/project-session.js';
import {
  createHostServer,
  encodeYjsMessageUpdate,
  encodeYjsSyncStep1,
  encodeYjsSyncStep2,
  HOST_YJS_UPGRADE_PATH,
  type HostServer,
  parseYjsSyncFrame,
  type YjsAuthPort,
  type YjsDenialReason,
  type YjsGateway,
  type YjsPersistencePort,
  type YjsSyncFrame,
} from '../src/host/server.js';
import {
  createYjsTicketService,
  type YjsTicketService,
} from '../src/host/yjs/index.js';
type YjsAuthRequest = Parameters<YjsAuthPort['resolve']>[0];

const USER_ID = 'user-1';

const closers: Array<() => Promise<void>> = [];
const trackClose = (close: () => Promise<void>): void => {
  closers.push(close);
};

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

// ─── Test doubles ────────────────────────────────────────────────────────────

const stateKey = (projectId: string, documentId: string): string =>
  `${projectId}\u0000${documentId}`;
/** Resolve one ticket exactly once, retaining only its opaque binding lifecycle. */
function ticketAuth(tickets: YjsTicketService, allowedProject?: string): YjsAuthPort {
  return {
    async resolve(request: YjsAuthRequest) {
      if ('ticket' in request) {
        const binding = tickets.consume(request.ticket);
        if (binding === null) return { ok: false, reason: 'UNAUTHENTICATED' };
        if (
          (allowedProject !== undefined && request.projectId !== allowedProject) ||
          binding.projectId !== request.projectId
        ) {
          tickets.release(binding.bindingId);
          return { ok: false, reason: 'PROJECT_MISMATCH' };
        }
        if (binding.documentId !== request.documentId) {
          tickets.release(binding.bindingId);
          return { ok: false, reason: 'INVALID_DOCUMENT' };
        }
        return {
          ok: true,
          scope: {
            bindingId: binding.bindingId,
            userId: binding.userId,
            capabilityVersion: binding.capabilityVersion,
            projectId: binding.projectId,
            documentId: binding.documentId,
          },
        };
      }
      const binding = tickets.get(request.bindingId);
      if (
        binding === null ||
        binding.userId !== request.userId ||
        binding.capabilityVersion !== request.capabilityVersion ||
        binding.projectId !== request.projectId ||
        binding.documentId !== request.documentId
      ) {
        return { ok: false, reason: 'UNAUTHENTICATED' };
      }
      return { ok: true, scope: request };
    },
    release(scope): void {
      tickets.release(scope.bindingId);
    },
  };
}

/** Always-accepting auth port backed by the fixture's one-time ticket store. */
function allowAllAuth(tickets: YjsTicketService): YjsAuthPort {
  return ticketAuth(tickets);
}

/** Accept only one project; anything else is a project mismatch. */
function projectScopedAuth(allowedProject: string, tickets: YjsTicketService): YjsAuthPort {
  return ticketAuth(tickets, allowedProject);
}

function denyingAuth(reason: YjsDenialReason): YjsAuthPort {
  return {
    async resolve() {
      return { ok: false, reason };
    },
  };
}

function fakePersistence(): YjsPersistencePort & { states: Map<string, WorkingDocumentState> } {
  const states = new Map<string, WorkingDocumentState>();
  return {
    states,
    async loadWorkingDocument(key) {
      return states.get(stateKey(key.projectId, key.documentId)) ?? null;
    },
    async persistYjsUpdate(input) {
      const state: WorkingDocumentState = {
        key: { projectId: input.projectId, documentId: input.documentId },
        stateVector: input.stateVector ?? new Uint8Array(0),
        update: input.update,
        updatedAt: '2026-08-02T00:00:00.000Z',
      };
      states.set(stateKey(input.projectId, input.documentId), state);
      return state;
    },
  };
}

interface ServerFixture {
  readonly server: HostServer;
  readonly gateway: YjsGateway;
  readonly persistence: YjsPersistencePort & { states: Map<string, WorkingDocumentState> };
  readonly tickets: YjsTicketService;
  readonly port: number;
  readonly close: () => Promise<void>;
}

async function createFixture(
  options: {
    auth?: YjsAuthPort | ((tickets: YjsTicketService) => YjsAuthPort);
    persistence?: YjsPersistencePort;
  } = {},
): Promise<ServerFixture> {
  const persistence = (options.persistence ?? fakePersistence()) as YjsPersistencePort & {
    states: Map<string, WorkingDocumentState>;
  };
  const tickets = createYjsTicketService();
  const auth =
    typeof options.auth === 'function'
      ? options.auth(tickets)
      : (options.auth ?? allowAllAuth(tickets));
  const server = createHostServer({
    port: 0,
    yjs: {
      persistence,
      sessions: { size: 0, get: () => null } as unknown as ProjectSessionRegistry,
      auth,
    },
  });
  const handle = await server.start();
  if (handle.port === null) throw new Error('listener did not bind a TCP port');
  return {
    server,
    gateway: requireYjsGateway(server),
    persistence,
    tickets,
    port: handle.port,
    close: () => server.close(),
  };
}
function requireYjsGateway(server: HostServer): YjsGateway {
  const gateway = server.yjs;
  if (gateway === null) throw new Error('Yjs gateway is not configured');
  return gateway;
}

function requireStoredState(state: WorkingDocumentState | undefined): WorkingDocumentState {
  if (state === undefined) throw new Error('persisted Yjs state is missing');
  return state;
}

function requireSyncFrame(frame: Uint8Array): YjsSyncFrame {
  const parsed = parseYjsSyncFrame(frame);
  if (parsed === null) throw new Error('expected a Yjs sync frame');
  return parsed;
}

// ─── Wire helpers (client side of the same y-protocols framing) ──────────────

function upgradeUrl(port: number, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return `ws://127.0.0.1:${port}${HOST_YJS_UPGRADE_PATH}?${query}`;
}

function ticketUrl(
  fixture: ServerFixture,
  projectId: string,
  documentId: string,
): string {
  const ticket = fixture.tickets.mint({
    sessionId: 'session-1',
    userId: USER_ID,
    capabilityVersion: 1,
    projectId,
    documentId,
  });
  return upgradeUrl(fixture.port, { ticket, project: projectId, document: documentId });
}

function toUint8Array(data: RawData): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return Buffer.concat(data);
}

/**
 * Client harness over one real WebSocket. Sync frames are buffered from
 * construction: the Host pushes the hydrated state immediately after the
 * handshake, and with the ws client that frame can be delivered in the same
 * tick as `open`, so a listener attached only after `open` would miss it.
 * The short timeout guards are a deliberate exception to fake timers: only
 * the OS-level socket event loop can drive the handshake.
 */
class SocketClient {
  readonly ws: WebSocket;
  readonly opened: Promise<void>;
  private readonly pending: Uint8Array[] = [];
  private readonly waiters: Array<(frame: Uint8Array) => void> = [];

  constructor(url: string) {
    const ws = new WebSocket(url);
    this.ws = ws;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.opened = promise;
    ws.once('open', () => resolve());
    ws.once('error', (error) => reject(error));
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      ws.terminate();
      reject(new Error(`upgrade rejected with HTTP ${response.statusCode}`));
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const frame = toUint8Array(data);
      if (parseYjsSyncFrame(frame) === null) return; // awareness frames: ignored.
      const waiter = this.waiters.shift();
      if (waiter !== undefined) waiter(frame);
      else this.pending.push(frame);
    });
  }

  /** Resolve once the upgrade is accepted; reject with the refusal status. */
  async open(): Promise<void> {
    await this.opened;
  }

  /** Send one binary frame. */
  send(frame: Uint8Array): void {
    this.ws.send(frame);
  }

  /** Resolve on the next buffered/arriving sync frame. */
  nextSync(timeoutMs = 3000): Promise<Uint8Array> {
    const buffered = this.pending.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    const { promise, resolve, reject } = Promise.withResolvers<Uint8Array>();
    let timer: NodeJS.Timeout | undefined;
    const onFrame = (frame: Uint8Array): void => {
      clearTimeout(timer);
      resolve(frame);
    };
    timer = setTimeout(() => {
      // A timed-out waiter must not consume a later frame: remove it so the
      // next frame is buffered for the next consumer instead.
      const index = this.waiters.indexOf(onFrame);
      if (index !== -1) this.waiters.splice(index, 1);
      reject(new Error('timed out waiting for a yjs sync frame'));
    }, timeoutMs);
    this.waiters.push(onFrame);
    return promise;
  }

  /** Graceful close; resolves when the socket is fully closed. */
  async close(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.ws.once('close', () => resolve());
    this.ws.close();
    await promise;
  }

  /** Fire when the server terminates this socket (e.g. Host close). */
  onClose(callback: () => void): void {
    this.ws.once('close', callback);
  }
}

/** Decode the `prose` text out of a sync step 2 frame. */
function textOf(frame: Uint8Array): string {
  const parsed = requireSyncFrame(frame);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, parsed.payload);
  return doc.getText('prose').toString();
}

/** Decode the `prose` text out of a raw Yjs update (no wire envelope). */
function textOfUpdate(update: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc.getText('prose').toString();
}

/** Full-state Yjs update writing `text` into the `prose` text type. */
function updateWithText(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('prose').insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

// ─── Integration tests ────────────────────────────────────────────────────────

describe('Host Yjs WebSocket upgrade integration', () => {
  it('authenticates, accepts a real loopback connection, and exchanges updates', async () => {
    const fixture = await createFixture();
    trackClose(() => fixture.close());
    const client = new SocketClient(
      ticketUrl(fixture, 'project-a', 'definitions/characters.yaml'),
    );
    await client.open();
    try {
      // A fresh document has no persisted state; the client initiates sync.
      client.send(encodeYjsSyncStep2(updateWithText('hello')));
      const ack = await client.nextSync();
      expect(textOf(ack)).toBe('hello');
      // The accepted update was persisted through the gateway.
      const stored = requireStoredState(
        fixture.persistence.states.get(stateKey('project-a', 'definitions/characters.yaml')),
      );
      expect(textOfUpdate(stored.update)).toBe('hello');
      // A sync step 1 request answers with the authoritative state.
      client.send(encodeYjsSyncStep1(new Uint8Array(0)));
      const reply = await client.nextSync();
      expect(textOf(reply)).toBe('hello');
    } finally {
      await client.close();
      await vi.waitFor(() => expect(fixture.gateway.size).toBe(0));
    }
    await fixture.close();
  });

  it('consumes one-time tickets and releases their connection lifecycle', async () => {
    const fixture = await createFixture();
    trackClose(() => fixture.close());
    const ticket = fixture.tickets.mint({
      sessionId: 'session-1',
      userId: USER_ID,
      capabilityVersion: 1,
      projectId: 'project-a',
      documentId: 'definitions/characters.yaml',
    });
    const url = upgradeUrl(fixture.port, {
      ticket,
      project: 'project-a',
      document: 'definitions/characters.yaml',
    });
    const first = new SocketClient(url);
    await first.open();
    await first.close();
    await vi.waitFor(() => expect(fixture.gateway.size).toBe(0));
    const replay = new SocketClient(url);
    await expect(replay.open()).rejects.toThrow('upgrade rejected with HTTP 401');
    await fixture.close();
  });

  it('reconnects into the persisted state', async () => {

    const fixture = await createFixture();
    trackClose(() => fixture.close());
    const url = (): string => ticketUrl(fixture, 'project-a', 'definitions/characters.yaml');
    const first = new SocketClient(url());
    await first.open();
    first.send(encodeYjsSyncStep2(updateWithText('hello')));
    await first.nextSync();
    await first.close();
    await vi.waitFor(() => expect(fixture.gateway.size).toBe(0));

    const second = new SocketClient(url());
    await second.open();
    try {
      // The hydrated persisted state is pushed immediately on connect and
      // captured by the harness before any consumer attaches.
      const initial = await second.nextSync();
      expect(textOf(initial)).toBe('hello');
    } finally {
      await second.close();
    }
    await fixture.close();
  });

  it('broadcasts an accepted update to live peers on the exact same document', async () => {
    const fixture = await createFixture();
    trackClose(() => fixture.close());
    const url = (documentId: string): string => ticketUrl(fixture, 'project-a', documentId);
    // Alice and Bob share one document; Carol is on a different document of
    // the same project and must never hear the shared document's updates.
    const alice = new SocketClient(url('definitions/characters.yaml'));
    const bob = new SocketClient(url('definitions/characters.yaml'));
    const carol = new SocketClient(url('definitions/places.yaml'));
    await alice.open();
    await bob.open();
    await carol.open();
    try {
      // Alice's update is acknowledged exactly once and persisted canonically.
      alice.send(encodeYjsSyncStep2(updateWithText('hello')));
      const ack = await alice.nextSync();
      expect(textOf(ack)).toBe('hello');
      const stored = requireStoredState(
        fixture.persistence.states.get(stateKey('project-a', 'definitions/characters.yaml')),
      );
      expect(textOfUpdate(stored.update)).toBe('hello');

      // Bob is still connected (no reconnect) and receives the exact
      // persisted canonical state, byte for byte.
      const broadcast = await bob.nextSync();
      expect(textOf(broadcast)).toBe('hello');

      // The initiating socket receives no duplicate of its own update, and
      // Carol's different document hears nothing.
      await expect(alice.nextSync(150)).rejects.toThrow('timed out waiting for a yjs sync frame');
      await expect(carol.nextSync(150)).rejects.toThrow('timed out waiting for a yjs sync frame');

      // A closed peer is removed from the broadcast set: the next update
      // still applies and acknowledges cleanly, and Carol still hears
      // nothing. Alice's client builds on the canonical state she already
      // holds (a realistic append, not a conflicting fresh full state), so
      // the merge is deterministic: 'hello' + ' two'.
      await bob.close();
      const advanced = new Y.Doc();
      Y.applyUpdate(advanced, stored.update);
      const prose = advanced.getText('prose');
      prose.insert(prose.length, ' two');
      alice.send(encodeYjsSyncStep2(Y.encodeStateAsUpdate(advanced)));
      const secondAck = await alice.nextSync();
      expect(textOf(secondAck)).toBe('hello two');
      const secondStored = requireStoredState(
        fixture.persistence.states.get(stateKey('project-a', 'definitions/characters.yaml')),
      );
      expect(textOfUpdate(secondStored.update)).toBe('hello two');
      await expect(alice.nextSync(150)).rejects.toThrow('timed out waiting for a yjs sync frame');
      await expect(carol.nextSync(150)).rejects.toThrow('timed out waiting for a yjs sync frame');
    } finally {
      const live = [alice, bob, carol].filter((client) => client.ws.readyState === WebSocket.OPEN);
      await Promise.all(live.map((client) => client.close()));
      await vi.waitFor(() => expect(fixture.gateway.size).toBe(0));
    }
    await fixture.close();
  });
  it('accepts standard messageYjsUpdate frames (sync subtype 2) through the canonical path', async () => {
    const fixture = await createFixture();
    trackClose(() => fixture.close());
    const url = (documentId: string): string => ticketUrl(fixture, 'project-a', documentId);
    // Alice and Bob share one document; Carol is on a different document and
    // must never hear the shared document's updates.
    const alice = new SocketClient(url('definitions/characters.yaml'));
    const bob = new SocketClient(url('definitions/characters.yaml'));
    const carol = new SocketClient(url('definitions/places.yaml'));
    await alice.open();
    await bob.open();
    await carol.open();
    try {
      // The frame is a genuine y-protocols messageYjsUpdate: messageSync=0,
      // sync subtype 2 — a distinct envelope from the step-2 frames the other
      // tests exercise.
      const update = updateWithText('hello');
      const frame = encodeYjsMessageUpdate(update);
      expect(Array.from(frame)).toEqual([0, 2, update.byteLength, ...Array.from(update)]);
      alice.send(frame);
      const ack = await alice.nextSync();
      expect(textOf(ack)).toBe('hello');
      const stored = requireStoredState(
        fixture.persistence.states.get(stateKey('project-a', 'definitions/characters.yaml')),
      );
      expect(textOfUpdate(stored.update)).toBe('hello');
      // The exact-scope peer receives the canonical persisted state, byte for
      // byte; the sender hears no echo and Carol's other document hears
      // nothing.
      const broadcast = await bob.nextSync();
      expect(Array.from(broadcast)).toEqual(Array.from(encodeYjsSyncStep2(stored.update)));
      expect(textOf(broadcast)).toBe('hello');
      await expect(alice.nextSync(150)).rejects.toThrow('timed out waiting for a yjs sync frame');
      await expect(carol.nextSync(150)).rejects.toThrow('timed out waiting for a yjs sync frame');
    } finally {
      const live = [alice, bob, carol].filter((client) => client.ws.readyState === WebSocket.OPEN);
      await Promise.all(live.map((client) => client.close()));
      await vi.waitFor(() => expect(fixture.gateway.size).toBe(0));
    }
    await fixture.close();
  });

  it('reopens the Yjs surface after close so a later start accepts exactly one authenticated upgrade', async () => {
    const persistence = fakePersistence();
    const tickets = createYjsTicketService();
    const server = createHostServer({
      port: 0,
      yjs: {
        persistence,
        sessions: { size: 0, get: () => null } as unknown as ProjectSessionRegistry,
        auth: allowAllAuth(tickets),
      },
    });
    trackClose(() => server.close());
    const url = (port: number): string => {
      const ticket = tickets.mint({
        sessionId: 'session-1',
        userId: USER_ID,
        capabilityVersion: 1,
        projectId: 'project-a',
        documentId: 'definitions/characters.yaml',
      });
      return upgradeUrl(port, {
        ticket,
        project: 'project-a',
        document: 'definitions/characters.yaml',
      });
    };

    const firstHandle = await server.start();
    if (firstHandle.port === null) throw new Error('listener did not bind a TCP port');
    const first = new SocketClient(url(firstHandle.port));
    await first.open();
    first.send(encodeYjsSyncStep2(updateWithText('one')));
    const firstAck = await first.nextSync();
    expect(textOf(firstAck)).toBe('one');
    await first.close();
    await vi.waitFor(() => expect(requireYjsGateway(server).size).toBe(0));
    await server.close();
    expect(server.status().running).toBe(false);

    // A fresh start rebuilds the Yjs surface exactly once: the listener
    // reopens the upgrade seam before wiring, so the second cycle hydrates
    // the persisted state and accepts a new authenticated upgrade with no
    // stale handler or socket from the first cycle.
    const secondHandle = await server.start();
    if (secondHandle.port === null) throw new Error('listener did not bind a TCP port');
    const second = new SocketClient(url(secondHandle.port));
    await second.open();
    try {
      const initial = await second.nextSync();
      expect(textOf(initial)).toBe('one');
      // Append to the canonical persisted state so the merge is deterministic.
      const stored = requireStoredState(
        persistence.states.get(stateKey('project-a', 'definitions/characters.yaml')),
      );
      const advanced = new Y.Doc();
      Y.applyUpdate(advanced, stored.update);
      const prose = advanced.getText('prose');
      prose.insert(prose.length, ' two');
      second.send(encodeYjsSyncStep2(Y.encodeStateAsUpdate(advanced)));
      const ack = await second.nextSync();
      expect(textOf(ack)).toBe('one two');
      const secondStored = requireStoredState(
        persistence.states.get(stateKey('project-a', 'definitions/characters.yaml')),
      );
      expect(textOfUpdate(secondStored.update)).toBe('one two');
    } finally {
      await second.close();
      await vi.waitFor(() => expect(requireYjsGateway(server).size).toBe(0));
    }
    await server.close();
  });

  it('rejects unauthenticated upgrades before any socket is upgraded', async () => {
    const fixture = await createFixture({ auth: denyingAuth('UNAUTHENTICATED') });
    trackClose(() => fixture.close());
    const client = new SocketClient(
      upgradeUrl(fixture.port, {
        ticket: 'unknown-ticket',
        project: 'project-a',
        document: 'definitions/characters.yaml',
      }),
    );
    await expect(client.open()).rejects.toThrow('upgrade rejected with HTTP 401');
    expect(fixture.gateway.size).toBe(0);
    await fixture.close();
  });

  it('rejects upgrades for a project the ticket cannot access', async () => {
    const fixture = await createFixture({
      auth: (tickets) => projectScopedAuth('project-a', tickets),
    });
    trackClose(() => fixture.close());
    const ticket = fixture.tickets.mint({
      sessionId: 'session-1',
      userId: USER_ID,
      capabilityVersion: 1,
      projectId: 'project-a',
      documentId: 'definitions/characters.yaml',
    });
    const client = new SocketClient(
      upgradeUrl(fixture.port, {
        ticket,
        project: 'project-b',
        document: 'definitions/characters.yaml',
      }),
    );
    await expect(client.open()).rejects.toThrow('upgrade rejected with HTTP 403');
    expect(fixture.gateway.size).toBe(0);
    await fixture.close();
  });

  it('rejects malformed scope and unknown upgrade paths', async () => {
    const fixture = await createFixture();
    trackClose(() => fixture.close());
    const missingTicket = new SocketClient(
      upgradeUrl(fixture.port, {
        project: 'project-a',
        document: 'definitions/characters.yaml',
      }),
    );
    await expect(missingTicket.open()).rejects.toThrow('upgrade rejected with HTTP 401');
    const missingDocument = new SocketClient(
      upgradeUrl(fixture.port, { ticket: 'malformed-ticket', project: 'project-a' }),
    );
    await expect(missingDocument.open()).rejects.toThrow('upgrade rejected with HTTP 400');
    const wrongPath = new SocketClient(
      `ws://127.0.0.1:${fixture.port}/other?ticket=malformed&project=p&document=d`,
    );
    await expect(wrongPath.open()).rejects.toThrow('upgrade rejected with HTTP 404');
    expect(fixture.gateway.size).toBe(0);
    await fixture.close();
  });
  it('closes every socket and the ws server when the Host closes', async () => {
    const fixture = await createFixture();
    trackClose(() => fixture.close());
    const client = new SocketClient(
      ticketUrl(fixture, 'project-a', 'definitions/characters.yaml'),
    );
    await client.open();
    const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
    client.onClose(resolveClosed);
    await fixture.close();
    await closed;
    expect(fixture.gateway.size).toBe(0);
    expect(fixture.server.status().running).toBe(false);
  });


  it('speaks the exact y-websocket wire format', () => {
    const update = updateWithText('wire');
    const frame = encodeYjsSyncStep2(update);
    // [messageSync=0][syncStep2=1][varuint length][update bytes]
    const header = [0, 1, update.byteLength];
    expect(Array.from(frame)).toEqual([...header, ...Array.from(update)]);
    expect(parseYjsSyncFrame(frame)).toEqual({ syncType: 1, payload: update });
    // messageYjsUpdate is the standard y-protocols subtype-2 envelope,
    // distinct from step 2, and carries the same raw update payload.
    const updateFrame = encodeYjsMessageUpdate(update);
    expect(Array.from(updateFrame)).toEqual([0, 2, update.byteLength, ...Array.from(update)]);
    expect(parseYjsSyncFrame(updateFrame)).toEqual({ syncType: 2, payload: update });
    // Awareness frames are gateway-owned and ignored by the sync layer.
    expect(parseYjsSyncFrame(Uint8Array.of(1, 0, 0))).toBeNull();
    expect(Array.from(encodeYjsSyncStep1(new Uint8Array(0)))).toEqual([0, 0, 0]);
  });
});

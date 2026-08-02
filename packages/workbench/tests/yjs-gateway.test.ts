import type {
  CoreExecutionRepository,
  CoreRuntimeServices,
  LLMProvider,
  ProjectCompilation,
  ProjectSourceSnapshotV1,
  RenderCacheRepository,
  StateLogRepository,
  StateSnapshotRepository,
} from '@novalistically/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { SessionState, WorkingDocumentState } from '../src/contracts/persistence.js';
import type {
  AgentCapabilityCheckResult,
  AgentCapabilityService,
} from '../src/host/agent/index.js';
import { createProjectCoreRuntime } from '../src/host/core-runtime.js';
import {
  createProjectSessionRegistry,
  type ProjectionDerivationInput,
  type ProjectSession,
  type ProjectSessionProjectionV1,
  type SessionAuditRecord,
  type SessionAuditSink,
} from '../src/host/project-session.js';
import {
  createSessionAuthPort,
  createYjsGateway,
  createYjsPersistencePort,
  type YjsAuthPort,
  type YjsConnectionRequest,
  type YjsConnectionScope,
  type YjsDenialReason,
  type YjsGateway,
  type YjsPersistencePort,
  type YjsScopeResolution,
} from '../src/host/yjs/index.js';
import type { PersistenceWorkerClient } from '../src/persistence/worker-client.js';

const FIXED_NOW = '2026-08-02T00:00:00.000Z';
const USER_ID = 'user-1';
const SESSION_ID = 'session-1';
const PROJECT_ID = 'project-a';
const DOCUMENT_ID = 'definitions/characters.yaml';
const SOURCE_HASH = 'hash-1';

// ─── Test doubles ────────────────────────────────────────────────────────────

function fakeServices(options: { now?: () => string } = {}): CoreRuntimeServices {
  let sequence = 0;
  return {
    execution: {} as CoreExecutionRepository,
    renderCache: {} as RenderCacheRepository,
    stateLog: {} as StateLogRepository,
    stateSnapshots: {} as StateSnapshotRepository,
    promptTemplates: {
      async get() {
        return null;
      },
    },
    clock: { now: () => options.now?.() ?? FIXED_NOW },
    ids: { next: (input) => `${input?.kind ?? 'id'}-${++sequence}` },
    llm: {} as LLMProvider,
  };
}

function makeSnapshot(sourceHash: string): ProjectSourceSnapshotV1 {
  return {
    version: 1,
    sourceHash,
    documents: [
      {
        version: 1 as const,
        logicalPath: DOCUMENT_ID,
        content: 'key: value',
        contentHash: 'content-1',
        parseResult: { status: 'parsed' as const, value: { key: 'value' } },
        diagnostics: [],
      },
    ],
  };
}

function testDerive(input: ProjectionDerivationInput): ProjectSessionProjectionV1 {
  return {
    version: 1,
    projectId: input.projectId,
    revision: input.revision,
    sourceHash: input.snapshot?.sourceHash ?? null,
    documents: input.snapshot?.documents.length ?? 0,
    events: input.snapshot?.documents.length ?? 0,
    rendered: 0,
    pending: 0,
    blocked: 0,
    errorCount: 0,
    warningCount: 0,
    diagnostics: [],
    presence: input.presence,
    generatedAt: input.generatedAt,
  };
}

function allowedVerdict(
  userId: string,
  projectId: string,
  scopes: readonly string[],
  version = 1,
  expiresAt = '2099-01-01T00:00:00.000Z',
): AgentCapabilityCheckResult {
  return {
    allowed: true,
    grant: { capabilityId: 'cap-1', userId, projectId, scopes, version, expiresAt },
  };
}

function fakeCapabilities(
  verdict: AgentCapabilityCheckResult,
): Pick<AgentCapabilityService, 'checkGrant'> {
  return { checkGrant: async () => verdict };
}

function recordingAudit(): { sink: SessionAuditSink; records: SessionAuditRecord[] } {
  const records: SessionAuditRecord[] = [];
  return { sink: { record: (record) => void records.push(record) }, records };
}

function createSessionFixture(
  projectId: string,
  sourceHash: string,
): { session: ProjectSession; registry: ReturnType<typeof createProjectSessionRegistry> } {
  const audit = recordingAudit();
  const registry = createProjectSessionRegistry();
  const session = registry.create({
    projectId,
    runtime: createProjectCoreRuntime({
      projectId,
      services: fakeServices(),
      compile: (snapshot) =>
        ({ events: snapshot.documents.length }) as unknown as ProjectCompilation,
    }),
    capabilities: fakeCapabilities(allowedVerdict(USER_ID, projectId, ['scene:edit'])),
    audit: audit.sink,
    initialSource: makeSnapshot(sourceHash),
    derive: testDerive,
    now: () => FIXED_NOW,
  });
  return { session, registry };
}

/** Always-allowing auth port; the resolved actor is a fixed user. */
function allowAuth(): YjsAuthPort {
  return {
    async resolve(request: YjsConnectionRequest): Promise<YjsScopeResolution> {
      return {
        ok: true,
        scope: {
          sessionId: request.sessionId,
          userId: USER_ID,
          projectId: request.projectId,
          documentId: request.documentId,
        },
      };
    },
  };
}

function fakePersistence(initial: WorkingDocumentState[] = []) {
  const stored = new Map<string, WorkingDocumentState>();
  for (const state of initial) {
    stored.set(stateKey(state.key.projectId, state.key.documentId), state);
  }
  const calls: { operation: 'load' | 'persist'; key: string }[] = [];
  const port: YjsPersistencePort = {
    async loadWorkingDocument(key) {
      calls.push({ operation: 'load', key: stateKey(key.projectId, key.documentId) });
      return stored.get(stateKey(key.projectId, key.documentId)) ?? null;
    },
    async persistYjsUpdate(input) {
      calls.push({ operation: 'persist', key: stateKey(input.projectId, input.documentId) });
      const state: WorkingDocumentState = {
        key: { projectId: input.projectId, documentId: input.documentId },
        stateVector: input.stateVector ?? new Uint8Array(),
        update: input.update,
        updatedAt: FIXED_NOW,
      };
      stored.set(stateKey(input.projectId, input.documentId), state);
      return state;
    },
  };
  return { port, stored, calls };
}

function requireStored(
  stored: Map<string, WorkingDocumentState>,
  key: string,
): WorkingDocumentState {
  const state = stored.get(key);
  if (!state) throw new Error(`Expected stored working document state for ${key}`);
  return state;
}

function requireInitialState(state: WorkingDocumentState | null): WorkingDocumentState {
  if (!state) throw new Error('Expected hydrated working document state');
  return state;
}

function stateKey(projectId: string, documentId: string): string {
  return `${projectId}:${documentId}`;
}

interface GatewayFixture {
  gateway: YjsGateway;
  session: ProjectSession;
  persistence: ReturnType<typeof fakePersistence>;
}

function createGatewayFixture(
  options: { auth?: YjsAuthPort; persistence?: YjsPersistencePort } = {},
): GatewayFixture {
  const { session, registry } = createSessionFixture(PROJECT_ID, SOURCE_HASH);
  const persistence = fakePersistence();
  const gateway = createYjsGateway({
    auth: options.auth ?? allowAuth(),
    persistence: options.persistence ?? persistence.port,
    sessions: registry,
    now: () => FIXED_NOW,
  });
  return { gateway, session, persistence };
}

function request(overrides: Partial<YjsConnectionRequest> = {}): YjsConnectionRequest {
  return {
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    documentId: DOCUMENT_ID,
    ...overrides,
  };
}

/** Manual-resolution promise gate for deterministic delayed-operation tests. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred promise resolved before initialization');
  };
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Full-state Yjs update containing `text` in the `prose` text type. */
function workingUpdate(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('prose').insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

/** Delta update appending `text` to a document reconstructed from `base`. */
function deltaUpdate(base: Uint8Array, text: string): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, base);
  doc.getText('prose').insert(doc.getText('prose').length, text);
  return Y.encodeStateAsUpdate(doc);
}

/**
 * Full-state update from a fresh doc with an explicit client id, seeded with
 * `base`. The fixed client id makes the concurrent-merge test deterministic.
 */
function concurrentUpdate(
  base: Uint8Array,
  clientID: number,
  apply: (text: Y.Text) => void,
): Uint8Array {
  const doc = new Y.Doc({ clientID });
  Y.applyUpdate(doc, base);
  apply(doc.getText('prose'));
  return Y.encodeStateAsUpdate(doc);
}

function textOf(update: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc.getText('prose').toString();
}

function yjsPresenceOf(session: ProjectSession): ProjectSessionProjectionV1['presence'] {
  return session.projection.presence.filter((entry) => entry.surface === 'yjs');
}

// ─── Auth scope ──────────────────────────────────────────────────────────────

describe('Yjs gateway auth scope', () => {
  it.each<[string, 'UNAUTHENTICATED' | 'EXPIRED' | 'PROJECT_MISMATCH' | 'INVALID_DOCUMENT']>([
    ['unauthenticated (unknown or revoked session)', 'UNAUTHENTICATED'],
    ['expired session', 'EXPIRED'],
    ['wrong-project request', 'PROJECT_MISMATCH'],
    ['invalid document request', 'INVALID_DOCUMENT'],
  ])('rejects a %s before any persistence or presence', async (_label, reason) => {
    const { gateway, session, persistence } = createGatewayFixture({
      auth: {
        async resolve() {
          return { ok: false, reason };
        },
      },
    });
    const result = await gateway.connect(request());
    expect(result).toEqual({ ok: false, reason });
    expect(persistence.calls).toEqual([]);
    expect(yjsPresenceOf(session)).toEqual([]);
    expect(gateway.size).toBe(0);
  });

  it('binds the exact server-resolved scope and joins Yjs presence', async () => {
    const { gateway, session } = createGatewayFixture();
    const result = await gateway.connect(request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connection.scope).toEqual({
      sessionId: SESSION_ID,
      userId: USER_ID,
      projectId: PROJECT_ID,
      documentId: DOCUMENT_ID,
    });
    expect(result.initialState).toBeNull();
    expect(yjsPresenceOf(session)).toEqual([
      { actorId: USER_ID, surface: 'yjs', since: FIXED_NOW },
    ]);
    expect(gateway.size).toBe(1);
    // The accepted projection itself is untouched by a bind.
    expect(session.source?.sourceHash).toBe(SOURCE_HASH);
    expect(session.projection.sourceHash).toBe(SOURCE_HASH);
  });
});

// ─── createSessionAuthPort ───────────────────────────────────────────────────

describe('createSessionAuthPort', () => {
  function sessionStore(rows: Map<string, SessionState>) {
    return { getSession: async (sessionId: string) => rows.get(sessionId) ?? null };
  }

  function liveSession(overrides: Partial<SessionState> = {}): SessionState {
    return {
      sessionId: SESSION_ID,
      userId: USER_ID,
      expiresAt: '2099-01-01T00:00:00.000Z',
      capabilityVersion: 1,
      ...overrides,
    };
  }

  it('maps an unknown or revoked session to UNAUTHENTICATED', async () => {
    const rows = new Map<string, SessionState>([[SESSION_ID, liveSession()]]);
    const port = createSessionAuthPort({
      sessions: sessionStore(rows),
      now: () => FIXED_NOW,
      canAccessProject: () => true,
      isValidDocument: () => true,
    });
    // Revocation deletes the session row: the same lookup that returned a
    // session before now resolves like an unknown one.
    expect(await port.resolve(request())).toMatchObject({ ok: true });
    rows.delete(SESSION_ID);
    expect(await port.resolve(request())).toEqual({ ok: false, reason: 'UNAUTHENTICATED' });
  });

  it('rejects an expired session with EXPIRED', async () => {
    const port = createSessionAuthPort({
      sessions: sessionStore(
        new Map([[SESSION_ID, liveSession({ expiresAt: '2020-01-01T00:00:00.000Z' })]]),
      ),
      now: () => FIXED_NOW,
      canAccessProject: () => true,
      isValidDocument: () => true,
    });
    expect(await port.resolve(request())).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('rejects a project the user cannot access with PROJECT_MISMATCH', async () => {
    const port = createSessionAuthPort({
      sessions: sessionStore(new Map([[SESSION_ID, liveSession()]])),
      now: () => FIXED_NOW,
      canAccessProject: async (_userId, projectId) => projectId === 'allowed-project',
      isValidDocument: () => true,
    });
    expect(await port.resolve(request())).toEqual({ ok: false, reason: 'PROJECT_MISMATCH' });
  });

  it('rejects an invalid document with INVALID_DOCUMENT', async () => {
    const port = createSessionAuthPort({
      sessions: sessionStore(new Map([[SESSION_ID, liveSession()]])),
      now: () => FIXED_NOW,
      canAccessProject: () => true,
      isValidDocument: async (_projectId, documentId) => documentId === 'definitions/valid.yaml',
    });
    expect(await port.resolve(request())).toEqual({ ok: false, reason: 'INVALID_DOCUMENT' });
  });

  it('resolves the exact scope for a live session', async () => {
    const port = createSessionAuthPort({
      sessions: sessionStore(new Map([[SESSION_ID, liveSession()]])),
      now: () => FIXED_NOW,
      canAccessProject: () => true,
      isValidDocument: () => true,
    });
    expect(await port.resolve(request())).toEqual({
      ok: true,
      scope: {
        sessionId: SESSION_ID,
        userId: USER_ID,
        projectId: PROJECT_ID,
        documentId: DOCUMENT_ID,
      },
    });
  });
});

// ─── Typed persistence port ──────────────────────────────────────────────────

describe('createYjsPersistencePort', () => {
  it('forwards through the typed persistence worker operations', async () => {
    const operations: string[] = [];
    const client = {
      async request(operation: string, payload: unknown) {
        operations.push(operation);
        if (operation === 'loadWorkingDocument') return null;
        return {
          key: payload,
          stateVector: new Uint8Array(),
          update: new Uint8Array(),
          updatedAt: FIXED_NOW,
        };
      },
    } as unknown as PersistenceWorkerClient;
    const port = createYjsPersistencePort(client);
    await port.loadWorkingDocument({ projectId: PROJECT_ID, documentId: DOCUMENT_ID });
    await port.persistYjsUpdate({
      projectId: PROJECT_ID,
      documentId: DOCUMENT_ID,
      update: new Uint8Array([1]),
    });
    expect(operations).toEqual(['loadWorkingDocument', 'persistYjsUpdate']);
  });
});

// ─── Binary persistence and reconnect ────────────────────────────────────────

describe('Yjs gateway binary persistence and reconnect', () => {
  it('persists merged updates and reloads them across reconnect', async () => {
    const { gateway, persistence } = createGatewayFixture();
    const first = await gateway.connect(request());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const applied = await first.connection.applyUpdate(workingUpdate('chapter one'));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(textOf(applied.state.update)).toBe('chapter one');
    expect(
      textOf(requireStored(persistence.stored, stateKey(PROJECT_ID, DOCUMENT_ID)).update),
    ).toBe('chapter one');

    first.connection.disconnect();
    expect(gateway.size).toBe(0);

    // Reconnect: the persisted working document hydrates the new connection.
    const second = await gateway.connect(request());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const secondInitialState = requireInitialState(second.initialState);
    expect(textOf(secondInitialState.update)).toBe('chapter one');
    expect(
      Buffer.from(secondInitialState.stateVector).equals(Buffer.from(applied.state.stateVector)),
    ).toBe(true);

    const updated = await second.connection.applyUpdate(deltaUpdate(applied.state.update, ' v2'));
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(textOf(updated.state.update)).toBe('chapter one v2');

    // The stored state vector round-trips through the typed port.
    const stored = requireStored(persistence.stored, stateKey(PROJECT_ID, DOCUMENT_ID));
    const hydrated = new Y.Doc();
    Y.applyUpdate(hydrated, stored.update);
    expect(Buffer.from(Y.encodeStateVector(hydrated)).equals(Buffer.from(stored.stateVector))).toBe(
      true,
    );

    second.connection.disconnect();
    const third = await gateway.connect(request());
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(textOf(requireInitialState(third.initialState).update)).toBe('chapter one v2');
  });

  it('shares one canonical working document across connections to the same scope', async () => {
    const { gateway } = createGatewayFixture();
    const first = await gateway.connect(request());
    const second = await gateway.connect(request());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const alpha = await first.connection.applyUpdate(workingUpdate('alpha'));
    expect(alpha.ok).toBe(true);
    if (!alpha.ok) return;
    const beta = await second.connection.applyUpdate(deltaUpdate(alpha.state.update, ' beta'));
    expect(beta.ok).toBe(true);
    if (!beta.ok) return;
    expect(textOf(beta.state.update)).toBe('alpha beta');
    // The first connection sees the converged document too.
    const gamma = await first.connection.applyUpdate(deltaUpdate(beta.state.update, ' gamma'));
    expect(gamma.ok).toBe(true);
    if (!gamma.ok) return;
    expect(textOf(gamma.state.update)).toBe('alpha beta gamma');
  });

  it('serializes concurrent updates per document so both merge before persistence', async () => {
    const { gateway, persistence } = createGatewayFixture();
    const bound = await gateway.connect(request());
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;

    const baseline = await bound.connection.applyUpdate(workingUpdate('base '));
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;

    // Fire both updates without awaiting: the second MUST merge onto the
    // first's canonical state instead of last-writer-wins overwriting it. The
    // deltas insert at different positions, so the merged order is
    // deterministic regardless of CRDT tie-breaking.
    const [a, b] = await Promise.all([
      bound.connection.applyUpdate(
        concurrentUpdate(baseline.state.update, 200, (text) => text.insert(0, 'A')),
      ),
      bound.connection.applyUpdate(
        concurrentUpdate(baseline.state.update, 300, (text) => text.insert(text.length, 'B')),
      ),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(
      textOf(requireStored(persistence.stored, stateKey(PROJECT_ID, DOCUMENT_ID)).update),
    ).toBe('Abase B');

    // A later update still merges onto the converged persisted state.
    const c = await bound.connection.applyUpdate(
      deltaUpdate(
        requireStored(persistence.stored, stateKey(PROJECT_ID, DOCUMENT_ID)).update,
        ' C',
      ),
    );
    if (!c.ok) return;
    expect(textOf(c.state.update)).toBe('Abase B C');
  });

  it('rejects a corrupt raw update without touching persisted state or the accepted projection', async () => {
    const { gateway, session, persistence } = createGatewayFixture();
    const bound = await gateway.connect(request());
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;

    const baseline = await bound.connection.applyUpdate(workingUpdate('chapter one'));
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    const persistedBefore = persistence.stored.get(stateKey(PROJECT_ID, DOCUMENT_ID));
    const acceptedSource = session.source;
    const acceptedProjection = session.projection;

    // Raw garbage (and an empty payload) must fail validation, not storage.
    for (const corrupt of [new Uint8Array([0xff, 0xfe, 0x01, 0x02]), new Uint8Array()]) {
      const rejected = await bound.connection.applyUpdate(corrupt);
      expect(rejected).toEqual({ ok: false, reason: 'INVALID_UPDATE' });
    }

    // Nothing was persisted, the canonical document was not advanced, and the
    // accepted Core/Git projection is bit-for-bit untouched.
    expect(persistence.stored.get(stateKey(PROJECT_ID, DOCUMENT_ID))).toBe(persistedBefore);
    expect(
      textOf(requireStored(persistence.stored, stateKey(PROJECT_ID, DOCUMENT_ID)).update),
    ).toBe('chapter one');
    expect(session.source).toBe(acceptedSource);
    expect(session.source?.sourceHash).toBe(SOURCE_HASH);
    expect(session.projection.sourceHash).toBe(acceptedProjection.sourceHash);
    expect(session.projection.version).toBe(1);

    // The next valid update still merges from the last-valid state.
    const after = await bound.connection.applyUpdate(deltaUpdate(baseline.state.update, ' v2'));
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(textOf(after.state.update)).toBe('chapter one v2');
    expect(session.source?.sourceHash).toBe(SOURCE_HASH);
  });

  it('rejects the update when the session is revoked mid-connection', async () => {
    let revoked = false;
    const { gateway, session, persistence } = createGatewayFixture({
      auth: {
        async resolve(inner: YjsConnectionRequest) {
          if (revoked) return { ok: false, reason: 'UNAUTHENTICATED' };
          return {
            ok: true,
            scope: {
              sessionId: inner.sessionId,
              userId: USER_ID,
              projectId: inner.projectId,
              documentId: inner.documentId,
            },
          };
        },
      },
    });
    const bound = await gateway.connect(request());
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const baseline = await bound.connection.applyUpdate(workingUpdate('chapter one'));
    expect(baseline.ok).toBe(true);

    revoked = true;
    const denied = await bound.connection.applyUpdate(workingUpdate('should not land'));
    expect(denied).toEqual({ ok: false, reason: 'UNAUTHENTICATED' });
    expect(
      textOf(requireStored(persistence.stored, stateKey(PROJECT_ID, DOCUMENT_ID)).update),
    ).toBe('chapter one');
    expect(session.source?.sourceHash).toBe(SOURCE_HASH);
  });

  it('rejects the connection when the persistence worker is unavailable', async () => {
    const persistence = fakePersistence();
    const { gateway, session } = createGatewayFixture({
      persistence: {
        ...persistence.port,
        async loadWorkingDocument() {
          throw new Error('worker down');
        },
      },
    });
    const result = await gateway.connect(request());
    expect(result).toEqual({ ok: false, reason: 'STORAGE_UNAVAILABLE' });
    expect(yjsPresenceOf(session)).toEqual([]);
  });
});

// ─── Disconnect presence cleanup ─────────────────────────────────────────────

describe('Yjs gateway disconnect presence cleanup', () => {
  it('removes the actor Yjs presence on disconnect and leaves the accepted projection intact', async () => {
    const { gateway, session } = createGatewayFixture();
    const bound = await gateway.connect(request());
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(yjsPresenceOf(session)).toHaveLength(1);

    const projectionAfterLeave = bound.connection.disconnect();
    expect(yjsPresenceOf(session)).toEqual([]);
    expect(gateway.size).toBe(0);
    expect(projectionAfterLeave?.presence).toEqual([]);
    expect(session.source?.sourceHash).toBe(SOURCE_HASH);
    expect(session.projection.sourceHash).toBe(SOURCE_HASH);

    // Idempotent: a second disconnect is a no-op.
    expect(bound.connection.disconnect()).toBeNull();
    expect(yjsPresenceOf(session)).toEqual([]);
  });

  it('refcounts multiple connections from the same actor', async () => {
    const { gateway, session } = createGatewayFixture();
    const first = await gateway.connect(request());
    const second = await gateway.connect(request());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(yjsPresenceOf(session)).toHaveLength(1);
    expect(gateway.size).toBe(2);

    first.connection.disconnect();
    expect(yjsPresenceOf(session)).toHaveLength(1);
    expect(gateway.size).toBe(1);

    second.connection.disconnect();
    expect(yjsPresenceOf(session)).toEqual([]);
    expect(gateway.size).toBe(0);
  });

  it('gateway.close() disconnects every bound connection', async () => {
    const { gateway, session } = createGatewayFixture();
    const first = await gateway.connect(request());
    const second = await gateway.connect(request({ documentId: 'definitions/locations.yaml' }));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(gateway.size).toBe(2);

    await gateway.close();
    expect(gateway.size).toBe(0);
    expect(yjsPresenceOf(session)).toEqual([]);
  });
});

// ─── Shutdown closure: reauth after hydration, fail-closed close, drain ──────

describe('Yjs gateway shutdown closure', () => {
  it('re-authenticates after hydration and binds nothing when the session is revoked during a delayed load', async () => {
    let revoked = false;
    let authCalls = 0;
    const loadGate = deferred<WorkingDocumentState | null>();
    const auth: YjsAuthPort = {
      async resolve(inner: YjsConnectionRequest) {
        authCalls += 1;
        if (revoked) return { ok: false, reason: 'UNAUTHENTICATED' };
        return {
          ok: true,
          scope: {
            sessionId: inner.sessionId,
            userId: USER_ID,
            projectId: inner.projectId,
            documentId: inner.documentId,
          },
        };
      },
    };
    const base = fakePersistence();
    const loads: string[] = [];
    const { gateway, session } = createGatewayFixture({
      auth,
      persistence: {
        ...base.port,
        async loadWorkingDocument(key) {
          loads.push(stateKey(key.projectId, key.documentId));
          return loadGate.promise;
        },
      },
    });

    const connecting = gateway.connect(request());
    // Let the pre-queue auth resolve and the queue slot reach the hydration
    // await, then revoke the session while the persisted state is loading.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(authCalls).toBe(1);
    expect(loads).toEqual([stateKey(PROJECT_ID, DOCUMENT_ID)]);
    revoked = true;
    // Hydration completes with a stored document that must never bind.
    loadGate.resolve({
      key: { projectId: PROJECT_ID, documentId: DOCUMENT_ID },
      stateVector: new Uint8Array(),
      update: workingUpdate('secret working state'),
      updatedAt: FIXED_NOW,
    });

    const result = await connecting;
    expect(result).toEqual({ ok: false, reason: 'UNAUTHENTICATED' });
    // The in-queue re-auth ran after hydration and rejected before binding.
    expect(authCalls).toBe(2);
    expect(gateway.size).toBe(0);
    expect(yjsPresenceOf(session)).toEqual([]);
  });

  it.each<[string, Partial<YjsConnectionScope>, YjsDenialReason]>([
    ['a different actor', { userId: 'user-2' }, 'UNAUTHENTICATED'],
    ['a different session', { sessionId: 'session-2' }, 'UNAUTHENTICATED'],
    ['a different project', { projectId: 'project-b' }, 'PROJECT_MISMATCH'],
    ['a different document', { documentId: 'definitions/locations.yaml' }, 'INVALID_DOCUMENT'],
  ])('rejects a connect whose re-resolved scope drifted to %s', async (_label, drift, reason) => {
    let authCalls = 0;
    const auth: YjsAuthPort = {
      async resolve(inner: YjsConnectionRequest) {
        authCalls += 1;
        const scope: YjsConnectionScope = {
          sessionId: inner.sessionId,
          userId: USER_ID,
          projectId: inner.projectId,
          documentId: inner.documentId,
        };
        if (authCalls === 1) return { ok: true, scope };
        return { ok: true, scope: { ...scope, ...drift } };
      },
    };
    const { gateway, session } = createGatewayFixture({ auth });
    const result = await gateway.connect(request());
    expect(result).toEqual({ ok: false, reason });
    expect(authCalls).toBe(2);
    expect(gateway.size).toBe(0);
    expect(yjsPresenceOf(session)).toEqual([]);
  });

  it('close() waits for an in-flight persist, fails closed, and never resurrects a runtime', async () => {
    const persistGate = deferred<WorkingDocumentState>();
    const persistStarted = deferred<void>();
    const base = fakePersistence();
    const { gateway, session } = createGatewayFixture({
      persistence: {
        ...base.port,
        async persistYjsUpdate(input) {
          base.calls.push({
            operation: 'persist',
            key: stateKey(input.projectId, input.documentId),
          });
          persistStarted.resolve();
          return persistGate.promise;
        },
      },
    });
    const bound = await gateway.connect(request());
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;

    const applying = bound.connection.applyUpdate(workingUpdate('chapter one'));
    await persistStarted.promise;
    expect(base.calls.filter((call) => call.operation === 'persist')).toHaveLength(1);

    let closed = false;
    const closing = gateway.close().then(() => {
      closed = true;
    });
    // Connections are marked closed synchronously before the drain...
    expect(gateway.size).toBe(0);
    expect(yjsPresenceOf(session)).toEqual([]);
    // ...but close must not resolve until the in-flight persist completes.
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);

    // New calls fail closed while close is still draining.
    expect(await bound.connection.applyUpdate(workingUpdate('nope'))).toEqual({
      ok: false,
      reason: 'CONNECTION_CLOSED',
    });
    expect(await gateway.connect(request())).toEqual({ ok: false, reason: 'CONNECTION_CLOSED' });

    // Completing the in-flight persist lets the close finish. The drained
    // update is durably stored and reported, but nothing is resurrected.
    persistGate.resolve({
      key: { projectId: PROJECT_ID, documentId: DOCUMENT_ID },
      stateVector: new Uint8Array(),
      update: workingUpdate('chapter one'),
      updatedAt: FIXED_NOW,
    });
    await closing;
    expect(closed).toBe(true);
    const applied = await applying;
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(textOf(applied.state.update)).toBe('chapter one');
    expect(base.calls.filter((call) => call.operation === 'persist')).toHaveLength(1);
    expect(gateway.size).toBe(0);
    expect(yjsPresenceOf(session)).toEqual([]);
    expect(await gateway.connect(request())).toEqual({ ok: false, reason: 'CONNECTION_CLOSED' });
  });

  it('fails closed when shutdown lands while an update is re-validating', async () => {
    const authGate = deferred<YjsScopeResolution>();
    const base = fakePersistence();
    let authCalls = 0;
    const { gateway } = createGatewayFixture({
      auth: {
        async resolve(inner: YjsConnectionRequest) {
          authCalls += 1;
          if (authCalls <= 2) {
            return {
              ok: true,
              scope: {
                sessionId: inner.sessionId,
                userId: USER_ID,
                projectId: inner.projectId,
                documentId: inner.documentId,
              },
            };
          }
          return authGate.promise;
        },
      },
      persistence: base.port,
    });
    const bound = await gateway.connect(request());
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;

    const applying = bound.connection.applyUpdate(workingUpdate('must not persist'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(authCalls).toBe(3); // the per-update revalidation is in flight

    const closing = gateway.close();
    authGate.resolve({
      ok: true,
      scope: {
        sessionId: SESSION_ID,
        userId: USER_ID,
        projectId: PROJECT_ID,
        documentId: DOCUMENT_ID,
      },
    });
    await closing;
    expect(await applying).toEqual({ ok: false, reason: 'CONNECTION_CLOSED' });
    expect(base.calls.filter((call) => call.operation === 'persist')).toHaveLength(0);
  });

  it('open() re-enables connects after a terminal close()', async () => {
    const { gateway } = createGatewayFixture();
    const bound = await gateway.connect(request());
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(
      await bound.connection.applyUpdate(workingUpdate('persisted across restart')),
    ).toMatchObject({ ok: true });

    await gateway.close();
    expect(gateway.size).toBe(0);
    expect(await gateway.connect(request())).toEqual({ ok: false, reason: 'CONNECTION_CLOSED' });

    // A Host close/start cycle calls open() before the next listen cycle: the
    // gateway re-accepts connects and hydrates from the persisted state.
    gateway.open();
    const rebound = await gateway.connect(request());
    expect(rebound.ok).toBe(true);
    if (!rebound.ok) return;
    expect(rebound.initialState).not.toBeNull();
    expect(textOf(requireInitialState(rebound.initialState).update)).toBe(
      'persisted across restart',
    );
    expect(gateway.size).toBe(1);
  });
});

/**
 * Authenticated Yjs working-layer gateway for the Workbench Host.
 *
 * The gateway is the Host-side boundary of the online-only Yjs working layer.
 * Every connection MUST pass an injected session-authentication port that
 * resolves the exact user/project/document scope before anything else
 * happens: unauthenticated, expired/revoked, wrong-project, and invalid
 * document requests are rejected before a byte of working state is loaded or
 * exchanged. The same scope is re-validated before every update, so a session
 * revoked or expired mid-connection stops the next update at the next safe
 * checkpoint.
 *
 * Working updates are validated and persisted exclusively through the typed
 * persistence worker operations (`loadWorkingDocument` / `persistYjsUpdate`);
 * Yjs content never reaches the accepted Core/Git projection, which remains
 * canonical and untouched. An invalid raw update is rejected without touching
 * the canonical in-memory document or the persisted state.
 * Read-merge-persist sections are serialized per project/document scope, so
 * concurrent updates merge onto the canonical document before the typed
 * persist instead of last-writer-wins overwriting each other's bytes.
 * `close()` is asynchronous and fail-closed: new connects and updates are
 * rejected once shutdown begins, live connections are marked closed, and
 * every queued/in-flight per-document persistence operation drains before
 * the close resolves. The gateway stays fail-closed until `open()` runs,
 * which the Host invokes before every listen cycle.
 *
 * The per-key canonical working document and its serialization live in the
 * shared {@link YjsWorkingDocumentCore}. The browser gateway AND the
 * production Agent document store (`host/authoring/document-store.ts`) bind
 * the SAME core instance, so browser updates and Agent/MCP scoped updates
 * merge onto one canonical in-memory document per key and one persisted
 * state — never a second CRDT/store. `createYjsGateway` creates a private
 * core by default; Host wiring passes one shared core to both the gateway
 * and the document store.
 *
 * This module deliberately does NOT start a y-websocket server. It exposes
 * connect/disconnect/update APIs that a ws upgrade integration (a later Host
 * slice) calls; the gateway itself is transport-agnostic and fully
 * deterministic under injected auth/session adapters.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as Y from 'yjs';

import type {
  PersistYjsUpdateInput,
  WorkingDocumentState,
  YjsDocumentKey,
} from '../../contracts/persistence.js';
import type { PersistenceWorkerClient } from '../../persistence/worker-client.js';
import type { LocalAuthService } from '../auth/service.js';
import type { ProjectAccessRequiredRole } from '../project-access-service.js';
import type { ProjectSessionProjectionV1, ProjectSessionRegistry } from '../project-session.js';
/**
 * Typed persistence surface used by the Yjs working-document core.
 * Implementations must route these operations through the Host persistence
 * worker; the gateway never reaches storage directly.
 */
export interface YjsPersistencePort {
  loadWorkingDocument(key: YjsDocumentKey): Promise<WorkingDocumentState | null>;
  persistYjsUpdate(input: PersistYjsUpdateInput): Promise<WorkingDocumentState>;
}

/** Adapt the typed persistence worker client to the Yjs persistence port. */
export function createYjsPersistencePort(client: PersistenceWorkerClient): YjsPersistencePort {
  return {
    loadWorkingDocument(key) {
      return client.request('loadWorkingDocument', key);
    },
    persistYjsUpdate(input) {
      return client.request('persistYjsUpdate', input);
    },
  };
}

const YJS_TICKET_TTL_MS = 30_000;

export interface YjsTicketBinding {
  readonly bindingId: string;
  /** Host-only session lookup key; never returned by transport or DTO. */
  readonly sessionId: string;
  readonly userId: string;
  readonly capabilityVersion: number;
  readonly projectId: string;
  readonly documentId: string;
  readonly expiresAt: number;
}
/**
 * Host-only one-time ticket store. Only the SHA-256 digest of a presented
 * ticket is retained; after consumption, callers retain an opaque binding id.
 */
export interface YjsTicketService {
  mint(input: {
    readonly sessionId: string;
    readonly userId: string;
    readonly capabilityVersion: number;
    readonly projectId: string;
    readonly documentId: string;
    readonly now?: number;
  }): string;
  consume(ticket: string, now?: number): YjsTicketBinding | null;
  get(bindingId: string): YjsTicketBinding | null;
  release(bindingId: string): void;
}

function ticketDigest(ticket: string): string {
  return createHash('sha256').update(ticket, 'utf8').digest('hex');
}

export function createYjsTicketService(): YjsTicketService {
  const tickets = new Map<string, YjsTicketBinding>();
  const bindings = new Map<string, YjsTicketBinding>();
  return {
    mint(input): string {
      const ticket = randomBytes(32).toString('base64url');
      const record: YjsTicketBinding = {
        bindingId: randomUUID(),
        sessionId: input.sessionId,
        userId: input.userId,
        capabilityVersion: input.capabilityVersion,
        projectId: input.projectId,
        documentId: input.documentId,
        expiresAt: (input.now ?? Date.now()) + YJS_TICKET_TTL_MS,
      };
      tickets.set(ticketDigest(ticket), record);
      return ticket;
    },
    consume(ticket, now = Date.now()): YjsTicketBinding | null {
      if (typeof ticket !== 'string' || ticket.length === 0) return null;
      const digest = ticketDigest(ticket);
      const record = tickets.get(digest);
      // Delete before any validation so a failed/expired presentation cannot
      // be replayed and the raw ticket never survives consumption.
      tickets.delete(digest);
      if (record === undefined || record.expiresAt <= now) return null;
      bindings.set(record.bindingId, record);
      return record;
    },
    get(bindingId) {
      const record = bindings.get(bindingId);
      if (record === undefined || record.expiresAt <= Date.now()) {
        if (record !== undefined) bindings.delete(bindingId);
        return null;
      }
      return record;
    },
    release(bindingId): void {
      bindings.delete(bindingId);
    },
  };
}
/** Access the process-wide ticket service used by default Host wiring. */
export function getYjsTicketService(): YjsTicketService {
  return defaultYjsTickets;
}

const defaultYjsTickets = createYjsTicketService();

/** One Yjs connection request presented by the ticketed transport. */
export interface YjsConnectionRequest {
  readonly ticket: string;
  readonly projectId: string;
  readonly documentId: string;
}

/** Server-side reasons a Yjs connection is denied before update exchange. */
export type YjsDenialReason =
  | 'UNAUTHENTICATED'
  | 'EXPIRED'
  | 'PROJECT_MISMATCH'
  | 'INVALID_DOCUMENT';

/** Non-auth service failures that can still prevent binding or persisting. */
export type YjsServiceFailureReason = 'STORAGE_UNAVAILABLE' | 'CONNECTION_CLOSED';

export type YjsConnectFailureReason = YjsDenialReason | 'STORAGE_UNAVAILABLE' | 'CONNECTION_CLOSED';

export type YjsApplyFailureReason = YjsDenialReason | YjsServiceFailureReason | 'INVALID_UPDATE';

/**
 * Exact server-resolved scope bound to one Yjs connection. The raw ticket and
 * reusable session credential are never retained here; only the opaque binding
 * id is carried by the gateway connection.
 */
export interface YjsConnectionScope {
  readonly bindingId: string;
  readonly userId: string;
  readonly capabilityVersion: number;
  readonly projectId: string;
  readonly documentId: string;
}

export type YjsScopeResolution =
  | { readonly ok: true; readonly scope: YjsConnectionScope }
  | { readonly ok: false; readonly reason: YjsDenialReason };

export type YjsAuthRequest = YjsConnectionRequest | YjsConnectionScope;

/**
 * Injected session-authentication port. Initial resolution consumes a
 * one-time ticket; subsequent resolutions accept only the opaque binding.
 */
export interface YjsAuthPort {
  resolve(request: YjsAuthRequest): Promise<YjsScopeResolution>;
  /** Release an opaque binding once its socket disconnects. */
  release?(scope: YjsConnectionScope): void;
}

export interface SessionAuthPortOptions {
  /** Session lookup; a missing row means the session never existed or was revoked. */
  readonly sessions: Pick<LocalAuthService, 'getSession'>;
  /** Shared one-time ticket store; defaults to the Host process store. */
  readonly tickets?: YjsTicketService;
  /** Timestamp source for expiry checks; defaults to the host clock. */
  readonly now?: () => string;
  /** True when the authenticated user may access the requested project at the required role. */
  readonly canAccessProject: (
    userId: string,
    projectId: string,
    requiredRole?: ProjectAccessRequiredRole,
  ) => boolean | Promise<boolean>;
  /** True when the document id is a valid working document of the project. */
  readonly isValidDocument: (projectId: string, documentId: string) => boolean | Promise<boolean>;
}

/**
 * Default auth port over the Host session store. Ticket consumption is atomic;
 * every update rechecks session expiry, capability version, ACL and document.
 */
export function createSessionAuthPort(options: SessionAuthPortOptions): YjsAuthPort {
  const now = options.now ?? (() => new Date().toISOString());
  const tickets = options.tickets ?? defaultYjsTickets;
  return {
    async resolve(request: YjsAuthRequest): Promise<YjsScopeResolution> {
      let record: YjsTicketBinding | null;
      if ('ticket' in request) {
        const ticket = tickets.consume(request.ticket);
        if (ticket === null) return { ok: false, reason: 'UNAUTHENTICATED' };
        if (ticket.projectId !== request.projectId) {
          tickets.release(ticket.bindingId);
          return { ok: false, reason: 'PROJECT_MISMATCH' };
        }
        if (ticket.documentId !== request.documentId) {
          tickets.release(ticket.bindingId);
          return { ok: false, reason: 'INVALID_DOCUMENT' };
        }
        record = ticket;
      } else {
        record = tickets.get(request.bindingId);
        if (
          record === null ||
          record.userId !== request.userId ||
          record.capabilityVersion !== request.capabilityVersion ||
          record.projectId !== request.projectId ||
          record.documentId !== request.documentId
        ) {
          return { ok: false, reason: 'UNAUTHENTICATED' };
        }
      }
      const session = await options.sessions.getSession(record.sessionId);
      if (session === null) {
        tickets.release(record.bindingId);
        return { ok: false, reason: 'UNAUTHENTICATED' };
      }
      if (session.expiresAt <= now()) {
        tickets.release(record.bindingId);
        return { ok: false, reason: 'EXPIRED' };
      }
      if (session.capabilityVersion !== record.capabilityVersion) {
        tickets.release(record.bindingId);
        return { ok: false, reason: 'UNAUTHENTICATED' };
      }
      if (!(await options.canAccessProject(record.userId, record.projectId, 'author'))) {
        tickets.release(record.bindingId);
        return { ok: false, reason: 'PROJECT_MISMATCH' };
      }
      if (!(await options.isValidDocument(record.projectId, record.documentId))) {
        tickets.release(record.bindingId);
        return { ok: false, reason: 'INVALID_DOCUMENT' };
      }
      return {
        ok: true,
        scope: {
          bindingId: record.bindingId,
          userId: record.userId,
          capabilityVersion: record.capabilityVersion,
          projectId: record.projectId,
          documentId: record.documentId,
        },
      };
    },
    release(scope): void {
      tickets.release(scope.bindingId);
    },
  };
}
// ─── Shared per-key working-document core ────────────────────────────────────

const SCOPE_SEPARATOR = '\u0000';

function keyOfDocument(key: YjsDocumentKey): string {
  return `${key.projectId}${SCOPE_SEPARATOR}${key.documentId}`;
}

export interface YjsWorkingDocumentCoreOptions {
  /** Typed persistence port; the ONLY storage surface of the core. */
  readonly persistence: YjsPersistencePort;
  /** Timestamp source for synthesized read states; defaults to the host clock. */
  readonly now?: () => string;
}

/**
 * The shared per-key canonical working-document core. Owns the in-memory
 * canonical docs, the per-key serialization tails, the fail-closed shutdown
 * flag, and every persistence read/merge/persist-swap. The browser gateway
 * and the production Agent document store bind the SAME instance so all
 * writers merge onto one canonical document per exact project/document key
 * and one persisted state.
 *
 * Serialization discipline: `enqueue` is the ONLY entry into a key's
 * critical section. The primitives (`getOrCreate`, `load`, `persist`,
 * `release`, `peek`) do NOT enqueue and MUST be called inside an enqueued
 * section for the same key — nesting an enqueue inside a running slot would
 * deadlock the tail chain.
 */
export interface YjsWorkingDocumentCore {
  /** Number of in-memory canonical documents currently held. */
  readonly size: number;
  /** True once `close()` has run and before `open()` clears the flag. */
  readonly closed: boolean;
  /** Reopen after a terminal close: new enqueues/creates are accepted again. Idempotent. */
  open(): void;
  /**
   * Fail closed: reject new work, drop every in-memory canonical document,
   * and drain queued/in-flight per-key persistence operations before the
   * returned promise resolves. Persisted state stays authoritative.
   */
  close(): Promise<void>;
  /**
   * Serialize one critical section per exact project/document key. Slots run
   * strictly in enqueue order; a rejected prior slot never blocks the next.
   */
  enqueue<T>(key: YjsDocumentKey, run: () => Promise<T> | T): Promise<T>;
  /**
   * Get-or-create the canonical in-memory doc for the key, hydrated from the
   * persisted state exactly once. Returns null when the core is closed or
   * the persisted state could not be loaded (a storage fault, never a
   * client issue). Must run inside an enqueued section for the key.
   */
  getOrCreate(
    key: YjsDocumentKey,
  ): Promise<{ readonly doc: Y.Doc; readonly stored: WorkingDocumentState | null } | null>;
  /**
   * Read the current working state for the key without creating a doc: the
   * canonical in-memory state when one exists, else the persisted state.
   * Never throws; storage faults return null. May run anywhere.
   */
  load(key: YjsDocumentKey): Promise<WorkingDocumentState | null>;
  /**
   * Persist the full state of `doc` for the key. On success the canonical
   * in-memory doc is swapped for `doc` only while holders remain; a doc with
   * zero holders is dropped (persisted state stays authoritative). Rejects
   * when the typed persist fails — the canonical doc is never advanced past
   * what was durably persisted. Must run inside an enqueued section.
   */
  persist(key: YjsDocumentKey, doc: Y.Doc): Promise<WorkingDocumentState>;
  /** Register a live holder (a bound connection) so the doc survives other releases. */
  retain(key: YjsDocumentKey, holder: object): void;
  /** Remove a holder; the in-memory doc is dropped when no holders remain. */
  release(key: YjsDocumentKey, holder: object): void;
  /** Inspect the canonical in-memory doc without creating one. */
  peek(key: YjsDocumentKey): Y.Doc | null;
  /** Subscribe to successful persists (browser or Agent origin); returns an unsubscribe. */
  onPersist(listener: (key: YjsDocumentKey) => void): () => void;
}

function createYjsWorkingDocumentCoreImpl(
  options: YjsWorkingDocumentCoreOptions,
): YjsWorkingDocumentCore {
  const persistence = options.persistence;
  const now = options.now ?? (() => new Date().toISOString());
  /** Canonical in-memory working docs, keyed by exact project/document scope. */
  const documents = new Map<string, { doc: Y.Doc; holders: Set<object> }>();
  /**
   * Per-key serialization tails. Every read-merge-persist-swap on a working
   * document runs strictly in enqueue order per project/document scope, so
   * concurrent updates merge onto the canonical state instead of a
   * last-writer-wins overwrite of each other's persisted bytes.
   */
  const tails = new Map<string, Promise<unknown>>();
  /** Persist listeners: notified (synchronously) after each successful persist. */
  const persistListeners = new Set<(key: YjsDocumentKey) => void>();
  /**
   * Fail-closed shutdown flag. Once set by `close()`, new work is rejected
   * and only already-queued per-document operations drain; `open()` clears
   * it for the next listen cycle.
   */
  let closing = false;

  const enqueue = <T>(key: YjsDocumentKey, run: () => Promise<T> | T): Promise<T> => {
    const slotKey = keyOfDocument(key);
    const prior = tails.get(slotKey) ?? Promise.resolve();
    const slot = prior.then(run, run);
    tails.set(
      slotKey,
      slot.then(
        () => undefined,
        () => undefined,
      ),
    );
    return slot;
  };

  return {
    get size() {
      return documents.size;
    },
    get closed() {
      return closing;
    },
    open(): void {
      closing = false;
    },
    async close(): Promise<void> {
      closing = true;
      // Drop every in-memory canonical document; persisted state stays
      // authoritative and rehydrates the next open cycle.
      for (const runtime of [...documents.values()]) runtime.doc.destroy();
      documents.clear();
      // Drain every queued/in-flight per-document operation: slots already
      // past their fail-closed check finish their persistence, and slots
      // still queued settle without creating or persisting.
      await Promise.allSettled([...tails.values()]);
    },
    enqueue,
    async getOrCreate(key) {
      // MUST be called inside an enqueued section for `key` (no nested
      // enqueue: that would chain onto the running slot and deadlock).
      if (closing) return null;
      const slotKey = keyOfDocument(key);
      const existing = documents.get(slotKey);
      if (existing !== undefined) {
        return { doc: existing.doc, stored: await loadUnsafe(key) };
      }
      let stored: WorkingDocumentState | null;
      try {
        stored = await persistence.loadWorkingDocument({
          projectId: key.projectId,
          documentId: key.documentId,
        });
      } catch {
        return null;
      }
      if (closing) return null;
      const doc = new Y.Doc();
      if (stored !== null) {
        try {
          Y.applyUpdate(doc, stored.update);
        } catch {
          // A corrupt persisted blob is a storage fault, not a client issue.
          return null;
        }
      }
      documents.set(slotKey, { doc, holders: new Set() });
      return { doc, stored };
    },
    async load(key) {
      const slotKey = keyOfDocument(key);
      const existing = documents.get(slotKey);
      if (existing !== undefined) {
        return {
          key: { projectId: key.projectId, documentId: key.documentId },
          stateVector: Y.encodeStateVector(existing.doc),
          update: Y.encodeStateAsUpdate(existing.doc),
          updatedAt: now(),
        };
      }
      return loadUnsafe(key);
    },
    async persist(key, doc) {
      let state: WorkingDocumentState;
      try {
        state = await persistence.persistYjsUpdate({
          projectId: key.projectId,
          documentId: key.documentId,
          update: Y.encodeStateAsUpdate(doc),
          stateVector: Y.encodeStateVector(doc),
        });
      } catch {
        // Last-valid persisted state stays authoritative: the canonical doc
        // is only ever advanced past what was durably persisted.
        throw new Error('persistYjsUpdate failed');
      }
      const slotKey = keyOfDocument(key);
      const runtime = documents.get(slotKey);
      if (runtime === undefined) {
        for (const listener of persistListeners) listener(key);
        return state;
      }
      if (runtime.holders.size === 0) {
        // A disconnect/close racing this persist may have torn the runtime
        // down (zero live holders). The persisted state stays authoritative,
        // but the canonical in-memory runtime must never be resurrected with
        // no live holder keeping it.
        runtime.doc.destroy();
        documents.delete(slotKey);
        for (const listener of persistListeners) listener(key);
        return state;
      }
      documents.set(slotKey, { doc, holders: runtime.holders });
      for (const listener of persistListeners) listener(key);
      return state;
    },
    retain(key, holder) {
      const runtime = documents.get(keyOfDocument(key));
      if (runtime === undefined) return;
      runtime.holders.add(holder);
    },
    release(key, holder) {
      const slotKey = keyOfDocument(key);
      const runtime = documents.get(slotKey);
      if (runtime === undefined) return;
      runtime.holders.delete(holder);
      if (runtime.holders.size === 0) {
        runtime.doc.destroy();
        documents.delete(slotKey);
      }
    },
    peek(key) {
      return documents.get(keyOfDocument(key))?.doc ?? null;
    },
    onPersist(listener) {
      persistListeners.add(listener);
      return () => {
        persistListeners.delete(listener);
      };
    },
  };

  /** Read the persisted state without creating a doc; storage faults yield null. */
  async function loadUnsafe(key: YjsDocumentKey): Promise<WorkingDocumentState | null> {
    try {
      return await persistence.loadWorkingDocument({
        projectId: key.projectId,
        documentId: key.documentId,
      });
    } catch {
      return null;
    }
  }
}

/** Create one shared per-key working-document core. */
export function createYjsWorkingDocumentCore(
  options: YjsWorkingDocumentCoreOptions,
): YjsWorkingDocumentCore {
  return createYjsWorkingDocumentCoreImpl(options);
}

export interface YjsGatewayOptions {
  readonly auth: YjsAuthPort;
  readonly persistence: YjsPersistencePort;
  /**
   * Optional shared per-key working-document core. When omitted the gateway
   * creates a private core over `persistence`; Host wiring passes ONE shared
   * core to both the gateway and the production Agent document store so
   * browser and Agent writers merge onto the same canonical documents.
   */
  readonly core?: YjsWorkingDocumentCore;
  /**
   * Open project sessions, used only for working/presence state. A project
   * without an open session skips presence but never loosens auth.
   */
  readonly sessions: Pick<ProjectSessionRegistry, 'get'>;
  /** Timestamp source for presence updates; defaults to the host clock. */
  readonly now?: () => string;
}

/**
 * One authenticated, scope-bound Yjs connection. `applyUpdate` merges into
 * the shared canonical working document for its exact key and persists the
 * merged state; `disconnect` releases the connection and cleans up presence.
 */
export interface YjsGatewayConnection {
  /** The exact server-resolved scope bound at connect time; never client-selectable. */
  readonly scope: YjsConnectionScope;
  /**
   * Merge one raw Yjs update into the bound working document and persist the
   * merged state through the typed worker. The session is re-validated before
   * every update, and a corrupt update is rejected without advancing either
   * the canonical document or the persisted state.
   */
  applyUpdate(update: Uint8Array): Promise<YjsApplyResult>;
  /**
   * Release the connection: drops in-memory state (the persisted working
   * document remains) and removes the actor's Yjs presence when no other
   * connection holds it. Idempotent; returns the session projection after the
   * presence leave, or null when no session is open for the project.
   */
  disconnect(): ProjectSessionProjectionV1 | null;
}

export type YjsApplyResult =
  | { readonly ok: true; readonly state: WorkingDocumentState }
  | { readonly ok: false; readonly reason: YjsApplyFailureReason };

export type YjsGatewayConnectResult =
  | {
      readonly ok: true;
      readonly connection: YjsGatewayConnection;
      /** Persisted working state at bind time; null when the document was never persisted. */
      readonly initialState: WorkingDocumentState | null;
    }
  | { readonly ok: false; readonly reason: YjsConnectFailureReason };

export interface YjsGateway {
  /** Bound connections currently held. */
  readonly size: number;
  /** Authenticate + bind exact scope + hydrate, or reject before any update exchange. */
  connect(request: YjsConnectionRequest): Promise<YjsGatewayConnectResult>;
  /**
   * Reopen after a terminal {@link close}: clears the fail-closed shutdown
   * state so new connects and updates are accepted again. Idempotent; the
   * Host calls it before every listener start cycle.
   */
  open(): void;
  /**
   * Shut the gateway down: reject new connects and updates, disconnect every
   * bound connection, and drain queued/in-flight per-document persistence
   * operations before the returned promise resolves. The gateway stays
   * fail-closed until {@link open} runs.
   */
  close(): Promise<void>;
}

export function createYjsGateway(options: YjsGatewayOptions): YjsGateway {
  const auth = options.auth;
  const sessions = options.sessions;
  const now = options.now ?? (() => new Date().toISOString());
  const core =
    options.core ?? createYjsWorkingDocumentCore({ persistence: options.persistence, now });
  /** projectId → (userId → open connection count) for presence refcounting. */
  const presence = new Map<string, Map<string, number>>();
  const connections = new Set<YjsGatewayConnectionImpl>();

  /**
   * Denial reason when the post-hydration re-resolution drifted from the
   * scope resolved before queueing. Binding and capability identity must not
   * change while hydration is in flight.
   */
  const scopeDriftReason = (
    expected: YjsConnectionScope,
    actual: YjsConnectionScope,
  ): YjsDenialReason | null => {
    if (
      expected.bindingId !== actual.bindingId ||
      expected.userId !== actual.userId ||
      expected.capabilityVersion !== actual.capabilityVersion
    ) {
      return 'UNAUTHENTICATED';
    }
    if (expected.projectId !== actual.projectId) return 'PROJECT_MISMATCH';
    if (expected.documentId !== actual.documentId) return 'INVALID_DOCUMENT';
    return null;
  };

  const joinPresence = (scope: YjsConnectionScope): void => {
    const session = sessions.get(scope.projectId);
    if (session === null) return;
    const counts = presence.get(scope.projectId) ?? new Map<string, number>();
    counts.set(scope.userId, (counts.get(scope.userId) ?? 0) + 1);
    presence.set(scope.projectId, counts);
    if (counts.get(scope.userId) === 1) {
      session.updatePresence({ kind: 'join', actorId: scope.userId, surface: 'yjs', at: now() });
    }
  };

  const leavePresence = (scope: YjsConnectionScope): void => {
    const session = sessions.get(scope.projectId);
    if (session === null) return;
    const counts = presence.get(scope.projectId);
    if (counts === undefined) return;
    const remaining = (counts.get(scope.userId) ?? 0) - 1;
    if (remaining > 0) {
      counts.set(scope.userId, remaining);
      return;
    }
    counts.delete(scope.userId);
    if (counts.size === 0) presence.delete(scope.projectId);
    session.updatePresence({ kind: 'leave', actorId: scope.userId, surface: 'yjs', at: now() });
  };

  const keyOf = (scope: YjsConnectionScope): YjsDocumentKey => ({
    projectId: scope.projectId,
    documentId: scope.documentId,
  });

  class YjsGatewayConnectionImpl implements YjsGatewayConnection {
    readonly scope: YjsConnectionScope;
    #closed = false;

    constructor(scope: YjsConnectionScope) {
      this.scope = scope;
    }

    async applyUpdate(update: Uint8Array): Promise<YjsApplyResult> {
      if (this.#closed) return { ok: false, reason: 'CONNECTION_CLOSED' };
      const key = keyOf(this.scope);
      // Serialized per exact project/document scope: the read-merge-persist
      // section below runs atomically for the key, so concurrent updates
      // merge onto the canonical document before the typed persist instead of
      // racing a last-writer overwrite.
      return core.enqueue(key, async (): Promise<YjsApplyResult> => {
        if (this.#closed || core.closed) return { ok: false, reason: 'CONNECTION_CLOSED' };
        // Every state change re-authenticates server-side against the bound
        // scope: revocation or expiry stops the next update at the next safe
        // checkpoint.
        const resolution = await auth.resolve(this.scope);
        if (!resolution.ok) return { ok: false, reason: resolution.reason };
        // The connection may have been closed (Host shutdown) while the
        // revalidation was in flight: fail closed at this checkpoint without
        // persisting anything further.
        if (this.#closed || core.closed) return { ok: false, reason: 'CONNECTION_CLOSED' };
        const created = await core.getOrCreate(key);
        if (created === null) {
          return {
            ok: false,
            reason: core.closed ? 'CONNECTION_CLOSED' : 'STORAGE_UNAVAILABLE',
          };
        }
        // Validate against a scratch copy: a corrupt update must never advance
        // the canonical working document.
        const merged = new Y.Doc();
        try {
          Y.applyUpdate(merged, Y.encodeStateAsUpdate(created.doc));
          Y.applyUpdate(merged, update);
        } catch {
          return { ok: false, reason: 'INVALID_UPDATE' };
        }
        let state: WorkingDocumentState;
        try {
          state = await core.persist(key, merged);
        } catch {
          // Last-valid persisted state stays authoritative: the canonical doc
          // is only ever advanced past what was durably persisted.
          return { ok: false, reason: 'STORAGE_UNAVAILABLE' };
        }
        return { ok: true, state };
      });
    }

    disconnect(): ProjectSessionProjectionV1 | null {
      if (this.#closed) return null;
      this.#closed = true;
      connections.delete(this);
      core.release(keyOf(this.scope), this);
      auth.release?.(this.scope);
      leavePresence(this.scope);
      return sessions.get(this.scope.projectId)?.projection ?? null;
    }
  }

  return {
    get size() {
      return connections.size;
    },
    open(): void {
      // Reopen after a terminal close(): clear the fail-closed flag so new
      // connects and updates are accepted again. Idempotent; the Host calls
      // it before every listener start cycle.
      core.open();
    },
    async connect(request: YjsConnectionRequest): Promise<YjsGatewayConnectResult> {
      if (core.closed) return { ok: false, reason: 'CONNECTION_CLOSED' };
      const resolution = await auth.resolve(request);
      if (!resolution.ok) return { ok: false, reason: resolution.reason };
      const scope = resolution.scope;
      const key = keyOf(scope);
      // Bind serialized per key too: get-or-create must never interleave with
      // an applyUpdate swap that would replace the runtime under a fresh
      // connection, and the hydrated `initialState` is read inside the slot so
      // it always reflects the latest persisted state for the key.
      return core.enqueue(key, async (): Promise<YjsGatewayConnectResult> => {
        // Fail closed if shutdown landed before this slot ran.
        if (core.closed) return { ok: false, reason: 'CONNECTION_CLOSED' };
        const created = await core.getOrCreate(key);
        if (created === null) {
          return {
            ok: false,
            reason: core.closed ? 'CONNECTION_CLOSED' : 'STORAGE_UNAVAILABLE',
          };
        }
        // Ticket already consumed; binding revalidation follows.
        if (core.closed) return { ok: false, reason: 'CONNECTION_CLOSED' };
        // Re-authenticate after hydration, immediately before binding: a
        // session revoked/expired while the persisted state was loading, or
        // a scope that drifted under the live request, must not bind or
        // disclose any working state.
        const revalidated = await auth.resolve(scope);
        if (!revalidated.ok) return { ok: false, reason: revalidated.reason };
        const drift = scopeDriftReason(scope, revalidated.scope);
        if (drift !== null) return { ok: false, reason: drift };
        if (core.closed) return { ok: false, reason: 'CONNECTION_CLOSED' };
        joinPresence(scope);
        const connection = new YjsGatewayConnectionImpl(scope);
        connections.add(connection);
        core.retain(key, connection);
        return { ok: true, connection, initialState: created.stored };
      });
    },
    async close(): Promise<void> {
      // Fail closed: no new connects or updates may start after this point.
      // Connections are marked closed and their presence leaves synchronously;
      // the shared core then drains queued/in-flight persistence operations.
      for (const connection of [...connections]) connection.disconnect();
      await core.close();
    },
  };
}

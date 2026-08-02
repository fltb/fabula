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
 * This module deliberately does NOT start a y-websocket server. It exposes
 * connect/disconnect/update APIs that a ws upgrade integration (a later Host
 * slice) calls; the gateway itself is transport-agnostic and fully
 * deterministic under injected auth/session adapters.
 */
import * as Y from 'yjs';

import type {
  PersistYjsUpdateInput,
  WorkingDocumentState,
  YjsDocumentKey,
} from '../../contracts/persistence.js';
import type { PersistenceWorkerClient } from '../../persistence/worker-client.js';
import type { LocalAuthService } from '../auth/service.js';
import type { ProjectSessionProjectionV1, ProjectSessionRegistry } from '../project-session.js';

/** One Yjs connection request as presented by the transport layer. */
export interface YjsConnectionRequest {
  readonly sessionId: string;
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
 * Exact server-resolved scope bound to one Yjs connection. The transport
 * never chooses the actor or any permission: the session determines the
 * actor, and the requested project/document are validated against it.
 */
export interface YjsConnectionScope {
  readonly sessionId: string;
  readonly userId: string;
  readonly projectId: string;
  readonly documentId: string;
}

export type YjsScopeResolution =
  | { readonly ok: true; readonly scope: YjsConnectionScope }
  | { readonly ok: false; readonly reason: YjsDenialReason };

/**
 * Injected session-authentication port. The gateway consumes only this
 * boundary; Host wiring supplies it (see {@link createSessionAuthPort}), and
 * tests inject deterministic fakes.
 */
export interface YjsAuthPort {
  resolve(request: YjsConnectionRequest): Promise<YjsScopeResolution>;
}

export interface SessionAuthPortOptions {
  /** Session lookup; a missing row means the session never existed or was revoked. */
  readonly sessions: Pick<LocalAuthService, 'getSession'>;
  /** Timestamp source for expiry checks; defaults to the host clock. */
  readonly now?: () => string;
  /** True when the authenticated user may access the requested project. */
  readonly canAccessProject: (userId: string, projectId: string) => boolean | Promise<boolean>;
  /** True when the document id is a valid working document of the project. */
  readonly isValidDocument: (projectId: string, documentId: string) => boolean | Promise<boolean>;
}

/**
 * Default auth port over the Host session store. Revoked sessions are deleted
 * from the store, so they resolve exactly like unknown sessions:
 * `UNAUTHENTICATED`. Expired sessions still have a row and are rejected here
 * with `EXPIRED`; project/document scope is resolved only for a live session.
 */
export function createSessionAuthPort(options: SessionAuthPortOptions): YjsAuthPort {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async resolve(request: YjsConnectionRequest): Promise<YjsScopeResolution> {
      const session = await options.sessions.getSession(request.sessionId);
      if (session === null) return { ok: false, reason: 'UNAUTHENTICATED' };
      if (session.expiresAt <= now()) return { ok: false, reason: 'EXPIRED' };
      if (!(await options.canAccessProject(session.userId, request.projectId))) {
        return { ok: false, reason: 'PROJECT_MISMATCH' };
      }
      if (!(await options.isValidDocument(request.projectId, request.documentId))) {
        return { ok: false, reason: 'INVALID_DOCUMENT' };
      }
      return {
        ok: true,
        scope: {
          sessionId: session.sessionId,
          userId: session.userId,
          projectId: request.projectId,
          documentId: request.documentId,
        },
      };
    },
  };
}

/**
 * Typed Yjs persistence port. The gateway never sees SQL, the database
 * driver, or the worker plumbing — only these two domain operations.
 */
export interface YjsPersistencePort {
  loadWorkingDocument(key: YjsDocumentKey): Promise<WorkingDocumentState | null>;
  persistYjsUpdate(input: PersistYjsUpdateInput): Promise<WorkingDocumentState>;
}

/** Domain adapter over the persistence worker client; typed operations only. */
export function createYjsPersistencePort(client: PersistenceWorkerClient): YjsPersistencePort {
  return {
    loadWorkingDocument: (key) => client.request('loadWorkingDocument', key),
    persistYjsUpdate: (input) => client.request('persistYjsUpdate', input),
  };
}

export interface YjsGatewayOptions {
  readonly auth: YjsAuthPort;
  readonly persistence: YjsPersistencePort;
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

const SCOPE_SEPARATOR = '\u0000';

export function createYjsGateway(options: YjsGatewayOptions): YjsGateway {
  /** One bound working document: the canonical doc plus its live connections. */
  interface DocumentRuntime {
    doc: Y.Doc;
    connections: Set<YjsGatewayConnectionImpl>;
  }
  const auth = options.auth;
  const persistence = options.persistence;
  const sessions = options.sessions;
  const now = options.now ?? (() => new Date().toISOString());
  /** Canonical in-memory working docs, keyed by exact project/document scope. */
  const documents = new Map<string, DocumentRuntime>();
  /** projectId → (userId → open connection count) for presence refcounting. */
  const presence = new Map<string, Map<string, number>>();
  const connections = new Set<YjsGatewayConnectionImpl>();
  /**
   * Fail-closed shutdown flag. Once set by `close()`, new connects and
   * updates are rejected and only already-queued per-document operations
   * drain; `open()` clears it for the next listen cycle.
   */
  let closing = false;
  /**
   * Per-key serialization tails. Every read-merge-persist-swap on a working
   * document runs strictly in enqueue order per project/document scope, so
   * concurrent updates merge onto the canonical state instead of a
   * last-writer-wins overwrite of each other's persisted bytes.
   */
  const tails = new Map<string, Promise<unknown>>();
  const enqueue = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const prior = tails.get(key) ?? Promise.resolve();
    const slot = prior.then(run, run);
    tails.set(
      key,
      slot.then(
        () => undefined,
        () => undefined,
      ),
    );
    return slot;
  };

  const keyOf = (scope: YjsConnectionScope): string =>
    `${scope.projectId}${SCOPE_SEPARATOR}${scope.documentId}`;

  /**
   * Denial reason when the post-hydration re-resolution drifted from the
   * scope resolved before queueing. The transport authenticated against the
   * pre-queue scope; binding to a different actor/project/document would let
   * a changed session row redirect a live request, so any drift rejects.
   */
  const scopeDriftReason = (
    expected: YjsConnectionScope,
    actual: YjsConnectionScope,
  ): YjsDenialReason | null => {
    if (expected.sessionId !== actual.sessionId || expected.userId !== actual.userId) {
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

  class YjsGatewayConnectionImpl implements YjsGatewayConnection {
    readonly scope: YjsConnectionScope;
    #closed = false;

    constructor(scope: YjsConnectionScope) {
      this.scope = scope;
    }

    async applyUpdate(update: Uint8Array): Promise<YjsApplyResult> {
      if (this.#closed) return { ok: false, reason: 'CONNECTION_CLOSED' };
      // Serialized per exact project/document scope: the read-merge-persist
      // section below runs atomically for the key, so concurrent updates
      // merge onto the canonical document before the typed persist instead of
      // racing a last-writer overwrite.
      return enqueue(keyOf(this.scope), async () => {
        if (this.#closed) return { ok: false, reason: 'CONNECTION_CLOSED' };
        // Every state change re-authenticates server-side against the bound
        // scope: revocation or expiry stops the next update at the next safe
        // checkpoint.
        const resolution = await auth.resolve(this.scope);
        if (!resolution.ok) return { ok: false, reason: resolution.reason };
        // The connection may have been closed (Host shutdown) while the
        // revalidation was in flight: fail closed at this checkpoint without
        // persisting anything further.
        if (this.#closed) return { ok: false, reason: 'CONNECTION_CLOSED' };
        const runtime = documents.get(keyOf(this.scope));
        if (runtime === undefined) return { ok: false, reason: 'CONNECTION_CLOSED' };
        // Validate against a scratch copy: a corrupt update must never advance
        // the canonical working document.
        const merged = new Y.Doc();
        try {
          Y.applyUpdate(merged, Y.encodeStateAsUpdate(runtime.doc));
          Y.applyUpdate(merged, update);
        } catch {
          return { ok: false, reason: 'INVALID_UPDATE' };
        }
        let state: WorkingDocumentState;
        try {
          state = await persistence.persistYjsUpdate({
            projectId: this.scope.projectId,
            documentId: this.scope.documentId,
            update: Y.encodeStateAsUpdate(merged),
            stateVector: Y.encodeStateVector(merged),
          });
        } catch {
          // Last-valid persisted state stays authoritative: the canonical doc
          // is only ever advanced past what was durably persisted.
          return { ok: false, reason: 'STORAGE_UNAVAILABLE' };
        }
        // A disconnect/close racing this persist may have torn the runtime
        // down (zero live connections). The persisted state stays
        // authoritative, but the canonical in-memory runtime must never be
        // resurrected with no live connection holding it.
        if (runtime.connections.size === 0) return { ok: true, state };
        documents.set(keyOf(this.scope), { doc: merged, connections: runtime.connections });
        return { ok: true, state };
      });
    }

    disconnect(): ProjectSessionProjectionV1 | null {
      if (this.#closed) return null;
      this.#closed = true;
      connections.delete(this);
      const key = keyOf(this.scope);
      const runtime = documents.get(key);
      if (runtime !== undefined) {
        runtime.connections.delete(this);
        if (runtime.connections.size === 0) documents.delete(key);
      }
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
      closing = false;
    },
    async connect(request: YjsConnectionRequest): Promise<YjsGatewayConnectResult> {
      if (closing) return { ok: false, reason: 'CONNECTION_CLOSED' };
      const resolution = await auth.resolve(request);
      if (!resolution.ok) return { ok: false, reason: resolution.reason };
      const scope = resolution.scope;
      const key = keyOf(scope);
      // Bind serialized per key too: get-or-create must never interleave with
      // an applyUpdate swap that would replace the runtime under a fresh
      // connection, and the hydrated `initialState` is read inside the slot so
      // it always reflects the latest persisted state for the key.
      return enqueue(key, async (): Promise<YjsGatewayConnectResult> => {
        // Fail closed if shutdown landed before this slot ran.
        if (closing) return { ok: false, reason: 'CONNECTION_CLOSED' };
        let stored: WorkingDocumentState | null;
        try {
          stored = await persistence.loadWorkingDocument({
            projectId: scope.projectId,
            documentId: scope.documentId,
          });
        } catch {
          return { ok: false, reason: 'STORAGE_UNAVAILABLE' };
        }
        // Fail closed if shutdown landed during hydration.
        if (closing) return { ok: false, reason: 'CONNECTION_CLOSED' };
        // Re-authenticate after hydration, immediately before binding: a
        // session revoked/expired while the persisted state was loading, or
        // a scope that drifted under the live request, must not bind or
        // disclose any working state.
        const revalidated = await auth.resolve(request);
        if (!revalidated.ok) return { ok: false, reason: revalidated.reason };
        const drift = scopeDriftReason(scope, revalidated.scope);
        if (drift !== null) return { ok: false, reason: drift };
        if (closing) return { ok: false, reason: 'CONNECTION_CLOSED' };
        let runtime = documents.get(key);
        if (runtime === undefined) {
          const doc = new Y.Doc();
          if (stored !== null) {
            try {
              Y.applyUpdate(doc, stored.update);
            } catch {
              // A corrupt persisted blob is a storage fault, not a client issue.
              return { ok: false, reason: 'STORAGE_UNAVAILABLE' };
            }
          }
          runtime = { doc, connections: new Set() };
          documents.set(key, runtime);
        }
        joinPresence(scope);
        const connection = new YjsGatewayConnectionImpl(scope);
        connections.add(connection);
        runtime.connections.add(connection);
        return { ok: true, connection, initialState: stored };
      });
    },
    async close(): Promise<void> {
      // Fail closed: no new connects or updates may start after this point.
      closing = true;
      // Mark every live connection closed; presence leaves and zero-
      // connection runtimes drop synchronously.
      for (const connection of [...connections]) connection.disconnect();
      // Drain every queued/in-flight per-document operation before the close
      // resolves: slots already past their fail-closed check finish their
      // persistence, and slots still queued settle without binding or
      // persisting. `allSettled` because serialization tails never reject.
      await Promise.allSettled([...tails.values()]);
    },
  };
}

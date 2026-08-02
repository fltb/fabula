/**
 * Host-only AuthoringCoordinator port contract (Phase 0).
 *
 * The per-project AuthoringCoordinator is the single transformation point for
 * browser direct edits, in-browser Agents, external MCP tools, and the
 * filesystem watcher. This module defines the ports the coordinator consumes
 * — document materialization, authoring-tree reload (watcher), session
 * operations, Git submit, event publishing — plus the coordinator surface
 * services call. Every Phase-1 substream depends ONLY on this contract and
 * the versioned contracts in `contracts/`; nothing here names a concrete
 * host service, filesystem path, provider, database handle, or Git runner.
 *
 * Identity rules (never interchangeable): the accepted source hash is the
 * validated `ProjectSession` source identity; the observed filesystem hash is
 * what the watcher last re-read; the workspace digest is the stable sorted
 * `logicalPath + state vector` summary of the Yjs working layer; the fixed
 * Git head/submitId is the durable Git CAS identity. None of these may stand
 * in for another.
 */

import type {
  AuthoringOperationReceiptV1,
  AuthoringStateV1,
} from '../../contracts/authoring.js';
import type { GitSubmissionReceipt, YjsDocumentKey } from '../../contracts/persistence.js';

// ─── Document materialization ───────────────────────────────────────────────

/**
 * Materializes Yjs working documents into UTF-8 source text for a submit or
 * reconcile candidate. The implementation reuses the Yjs gateway's
 * per-document persistence/serialization — never a second CRDT/store. The
 * coordinator only ever sees opaque keys and materialized text.
 */
export interface AuthoringDocumentMaterializer {
  /** Resolve a working document key to its manifest logical path; null when unknown. */
  logicalPath(key: YjsDocumentKey): string | null;
  /** Materialize working documents to source text for a candidate. */
  materialize(input: {
    readonly projectId: string;
    readonly documents: readonly { readonly documentId: string; readonly logicalPath: string }[];
  }): Promise<{
    readonly entries: readonly { readonly logicalPath: string; readonly content: string }[];
  }>;
}

// ─── Authoring-tree reload (watcher) ────────────────────────────────────────

/** One full re-read of the external authoring tree. */
export interface AuthoringTreeSnapshot {
  readonly projectId: string;
  /** Full authoring-tree content hash (the observed filesystem identity). */
  readonly treeHash: string;
  /** Manifest-approved entries in stable logical-path order. */
  readonly entries: readonly { readonly logicalPath: string; readonly content: string }[];
  readonly diagnostics: readonly {
    readonly code: string;
    readonly severity: 'error' | 'warning' | 'info';
    readonly message: string;
    readonly logicalPath: string | null;
  }[];
  readonly observedAt: string;
}

/**
 * Full re-read of the authoring tree the watcher tracks (an adapter over the
 * allowed authoring-manifest topology — `.git`, `.nova`, cache, output and
 * Host staging are excluded). The watcher only produces external candidates;
 * it never accepts or commits anything.
 */
export interface AuthoringTreeLoader {
  loadTree(input: { readonly projectId: string }): Promise<AuthoringTreeSnapshot>;
}

// ─── Session operations ─────────────────────────────────────────────────────

/**
 * Runs an effect strictly serially inside the project session's
 * capability-gated operation queue (an adapter over
 * `ProjectSession.enqueueOperation`). The gate re-validates the persisted
 * grant (existence, version, revocation, expiry, project, scope) immediately
 * before the effect runs and records typed secret-free audit metadata.
 */
export interface AuthoringSessionOperationPort {
  enqueue(input: {
    readonly projectId: string;
    readonly capabilityId: string;
    readonly scopes: readonly string[];
    readonly expectedVersion?: number;
    readonly kind: string;
    readonly run: (context: {
      readonly operationId: string;
      readonly now: () => string;
    }) => Promise<unknown> | unknown;
  }): Promise<
    | { readonly status: 'completed'; readonly operationId: string }
    | { readonly status: 'denied'; readonly operationId: string; readonly reason: string }
    | { readonly status: 'failed'; readonly operationId: string; readonly message: string }
  >;
}

// ─── Git submit ─────────────────────────────────────────────────────────────

/** Typed submit outcome from the Git authoring service (exact-once journal). */
export type AuthoringGitSubmitOutcome =
  | { readonly status: 'accepted'; readonly receipt: GitSubmissionReceipt }
  | { readonly status: 'stale'; readonly reason: string }
  | { readonly status: 'conflict'; readonly reason: string }
  | { readonly status: 'invalid'; readonly code: string; readonly reason: string };

/**
 * The only Git authoring acceptance path (an adapter over
 * `GitAuthoringSubmitService`). The adapter owns manifest validation, the
 * isolated index, the fixed-ref CAS and the durable journal; the coordinator
 * supplies the byte-exact candidate and the expected identities.
 */
export interface AuthoringGitSubmitPort {
  submit(input: {
    readonly projectId: string;
    /** Stable submit id used as the exact-once journal key. */
    readonly submitId: string;
    /** Fixed Git ref head the submit must still build on (CAS old value). */
    readonly expectedGitHead: string;
    /** Stable workspace digest the submit must still confirm against. */
    readonly expectedWorkspaceDigest: string;
    /** Manifest-approved candidate entries (UTF-8 source text). */
    readonly entries: readonly { readonly logicalPath: string; readonly content: string }[];
    /** Non-secret content hash of the candidate source. */
    readonly sourceHash: string;
    readonly message: string;
    /** Authenticated actor; recorded in commit trailers, never caller-chosen. */
    readonly actorId: string;
    /** Optional capability under which the actor submitted. */
    readonly capabilityId?: string;
  }): Promise<AuthoringGitSubmitOutcome>;
}

// ─── Event publishing ───────────────────────────────────────────────────────

/** Typed coordinator events broadcast to connected surfaces (SSE) and audit. */
export type AuthoringCoordinatorEvent =
  | {
      readonly type: 'state-changed';
      readonly projectId: string;
      readonly state: AuthoringStateV1;
      readonly at: string;
    }
  | {
      readonly type: 'operation-updated';
      readonly projectId: string;
      readonly receipt: AuthoringOperationReceiptV1;
      readonly at: string;
    }
  | {
      readonly type: 'submit-receipt';
      readonly projectId: string;
      readonly submitId: string;
      readonly gitReceiptHash: string;
      readonly acceptedSourceHash: string;
      readonly at: string;
    };

/** Publishes coordinator events; never holds raw source, tokens or keys. */
export interface AuthoringEventPublisher {
  publish(event: AuthoringCoordinatorEvent): void;
}

// ─── Coordinator surface ────────────────────────────────────────────────────

/** Explicit submit request into the coordinator. */
export interface AuthoringSubmitInput {
  /** CAS on the accepted source; a moved projection rejects before any work. */
  readonly expectedAcceptedSourceHash: string | null;
  /** CAS on the working layer; a changed digest is `WORKSPACE_STALE`. */
  readonly expectedWorkspaceDigest: string;
  readonly message?: string;
  /** Authenticated actor; the capability binding comes from the persisted grant. */
  readonly actorId: string;
  /** Opaque grant id; actor and scope truth come from the persisted grant. */
  readonly capabilityId: string;
  /** Capability scopes required for this submit; validated by the session gate. */
  readonly capabilityScopes: readonly string[];
}

/** Reconcile/resolution request into the coordinator. */
export interface AuthoringReconcileInput {
  readonly choice: 'keep-working' | 'accept-external' | 'apply-proposed-disjoint-merge';
  /** Required for accept-external/apply-proposed-disjoint-merge. */
  readonly candidateHash: string | null;
  readonly expectedAcceptedSourceHash: string | null;
  readonly actorId: string;
  readonly capabilityId: string;
  readonly capabilityScopes: readonly string[];
}

/**
 * The per-project AuthoringCoordinator surface. All four write entries
 * (browser direct edit, in-browser Agent, external MCP, filesystem watcher)
 * funnel through this single transformation point; Core never knows it and
 * the browser never holds equivalent state.
 */
export interface AuthoringCoordinator {
  readonly projectId: string;
  /** Current browser-safe authoring state. */
  getState(): AuthoringStateV1;
  /** Recent operation receipts for the browser/MCP operation center. */
  listOperations(): readonly AuthoringOperationReceiptV1[];
  /** One operation receipt, or null when the id is unknown. */
  getOperation(operationId: string): AuthoringOperationReceiptV1 | null;
  /** Whether authoring conflicts/recovery require agents to pause. */
  isAgentPaused(): boolean;
  /**
   * Watcher notification. The event is only a hint: the coordinator debounces
   * and then performs a full {@link AuthoringTreeLoader.loadTree} re-read
   * before producing an external candidate.
   */
  notifyExternalChange(input: { readonly hintPaths?: readonly string[] }): Promise<void>;
  /** Explicit submit under the coordinator lock; returns the operation receipt. */
  submit(input: AuthoringSubmitInput): Promise<AuthoringOperationReceiptV1>;
  /** Reconcile an external candidate or resolve a conflict. */
  reconcileExternal(input: AuthoringReconcileInput): Promise<AuthoringOperationReceiptV1>;
  /**
   * Serial adoption hook: after a Git receipt the coordinator reloads the
   * source, verifies the resulting hash equals `expectedSourceHash`, and
   * refreshes the session projection inside the same serial operation.
   */
  refreshAccepted(input: { readonly expectedSourceHash: string }): Promise<void>;
  dispose(): Promise<void>;
}

/** Assembly inputs for the Phase-1 coordinator implementation. */
export interface AuthoringCoordinatorOptions {
  readonly projectId: string;
  readonly materializer: AuthoringDocumentMaterializer;
  readonly treeLoader: AuthoringTreeLoader;
  readonly sessions: AuthoringSessionOperationPort;
  readonly git: AuthoringGitSubmitPort;
  readonly events: AuthoringEventPublisher;
  readonly now?: () => string;
}

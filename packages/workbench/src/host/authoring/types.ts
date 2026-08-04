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

import type { AuthoringOperationReceiptV1, AuthoringStateV1 } from '../../contracts/authoring.js';
import type { YjsDocumentKey } from '../../contracts/persistence.js';

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

// ─── Native revision operation phases ───────────────────────────────────────

/** Immutable operation phases for the native revision backend. */
export type AuthoringNativeOperationPhase =
  | 'prepared'
  | 'accepted'
  | 'materializing'
  | 'materialized'
  | 'completed'
  | 'stale'
  | 'conflict'
  | 'recovery-required';

// ─── Native revision backend ────────────────────────────────────────────────

/** Per-path content hash entry for materialization tracking. */
export interface AuthoringPathHashEntry {
  readonly logicalPath: string;
  readonly hash: string;
}

/** Result of a source view materializer inspect call. */
export interface AuthoringSourceViewInspectResult {
  readonly projectId: string;
  /** SHA-256 of the entire approved tree (same as ProjectSourceSnapshotV1.sourceHash). */
  readonly treeHash: string;
  /** Per-path content hashes in stable logical-path order. */
  readonly perPathHashes: readonly AuthoringPathHashEntry[];
  /** Current materialized revision ID, or null when never materialized. */
  readonly materializedRevisionId: string | null;
}

/** Outcome of a source view materializer materialize call. */
export type AuthoringMaterializeOutcome =
  | { readonly status: 'completed'; readonly treeHash: string }
  | { readonly status: 'external-candidate'; readonly reason: string }
  | { readonly status: 'recovery-required'; readonly reason: string };

/**
 * Backend-neutral seam for the native revision backend.
 * Replaces the previous Git-only AuthoringGitSubmitPort.
 * Every submit/restore is a CAS operation keyed by expected revision identity
 * and source hash; duplicate operationId calls replay the recorded result.
 */
export interface AuthoringRevisionPort {
  /** Load the current accepted revision metadata, or null if none exists. */
  loadAccepted(projectId: string): Promise<{
    readonly revisionId: string;
    readonly sourceHash: string;
    readonly bundleHash: string;
  } | null>;

  /**
   * Submit a new candidate revision. The operation is exact-once: a duplicate
   * operationId replays the recorded result without re-executing.
   */
  submit(input: {
    readonly projectId: string;
    readonly candidate: {
      readonly entries: readonly { readonly logicalPath: string; readonly content: string }[];
      readonly sourceHash: string;
      readonly bundleHash: string;
    };
    readonly expectedRevisionId: string | null;
    readonly expectedSourceHash: string | null;
    readonly operationId: string;
    readonly actorId: string;
  }): Promise<
    | { readonly status: 'accepted'; readonly revisionId: string; readonly receiptHash: string }
    | { readonly status: 'stale'; readonly reason: string }
    | { readonly status: 'conflict'; readonly reason: string }
    | { readonly status: 'invalid'; readonly code: string; readonly reason: string }
  >;

  /**
   * Run recovery after a crash or restart. Returns the recovery outcome:
   * completed when the accepted head is intact, recovery-required when
   * external edits or corruption are detected, stale when a moved head was
   * found, or initial-load when no native head exists and the portable YAML
   * tree was loaded as a baseline.
   */
  recover(projectId: string): Promise<
    | {
        readonly status: 'completed';
        readonly revisionId: string;
        readonly materializedRevisionId: string;
      }
    | { readonly status: 'recovery-required'; readonly reason: string }
    | { readonly status: 'stale'; readonly reason: string }
    | { readonly status: 'initial-load'; readonly revisionId: string; readonly sourceHash: string }
  >;

  /** List revisions, oldest first. Cursor is opaque. */
  list(
    projectId: string,
    cursor?: string,
  ): Promise<{
    readonly revisions: readonly AuthoringRevisionSummary[];
    readonly nextCursor?: string;
  }>;

  /** Read one project-scoped immutable revision metadata record. */
  get(projectId: string, revisionId: string): Promise<AuthoringRevisionSummary | null>;

  /** Compute the diff between two revisions. */
  diff(
    projectId: string,
    fromRevisionId: string,
    toRevisionId: string,
  ): Promise<{ readonly changes: readonly AuthoringRevisionChange[] }>;

  /**
   * Restore a previous revision as a new child revision. Never moves the
   * native head backward; always creates a forward revision whose content
   * matches the restored revision.
   */
  restore(input: {
    readonly projectId: string;
    readonly revisionId: string;
    readonly expectedAcceptedRevisionId: string | null;
    readonly expectedSourceHash: string | null;
    readonly operationId: string;
    readonly actorId: string;
  }): Promise<
    | { readonly status: 'accepted'; readonly revisionId: string; readonly receiptHash: string }
    | { readonly status: 'stale'; readonly reason: string }
    | { readonly status: 'conflict'; readonly reason: string }
    | { readonly status: 'invalid'; readonly code: string; readonly reason: string }
  >;
}

/** Safe revision metadata returned by the native revision backend. */
export interface AuthoringRevisionSummary {
  readonly revisionId: string;
  readonly sourceHash: string;
  readonly bundleHash: string;
  readonly createdAt: string;
  readonly acceptedAt: string;
}

/** Hash-only path change between two native revisions. */
export interface AuthoringRevisionChange {
  readonly logicalPath: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
}

/**
 * Immutable content-addressed bundle store for native revision source
 * revisions. Stored under
 * `$WORKBENCH_HOME/projects/<projectId>/source-revisions/objects/sha256/<first-two>/<full-hash>`.
 * Bundles are write-once, read-many. Storage is file-based and survives
 * restarts.
 */
export interface AuthoringRevisionContentStore {
  /** Persist an immutable bundle. Idempotent for the same bundleHash. */
  put(input: {
    readonly projectId: string;
    readonly bundleHash: string;
    readonly entries: readonly { readonly logicalPath: string; readonly content: string }[];
  }): Promise<void>;

  /** Retrieve a previously stored bundle, or null when missing. */
  get(input: { readonly projectId: string; readonly bundleHash: string }): Promise<{
    readonly entries: readonly { readonly logicalPath: string; readonly content: string }[];
  } | null>;
}

/**
 * Approved-tree materializer with expected-revision CAS.
 *
 * Materializes a complete bundle of approved source entries to the project
 * filesystem tree under the shared root directory lock. Only touches paths
 * approved by the neutral authoring manifest; explicitly deletes approved
 * paths omitted from the target bundle; preserves references/, .nova/, .git/,
 * output/, caches, and unrelated files. Verifies the resulting tree through
 * FileProjectSourceLoader.
 */
export interface AuthoringSourceViewMaterializer {
  /**
   * Inspect the current approved tree and return the tree hash, per-path
   * hashes, and current materialized revision ID. Never mutates files.
   */
  inspect(projectId: string): Promise<AuthoringSourceViewInspectResult>;

  /**
   * Materialize a complete bundle onto the approved project tree.
   *
   * Before any write, acquires the shared per-root write lock, re-inspects
   * the tree, and verifies that expectedMaterializedRevisionId and
   * expectedTreeHash match. On mismatch, returns external-candidate without
   * writing. On success, writes all entries, deletes omitted approved paths,
   * verifies through FileProjectSourceLoader, and returns completed.
   */
  materialize(input: {
    readonly projectId: string;
    readonly expectedMaterializedRevisionId: string | null;
    readonly expectedTreeHash: string;
    readonly bundle: {
      readonly bundleHash: string;
      readonly entries: readonly { readonly logicalPath: string; readonly content: string }[];
    };
  }): Promise<AuthoringMaterializeOutcome>;
}

/**
 * Optional post-acceptance revision mirror adapter (e.g., Git best-effort).
 * Its external IDs never cross the native revision CAS or Core source
 * contracts. The mirror is best-effort: failure records an audit event but
 * does not roll back the native revision.
 */
export interface AuthoringRevisionMirror {
  /** Probe whether the mirror backend is available for this project. */
  probe(projectId: string): Promise<{ readonly available: boolean; readonly reason?: string }>;

  /** Export an accepted revision to the mirror. */
  export(input: {
    readonly projectId: string;
    readonly revisionId: string;
    readonly bundle: {
      readonly bundleHash: string;
      readonly entries: readonly { readonly logicalPath: string; readonly content: string }[];
    };
  }): Promise<
    | { readonly status: 'exported'; readonly externalId: string }
    | { readonly status: 'failed'; readonly diagnostic: string }
  >;

  /** Inspect the current mirror state for this project. */
  inspect(projectId: string): Promise<{
    readonly status: 'active' | 'disabled' | 'failed';
    readonly externalHeadId?: string;
    readonly diagnostic?: string;
  }>;
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
      readonly operationId: string;
      readonly receiptHash: string;
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
  /** Refresh the browser-safe dirty/digest projection after a Yjs persist. */
  refreshWorkingState(): Promise<void>;
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
  readonly revision: AuthoringRevisionPort;
  readonly sourceViewMaterializer: AuthoringSourceViewMaterializer;
  readonly events: AuthoringEventPublisher;
  readonly now?: () => string;
}

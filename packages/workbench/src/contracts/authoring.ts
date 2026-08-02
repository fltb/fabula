/**
 * Authoring coordination contract — the shared wire shapes for the
 * per-project AuthoringCoordinator: workspace digest identity, authoring
 * state machine, external candidates, conflicts, operation receipts, the
 * browser submit/reconcile surface, and the strict MCP authoring tool I/O.
 *
 * The coordinator is the single transformation point for browser direct
 * edits, in-browser Agents, external MCP tools, and the filesystem watcher;
 * these DTOs are what every surface reads and what the guarded mutation
 * endpoints accept.
 *
 * BOUNDARY: this module is browser-safe as a whole — it carries no
 * filesystem paths, no tokens or provider keys, no raw Yjs bytes, no SQL and
 * no Host handles. Working-layer identity is carried as content/state-vector
 * hashes and a stable workspace digest, never as document bytes. Logical
 * paths are manifest-relative (`nova.yaml`, `definitions/state_initial.yaml`),
 * never absolute filesystem paths.
 */

import { BROWSER_API_BASE_PATH } from './browser-api.js';

/** Version of the authoring coordination contract. */
export const AUTHORING_CONTRACT_VERSION = 1 as const;
export type AuthoringContractVersion = typeof AUTHORING_CONTRACT_VERSION;

// ─── Workspace digest ───────────────────────────────────────────────────────

/** One working document's stable digest identity: logical path + state-vector hash. */
export interface AuthoringDocumentDigestV1 {
  /** Manifest-relative logical path (e.g. `nova.yaml`); never an absolute path. */
  readonly logicalPath: string;
  /** SHA-256 of the document's Yjs state vector, hex. */
  readonly stateVectorHash: string;
}

/**
 * Stable sorted summary of a project's Yjs working layer — the submit
 * precondition identity. Documents are sorted by `logicalPath`, each path at
 * most once, and `digest` is the hash over that stable list. Never carries
 * document bytes.
 */
export interface AuthoringWorkspaceDigestV1 {
  readonly version: AuthoringContractVersion;
  readonly projectId: string;
  readonly documents: readonly AuthoringDocumentDigestV1[];
  /** SHA-256 over the stable document list, hex. */
  readonly digest: string;
  readonly generatedAt: string;
}

// ─── Authoring state machine ────────────────────────────────────────────────

/** Canonical coordinator phases (single source of truth). */
export const AUTHORING_PHASE_VALUES = [
  'clean',
  'working-dirty',
  'external-pending',
  'dual-conflict',
  'candidate-invalid',
  'submitting',
  'accepted',
  'stale',
  'conflict',
  'recovery-required',
] as const;

/** Phase of the per-project authoring state machine. */
export type AuthoringPhaseV1 = (typeof AUTHORING_PHASE_VALUES)[number];
/** Conflict classes the coordinator can persist (single source of truth). */
export type AuthoringConflictKindV1 = 'working-vs-external';

/** One typed source diagnostic (same shape as the session projection diagnostics). */
export interface AuthoringDiagnosticV1 {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
  readonly logicalPath: string | null;
}

/** Per-document working-vs-external conflict. Hashes only; content is fetched separately. */
export interface AuthoringConflictV1 {
  readonly logicalPath: string;
  readonly kind: 'working-vs-external';
  /** Accepted (base) source hash at conflict detection. */
  readonly baseSourceHash: string;
  /** Hash of the working-layer content. */
  readonly workingHash: string;
  /** Hash of the observed external content. */
  readonly externalHash: string;
  /** True when the paths are disjoint and a proposed merge candidate exists. */
  readonly proposedDisjointMerge: boolean;
}

/**
 * One observed external (hand-written filesystem) candidate. `candidateHash`
 * is the full authoring-tree hash the watcher captured; `valid` reports
 * whether the candidate passed Core validation. The accepted projection is
 * never replaced by an invalid candidate.
 */
export interface AuthoringExternalCandidateV1 {
  readonly candidateHash: string;
  readonly detectedAt: string;
  readonly valid: boolean;
  /** Manifest-relative logical paths that changed, stable order. */
  readonly changedLogicalPaths: readonly string[];
  readonly diagnostics: readonly AuthoringDiagnosticV1[];
}

/** Why submit is currently blocked; `none` means submit may be attempted. */
export type AuthoringSubmitBlockReasonV1 =
  | 'none'
  | 'not-dirty'
  | 'candidate-invalid'
  | 'conflict-requires-resolution'
  | 'external-candidate-pending'
  | 'submission-in-flight'
  | 'recovery-required';

/** Browser-safe authoring state view for one project. */
export interface AuthoringStateV1 {
  readonly version: AuthoringContractVersion;
  readonly projectId: string;
  readonly phase: AuthoringPhaseV1;
  /** Accepted last-valid source identity; null before the first accepted load. */
  readonly acceptedSourceHash: string | null;
  /** True when the Yjs working layer differs from the accepted source. */
  readonly workingDirty: boolean;
  /** Current workspace digest, or null when no working documents exist. */
  readonly workspaceDigest: string | null;
  readonly externalCandidate: AuthoringExternalCandidateV1 | null;
  readonly conflicts: readonly AuthoringConflictV1[];
  readonly diagnostics: readonly AuthoringDiagnosticV1[];
  readonly canSubmit: boolean;
  readonly submitBlockReason: AuthoringSubmitBlockReasonV1;
  readonly generatedAt: string;
}

// ─── Operation receipts ─────────────────────────────────────────────────────

/** Async authoring operation kinds the Operation Center tracks. */
export type AuthoringOperationKindV1 = 'submit' | 'reconcile-external' | 'resolve-conflict';

/** Lifecycle status of one queued authoring operation. */
export type AuthoringOperationStatusV1 =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stale'
  | 'conflict';

/** Secret-free receipt of one async authoring operation. */
export interface AuthoringOperationReceiptV1 {
  readonly version: AuthoringContractVersion;
  readonly operationId: string;
  readonly projectId: string;
  readonly kind: AuthoringOperationKindV1;
  readonly status: AuthoringOperationStatusV1;
  readonly acceptedSourceHash: string | null;
  readonly workspaceDigest: string | null;
  /** Fixed-ref Git submit id when the operation ran a submit. */
  readonly gitSubmitId: string | null;
  /** Durable Git receipt hash when the operation accepted a submit. */
  readonly gitReceiptHash: string | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Durable Git authoring receipt projection (non-secret). */
export interface AuthoringSubmitReceiptV1 {
  readonly version: AuthoringContractVersion;
  readonly projectId: string;
  readonly submitId: string;
  /** Full accepted Git commit object id. */
  readonly gitCommit: string;
  /** Verified accepted source hash after reload. */
  readonly acceptedSourceHash: string;
  readonly gitReceiptHash: string;
  readonly acceptedAt: string;
}

// ─── Failures ───────────────────────────────────────────────────────────────

/** Typed authoring failures shared by browser and MCP surfaces. */
export type AuthoringFailureCodeV1 =
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_NOT_READY'
  | 'WORKSPACE_STALE'
  | 'ACCEPTED_HASH_MISMATCH'
  | 'DOCUMENT_NOT_FOUND'
  | 'CANDIDATE_INVALID'
  | 'CONFLICT_REQUIRES_RESOLUTION'
  | 'SUBMIT_BLOCKED'
  | 'HUMAN_EDITING'
  | 'INVALID_INPUT'
  | 'UNKNOWN_FIELD'
  | 'INTERNAL';

/** Secret-free typed authoring failure envelope. */
export interface AuthoringFailureV1 {
  readonly code: AuthoringFailureCodeV1;
  readonly message: string;
}

// ─── Browser submit / reconcile surface ─────────────────────────────────────

/** Explicit browser submit request (Ctrl/Cmd+S is the only save-to-Git path). */
export interface BrowserAuthoringSubmitRequestV1 {
  readonly version: AuthoringContractVersion;
  readonly projectId: string;
  /** CAS on the accepted source; moved projection rejects before any work. */
  readonly expectedAcceptedSourceHash: string | null;
  /** CAS on the working layer; a changed digest is `WORKSPACE_STALE`. */
  readonly expectedWorkspaceDigest: string;
  readonly message?: string;
}

/** Predefined reconcile/resolution choices for external candidates/conflicts. */
export type AuthoringReconcileChoiceV1 =
  | 'keep-working'
  | 'accept-external'
  | 'apply-proposed-disjoint-merge';

/** Explicit reconcile of an external candidate (or conflict resolution). */
export interface BrowserAuthoringReconcileRequestV1 {
  readonly version: AuthoringContractVersion;
  readonly projectId: string;
  readonly choice: AuthoringReconcileChoiceV1;
  /** Required for accept-external/apply-proposed-disjoint-merge: exact candidate hash. */
  readonly candidateHash: string | null;
  readonly expectedAcceptedSourceHash: string | null;
}

/** Immediate result of a browser submit; async work continues via the operation receipt. */
export type BrowserAuthoringSubmitResultV1 =
  | { readonly status: 'queued'; readonly receipt: AuthoringOperationReceiptV1 }
  | { readonly status: 'rejected'; readonly failure: AuthoringFailureV1 }
  | {
      readonly status: 'completed';
      readonly receipt: AuthoringOperationReceiptV1;
      readonly submit: AuthoringSubmitReceiptV1;
    };

/** Immediate result of a browser reconcile/conflict-resolution request. */
export type BrowserAuthoringReconcileResultV1 =
  | { readonly status: 'queued'; readonly receipt: AuthoringOperationReceiptV1 }
  | { readonly status: 'rejected'; readonly failure: AuthoringFailureV1 }
  | { readonly status: 'completed'; readonly receipt: AuthoringOperationReceiptV1 };

// ─── Safe activity events (SSE stream) ──────────────────────────────────────

/** Typed authoring activity events broadcast to connected clients. */
export type AuthoringActivityEventV1 =
  | {
      readonly type: 'state-changed';
      readonly version: AuthoringContractVersion;
      readonly projectId: string;
      readonly state: AuthoringStateV1;
      readonly at: string;
    }
  | {
      readonly type: 'operation-updated';
      readonly version: AuthoringContractVersion;
      readonly projectId: string;
      readonly receipt: AuthoringOperationReceiptV1;
      readonly at: string;
    }
  | {
      readonly type: 'submit-receipt';
      readonly version: AuthoringContractVersion;
      readonly projectId: string;
      readonly receipt: AuthoringSubmitReceiptV1;
      readonly at: string;
    }
  | {
      readonly type: 'external-candidate';
      readonly version: AuthoringContractVersion;
      readonly projectId: string;
      readonly candidate: AuthoringExternalCandidateV1;
      readonly at: string;
    }
  | {
      readonly type: 'presence-changed';
      readonly version: AuthoringContractVersion;
      readonly projectId: string;
      /** Monotonic session presence generation; no session or capability data. */
      readonly generation: number;
      /** Safe collaborator projection only; never raw Yjs or credentials. */
      readonly presence: readonly AuthoringPresenceMemberV1[];
      readonly at: string;
    };

/** Safe collaborator identity carried only by the authoring activity stream. */
export interface AuthoringPresenceMemberV1 {
  readonly actorId: string;
  readonly surface: 'browser' | 'mcp' | 'yjs' | 'agent';
  readonly since: string;
}

// ─── Browser authoring API paths ────────────────────────────────────────────

/** Base path of the guarded browser authoring mutation surface. */
export const BROWSER_AUTHORING_BASE_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/authoring`;
/** `GET .../authoring/state` — current authoring state. */
export const BROWSER_AUTHORING_STATE_PATH = `${BROWSER_AUTHORING_BASE_PATH}/state`;
/** `POST .../authoring/submit` — explicit submit. */
export const BROWSER_AUTHORING_SUBMIT_PATH = `${BROWSER_AUTHORING_BASE_PATH}/submit`;
/** `POST .../authoring/reconcile` — external candidate reconcile / conflict resolution. */
export const BROWSER_AUTHORING_RECONCILE_PATH = `${BROWSER_AUTHORING_BASE_PATH}/reconcile`;
/** `GET .../authoring/operations` — operation list. */
export const BROWSER_AUTHORING_OPERATIONS_PATH = `${BROWSER_AUTHORING_BASE_PATH}/operations`;
/** `GET .../authoring/operations/:operationId` — one operation receipt. */
export const BROWSER_AUTHORING_OPERATION_PATH = `${BROWSER_AUTHORING_BASE_PATH}/operations/:operationId`;
/** `GET .../authoring/events` — guarded activity stream. */
export const BROWSER_AUTHORING_EVENTS_PATH = `${BROWSER_AUTHORING_BASE_PATH}/events`;


// ─── Strict MCP authoring tool I/O ──────────────────────────────────────────

/** Scope for document-level authoring tools (never implicit with read/render). */
export const MCP_AUTHOR_SCOPE = 'mcp:author';
/** Scope for explicit submit tools. */
export const MCP_SUBMIT_SCOPE = 'mcp:submit';

/** Scoped MCP authoring tool names. */
export const MCP_TOOL_AUTHORING_STATUS = 'nova_authoring_status';
export const MCP_TOOL_AUTHORING_DOCUMENT_GET = 'nova_authoring_document_get';
export const MCP_TOOL_AUTHORING_APPLY = 'nova_authoring_apply';
export const MCP_TOOL_AUTHORING_SUBMIT = 'nova_authoring_submit';
export const MCP_TOOL_OPERATION_GET = 'nova_operation_get';
export const MCP_TOOL_CONFLICT_RESOLVE = 'nova_conflict_resolve';

/** `nova_authoring_status` input; strict, no unknown fields accepted. */
export interface McpAuthoringStatusInputV1 {
  readonly version: AuthoringContractVersion;
  readonly projectId: string;
}
/** `nova_authoring_status` output. */
export interface McpAuthoringStatusOutputV1 {
  readonly version: AuthoringContractVersion;
  readonly projectId: string;
  readonly state: AuthoringStateV1;
  readonly generatedAt: string;
}

/** `nova_authoring_document_get` input. */
export interface McpAuthoringDocumentGetInputV1 {
  readonly version: AuthoringContractVersion;
  readonly projectId: string;
  readonly documentId: string;
}
/** `nova_authoring_document_get` output: identity and hashes, never document bytes. */
export interface McpAuthoringDocumentGetOutputV1 {
  readonly version: AuthoringContractVersion;
  readonly projectId: string;
  readonly documentId: string;
  readonly logicalPath: string | null;
  /** True when the Host currently has a live working document for this key. */
  readonly available: boolean;
  readonly stateVectorHash: string | null;
  readonly acceptedSourceHash: string | null;
}

/**
 * `nova_authoring_apply` input: a strict full-replacement write to one
 * working document, CAS-bound to the workspace digest and accepted source
 * hash. A stale/conflicting digest is a typed failure — never last-writer-wins.
 */
export interface McpAuthoringApplyInputV1 {
  readonly version: AuthoringContractVersion;
  readonly projectId: string;
  readonly documentId: string;
  readonly expectedWorkspaceDigest: string;
  readonly expectedAcceptedSourceHash: string | null;
  /** Full replacement text for the working document; never a patch or partial edit. */
  readonly replacementText: string;
}
/** `nova_authoring_apply` output. */
export type McpAuthoringApplyOutputV1 =
  | {
      readonly status: 'applied';
      readonly workspaceDigest: string;
      readonly stateVectorHash: string;
    }
  | { readonly status: 'stale'; readonly failure: AuthoringFailureV1 }
  | { readonly status: 'conflict'; readonly failure: AuthoringFailureV1 }
  | { readonly status: 'rejected'; readonly failure: AuthoringFailureV1 };

/** `nova_authoring_submit` input; the working-layer CAS is required. */
export interface McpAuthoringSubmitInputV1 {
  readonly version: AuthoringContractVersion;
  readonly projectId: string;
  readonly expectedWorkspaceDigest: string;
  readonly message?: string;
}
/** `nova_authoring_submit` output. */
export type McpAuthoringSubmitOutputV1 =
  | { readonly status: 'queued'; readonly receipt: AuthoringOperationReceiptV1 }
  | { readonly status: 'rejected'; readonly failure: AuthoringFailureV1 }
  | {
      readonly status: 'completed';
      readonly receipt: AuthoringOperationReceiptV1;
      readonly submit: AuthoringSubmitReceiptV1;
    };

/** `nova_operation_get` input. */
export interface McpOperationGetInputV1 {
  readonly version: AuthoringContractVersion;
  readonly operationId: string;
}
/** `nova_operation_get` output. */
export interface McpOperationGetOutputV1 {
  readonly version: AuthoringContractVersion;
  readonly operationId: string;
  readonly receipt: AuthoringOperationReceiptV1 | null;
}

/** `nova_conflict_resolve` input; same predefined choices as the browser surface. */
export interface McpConflictResolveInputV1 {
  readonly version: AuthoringContractVersion;
  readonly projectId: string;
  readonly choice: AuthoringReconcileChoiceV1;
  readonly candidateHash: string | null;
}
/** `nova_conflict_resolve` output. */
export type McpConflictResolveOutputV1 =
  | { readonly status: 'queued'; readonly receipt: AuthoringOperationReceiptV1 }
  | { readonly status: 'rejected'; readonly failure: AuthoringFailureV1 }
  | { readonly status: 'completed'; readonly receipt: AuthoringOperationReceiptV1 };

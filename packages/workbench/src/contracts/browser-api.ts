/**
 * Browser-safe versioned read API contract. These DTOs are the only payloads
 * the Host browser read surface (`../host/browser-read-api.ts`) returns, and
 * the only read types client code may consume (re-exported through
 * `./index.ts`). The boundary rules are absolute: a principal never carries a
 * session id or cookie; a project summary/overview never carries a root label
 * or any filesystem path; no Git, SQLite, credential, capability token, Yjs
 * byte, or operation output path ever crosses this boundary. UI preferences
 * stay browser-local and are deliberately absent here.
 */

import type {
  ProjectSessionProjectionV1,
  ReferenceContentV1,
  ReferenceItemV1,
  ReferenceJobV1,
} from '@novalistically/workbench-protocol';
import type { UserRole } from './persistence.js';
import type { ProjectAccessRole } from './configuration.js';

export type { ProjectAccessRole };

/** Version of the browser read API contract carried by every response DTO. */
export const BROWSER_API_VERSION = 1 as const;
export type BrowserApiVersion = typeof BROWSER_API_VERSION;

/**
 * Request header carrying the server-issued session identity for browser
 * reads. The Host resolves the principal from this header server-side; the
 * value itself (a session id) is never reflected in any response DTO.
 * Mirrors the MCP transport's session header so browser and MCP surfaces
 * share one identity carrier.
 */
import type { WorkbenchRouteSelectorV1 } from './graph.js';
export const BROWSER_SESSION_HEADER = 'x-fabula-session';

/** Base path of the versioned browser read surface. */
export const BROWSER_API_BASE_PATH = '/api/v1';

/** `GET /api/v1/session` — safe current-session principal. */
export const BROWSER_SESSION_PATH = `${BROWSER_API_BASE_PATH}/session`;
/** `GET /api/v1/projects` — server-scoped project catalog. */
export const BROWSER_PROJECTS_PATH = `${BROWSER_API_BASE_PATH}/projects`;
/** `GET /api/v1/projects/:projectId/overview` — project overview. */
export const BROWSER_PROJECT_OVERVIEW_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/overview`;
/** `GET /api/v1/projects/:projectId/graphs` — canonical graph for one route. */
export const BROWSER_PROJECT_GRAPHS_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/graphs`;
/** `GET /api/v1/projects/:projectId/references` — safe reference catalog. */
export const BROWSER_PROJECT_REFERENCES_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/references`;
/** `POST /api/v1/projects/:projectId/references/import` — multipart reference import. */
export const BROWSER_PROJECT_REFERENCES_IMPORT_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/references/import`;
/** `GET/DELETE /api/v1/projects/:projectId/references/:referenceId` — one reference. */
export const BROWSER_PROJECT_REFERENCE_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/references/:referenceId`;
/** `GET /api/v1/projects/:projectId/references/:referenceId/content` — bounded content slice. */
export const BROWSER_PROJECT_REFERENCE_CONTENT_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/references/:referenceId/content`;
/** `POST /api/v1/projects/:projectId/references/import/retry` — retry one failed import job. */
export const BROWSER_PROJECT_REFERENCE_RETRY_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/references/import/retry`;
/** `GET /api/v1/projects/:projectId/capabilities` — Host-derived feature gates. */
export const BROWSER_PROJECT_CAPABILITIES_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/capabilities`;
/** `GET /api/v1/projects/:projectId/scene-adoption` — adoption preview for one scene revision. */
export const BROWSER_PROJECT_SCENE_ADOPTION_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/scene-adoption`;
/** Query parameter carrying the scene event id on the scene-adoption endpoint. */
export const BROWSER_SCENE_ADOPTION_EVENT_QUERY = 'eventId';
/** Query parameter carrying the scene revision id on the scene-adoption endpoint. */
export const BROWSER_SCENE_ADOPTION_REVISION_QUERY = 'revisionId';
/** `GET /api/v1/projects/:projectId/role` — the caller's resolved project role. */
export const BROWSER_PROJECT_ROLE_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/role`;

/** Query parameter carrying the strict route selector on the graphs endpoint. */
export const BROWSER_GRAPH_ROUTE_QUERY = 'route';

/** `GET /api/v1/projects/:projectId/reviews` — review comment list. */
export const BROWSER_PROJECT_REVIEWS_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/reviews`;
/** `GET /api/v1/projects/:projectId/reviews/:commentId` — one comment. */
export const BROWSER_PROJECT_REVIEW_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/reviews/:commentId`;
/** `GET /api/v1/projects/:projectId/reviews/history` — safe review event trail. */
export const BROWSER_PROJECT_REVIEW_HISTORY_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/reviews/history`;
/** `GET /api/v1/projects/:projectId/gates` — release gate list. */
export const BROWSER_PROJECT_GATES_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/gates`;
/** `POST /api/v1/projects/:projectId/gates/:gateId/decision` — gate decision. */
export const BROWSER_PROJECT_GATE_DECISION_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/gates/:gateId/decision`;
/** `GET/POST /api/v1/projects/:projectId/publications` — publication list / publish. */
export const BROWSER_PROJECT_PUBLICATIONS_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/publications`;
/** `GET /api/v1/projects/:projectId/publications/:publicationId` — one publication. */
export const BROWSER_PROJECT_PUBLICATION_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/publications/:publicationId`;
/** `GET /api/v1/projects/:projectId/publications/:publicationId/content` — bounded markdown slice. */
export const BROWSER_PROJECT_PUBLICATION_CONTENT_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/publications/:publicationId/content`;
/** Query parameters of the bounded publication content endpoint. */
export const BROWSER_PUBLICATION_CONTENT_OFFSET_QUERY = 'offset';
export const BROWSER_PUBLICATION_CONTENT_LIMIT_QUERY = 'limit';

/**
 * Safe current-session principal. Identity + role + display fields only:
 * never the session id/cookie, never a credential or capability token, never
 * any Host/filesystem material.
 */
export interface BrowserSessionPrincipalV1 {
  readonly version: BrowserApiVersion;
  readonly userId: string;
  readonly role: UserRole;
  readonly displayName: string;
  /** Monotonic capability version the user's grants were issued under. */
  readonly capabilityVersion: number;
  /** Session expiry timestamp; present so the client can show stale-auth state. */
  readonly expiresAt: string;
}

/**
 * One server-scoped project catalog entry. `rootLabel` and every filesystem
 * path are Host-internal and deliberately absent; `open` reports whether a
 * ProjectSession is currently open for the project (host state, not a path).
 */
export interface BrowserProjectSummaryV1 {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly open: boolean;
}

/** Versioned project catalog envelope. */
export interface BrowserProjectListV1 {
  readonly version: BrowserApiVersion;
  readonly projects: readonly BrowserProjectSummaryV1[];
}

/**
 * Safe status/activity state of one project: host-only surfaces that are
 * absent from {@link ProjectSessionProjectionV1}. No operation output path,
 * checkpoint, journal, or queue detail is ever included.
 */
export interface BrowserProjectActivityV1 {
  /** True while the project session has operations queued or in flight. */
  readonly busy: boolean;
  /** True while any human presence (browser, mcp, or yjs surface) is attached. */
  readonly hasHumanPresence: boolean;
}

/**
 * One project overview: display metadata plus the accepted session projection
 * and safe activity state. `projection` is null when no ProjectSession is
 * open for the project yet (the client models that honestly as "no accepted
 * source" rather than inventing one). Never carries rootLabel/path, Git,
 * SQLite, credentials, capability tokens, Yjs bytes, or output paths.
 */
export interface BrowserProjectOverviewV1 {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  readonly metadata: {
    readonly displayName: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  /** Accepted last-valid session projection, or null when the project is not open. */
  readonly projection: ProjectSessionProjectionV1 | null;
  readonly activity: BrowserProjectActivityV1;
  readonly generatedAt: string;
}
/**
 * Host-derived feature gate for one project view surface. The Host publishes
 * a feature only when the complete service and route behind it are registered
 * and reachable; the client never infers features from navigation constants
 * or configuration. `agent-chat` additionally stays hidden until the Agent
 * parity gate passes.
 */
export type WorkbenchProjectFeatureV1 =
  | 'project-home'
  | 'source-studio'
  | 'scene-canvas'
  | 'graph-route'
  | 'review-hub'
  | 'publication'
  | 'references'
  | 'agent-chat';

/** Versioned capabilities envelope for one project. */
export interface BrowserProjectCapabilitiesV1 {
  readonly version: 1;
  readonly projectId: string;
  readonly features: readonly WorkbenchProjectFeatureV1[];
}

/**
 * The caller's resolved project role for one project. `role` is null only
 * when no ACL role could be resolved; the Host's implicit owner override is
 * normalized to `maintainer`, matching the Agent chat role resolver.
 */
export interface BrowserProjectRoleV1 {
  readonly version: 1;
  readonly role: ProjectAccessRole | null;
}

/**
 * Strict documented route selector for `GET /api/v1/projects/:projectId/graphs`.
 * Single source of truth: the graph contract's {@link WorkbenchRouteSelectorV1},
 * aliased here as the browser API's wire selector.
 *
 * The endpoint accepts exactly ONE query parameter, `route`, carrying a
 * URL-encoded JSON document of precisely that shape. Everything else is
 * rejected with 400 `INVALID_ROUTE_SELECTOR` before any graph work happens:
 * unknown keys, wrong types, missing `branchPath`, malformed decisions,
 * non-integer `narrativeOrder`, and non-string ids. The endpoint never
 * compiles or parses client bytes — the selector is pure route identity, and
 * the graph itself is produced by the injected host projector.
 */
export type BrowserGraphRouteSelectorV1 = WorkbenchRouteSelectorV1;

/** Safe, path-free reference catalog returned by one authorized project route. */
export interface BrowserProjectReferenceListV1 {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  readonly items: readonly ReferenceItemV1[];
  readonly nextCursor: string | null;
}

/** Bounded cursor query accepted by the project reference-list endpoint. */
export interface BrowserProjectReferenceListQueryV1 {
  readonly pageSize?: number;
  readonly cursor?: string;
}

/** One reference result (get returns the projected item or null). */
export interface BrowserProjectReferenceGetResultV1 {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  readonly item: ReferenceItemV1 | null;
}

/** Bounded byte-range query accepted by the reference content endpoint. */
export interface BrowserProjectReferenceReadQueryV1 {
  readonly offset: number;
  readonly limit: number;
}

/**
 * One bounded content slice of a reference object. `byteLength` is the slice
 * size and `nextOffset` (when non-null) continues the read, so a reader can
 * page through a reference without ever learning a Host path.
 */
export interface BrowserProjectReferenceReadResultV1 {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  readonly content: ReferenceContentV1;
}

/**
 * One reference import result. The Host drives the durable three-phase
 * import synchronously, so `job` is terminal when the response arrives;
 * `job.status === 'failed'` keeps `jobId` available for a retry.
 */
export interface BrowserProjectReferenceImportResultV1 {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  readonly job: ReferenceJobV1;
}

/** One reference delete result; the durable delete job has already run. */
export interface BrowserProjectReferenceDeleteResultV1 {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  readonly job: ReferenceJobV1;
  readonly deletedReferenceId: string;
}

/** One reference import-job retry result. */
export interface BrowserProjectReferenceRetryResultV1 {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  readonly job: ReferenceJobV1;
}

/** Typed browser read API error codes, grouped by HTTP status class. */
export type BrowserApiErrorCode =
  /** 401 — the presented session is missing, revoked, or unknown. */
  | 'SESSION_NOT_FOUND'
  /** 401 — the presented session exists but has expired. */
  | 'SESSION_EXPIRED'
  /** 403 — the session is valid but the user cannot access this project. */
  | 'PROJECT_MISMATCH'
  /** 404 — the project is not in the caller's server-scoped catalog. */
  | 'PROJECT_NOT_FOUND'
  /** 400 — the `route` selector is missing or violates the documented shape. */
  | 'INVALID_ROUTE_SELECTOR'
  /** 503 — the injected graph projector could not produce the requested route. */
  | 'GRAPH_UNAVAILABLE'
  /** 503 — the injected Source Studio source could not produce project state. */
  | 'SOURCE_UNAVAILABLE'
  /** 404 — the requested reference or import job does not exist. */
  | 'REFERENCE_NOT_FOUND'
  /** 400 — the reference request is malformed or exceeds a documented bound. */
  | 'REFERENCE_INVALID'
  /** 503 — the project's reference library is unavailable. */
  | 'REFERENCE_UNAVAILABLE'
  /** 409 — an import lifecycle operation conflicts with the current job state. */
  | 'REFERENCE_CONFLICT'
  /** 500 — a reference import/retry job terminated with a host failure. */
  | 'REFERENCE_IMPORT_FAILED'
  /** 413 — the uploaded reference file exceeds the documented size bound. */
  | 'REFERENCE_SIZE_EXCEEDED'
  /** 404 — the review comment does not exist or is superseded away. */
  | 'REVIEW_COMMENT_NOT_FOUND'
  /** 400 — a review request is malformed or violates a documented bound. */
  | 'REVIEW_INVALID'
  /** 503 — the project review stream is unavailable. */
  | 'REVIEW_UNAVAILABLE'
  /** 404 — the release gate does not exist. */
  | 'GATE_NOT_FOUND'
  /** 409 — the gate is not open (already decided or superseded). */
  | 'GATE_NOT_OPEN'
  /** 400 — the gate decision violates a documented bound. */
  | 'GATE_DECISION_INVALID'
  /** 404 — the publication does not exist. */
  | 'PUBLICATION_NOT_FOUND'
  /** 400 — a publication request is malformed or violates a documented bound. */
  | 'PUBLICATION_INVALID'
  /** 503 — the project publication repository is unavailable. */
  | 'PUBLICATION_UNAVAILABLE'
  /** 409 — publication conflicts with the current accepted source/scope identity. */
  | 'PUBLICATION_CONFLICT'
  /** 503 — the Agent chat surface is not enabled for this project. */
  | 'AGENT_CHAT_UNAVAILABLE'
  /** 404 — the agent conversation does not exist. */
  | 'AGENT_CHAT_CONVERSATION_NOT_FOUND'
  /** 404 — the agent run does not exist. */
  | 'AGENT_CHAT_RUN_NOT_FOUND'
  /** 400 — an agent chat request is malformed or exceeds a documented bound. */
  | 'AGENT_CHAT_INVALID'
  /** 409 — the run is already terminal and cannot be cancelled/retried here. */
  | 'AGENT_CHAT_RUN_TERMINAL'
  /** 409 — the project operation queue is full; retry later. */
  | 'AGENT_CHAT_QUEUE_FULL'
  /** 404 — the requested scene revision does not exist for this project. */
  | 'SCENE_ADOPTION_NOT_FOUND'
  /** 400 — the scene adoption request is malformed or violates a documented bound. */
  | 'SCENE_ADOPTION_INVALID'
  /** 503 — the scene adoption preview cannot be produced by the host. */
  | 'SCENE_ADOPTION_UNAVAILABLE';
/** Secret-free error envelope for every non-2xx browser read response. */
export interface BrowserApiErrorV1 {
  readonly error: {
    readonly code: BrowserApiErrorCode;
    readonly message: string;
  };
}

// ─── Review Hub contract ────────────────────────────────────────────────────
// Browser-safe review DTOs: comments, their revision linkage, the safe event
// trail, and release gates. The boundary rules are absolute: no actor
// secrets, no capability tokens, no revision bytes, no filesystem paths, and
// no raw event payloads ever cross this boundary. All identity fields are
// Host-allocated opaque strings; `actorId` from the review stream is never
// echoed here.

/** Comment severity projected from the review stream. */
export type BrowserReviewSeverityV1 = 'nit' | 'suggestion' | 'blocking';
/** Comment category projected from the review stream. */
export type BrowserReviewCategoryV1 =
  | 'style'
  | 'pacing'
  | 'character_voice'
  | 'plot_logic'
  | 'world_consistency'
  | 'reader_experience';
/** Comment lifecycle status projected from the append-only review stream. */
export type BrowserReviewStatusV1 = 'open' | 'addressed' | 'resolved' | 'wontfix' | 'superseded';
/** Target kinds a review comment can be attached to. */
export type BrowserReviewTargetTypeV1 =
  | 'novel'
  | 'chapter'
  | 'scene'
  | 'line'
  | 'character'
  | 'worldrule';

/**
 * One revision application: which revision addressed (or considered) the
 * comment. Written from `comment_applied` events; this is the Review Hub's
 * revision linkage. No revision bytes or operation internals are included.
 */
export interface BrowserReviewApplicationV1 {
  /** The scene event the applied revision rendered. */
  readonly eventId: string;
  /** Accepted native revision id that produced the prose. */
  readonly revisionId: string;
  /** Durable operation id that ran the revision. */
  readonly operationId: string;
  readonly appliedAt: string;
}

/**
 * One browser-safe review comment. `eventId` is the target scene event id
 * (novel/chapter/line targets still carry the owning scene event when the
 * Host can resolve one). `supersedesId` links a replacement to its
 * predecessor; `applications` carry the revision linkage. No actor id, no
 * line bytes, no paths.
 */
export interface BrowserReviewCommentV1 {
  readonly version: BrowserApiVersion;
  readonly commentId: string;
  readonly eventId: string;
  readonly targetType: BrowserReviewTargetTypeV1;
  readonly severity: BrowserReviewSeverityV1;
  readonly category: BrowserReviewCategoryV1;
  readonly content: string;
  readonly status: BrowserReviewStatusV1;
  readonly author: 'human' | 'llm';
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly supersedesId: string | null;
  readonly applications: readonly BrowserReviewApplicationV1[];
}

/** Review comment list for one project, optionally narrowed to one event. */
export interface BrowserReviewListV1 {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  readonly comments: readonly BrowserReviewCommentV1[];
  readonly generatedAt: string;
}

/** One comment result (get/add/update all return the projected comment). */
export interface BrowserReviewCommentResultV1 {
  readonly version: BrowserApiVersion;
  readonly comment: BrowserReviewCommentV1;
}

/** Kinds of review events surfaced in the safe history trail. */
export type BrowserReviewHistoryKindV1 =
  | 'comment_added'
  | 'comment_replaced'
  | 'comment_status_changed'
  | 'comment_applied'
  | 'gate_opened'
  | 'gate_decided'
  | 'gate_superseded';

/**
 * One safe entry of the review event trail. The Host renders each event to
 * `summary` (never raw payloads) and links it to its comment or gate; actor
 * ids and event payload internals are never included.
 */
export interface BrowserReviewHistoryEntryV1 {
  readonly version: BrowserApiVersion;
  readonly sequence: number;
  readonly kind: BrowserReviewHistoryKindV1;
  readonly commentId: string | null;
  readonly gateId: string | null;
  /** Native revision id for `comment_applied` entries; null otherwise. */
  readonly revisionId: string | null;
  readonly at: string;
  readonly summary: string;
}

/** Review history trail for one project, optionally narrowed to one event. */
export interface BrowserReviewHistoryV1 {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  readonly entries: readonly BrowserReviewHistoryEntryV1[];
  readonly generatedAt: string;
}

/** Lifecycle status of one release gate. */
export type BrowserReviewGateStatusV1 = 'open' | 'decided' | 'superseded';

/** Browser-safe gate decision; the maintainer actor id stays server-side. */
export interface BrowserReviewGateDecisionV1 {
  readonly decision: 'waived' | 'rejected' | 'accepted';
  readonly revisionId: string;
  readonly reason: string;
  readonly decidedAt: string;
}

/**
 * One browser-safe release gate for a scene candidate. Identity fields are
 * hashes only (never prose bytes); `warningFingerprints` are stable
 * fingerprints, not free text. The binding candidate revision is
 * `revisionId`.
 */
export interface BrowserReviewGateV1 {
  readonly version: BrowserApiVersion;
  readonly gateId: string;
  readonly eventId: string;
  readonly sourceHash: string;
  readonly proseHash: string;
  readonly scopeHash: string;
  readonly validationIdentity: string;
  readonly warningFingerprints: readonly string[];
  readonly revisionId: string;
  readonly status: BrowserReviewGateStatusV1;
  readonly decision: BrowserReviewGateDecisionV1 | null;
  readonly openedAt: string;
  readonly supersededAt: string | null;
}

/** Release gate list for one project, optionally narrowed to one event. */
export interface BrowserReviewGateListV1 {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  readonly gates: readonly BrowserReviewGateV1[];
  readonly generatedAt: string;
}

/** Explicit browser review-comment add request. */
export interface BrowserReviewAddRequestV1 {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  /** Scene event the comment targets. */
  readonly eventId: string;
  readonly severity: BrowserReviewSeverityV1;
  readonly category: BrowserReviewCategoryV1;
  readonly content: string;
}

/**
 * Comment update actions. `addressed` is NOT an action: it is written only
 * by `comment_applied` events after a revision addresses the comment.
 */
export type BrowserReviewUpdateActionV1 = 'replace' | 'resolve' | 'wontfix' | 'reopen' | 'escalate';

/** Explicit browser review-comment update request. */
export interface BrowserReviewUpdateRequestV1 {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  readonly commentId: string;
  readonly action: BrowserReviewUpdateActionV1;
  /** Replacement content; required for `replace`. */
  readonly content?: string;
  readonly severity?: BrowserReviewSeverityV1;
  readonly category?: BrowserReviewCategoryV1;
}

/** Explicit browser release-gate decision request. */
export interface BrowserReviewGateDecideRequestV1 {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  readonly gateId: string;
  readonly decision: 'accept' | 'reject';
  readonly reason: string;
}

/** Immediate result of a gate decision; async promotion continues as an operation. */
export interface BrowserReviewGateDecisionResultV1 {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  readonly gateId: string;
  readonly eventId: string;
  readonly outcome: 'accepted' | 'rejected' | 'stale' | 'superseded';
  /** Gate decision status; `pending_waiver` only under strict release policy. */
  readonly decisionStatus: 'accepted' | 'pending_waiver' | 'blocked';
  readonly decidedAt: string;
}

// ─── Publication contract ───────────────────────────────────────────────────
// Browser-safe publication DTOs: the project-relative artifact catalog and
// the bounded content reader. The boundary rules are absolute: `relativeOutputPath`
// is project-relative (never an absolute Host path), hashes are identity only
// (never prose bytes), `actorId` from the publication record is never echoed,
// and content is read through the bounded read route — the browser never
// learns where the file lives on the Host.

/** Publication kind: the canonical novel or a custom branch publication. */
export type BrowserPublicationKindV1 = 'canonical' | 'custom';
/** Lifecycle status of one publication relative to the accepted source. */
export type BrowserPublicationStatusV1 = 'current' | 'stale';

/**
 * Stable reason codes explaining why a publication is no longer current.
 * `missing_scenes`/`blocked_scenes` mirror the assembly readiness state;
 * `source_changed`/`scope_mixed` mean the artifact no longer matches the
 * accepted source/scope; `out_of_date` is the generic fallback the Host uses
 * when the record predates the current accepted revision.
 */
export type BrowserPublicationStaleReasonV1 =
  | 'missing_scenes'
  | 'blocked_scenes'
  | 'source_changed'
  | 'scope_mixed'
  | 'out_of_date';

/**
 * One browser-safe publication record. `relativeOutputPath` is the
 * project-relative artifact file (`output/novel.md` for canonical, otherwise
 * `output/<publicationId>.md`); `novelHash` is the SHA-256 of the exact
 * written bytes and `byteLength` their UTF-8 size. The Host projects
 * `sceneCount` (assembled scene set) and `wordCount` (artifact token count)
 * from the artifact it produced; the browser never reads the file itself.
 */
export interface BrowserPublicationRecordV1 {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  readonly publicationId: string;
  readonly kind: BrowserPublicationKindV1;
  readonly status: BrowserPublicationStatusV1;
  readonly sourceHash: string;
  readonly scopeHash: string;
  readonly revisionIds: readonly string[];
  readonly novelHash: string;
  readonly relativeOutputPath: string;
  readonly byteLength: number;
  readonly sceneCount: number;
  readonly wordCount: number;
  readonly staleReasons: readonly BrowserPublicationStaleReasonV1[];
  /** Durable operation that produced the artifact; null only before completion. */
  readonly operationId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Publication catalog for one project (canonical + custom branches). */
export interface BrowserPublicationListV1 {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  readonly publications: readonly BrowserPublicationRecordV1[];
  readonly generatedAt: string;
}

/** One publication result (get returns the projected record or null). */
export interface BrowserPublicationGetResultV1 {
  readonly version: BrowserApiVersion;
  readonly publication: BrowserPublicationRecordV1 | null;
}

/** Bounded cursor query accepted by the publication content endpoint. */
export interface BrowserPublicationReadQueryV1 {
  readonly offset?: number;
  readonly limit?: number;
}

/**
 * One bounded markdown slice of a publication. `byteLength` is the slice
 * size; `totalByteLength` is the artifact size, so a reader can page through
 * the whole novel with offset/limit without ever learning a Host path.
 */
export interface BrowserPublicationReadResultV1 {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  readonly publicationId: string;
  readonly offset: number;
  readonly limit: number;
  readonly content: string;
  readonly byteLength: number;
  readonly totalByteLength: number;
}

/**
 * Explicit browser publish request. Omitting all branch fields publishes the
 * canonical novel (`output/novel.md`); supplying `branchPath` (the strict
 * route selector) plus optional `discourseBranch`/`title` publishes a custom
 * branch artifact. Assembly is a durable operation, so the result is queued.
 */
export interface BrowserPublishRequestV1 {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  readonly branchPath?: BrowserGraphRouteSelectorV1;
  readonly discourseBranch?: string;
  readonly title?: string;
}

/** Immediate result of a publish request; the view refreshes to the record. */
export interface BrowserPublishResultV1 {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  readonly publicationId: string;
  readonly kind: BrowserPublicationKindV1;
  readonly outcome: 'queued' | 'current' | 'stale' | 'failed';
  /** Durable operation to track when the assembly is queued. */
  readonly operationId: string | null;
  readonly staleReasons: readonly BrowserPublicationStaleReasonV1[];
}

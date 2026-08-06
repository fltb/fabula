// ============================================================================
// Guarded browser review surface (plan Step 5)
// ----------------------------------------------------------------------------
// The browser-only review seam: comment list/get/add/update, the safe review
// event trail, and the release-gate list/decide trigger. Every route follows
// the same guard chain as the other browser surfaces — principal → project
// ACL → catalogue listing → 404 — and the browser never supplies a session,
// grant, actor, capability token or Host path. `actorId` from the review
// stream is never echoed, `eventId` is the target scene event id, and
// history entries are Host-rendered summaries (never raw event payloads).
//
// Every mutation goes through the same per-project HostReviewService as the
// MCP review tools: comment add/update and gate decisions write durable
// `review` / `release-gate` ProjectOperationRecordV1 rows under the caller
// grant, which is resolved server-side (never caller-supplied). Comment
// mutations require the author role and an `mcp:author` grant; a gate
// decision requires the maintainer role and an `mcp:submit` grant.
// ============================================================================

import type { ReviewEventRecordV1, ReviewGateV1, ReviewProjectionV1 } from '@novalistically/core';
import type { Context, Handler } from 'hono';
import {
  BROWSER_API_VERSION,
  BROWSER_PROJECT_GATE_DECISION_PATH,
  BROWSER_PROJECT_GATES_PATH,
  BROWSER_PROJECT_REVIEW_HISTORY_PATH,
  BROWSER_PROJECT_REVIEW_PATH,
  BROWSER_PROJECT_REVIEWS_PATH,
  type BrowserApiErrorCode,
  type BrowserReviewAddRequestV1,
  type BrowserReviewCategoryV1,
  type BrowserReviewCommentResultV1,
  type BrowserReviewCommentV1,
  type BrowserReviewGateDecisionResultV1,
  type BrowserReviewGateListV1,
  type BrowserReviewGateV1,
  type BrowserReviewHistoryEntryV1,
  type BrowserReviewHistoryKindV1,
  type BrowserReviewHistoryV1,
  type BrowserReviewListV1,
  type BrowserReviewSeverityV1,
  type BrowserReviewUpdateActionV1,
  type BrowserSessionPrincipalV1,
} from '../contracts/browser-api.js';
import type { AgentCapabilityGrant } from './agent/index.js';
import type {
  BrowserPrincipalResolution,
  BrowserPrincipalResolver,
  BrowserProjectAuthorization,
  BrowserProjectCatalog,
} from './browser-read-api.js';
import type { HostListenerEnv, MutationHttpMethod } from './listener.js';
import type { McpAuthorizedCaller } from './mcp/auth.js';
import type { ProjectAccessRequiredRole, ProjectAccessService } from './project-access-service.js';
import type {
  HostNewReviewCommentV1,
  HostReviewCommentV1,
  HostReviewService,
} from './review/review-service.js';
import type { HostServer } from './server.js';

/** Per-project review service resolved by the Host; null = not ready. */
export interface BrowserReviewRegistry {
  get(projectId: string): HostReviewService | null | Promise<HostReviewService | null>;
}

/** Capability scope a review mutation needs; mirrors the MCP scope grants. */
export type BrowserReviewCapabilityScope = 'mcp:author' | 'mcp:submit';

/** Resolves a server-owned capability grant for one review mutation. */
export interface BrowserReviewCapabilityResolver {
  resolve(input: {
    readonly principal: BrowserSessionPrincipalV1;
    readonly projectId: string;
    readonly scope: BrowserReviewCapabilityScope;
  }): Promise<AgentCapabilityGrant | null>;
}

export interface BrowserReviewApiOptions {
  readonly principal: BrowserPrincipalResolver;
  /** Shared ACL/lifecycle service; when present it is the authoritative role gate. */
  readonly access?: Pick<ProjectAccessService, 'authorize'>;
  readonly authorization: BrowserProjectAuthorization;
  readonly catalog: BrowserProjectCatalog;
  readonly reviews: BrowserReviewRegistry;
  /** Capability resolver for the mutations; absent → mutations fail closed. */
  readonly capabilities?: BrowserReviewCapabilityResolver | null;
  readonly now?: () => string;
}

export interface BrowserReviewApiSurface {
  register(host: HostServer): void;
}

/** The error codes this surface may emit (a strict subset of the shared envelope). */
export type BrowserReviewErrorCode = Extract<
  BrowserApiErrorCode,
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'PROJECT_MISMATCH'
  | 'PROJECT_NOT_FOUND'
  | 'REVIEW_COMMENT_NOT_FOUND'
  | 'REVIEW_INVALID'
  | 'REVIEW_UNAVAILABLE'
  | 'GATE_NOT_FOUND'
  | 'GATE_NOT_OPEN'
  | 'GATE_DECISION_INVALID'
>;

const REVIEW_ERROR_STATUS: Readonly<Record<BrowserReviewErrorCode, number>> = {
  SESSION_NOT_FOUND: 401,
  SESSION_EXPIRED: 401,
  PROJECT_MISMATCH: 403,
  PROJECT_NOT_FOUND: 404,
  REVIEW_COMMENT_NOT_FOUND: 404,
  REVIEW_INVALID: 400,
  REVIEW_UNAVAILABLE: 503,
  GATE_NOT_FOUND: 404,
  GATE_NOT_OPEN: 409,
  GATE_DECISION_INVALID: 400,
};

/** Bounds shared with the MCP review tools. */
const BROWSER_REVIEW_MAX_ID_LENGTH = 128;
const BROWSER_REVIEW_MAX_EVENT_ID_LENGTH = 4096;
const BROWSER_REVIEW_MAX_CONTENT_LENGTH = 65536;
const BROWSER_REVIEW_MAX_REASON_LENGTH = 4096;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function reviewError(code: BrowserReviewErrorCode, message: string): Response {
  const body = { error: { code, message } };
  return json(body, REVIEW_ERROR_STATUS[code]);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

async function readJson(c: Context<HostListenerEnv>): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await c.req.json();
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const REVIEW_SEVERITIES: readonly BrowserReviewSeverityV1[] = ['nit', 'suggestion', 'blocking'];
const REVIEW_CATEGORIES: readonly BrowserReviewCategoryV1[] = [
  'style',
  'pacing',
  'character_voice',
  'plot_logic',
  'world_consistency',
  'reader_experience',
];
const REVIEW_UPDATE_ACTIONS: readonly BrowserReviewUpdateActionV1[] = [
  'replace',
  'resolve',
  'wontfix',
  'reopen',
  'escalate',
];

function isReviewSeverity(value: unknown): value is BrowserReviewSeverityV1 {
  return typeof value === 'string' && (REVIEW_SEVERITIES as readonly string[]).includes(value);
}

function isReviewCategory(value: unknown): value is BrowserReviewCategoryV1 {
  return typeof value === 'string' && (REVIEW_CATEGORIES as readonly string[]).includes(value);
}

function isReviewUpdateAction(value: unknown): value is BrowserReviewUpdateActionV1 {
  return typeof value === 'string' && (REVIEW_UPDATE_ACTIONS as readonly string[]).includes(value);
}

type AccessResult =
  | { readonly ok: true; readonly principal: BrowserSessionPrincipalV1; readonly projectId: string }
  | { readonly ok: false; readonly response: Response };

class BrowserReviewApiImpl {
  constructor(readonly options: BrowserReviewApiOptions) {}

  async access(
    c: Context<HostListenerEnv>,
    requiredRole: ProjectAccessRequiredRole = 'reader',
  ): Promise<AccessResult> {
    const resolution: BrowserPrincipalResolution = await this.options.principal.resolve(c.req.raw);
    if (!resolution.ok) {
      return {
        ok: false,
        response: reviewError(
          resolution.failure,
          resolution.failure === 'SESSION_EXPIRED'
            ? 'The session has expired.'
            : 'The session is missing, revoked or unknown.',
        ),
      };
    }
    const projectId = c.req.param('projectId');
    if (!nonEmptyString(projectId)) {
      return {
        ok: false,
        response: reviewError('PROJECT_NOT_FOUND', 'A project id is required.'),
      };
    }
    const authorized =
      this.options.access === undefined
        ? await this.options.authorization.canAccessProject(
            resolution.principal.userId,
            projectId,
            requiredRole,
          )
        : (
            await this.options.access.authorize({
              userId: resolution.principal.userId,
              projectId,
              requiredRole,
            })
          ).ok;
    if (!authorized) {
      return {
        ok: false,
        response: reviewError(
          'PROJECT_MISMATCH',
          'The session is not authorized for this project.',
        ),
      };
    }
    const projects = await this.options.catalog.listProjects(resolution.principal);
    if (!projects.some((project) => project.projectId === projectId)) {
      return {
        ok: false,
        response: reviewError('PROJECT_NOT_FOUND', 'The project is not in this session catalogue.'),
      };
    }
    return { ok: true, principal: resolution.principal, projectId };
  }

  async service(projectId: string): Promise<HostReviewService | Response> {
    const service = await this.options.reviews.get(projectId);
    if (service === null || service.projectId !== projectId) {
      return reviewError(
        'REVIEW_UNAVAILABLE',
        'The review service is not available for this project.',
      );
    }
    return service;
  }

  /** One capability grant for a mutation, resolved server-side (never caller-supplied). */
  async capability(
    access: Extract<AccessResult, { readonly ok: true }>,
    scope: BrowserReviewCapabilityScope,
  ): Promise<AgentCapabilityGrant | Response> {
    const resolver = this.options.capabilities;
    if (resolver === undefined || resolver === null) {
      return reviewError('REVIEW_UNAVAILABLE', 'The browser review capability is unavailable.');
    }
    const grant = await resolver.resolve({
      principal: access.principal,
      projectId: access.projectId,
      scope,
    });
    if (grant === null) {
      return reviewError(
        'REVIEW_UNAVAILABLE',
        'The browser review capability could not be resolved.',
      );
    }
    return grant;
  }
}

// ─── Browser-safe DTO conversion ─────────────────────────────────────────────

function toBrowserComment(comment: HostReviewCommentV1): BrowserReviewCommentV1 {
  return {
    version: BROWSER_API_VERSION,
    commentId: comment.id,
    // The target scene event id: scene/line targets carry it directly, and
    // every browser-created comment targets the scene the form named.
    eventId: comment.target.id,
    targetType: comment.target.type,
    severity: comment.severity,
    category: comment.category,
    content: comment.content,
    status: comment.status,
    author: comment.author,
    createdAt: comment.createdAt,
    resolvedAt: comment.resolvedAt ?? null,
    supersedesId: comment.supersedesId ?? null,
    applications: comment.applications.map((application) => ({
      eventId: application.eventId,
      revisionId: application.revisionId,
      operationId: application.operationId,
      appliedAt: application.appliedAt,
    })),
  };
}

function toBrowserGate(gate: ReviewGateV1): BrowserReviewGateV1 {
  return {
    version: BROWSER_API_VERSION,
    gateId: gate.gateId,
    eventId: gate.eventId,
    sourceHash: gate.sourceHash,
    proseHash: gate.proseHash,
    scopeHash: gate.scopeHash,
    validationIdentity: gate.validationIdentity,
    warningFingerprints: [...gate.warningFingerprints],
    revisionId: gate.revisionId,
    status: gate.status,
    decision:
      gate.decision === null
        ? null
        : {
            decision: gate.decision.decision,
            revisionId: gate.decision.revisionId,
            reason: gate.decision.reason,
            decidedAt: gate.decision.createdAt,
          },
    openedAt: gate.openedAt,
    supersededAt: gate.supersededAt ?? null,
  };
}

/** Native revision id for `comment_applied` entries; null otherwise. */
function revisionIdOf(event: ReviewEventRecordV1): string | null {
  if (event.kind !== 'comment_applied') return null;
  const payload =
    typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : null;
  const application = payload === null ? null : payload.application;
  return typeof application === 'object' &&
    application !== null &&
    !Array.isArray(application) &&
    typeof (application as Record<string, unknown>).revisionId === 'string'
    ? ((application as Record<string, unknown>).revisionId as string)
    : null;
}

/** Extract the decided value of a `gate_decided` payload; never raw payloads. */
function decidedValueOf(payload: Record<string, unknown> | null): string {
  if (payload === null) return 'decided';
  const decision = payload.decision;
  if (
    typeof decision === 'object' &&
    decision !== null &&
    !Array.isArray(decision) &&
    typeof (decision as Record<string, unknown>).decision === 'string'
  ) {
    return (decision as Record<string, unknown>).decision as string;
  }
  return 'decided';
}

/** Host-rendered summary of one review event; raw payloads never cross. */
function summarize(event: ReviewEventRecordV1): string {
  const payload =
    typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : null;
  switch (event.kind) {
    case 'comment_added':
      return `Review comment ${event.commentId ?? '?'} added.`;
    case 'comment_replaced':
      return `Review comment ${event.commentId ?? '?'} replaced.`;
    case 'comment_status_changed': {
      const to = payload !== null && typeof payload.to === 'string' ? payload.to : 'changed';
      return `Review comment ${event.commentId ?? '?'} ${to}.`;
    }
    case 'comment_applied':
      return `Review comment ${event.commentId ?? '?'} applied to a revision.`;
    case 'gate_opened':
      return `Release gate ${event.gateId ?? '?'} opened.`;
    case 'gate_decided':
      return `Release gate ${event.gateId ?? '?'} ${decidedValueOf(payload)}.`;
    case 'gate_superseded':
      return `Release gate ${event.gateId ?? '?'} superseded.`;
  }
}

function toHistoryEntry(event: ReviewEventRecordV1): BrowserReviewHistoryEntryV1 {
  return {
    version: BROWSER_API_VERSION,
    sequence: event.sequence,
    kind: event.kind as BrowserReviewHistoryKindV1,
    commentId: event.commentId ?? null,
    gateId: event.gateId ?? null,
    revisionId: revisionIdOf(event),
    at: event.createdAt,
    summary: summarize(event),
  };
}

/** Strict eventId query parse shared by the list/history/gates routes. */
function parseEventIdQuery(
  raw: string | undefined,
):
  | { readonly ok: true; readonly value?: string }
  | { readonly ok: false; readonly response: Response } {
  if (raw === undefined || raw.length === 0) return { ok: true };
  if (raw.length > BROWSER_REVIEW_MAX_EVENT_ID_LENGTH) {
    return {
      ok: false,
      response: reviewError(
        'REVIEW_INVALID',
        `eventId must be a bounded non-empty string of at most ${BROWSER_REVIEW_MAX_EVENT_ID_LENGTH} characters.`,
      ),
    };
  }
  return { ok: true, value: raw };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

function listHandler(api: BrowserReviewApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'reader');
    if (!access.ok) return access.response;
    const serviceOrError = await api.service(access.projectId);
    if (serviceOrError instanceof Response) return serviceOrError;
    const event = parseEventIdQuery(c.req.query('eventId'));
    if (!event.ok) return event.response;
    const comments = (
      await serviceOrError.listComments(
        event.value === undefined ? undefined : { eventId: event.value },
      )
    ).filter((comment) => comment.status !== 'superseded');
    return json({
      version: BROWSER_API_VERSION,
      projectId: access.projectId,
      comments: comments.map(toBrowserComment),
      generatedAt: api.options.now?.() ?? new Date().toISOString(),
    } satisfies BrowserReviewListV1);
  };
}

function getHandler(api: BrowserReviewApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'reader');
    if (!access.ok) return access.response;
    const commentId = c.req.param('commentId');
    if (!nonEmptyString(commentId) || commentId.length > BROWSER_REVIEW_MAX_ID_LENGTH) {
      return reviewError('REVIEW_INVALID', 'commentId must be a bounded identifier.');
    }
    const serviceOrError = await api.service(access.projectId);
    if (serviceOrError instanceof Response) return serviceOrError;
    const comment = await serviceOrError.getComment(commentId);
    // Superseded comments are "superseded away": the replacement carries the
    // lineage, the predecessor is not addressable from the browser.
    if (comment === null || comment.status === 'superseded') {
      return reviewError('REVIEW_COMMENT_NOT_FOUND', 'The review comment does not exist.');
    }
    return json({
      version: BROWSER_API_VERSION,
      comment: toBrowserComment(comment),
    } satisfies BrowserReviewCommentResultV1);
  };
}

function historyHandler(api: BrowserReviewApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'reader');
    if (!access.ok) return access.response;
    const serviceOrError = await api.service(access.projectId);
    if (serviceOrError instanceof Response) return serviceOrError;
    const event = parseEventIdQuery(c.req.query('eventId'));
    if (!event.ok) return event.response;
    const projection: ReviewProjectionV1 = await serviceOrError.reviewProjection();
    let events = [...projection.events].sort((a, b) => a.sequence - b.sequence);
    if (event.value !== undefined) {
      const commentIds = new Set(
        projection.comments
          .filter((comment) => comment.target.id === event.value)
          .map((comment) => comment.id),
      );
      const gateIds = new Set(
        projection.gates.filter((gate) => gate.eventId === event.value).map((gate) => gate.gateId),
      );
      events = events.filter(
        (record) =>
          (record.commentId !== undefined && commentIds.has(record.commentId)) ||
          (record.gateId !== undefined && gateIds.has(record.gateId)),
      );
    }
    return json({
      version: BROWSER_API_VERSION,
      projectId: access.projectId,
      entries: events.map(toHistoryEntry),
      generatedAt: api.options.now?.() ?? new Date().toISOString(),
    } satisfies BrowserReviewHistoryV1);
  };
}

function addHandler(api: BrowserReviewApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'author');
    if (!access.ok) return access.response;
    const grant = await api.capability(access, 'mcp:author');
    if (grant instanceof Response) return grant;
    const serviceOrError = await api.service(access.projectId);
    if (serviceOrError instanceof Response) return serviceOrError;
    const body = await readJson(c);
    if (body === null) {
      return reviewError('REVIEW_INVALID', 'The review request must be an object.');
    }
    const request = body as unknown as BrowserReviewAddRequestV1;
    if (request.version !== BROWSER_API_VERSION) {
      return reviewError('REVIEW_INVALID', 'The review request version is unsupported.');
    }
    if (request.projectId !== access.projectId) {
      return reviewError('REVIEW_INVALID', 'The request project does not match its route.');
    }
    const eventId = request.eventId;
    if (
      typeof eventId !== 'string' ||
      eventId.length === 0 ||
      eventId.length > BROWSER_REVIEW_MAX_EVENT_ID_LENGTH
    ) {
      return reviewError(
        'REVIEW_INVALID',
        `eventId must be a bounded non-empty string of at most ${BROWSER_REVIEW_MAX_EVENT_ID_LENGTH} characters.`,
      );
    }
    if (!isReviewSeverity(request.severity)) {
      return reviewError('REVIEW_INVALID', 'severity is invalid.');
    }
    if (!isReviewCategory(request.category)) {
      return reviewError('REVIEW_INVALID', 'category is invalid.');
    }
    const content = request.content;
    if (
      typeof content !== 'string' ||
      content.trim().length === 0 ||
      content.length > BROWSER_REVIEW_MAX_CONTENT_LENGTH
    ) {
      return reviewError(
        'REVIEW_INVALID',
        `content must be a non-empty string of at most ${BROWSER_REVIEW_MAX_CONTENT_LENGTH} characters.`,
      );
    }
    const caller = { sessionId: null, userId: grant.userId, grant } as McpAuthorizedCaller;
    try {
      const comment = await serviceOrError.addComment(
        {
          target: { type: 'scene', id: eventId },
          severity: request.severity,
          category: request.category,
          content,
        },
        caller,
      );
      return json({
        version: BROWSER_API_VERSION,
        comment: toBrowserComment(comment),
      } satisfies BrowserReviewCommentResultV1);
    } catch (error) {
      return reviewErrorFrom(error, 'comment');
    }
  };
}

function updateHandler(api: BrowserReviewApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'author');
    if (!access.ok) return access.response;
    const grant = await api.capability(access, 'mcp:author');
    if (grant instanceof Response) return grant;
    const serviceOrError = await api.service(access.projectId);
    if (serviceOrError instanceof Response) return serviceOrError;
    const commentId = c.req.param('commentId');
    if (!nonEmptyString(commentId) || commentId.length > BROWSER_REVIEW_MAX_ID_LENGTH) {
      return reviewError('REVIEW_INVALID', 'commentId must be a bounded identifier.');
    }
    const body = await readJson(c);
    if (body === null) {
      return reviewError('REVIEW_INVALID', 'The review update request must be an object.');
    }
    const request = body;
    if (request.version !== BROWSER_API_VERSION) {
      return reviewError('REVIEW_INVALID', 'The review update request version is unsupported.');
    }
    if (request.projectId !== access.projectId) {
      return reviewError('REVIEW_INVALID', 'The request project does not match its route.');
    }
    if (request.commentId !== commentId) {
      return reviewError('REVIEW_INVALID', 'The request comment does not match its route.');
    }
    if (!isReviewUpdateAction(request.action)) {
      return reviewError(
        'REVIEW_INVALID',
        'action must be replace, resolve, wontfix, reopen, or escalate.',
      );
    }
    const action = request.action;
    const caller = { sessionId: null, userId: grant.userId, grant } as McpAuthorizedCaller;
    try {
      let updated: HostReviewCommentV1;
      if (action === 'replace') {
        const content = request.content;
        if (
          typeof content !== 'string' ||
          content.trim().length === 0 ||
          content.length > BROWSER_REVIEW_MAX_CONTENT_LENGTH
        ) {
          return reviewError(
            'REVIEW_INVALID',
            `replace requires content of at most ${BROWSER_REVIEW_MAX_CONTENT_LENGTH} characters.`,
          );
        }
        if (request.severity !== undefined && !isReviewSeverity(request.severity)) {
          return reviewError('REVIEW_INVALID', 'severity is invalid.');
        }
        if (request.category !== undefined && !isReviewCategory(request.category)) {
          return reviewError('REVIEW_INVALID', 'category is invalid.');
        }
        // The replacement keeps the original target; severity/category fall
        // back to the comment being replaced when omitted (the Review Hub's
        // replace action sends only content).
        const existing = await serviceOrError.getComment(commentId);
        if (existing === null || existing.status === 'superseded') {
          return reviewError('REVIEW_COMMENT_NOT_FOUND', 'The review comment does not exist.');
        }
        const input: HostNewReviewCommentV1 = {
          target: existing.target,
          severity: request.severity === undefined ? existing.severity : request.severity,
          category: request.category === undefined ? existing.category : request.category,
          content,
        };
        updated = await serviceOrError.updateComment(
          { action: 'replace', commentId, input },
          caller,
        );
      } else {
        if (
          request.content !== undefined ||
          request.severity !== undefined ||
          request.category !== undefined
        ) {
          return reviewError(
            'REVIEW_INVALID',
            'content, severity and category apply only to replace.',
          );
        }
        updated = await serviceOrError.updateComment({ action, commentId }, caller);
      }
      return json({
        version: BROWSER_API_VERSION,
        comment: toBrowserComment(updated),
      } satisfies BrowserReviewCommentResultV1);
    } catch (error) {
      return reviewErrorFrom(error, 'comment');
    }
  };
}

function gateListHandler(api: BrowserReviewApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'reader');
    if (!access.ok) return access.response;
    const serviceOrError = await api.service(access.projectId);
    if (serviceOrError instanceof Response) return serviceOrError;
    const event = parseEventIdQuery(c.req.query('eventId'));
    if (!event.ok) return event.response;
    const gates = await serviceOrError.listGates(event.value);
    return json({
      version: BROWSER_API_VERSION,
      projectId: access.projectId,
      gates: gates.map(toBrowserGate),
      generatedAt: api.options.now?.() ?? new Date().toISOString(),
    } satisfies BrowserReviewGateListV1);
  };
}

function gateDecideHandler(api: BrowserReviewApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'maintainer');
    if (!access.ok) return access.response;
    const grant = await api.capability(access, 'mcp:submit');
    if (grant instanceof Response) return grant;
    const serviceOrError = await api.service(access.projectId);
    if (serviceOrError instanceof Response) return serviceOrError;
    const gateId = c.req.param('gateId');
    if (!nonEmptyString(gateId) || gateId.length > BROWSER_REVIEW_MAX_ID_LENGTH) {
      return reviewError('GATE_DECISION_INVALID', 'gateId must be a bounded identifier.');
    }
    const body = await readJson(c);
    if (body === null) {
      return reviewError('GATE_DECISION_INVALID', 'The gate decision request must be an object.');
    }
    const request = body;
    if (request.version !== BROWSER_API_VERSION) {
      return reviewError(
        'GATE_DECISION_INVALID',
        'The gate decision request version is unsupported.',
      );
    }
    if (request.projectId !== access.projectId) {
      return reviewError('GATE_DECISION_INVALID', 'The request project does not match its route.');
    }
    if (request.gateId !== gateId) {
      return reviewError('GATE_DECISION_INVALID', 'The request gate does not match its route.');
    }
    if (request.decision !== 'accept' && request.decision !== 'reject') {
      return reviewError('GATE_DECISION_INVALID', 'decision must be accept or reject.');
    }
    const reason = request.reason;
    if (
      typeof reason !== 'string' ||
      reason.trim().length === 0 ||
      reason.length > BROWSER_REVIEW_MAX_REASON_LENGTH
    ) {
      return reviewError(
        'GATE_DECISION_INVALID',
        `reason must be a non-empty string of at most ${BROWSER_REVIEW_MAX_REASON_LENGTH} characters.`,
      );
    }
    // The gate must exist and still be open in the projected review stream;
    // an already-decided or superseded gate is a conflict, not a replay.
    const gates = await serviceOrError.listGates();
    const gate = gates.find((candidate) => candidate.gateId === gateId);
    if (gate === undefined) {
      return reviewError('GATE_NOT_FOUND', 'The release gate does not exist.');
    }
    if (gate.status !== 'open') {
      return reviewError('GATE_NOT_OPEN', 'The release gate is not open.');
    }
    const caller = { sessionId: null, userId: grant.userId, grant } as McpAuthorizedCaller;
    try {
      const resolution = await serviceOrError.decideGate(
        {
          eventId: gate.eventId,
          candidateRevisionId: gate.revisionId,
          decision: request.decision,
          reason,
        },
        caller,
      );
      return json({
        version: BROWSER_API_VERSION,
        projectId: access.projectId,
        gateId,
        eventId: gate.eventId,
        outcome: resolution.outcome,
        decisionStatus: resolution.decision.status,
        decidedAt: resolution.decidedAt,
      } satisfies BrowserReviewGateDecisionResultV1);
    } catch (error) {
      return reviewErrorFrom(error, 'gate');
    }
  };
}

/** Map a review-service (Core) failure onto the typed browser envelope. */
function reviewErrorFrom(error: unknown, scope: 'comment' | 'gate'): Response {
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : null;
  const message = error instanceof Error ? error.message : 'The review operation failed.';
  if (code === 'INVALID_OPERATION' || code === 'REVISION_NOT_FOUND') {
    return reviewError(
      scope === 'comment' ? 'REVIEW_COMMENT_NOT_FOUND' : 'GATE_NOT_FOUND',
      message,
    );
  }
  if (code === 'STORAGE_CONFLICT') {
    // A raced ledger: the comment/gate state changed under the caller.
    return reviewError(scope === 'comment' ? 'REVIEW_INVALID' : 'GATE_NOT_OPEN', message);
  }
  if (code === 'INVALID_REVIEW_SELECTION') {
    return reviewError('REVIEW_INVALID', message);
  }
  if (code === 'NO_ACCEPTED_SOURCE') {
    return reviewError('REVIEW_UNAVAILABLE', 'The project review stream is unavailable.');
  }
  // Unknown service failures fail closed: the stream is not usable.
  return reviewError('REVIEW_UNAVAILABLE', 'The project review stream is unavailable.');
}

export function createBrowserReviewApi(options: BrowserReviewApiOptions): BrowserReviewApiSurface {
  const api = new BrowserReviewApiImpl(options);
  // `reviews/history` is registered before `reviews/:commentId` so the
  // static segment always wins in order-sensitive routers.
  const reads: readonly { readonly path: string; readonly handler: Handler<HostListenerEnv> }[] = [
    { path: BROWSER_PROJECT_REVIEWS_PATH, handler: listHandler(api) },
    { path: BROWSER_PROJECT_REVIEW_HISTORY_PATH, handler: historyHandler(api) },
    { path: BROWSER_PROJECT_REVIEW_PATH, handler: getHandler(api) },
    { path: BROWSER_PROJECT_GATES_PATH, handler: gateListHandler(api) },
  ];
  const mutations: readonly {
    readonly method: MutationHttpMethod;
    readonly path: string;
    readonly handler: Handler<HostListenerEnv>;
  }[] = [
    { method: 'POST', path: BROWSER_PROJECT_REVIEWS_PATH, handler: addHandler(api) },
    { method: 'POST', path: BROWSER_PROJECT_REVIEW_PATH, handler: updateHandler(api) },
    { method: 'POST', path: BROWSER_PROJECT_GATE_DECISION_PATH, handler: gateDecideHandler(api) },
  ];
  return {
    register(host: HostServer): void {
      for (const route of reads) host.registerReadRoute(route.path, route.handler);
      for (const route of mutations)
        host.registerMutationRoute(route.method, route.path, route.handler);
    },
  };
}

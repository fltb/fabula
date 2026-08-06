// ============================================================================
// Review System — Append-only event stream: types, projection, legacy import
// ----------------------------------------------------------------------------
// The review event stream is the single source of truth for comments, release
// gates and decisions. `ReviewEventRecordV1` entries are immutable and
// sequence-numbered per project; current state is ALWAYS derived by
// `projectReviewState`. The old mutable `ledger` key is imported once by the
// storage adapter (never dual-written).
// ============================================================================

import type { JsonValue } from '../contracts/json.ts';
import { reviewLedgerV1Schema } from '../schemas/review.ts';
import type { ReviewApplicationV1, ReviewComment, ReviewLedgerV1 } from '../types/review.ts';

// ——— Event kinds ———

export type ReviewEventKindV1 =
  | 'comment_added'
  | 'comment_replaced'
  | 'comment_status_changed'
  | 'comment_applied'
  | 'gate_opened'
  | 'gate_decided'
  | 'gate_superseded';

// ——— Comment payload shapes ———

/** A comment as recorded at creation: status is always 'open' at that point. */
export interface ReviewCommentDraftV1 {
  readonly id: string;
  readonly author: ReviewComment['author'];
  readonly actorId: string;
  readonly target: ReviewComment['target'];
  readonly severity: ReviewComment['severity'];
  readonly category: ReviewComment['category'];
  readonly content: string;
  readonly applications: readonly ReviewApplicationV1[];
  readonly supersedesId?: string;
  readonly createdAt: string;
}

export interface ReviewCommentReplacedPayloadV1 {
  readonly replacedCommentId: string;
  readonly replacement: ReviewCommentDraftV1;
  readonly at: string;
  readonly by: string;
}

export interface ReviewCommentStatusChangedPayloadV1 {
  readonly to: Exclude<ReviewComment['status'], never>;
  readonly at?: string;
  readonly by?: string;
  readonly severity?: ReviewComment['severity'];
}

export interface ReviewCommentAppliedPayloadV1 {
  readonly application: ReviewApplicationV1;
  readonly addressed?: boolean;
}

// ——— Gate payload shapes ———

/** Immutable identity of a release gate, bound to one candidate revision. */
export interface ReviewGateInputV1 {
  readonly gateId: string;
  readonly sourceHash: string;
  readonly eventId: string;
  readonly proseHash: string;
  readonly scopeHash: string;
  readonly validationIdentity: string;
  readonly warningFingerprints: readonly string[];
  readonly revisionId: string;
}

export interface ReviewGateDecisionV1 {
  readonly gateId: string;
  readonly decision: 'waived' | 'rejected' | 'accepted';
  readonly revisionId: string;
  readonly capabilityVersion: number;
  readonly reason: string;
  readonly actorId: string;
  readonly createdAt: string;
}

// ——— Event record ———

/** Immutable, sequence-numbered event as stored by the review event store. */
export interface ReviewEventRecordV1 {
  readonly version: 1;
  readonly sequence: number;
  readonly projectId: string;
  readonly kind: ReviewEventKindV1;
  readonly commentId?: string;
  readonly gateId?: string;
  readonly payload: JsonValue;
  readonly actorId?: string;
  readonly createdAt: string;
}

/** An event submitted for append; the store assigns `sequence`. */
export type ReviewEventDraftV1 = Omit<ReviewEventRecordV1, 'sequence'>;

export interface ReviewEventReadResultV1 {
  /** Count of events in the stream: the `expectedVersion` the next append must pass. */
  readonly version: number;
  readonly events: readonly ReviewEventRecordV1[];
}

// ——— Projected state ———

/** Current gate state derived from `gate_opened`/`gate_decided`/`gate_superseded`. */
export interface ReviewGateV1 extends ReviewGateInputV1 {
  readonly openedAt: string;
  readonly openedBy: string;
  readonly status: 'open' | 'decided' | 'superseded';
  readonly decision: ReviewGateDecisionV1 | null;
  readonly supersededAt?: string;
  readonly supersededBy?: string;
  readonly supersedeReason?: string;
}

export interface ReviewProjectionV1 {
  readonly version: number;
  readonly events: readonly ReviewEventRecordV1[];
  readonly comments: readonly ReviewComment[];
  readonly gates: readonly ReviewGateV1[];
}

// ——— Lenient payload parsing (projection is total over the stream) ———

/** Canonical JSON normalization used for event payloads and content hashes. */
export function canonicalJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Review record contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value === 'object') {
    const object: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) object[key] = canonicalJsonValue(entry);
    }
    return object;
  }
  throw new Error('Review record contains a non-JSON value');
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const asStringArray = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as string[])
    : null;

function parseCommentDraft(payload: JsonValue): ReviewCommentDraftV1 | null {
  const record = asRecord(payload);
  const comment = record ? asRecord(record.comment) : null;
  if (comment === null) return null;
  const id = asString(comment.id);
  const actorId = asString(comment.actorId);
  const createdAt = asString(comment.createdAt);
  const target = asRecord(comment.target);
  const applications = Array.isArray(comment.applications)
    ? (comment.applications as ReviewApplicationV1[])
    : [];
  if (id === null || actorId === null || createdAt === null || target === null) return null;
  if (typeof comment.author !== 'string') return null;
  if (typeof comment.severity !== 'string') return null;
  if (typeof comment.category !== 'string') return null;
  if (typeof comment.content !== 'string') return null;
  const draft: ReviewCommentDraftV1 = {
    id,
    author: comment.author as ReviewComment['author'],
    actorId,
    target: target as ReviewComment['target'],
    severity: comment.severity as ReviewComment['severity'],
    category: comment.category as ReviewComment['category'],
    content: comment.content,
    applications,
    createdAt,
    ...(typeof comment.supersedesId === 'string' ? { supersedesId: comment.supersedesId } : {}),
  };
  return draft;
}

function parseReplacedPayload(payload: JsonValue): ReviewCommentReplacedPayloadV1 | null {
  const record = asRecord(payload);
  if (record === null) return null;
  const replacedCommentId = asString(record.replacedCommentId);
  const at = asString(record.at);
  const by = asString(record.by);
  if (replacedCommentId === null || at === null || by === null) return null;
  const replacement = parseCommentDraft({ comment: record.replacement } as JsonValue);
  if (replacement === null) return null;
  return { replacedCommentId, replacement, at, by };
}

function parseStatusChangedPayload(payload: JsonValue): ReviewCommentStatusChangedPayloadV1 | null {
  const record = asRecord(payload);
  if (record === null) return null;
  const to = asString(record.to);
  if (to === null) return null;
  const COMMENT_STATUSES: Record<string, true> = {
    open: true,
    addressed: true,
    resolved: true,
    wontfix: true,
    superseded: true,
  };
  if (COMMENT_STATUSES[to] !== true) return null;
  const at = asString(record.at);
  const by = asString(record.by);
  const parsed: ReviewCommentStatusChangedPayloadV1 = {
    to: to as ReviewCommentStatusChangedPayloadV1['to'],
    ...(at !== null ? { at } : {}),
    ...(by !== null ? { by } : {}),
    ...(record.severity === 'blocking' ? { severity: 'blocking' as const } : {}),
  };
  return parsed;
}

function parseAppliedPayload(payload: JsonValue): ReviewCommentAppliedPayloadV1 | null {
  const record = asRecord(payload);
  if (record === null) return null;
  const application = asRecord(record.application);
  if (application === null) return null;
  if (
    asString(application.eventId) === null ||
    asString(application.revisionId) === null ||
    asString(application.operationId) === null ||
    asString(application.appliedAt) === null
  )
    return null;
  return {
    application: application as unknown as ReviewApplicationV1,
    addressed: record.addressed === true,
  };
}

function parseGateInput(payload: JsonValue): ReviewGateInputV1 | null {
  const record = asRecord(payload);
  const gate = record ? asRecord(record.gate) : null;
  if (gate === null) return null;
  const gateId = asString(gate.gateId);
  const sourceHash = asString(gate.sourceHash);
  const eventId = asString(gate.eventId);
  const proseHash = asString(gate.proseHash);
  const scopeHash = asString(gate.scopeHash);
  const validationIdentity = asString(gate.validationIdentity);
  const revisionId = asString(gate.revisionId);
  const warningFingerprints = asStringArray(gate.warningFingerprints);
  if (
    gateId === null ||
    sourceHash === null ||
    eventId === null ||
    proseHash === null ||
    scopeHash === null ||
    validationIdentity === null ||
    revisionId === null ||
    warningFingerprints === null
  )
    return null;
  return {
    gateId,
    sourceHash,
    eventId,
    proseHash,
    scopeHash,
    validationIdentity,
    warningFingerprints,
    revisionId,
  };
}

function parseGateDecision(payload: JsonValue): ReviewGateDecisionV1 | null {
  const record = asRecord(payload);
  const decision = record ? asRecord(record.decision) : null;
  if (decision === null) return null;
  const gateId = asString(decision.gateId);
  const decisionValue = asString(decision.decision);
  const revisionId = asString(decision.revisionId);
  const reason = asString(decision.reason);
  const actorId = asString(decision.actorId);
  const createdAt = asString(decision.createdAt);
  if (
    gateId === null ||
    decisionValue === null ||
    revisionId === null ||
    reason === null ||
    actorId === null ||
    createdAt === null
  )
    return null;
  const GATE_DECISIONS: Record<string, true> = {
    waived: true,
    rejected: true,
    accepted: true,
  };
  if (GATE_DECISIONS[decisionValue] !== true) return null;
  if (typeof decision.capabilityVersion !== 'number') return null;
  return {
    gateId,
    decision: decisionValue as ReviewGateDecisionV1['decision'],
    revisionId,
    capabilityVersion: decision.capabilityVersion,
    reason,
    actorId,
    createdAt,
  };
}

// ——— Projection ———

/**
 * Derive the full current review state (comments, gates, history) from an
 * ordered event stream. Pure and total: events referencing unknown comments
 * or gates are skipped, never fatal.
 */
export function projectReviewState(events: readonly ReviewEventRecordV1[]): ReviewProjectionV1 {
  const comments = new Map<string, ReviewComment>();
  const gates = new Map<string, ReviewGateV1>();

  for (const event of events) {
    switch (event.kind) {
      case 'comment_added': {
        const draft = parseCommentDraft(event.payload);
        if (draft === null) break;
        comments.set(draft.id, { ...draft, status: 'open', applications: [...draft.applications] });
        break;
      }
      case 'comment_replaced': {
        const payload = parseReplacedPayload(event.payload);
        if (payload === null) break;
        const original = comments.get(payload.replacedCommentId);
        if (original === undefined) break;
        comments.set(original.id, {
          ...original,
          status: 'superseded',
          resolvedAt: payload.at,
          resolvedBy: payload.by,
        });
        comments.set(payload.replacement.id, {
          ...payload.replacement,
          status: 'open',
          applications: [...payload.replacement.applications],
        });
        break;
      }
      case 'comment_status_changed': {
        const payload = parseStatusChangedPayload(event.payload);
        if (payload === null) break;
        const id = event.commentId ?? '';
        const comment = comments.get(id);
        if (comment === undefined) break;
        if (payload.to === 'open') {
          const { resolvedAt: _resolvedAt, resolvedBy: _resolvedBy, ...rest } = comment;
          comments.set(id, {
            ...rest,
            status: 'open',
            ...(payload.severity !== undefined ? { severity: payload.severity } : {}),
          });
        } else if (payload.to === 'addressed') {
          comments.set(id, { ...comment, status: 'addressed' });
        } else {
          comments.set(id, {
            ...comment,
            status: payload.to,
            resolvedAt: payload.at ?? event.createdAt,
            resolvedBy: payload.by ?? event.actorId ?? comment.actorId,
          });
        }
        break;
      }
      case 'comment_applied': {
        const payload = parseAppliedPayload(event.payload);
        if (payload === null) break;
        const id = event.commentId ?? '';
        const comment = comments.get(id);
        if (comment === undefined) break;
        comments.set(id, {
          ...comment,
          applications: [...comment.applications, payload.application],
          ...(payload.addressed ? { status: 'addressed' } : {}),
        });
        break;
      }
      case 'gate_opened': {
        const gate = parseGateInput(event.payload);
        if (gate === null) break;
        gates.set(gate.gateId, {
          ...gate,
          openedAt: event.createdAt,
          openedBy: event.actorId ?? '',
          status: 'open',
          decision: null,
        });
        break;
      }
      case 'gate_decided': {
        const decision = parseGateDecision(event.payload);
        if (decision === null) break;
        const gate = gates.get(decision.gateId);
        if (gate === undefined || gate.status === 'superseded') break;
        gates.set(gate.gateId, { ...gate, status: 'decided', decision });
        break;
      }
      case 'gate_superseded': {
        const record = asRecord(event.payload);
        const reason = record !== null && typeof record.reason === 'string' ? record.reason : '';
        const gate = gates.get(event.gateId ?? '');
        if (gate === undefined) break;
        gates.set(gate.gateId, {
          ...gate,
          status: 'superseded',
          supersededAt: event.createdAt,
          supersededBy: event.actorId,
          supersedeReason: reason,
        });
        break;
      }
    }
  }

  return {
    version: events.length,
    events,
    comments: [...comments.values()],
    gates: [...gates.values()],
  };
}

// ——— Legacy mutable-ledger import ———

function toReviewLedger(value: ReviewLedgerV1): ReviewLedgerV1 {
  return {
    version: 1,
    comments: value.comments.map(
      (comment): ReviewComment => ({
        ...comment,
        applications: comment.applications.map((application) => ({ ...application })),
      }),
    ),
    patches: value.patches.map((patch): ReviewLedgerV1['patches'][number] => ({
      ...patch,
      changes: patch.changes.map((change) => ({ ...change })),
    })),
  };
}

function normalizeLegacyLedger(raw: Record<string, unknown>): ReviewLedgerV1 {
  const comments = Array.isArray(raw.comments)
    ? raw.comments.map((entry) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
          throw new Error('Invalid review comment');
        return {
          ...entry,
          actorId: typeof entry.actorId === 'string' ? entry.actorId : 'legacy',
          applications: Array.isArray(entry.applications) ? entry.applications : [],
        };
      })
    : [];
  const patches = Array.isArray(raw.patches) ? raw.patches : [];
  return toReviewLedger({ version: 1, comments, patches } as ReviewLedgerV1);
}

/**
 * Parse the stored legacy review value (a v1 ledger or an older unversioned
 * shape) into a normalized `ReviewLedgerV1`. Throws when the value is not a
 * review ledger at all.
 */
export function parseLegacyReviewLedger(value: unknown): ReviewLedgerV1 {
  const parsed = reviewLedgerV1Schema.safeParse(value);
  if (parsed.success) return toReviewLedger(parsed.data);
  const raw = asRecord(value);
  if (raw === null || raw.version !== undefined) throw new Error('Invalid review ledger structure');
  return normalizeLegacyLedger(raw);
}

/**
 * Convert a legacy ledger into the equivalent append-only event drafts:
 * one `comment_added` per comment (status forced to 'open', applications
 * preserved) plus one `comment_status_changed` for every non-open status.
 * Sequences are assigned by the store at append time.
 */
export function legacyLedgerToReviewEvents(input: {
  readonly projectId: string;
  readonly ledger: ReviewLedgerV1;
  readonly createdAt: string;
  readonly actorId?: string;
}): ReviewEventDraftV1[] {
  const drafts: ReviewEventDraftV1[] = [];
  for (const comment of input.ledger.comments) {
    const { status, resolvedAt, resolvedBy, ...base } = comment;
    drafts.push({
      version: 1,
      projectId: input.projectId,
      kind: 'comment_added',
      commentId: comment.id,
      payload: canonicalJsonValue({ comment: { ...base } }),
      actorId: comment.actorId,
      createdAt: comment.createdAt,
    });
    if (status !== 'open') {
      drafts.push({
        version: 1,
        projectId: input.projectId,
        kind: 'comment_status_changed',
        commentId: comment.id,
        payload: canonicalJsonValue({
          to: status,
          at: resolvedAt ?? comment.createdAt,
          by: resolvedBy ?? comment.actorId,
        }),
        actorId: input.actorId,
        createdAt: input.createdAt,
      });
    }
  }
  return drafts;
}

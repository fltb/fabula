import { sha256Canonical } from '../cache/render-cache.ts';
import { EditorialOperationError } from '../editorial/errors.ts';
import type { CoreExecutionRepository } from '../ports/execution-repository.ts';
import type { Clock, IdGenerator } from '../ports/runtime-services.ts';
import { reviewCommentSchema, reviewEventRecordV1Schema } from '../schemas/review.ts';
import type {
  NewReviewComment,
  ReviewApplicationV1,
  ReviewComment,
  ReviewLedgerV1,
} from '../types/index.js';
import {
  canonicalJsonValue,
  projectReviewState,
  type ReviewEventDraftV1,
  type ReviewEventRecordV1,
  type ReviewGateDecisionV1,
  type ReviewGateInputV1,
  type ReviewGateV1,
  type ReviewProjectionV1,
} from './events.js';
import { getSummary } from './summary.js';
import type { CommentFilter, ReviewServices, StatusSummary } from './types.js';

// Deterministic fallbacks when the host does not inject services — never
// wall-clock or random UUIDs, so identical inputs yield identical streams.
const FALLBACK_CLOCK: Clock = { now: () => '1970-01-01T00:00:00.000Z' };

/** Deterministic sequential comment ID fallback — unique per manager, never random. */
class SequentialReviewIdGenerator implements IdGenerator {
  private sequence = 0;
  next(): string {
    this.sequence += 1;
    return `rev_${this.sequence}`;
  }
}

/** Deterministic content hash of the projected comment state (empty → null). */
function commentStateHash(comments: readonly ReviewComment[]): string | null {
  if (comments.length === 0) return null;
  return sha256Canonical(canonicalJsonValue(comments));
}

export interface ReviewLedgerSnapshot {
  ledger: ReviewLedgerV1;
  contentHash: string | null;
  legacy: boolean;
  version: number | null;
}

const MAX_APPEND_ATTEMPTS = 5;

export class ReviewManager {
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(
    private readonly execution: CoreExecutionRepository,
    private readonly projectId: string,
    services?: Partial<ReviewServices>,
  ) {
    this.clock = services?.clock ?? FALLBACK_CLOCK;
    this.ids = services?.ids ?? new SequentialReviewIdGenerator();
  }

  /** Read + validate the event stream and project current state from it. */
  private async readState(): Promise<ReviewProjectionV1> {
    const { events } = await this.execution.readReviewEvents({ projectId: this.projectId });
    for (const event of events) {
      if (!reviewEventRecordV1Schema.safeParse(event).success)
        throw new EditorialOperationError('STORAGE_CONFLICT', 'Invalid review event stream');
    }
    return projectReviewState(events);
  }

  /** Legacy-compat read: a projected ledger snapshot. Patches are not part of the event stream. */
  async readLedger(): Promise<ReviewLedgerSnapshot> {
    const state = await this.readState();
    return {
      ledger: {
        version: 1,
        comments: state.comments.map((comment) => ({ ...comment })),
        patches: [],
      },
      contentHash: commentStateHash(state.comments),
      legacy: false,
      version: state.version === 0 ? null : state.version,
    };
  }

  /**
   * Append one or more events with CAS-on-version; on conflict re-read the
   * current version and retry. Every mutation funnels through here so the
   * stream stays the single source of truth.
   */
  private async appendEvents(
    drafts: readonly ReviewEventDraftV1[],
  ): Promise<readonly ReviewEventRecordV1[]> {
    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
      const { version } = await this.execution.readReviewEvents({ projectId: this.projectId });
      const result = await this.execution.appendReviewEvents({
        projectId: this.projectId,
        expectedVersion: version,
        events: drafts,
      });
      if (result.kind === 'committed') return result.value;
    }
    throw new EditorialOperationError('STORAGE_CONFLICT', 'Review event stream write conflict');
  }

  private assertHash(state: ReviewProjectionV1, expected?: string) {
    if (expected === undefined) return;
    const hash = commentStateHash(state.comments);
    if (hash !== expected)
      throw new EditorialOperationError(
        'STORAGE_CONFLICT',
        'Expected review ledger hash does not match current content',
      );
  }

  async addReviewComment(
    input: NewReviewComment,
    actorId: string,
    opts?: { expectedLedgerHash?: string },
    sceneLineCount?: number,
  ): Promise<ReviewComment> {
    this.validateLine(input, sceneLineCount);
    const state = await this.readState();
    this.assertHash(state, opts?.expectedLedgerHash);
    const comment: ReviewComment = {
      id: this.ids.next({ kind: 'review_comment' }),
      author: 'human',
      actorId: actorId.trim(),
      target: input.target,
      severity: input.severity,
      category: input.category,
      content: input.content,
      status: 'open',
      applications: [],
      createdAt: this.clock.now(),
    };
    const { status: _status, resolvedAt: _resolvedAt, resolvedBy: _resolvedBy, ...draft } = comment;
    await this.appendEvents([
      {
        version: 1,
        projectId: this.projectId,
        kind: 'comment_added',
        commentId: comment.id,
        payload: canonicalJsonValue({ comment: draft }),
        actorId: comment.actorId,
        createdAt: comment.createdAt,
      },
    ]);
    return comment;
  }

  async getComments(filter?: CommentFilter): Promise<ReviewComment[]> {
    const { comments } = await this.readState();
    return comments
      .filter(
        (c) =>
          (!filter?.status || c.status === filter.status) &&
          (!filter?.severity || c.severity === filter.severity) &&
          (!filter?.targetType || c.target.type === filter.targetType) &&
          (!filter?.targetId || c.target.id === filter.targetId),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async getApplicableOpenComments(eventId: string, chapterNum: number): Promise<ReviewComment[]> {
    const { comments } = await this.readState();
    const applicable = comments.filter(
      (c) =>
        c.status === 'open' &&
        (c.target.type === 'novel' ||
          (c.target.type === 'chapter' && c.target.id === `chapter:${chapterNum}`) ||
          ((c.target.type === 'scene' || c.target.type === 'line') && c.target.id === eventId)),
    );
    const order: Record<string, number> = { novel: 0, chapter: 1, scene: 2, line: 3 };
    return applicable.sort(
      (a, b) =>
        order[a.target.type] - order[b.target.type] ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  }

  async replaceReviewComment(
    id: string,
    input: NewReviewComment,
    actorId: string,
    opts?: { expectedLedgerHash?: string },
    sceneLineCount?: number,
  ): Promise<ReviewComment> {
    this.validateLine(input, sceneLineCount);
    const state = await this.readState();
    this.assertHash(state, opts?.expectedLedgerHash);
    const commentsById = new Map(state.comments.map((c) => [c.id, c] as const));
    const original = commentsById.get(id);
    if (!original)
      throw new EditorialOperationError('INVALID_OPERATION', `Comment ${id} not found`);
    if (original.status === 'superseded')
      throw new EditorialOperationError('INVALID_OPERATION', `Comment ${id} is already superseded`);
    const now = this.clock.now();
    const trimmed = actorId.trim();
    const replacement: ReviewComment = {
      id: this.ids.next({ kind: 'review_comment' }),
      author: 'human',
      actorId: trimmed,
      target: input.target,
      severity: input.severity,
      category: input.category,
      content: input.content,
      status: 'open',
      applications: [],
      supersedesId: id,
      createdAt: now,
    };
    const {
      status: _status,
      resolvedAt: _resolvedAt,
      resolvedBy: _resolvedBy,
      ...replacementDraft
    } = replacement;
    await this.appendEvents([
      {
        version: 1,
        projectId: this.projectId,
        kind: 'comment_replaced',
        commentId: id,
        payload: canonicalJsonValue({
          replacedCommentId: id,
          replacement: replacementDraft,
          at: now,
          by: trimmed,
        }),
        actorId: trimmed,
        createdAt: now,
      },
    ]);
    return replacement;
  }

  async updateReviewComment(
    id: string,
    action: 'resolve' | 'wontfix' | 'reopen' | 'escalate',
    actorId: string,
    opts?: { expectedLedgerHash?: string },
  ): Promise<ReviewComment> {
    const state = await this.readState();
    this.assertHash(state, opts?.expectedLedgerHash);
    const commentsById = new Map(state.comments.map((c) => [c.id, c] as const));
    const comment = commentsById.get(id);
    if (!comment) throw new EditorialOperationError('INVALID_OPERATION', `Comment ${id} not found`);
    if (comment.status === 'superseded')
      throw new EditorialOperationError('INVALID_OPERATION', `Comment ${id} is superseded`);
    const now = this.clock.now();
    let payload: { to: ReviewComment['status']; at?: string; by?: string; severity?: 'blocking' };
    let updated: ReviewComment;
    if (action === 'resolve' || action === 'wontfix') {
      payload = { to: action === 'resolve' ? 'resolved' : 'wontfix', at: now, by: actorId };
      updated = {
        ...comment,
        status: action === 'resolve' ? 'resolved' : 'wontfix',
        resolvedAt: now,
        resolvedBy: actorId,
      };
    } else if (action === 'reopen') {
      payload = { to: 'open' };
      const { resolvedAt: _resolvedAt, resolvedBy: _resolvedBy, ...rest } = comment;
      updated = { ...rest, status: 'open' };
    } else {
      payload = { to: 'open', severity: 'blocking' };
      const { resolvedAt: _resolvedAt, resolvedBy: _resolvedBy, ...rest } = comment;
      updated = { ...rest, severity: 'blocking', status: 'open' };
    }
    updated = reviewCommentSchema.parse(updated);
    await this.appendEvents([
      {
        version: 1,
        projectId: this.projectId,
        kind: 'comment_status_changed',
        commentId: id,
        payload,
        actorId,
        createdAt: now,
      },
    ]);
    return updated;
  }

  /**
   * Record `comment_applied` events for a completed revision. Each entry maps
   * a comment id to the application (and whether the comment is addressed).
   * Unknown comment ids are ignored; the events are appended atomically with
   * the same version CAS as every other mutation.
   */
  async recordCommentApplications(
    applications: ReadonlyMap<
      string,
      { readonly application: ReviewApplicationV1; readonly addressed: boolean }
    >,
  ): Promise<ReviewComment[]> {
    const state = await this.readState();
    const commentsById = new Map(state.comments.map((c) => [c.id, c] as const));
    const now = this.clock.now();
    const drafts: ReviewEventDraftV1[] = [];
    const updated: ReviewComment[] = [];
    for (const [id, entry] of applications) {
      const comment = commentsById.get(id);
      if (!comment) continue;
      drafts.push({
        version: 1,
        projectId: this.projectId,
        kind: 'comment_applied',
        commentId: id,
        payload: canonicalJsonValue({ application: entry.application, addressed: entry.addressed }),
        createdAt: now,
      });
      updated.push({
        ...comment,
        applications: [...comment.applications, entry.application],
        ...(entry.addressed ? { status: 'addressed' } : {}),
      });
    }
    if (drafts.length > 0) await this.appendEvents(drafts);
    return updated;
  }

  async applyComments(
    ids: string[],
    application: ReviewApplicationV1,
    addressed: Set<string>,
  ): Promise<ReviewComment[]> {
    const state = await this.readState();
    const commentsById = new Map(state.comments.map((c) => [c.id, c] as const));
    for (const id of ids)
      if (!commentsById.has(id))
        throw new EditorialOperationError('INVALID_OPERATION', `Comment ${id} not found`);
    return this.recordCommentApplications(
      new Map(ids.map((id) => [id, { application, addressed: addressed.has(id) }] as const)),
    );
  }

  async openGate(
    input: ReviewGateInputV1,
    actorId: string,
    opts?: { expectedLedgerHash?: string },
  ): Promise<ReviewGateV1> {
    const state = await this.readState();
    this.assertHash(state, opts?.expectedLedgerHash);
    const now = this.clock.now();
    await this.appendEvents([
      {
        version: 1,
        projectId: this.projectId,
        kind: 'gate_opened',
        gateId: input.gateId,
        payload: canonicalJsonValue({ gate: input }),
        actorId,
        createdAt: now,
      },
    ]);
    return { ...input, openedAt: now, openedBy: actorId, status: 'open', decision: null };
  }

  async decideGate(
    input: {
      readonly gateId: string;
      readonly decision: 'waived' | 'rejected' | 'accepted';
      readonly revisionId: string;
      readonly capabilityVersion: number;
      readonly reason: string;
    },
    actorId: string,
    opts?: { expectedLedgerHash?: string },
  ): Promise<ReviewGateV1> {
    const state = await this.readState();
    this.assertHash(state, opts?.expectedLedgerHash);
    const gate = state.gates.find((candidate) => candidate.gateId === input.gateId);
    if (!gate)
      throw new EditorialOperationError('INVALID_OPERATION', `Gate ${input.gateId} not found`);
    if (gate.status !== 'open')
      throw new EditorialOperationError('INVALID_OPERATION', `Gate ${input.gateId} is not open`);
    const now = this.clock.now();
    const decision: ReviewGateDecisionV1 = { ...input, actorId, createdAt: now };
    await this.appendEvents([
      {
        version: 1,
        projectId: this.projectId,
        kind: 'gate_decided',
        gateId: input.gateId,
        payload: canonicalJsonValue({ decision }),
        actorId,
        createdAt: now,
      },
    ]);
    return { ...gate, status: 'decided', decision };
  }

  async supersedeGate(
    gateId: string,
    reason: string,
    actorId: string,
    opts?: { expectedLedgerHash?: string },
  ): Promise<void> {
    const state = await this.readState();
    this.assertHash(state, opts?.expectedLedgerHash);
    const gate = state.gates.find((candidate) => candidate.gateId === gateId);
    if (!gate) throw new EditorialOperationError('INVALID_OPERATION', `Gate ${gateId} not found`);
    if (gate.status === 'superseded')
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Gate ${gateId} is already superseded`,
      );
    const now = this.clock.now();
    await this.appendEvents([
      {
        version: 1,
        projectId: this.projectId,
        kind: 'gate_superseded',
        gateId,
        payload: canonicalJsonValue({ reason }),
        actorId,
        createdAt: now,
      },
    ]);
  }

  async getGates(): Promise<ReviewGateV1[]> {
    return [...(await this.readState()).gates];
  }

  async getGate(gateId: string): Promise<ReviewGateV1 | null> {
    return (await this.readState()).gates.find((candidate) => candidate.gateId === gateId) ?? null;
  }

  async getHistory(): Promise<ReviewEventRecordV1[]> {
    return [...(await this.readState()).events];
  }

  async getPatches(): Promise<ReviewLedgerV1['patches']> {
    // Patches were never written by the stream-based manager; the old ledger
    // `patches` array is not part of the append-only event model.
    return [];
  }
  async getSummary(): Promise<StatusSummary> {
    return getSummary([...(await this.readState()).comments], 0);
  }

  private validateLine(input: NewReviewComment, count?: number) {
    if (
      input.target.type === 'line' &&
      count !== undefined &&
      input.target.lineRange &&
      input.target.lineRange[1] > count
    )
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Line range end ${input.target.lineRange[1]} exceeds scene line count ${count}`,
      );
  }
}

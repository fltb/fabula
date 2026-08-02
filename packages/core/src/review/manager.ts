import { EditorialOperationError } from '../editorial/errors.ts';
import type { CoreExecutionRepository } from '../ports/execution-repository.ts';
import { sha256Canonical } from '../cache/render-cache.ts';
import type { JsonObject, JsonValue } from '../contracts/json.ts';
import { reviewCommentSchema, reviewLedgerV1Schema } from '../schemas/review.ts';
import type { NewReviewComment, ReviewApplicationV1, ReviewComment, ReviewLedgerV1, ReviewPatch } from '../types/index.js';
import { getSummary } from './summary.js';
import type { CommentFilter, StatusSummary } from './types.js';

function canonicalJsonValue(value: unknown): JsonValue {
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

function asJsonObject(value: JsonValue): JsonObject | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as JsonObject;
}

function toReviewLedger(value: unknown): ReviewLedgerV1 {
  const parsed = reviewLedgerV1Schema.parse(value);
  return {
    version: 1,
    comments: parsed.comments.map((comment): ReviewComment => ({ ...comment, applications: comment.applications.map((application) => ({ ...application })) })),
    patches: parsed.patches.map((patch): ReviewPatch => ({ ...patch, changes: patch.changes.map((change) => ({ ...change })) })),
  };
}

export interface ReviewLedgerSnapshot { ledger: ReviewLedgerV1; contentHash: string | null; legacy: boolean; version: number | null; }
const key = 'ledger';

export class ReviewManager {
  constructor(private readonly execution: CoreExecutionRepository, private readonly projectId: string) {}

  async readLedger(): Promise<ReviewLedgerSnapshot> {
    const record = await this.execution.readReview({ projectId: this.projectId, reviewId: key });
    if (!record) return { ledger: { version: 1, comments: [], patches: [] }, contentHash: null, legacy: false, version: null };
    const parsed = reviewLedgerV1Schema.safeParse(record.value.value);
    if (parsed.success) {
      const ledger = toReviewLedger(parsed.data);
      return { ledger, contentHash: sha256Canonical(canonicalJsonValue(ledger)), legacy: false, version: record.revision };
    }
    const raw = asJsonObject(record.value.value);
    if (raw === null) throw new Error('Invalid review ledger structure');
    if (raw.version !== undefined) throw new Error('Invalid review ledger structure');
    const ledger = this.normalizeLegacy(raw);
    return { ledger, contentHash: sha256Canonical(canonicalJsonValue(ledger)), legacy: true, version: record.revision };
  }

  async addReviewComment(input: NewReviewComment, actorId: string, opts?: { expectedLedgerHash?: string }, sceneLineCount?: number): Promise<ReviewComment> {
    this.validateLine(input, sceneLineCount);
    const current = await this.readLedger();
    this.assertHash(current, opts?.expectedLedgerHash);
    const comment: ReviewComment = { id: `rev_${globalThis.crypto.randomUUID()}`, author: 'human', actorId: actorId.trim(), target: input.target, severity: input.severity, category: input.category, content: input.content, status: 'open', applications: [], createdAt: new Date().toISOString() };
    await this.persist({ ...current.ledger, comments: [...current.ledger.comments, comment] }, current.version);
    return comment;
  }

  async getComments(filter?: CommentFilter): Promise<ReviewComment[]> {
    const { ledger } = await this.readLedger();
    return ledger.comments.filter(c => (!filter?.status || c.status === filter.status) && (!filter?.severity || c.severity === filter.severity) && (!filter?.targetType || c.target.type === filter.targetType) && (!filter?.targetId || c.target.id === filter.targetId)).sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async getApplicableOpenComments(eventId: string, chapterNum: number): Promise<ReviewComment[]> {
    const comments = (await this.readLedger()).ledger.comments.filter(c => c.status === 'open' && (c.target.type === 'novel' || (c.target.type === 'chapter' && c.target.id === `chapter:${chapterNum}`) || ((c.target.type === 'scene' || c.target.type === 'line') && c.target.id === eventId)));
    const order: Record<string, number> = { novel: 0, chapter: 1, scene: 2, line: 3 };
    return comments.sort((a,b) => order[a.target.type] - order[b.target.type] || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async replaceReviewComment(id: string, input: NewReviewComment, actorId: string, opts?: { expectedLedgerHash?: string }, sceneLineCount?: number): Promise<ReviewComment> {
    this.validateLine(input, sceneLineCount);
    const current = await this.readLedger(); this.assertHash(current, opts?.expectedLedgerHash);
    const index = current.ledger.comments.findIndex(c => c.id === id); if (index < 0) throw new EditorialOperationError('INVALID_OPERATION', `Comment ${id} not found`);
    const original = current.ledger.comments[index]; if (original.status === 'superseded') throw new EditorialOperationError('INVALID_OPERATION', `Comment ${id} is already superseded`);
    const now = new Date().toISOString(); const replacement: ReviewComment = { id: `rev_${globalThis.crypto.randomUUID()}`, author: 'human', actorId: actorId.trim(), target: input.target, severity: input.severity, category: input.category, content: input.content, status: 'open', applications: [], supersedesId: id, createdAt: now };
    const comments = [...current.ledger.comments]; comments[index] = { ...original, status: 'superseded', resolvedAt: now, resolvedBy: actorId.trim() }; comments.push(replacement);
    await this.persist({ ...current.ledger, comments }, current.version); return replacement;
  }

  async updateReviewComment(id: string, action: 'resolve'|'wontfix'|'reopen'|'escalate', actorId: string, opts?: { expectedLedgerHash?: string }): Promise<ReviewComment> {
    const current = await this.readLedger(); this.assertHash(current, opts?.expectedLedgerHash); const index = current.ledger.comments.findIndex(c => c.id === id); if (index < 0) throw new EditorialOperationError('INVALID_OPERATION', `Comment ${id} not found`);
    const comment = current.ledger.comments[index]; if (comment.status === 'superseded') throw new EditorialOperationError('INVALID_OPERATION', `Comment ${id} is superseded`);
    const now = new Date().toISOString();
    let updated: ReviewComment;
    if (action === 'resolve' || action === 'wontfix') {
      updated = { ...comment, status: action === 'resolve' ? 'resolved' : 'wontfix', resolvedAt: now, resolvedBy: actorId };
    } else if (action === 'reopen') {
      const { resolvedAt: _resolvedAt, resolvedBy: _resolvedBy, ...rest } = comment;
      updated = { ...rest, status: 'open' };
    } else {
      const { resolvedAt: _resolvedAt, resolvedBy: _resolvedBy, ...rest } = comment;
      updated = { ...rest, severity: 'blocking', status: 'open' };
    }
    updated = reviewCommentSchema.parse(updated);
    const comments: ReviewComment[] = [...current.ledger.comments]; comments[index] = updated; await this.persist({ ...current.ledger, comments }, current.version); return updated;
  }

  async applyComments(ids: string[], application: ReviewApplicationV1, addressed: Set<string>): Promise<ReviewComment[]> { const current = await this.readLedger(); for (const id of ids) if (!current.ledger.comments.some(c => c.id === id)) throw new EditorialOperationError('INVALID_OPERATION', `Comment ${id} not found`); const comments: ReviewComment[] = current.ledger.comments.map((comment): ReviewComment => { if (!ids.includes(comment.id)) return comment; const updated: ReviewComment = { ...comment, applications: [...comment.applications, application], status: addressed.has(comment.id) ? 'addressed' : comment.status }; return reviewCommentSchema.parse(updated); }); await this.persist({ ...current.ledger, comments }, current.version); return comments.filter(c => ids.includes(c.id)); }
  async getPatches(): Promise<ReviewPatch[]> { return (await this.readLedger()).ledger.patches; }
  async getSummary(): Promise<StatusSummary> { return getSummary((await this.readLedger()).ledger.comments, 0); }

  private validateLine(input: NewReviewComment, count?: number) { if (input.target.type === 'line' && count !== undefined && input.target.lineRange && input.target.lineRange[1] > count) throw new EditorialOperationError('INVALID_OPERATION', `Line range end ${input.target.lineRange[1]} exceeds scene line count ${count}`); }
  private assertHash(current: ReviewLedgerSnapshot, expected?: string) { if (expected !== undefined && current.contentHash !== expected) throw new EditorialOperationError('STORAGE_CONFLICT', 'Expected review ledger hash does not match current content'); }
  private async persist(ledger: ReviewLedgerV1, expectedVersion: number | null) { const value = canonicalJsonValue(toReviewLedger(ledger)); const result = await this.execution.compareAndSwapReview({ projectId: this.projectId, reviewId: key, expectedVersion, value: { version: 1, projectId: this.projectId, reviewId: key, value } }); if (result.kind === 'conflict') throw new EditorialOperationError('STORAGE_CONFLICT', 'Review ledger version conflict'); }
  private normalizeLegacy(raw: JsonObject): ReviewLedgerV1 { const comments = Array.isArray(raw.comments) ? raw.comments.map((entry) => { if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('Invalid review comment'); return { ...entry, actorId: typeof entry.actorId === 'string' ? entry.actorId : 'legacy', applications: Array.isArray(entry.applications) ? entry.applications : [] }; }) : []; const patches = Array.isArray(raw.patches) ? raw.patches : []; return toReviewLedger({ version: 1, comments, patches }); }
}

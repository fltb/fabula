// ============================================================================
// Review System — Storage-backed ReviewManager (V1)
// All authoritative writes use ProjectTransactionCoordinator transactions.
// No legacy in-memory API (no-arg constructor, addComment, resolve, etc.)
// ============================================================================

import * as crypto from 'node:crypto';
import { computeContentHash } from '../storage/hash.ts';
import type { Storage } from '../storage/types.ts';
import type { ProjectTransactionCoordinator } from '../editorial/transaction.ts';
import { EditorialOperationError } from '../editorial/errors.ts';
import { ConfigError, StorageConflictError } from '../errors.ts';
import { reviewLedgerV1Schema } from '../schemas/review.ts';
import type { CommentFilter, StatusSummary } from './types.js';
import { getSummary } from './summary.js';
import type {
  NewReviewComment,
  ReviewApplicationV1,
  ReviewComment,
  ReviewLedgerV1,
  ReviewPatch,
} from '../types/index.js';

// ─── Snapshot type ──────────────────────────────────────────────────────────

export interface ReviewLedgerSnapshot {
  ledger: ReviewLedgerV1;
  contentHash: string | null;
  legacy: boolean;
}

export class ReviewManager {

  private readonly storage: Storage;
  private readonly coordinator: ProjectTransactionCoordinator;
  private readonly ledgerPath: string;

  constructor(
    storage: Storage,
    coordinator: ProjectTransactionCoordinator,
    ledgerPath: string,
  ) {
    if ('storage' in coordinator && coordinator.storage !== storage) {
      throw new ConfigError(
        'ReviewManager storage must match coordinator storage',
        { path: ledgerPath },
      );
    }
    this.storage = storage;
    this.coordinator = coordinator;
    this.ledgerPath = ledgerPath;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  readLedger(): ReviewLedgerSnapshot {
    const content = this.storage.readOptional(this.ledgerPath);
    if (content === null) {
      return {
        ledger: { version: 1, comments: [], patches: [] },
        contentHash: null,
        legacy: false,
      };
    }

    const contentHash = computeContentHash(content);
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      throw new ConfigError('Invalid JSON in review ledger', {
        path: this.ledgerPath,
      });
    }

    if (typeof raw !== 'object' || raw === null) {
      throw new ConfigError('Invalid review ledger structure', {
        path: this.ledgerPath,
      });
    }

    // Try strict V1 schema first
    const v1Result = reviewLedgerV1Schema.safeParse(raw);
    if (v1Result.success) {
      return { ledger: v1Result.data, contentHash, legacy: false };
    }

    // Check for legacy format (no version field)
    const obj = raw as Record<string, unknown>;
    const hasVersion = 'version' in obj;
    if (!hasVersion) {
      const ledger = this.normalizeLegacy(obj);
      return { ledger, contentHash, legacy: true };
    }

    // Structurally invalid V1
    throw new ConfigError('Invalid review ledger structure', {
      path: this.ledgerPath,
    });
  }

  // ── Add ───────────────────────────────────────────────────────────────────

  addReviewComment(
    input: NewReviewComment,
    actorId: string,
    opts?: { expectedLedgerHash?: string },
    sceneLineCount?: number,
  ): ReviewComment {
    const trimmedActor = actorId.trim();

    // Validate line bounds
    if (
      input.target.type === 'line' &&
      sceneLineCount !== undefined &&
      input.target.lineRange
    ) {
      if (input.target.lineRange[1] > sceneLineCount) {
        throw new EditorialOperationError(
          'INVALID_OPERATION',
          `Line range end ${input.target.lineRange[1]} exceeds scene line count ${sceneLineCount}`,
        );
      }
    }

    // CAS check
    const current = this.readLedger();
    if (
      opts?.expectedLedgerHash !== undefined &&
      current.contentHash !== opts.expectedLedgerHash
    ) {
      throw new StorageConflictError(
        'Expected ledger hash does not match current content',
        { path: this.ledgerPath },
      );
    }

    const now = new Date().toISOString();
    const comment: ReviewComment = {
      id: `rev_${crypto.randomUUID()}`,
      author: 'human',
      actorId: trimmedActor,
      target: input.target,
      severity: input.severity,
      category: input.category,
      content: input.content,
      status: 'open',
      applications: [],
      createdAt: now,
    };
    this.persistLedger(
      {
        ...current.ledger,
        comments: [...current.ledger.comments, comment],
      },
      current.contentHash,
    );

    return comment;
  }

  // ── Get Comments ──────────────────────────────────────────────────────────

  getComments(filter?: CommentFilter): ReviewComment[] {
    const { ledger } = this.readLedger();
    let result = [...ledger.comments];
    if (filter?.status) {
      result = result.filter((c) => c.status === filter.status);
    }
    if (filter?.severity) {
      result = result.filter((c) => c.severity === filter.severity);
    }
    if (filter?.targetType) {
      result = result.filter((c) => c.target.type === filter.targetType);
    }
    if (filter?.targetId) {
      result = result.filter((c) => c.target.id === filter.targetId);
    }
    // Sort by createdAt then id
    result.sort((a, b) => {
      const dateCmp = a.createdAt.localeCompare(b.createdAt);
      if (dateCmp !== 0) return dateCmp;
      return a.id.localeCompare(b.id);
    });
    return result;
  }

  // ── Applicable Open Comments ──────────────────────────────────────────────

  // ── Applicable Open Comments (including line-level) ────────────
  
  getApplicableOpenComments(
    eventId: string,
    chapterNum: number,
  ): ReviewComment[] {
    const { ledger } = this.readLedger();
    const chapterId = `chapter:${chapterNum}`;
  
    // Filter to open comments that match by scope
    const applicable = ledger.comments.filter((c) => {
      if (c.status !== 'open') return false;
      const t = c.target;
      if (t.type === 'novel') return true;
      if (t.type === 'chapter') return t.id === chapterId;
      if (t.type === 'scene') return t.id === eventId;
      if (t.type === 'line') return t.id === eventId;
      return false;
    });
  
    // Stable order: scope, then creation time, then immutable ID
    const order: Record<string, number> = { novel: 0, chapter: 1, scene: 2, line: 3 };
    applicable.sort((left, right) => {
      const scopeOrder = (order[left.target.type] ?? 99) - (order[right.target.type] ?? 99);
      if (scopeOrder !== 0) return scopeOrder;
      const createdOrder = left.createdAt.localeCompare(right.createdAt);
      return createdOrder !== 0 ? createdOrder : left.id.localeCompare(right.id);
    });
  
    return applicable;
  }

  // ── Replace (Supersede) ───────────────────────────────────────────────────

  replaceReviewComment(
    id: string,
    input: NewReviewComment,
    actorId: string,
    opts?: { expectedLedgerHash?: string },
    sceneLineCount?: number,
  ): ReviewComment {
    const trimmedActor = actorId.trim();
    const current = this.readLedger();

    // CAS check
    if (
      opts?.expectedLedgerHash !== undefined &&
      current.contentHash !== opts.expectedLedgerHash
    ) {
      throw new StorageConflictError(
        'Expected ledger hash does not match current content',
        { path: this.ledgerPath },
      );
    }

    const originalIndex = current.ledger.comments.findIndex(
      (c) => c.id === id,
    );
    if (originalIndex === -1) {
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Comment ${id} not found`,
      );
    }

    const original = current.ledger.comments[originalIndex];
    if (original.status === 'superseded') {
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Comment ${id} is already superseded`,
      );
    }

    // Validate line bounds on replacement input
    if (
      input.target.type === 'line' &&
      sceneLineCount !== undefined &&
      input.target.lineRange
    ) {
      if (input.target.lineRange[1] > sceneLineCount) {
        throw new EditorialOperationError(
          'INVALID_OPERATION',
          `Line range end ${input.target.lineRange[1]} exceeds scene line count ${sceneLineCount}`,
        );
      }
    }

    const now = new Date().toISOString();
    const superseded: ReviewComment = {
      ...original,
      status: 'superseded',
      resolvedAt: now,
      resolvedBy: trimmedActor,
    };
    const replacement: ReviewComment = {
      id: `rev_${crypto.randomUUID()}`,
      author: 'human',
      actorId: trimmedActor,
      target: input.target,
      severity: input.severity,
      category: input.category,
      content: input.content,
      status: 'open',
      applications: [],
      supersedesId: id,
      createdAt: now,
    };

    const updatedComments = [...current.ledger.comments];
    updatedComments[originalIndex] = superseded;
    updatedComments.push(replacement);
    this.persistLedger(
      {
        ...current.ledger,
        comments: updatedComments,
      },
      current.contentHash,
    );

    return replacement;
  }

  // ── Update Lifecycle ──────────────────────────────────────────────────────

  updateReviewComment(
    id: string,
    action: 'resolve' | 'wontfix' | 'reopen' | 'escalate',
    actorId: string,
  ): ReviewComment {
    const current = this.readLedger();
    const index = current.ledger.comments.findIndex((c) => c.id === id);
    if (index === -1) {
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Comment ${id} not found`,
      );
    }

    const comment = current.ledger.comments[index];
    if (comment.status === 'superseded') {
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Comment ${id} is superseded`,
      );
    }

    let updated: ReviewComment;
    const now = new Date().toISOString();

    switch (action) {
      case 'resolve':
        updated = {
          ...comment,
          status: 'resolved',
          resolvedAt: now,
          resolvedBy: actorId,
        };
        break;
      case 'wontfix':
        updated = {
          ...comment,
          status: 'wontfix',
          resolvedAt: now,
          resolvedBy: actorId,
        };
        break;
      case 'reopen':
        updated = {
          ...comment,
          status: 'open',
          resolvedAt: undefined,
          resolvedBy: undefined,
        };
        break;
      case 'escalate':
        updated = {
          ...comment,
          severity: 'blocking',
          status: 'open',
          resolvedAt: undefined,
          resolvedBy: undefined,
        };
        break;
    }

    const updatedComments = [...current.ledger.comments];
    updatedComments[index] = updated;

    this.persistLedger(
      {
        ...current.ledger,
        comments: updatedComments,
      },
      current.contentHash,
    );

    return updated;
  }

  // ── Apply Comments ───────────────────────────────────────────────────────

  applyComments(
    ids: string[],
    application: ReviewApplicationV1,
    addressed: Set<string>,
  ): ReviewComment[] {
    const current = this.readLedger();

    // Validate all IDs exist
    for (const id of ids) {
      if (!current.ledger.comments.some((c) => c.id === id)) {
        throw new EditorialOperationError(
          'INVALID_OPERATION',
          `Comment ${id} not found`,
        );
      }
    }

    const updatedComments = current.ledger.comments.map((c) => {
      if (!ids.includes(c.id)) return c;
      const withApp: ReviewComment = {
        ...c,
        applications: [...c.applications, application],
        status: addressed.has(c.id) ? 'addressed' : c.status,
      };
      return withApp;
    });

    this.persistLedger(
      {
        ...current.ledger,
        comments: updatedComments,
      },
      current.contentHash,
    );

    return updatedComments.filter((c) => ids.includes(c.id));
  }

  // ── Patches ───────────────────────────────────────────────────────────────

  getPatches(): ReviewPatch[] {
    return this.readLedger().ledger.patches;
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  getSummary(): StatusSummary {
    return getSummary(this.readLedger().ledger.comments, 0);
  }

  private persistLedger(ledger: ReviewLedgerV1, expectedHash: string | null): void {
    const content = JSON.stringify(ledger, null, 2);
    this.coordinator.commit({
      writes: [
        {
          type: 'put',
          path: this.ledgerPath,
          content,
          expectedHash,
        },
      ],
    });
  }

  // ── Legacy Normalization ──────────────────────────────────────────────────

  private normalizeLegacy(raw: Record<string, unknown>): ReviewLedgerV1 {
    const rawComments = Array.isArray(raw.comments) ? raw.comments : [];
    const rawPatches = Array.isArray(raw.patches) ? raw.patches : [];

    const comments: ReviewComment[] = rawComments.map(
      (c: unknown) => {
        const entry = c as Record<string, unknown>;
        return {
          id: String(entry.id ?? ''),
          author: (entry.author === 'llm' ? 'llm' : 'human') as 'human' | 'llm',
          actorId: entry.actorId ? String(entry.actorId) : 'legacy',
          target: (entry.target ?? {
            type: 'scene',
            id: '',
          }) as ReviewComment['target'],
          severity: (entry.severity ?? 'nit') as ReviewComment['severity'],
          category: (entry.category ?? 'style') as ReviewComment['category'],
          content: String(entry.content ?? ''),
          status: (entry.status ?? 'open') as ReviewComment['status'],
          applications: Array.isArray(entry.applications)
            ? (entry.applications as ReviewApplicationV1[])
            : [],
          ...(entry.supersedesId
            ? { supersedesId: String(entry.supersedesId) }
            : {}),
          ...(entry.resolvedBy
            ? { resolvedBy: String(entry.resolvedBy) }
            : {}),
          createdAt: String(entry.createdAt ?? new Date().toISOString()),
          ...(entry.resolvedAt
            ? { resolvedAt: String(entry.resolvedAt) }
            : {}),
        };
      },
    );

    const patches: ReviewPatch[] = rawPatches.map(
      (p: unknown) => {
        const entry = p as Record<string, unknown>;
        return {
          sourceReviewIds: Array.isArray(entry.sourceReviewIds)
            ? entry.sourceReviewIds.map(String)
            : [],
          description: String(entry.description ?? ''),
          changes: Array.isArray(entry.changes)
            ? entry.changes.map((ch: unknown) => {
                const ce = ch as Record<string, unknown>;
                return {
                  type: ce.type as ReviewPatch['changes'][number]['type'],
                  target: String(ce.target ?? ''),
                  oldValue: ce.oldValue,
                  newValue: ce.newValue,
                  rationale: String(ce.rationale ?? ''),
                };
              })
            : [],
        };
      },
    );

    return { version: 1, comments, patches };
  }
}

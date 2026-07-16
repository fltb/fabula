// ============================================================================
// Review System — ReviewComment lifecycle management
// ============================================================================

import type {
  ReviewComment,
  ReviewPatch,
  PatchChange,
  EntityId,
} from '../types/index.js';

export class ReviewManager {
  private comments: ReviewComment[] = [];
  private patches: ReviewPatch[] = [];
  private blockingChaptersBeforeDowngrade: number;

  constructor(blockingChaptersBeforeDowngrade = 3) {
    this.blockingChaptersBeforeDowngrade = blockingChaptersBeforeDowngrade;
  }

  /** Add a review comment */
  addComment(comment: ReviewComment): void {
    this.comments.push(comment);
  }

  /** Get all comments */
  getComments(filter?: {
    status?: ReviewComment['status'];
    severity?: ReviewComment['severity'];
    targetType?: string;
    targetId?: string;
  }): ReviewComment[] {
    let result = [...this.comments];
    if (filter?.status) result = result.filter((c) => c.status === filter.status);
    if (filter?.severity) result = result.filter((c) => c.severity === filter.severity);
    if (filter?.targetType) result = result.filter((c) => c.target.type === filter.targetType);
    if (filter?.targetId) result = result.filter((c) => c.target.id === filter.targetId);
    return result;
  }

  /** Get blocking comments within recent chapters */
  getActiveBlocking(currentChapter: number): ReviewComment[] {
    return this.comments.filter(
      (c) => c.severity === 'blocking' && c.status === 'open',
    );
  }

  /** Resolve a comment */
  resolve(commentId: string, patchId?: string): void {
    const comment = this.comments.find((c) => c.id === commentId);
    if (comment) {
      comment.status = 'resolved';
      comment.resolvedAt = new Date().toISOString();
      if (patchId) comment.resolvedBy = patchId;
    }
  }

  /** Mark comment as addressed (waiting for verification) */
  address(commentId: string): void {
    const comment = this.comments.find((c) => c.id === commentId);
    if (comment) {
      comment.status = 'addressed';
    }
  }

  /** Create a patch from resolved comments */
  createPatch(sourceReviewIds: string[], changes: PatchChange[]): ReviewPatch {
    const patch: ReviewPatch = { sourceReviewIds, changes };
    this.patches.push(patch);
    return patch;
  }

  /** Get summary for status report */
  getSummary(currentChapter: number): {
    total: number;
    open: number;
    blocking: number;
    addressed: number;
    resolved: number;
  } {
    const byStatus = {
      total: this.comments.length,
      open: 0,
      blocking: 0,
      addressed: 0,
      resolved: 0,
      wontfix: 0,
    };
    for (const c of this.comments) {
      byStatus[c.status]++;
      if (c.severity === 'blocking' && c.status === 'open') byStatus.blocking++;
    }
    return byStatus;
  }
}

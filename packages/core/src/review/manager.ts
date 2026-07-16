// ============================================================================
// Review System — ReviewComment lifecycle management
// ============================================================================

import type {
  ReviewComment,
  ReviewPatch,
  PatchChange,
} from '../types/index.js';
import type { CommentFilter, StatusSummary } from './types.js';
import {
  addComment,
  getComments,
  getActiveBlocking,
  resolve,
  address,
} from './comment.js';
import { createPatch } from './patch.js';
import { getSummary } from './summary.js';

export class ReviewManager {
  private comments: ReviewComment[] = [];
  private patches: ReviewPatch[] = [];
  private blockingChaptersBeforeDowngrade: number;

  constructor(blockingChaptersBeforeDowngrade = 3) {
    this.blockingChaptersBeforeDowngrade = blockingChaptersBeforeDowngrade;
  }

  /** Add a review comment */
  addComment(comment: ReviewComment): void {
    addComment(this.comments, comment);
  }

  /** Get all comments with optional filtering */
  getComments(filter?: CommentFilter): ReviewComment[] {
    return getComments(this.comments, filter);
  }

  /** Get blocking comments within recent chapters */
  getActiveBlocking(currentChapter: number): ReviewComment[] {
    return getActiveBlocking(this.comments, currentChapter);
  }

  /** Resolve a comment */
  resolve(commentId: string, patchId?: string): void {
    resolve(this.comments, commentId, patchId);
  }

  /** Mark comment as addressed (waiting for verification) */
  address(commentId: string): void {
    address(this.comments, commentId);
  }

  /** Create a patch from resolved comments */
  createPatch(sourceReviewIds: string[], changes: PatchChange[]): ReviewPatch {
    return createPatch(this.patches, sourceReviewIds, changes);
  }

  /** Get summary for status report */
  getSummary(currentChapter: number): StatusSummary {
    return getSummary(this.comments, currentChapter);
  }
}

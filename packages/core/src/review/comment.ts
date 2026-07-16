// ============================================================================
// Review System — Comment lifecycle operations (pure functions)
// ============================================================================

import type { ReviewComment } from '../types/index.js';
import type { CommentFilter } from './types.js';

/** Add a review comment */
export function addComment(comments: ReviewComment[], comment: ReviewComment): void {
  comments.push(comment);
}

/** Get comments with optional filtering */
export function getComments(
  comments: ReviewComment[],
  filter?: CommentFilter,
): ReviewComment[] {
  let result = [...comments];
  if (filter?.status) result = result.filter((c) => c.status === filter.status);
  if (filter?.severity) result = result.filter((c) => c.severity === filter.severity);
  if (filter?.targetType) result = result.filter((c) => c.target.type === filter.targetType);
  if (filter?.targetId) result = result.filter((c) => c.target.id === filter.targetId);
  return result;
}

/** Get blocking comments within recent chapters */
export function getActiveBlocking(
  comments: ReviewComment[],
  _currentChapter: number,
): ReviewComment[] {
  return comments.filter(
    (c) => c.severity === 'blocking' && c.status === 'open',
  );
}

/** Resolve a comment */
export function resolve(
  comments: ReviewComment[],
  commentId: string,
  patchId?: string,
): void {
  const comment = comments.find((c) => c.id === commentId);
  if (comment) {
    comment.status = 'resolved';
    comment.resolvedAt = new Date().toISOString();
    if (patchId) comment.resolvedBy = patchId;
  }
}

/** Mark comment as addressed (waiting for verification) */
export function address(comments: ReviewComment[], commentId: string): void {
  const comment = comments.find((c) => c.id === commentId);
  if (comment) {
    comment.status = 'addressed';
  }
}

// ============================================================================
// Review System — ReviewComment lifecycle management
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';

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
  reopen,
  escalate,
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

  /** Persist comments to a JSON file */
  save(projectDir: string): void {
    const reviewsDir = path.join(projectDir, 'reviews');
    if (!fs.existsSync(reviewsDir)) {
      fs.mkdirSync(reviewsDir, { recursive: true });
    }
    const filePath = path.join(reviewsDir, 'pending.json');
    const data = {
      comments: this.comments,
      patches: this.patches,
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /** Load comments from a JSON file, merging with any existing in-memory state */
  load(projectDir: string): void {
    const filePath = path.join(projectDir, 'reviews', 'pending.json');
    if (!fs.existsSync(filePath)) return;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.comments)) {
        // Avoid duplicates by ID
        const existingIds = new Set(this.comments.map((c) => c.id));
        for (const c of data.comments) {
          if (!existingIds.has(c.id)) {
            this.comments.push(c);
            existingIds.add(c.id);
          }
        }
      }
    } catch {
      // Ignore malformed file
    }
  }

  /** Reopen a resolved/addressed/wontfix comment */
  reopen(commentId: string): void {
    reopen(this.comments, commentId);
  }

  /** Escalate a comment's severity to 'blocking' */
  escalate(commentId: string): void {
    escalate(this.comments, commentId);
  }
}

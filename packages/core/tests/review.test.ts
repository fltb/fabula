// ============================================================================
// ReviewManager — Unit Tests
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { ReviewManager } from '../src/review/index.js';
import type { ReviewComment, ReviewPatch } from '../src/types/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeComment(overrides: Partial<ReviewComment> & { id: string }): ReviewComment {
  return {
    author: 'human',
    target: { type: 'scene', id: 'scene_001' },
    severity: 'nit',
    category: 'style',
    content: 'Test comment',
    status: 'open',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ReviewManager', () => {
  let manager: ReviewManager;

  beforeEach(() => {
    manager = new ReviewManager();
  });

  // 1. Construction
  describe('construction', () => {
    it('should create an empty ReviewManager with default blocking threshold', () => {
      expect(manager).toBeInstanceOf(ReviewManager);
      // No public getter for blockingChaptersBeforeDowngrade,
      // but we can verify by exercising the class
    });

    it('should create a ReviewManager', () => {
      const custom = new ReviewManager();
      expect(custom).toBeInstanceOf(ReviewManager);
    });
  });

  // 2. addComment
  describe('addComment', () => {
    it('should append a comment to the list', () => {
      const comment = makeComment({ id: 'c1' });
      manager.addComment(comment);

      const all = manager.getComments();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe('c1');
    });

    it('should append multiple comments', () => {
      manager.addComment(makeComment({ id: 'c1' }));
      manager.addComment(makeComment({ id: 'c2' }));
      manager.addComment(makeComment({ id: 'c3' }));

      expect(manager.getComments()).toHaveLength(3);
    });
  });

  // 3. getComments
  describe('getComments', () => {
    beforeEach(() => {
      manager.addComment(
        makeComment({ id: 'c1', status: 'open', severity: 'blocking', target: { type: 'scene', id: 's1' } }),
      );
      manager.addComment(
        makeComment({ id: 'c2', status: 'resolved', severity: 'nit', target: { type: 'chapter', id: 'ch2' } }),
      );
      manager.addComment(
        makeComment({ id: 'c3', status: 'open', severity: 'suggestion', target: { type: 'scene', id: 's1' } }),
      );
      manager.addComment(
        makeComment({ id: 'c4', status: 'addressed', severity: 'blocking', target: { type: 'character', id: 'char3' } }),
      );
    });

    it('should return all comments with no filter', () => {
      const all = manager.getComments();
      expect(all).toHaveLength(4);
    });

    it('should filter by status', () => {
      const open = manager.getComments({ status: 'open' });
      expect(open).toHaveLength(2);
      expect(open.every((c) => c.status === 'open')).toBe(true);
    });

    it('should filter by severity', () => {
      const blocking = manager.getComments({ severity: 'blocking' });
      expect(blocking).toHaveLength(2);
      expect(blocking.every((c) => c.severity === 'blocking')).toBe(true);
    });

    it('should filter by targetType', () => {
      const scenes = manager.getComments({ targetType: 'scene' });
      expect(scenes).toHaveLength(2);
      expect(scenes.every((c) => c.target.type === 'scene')).toBe(true);
    });

    it('should filter by targetId', () => {
      const s1 = manager.getComments({ targetId: 's1' });
      expect(s1).toHaveLength(2);
      expect(s1.every((c) => c.target.id === 's1')).toBe(true);
    });
  });

  // 4. getActiveBlocking
  describe('getActiveBlocking', () => {
    it('should return only open + blocking comments', () => {
      manager.addComment(
        makeComment({ id: 'c1', severity: 'blocking', status: 'open' }),
      );
      manager.addComment(
        makeComment({ id: 'c2', severity: 'nit', status: 'open' }),
      );
      manager.addComment(
        makeComment({ id: 'c3', severity: 'blocking', status: 'resolved' }),
      );
      manager.addComment(
        makeComment({ id: 'c4', severity: 'blocking', status: 'addressed' }),
      );

      const active = manager.getActiveBlocking(1);
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe('c1');
    });

    it('should return empty array when no active blocking comments exist', () => {
      manager.addComment(
        makeComment({ id: 'c1', severity: 'nit', status: 'open' }),
      );

      const active = manager.getActiveBlocking(1);
      expect(active).toHaveLength(0);
    });
  });

  // 5. resolve
  describe('resolve', () => {
    it('should mark a comment as resolved and set resolvedAt', () => {
      manager.addComment(makeComment({ id: 'c1', status: 'open' }));
      manager.resolve('c1');

      const comments = manager.getComments({ status: 'resolved' });
      expect(comments).toHaveLength(1);
      expect(comments[0].id).toBe('c1');
      expect(comments[0].status).toBe('resolved');
      expect(comments[0].resolvedAt).toBeDefined();
      expect(typeof comments[0].resolvedAt).toBe('string');
    });

    it('should set resolvedBy when patchId is provided', () => {
      manager.addComment(makeComment({ id: 'c1', status: 'open' }));
      manager.resolve('c1', 'patch_abc');

      const comments = manager.getComments({ status: 'resolved' });
      expect(comments[0].resolvedBy).toBe('patch_abc');
    });

    it('should not throw if comment does not exist', () => {
      expect(() => manager.resolve('nonexistent')).not.toThrow();
    });
  });

  // 6. address
  describe('address', () => {
    it('should mark a comment as addressed', () => {
      manager.addComment(makeComment({ id: 'c1', status: 'open' }));
      manager.address('c1');

      const comments = manager.getComments({ status: 'addressed' });
      expect(comments).toHaveLength(1);
      expect(comments[0].status).toBe('addressed');
    });

    it('should not throw if comment does not exist', () => {
      expect(() => manager.address('nonexistent')).not.toThrow();
    });
  });

  // 7. createPatch
  describe('createPatch', () => {
    it('should store a patch and return it', () => {
      const patch = manager.createPatch(['c1', 'c2'], [
        { type: 'rewrite', target: 'scene_001', newValue: 'Updated text', rationale: 'Fix grammar' },
      ]);

      expect(patch).toBeDefined();
      expect(patch.sourceReviewIds).toEqual(['c1', 'c2']);
      expect(patch.changes).toHaveLength(1);
      expect(patch.changes[0].type).toBe('rewrite');
    });

    it('should allow creating multiple patches', () => {
      manager.createPatch(['c1'], []);
      manager.createPatch(['c2'], []);
      // No public getPatches on ReviewManager, but we can verify via
      // createPatch returning unique patches.
    });
  });

  // 8. getSummary
  describe('getSummary', () => {
    it('should return correct counts by status and blocking counter', () => {
      manager.addComment(makeComment({ id: 'c1', status: 'open', severity: 'blocking' }));
      manager.addComment(makeComment({ id: 'c2', status: 'open', severity: 'nit' }));
      manager.addComment(makeComment({ id: 'c3', status: 'resolved', severity: 'suggestion' }));
      manager.addComment(makeComment({ id: 'c4', status: 'addressed', severity: 'blocking' }));
      manager.addComment(makeComment({ id: 'c5', status: 'wontfix', severity: 'nit' }));

      const summary = manager.getSummary(1);

      expect(summary.total).toBe(5);
      expect(summary.open).toBe(2);
      expect(summary.resolved).toBe(1);
      expect(summary.addressed).toBe(1);
      expect(summary.wontfix).toBe(1);
      // blocking = comments that are both open AND blocking severity
      expect(summary.blocking).toBe(1);
    });

    it('should return zeros for empty manager', () => {
      const summary = manager.getSummary(1);
      expect(summary).toEqual({
        total: 0,
        open: 0,
        blocking: 0,
        addressed: 0,
        resolved: 0,
        wontfix: 0,
      });
    });
  });
});

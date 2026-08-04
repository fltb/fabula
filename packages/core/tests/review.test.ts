// ============================================================================
// ReviewManager — V1 semantic repository-backed behavior tests
//
// Tests the async ReviewManager over MemoryExecutionRepository review records
// with an explicit project ID.  No storage, coordinator, or ledger-path
// assumptions appear: persistence is the semantic CoreExecutionRepository
// review record, and conflicts are optimistic compare-and-swap outcomes.
// ============================================================================

import * as crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { EditorialOperationError } from '../src/editorial/errors.ts';
import {
  addReviewComment,
  listReviewComments,
  replaceReviewComment,
  updateReviewComment,
} from '../src/editorial/review-facade.ts';
import type { Clock, IdGenerator } from '../src/ports/runtime-services.ts';
import { markWontfix, resolve } from '../src/review/comment.ts';
import { ReviewManager } from '../src/review/index.ts';
import { reviewLedgerV1Schema } from '../src/schemas/review.ts';
import { MemoryExecutionRepository } from '../src/testing/memory-repositories.ts';
import type { EditorialRuntime } from '../src/types/editorial.ts';
import type {
  NewReviewComment,
  ReviewApplicationV1,
  ReviewComment,
  ReviewLedgerV1,
} from '../src/types/index.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PROJECT_ID = 'test-project';
const LEDGER_REVIEW_ID = 'ledger';

function newComment(overrides?: Partial<NewReviewComment>): NewReviewComment {
  return {
    target: { type: 'scene', id: 'E1' },
    severity: 'nit',
    category: 'style',
    content: 'Test comment',
    ...overrides,
  };
}

function makeApplication(eventId: string): ReviewApplicationV1 {
  return {
    eventId,
    revisionId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    appliedAt: '2025-01-01T00:00:00.000Z',
  };
}

function reviewComment(id: string, overrides?: Partial<ReviewComment>): ReviewComment {
  return {
    id,
    author: 'human',
    actorId: 'reviewer',
    target: { type: 'scene', id: 'E1' },
    severity: 'suggestion',
    category: 'style',
    content: 'Tighten',
    status: 'open',
    applications: [],
    createdAt: '2026-08-02T00:00:00.000Z',
    ...overrides,
  };
}

/** Scripted Clock/IdGenerator pair for deterministic ledger mutations. */
function fixedServices(now: string, ids: readonly string[]): { clock: Clock; ids: IdGenerator } {
  let index = 0;
  return {
    clock: { now: () => now },
    ids: {
      next: () => {
        const id = ids[index];
        index += 1;
        if (id === undefined) throw new Error(`Fixed ID generator exhausted after ${index} calls`);
        return id;
      },
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ReviewManager', () => {
  let execution: MemoryExecutionRepository;
  let manager: ReviewManager;

  beforeEach(() => {
    execution = new MemoryExecutionRepository();
    manager = new ReviewManager(execution, PROJECT_ID);
  });

  // 1. Construction ──────────────────────────────────────────────────────────

  describe('construction', () => {
    it('creates a manager with an execution repository and project ID', () => {
      expect(manager).toBeInstanceOf(ReviewManager);
    });

    it('isolates review ledgers per project on the same repository', async () => {
      const other = new ReviewManager(execution, 'other-project');
      await manager.addReviewComment(newComment(), 'actor-1');

      expect(await manager.getComments()).toHaveLength(1);
      expect(await other.getComments()).toHaveLength(0);
      expect((await other.readLedger()).contentHash).toBeNull();
    });

    it('readLedger returns an empty ledger when no record exists', async () => {
      const snapshot = await manager.readLedger();
      expect(snapshot.ledger.version).toBe(1);
      expect(snapshot.ledger.comments).toEqual([]);
      expect(snapshot.ledger.patches).toEqual([]);
      expect(snapshot.contentHash).toBeNull();
      expect(snapshot.legacy).toBe(false);
      expect(snapshot.version).toBeNull();
    });

    it('getSummary returns zeros for an empty ledger', async () => {
      const summary = await manager.getSummary();
      expect(summary).toEqual({
        total: 0,
        open: 0,
        blocking: 0,
        addressed: 0,
        resolved: 0,
        wontfix: 0,
        superseded: 0,
      });
    });
  });

  // 2. addReviewComment ──────────────────────────────────────────────────────

  describe('addReviewComment', () => {
    it('adds a comment with a generated ID and returns the structured comment', async () => {
      const comment = await manager.addReviewComment(newComment(), 'actor-1');

      expect(comment.id).toMatch(/^rev_/);
      expect(comment.actorId).toBe('actor-1');
      expect(comment.applications).toEqual([]);
      expect(comment.status).toBe('open');
      expect(comment.createdAt).toBeTruthy();
      expect(() => new Date(comment.createdAt)).not.toThrow();

      // Verify it is readable back
      const comments = await manager.getComments();
      expect(comments).toHaveLength(1);
      expect(comments[0].id).toBe(comment.id);
    });

    it('persists the comment as a review record in the execution repository', async () => {
      const comment = await manager.addReviewComment(newComment(), 'actor-1');

      const record = await execution.readReview({
        projectId: PROJECT_ID,
        reviewId: LEDGER_REVIEW_ID,
      });
      expect(record).not.toBeNull();
      if (!record) throw new Error('Expected persisted review record fixture');
      const parsed = reviewLedgerV1Schema.parse(record.value.value);
      expect(parsed.version).toBe(1);
      expect(parsed.comments).toHaveLength(1);
      expect(parsed.comments[0].id).toBe(comment.id);
    });

    it('trims whitespace from actorId', async () => {
      const comment = await manager.addReviewComment(newComment(), '  actor-2  ');
      expect(comment.actorId).toBe('actor-2');
    });

    it('each comment gets a unique ID', async () => {
      const c1 = await manager.addReviewComment(newComment(), 'a');
      const c2 = await manager.addReviewComment(newComment(), 'a');
      expect(c1.id).not.toBe(c2.id);
    });

    it('applications is empty for a fresh comment', async () => {
      const comment = await manager.addReviewComment(newComment(), 'a');
      expect(comment.applications).toEqual([]);
    });

    describe('line bounds', () => {
      it('accepts a line range within the scene line count', async () => {
        const input: NewReviewComment = {
          target: {
            type: 'line',
            id: 'E1',
            lineRange: [1, 10],
            lineBasis: {
              revisionId: crypto.randomUUID(),
              proseHash: 'a'.repeat(64),
            },
          },
          severity: 'nit',
          category: 'style',
          content: 'Line comment',
        };
        const comment = await manager.addReviewComment(input, 'a', {}, 100);
        expect(comment.target.type).toBe('line');
      });

      it('rejects a line range ending beyond the scene line count', async () => {
        const input: NewReviewComment = {
          target: {
            type: 'line',
            id: 'E1',
            lineRange: [1, 200],
            lineBasis: {
              revisionId: crypto.randomUUID(),
              proseHash: 'a'.repeat(64),
            },
          },
          severity: 'nit',
          category: 'style',
          content: 'Line comment',
        };
        await expect(manager.addReviewComment(input, 'a', {}, 100)).rejects.toThrow(
          EditorialOperationError,
        );
      });
    });
  });

  // 3. getComments — filters ─────────────────────────────────────────────────

  describe('getComments filters', () => {
    beforeEach(async () => {
      await manager.addReviewComment(
        {
          target: { type: 'scene', id: 'E1' },
          severity: 'blocking',
          category: 'style',
          content: 'c1',
        },
        'actor',
      );
      await manager.addReviewComment(
        {
          target: { type: 'scene', id: 'E2' },
          severity: 'suggestion',
          category: 'pacing',
          content: 'c2',
        },
        'actor',
      );
      await manager.addReviewComment(
        { target: { type: 'scene', id: 'E1' }, severity: 'nit', category: 'style', content: 'c3' },
        'actor',
      );
      // Resolve c2 so we have a mix of statuses
      const all = await manager.getComments();
      const c2 = all.find((c) => c.content === 'c2');
      expect(c2).toBeDefined();
      if (!c2) throw new Error('Expected c2 review comment fixture');
      await manager.updateReviewComment(c2.id, 'resolve', 'actor');
    });

    it('returns all comments with no filter', async () => {
      expect(await manager.getComments()).toHaveLength(3);
    });

    it('filters by status', async () => {
      const open = await manager.getComments({ status: 'open' });
      expect(open).toHaveLength(2);
      expect(open.every((c) => c.status === 'open')).toBe(true);
    });

    it('filters by severity', async () => {
      const blocking = await manager.getComments({ severity: 'blocking' });
      expect(blocking).toHaveLength(1);
      expect(blocking[0].severity).toBe('blocking');
    });

    it('filters by targetType', async () => {
      const scenes = await manager.getComments({ targetType: 'scene' });
      expect(scenes).toHaveLength(3);
    });

    it('filters by targetId', async () => {
      const e1 = await manager.getComments({ targetId: 'E1' });
      expect(e1).toHaveLength(2);
      expect(e1.every((c) => c.target.id === 'E1')).toBe(true);
    });

    it('returns comments sorted by createdAt then id', async () => {
      const all = await manager.getComments();
      for (let i = 1; i < all.length; i++) {
        const prev = all[i - 1].createdAt;
        const curr = all[i].createdAt;
        expect(prev <= curr).toBe(true);
      }
    });
  });

  // 4. getApplicableOpenComments — applicability order ───────────────────────

  describe('getApplicableOpenComments', () => {
    beforeEach(async () => {
      await manager.addReviewComment(
        {
          target: { type: 'novel', id: 'novel' },
          severity: 'nit',
          category: 'style',
          content: 'novel-global',
        },
        'a',
      );
      await manager.addReviewComment(
        {
          target: { type: 'chapter', id: 'chapter:2' },
          severity: 'nit',
          category: 'style',
          content: 'chapter-2',
        },
        'a',
      );
      await manager.addReviewComment(
        {
          target: { type: 'chapter', id: 'chapter:5' },
          severity: 'nit',
          category: 'style',
          content: 'chapter-5',
        },
        'a',
      );
      await manager.addReviewComment(
        {
          target: { type: 'scene', id: 'E1' },
          severity: 'nit',
          category: 'style',
          content: 'scene-E1',
        },
        'a',
      );
      await manager.addReviewComment(
        {
          target: { type: 'scene', id: 'E2' },
          severity: 'nit',
          category: 'style',
          content: 'scene-E2',
        },
        'a',
      );
    });

    it('returns only open comments applicable to the given event and chapter', async () => {
      const applicable = await manager.getApplicableOpenComments('E1', 2);
      const contents = applicable.map((c) => c.content);
      expect(contents).toContain('novel-global');
      expect(contents).toContain('chapter-2');
      expect(contents).toContain('scene-E1');
      expect(contents).not.toContain('chapter-5');
      expect(contents).not.toContain('scene-E2');
    });

    it('excludes comments for a non-matching chapter', async () => {
      const applicable = await manager.getApplicableOpenComments('E1', 3);
      const contents = applicable.map((c) => c.content);
      expect(contents).toContain('novel-global');
      expect(contents).not.toContain('chapter-2');
      expect(contents).not.toContain('chapter-5');
      expect(contents).toContain('scene-E1');
    });

    it('returns comments in stable order: novel, chapter, scene', async () => {
      const applicable = await manager.getApplicableOpenComments('E1', 2);
      const types = applicable.map((c) => c.target.type);
      const filtered = types.filter((t) => ['novel', 'chapter', 'scene'].includes(t));
      expect(filtered).toEqual(['novel', 'chapter', 'scene']);
    });

    it('does not return resolved, wontfix, addressed, or superseded comments', async () => {
      const all = await manager.getComments();
      const scene = all.find((c) => c.content === 'scene-E1');
      expect(scene).toBeDefined();
      if (!scene) throw new Error('Expected scene review comment fixture');
      await manager.updateReviewComment(scene.id, 'resolve', 'a');

      const applicable = await manager.getApplicableOpenComments('E1', 2);
      expect(applicable.find((c) => c.id === scene.id)).toBeUndefined();
    });

    it('ignores a novel comment when it is resolved', async () => {
      const all = await manager.getComments();
      const novel = all.find((c) => c.content === 'novel-global');
      expect(novel).toBeDefined();
      if (!novel) throw new Error('Expected novel review comment fixture');
      await manager.updateReviewComment(novel.id, 'resolve', 'a');

      const applicable = await manager.getApplicableOpenComments('E1', 2);
      expect(applicable.find((c) => c.id === novel.id)).toBeUndefined();
    });
  });

  // 5. replaceReviewComment — superseded chain ──────────────────────────────

  describe('replaceReviewComment', () => {
    it('creates a replacement with supersedesId and marks the original as superseded', async () => {
      const original = await manager.addReviewComment(
        {
          target: { type: 'scene', id: 'E1' },
          severity: 'blocking',
          category: 'plot_logic',
          content: 'original',
        },
        'a',
      );

      const replacement = await manager.replaceReviewComment(
        original.id,
        {
          target: { type: 'scene', id: 'E1' },
          severity: 'suggestion',
          category: 'style',
          content: 'replacement',
        },
        'b',
      );

      expect(replacement.supersedesId).toBe(original.id);

      const superseded = await manager.getComments({ status: 'superseded' });
      expect(superseded).toHaveLength(1);
      expect(superseded[0].id).toBe(original.id);
    });

    it('does not mutate the original comment content or target', async () => {
      const original = await manager.addReviewComment(
        {
          target: { type: 'scene', id: 'E1' },
          severity: 'blocking',
          category: 'plot_logic',
          content: 'original text',
        },
        'a',
      );

      await manager.replaceReviewComment(
        original.id,
        {
          target: { type: 'scene', id: 'E2' },
          severity: 'suggestion',
          category: 'style',
          content: 'new text',
        },
        'b',
      );

      const superseded = await manager.getComments({ status: 'superseded' });
      expect(superseded[0].content).toBe('original text');
      expect(superseded[0].target).toEqual({ type: 'scene', id: 'E1' });
    });

    it('sets resolvedAt and resolvedBy on the superseded original', async () => {
      const original = await manager.addReviewComment(newComment(), 'a');
      await manager.replaceReviewComment(original.id, newComment(), 'b');

      const superseded = (await manager.getComments({ status: 'superseded' }))[0];
      expect(superseded.resolvedAt).toBeTruthy();
      expect(superseded.resolvedBy).toBe('b');
    });

    it('throws EditorialOperationError when the original is not found', async () => {
      await expect(manager.replaceReviewComment('nonexistent', newComment(), 'a')).rejects.toThrow(
        EditorialOperationError,
      );
    });

    it('throws EditorialOperationError when the original is already superseded', async () => {
      const c1 = await manager.addReviewComment(newComment(), 'a');
      await manager.replaceReviewComment(c1.id, newComment(), 'b');
      await expect(manager.replaceReviewComment(c1.id, newComment(), 'c')).rejects.toThrow(
        EditorialOperationError,
      );
    });

    describe('line bounds on replacement', () => {
      it('rejects a replacement with an out-of-bounds line range', async () => {
        const original = await manager.addReviewComment(newComment(), 'a');
        const badInput: NewReviewComment = {
          target: {
            type: 'line',
            id: 'E1',
            lineRange: [1, 999],
            lineBasis: {
              revisionId: crypto.randomUUID(),
              proseHash: 'b'.repeat(64),
            },
          },
          severity: 'nit',
          category: 'style',
          content: 'out of bounds',
        };
        await expect(
          manager.replaceReviewComment(original.id, badInput, 'a', {}, 50),
        ).rejects.toThrow(EditorialOperationError);
      });
    });
  });

  // 6. updateReviewComment — lifecycle actions ──────────────────────────────

  describe('updateReviewComment lifecycle', () => {
    let commentId: string;

    beforeEach(async () => {
      commentId = (await manager.addReviewComment(newComment(), 'a')).id;
    });

    it('resolve sets status resolved, resolvedAt, resolvedBy', async () => {
      const updated = await manager.updateReviewComment(commentId, 'resolve', 'reviewer-1');
      expect(updated.status).toBe('resolved');
      expect(updated.resolvedAt).toBeTruthy();
      expect(updated.resolvedBy).toBe('reviewer-1');

      // Persisted — read back
      const loaded = await manager.getComments({ status: 'resolved' });
      expect(loaded).toHaveLength(1);
      expect(loaded[0].resolvedBy).toBe('reviewer-1');
    });

    it('wontfix sets status wontfix, resolvedAt, resolvedBy', async () => {
      const updated = await manager.updateReviewComment(commentId, 'wontfix', 'reviewer-2');
      expect(updated.status).toBe('wontfix');
      expect(updated.resolvedAt).toBeTruthy();
      expect(updated.resolvedBy).toBe('reviewer-2');
    });

    it('reopen restores status open and clears resolved fields', async () => {
      await manager.updateReviewComment(commentId, 'resolve', 'reviewer-1');
      const reopened = await manager.updateReviewComment(commentId, 'reopen', 'reviewer-2');
      expect(reopened.status).toBe('open');
      expect(reopened.resolvedAt).toBeUndefined();
      expect(reopened.resolvedBy).toBeUndefined();
    });

    it('escalate sets severity to blocking and status to open', async () => {
      await manager.updateReviewComment(commentId, 'resolve', 'a');
      const escalated = await manager.updateReviewComment(commentId, 'escalate', 'reviewer-1');
      expect(escalated.severity).toBe('blocking');
      expect(escalated.status).toBe('open');
      expect(escalated.resolvedAt).toBeUndefined();
      expect(escalated.resolvedBy).toBeUndefined();
    });

    it('throws EditorialOperationError when the comment is not found', async () => {
      await expect(manager.updateReviewComment('nonexistent', 'resolve', 'a')).rejects.toThrow(
        EditorialOperationError,
      );
    });

    it('throws EditorialOperationError when the comment is superseded', async () => {
      await manager.replaceReviewComment(commentId, newComment(), 'b');
      await expect(manager.updateReviewComment(commentId, 'resolve', 'a')).rejects.toThrow(
        EditorialOperationError,
      );
    });
  });

  // 7. Semantic review record validation ────────────────────────────────────

  describe('semantic review record validation', () => {
    it('rejects a non-object review record from the repository', async () => {
      await execution.compareAndSwapReview({
        projectId: PROJECT_ID,
        reviewId: LEDGER_REVIEW_ID,
        expectedVersion: null,
        value: {
          version: 1,
          projectId: PROJECT_ID,
          reviewId: LEDGER_REVIEW_ID,
          value: 'just a string',
        },
      });
      await expect(manager.readLedger()).rejects.toThrow('Invalid review ledger structure');
    });

    it('rejects a structurally invalid v1 ledger record', async () => {
      await execution.compareAndSwapReview({
        projectId: PROJECT_ID,
        reviewId: LEDGER_REVIEW_ID,
        expectedVersion: null,
        value: {
          version: 1,
          projectId: PROJECT_ID,
          reviewId: LEDGER_REVIEW_ID,
          value: { version: 1, comments: 'not-an-array', patches: [] },
        },
      });
      await expect(manager.readLedger()).rejects.toThrow('Invalid review ledger structure');
    });

    it('rejects comments that fail the semantic comment schema', async () => {
      const invalid = {
        version: 1,
        comments: [
          {
            id: 'c1',
            author: 'human',
            actorId: 'x',
            target: { type: 'scene', id: 'E1' },
            severity: 'nit',
            category: 'style',
            content: 'x',
            status: 'bogus',
            applications: [],
            createdAt: '2025-01-01T00:00:00.000Z',
          },
        ],
        patches: [],
      };
      expect(reviewLedgerV1Schema.safeParse(invalid).success).toBe(false);
      await execution.compareAndSwapReview({
        projectId: PROJECT_ID,
        reviewId: LEDGER_REVIEW_ID,
        expectedVersion: null,
        value: { version: 1, projectId: PROJECT_ID, reviewId: LEDGER_REVIEW_ID, value: invalid },
      });
      await expect(manager.readLedger()).rejects.toThrow('Invalid review ledger structure');
    });
  });

  // 8. CAS stale expected hash ──────────────────────────────────────────────

  describe('CAS stale expected hash', () => {
    it('throws STORAGE_CONFLICT when expectedLedgerHash is stale', async () => {
      // Establish a ledger
      await manager.addReviewComment(newComment(), 'a');
      const snapshot = await manager.readLedger();
      expect(snapshot.contentHash).toBeDefined();
      if (snapshot.contentHash === undefined)
        throw new Error('Expected review ledger hash fixture');
      const staleHash = snapshot.contentHash;

      // Replace the ledger externally — different content, different hash
      const external: ReviewLedgerV1 = {
        version: 1,
        comments: [
          {
            id: 'ext',
            author: 'human',
            actorId: 'x',
            target: { type: 'novel', id: 'novel' },
            severity: 'blocking',
            category: 'style',
            content: 'external',
            status: 'open',
            applications: [],
            createdAt: '2025-01-01T00:00:00.000Z',
          },
        ],
        patches: [],
      };
      const result = await execution.compareAndSwapReview({
        projectId: PROJECT_ID,
        reviewId: LEDGER_REVIEW_ID,
        expectedVersion: 1,
        value: { version: 1, projectId: PROJECT_ID, reviewId: LEDGER_REVIEW_ID, value: external },
      });
      expect(result.kind).toBe('committed');

      // Attempt a mutation with the stale hash
      let caught: unknown;
      try {
        await manager.addReviewComment(newComment(), 'b', { expectedLedgerHash: staleHash });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(EditorialOperationError);
      expect((caught as EditorialOperationError).code).toBe('STORAGE_CONFLICT');
    });

    it('succeeds when the expected hash matches the current content', async () => {
      await manager.addReviewComment(newComment(), 'a');
      const snapshot = await manager.readLedger();

      const c2 = await manager.addReviewComment(newComment(), 'b', {
        expectedLedgerHash: snapshot.contentHash,
      });
      expect(c2).toBeTruthy();
      expect(await manager.getComments()).toHaveLength(2);
    });
  });

  // 9. applyComments — E1/E2 explicit application statuses ─────────────────

  describe('applyComments', () => {
    it('adds an application to comments and marks specified IDs as addressed', async () => {
      const c1 = await manager.addReviewComment(
        {
          target: { type: 'scene', id: 'E1' },
          severity: 'blocking',
          category: 'plot_logic',
          content: 'fix plot',
        },
        'a',
      );
      const c2 = await manager.addReviewComment(
        {
          target: { type: 'scene', id: 'E2' },
          severity: 'suggestion',
          category: 'style',
          content: 'tweak',
        },
        'a',
      );
      const app = makeApplication('E1');
      const addressed = new Set([c1.id]);

      const updated = await manager.applyComments([c1.id, c2.id], app, addressed);
      expect(updated).toHaveLength(2);

      // c1 — addressed
      const c1Result = updated.find((c) => c.id === c1.id);
      expect(c1Result).toBeDefined();
      if (!c1Result) throw new Error('Expected addressed review comment fixture');
      expect(c1Result.status).toBe('addressed');
      expect(c1Result.applications).toHaveLength(1);
      expect(c1Result.applications[0].eventId).toBe('E1');

      // c2 — still open, but has the application
      const c2Result = updated.find((c) => c.id === c2.id);
      expect(c2Result).toBeDefined();
      if (!c2Result) throw new Error('Expected open review comment fixture');
      expect(c2Result.status).toBe('open');
      expect(c2Result.applications).toHaveLength(1);
    });

    it('throws EditorialOperationError for unknown comment IDs', async () => {
      await expect(
        manager.applyComments(['nonexistent'], makeApplication('E1'), new Set()),
      ).rejects.toThrow(EditorialOperationError);
    });

    it('multiple applications accumulate on a comment', async () => {
      const c1 = await manager.addReviewComment(newComment(), 'a');
      const app1 = makeApplication('E1');
      const app2 = makeApplication('E2');

      await manager.applyComments([c1.id], app1, new Set());
      await manager.applyComments([c1.id], app2, new Set([c1.id]));

      const comments = await manager.getComments();
      const updated = comments.find((c) => c.id === c1.id);
      expect(updated).toBeDefined();
      if (!updated) throw new Error('Expected updated review comment fixture');
      expect(updated.applications).toHaveLength(2);
      expect(updated.applications[0].eventId).toBe('E1');
      expect(updated.applications[1].eventId).toBe('E2');
    });
  });

  // 10. getPatches ──────────────────────────────────────────────────────────

  describe('getPatches', () => {
    it('returns an empty array for an empty ledger', async () => {
      expect(await manager.getPatches()).toEqual([]);
    });

    it('returns patches stored in the ledger record', async () => {
      const ledger: ReviewLedgerV1 = {
        version: 1,
        comments: [],
        patches: [
          {
            sourceReviewIds: ['c1'],
            description: 'Fix grammar',
            changes: [
              { type: 'rewrite', target: 'E1', newValue: 'corrected', rationale: 'grammar' },
            ],
          },
        ],
      };
      await execution.compareAndSwapReview({
        projectId: PROJECT_ID,
        reviewId: LEDGER_REVIEW_ID,
        expectedVersion: null,
        value: { version: 1, projectId: PROJECT_ID, reviewId: LEDGER_REVIEW_ID, value: ledger },
      });
      const patches = await manager.getPatches();
      expect(patches).toHaveLength(1);
      expect(patches[0].description).toBe('Fix grammar');
    });
  });

  // 11. getSummary with data ────────────────────────────────────────────────

  describe('getSummary', () => {
    it('reports correct counts across statuses', async () => {
      const _blocking = await manager.addReviewComment(
        {
          target: { type: 'scene', id: 'E1' },
          severity: 'blocking',
          category: 'plot_logic',
          content: 'b1',
        },
        'a',
      );
      const nit = await manager.addReviewComment(
        { target: { type: 'scene', id: 'E1' }, severity: 'nit', category: 'style', content: 'n1' },
        'a',
      );

      // Resolve the nit comment; the blocking one stays open
      await manager.updateReviewComment(nit.id, 'resolve', 'a');

      const summary = await manager.getSummary();
      expect(summary.total).toBe(2);
      expect(summary.open).toBe(1);
      expect(summary.resolved).toBe(1);
      expect(summary.blocking).toBe(1);
    });

    it('counts wontfix and superseded statuses', async () => {
      const c1 = await manager.addReviewComment(newComment(), 'a');
      const c2 = await manager.addReviewComment(newComment(), 'a');

      await manager.updateReviewComment(c1.id, 'wontfix', 'a');
      await manager.replaceReviewComment(c2.id, newComment(), 'b');

      const summary = await manager.getSummary();
      expect(summary.wontfix).toBe(1);
      expect(summary.superseded).toBe(1);
    });
  });

  // 12. Deterministic injected services ─────────────────────────────────────

  describe('deterministic injected services', () => {
    const FIXED_NOW = '2026-08-02T12:00:00.000Z';

    it('creates a comment with the exact injected ID and timestamp', async () => {
      const manager = new ReviewManager(
        execution,
        PROJECT_ID,
        fixedServices(FIXED_NOW, ['rev_fixed_1']),
      );
      const comment = await manager.addReviewComment(newComment(), 'actor-1');

      expect(comment.id).toBe('rev_fixed_1');
      expect(comment.createdAt).toBe(FIXED_NOW);
      expect(comment.status).toBe('open');
      expect(comment.applications).toEqual([]);
    });

    it('identical inputs under identical fixed services produce identical comments', async () => {
      const managerA = new ReviewManager(
        execution,
        PROJECT_ID,
        fixedServices(FIXED_NOW, ['rev_fixed_1']),
      );
      const managerB = new ReviewManager(
        new MemoryExecutionRepository(),
        PROJECT_ID,
        fixedServices(FIXED_NOW, ['rev_fixed_1']),
      );

      const a = await managerA.addReviewComment(newComment({ content: 'same content' }), 'actor-1');
      const b = await managerB.addReviewComment(newComment({ content: 'same content' }), 'actor-1');
      expect(a).toEqual(b);
      expect(a.createdAt).toBe(FIXED_NOW);
    });

    it('replacement and supersession stamps come from the injected services', async () => {
      const manager = new ReviewManager(
        execution,
        PROJECT_ID,
        fixedServices(FIXED_NOW, ['rev_orig', 'rev_repl']),
      );
      const original = await manager.addReviewComment(newComment(), 'a');
      const replacement = await manager.replaceReviewComment(original.id, newComment(), 'b');

      expect(original.id).toBe('rev_orig');
      expect(replacement.id).toBe('rev_repl');
      expect(replacement.supersedesId).toBe('rev_orig');
      expect(replacement.createdAt).toBe(FIXED_NOW);

      const superseded = (await manager.getComments({ status: 'superseded' }))[0];
      expect(superseded.resolvedAt).toBe(FIXED_NOW);
      expect(superseded.resolvedBy).toBe('b');
    });

    it('resolution stamps the injected clock time', async () => {
      const manager = new ReviewManager(
        execution,
        PROJECT_ID,
        fixedServices(FIXED_NOW, ['rev_c1']),
      );
      const comment = await manager.addReviewComment(newComment(), 'a');
      const updated = await manager.updateReviewComment(comment.id, 'resolve', 'reviewer-1');

      expect(updated.status).toBe('resolved');
      expect(updated.resolvedAt).toBe(FIXED_NOW);
      expect(updated.resolvedBy).toBe('reviewer-1');
    });

    it('a create/replace/resolve sequence yields byte-identical persisted ledgers for fixed services', async () => {
      const run = async () => {
        const repo = new MemoryExecutionRepository();
        const manager = new ReviewManager(
          repo,
          PROJECT_ID,
          fixedServices(FIXED_NOW, ['rev_s1', 'rev_s2']),
        );
        const created = await manager.addReviewComment(
          newComment({ content: 'deterministic' }),
          'a',
        );
        await manager.replaceReviewComment(
          created.id,
          newComment({ content: 'deterministic replacement' }),
          'b',
        );
        const open = (await manager.getComments()).find((c) => c.status === 'open');
        expect(open).toBeDefined();
        if (!open) throw new Error('Expected open deterministic review comment fixture');
        await manager.updateReviewComment(open.id, 'resolve', 'c');
        const record = await repo.readReview({ projectId: PROJECT_ID, reviewId: LEDGER_REVIEW_ID });
        expect(record).not.toBeNull();
        if (!record) throw new Error('Expected deterministic review record fixture');
        return record.value.value;
      };
      expect(await run()).toEqual(await run());
    });
  });

  // 13. Pure comment lifecycle — explicit timestamps ────────────────────────

  describe('comment lifecycle pure functions', () => {
    const NOW = '2026-08-02T12:00:00.000Z';

    it('resolve stamps the caller-supplied timestamp and patch', () => {
      const comments = [reviewComment('c1')];
      resolve(comments, 'c1', NOW, 'patch-1');

      expect(comments[0].status).toBe('resolved');
      expect(comments[0].resolvedAt).toBe(NOW);
      expect(comments[0].resolvedBy).toBe('patch-1');
    });

    it('resolve without a patch keeps the previous resolvedBy', () => {
      const comments = [reviewComment('c1', { resolvedBy: 'other' })];
      resolve(comments, 'c1', NOW);

      expect(comments[0].status).toBe('resolved');
      expect(comments[0].resolvedAt).toBe(NOW);
      expect(comments[0].resolvedBy).toBe('other');
    });

    it('resolve ignores unknown comment IDs', () => {
      const comments = [reviewComment('c1')];
      resolve(comments, 'missing', NOW);

      expect(comments[0].status).toBe('open');
      expect(comments[0].resolvedAt).toBeUndefined();
    });

    it('markWontfix stamps the caller-supplied timestamp without mutating the input', () => {
      const input = [reviewComment('c1')];
      const updated = markWontfix(input, 'c1', NOW, 'reviewer-1');

      expect(updated[0].status).toBe('wontfix');
      expect(updated[0].resolvedAt).toBe(NOW);
      expect(updated[0].resolvedBy).toBe('reviewer-1');
      expect(input[0].status).toBe('open');
      expect(input[0].resolvedAt).toBeUndefined();
    });
  });

  // 14. Editorial review facade — injected services reach ReviewManager ─────

  describe('editorial review facade', () => {
    const FACADE_NOW = '2026-08-02T12:00:00.000Z';

    function facadeRuntime(
      repo: MemoryExecutionRepository,
      ids: readonly string[],
    ): EditorialRuntime {
      const services = fixedServices(FACADE_NOW, ids);
      return {
        services: { execution: repo, clock: services.clock, ids: services.ids },
      } as unknown as EditorialRuntime;
    }

    it('adds a facade comment with the injected ID and timestamp, not the fallback', async () => {
      const repo = new MemoryExecutionRepository();
      const created = await addReviewComment(
        {
          projectId: PROJECT_ID,
          input: newComment({ content: 'facade add' }),
          mutation: { operationId: crypto.randomUUID(), actorId: 'actor-1' },
        },
        facadeRuntime(repo, ['rev_facade_1']),
      );

      expect(created.id).toBe('rev_facade_1');
      expect(created.createdAt).toBe(FACADE_NOW);
    });

    it('replacement and resolution stamp the same injected services through the facade', async () => {
      const repo = new MemoryExecutionRepository();
      const facade = facadeRuntime(repo, ['rev_facade_a', 'rev_facade_b']);
      const created = await addReviewComment(
        {
          projectId: PROJECT_ID,
          input: newComment(),
          mutation: { operationId: crypto.randomUUID(), actorId: 'a' },
        },
        facade,
      );
      const replacement = await replaceReviewComment(
        {
          projectId: PROJECT_ID,
          commentId: created.id,
          input: newComment({ content: 'facade replacement' }),
          mutation: { operationId: crypto.randomUUID(), actorId: 'b' },
        },
        facade,
      );
      const resolved = await updateReviewComment(
        {
          projectId: PROJECT_ID,
          commentId: replacement.id,
          action: 'resolve',
          mutation: { operationId: crypto.randomUUID(), actorId: 'c' },
        },
        facade,
      );

      expect(created.id).toBe('rev_facade_a');
      expect(replacement.id).toBe('rev_facade_b');
      expect(replacement.createdAt).toBe(FACADE_NOW);
      expect(replacement.supersedesId).toBe(created.id);
      expect(resolved.status).toBe('resolved');
      expect(resolved.resolvedAt).toBe(FACADE_NOW);

      const listed = await listReviewComments({ projectId: PROJECT_ID }, facade);
      expect(listed.map((entry) => entry.id)).toEqual(['rev_facade_a', 'rev_facade_b']);
    });
  });
});

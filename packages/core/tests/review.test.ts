// ============================================================================
// ReviewManager — V1 Storage-backed Behavior Tests
//
// Tests the storage-backed ReviewManager with MemoryStorage +
// ProjectTransactionCoordinator.  No legacy in-memory API (no-arg constructor,
// addComment, resolve, address, getActiveBlocking, createPatch) appears.
// ============================================================================

import { beforeEach, describe, expect, it } from 'vitest';
import { ReviewManager } from '../src/review/index.js';
import { MemoryStorage } from '../src/storage/memory-storage.js';
import {
  resolveProjectPaths,
  ProjectTransactionCoordinator,
  type ProjectPaths,
} from '../src/editorial/index.js';
import { ConfigError, StorageConflictError } from '../src/errors.js';
import { EditorialOperationError } from '../src/editorial/errors.js';
import type {
  NewReviewComment,
  ReviewApplicationV1,
  ReviewLedgerV1,
} from '../src/types/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
    revisionId: '00000000-0000-0000-0000-000000000001',
    operationId: '00000000-0000-0000-0000-000000000002',
    appliedAt: '2025-01-01T00:00:00.000Z',
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ReviewManager', () => {
  let storage: MemoryStorage;
  let paths: ProjectPaths;
  let manager: ReviewManager;
  const projectDir = '/test-project';

  beforeEach(() => {
    storage = new MemoryStorage();
    paths = resolveProjectPaths(projectDir);
    const coordinator = new ProjectTransactionCoordinator(storage, paths);
    manager = new ReviewManager(storage, coordinator, paths.reviewLedgerPath);
  });

  // 1. Construction ──────────────────────────────────────────────────────────

  describe('construction', () => {
    it('creates manager with storage, coordinator, and ledger path', () => {
      expect(manager).toBeInstanceOf(ReviewManager);
    });

    it('throws ConfigError when storage differs from coordinator storage', () => {
      const otherStorage = new MemoryStorage();
      const otherCoordinator = new ProjectTransactionCoordinator(
        otherStorage,
        resolveProjectPaths('/other'),
      );
      expect(
        () => new ReviewManager(storage, otherCoordinator, paths.reviewLedgerPath),
      ).toThrow(ConfigError);
    });

    it('readLedger returns empty ledger when no file exists', () => {
      const snapshot = manager.readLedger();
      expect(snapshot.ledger.version).toBe(1);
      expect(snapshot.ledger.comments).toEqual([]);
      expect(snapshot.ledger.patches).toEqual([]);
      expect(snapshot.contentHash).toBeNull();
      expect(snapshot.legacy).toBe(false);
    });

    it('getSummary returns zeros for empty ledger', () => {
      const summary = manager.getSummary();
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
    it('adds a comment with generated UUID and returns structured comment', () => {
      const comment = manager.addReviewComment(newComment(), 'actor-1');

      expect(comment.id).toMatch(/^rev_/);
      expect(comment.actorId).toBe('actor-1');
      expect(comment.applications).toEqual([]);
      expect(comment.status).toBe('open');
      expect(comment.createdAt).toBeTruthy();
      expect(() => new Date(comment.createdAt)).not.toThrow();

      // Verify it is readable back
      const comments = manager.getComments();
      expect(comments).toHaveLength(1);
      expect(comments[0].id).toBe(comment.id);
    });

    it('persists comment bytes to underlying storage', () => {
      manager.addReviewComment(newComment(), 'actor-1');

      const raw = storage.read(paths.reviewLedgerPath);
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw) as ReviewLedgerV1;
      expect(parsed.version).toBe(1);
      expect(parsed.comments).toHaveLength(1);
    });

    it('trims whitespace from actorId', () => {
      const comment = manager.addReviewComment(newComment(), '  actor-2  ');
      expect(comment.actorId).toBe('actor-2');
    });

    it('each comment gets a unique UUID', () => {
      const c1 = manager.addReviewComment(newComment(), 'a');
      const c2 = manager.addReviewComment(newComment(), 'a');
      expect(c1.id).not.toBe(c2.id);
    });

    it('applications is empty for a fresh comment', () => {
      const comment = manager.addReviewComment(newComment(), 'a');
      expect(comment.applications).toEqual([]);
    });

    describe('line bounds', () => {
      it('accepts line range within scene line count', () => {
        const input: NewReviewComment = {
          target: {
            type: 'line',
            id: 'E1',
            lineRange: [1, 10],
            lineBasis: {
              revisionId: '00000000-0000-0000-0000-000000000001',
              proseHash: 'a'.repeat(64),
            },
          },
          severity: 'nit',
          category: 'style',
          content: 'Line comment',
        };
        const comment = manager.addReviewComment(input, 'a', {}, 100);
        expect(comment.target.type).toBe('line');
      });

      it('rejects line range ending beyond scene line count', () => {
        const input: NewReviewComment = {
          target: {
            type: 'line',
            id: 'E1',
            lineRange: [1, 200],
            lineBasis: {
              revisionId: '00000000-0000-0000-0000-000000000001',
              proseHash: 'a'.repeat(64),
            },
          },
          severity: 'nit',
          category: 'style',
          content: 'Line comment',
        };
        expect(() => manager.addReviewComment(input, 'a', {}, 100)).toThrow(
          EditorialOperationError,
        );
      });
    });
  });

  // 3. getComments — filters ─────────────────────────────────────────────────

  describe('getComments filters', () => {
    beforeEach(() => {
      manager.addReviewComment(
        { target: { type: 'scene', id: 'E1' }, severity: 'blocking', category: 'style', content: 'c1' },
        'actor',
      );
      manager.addReviewComment(
        { target: { type: 'scene', id: 'E2' }, severity: 'suggestion', category: 'pacing', content: 'c2' },
        'actor',
      );
      manager.addReviewComment(
        { target: { type: 'scene', id: 'E1' }, severity: 'nit', category: 'style', content: 'c3' },
        'actor',
      );
      // Resolve c2 so we have a mix of statuses
      const all = manager.getComments();
      const c2 = all.find((c) => c.content === 'c2')!;
      manager.updateReviewComment(c2.id, 'resolve', 'actor');
    });

    it('returns all comments with no filter', () => {
      expect(manager.getComments()).toHaveLength(3);
    });

    it('filters by status', () => {
      const open = manager.getComments({ status: 'open' });
      expect(open).toHaveLength(2);
      expect(open.every((c) => c.status === 'open')).toBe(true);
    });

    it('filters by severity', () => {
      const blocking = manager.getComments({ severity: 'blocking' });
      expect(blocking).toHaveLength(1);
      expect(blocking[0].severity).toBe('blocking');
    });

    it('filters by targetType', () => {
      const scenes = manager.getComments({ targetType: 'scene' });
      expect(scenes).toHaveLength(3);
    });

    it('filters by targetId', () => {
      const e1 = manager.getComments({ targetId: 'E1' });
      expect(e1).toHaveLength(2);
      expect(e1.every((c) => c.target.id === 'E1')).toBe(true);
    });

    it('returns comments sorted by createdAt then id', () => {
      const all = manager.getComments();
      for (let i = 1; i < all.length; i++) {
        const prev = all[i - 1].createdAt;
        const curr = all[i].createdAt;
        expect(prev <= curr).toBe(true);
      }
    });
  });

  // 4. getApplicableOpenComments — applicability order ───────────────────────

  describe('getApplicableOpenComments', () => {
    beforeEach(() => {
      manager.addReviewComment(
        { target: { type: 'novel', id: 'novel' }, severity: 'nit', category: 'style', content: 'novel-global' },
        'a',
      );
      manager.addReviewComment(
        { target: { type: 'chapter', id: 'chapter:2' }, severity: 'nit', category: 'style', content: 'chapter-2' },
        'a',
      );
      manager.addReviewComment(
        { target: { type: 'chapter', id: 'chapter:5' }, severity: 'nit', category: 'style', content: 'chapter-5' },
        'a',
      );
      manager.addReviewComment(
        { target: { type: 'scene', id: 'E1' }, severity: 'nit', category: 'style', content: 'scene-E1' },
        'a',
      );
      manager.addReviewComment(
        { target: { type: 'scene', id: 'E2' }, severity: 'nit', category: 'style', content: 'scene-E2' },
        'a',
      );
    });

    it('returns only open comments applicable to the given event and chapter', () => {
      const applicable = manager.getApplicableOpenComments('E1', 2);
      const contents = applicable.map((c) => c.content);
      expect(contents).toContain('novel-global');
      expect(contents).toContain('chapter-2');
      expect(contents).toContain('scene-E1');
      expect(contents).not.toContain('chapter-5');
      expect(contents).not.toContain('scene-E2');
    });

    it('excludes comments for a non-matching chapter', () => {
      const applicable = manager.getApplicableOpenComments('E1', 3);
      const contents = applicable.map((c) => c.content);
      expect(contents).toContain('novel-global');
      expect(contents).not.toContain('chapter-2');
      expect(contents).not.toContain('chapter-5');
      expect(contents).toContain('scene-E1');
    });

    it('returns comments in stable order: novel, chapter, scene', () => {
      const applicable = manager.getApplicableOpenComments('E1', 2);
      const types = applicable.map((c) => c.target.type);
      const filtered = types.filter((t) => ['novel', 'chapter', 'scene'].includes(t));
      expect(filtered).toEqual(['novel', 'chapter', 'scene']);
    });

    it('does not return resolved, wontfix, addressed, or superseded comments', () => {
      const all = manager.getComments();
      const scene = all.find((c) => c.content === 'scene-E1')!;
      manager.updateReviewComment(scene.id, 'resolve', 'a');

      const applicable = manager.getApplicableOpenComments('E1', 2);
      expect(applicable.find((c) => c.id === scene.id)).toBeUndefined();
    });

    it('ignores novel comment when it is resolved', () => {
      const all = manager.getComments();
      const novel = all.find((c) => c.content === 'novel-global')!;
      manager.updateReviewComment(novel.id, 'resolve', 'a');

      const applicable = manager.getApplicableOpenComments('E1', 2);
      expect(applicable.find((c) => c.id === novel.id)).toBeUndefined();
    });
  });

  // 5. replaceReviewComment — superseded chain ──────────────────────────────

  describe('replaceReviewComment', () => {
    it('creates replacement with supersedesId and marks original as superseded', () => {
      const original = manager.addReviewComment(
        { target: { type: 'scene', id: 'E1' }, severity: 'blocking', category: 'plot_logic', content: 'original' },
        'a',
      );

      const replacement = manager.replaceReviewComment(
        original.id,
        { target: { type: 'scene', id: 'E1' }, severity: 'suggestion', category: 'style', content: 'replacement' },
        'b',
      );

      expect(replacement.supersedesId).toBe(original.id);

      const superseded = manager.getComments({ status: 'superseded' });
      expect(superseded).toHaveLength(1);
      expect(superseded[0].id).toBe(original.id);
    });

    it('does not mutate the original comment content or target', () => {
      const original = manager.addReviewComment(
        { target: { type: 'scene', id: 'E1' }, severity: 'blocking', category: 'plot_logic', content: 'original text' },
        'a',
      );

      manager.replaceReviewComment(
        original.id,
        { target: { type: 'scene', id: 'E2' }, severity: 'suggestion', category: 'style', content: 'new text' },
        'b',
      );

      const superseded = manager.getComments({ status: 'superseded' });
      expect(superseded[0].content).toBe('original text');
      expect(superseded[0].target).toEqual({ type: 'scene', id: 'E1' });
    });

    it('sets resolvedAt and resolvedBy on the superseded original', () => {
      const original = manager.addReviewComment(newComment(), 'a');
      manager.replaceReviewComment(original.id, newComment(), 'b');

      const superseded = manager.getComments({ status: 'superseded' })[0];
      expect(superseded.resolvedAt).toBeTruthy();
      expect(superseded.resolvedBy).toBe('b');
    });

    it('throws EditorialOperationError when the original is not found', () => {
      expect(() =>
        manager.replaceReviewComment('nonexistent', newComment(), 'a'),
      ).toThrow(EditorialOperationError);
    });

    it('throws EditorialOperationError when the original is already superseded', () => {
      const c1 = manager.addReviewComment(newComment(), 'a');
      manager.replaceReviewComment(c1.id, newComment(), 'b');
      expect(() =>
        manager.replaceReviewComment(c1.id, newComment(), 'c'),
      ).toThrow(EditorialOperationError);
    });

    describe('line bounds on replacement', () => {
      it('rejects replacement with out-of-bounds line range', () => {
        const original = manager.addReviewComment(newComment(), 'a');
        const badInput: NewReviewComment = {
          target: {
            type: 'line',
            id: 'E1',
            lineRange: [1, 999],
            lineBasis: {
              revisionId: '00000000-0000-0000-0000-000000000001',
              proseHash: 'b'.repeat(64),
            },
          },
          severity: 'nit',
          category: 'style',
          content: 'out of bounds',
        };
        expect(() =>
          manager.replaceReviewComment(original.id, badInput, 'a', {}, 50),
        ).toThrow(EditorialOperationError);
      });
    });
  });

  // 6. updateReviewComment — lifecycle actions ──────────────────────────────

  describe('updateReviewComment lifecycle', () => {
    let commentId: string;

    beforeEach(() => {
      commentId = manager.addReviewComment(newComment(), 'a').id;
    });

    it('resolve sets status resolved, resolvedAt, resolvedBy', () => {
      const updated = manager.updateReviewComment(commentId, 'resolve', 'reviewer-1');
      expect(updated.status).toBe('resolved');
      expect(updated.resolvedAt).toBeTruthy();
      expect(updated.resolvedBy).toBe('reviewer-1');

      // Persisted — read back
      const loaded = manager.getComments({ status: 'resolved' });
      expect(loaded).toHaveLength(1);
      expect(loaded[0].resolvedBy).toBe('reviewer-1');
    });

    it('wontfix sets status wontfix, resolvedAt, resolvedBy', () => {
      const updated = manager.updateReviewComment(commentId, 'wontfix', 'reviewer-2');
      expect(updated.status).toBe('wontfix');
      expect(updated.resolvedAt).toBeTruthy();
      expect(updated.resolvedBy).toBe('reviewer-2');
    });

    it('reopen restores status open and clears resolved fields', () => {
      manager.updateReviewComment(commentId, 'resolve', 'reviewer-1');
      const reopened = manager.updateReviewComment(commentId, 'reopen', 'reviewer-2');
      expect(reopened.status).toBe('open');
      expect(reopened.resolvedAt).toBeUndefined();
      expect(reopened.resolvedBy).toBeUndefined();
    });

    it('escalate sets severity to blocking and status to open', () => {
      manager.updateReviewComment(commentId, 'resolve', 'a');
      const escalated = manager.updateReviewComment(commentId, 'escalate', 'reviewer-1');
      expect(escalated.severity).toBe('blocking');
      expect(escalated.status).toBe('open');
      expect(escalated.resolvedAt).toBeUndefined();
      expect(escalated.resolvedBy).toBeUndefined();
    });

    it('throws EditorialOperationError when comment is not found', () => {
      expect(() =>
        manager.updateReviewComment('nonexistent', 'resolve', 'a'),
      ).toThrow(EditorialOperationError);
    });

    it('throws EditorialOperationError when comment is superseded', () => {
      manager.replaceReviewComment(commentId, newComment(), 'b');
      expect(() =>
        manager.updateReviewComment(commentId, 'resolve', 'a'),
      ).toThrow(EditorialOperationError);
    });
  });

  // 7. Legacy upgrades ──────────────────────────────────────────────────────

  describe('legacy ledger upgrades', () => {
    it('reads legacy format and normalizes comments', () => {
      const legacy = {
        comments: [
          {
            id: 'c1',
            author: 'human',
            target: { type: 'scene', id: 'E1' },
            severity: 'nit',
            category: 'style',
            content: 'legacy comment',
            status: 'open',
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        patches: [],
      };
      storage.write(paths.reviewLedgerPath, JSON.stringify(legacy));

      const snapshot = manager.readLedger();
      expect(snapshot.legacy).toBe(true);
      expect(snapshot.ledger.comments).toHaveLength(1);
      const c = snapshot.ledger.comments[0];
      expect(c.actorId).toBe('legacy');
      expect(c.applications).toEqual([]);
      expect(c.id).toBe('c1');
    });

    it('preserves patches from legacy format', () => {
      const legacy = {
        comments: [],
        patches: [
          {
            sourceReviewIds: ['c1'],
            description: 'Fix grammar',
            changes: [
              { type: 'rewrite' as const, target: 'E1', newValue: 'fixed', rationale: 'grammar' },
            ],
          },
        ],
      };
      storage.write(paths.reviewLedgerPath, JSON.stringify(legacy));

      const snapshot = manager.readLedger();
      expect(snapshot.ledger.patches).toHaveLength(1);
      expect(snapshot.ledger.patches[0].description).toBe('Fix grammar');
    });

    it('defaults actorId to "legacy" when comment is missing the field', () => {
      const legacy = {
        comments: [
          {
            id: 'c1',
            author: 'human',
            target: { type: 'scene', id: 'E1' },
            severity: 'nit',
            category: 'style',
            content: 'no-actor',
            status: 'open',
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        patches: [],
      };
      storage.write(paths.reviewLedgerPath, JSON.stringify(legacy));
      expect(manager.readLedger().ledger.comments[0].actorId).toBe('legacy');
    });

    it('defaults applications to empty array when missing', () => {
      const legacy = {
        comments: [
          {
            id: 'c1',
            author: 'human',
            target: { type: 'scene', id: 'E1' },
            severity: 'nit',
            category: 'style',
            content: 'no-apps',
            status: 'open',
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        patches: [],
      };
      storage.write(paths.reviewLedgerPath, JSON.stringify(legacy));
      expect(manager.readLedger().ledger.comments[0].applications).toEqual([]);
    });

    it('mutation persists upgraded v1 format to storage', () => {
      const legacy = {
        comments: [
          {
            id: 'c1',
            author: 'human',
            target: { type: 'scene', id: 'E1' },
            severity: 'nit',
            category: 'style',
            content: 'old',
            status: 'open',
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        patches: [],
      };
      storage.write(paths.reviewLedgerPath, JSON.stringify(legacy));

      manager.addReviewComment(newComment(), 'new-actor');

      const raw = storage.read(paths.reviewLedgerPath);
      const parsed = JSON.parse(raw) as ReviewLedgerV1;
      expect(parsed.version).toBe(1);
      expect(parsed.comments).toHaveLength(2);
      const legacyStored = parsed.comments.find((c) => c.actorId === 'legacy');
      expect(legacyStored).toBeTruthy();
      expect(legacyStored!.applications).toEqual([]);
    });

    it('second readLedger reports legacy: false after upgrade persist', () => {
      const legacy = {
        comments: [
          {
            id: 'c1',
            author: 'human',
            target: { type: 'scene', id: 'E1' },
            severity: 'nit',
            category: 'style',
            content: 'old',
            status: 'open',
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        patches: [],
      };
      storage.write(paths.reviewLedgerPath, JSON.stringify(legacy));
      // Load once to get legacy: true
      expect(manager.readLedger().legacy).toBe(true);

      // Trigger a mutation that persists the upgraded v1 format
      manager.addReviewComment(newComment(), 'x');

      // After persist, re-read — should be v1, not legacy
      expect(manager.readLedger().legacy).toBe(false);
    });
  });

  // 8. Malformed ledger ─────────────────────────────────────────────────────

  describe('malformed ledger', () => {
    it('throws ConfigError for invalid JSON', () => {
      storage.write(paths.reviewLedgerPath, 'not-json');
      expect(() => manager.readLedger()).toThrow(ConfigError);
    });

    it('error context includes the ledger path', () => {
      storage.write(paths.reviewLedgerPath, '{broken');
      try {
        manager.readLedger();
        expect.fail('should have thrown ConfigError');
      } catch (e) {
        if (e instanceof ConfigError) {
          expect(e.context.path).toBe(paths.reviewLedgerPath);
        }
      }
    });

    it('throws ConfigError for structurally invalid v1 content', () => {
      storage.write(
        paths.reviewLedgerPath,
        JSON.stringify({ version: 1, comments: 'not-an-array', patches: [] }),
      );
      expect(() => manager.readLedger()).toThrow(ConfigError);
    });

    it('throws ConfigError for non-object root', () => {
      storage.write(paths.reviewLedgerPath, '"just a string"');
      expect(() => manager.readLedger()).toThrow(ConfigError);
    });
  });

  // 9. CAS stale expected hash ──────────────────────────────────────────────

  describe('CAS stale expected hash', () => {
    it('causes StorageConflictError when expectedLedgerHash is stale', () => {
      // Establish a ledger
      manager.addReviewComment(newComment(), 'a');
      const snapshot = manager.readLedger();
      const staleHash = snapshot.contentHash;

      // Modify the ledger externally — different content, different hash
      storage.write(
        paths.reviewLedgerPath,
        JSON.stringify({
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
        }),
      );

      // Attempt mutation with stale hash
      expect(() =>
        manager.addReviewComment(newComment(), 'b', { expectedLedgerHash: staleHash }),
      ).toThrow(StorageConflictError);
    });

    it('succeeds when expected hash matches current content', () => {
      manager.addReviewComment(newComment(), 'a');
      const snapshot = manager.readLedger();

      const c2 = manager.addReviewComment(newComment(), 'b', {
        expectedLedgerHash: snapshot.contentHash,
      });
      expect(c2).toBeTruthy();
      expect(manager.getComments()).toHaveLength(2);
    });
  });

  // 10. applyComments — E1/E2 explicit application statuses ─────────────────

  describe('applyComments', () => {
    it('adds application to comments and marks specified IDs as addressed', () => {
      const c1 = manager.addReviewComment(
        { target: { type: 'scene', id: 'E1' }, severity: 'blocking', category: 'plot_logic', content: 'fix plot' },
        'a',
      );
      const c2 = manager.addReviewComment(
        { target: { type: 'scene', id: 'E2' }, severity: 'suggestion', category: 'style', content: 'tweak' },
        'a',
      );
      const app = makeApplication('E1');
      const addressed = new Set([c1.id]);

      const updated = manager.applyComments([c1.id, c2.id], app, addressed);
      expect(updated).toHaveLength(2);

      // c1 — addressed
      const c1Result = updated.find((c) => c.id === c1.id)!;
      expect(c1Result.status).toBe('addressed');
      expect(c1Result.applications).toHaveLength(1);
      expect(c1Result.applications[0].eventId).toBe('E1');

      // c2 — still open, but has the application
      const c2Result = updated.find((c) => c.id === c2.id)!;
      expect(c2Result.status).toBe('open');
      expect(c2Result.applications).toHaveLength(1);
    });

    it('throws EditorialOperationError for unknown comment IDs', () => {
      expect(() =>
        manager.applyComments(['nonexistent'], makeApplication('E1'), new Set()),
      ).toThrow(EditorialOperationError);
    });

    it('multiple applications accumulate on a comment', () => {
      const c1 = manager.addReviewComment(newComment(), 'a');
      const app1 = makeApplication('E1');
      const app2 = makeApplication('E2');

      manager.applyComments([c1.id], app1, new Set());
      manager.applyComments([c1.id], app2, new Set([c1.id]));

      const comments = manager.getComments();
      const updated = comments.find((c) => c.id === c1.id)!;
      expect(updated.applications).toHaveLength(2);
      expect(updated.applications[0].eventId).toBe('E1');
      expect(updated.applications[1].eventId).toBe('E2');
    });
  });

  // 11. getPatches ──────────────────────────────────────────────────────────

  describe('getPatches', () => {
    it('returns empty array for empty ledger', () => {
      expect(manager.getPatches()).toEqual([]);
    });

    it('returns patches stored in the ledger', () => {
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
      storage.write(paths.reviewLedgerPath, JSON.stringify(ledger));
      const patches = manager.getPatches();
      expect(patches).toHaveLength(1);
      expect(patches[0].description).toBe('Fix grammar');
    });
  });

  // 12. getSummary with data ────────────────────────────────────────────────

  describe('getSummary', () => {
    it('reports correct counts across statuses', () => {
      const blocking = manager.addReviewComment(
        { target: { type: 'scene', id: 'E1' }, severity: 'blocking', category: 'plot_logic', content: 'b1' },
        'a',
      );
      const nit = manager.addReviewComment(
        { target: { type: 'scene', id: 'E1' }, severity: 'nit', category: 'style', content: 'n1' },
        'a',
      );

      // Resolve the nit comment; the blocking one stays open
      manager.updateReviewComment(nit.id, 'resolve', 'a');

      const summary = manager.getSummary();
      expect(summary.total).toBe(2);
      expect(summary.open).toBe(1);
      expect(summary.resolved).toBe(1);
      expect(summary.blocking).toBe(1);
    });

    it('counts wontfix and superseded statuses', () => {
      const c1 = manager.addReviewComment(newComment(), 'a');
      const c2 = manager.addReviewComment(newComment(), 'a');

      manager.updateReviewComment(c1.id, 'wontfix', 'a');
      manager.replaceReviewComment(c2.id, newComment(), 'b');

      const summary = manager.getSummary();
      expect(summary.wontfix).toBe(1);
      expect(summary.superseded).toBe(1);
    });
  });
});

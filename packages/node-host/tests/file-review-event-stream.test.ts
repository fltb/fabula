// ============================================================================
// FileExecutionRepository — append-only review event stream
//
// Covers the event stream CAS contract, cross-instance persistence, the
// one-time legacy `ledger` import (with no dual-write), fromSequence reads,
// and corruption handling.
// ============================================================================

import type { ReviewEventDraftV1, ReviewEventRecordV1, ReviewLedgerV1 } from '@novalistically/core';
import { describe, expect, it } from 'vitest';
import { FileExecutionRepository } from '../src/execution/file-execution-repository.js';
import { withTempProject } from './execution-fixtures.js';

const PROJECT_ID = 'test-project';
const NOW = '2026-08-02T00:00:00.000Z';

const draft = (
  kind: ReviewEventDraftV1['kind'],
  overrides?: Partial<ReviewEventDraftV1>,
): ReviewEventDraftV1 => ({
  version: 1,
  projectId: PROJECT_ID,
  kind,
  payload: {},
  createdAt: NOW,
  ...overrides,
});

function ledgerComment(
  id: string,
  overrides?: Partial<ReviewLedgerV1['comments'][number]>,
): ReviewLedgerV1['comments'][number] {
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
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('FileExecutionRepository review event stream', () => {
  it('appends with CAS-on-version, assigns contiguous sequences, and reads back', async () => {
    await withTempProject(async (root) => {
      const repo = new FileExecutionRepository(root);
      expect(await repo.readReviewEvents({ projectId: PROJECT_ID })).toEqual({
        version: 0,
        events: [],
      });

      const appended = await repo.appendReviewEvents({
        projectId: PROJECT_ID,
        expectedVersion: 0,
        events: [
          draft('comment_added', { commentId: 'c1' }),
          draft('comment_added', { commentId: 'c2' }),
        ],
      });
      expect(appended.kind).toBe('committed');
      if (appended.kind !== 'committed') return;
      expect(appended.version).toBe(2);
      expect(appended.value.map((record) => record.sequence)).toEqual([1, 2]);

      const stale = await repo.appendReviewEvents({
        projectId: PROJECT_ID,
        expectedVersion: 0,
        events: [draft('comment_added', { commentId: 'c3' })],
      });
      expect(stale).toEqual({ kind: 'conflict', expectedVersion: 0, actualVersion: 2 });

      const read = await repo.readReviewEvents({ projectId: PROJECT_ID });
      expect(read.version).toBe(2);
      expect(read.events.map((record) => record.commentId)).toEqual(['c1', 'c2']);
      expect(read.events.map((record) => record.sequence)).toEqual([1, 2]);
    });
  });

  it('persists the stream across repository instances', async () => {
    await withTempProject(async (root) => {
      const writer = new FileExecutionRepository(root);
      await writer.appendReviewEvents({
        projectId: PROJECT_ID,
        expectedVersion: 0,
        events: [draft('comment_added', { commentId: 'c1' })],
      });

      const reader = new FileExecutionRepository(root);
      const read = await reader.readReviewEvents({ projectId: PROJECT_ID });
      expect(read.version).toBe(1);
      expect(read.events[0].commentId).toBe('c1');
    });
  });

  it('filters by fromSequence', async () => {
    await withTempProject(async (root) => {
      const repo = new FileExecutionRepository(root);
      await repo.appendReviewEvents({
        projectId: PROJECT_ID,
        expectedVersion: 0,
        events: [
          draft('comment_added', { commentId: 'c1' }),
          draft('comment_added', { commentId: 'c2' }),
          draft('comment_added', { commentId: 'c3' }),
        ],
      });
      const tail = await repo.readReviewEvents({ projectId: PROJECT_ID, fromSequence: 3 });
      expect(tail.events.map((record) => record.commentId)).toEqual(['c3']);
      expect(tail.version).toBe(3);
    });
  });

  it('imports the legacy ledger once on first read and never dual-writes', async () => {
    await withTempProject(async (root) => {
      const repo = new FileExecutionRepository(root);
      const legacy: ReviewLedgerV1 = {
        version: 1,
        comments: [
          ledgerComment('c1'),
          ledgerComment('c2', {
            status: 'resolved',
            resolvedAt: '2026-08-01T12:00:00.000Z',
            resolvedBy: 'reviewer-1',
          }),
        ],
        patches: [],
      };
      await repo.compareAndSwapReview({
        projectId: PROJECT_ID,
        reviewId: 'ledger',
        expectedVersion: null,
        value: { version: 1, projectId: PROJECT_ID, reviewId: 'ledger', value: legacy },
      });

      // First read imports: comment_added + comment_status_changed.
      const imported = await repo.readReviewEvents({ projectId: PROJECT_ID });
      expect(imported.version).toBe(3);
      expect(imported.events.map((record) => record.kind)).toEqual([
        'comment_added',
        'comment_added',
        'comment_status_changed',
      ]);
      expect(imported.events.map((record) => record.commentId)).toEqual(['c1', 'c2', 'c2']);
      const statusEvent = imported.events[2];
      expect(statusEvent.payload).toEqual({
        to: 'resolved',
        at: '2026-08-01T12:00:00.000Z',
        by: 'reviewer-1',
      });

      // A second read does not re-import.
      const again = await repo.readReviewEvents({ projectId: PROJECT_ID });
      expect(again.version).toBe(3);

      // Appends after import grow the stream but never touch the ledger key.
      await repo.appendReviewEvents({
        projectId: PROJECT_ID,
        expectedVersion: 3,
        events: [draft('comment_status_changed', { commentId: 'c1', payload: { to: 'wontfix' } })],
      });
      const ledger = await repo.readReview({ projectId: PROJECT_ID, reviewId: 'ledger' });
      expect(ledger?.revision).toBe(1);
      expect(ledger?.value.value).toEqual(legacy);
    });
  });

  it('does not import when the stream already has events', async () => {
    await withTempProject(async (root) => {
      const repo = new FileExecutionRepository(root);
      await repo.appendReviewEvents({
        projectId: PROJECT_ID,
        expectedVersion: 0,
        events: [draft('comment_added', { commentId: 'stream-1' })],
      });
      await repo.compareAndSwapReview({
        projectId: PROJECT_ID,
        reviewId: 'ledger',
        expectedVersion: null,
        value: {
          version: 1,
          projectId: PROJECT_ID,
          reviewId: 'ledger',
          value: { version: 1, comments: [ledgerComment('legacy-1')], patches: [] },
        },
      });

      const read = await repo.readReviewEvents({ projectId: PROJECT_ID });
      expect(read.version).toBe(1);
      expect(read.events.map((record) => record.commentId)).toEqual(['stream-1']);
    });
  });

  it('isolates streams per project', async () => {
    await withTempProject(async (root) => {
      const repo = new FileExecutionRepository(root);
      await repo.appendReviewEvents({
        projectId: 'project-a',
        expectedVersion: 0,
        events: [draft('comment_added', { commentId: 'a1' })],
      });
      await repo.appendReviewEvents({
        projectId: 'project-b',
        expectedVersion: 0,
        events: [
          draft('comment_added', { commentId: 'b1' }),
          draft('comment_added', { commentId: 'b2' }),
        ],
      });

      expect((await repo.readReviewEvents({ projectId: 'project-a' })).version).toBe(1);
      expect((await repo.readReviewEvents({ projectId: 'project-b' })).version).toBe(2);
    });
  });

  it('throws on a corrupt stream line instead of returning partial data', async () => {
    await withTempProject(async (root) => {
      const repo = new FileExecutionRepository(root);
      await repo.appendReviewEvents({
        projectId: PROJECT_ID,
        expectedVersion: 0,
        events: [draft('comment_added', { commentId: 'c1' })],
      });
      // Corrupt the stream file directly: append a non-JSON line.
      const fs = await import('node:fs');
      const path = await import('node:path');
      const directory = path.join(root, '.nova', 'execution');
      const streamFile = path.join(
        directory,
        `${Buffer.from(JSON.stringify(['review-stream', PROJECT_ID]), 'utf8').toString('base64url')}.json`,
      );
      await fs.promises.appendFile(streamFile, 'not-json\n', 'utf8');

      await expect(repo.readReviewEvents({ projectId: PROJECT_ID })).rejects.toThrow(
        /Corrupt review event stream/,
      );
    });
  });

  it('rejects a structurally invalid event record in the stream', async () => {
    await withTempProject(async (root) => {
      const repo = new FileExecutionRepository(root);
      await repo.appendReviewEvents({
        projectId: PROJECT_ID,
        expectedVersion: 0,
        events: [draft('comment_added', { commentId: 'c1' })],
      });
      const fs = await import('node:fs');
      const path = await import('node:path');
      const directory = path.join(root, '.nova', 'execution');
      const streamFile = path.join(
        directory,
        `${Buffer.from(JSON.stringify(['review-stream', PROJECT_ID]), 'utf8').toString('base64url')}.json`,
      );
      const bad: ReviewEventRecordV1 = {
        version: 1,
        sequence: 2,
        projectId: PROJECT_ID,
        kind: 'comment_teleported',
        payload: {},
        createdAt: NOW,
      };
      await fs.promises.appendFile(streamFile, `${JSON.stringify(bad)}\n`, 'utf8');

      await expect(repo.readReviewEvents({ projectId: PROJECT_ID })).rejects.toThrow(
        /Corrupt review event stream/,
      );
    });
  });
});

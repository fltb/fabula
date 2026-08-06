// ============================================================================
// Editorial revision feedback — semantic repository-backed tests
//
// Feedback ordering and identity are pure value semantics (sortReviewFeedback
// and reviewFeedbackProjection); line-basis staleness, accepted-artifact
// resolution, and review applications run against MemoryExecutionRepository
// records with an explicit project ID.  No storage, coordinator, or
// ledger-path assumptions appear.
// ============================================================================

import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MockPass2Provider } from '../../src/ai/providers/mock-pass2.ts';
import { reviewFeedbackProjection, sortReviewFeedback } from '../../src/editorial/compiler.ts';
import {
  buildEventRevisionStates,
  composeRevisionDirective,
} from '../../src/editorial/render-service.ts';
import {
  addReviewComment,
  replaceReviewComment,
  updateReviewComment,
} from '../../src/editorial/review-facade.ts';
import type { AcceptedSceneRecord } from '../../src/ports/execution-repository.ts';
import type { Clock, IdGenerator } from '../../src/ports/runtime-services.ts';
import { ReviewManager } from '../../src/review/manager.ts';
import {
  MemoryExecutionRepository,
  MemoryRenderCacheRepository,
  MemoryStateLogRepository,
  MemoryStateSnapshotRepository,
} from '../../src/testing/memory-repositories.ts';
import type { EditorialRuntime, RevisionRequest } from '../../src/types/editorial.ts';
import type {
  NewReviewComment,
  ReviewApplicationV1,
  ReviewComment,
} from '../../src/types/index.ts';

const PROJECT_ID = 'revision-feedback-project';
const NOW = '2026-07-28T00:00:00.000Z';

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function comment(
  id: string,
  target: ReviewComment['target'],
  createdAt: string,
  content = id,
): ReviewComment {
  return {
    id,
    author: 'human',
    actorId: 'reviewer',
    target,
    severity: 'suggestion',
    category: 'style',
    content,
    status: 'open',
    applications: [],
    createdAt,
  };
}

function acceptedScene(
  eventId: string,
  prose: string,
  revisionId: string,
  sourceHash: string,
): AcceptedSceneRecord {
  return {
    version: 1,
    projectId: PROJECT_ID,
    eventId,
    sourceHash,
    revisionId,
    prose,
    proseHash: hash(prose),
    sceneHash: hash(prose),
  };
}

/**
 * EditorialRuntime carrying the semantic execution repository plus optional
 * review time/ID services, mirroring host-injected runtime services.
 */
function runtime(
  execution: MemoryExecutionRepository,
  services?: { clock: Clock; ids: IdGenerator },
): EditorialRuntime {
  return {
    services: {
      execution,
      renderCache: new MemoryRenderCacheRepository(),
      stateLog: new MemoryStateLogRepository(),
      stateSnapshots: new MemoryStateSnapshotRepository(),
      promptTemplates: { get: async () => null },
      clock: services?.clock ?? { now: () => NOW },
      ids: services?.ids ?? { next: () => crypto.randomUUID() },
      llm: new MockPass2Provider(),
    },
  };
}

describe('editorial revision feedback', () => {
  it('orders feedback by scope, creation time, then immutable ID', () => {
    const reviews = [
      comment(
        'rev_line',
        {
          type: 'line',
          id: 'E1',
          lineRange: [1, 1],
          lineBasis: { revisionId: crypto.randomUUID(), proseHash: hash('prose') },
        },
        '2026-07-28T00:04:00.000Z',
      ),
      comment('rev_scene_b', { type: 'scene', id: 'E1' }, '2026-07-28T00:03:00.000Z'),
      comment('rev_novel', { type: 'novel', id: 'novel' }, '2026-07-28T00:05:00.000Z'),
      comment('rev_chapter', { type: 'chapter', id: 'chapter:1' }, '2026-07-28T00:02:00.000Z'),
      comment('rev_scene_a', { type: 'scene', id: 'E1' }, '2026-07-28T00:01:00.000Z'),
    ];

    expect(sortReviewFeedback(reviews).map((review) => review.id)).toEqual([
      'rev_novel',
      'rev_chapter',
      'rev_scene_a',
      'rev_scene_b',
      'rev_line',
    ]);
  });

  it('builds event revision states from event-scoped feedback', () => {
    const reviews = [
      comment('rev_scene_b', { type: 'scene', id: 'E1' }, '2026-07-28T00:03:00.000Z'),
      comment('rev_scene_a', { type: 'scene', id: 'E1' }, '2026-07-28T00:01:00.000Z'),
      comment('rev_other', { type: 'scene', id: 'E2' }, '2026-07-28T00:02:00.000Z'),
      comment(
        'rev_line',
        {
          type: 'line',
          id: 'E1',
          lineRange: [1, 1],
          lineBasis: { revisionId: crypto.randomUUID(), proseHash: hash('prose') },
        },
        '2026-07-28T00:04:00.000Z',
      ),
    ];
    const request: RevisionRequest = { reviewIds: ['rev_scene_a', 'rev_scene_b', 'rev_line'] };

    const [result] = buildEventRevisionStates(['E1'], request, reviews);
    expect(result.state).toBe('will_revise');
    expect(result.applicableReviewIds).toEqual(['rev_scene_a', 'rev_scene_b', 'rev_line']);
  });

  it('leaves events without a revision request untouched', () => {
    const [result] = buildEventRevisionStates(['E1'], undefined, []);
    expect(result.state).toBe('no_revision_needed');
    expect(result.applicableReviewIds).toEqual([]);
  });

  it('resolves the accepted head into the event revision state', () => {
    const accepted = new Map([
      [
        'E1',
        {
          revisionId: 'rev-accepted-1',
          proseHash: hash('E1 accepted prose'),
          prose: 'E1 accepted prose',
        },
      ],
    ]);
    const request: RevisionRequest = { reviewIds: ['rev_scene_a'] };
    const reviews = [comment('rev_scene_a', { type: 'scene', id: 'E1' }, NOW)];

    const [result] = buildEventRevisionStates(['E1'], request, reviews, accepted);
    expect(result.state).toBe('will_revise');
    expect(result.baseRevisionId).toBe('rev-accepted-1');
    expect(result.baseProse).toBe('E1 accepted prose');
    expect(result.baseProseHash).toBe(hash('E1 accepted prose'));
  });

  it('keeps base fields null when a revised event has no accepted head', () => {
    const request: RevisionRequest = { instruction: 'Rewrite.' };
    const [result] = buildEventRevisionStates(['E1'], request, [], new Map());
    expect(result.state).toBe('will_revise');
    expect(result.baseRevisionId).toBeNull();
    expect(result.baseProse).toBeNull();
    expect(result.baseProseHash).toBeNull();
  });

  it('composes the revision directive deterministically: instruction first, then canonical feedback order', () => {
    const reviews = [
      comment(
        'rev_line',
        {
          type: 'line',
          id: 'E1',
          lineRange: [1, 1],
          lineBasis: { revisionId: 'r', proseHash: hash('prose') },
        },
        '2026-07-28T00:04:00.000Z',
        '  Fix the line.  ',
      ),
      comment(
        'rev_scene',
        { type: 'scene', id: 'E1' },
        '2026-07-28T00:01:00.000Z',
        'Tighten the scene.',
      ),
      comment('rev_novel', { type: 'novel', id: 'novel' }, '2026-07-28T00:02:00.000Z', '  '),
    ];

    const directive = composeRevisionDirective('Rewrite in a colder register.', reviews);
    expect(directive).toBe(
      [
        'Rewrite in a colder register.',
        '[rev_scene] Tighten the scene.',
        '[rev_line] Fix the line.',
      ].join('\n'),
    );
    // Whitespace-only review content contributes nothing; same inputs => same output.
    expect(composeRevisionDirective('Rewrite in a colder register.', reviews)).toBe(directive);
  });

  it('returns undefined when neither instruction nor review content is present', () => {
    expect(composeRevisionDirective(undefined, [])).toBeUndefined();
    expect(
      composeRevisionDirective('  ', [comment('rev_x', { type: 'scene', id: 'E1' }, NOW, '  ')]),
    ).toBeUndefined();
  });

  it('ignores lifecycle and time in an individual feedback hash', () => {
    const base = comment(
      'rev_scene',
      { type: 'scene', id: 'E1' },
      '2026-07-28T00:00:00.000Z',
      '  Tighten this paragraph.  ',
    );
    const changedIncidentalFields: ReviewComment = {
      ...base,
      actorId: 'other-reviewer',
      createdAt: '2026-07-29T00:00:00.000Z',
      applications: [
        {
          eventId: 'E0',
          revisionId: crypto.randomUUID(),
          operationId: crypto.randomUUID(),
          appliedAt: '2026-07-29T00:00:00.000Z',
        },
      ],
    };

    expect(reviewFeedbackProjection(changedIncidentalFields)).toEqual(
      reviewFeedbackProjection(base),
    );
    expect(reviewFeedbackProjection(base).trimmedContent).toBe('Tighten this paragraph.');
  });

  it('keeps line basis inside the feedback projection', () => {
    const lineReview = comment(
      'rev_line',
      {
        type: 'line',
        id: 'E1',
        lineRange: [1, 3],
        lineBasis: { revisionId: crypto.randomUUID(), proseHash: hash('prose') },
      },
      NOW,
    );

    const projection = reviewFeedbackProjection(lineReview);
    expect(projection.target).toEqual({
      type: 'line',
      id: 'E1',
      lineRange: [1, 3],
      lineBasis: {
        revisionId: lineReview.target.lineBasis?.revisionId,
        proseHash: lineReview.target.lineBasis?.proseHash,
      },
    });
  });

  it('checks both revision ID and prose hash for line review staleness', async () => {
    const execution = new MemoryExecutionRepository();
    const revisionId = crypto.randomUUID();
    await execution.compareAndSwapAcceptedScene({
      projectId: PROJECT_ID,
      eventId: 'E1',
      expectedVersion: null,
      value: acceptedScene('E1', 'line one\nline two', revisionId, hash('source')),
    });
    const line = (basisRevisionId: string, proseHash: string): NewReviewComment => ({
      target: {
        type: 'line',
        id: 'E1',
        lineRange: [1, 1],
        lineBasis: { revisionId: basisRevisionId, proseHash },
      },
      severity: 'blocking',
      category: 'plot_logic',
      content: 'Fix line',
    });
    const mutation = { operationId: crypto.randomUUID(), actorId: 'reviewer' };

    const added = await addReviewComment(
      { projectId: PROJECT_ID, mutation, input: line(revisionId, hash('line one\nline two')) },
      runtime(execution),
    );
    expect(added.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // Same prose hash but a different revision ID is stale.
    await expect(
      addReviewComment(
        {
          projectId: PROJECT_ID,
          mutation,
          input: line(crypto.randomUUID(), hash('line one\nline two')),
        },
        runtime(execution),
      ),
    ).rejects.toMatchObject({ code: 'REVISION_STALE' });

    // Same revision ID but a different prose hash is stale.
    await expect(
      addReviewComment(
        { projectId: PROJECT_ID, mutation, input: line(revisionId, hash('other prose')) },
        runtime(execution),
      ),
    ).rejects.toMatchObject({ code: 'REVISION_STALE' });
  });

  it('resolves the materialized accepted head even when a blocked candidate is recorded', async () => {
    const execution = new MemoryExecutionRepository();
    const acceptedRevisionId = crypto.randomUUID();
    await execution.compareAndSwapAcceptedScene({
      projectId: PROJECT_ID,
      eventId: 'E1',
      expectedVersion: null,
      value: acceptedScene('E1', 'E1 accepted prose', acceptedRevisionId, hash('source')),
    });
    await execution.compareAndSwapSceneRevision({
      projectId: PROJECT_ID,
      eventId: 'E1',
      revisionId: crypto.randomUUID(),
      expectedVersion: null,
      value: {
        version: 1,
        projectId: PROJECT_ID,
        eventId: 'E1',
        revisionId: crypto.randomUUID(),
        parentRevisionId: acceptedRevisionId,
        sourceHash: hash('source'),
        value: { status: 'blocked' },
      },
    });

    const artifact = await execution.resolveAcceptedArtifact({
      projectId: PROJECT_ID,
      eventId: 'E1',
    });
    expect(artifact?.prose).toBe('E1 accepted prose');
    expect(artifact?.revisionId).toBe(acceptedRevisionId);
  });

  it('applies scene and line feedback with the promoted revision ID', async () => {
    const execution = new MemoryExecutionRepository();
    const manager = new ReviewManager(execution, PROJECT_ID);
    const sceneReview = await manager.addReviewComment(
      {
        target: { type: 'scene', id: 'E1' },
        severity: 'suggestion',
        category: 'style',
        content: 'Tighten scene',
      },
      'reviewer',
    );
    const lineReview = await manager.addReviewComment(
      {
        target: {
          type: 'line',
          id: 'E1',
          lineRange: [1, 1],
          lineBasis: { revisionId: crypto.randomUUID(), proseHash: hash('old prose') },
        },
        severity: 'blocking',
        category: 'plot_logic',
        content: 'Fix line',
      },
      'reviewer',
      undefined,
      1,
    );
    const promotedRevisionId = crypto.randomUUID();

    const applied = await manager.applyComments(
      [sceneReview.id, lineReview.id],
      {
        eventId: 'E1',
        revisionId: promotedRevisionId,
        operationId: crypto.randomUUID(),
        appliedAt: NOW,
      },
      new Set([sceneReview.id, lineReview.id]),
    );

    expect(applied.map((entry) => entry.status)).toEqual(['addressed', 'addressed']);
    expect(applied.map((entry) => entry.applications[0].revisionId)).toEqual([
      promotedRevisionId,
      promotedRevisionId,
    ]);
  });

  it('addresses chapter and novel feedback only for their complete selector scope', async () => {
    const execution = new MemoryExecutionRepository();
    const manager = new ReviewManager(execution, PROJECT_ID);
    const chapterReview = await manager.addReviewComment(
      {
        target: { type: 'chapter', id: 'chapter:1' },
        severity: 'suggestion',
        category: 'pacing',
        content: 'Tighten chapter',
      },
      'reviewer',
    );
    const novelReview = await manager.addReviewComment(
      {
        target: { type: 'novel', id: 'novel' },
        severity: 'suggestion',
        category: 'reader_experience',
        content: 'Tighten novel',
      },
      'reviewer',
    );
    const application = (eventId: string): ReviewApplicationV1 => ({
      eventId,
      revisionId: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      appliedAt: NOW,
    });

    // Incomplete chapter scope: only E1 of chapter:1 has been promoted — the
    // application is recorded but the comment stays open.
    await manager.applyComments([chapterReview.id], application('E1'), new Set());
    let comments = await manager.getComments();
    expect(comments.find((entry) => entry.id === chapterReview.id)?.status).toBe('open');
    expect(comments.find((entry) => entry.id === novelReview.id)?.status).toBe('open');

    // Chapter scope complete (E1 + E2): chapter feedback addressed; the novel
    // feedback is untouched until its all-project scope is covered.
    await manager.applyComments([chapterReview.id], application('E2'), new Set([chapterReview.id]));
    comments = await manager.getComments();
    expect(comments.find((entry) => entry.id === chapterReview.id)?.status).toBe('addressed');
    const novel = comments.find((entry) => entry.id === novelReview.id);
    if (novel === undefined) {
      throw new Error('expected the novel review to remain in the ledger');
    }
    expect(novel.status).toBe('open');
    expect(novel.applications).toEqual([]);

    // Full novel scope promoted (E1 + E2): novel feedback addressed with one
    // application per event.
    await manager.applyComments([novelReview.id], application('E1'), new Set([novelReview.id]));
    await manager.applyComments([novelReview.id], application('E2'), new Set([novelReview.id]));
    comments = await manager.getComments();
    const addressedNovel = comments.find((entry) => entry.id === novelReview.id);
    if (addressedNovel === undefined) {
      throw new Error('expected the addressed novel review in the ledger');
    }
    expect(addressedNovel.status).toBe('addressed');
    expect(addressedNovel.applications.map((entry) => entry.eventId)).toEqual(['E1', 'E2']);
  });

  it('produces identical review ledgers under identical fixed clock and ID services', async () => {
    const NOW = '2026-07-28T00:00:00.000Z';
    const run = async () => {
      const repo = new MemoryExecutionRepository();
      const manager = new ReviewManager(repo, PROJECT_ID, {
        clock: { now: () => NOW },
        ids: { next: () => 'rev_fixed_1' },
      });
      const created = await manager.addReviewComment(
        {
          target: { type: 'scene', id: 'E1' },
          severity: 'suggestion',
          category: 'style',
          content: 'Tighten scene',
        },
        'reviewer',
      );
      const resolved = await manager.updateReviewComment(created.id, 'resolve', 'reviewer');
      return {
        comment: { ...created, applications: created.applications.map((a) => ({ ...a })) },
        resolved: {
          status: resolved.status,
          resolvedAt: resolved.resolvedAt,
          resolvedBy: resolved.resolvedBy,
        },
      };
    };
    expect(await run()).toEqual(await run());
  });

  it('facade review mutations stamp the injected clock and ID services', async () => {
    const now = '2026-07-28T09:30:00.000Z';
    const ids = ['rev_facade_1', 'rev_facade_2'];
    let next = 0;
    const execution = new MemoryExecutionRepository();
    const facadeRuntime = runtime(execution, {
      clock: { now: () => now },
      ids: { next: () => ids[next++] },
    });

    const created = await addReviewComment(
      {
        projectId: PROJECT_ID,
        input: {
          target: { type: 'scene', id: 'E1' },
          severity: 'suggestion',
          category: 'style',
          content: 'Facade comment',
        },
        mutation: { operationId: crypto.randomUUID(), actorId: 'reviewer' },
      },
      facadeRuntime,
    );
    expect(created.id).toBe('rev_facade_1');
    expect(created.createdAt).toBe(now);

    const replacement = await replaceReviewComment(
      {
        projectId: PROJECT_ID,
        commentId: created.id,
        input: {
          target: { type: 'scene', id: 'E1' },
          severity: 'blocking',
          category: 'plot_logic',
          content: 'Facade replacement',
        },
        mutation: { operationId: crypto.randomUUID(), actorId: 'reviewer' },
      },
      facadeRuntime,
    );
    expect(replacement.id).toBe('rev_facade_2');
    expect(replacement.createdAt).toBe(now);
    expect(replacement.supersedesId).toBe(created.id);

    const resolved = await updateReviewComment(
      {
        projectId: PROJECT_ID,
        commentId: replacement.id,
        action: 'resolve',
        mutation: { operationId: crypto.randomUUID(), actorId: 'reviewer' },
      },
      facadeRuntime,
    );
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedAt).toBe(now);

    // The injected identities are exactly what reached the review event
    // stream — no fallback IDs or timestamps leaked in.
    const { events } = await execution.readReviewEvents({ projectId: PROJECT_ID });
    expect(events.map((entry) => entry.kind)).toEqual([
      'comment_added',
      'comment_replaced',
      'comment_status_changed',
    ]);
    expect(events.map((entry) => entry.commentId)).toEqual([
      'rev_facade_1',
      'rev_facade_1',
      'rev_facade_2',
    ]);
    expect(events.every((entry) => entry.createdAt === now)).toBe(true);
  });
});

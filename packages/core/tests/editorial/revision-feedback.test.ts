import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  ProjectTransactionCoordinator,
  resolveProjectPaths,
  SceneRevisionStore,
} from '../../src/editorial/index.ts';
import {
  applyChapterNovelReviews,
  applySceneLineReviews,
  buildEventRevisionStates,
  type EventRevisionState,
} from '../../src/editorial/render-service.ts';
import { ReviewManager } from '../../src/review/manager.ts';
import { computeContentHash } from '../../src/storage/hash.ts';
import { MemoryStorage } from '../../src/storage/memory-storage.ts';
import type {
  AnalysisResult,
  ReviewComment,
  SceneRevisionEnvelopeV1,
  ValidationResult,
} from '../../src/types/index.ts';
import { makeObservations, makeProtocol } from '../fixtures/mock-pass2-helpers.ts';

const PROJECT = '/revision-feedback-project';
const NOW = '2026-07-28T00:00:00.000Z';

function hash(value = crypto.randomUUID()): string {
  return computeContentHash(value);
}
function analysis(eventId: string, prose: string): AnalysisResult {
  const payload: Record<string, unknown> = {
    postconditions: { covered: [], dropped: [] },
    preconditions: { violated: [] },
    pov: { consistent: true, leaks: [] },
    inventedDetails: [],
    quality: {
      proseScore: 8,
      maxScore: 10,
      strengths: ['clear'],
      weaknesses: [],
      estimatedWordCount: 20,
    },
    threadProgressAchieved: [],
    foreshadowingDeployed: [],
    narrativeChecks: [],
    appearanceChecks: [],
    characterReferences: [],
    tenseDetected: 'past',
    conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
    ruleChecks: [],
    knowledgeChecks: [],
  };
  return {
    eventId,
    protocol: makeProtocol(prose),
    observations: makeObservations(payload, prose),
    analysis: payload,
  };
}

function validation(): ValidationResult {
  return { passed: true, errors: [], warnings: [], infos: [] };
}

function envelope(
  eventId: string,
  revisionId: string,
  prose: string,
  status: 'accepted' | 'blocked' = 'accepted',
): SceneRevisionEnvelopeV1 {
  const scopeHash = hash(`scope:${eventId}`);
  const proseHash = computeContentHash(prose);
  return {
    version: 1,
    revisionId,
    parentRevisionId: null,
    operationId: crypto.randomUUID(),
    planHash: hash(),
    actorId: 'editor',
    eventId,
    origin: 'llm_draft',
    prose,
    proseHash,
    sceneHash: proseHash,
    editorialBasisHash: hash(`basis:${eventId}`),
    scopeHash,
    validationIdentity: 'validator-v1',
    modelUsed: 'mock',
    feedbackHash: null,
    reviewIds: [],
    analysis: status === 'accepted' ? analysis(eventId, prose) : null,
    validation: status === 'accepted' ? validation() : null,
    releaseDecision: {
      status,
      scopeHash,
      validationIdentity: 'validator-v1',
      reasons: status === 'accepted' ? [] : ['blocked'],
    },
    released: status === 'accepted',
    cacheHit: false,
    errors: status === 'accepted' ? [] : ['blocked'],
    llmPass1: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    llmPass2:
      status === 'accepted' ? { promptTokens: 1, completionTokens: 1, totalTokens: 2 } : null,
    attempts: 1,
    needsReview: status !== 'accepted',
    promptHash: hash(),
    providerCalls: [],
    promotionReadSet: [],
    requestRecords: [],
    createdAt: NOW,
  };
}

function seedAcceptedHead(
  storage: MemoryStorage,
  eventId: string,
  chapter = 1,
  prose = `${eventId} accepted prose`,
): { envelope: SceneRevisionEnvelopeV1; store: SceneRevisionStore } {
  const paths = resolveProjectPaths(PROJECT);
  const coordinator = new ProjectTransactionCoordinator(storage, paths);
  const store = new SceneRevisionStore(coordinator, paths);
  const accepted = envelope(eventId, crypto.randomUUID(), prose);
  store.archiveAndUpdateLatest(accepted, null);
  storage.write(
    `${paths.scenesDir}/chapter-${String(chapter).padStart(2, '0')}/${eventId}.yaml`,
    YAML.stringify({
      schema_version: 1,
      event: eventId,
      narrative_order: chapter,
      revision_id: accepted.revisionId,
      prose_source: 'llm',
      prose_hash: accepted.proseHash,
      scene_hash: accepted.sceneHash,
      editorial_basis_hash: accepted.editorialBasisHash,
      scope_hash: accepted.scopeHash,
      validation_identity: accepted.validationIdentity,
      model_used: accepted.modelUsed,
      rendered_at: NOW,
      word_count: prose.split(/\s+/).length,
      text_count_version: 1,
      edit_history: [],
      branch_existence: { type: 'all' },
    }),
  );
  return { envelope: accepted, store };
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

function state(eventId: string, reviewIds: readonly string[]): EventRevisionState {
  return {
    eventId,
    state: 'will_revise',
    applicableReviewIds: reviewIds,
    feedbackHashes: [],
    editorialRevisionInstructions: 'feedback: []',
    baseRevisionId: crypto.randomUUID(),
    baseProse: 'base',
    baseProseHash: hash('base'),
  };
}

describe('editorial revision feedback', () => {
  it('orders auto-selected feedback by scope, creation time, and ID', () => {
    const storage = new MemoryStorage();
    seedAcceptedHead(storage, 'E1');
    const reviews = [
      comment(
        'rev_line',
        {
          type: 'line',
          id: 'E1',
          lineRange: [1, 1],
          lineBasis: {
            revisionId: '',
            proseHash: '',
          },
        },
        '2026-07-28T00:04:00.000Z',
      ),
      comment('rev_scene_b', { type: 'scene', id: 'E1' }, '2026-07-28T00:03:00.000Z'),
      comment('rev_novel', { type: 'novel', id: 'novel' }, '2026-07-28T00:05:00.000Z'),
      comment('rev_chapter', { type: 'chapter', id: 'chapter:1' }, '2026-07-28T00:02:00.000Z'),
      comment('rev_scene_a', { type: 'scene', id: 'E1' }, '2026-07-28T00:01:00.000Z'),
    ];
    const accepted = new SceneRevisionStore(
      new ProjectTransactionCoordinator(storage, resolveProjectPaths(PROJECT)),
      resolveProjectPaths(PROJECT),
    ).getLatest('E1')!;
    reviews[0].target.lineBasis = {
      revisionId: accepted.revisionId,
      proseHash: accepted.proseHash,
    };

    const [result] = buildEventRevisionStates(
      ['E1'],
      {},
      reviews,
      storage,
      resolveProjectPaths(PROJECT),
      { E1: 1 },
    );

    expect(result.state).toBe('will_revise');
    expect(result.applicableReviewIds).toEqual([
      'rev_novel',
      'rev_chapter',
      'rev_scene_a',
      'rev_scene_b',
      'rev_line',
    ]);
  });

  it('ignores lifecycle and time in an individual feedback hash', () => {
    const storage = new MemoryStorage();
    seedAcceptedHead(storage, 'E1');
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
    const args = [storage, resolveProjectPaths(PROJECT), { E1: 1 }] as const;
    const first = buildEventRevisionStates(['E1'], {}, [base], ...args)[0];
    const second = buildEventRevisionStates(['E1'], {}, [changedIncidentalFields], ...args)[0];
    expect(second.feedbackHashes).toEqual(first.feedbackHashes);
  });

  it('checks both revision ID and prose hash for line review staleness', () => {
    const storage = new MemoryStorage();
    const { envelope: accepted } = seedAcceptedHead(storage, 'E1');
    const review = comment(
      'rev_line',
      {
        type: 'line',
        id: 'E1',
        lineRange: [1, 1],
        lineBasis: {
          revisionId: crypto.randomUUID(),
          proseHash: accepted.proseHash,
        },
      },
      NOW,
    );

    const [result] = buildEventRevisionStates(
      ['E1'],
      { reviewIds: [review.id] },
      [review],
      storage,
      resolveProjectPaths(PROJECT),
      { E1: 1 },
    );
    expect(result.state).toBe('revision_stale');
  });

  it('uses the materialized accepted head when latest candidate is blocked', () => {
    const storage = new MemoryStorage();
    const { store } = seedAcceptedHead(storage, 'E1');
    const blocked = envelope('E1', crypto.randomUUID(), 'blocked candidate', 'blocked');
    store.archiveAndUpdateLatest(blocked, store.latestHash('E1'));
    const review = comment('rev_scene', { type: 'scene', id: 'E1' }, NOW);

    const [result] = buildEventRevisionStates(
      ['E1'],
      { reviewIds: [review.id] },
      [review],
      storage,
      resolveProjectPaths(PROJECT),
      { E1: 1 },
    );
    expect(result.state).toBe('will_revise');
    expect(result.baseProse).toBe('E1 accepted prose');
  });

  it('distinguishes a current lock from a stale lock', () => {
    const storage = new MemoryStorage();
    const { envelope: accepted } = seedAcceptedHead(storage, 'E1');
    const paths = resolveProjectPaths(PROJECT);
    const review = comment('rev_scene', { type: 'scene', id: 'E1' }, NOW);
    const lockPath = `${paths.workDir}/locks/E1.lock`;
    storage.write(
      lockPath,
      JSON.stringify({
        revisionId: accepted.revisionId,
        proseHash: accepted.proseHash,
        lockedAt: NOW,
        actorId: 'editor',
      }),
    );

    const current = buildEventRevisionStates(
      ['E1'],
      { reviewIds: [review.id] },
      [review],
      storage,
      paths,
      { E1: 1 },
    )[0];
    expect(current.state).toBe('skipped_by_lock');

    storage.write(
      lockPath,
      JSON.stringify({
        revisionId: crypto.randomUUID(),
        proseHash: accepted.proseHash,
        lockedAt: NOW,
        actorId: 'editor',
      }),
    );
    const stale = buildEventRevisionStates(
      ['E1'],
      { reviewIds: [review.id] },
      [review],
      storage,
      paths,
      { E1: 1 },
    )[0];
    expect(stale.state).toBe('lock_stale');
  });

  it('applies scene and line feedback only to newly promoted revision IDs', () => {
    const storage = new MemoryStorage();
    const paths = resolveProjectPaths(PROJECT);
    const manager = new ReviewManager(
      storage,
      new ProjectTransactionCoordinator(storage, paths),
      paths.reviewLedgerPath,
    );
    const sceneReview = manager.addReviewComment(
      {
        target: { type: 'scene', id: 'E1' },
        severity: 'suggestion',
        category: 'style',
        content: 'Tighten scene',
      },
      'reviewer',
    );
    const lineReview = manager.addReviewComment(
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

    applySceneLineReviews(
      new Map([['E1', promotedRevisionId]]),
      [state('E1', [sceneReview.id, lineReview.id])],
      manager,
      crypto.randomUUID(),
    );

    const applied = manager.getComments();
    expect(applied.map((entry) => entry.status)).toEqual(['addressed', 'addressed']);
    expect(applied.map((entry) => entry.applications[0].revisionId)).toEqual([
      promotedRevisionId,
      promotedRevisionId,
    ]);
  });

  it('addresses chapter and novel feedback only for their complete selector scope', () => {
    const storage = new MemoryStorage();
    const paths = resolveProjectPaths(PROJECT);
    const manager = new ReviewManager(
      storage,
      new ProjectTransactionCoordinator(storage, paths),
      paths.reviewLedgerPath,
    );
    const chapterReview = manager.addReviewComment(
      {
        target: { type: 'chapter', id: 'chapter:1' },
        severity: 'suggestion',
        category: 'pacing',
        content: 'Tighten chapter',
      },
      'reviewer',
    );
    const novelReview = manager.addReviewComment(
      {
        target: { type: 'novel', id: 'novel' },
        severity: 'suggestion',
        category: 'reader_experience',
        content: 'Tighten novel',
      },
      'reviewer',
    );
    const states = [
      state('E1', [chapterReview.id, novelReview.id]),
      state('E2', [chapterReview.id, novelReview.id]),
    ];
    const promoted = new Map([
      ['E1', crypto.randomUUID()],
      ['E2', crypto.randomUUID()],
    ]);

    applyChapterNovelReviews(
      promoted,
      states,
      manager,
      crypto.randomUUID(),
      { type: 'chapter', chapter: 1 },
      ['E1', 'E2'],
    );
    let comments = manager.getComments();
    expect(comments.find((entry) => entry.id === chapterReview.id)?.status).toBe('addressed');
    expect(comments.find((entry) => entry.id === novelReview.id)?.status).toBe('open');

    applyChapterNovelReviews(promoted, states, manager, crypto.randomUUID(), { type: 'all' }, [
      'E1',
      'E2',
    ]);
    comments = manager.getComments();
    const novel = comments.find((entry) => entry.id === novelReview.id)!;
    expect(novel.status).toBe('addressed');
    expect(novel.applications.map((application) => application.eventId)).toEqual(['E1', 'E2']);
  });
});

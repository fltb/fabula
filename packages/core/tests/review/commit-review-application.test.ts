// ============================================================================
// commitEditorialCandidates — review application on successful revise
//
// A revision that explicitly names review comments (`request.revision
// .reviewIds`) appends append-only `comment_applied` events for the
// scene/line-scoped comments whose target event was successfully committed.
// Skipped entirely when the operation is stale (accepted-head conflict).
// ============================================================================

import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EditorialCandidateSetV1 } from '../../src/editorial/render-service.ts';
import { commitEditorialCandidates } from '../../src/editorial/render-service.ts';
import { ReviewManager } from '../../src/review/index.ts';
import { buildSourceSnapshot } from '../../src/source/source-identity.ts';
import type {
  EditorialRenderRequestV1,
  SceneRevisionEnvelopeV1,
} from '../../src/types/editorial.ts';
import type { ReviewApplicationV1, ReviewComment } from '../../src/types/index.ts';
import type { ReleaseDecision } from '../../src/types/render-surface.ts';
import { createRuntimeServices, toEditorialRuntime } from '../fixtures/runtime-services.ts';

const PROJECT_ID = 'test-project';
const NOW = '2026-01-01T00:00:00.000Z';
const sha = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

const acceptedDecision: ReleaseDecision = {
  status: 'accepted',
  scopeHash: sha('scope'),
  validationIdentity: 'validators-v1',
  reasons: [],
};

function envelope(eventId: string, revisionId: string): SceneRevisionEnvelopeV1 {
  return {
    version: 1,
    revisionId,
    parentRevisionId: null,
    operationId: 'operation-1',
    planHash: sha('plan'),
    actorId: 'agent',
    eventId,
    origin: 'llm_revision',
    prose: 'Revised prose',
    proseHash: sha('Revised prose'),
    sceneHash: sha('Revised prose'),
    editorialBasisHash: sha('basis'),
    scopeHash: sha('scope'),
    validationIdentity: 'validators-v1',
    feedbackHash: null,
    reviewIds: [],
    analysis: null,
    validation: null,
    releaseDecision: acceptedDecision,
    released: true,
    cacheHit: false,
    errors: [],
    llmPass1: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    llmPass2: null,
    attempts: 1,
    needsReview: false,
    promptHash: sha('prompt'),
    providerCalls: [],
    promotionReadSet: [],
    requestRecords: [],
    createdAt: NOW,
  };
}

function candidateSet(overrides?: Partial<EditorialCandidateSetV1>): EditorialCandidateSetV1 {
  const revisionId = crypto.randomUUID();
  const request: EditorialRenderRequestV1 = {
    version: 1,
    source: buildSourceSnapshot([]),
    mutation: { operationId: 'operation-1', actorId: 'agent' },
  };
  return {
    version: 1,
    operationId: 'operation-1',
    projectId: PROJECT_ID,
    sourceHash: sha('source'),
    request,
    planHash: sha('plan'),
    planSummary: {
      scopeHash: sha('scope'),
      validationIdentity: 'validators-v1',
      totalScenes: 1,
      totalChapters: 1,
      model: 'mock',
      warnings: [],
    },
    selectedEventIds: ['E1'],
    orderedResults: [],
    decisions: new Map([['E1', acceptedDecision]]),
    sceneDispositions: new Map([['E1', 'candidate_promoted']]),
    revisionIds: new Map([['E1', revisionId]]),
    editorialErrors: [],
    commits: [
      {
        eventId: 'E1',
        revisionId,
        envelope: envelope('E1', revisionId),
        expectedVersion: null,
        resultErrors: [],
      },
    ],
    trace: {} as never,
    completedScenes: 1,
    totalScenes: 1,
    ...overrides,
  };
}

function reviewComment(id: string, targetId: string): ReviewComment {
  return {
    id,
    author: 'human',
    actorId: 'reviewer',
    target: { type: 'scene', id: targetId },
    severity: 'suggestion',
    category: 'style',
    content: 'Tighten scene',
    status: 'open',
    applications: [],
    createdAt: NOW,
  };
}

describe('commitEditorialCandidates review application', () => {
  it('appends comment_applied for reviewIds whose scene was committed', async () => {
    const harness = createRuntimeServices({ now: NOW });
    const runtime = toEditorialRuntime(harness);
    const manager = new ReviewManager(harness.execution, PROJECT_ID, {
      clock: harness.clock,
      ids: harness.ids,
    });
    const scene = await manager.addReviewComment(
      {
        target: { type: 'scene', id: 'E1' },
        severity: 'suggestion',
        category: 'style',
        content: 'x',
      },
      'reviewer',
    );
    const otherScene = await manager.addReviewComment(
      {
        target: { type: 'scene', id: 'E2' },
        severity: 'suggestion',
        category: 'style',
        content: 'y',
      },
      'reviewer',
    );

    const set = candidateSet({
      request: {
        version: 1,
        source: buildSourceSnapshot([]),
        mutation: { operationId: 'operation-1', actorId: 'agent' },
        revision: { reviewIds: [scene.id, otherScene.id, 'unknown-id'] },
      },
    });
    const commit = await commitEditorialCandidates(set, runtime);
    expect(commit.stale).toBe(false);

    // E1's comment is addressed; E2 was never committed and unknown ids are
    // ignored.
    const comments = await manager.getComments();
    const addressed = comments.find((entry) => entry.id === scene.id);
    expect(addressed?.status).toBe('addressed');
    expect(addressed?.applications).toHaveLength(1);
    expect(addressed?.applications[0].eventId).toBe('E1');
    expect(addressed?.applications[0].revisionId).toBe(set.revisionIds.get('E1'));
    expect(comments.find((entry) => entry.id === otherScene.id)?.status).toBe('open');

    const { events } = await harness.execution.readReviewEvents({ projectId: PROJECT_ID });
    const applied = events.filter((event) => event.kind === 'comment_applied');
    expect(applied).toHaveLength(1);
    expect(applied[0].commentId).toBe(scene.id);
    expect((applied[0].payload as { addressed: boolean }).addressed).toBe(true);
  });

  it('marks already-open scene comments addressed with their committed revision', async () => {
    const harness = createRuntimeServices({ now: NOW });
    const runtime = toEditorialRuntime(harness);
    const manager = new ReviewManager(harness.execution, PROJECT_ID, {
      clock: harness.clock,
      ids: harness.ids,
    });
    const c1 = await manager.addReviewComment(
      {
        target: { type: 'line', id: 'E1' },
        severity: 'blocking',
        category: 'plot_logic',
        content: 'x',
      },
      'reviewer',
    );

    await commitEditorialCandidates(
      candidateSet({
        request: {
          version: 1,
          source: buildSourceSnapshot([]),
          mutation: { operationId: 'operation-1', actorId: 'agent' },
          revision: { reviewIds: [c1.id] },
        },
      }),
      runtime,
    );

    const loaded = await manager.getComments({ status: 'addressed' });
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(c1.id);
    const application = loaded[0].applications[0] as ReviewApplicationV1;
    expect(application.operationId).toBe('operation-1');
  });

  it('does not apply review comments when the operation is stale', async () => {
    const harness = createRuntimeServices({ now: NOW });
    const runtime = toEditorialRuntime(harness);
    const manager = new ReviewManager(harness.execution, PROJECT_ID, {
      clock: harness.clock,
      ids: harness.ids,
    });
    const scene = await manager.addReviewComment(
      {
        target: { type: 'scene', id: 'E1' },
        severity: 'suggestion',
        category: 'style',
        content: 'x',
      },
      'reviewer',
    );

    // Simulate an accepted-head conflict: the head already moved.
    await harness.execution.compareAndSwapAcceptedScene({
      projectId: PROJECT_ID,
      eventId: 'E1',
      expectedVersion: null,
      value: {
        version: 1,
        projectId: PROJECT_ID,
        eventId: 'E1',
        sourceHash: sha('source'),
        revisionId: 'other-revision',
        prose: 'other',
        proseHash: sha('other'),
        sceneHash: sha('other'),
      },
    });
    const set = candidateSet({
      request: {
        version: 1,
        source: buildSourceSnapshot([]),
        mutation: { operationId: 'operation-1', actorId: 'agent' },
        revision: { reviewIds: [scene.id] },
      },
    });
    const commit = await commitEditorialCandidates(set, runtime);
    expect(commit.stale).toBe(true);

    const comments = await manager.getComments();
    expect(comments.find((entry) => entry.id === scene.id)?.status).toBe('open');
    const { events } = await harness.execution.readReviewEvents({ projectId: PROJECT_ID });
    expect(events.filter((event) => event.kind === 'comment_applied')).toHaveLength(0);
  });

  it('leaves resolved, wontfix and superseded comments untouched', async () => {
    const harness = createRuntimeServices({ now: NOW });
    const runtime = toEditorialRuntime(harness);
    const manager = new ReviewManager(harness.execution, PROJECT_ID, {
      clock: harness.clock,
      ids: harness.ids,
    });
    const resolved = await manager.addReviewComment(
      {
        target: { type: 'scene', id: 'E1' },
        severity: 'suggestion',
        category: 'style',
        content: 'x',
      },
      'reviewer',
    );
    await manager.updateReviewComment(resolved.id, 'resolve', 'reviewer');

    await commitEditorialCandidates(
      candidateSet({
        request: {
          version: 1,
          source: buildSourceSnapshot([]),
          mutation: { operationId: 'operation-1', actorId: 'agent' },
          revision: { reviewIds: [resolved.id] },
        },
      }),
      runtime,
    );

    const comments = await manager.getComments();
    expect(comments.find((entry) => entry.id === resolved.id)?.status).toBe('resolved');
  });
});

// ============================================================================
// SurfaceScheduler — Unit Tests
//
// Covers:
//   §1: Wave building — empty, parallel-only, linear chains
//   §2: Missing predecessor detection
//   §3: Cycle detection
//   §4: Mixed valid + invalid jobs
//   §5: AcceptedArtifactResolver — accepted / missing / blocked artifacts
//   §6: Determinism — same inputs → same waves
// ============================================================================

import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RenderJob } from '../../src/pipeline/render.ts';
import {
  AcceptedArtifactResolver,
  SurfaceScheduler,
} from '../../src/pipeline/surface-scheduler.ts';
import { MemoryExecutionRepository } from '../../src/testing/memory-repositories.ts';
import type { NarrativeEvent } from '../../src/types/event.ts';
import type { ReleaseDecision } from '../../src/types/render-surface.ts';
import type { WorldState } from '../../src/types/world.ts';

// ============================================================================
// Helper factories
// ============================================================================

function makeJob(id: string, predecessorEventId?: string): RenderJob {
  return {
    event: {
      id,
      narrativeOrder: 0,
      preconditions: [],
      postconditions: [],
      threads: [],
      foreshadowing: [],
      relationships: [],
      ruleEffects: [],
    },
    stateBefore: { entities: {}, threads: {}, relationships: {} },
    context: {
      event: {} as unknown as NarrativeEvent,
      stateBefore: {} as unknown as WorldState,
      characters: [],
      scene: { location: '', cast: [], wordCount: 0, timeOfDay: '' },
      activeFactions: [],
      activeKnowledge: [],
      activeThreads: [],
      foreshadowing: [],
      recentEvents: [],
      relationships: [],
      relevanceScores: [],
      rules: [],
      worldFacts: [],
    },
    graphHash: 'a00',
    chapter: 1,
    contract: {
      sceneId: id,
      branch: { decisions: [] },
      discoursePosition: 0,
      worldStateHash: 'a00',
      knowledgeStateHash: 'a00',
      narratorProfileHash: 'a00',
      plannedDiscourseHash: 'a00',
      styleProfile: {
        profileId: 'default',
        resolutionPrecedence: { projectStyle: 'default' },
      },
      continuityPacket: { transition: 'continuous' },
      promptContractHash: 'a00',
    },
    surfaceDependency: {
      groupId: 'default',
      policy: 'parallel' as const,
      manifestHash: 'a00',
      ...(predecessorEventId !== undefined ? { predecessorEventId } : {}),
    },
  };
}

function makeJobs(spec: Array<{ id: string; pred?: string }>): RenderJob[] {
  return spec.map((s) => makeJob(s.id, s.pred));
}

function makeAcceptedDecision(
  scopeHash: string = crypto.createHash('sha256').update('scope01').digest('hex'),
): ReleaseDecision {
  return { status: 'accepted', scopeHash, validationIdentity: 'vi01', reasons: [] };
}

function makeBlockedDecision(scopeHash: string = 'scope01'): ReleaseDecision {
  return { status: 'blocked', scopeHash, validationIdentity: 'vi01', reasons: ['test blocked'] };
}

// ============================================================================
// Tests
// ============================================================================

describe('SurfaceScheduler', () => {
  const scheduler = new SurfaceScheduler();

  // ── §1: Wave building ──────────────────────────────────────────────

  describe('wave building (§1)', () => {
    it('returns empty plan for empty jobs', () => {
      const plan = scheduler.buildWavePlan([]);
      expect(plan.waves).toHaveLength(0);
      expect(plan.missingPredecessors).toHaveLength(0);
      expect(plan.cycleParticipants).toHaveLength(0);
    });

    it('all parallel jobs (no predecessors) form a single wave 0', () => {
      const jobs = makeJobs([{ id: 'S1' }, { id: 'S2' }, { id: 'S3' }]);
      const plan = scheduler.buildWavePlan(jobs);

      expect(plan.waves).toHaveLength(1);
      expect(plan.waves[0].waveIndex).toBe(0);
      expect(plan.waves[0].eventIds.sort()).toEqual(['S1', 'S2', 'S3']);
      expect(plan.missingPredecessors).toHaveLength(0);
      expect(plan.cycleParticipants).toHaveLength(0);
    });

    it('linear chain produces sequential waves', () => {
      const jobs = makeJobs([{ id: 'S1' }, { id: 'S2', pred: 'S1' }, { id: 'S3', pred: 'S2' }]);
      const plan = scheduler.buildWavePlan(jobs);

      expect(plan.waves).toHaveLength(3);
      expect(plan.waves[0].eventIds).toEqual(['S1']);
      expect(plan.waves[1].eventIds).toEqual(['S2']);
      expect(plan.waves[2].eventIds).toEqual(['S3']);
    });

    it('mixed parallel and serial forms correct waves', () => {
      const jobs = makeJobs([
        { id: 'A' },
        { id: 'B' },
        { id: 'C', pred: 'A' },
        { id: 'D', pred: 'B' },
        { id: 'E', pred: 'C' },
      ]);
      const plan = scheduler.buildWavePlan(jobs);

      expect(plan.waves).toHaveLength(3);
      // Wave 0: independent jobs A and B
      expect(plan.waves[0].eventIds.sort()).toEqual(['A', 'B']);
      // Wave 1: dependents of A and B
      expect(plan.waves[1].eventIds.sort()).toEqual(['C', 'D']);
      // Wave 2: dependent of C
      expect(plan.waves[2].eventIds).toEqual(['E']);
    });

    it('excludes jobs with a missing predecessor from executable waves', () => {
      // Pred 'outside' is absent from the selected job set and must fail closed.
      const jobs = makeJobs([{ id: 'S1' }, { id: 'S2', pred: 'outside' }]);
      const plan = scheduler.buildWavePlan(jobs);

      // Only the genuinely predecessor-free job is executable in wave 0.
      expect(plan.waves).toHaveLength(1);
      expect(plan.waves[0].eventIds).toEqual(['S1']);
      expect(plan.missingPredecessors).toEqual([{ eventId: 'S2', predecessorEventId: 'outside' }]);
    });
  });

  // ── §2: Missing predecessor detection ──────────────────────────────

  describe('missing predecessor detection (§2)', () => {
    it('reports missing predecessor and excludes job from waves', () => {
      const jobs = makeJobs([{ id: 'S1' }, { id: 'S2', pred: 'MISSING' }]);
      const plan = scheduler.buildWavePlan(jobs);

      expect(plan.missingPredecessors).toHaveLength(1);
      expect(plan.missingPredecessors[0].eventId).toBe('S2');
      expect(plan.missingPredecessors[0].predecessorEventId).toBe('MISSING');
      // S1 still in wave 0; S2 excluded.
      expect(plan.waves).toHaveLength(1);
      expect(plan.waves[0].eventIds).toEqual(['S1']);
    });

    it('reports multiple missing predecessors', () => {
      const jobs = makeJobs([{ id: 'A', pred: 'X' }, { id: 'B', pred: 'Y' }, { id: 'C' }]);
      const plan = scheduler.buildWavePlan(jobs);

      expect(plan.missingPredecessors).toHaveLength(2);
      const missingIds = plan.missingPredecessors.map((e) => e.eventId).sort();
      expect(missingIds).toEqual(['A', 'B']);
      expect(plan.waves).toHaveLength(1);
      expect(plan.waves[0].eventIds).toEqual(['C']);
    });
  });

  // ── §3: Cycle detection ────────────────────────────────────────────

  describe('cycle detection (§3)', () => {
    it('detects simple two-node cycle', () => {
      const jobs = makeJobs([
        { id: 'A', pred: 'B' },
        { id: 'B', pred: 'A' },
      ]);
      const plan = scheduler.buildWavePlan(jobs);

      expect(plan.cycleParticipants.sort()).toEqual(['A', 'B']);
      expect(plan.waves).toHaveLength(0);
    });

    it('detects three-node cycle', () => {
      const jobs = makeJobs([
        { id: 'A', pred: 'B' },
        { id: 'B', pred: 'C' },
        { id: 'C', pred: 'A' },
      ]);
      const plan = scheduler.buildWavePlan(jobs);

      expect(plan.cycleParticipants.sort()).toEqual(['A', 'B', 'C']);
      expect(plan.waves).toHaveLength(0);
    });

    it('detects self-loop cycle', () => {
      const jobs = makeJobs([{ id: 'A', pred: 'A' }]);
      const plan = scheduler.buildWavePlan(jobs);

      expect(plan.cycleParticipants).toEqual(['A']);
      expect(plan.waves).toHaveLength(0);
    });

    it('non-cycle chain is not flagged', () => {
      const jobs = makeJobs([{ id: 'A' }, { id: 'B', pred: 'A' }, { id: 'C', pred: 'B' }]);
      const plan = scheduler.buildWavePlan(jobs);

      expect(plan.cycleParticipants).toHaveLength(0);
      expect(plan.waves).toHaveLength(3);
    });

    it('cycle does not affect unrelated parallel jobs', () => {
      const jobs = makeJobs([{ id: 'A', pred: 'B' }, { id: 'B', pred: 'A' }, { id: 'C' }]);
      const plan = scheduler.buildWavePlan(jobs);

      expect(plan.cycleParticipants.sort()).toEqual(['A', 'B']);
      expect(plan.waves).toHaveLength(1);
      expect(plan.waves[0].eventIds).toEqual(['C']);
    });
  });

  // ── §4: Mixed scenarios ────────────────────────────────────────────

  describe('mixed scenarios (§4)', () => {
    it('handles missing, cycle, and valid jobs simultaneously', () => {
      const jobs = makeJobs([
        { id: 'A' }, // valid, wave 0
        { id: 'B', pred: 'MISSING' }, // missing predecessor
        { id: 'C', pred: 'D' }, // cycle (C→D→C)
        { id: 'D', pred: 'C' }, // cycle partner
        { id: 'E', pred: 'A' }, // valid, wave 1
      ]);
      const plan = scheduler.buildWavePlan(jobs);

      expect(plan.missingPredecessors).toHaveLength(1);
      expect(plan.missingPredecessors[0].eventId).toBe('B');

      expect(plan.cycleParticipants.sort()).toEqual(['C', 'D']);

      expect(plan.waves).toHaveLength(2);
      expect(plan.waves[0].eventIds).toEqual(['A']);
      expect(plan.waves[1].eventIds).toEqual(['E']);
    });
  });

  // ── §5: Determinism ────────────────────────────────────────────────

  describe('determinism (§6)', () => {
    it('same inputs always produce same waves', () => {
      const jobs = makeJobs([
        { id: 'B' },
        { id: 'A' },
        { id: 'D', pred: 'B' },
        { id: 'C', pred: 'A' },
      ]);

      const plan1 = scheduler.buildWavePlan(jobs);
      const plan2 = scheduler.buildWavePlan(jobs);

      expect(plan1.waves).toEqual(plan2.waves);
      expect(plan1.missingPredecessors).toEqual(plan2.missingPredecessors);
      expect(plan1.cycleParticipants).toEqual(plan2.cycleParticipants);
    });

    it('wave eventIds are deterministically sorted', () => {
      // Input order differs from sorted order.
      const jobs = makeJobs([{ id: 'Z' }, { id: 'Y' }, { id: 'X' }]);
      const plan = scheduler.buildWavePlan(jobs);

      expect(plan.waves).toHaveLength(1);
      // Must be sorted alphabetically, not input order.
      expect(plan.waves[0].eventIds).toEqual(['X', 'Y', 'Z']);
    });
  });
});

// ============================================================================
// AcceptedArtifactResolver — Tests
// ============================================================================

describe('AcceptedArtifactResolver', () => {
  const projectId = 'surface-test-project';
  const sourceHash = crypto.createHash('sha256').update('surface-source').digest('hex');

  const hash = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

  function makeEnvelope(eventId: string, prose: string, decision: ReleaseDecision) {
    const proseHash = hash(prose);
    return {
      version: 1,
      revisionId: crypto.randomUUID(),
      parentRevisionId: null,
      operationId: crypto.randomUUID(),
      planHash: hash('plan'),
      actorId: 'test',
      eventId,
      origin: 'llm_draft',
      prose,
      proseHash,
      sceneHash: hash(`${eventId}:${proseHash}`),
      editorialBasisHash: hash('basis'),
      scopeHash: decision.scopeHash,
      validationIdentity: decision.validationIdentity,
      feedbackHash: null,
      reviewIds: [],
      analysis: null,
      validation: null,
      releaseDecision: decision,
      released: decision.status === 'accepted',
      cacheHit: false,
      errors: [],
      llmPass1: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      llmPass2: null,
      attempts: 0,
      needsReview: false,
      promptHash: hash('prompt'),
      providerCalls: [],
      promotionReadSet: [],
      requestRecords: [],
      createdAt: '2026-08-02T00:00:00.000Z',
    };
  }

  async function seedAcceptedArtifact(
    execution: MemoryExecutionRepository,
    eventId: string,
    prose: string,
    decision: ReleaseDecision,
  ) {
    const envelope = makeEnvelope(eventId, prose, decision);
    await execution.compareAndSwapAcceptedScene({
      projectId,
      eventId,
      expectedVersion: null,
      value: {
        version: 1,
        projectId,
        eventId,
        sourceHash,
        revisionId: envelope.revisionId,
        prose,
        proseHash: envelope.proseHash,
        sceneHash: envelope.sceneHash,
        value: JSON.parse(JSON.stringify(envelope)),
      },
    });
    return envelope;
  }

  it('returns a repository-backed accepted artifact', async () => {
    const execution = new MemoryExecutionRepository();
    const decision = makeAcceptedDecision(hash('scope-s1'));
    await seedAcceptedArtifact(execution, 'S1', 'Once upon a time...', decision);

    const artifact = await new AcceptedArtifactResolver(execution, projectId).resolve('S1');

    expect(artifact).toMatchObject({
      eventId: 'S1',
      prose: 'Once upon a time...',
      releaseDecision: { status: 'accepted' },
      scopeHash: decision.scopeHash,
    });
  });

  it('returns null for missing, blocked, malformed, or scope-mismatched artifacts', async () => {
    const execution = new MemoryExecutionRepository();
    const resolver = new AcceptedArtifactResolver(execution, projectId);
    expect(await resolver.resolve('missing')).toBeNull();

    await seedAcceptedArtifact(
      execution,
      'blocked',
      'Blocked prose',
      makeBlockedDecision(hash('blocked')),
    );
    expect(await resolver.resolve('blocked')).toBeNull();

    await seedAcceptedArtifact(
      execution,
      'malformed',
      'Malformed prose',
      makeAcceptedDecision(hash('malformed')),
    );
    const malformed = await execution.readAcceptedScene({ projectId, eventId: 'malformed' });
    if (malformed === null) throw new Error('missing seeded artifact');
    await execution.compareAndSwapAcceptedScene({
      projectId,
      eventId: 'malformed',
      expectedVersion: malformed.revision,
      value: { ...malformed.value, value: { malformed: true } },
    });
    expect(await resolver.resolve('malformed')).toBeNull();

    await seedAcceptedArtifact(
      execution,
      'scoped',
      'Scoped prose',
      makeAcceptedDecision(hash('scope-a')),
    );
    expect(await resolver.resolve('scoped', hash('scope-b'))).toBeNull();
  });

  it('resolves only accepted artifacts in a batch', async () => {
    const execution = new MemoryExecutionRepository();
    await seedAcceptedArtifact(execution, 'S1', 'S1 prose', makeAcceptedDecision(hash('scope-1')));
    await seedAcceptedArtifact(execution, 'S2', 'S2 prose', makeBlockedDecision(hash('scope-2')));

    const artifacts = await new AcceptedArtifactResolver(execution, projectId).resolveAll([
      'S1',
      'S2',
      'S3',
    ]);

    expect([...artifacts.keys()]).toEqual(['S1']);
    expect(artifacts.get('S1')?.prose).toBe('S1 prose');
  });
});

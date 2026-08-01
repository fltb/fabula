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
import { MemoryStorage } from '../../src/storage/memory-storage.ts';
import type { NarrativeEvent } from '../../src/types/event.ts';
import type { ReleaseDecision } from '../../src/types/render-surface.ts';
import type { WorldState } from '../../src/types/world.ts';
import { makeObservations, makeProtocol } from '../fixtures/mock-pass2-helpers.ts';

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
  const HEAD_DIR = '/project/.nova/work/responses';
  const ARCHIVE_DIR = '/project/.nova/work/revisions/scenes';

  function seedAcceptedArtifact(
    storage: MemoryStorage,
    eventId: string,
    prose: string,
    decision: ReleaseDecision,
    revisionId?: string,
    proseHash?: string,
    headDir?: string,
    archiveDir?: string,
  ): { revisionId: string; proseHash: string } {
    const hd = headDir ?? HEAD_DIR;
    const ad = archiveDir ?? ARCHIVE_DIR;
    const rid = revisionId ?? crypto.randomUUID();
    const ph = proseHash ?? crypto.createHash('sha256').update(prose).digest('hex');
    // Current AnalysisResult contract: eventId + protocol + observations
    // (one produced observation per active field, evidence an exact prose
    // substring) + the dynamic analysis payload. protocol.proseHash is the
    // canonical SHA-256 of the prose, matching the pipeline's construction.
    const analysisPayload: Record<string, unknown> = {
      postconditions: { covered: [], dropped: [] },
      preconditions: { violated: [] },
      pov: { consistent: true, leaks: [] },
      inventedDetails: [],
      quality: {
        proseScore: 4,
        maxScore: 5,
        strengths: [],
        weaknesses: [],
        estimatedWordCount: 1,
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
    const sceneHash = crypto
      .createHash('sha256')
      .update(prose + ph + eventId)
      .digest('hex');

    // Head pointer
    storage.mkdirp(hd);
    storage.write(`${hd}/${eventId}.json`, JSON.stringify({ revisionId: rid, proseHash: ph }));

    // Full archived envelope
    const archiveEventDir = `${ad}/${eventId}`;
    storage.mkdirp(archiveEventDir);
    storage.write(
      `${archiveEventDir}/${rid}.json`,
      JSON.stringify({
        version: 1,
        revisionId: rid,
        parentRevisionId: null,
        operationId: crypto.randomUUID(),
        planHash: crypto.createHash('sha256').update('plan').digest('hex'),
        actorId: 'test',
        eventId,
        origin: 'llm_draft',
        prose,
        proseHash: ph,
        sceneHash,
        editorialBasisHash: crypto.createHash('sha256').update('basis').digest('hex'),
        scopeHash: decision.scopeHash,
        validationIdentity: decision.validationIdentity,
        feedbackHash: null,
        reviewIds: [],
        analysis:
          decision.status === 'accepted'
            ? {
                eventId,
                protocol: makeProtocol(prose),
                observations: makeObservations(analysisPayload, prose),
                analysis: analysisPayload,
              }
            : null,
        validation:
          decision.status === 'accepted'
            ? { passed: true, errors: [], warnings: [], infos: [] }
            : null,
        releaseDecision: decision,
        released: decision.status === 'accepted',
        cacheHit: false,
        errors: [],
        llmPass1: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        llmPass2: null,
        attempts: 0,
        needsReview: false,
        promptHash: crypto.createHash('sha256').update('prompt').digest('hex'),
        providerCalls: [],
        promotionReadSet: [],
        requestRecords: [],
        createdAt: new Date().toISOString(),
      }),
    );

    return { revisionId: rid, proseHash: ph };
  }

  // ── Accepted resolution ────────────────────────────────────────────

  describe('resolve()', () => {
    it('returns artifact for an accepted response', () => {
      const storage = new MemoryStorage();
      const decision = makeAcceptedDecision(
        crypto.createHash('sha256').update('scope_s1').digest('hex'),
      );
      seedAcceptedArtifact(storage, 'S1', 'Once upon a time...', decision);
      const resolver = new AcceptedArtifactResolver(storage, HEAD_DIR, ARCHIVE_DIR);

      const artifact = resolver.resolve('S1');

      expect(artifact).not.toBeNull();
      expect(artifact!.eventId).toBe('S1');
      expect(artifact!.prose).toBe('Once upon a time...');
      expect(artifact!.releaseDecision.status).toBe('accepted');
      expect(artifact!.scopeHash).toBe(decision.scopeHash);
    });

    it('returns null when head pointer file does not exist', () => {
      const storage = new MemoryStorage();
      storage.mkdirp(HEAD_DIR);
      const resolver = new AcceptedArtifactResolver(storage, HEAD_DIR, ARCHIVE_DIR);

      const artifact = resolver.resolve('NONEXISTENT');

      expect(artifact).toBeNull();
    });

    it('returns null when release decision is not accepted', () => {
      const storage = new MemoryStorage();
      const decision = makeBlockedDecision(
        crypto.createHash('sha256').update('scope01').digest('hex'),
      );
      seedAcceptedArtifact(storage, 'S1', 'Some prose', decision);
      const resolver = new AcceptedArtifactResolver(storage, HEAD_DIR, ARCHIVE_DIR);

      const artifact = resolver.resolve('S1');

      expect(artifact).toBeNull();
    });

    it('returns null when release decision is pending_waiver', () => {
      const storage = new MemoryStorage();
      const pendingDecision: ReleaseDecision = {
        status: 'pending_waiver',
        scopeHash: crypto.createHash('sha256').update('scope01').digest('hex'),
        validationIdentity: 'vi01',
        reasons: ['warnings not waived'],
      };
      seedAcceptedArtifact(storage, 'S1', 'Some prose', pendingDecision);
      const resolver = new AcceptedArtifactResolver(storage, HEAD_DIR, ARCHIVE_DIR);

      const artifact = resolver.resolve('S1');

      expect(artifact).toBeNull();
    });

    it('returns null for malformed JSON in head pointer', () => {
      const storage = new MemoryStorage();
      storage.mkdirp(HEAD_DIR);
      storage.write(`${HEAD_DIR}/S1.json`, 'not-json-at-all');
      const resolver = new AcceptedArtifactResolver(storage, HEAD_DIR, ARCHIVE_DIR);

      const artifact = resolver.resolve('S1');

      expect(artifact).toBeNull();
    });

    it('returns null when head pointer lacks revisionId/proseHash (no backward compat)', () => {
      const storage = new MemoryStorage();
      storage.mkdirp(HEAD_DIR);
      const decision = makeAcceptedDecision(
        crypto.createHash('sha256').update('scope01').digest('hex'),
      );
      storage.write(
        `${HEAD_DIR}/S1.json`,
        JSON.stringify({
          prose: 'Inline prose without revision pointer',
          releaseDecision: decision,
        }),
      );
      const resolver = new AcceptedArtifactResolver(storage, HEAD_DIR, ARCHIVE_DIR);

      const artifact = resolver.resolve('S1');

      expect(artifact).toBeNull();
    });
  });

  // ── Batch resolve ──────────────────────────────────────────────────

  describe('resolveAll()', () => {
    it('returns only accepted artifacts from a set', () => {
      const storage = new MemoryStorage();
      const acceptedDecision = makeAcceptedDecision(
        crypto.createHash('sha256').update('scope01').digest('hex'),
      );
      const blockedDecision = makeBlockedDecision(
        crypto.createHash('sha256').update('scope02').digest('hex'),
      );

      // S1 — accepted
      seedAcceptedArtifact(storage, 'S1', 'S1 prose', acceptedDecision);
      // S2 — blocked
      seedAcceptedArtifact(storage, 'S2', 'S2 prose', blockedDecision);
      // S3 — missing, no write

      const resolver = new AcceptedArtifactResolver(storage, HEAD_DIR, ARCHIVE_DIR);
      const results = resolver.resolveAll(['S1', 'S2', 'S3']);

      expect(results.size).toBe(1);
      expect(results.has('S1')).toBe(true);
      expect(results.get('S1')!.prose).toBe('S1 prose');
      expect(results.has('S2')).toBe(false);
      expect(results.has('S3')).toBe(false);
    });
  });

  // ── Storage independence ───────────────────────────────────────────

  it('works with any Storage backend (MemoryStorage)', () => {
    const storage = new MemoryStorage();
    const HEAD2 = '/proj/.nova/work/responses';
    const ARCHIVE2 = '/proj/.nova/work/revisions/scenes';
    const decision = makeAcceptedDecision();
    seedAcceptedArtifact(storage, 'E1', 'E1 text', decision, undefined, undefined, HEAD2, ARCHIVE2);

    const resolver = new AcceptedArtifactResolver(storage, HEAD2, ARCHIVE2);
    const artifact = resolver.resolve('E1');

    expect(artifact).not.toBeNull();
    expect(artifact!.eventId).toBe('E1');
    expect(artifact!.prose).toBe('E1 text');
  });
});

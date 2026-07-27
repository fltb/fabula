// ============================================================================
// Dynamic Schema Path — Tests for getCombinedValidationSchema()
// ============================================================================
//
// When a ResultAggregator is provided to the RenderPipeline, Pass 2 analysis
// JSON is validated against the dynamic schema built from all validator
// getAnalysisRequirements() declarations. This schema requires all 14 analysis
// blocks (no .optional() wrappers).
//
// Track 4B (P2): Cover the dynamic schema path and verify missing blocks
// produce rejection.
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { MockPass2Entry } from '../../src/ai/providers/mock-pass2.ts';
import { MockPass2Provider } from '../../src/ai/providers/mock-pass2.ts';
import { RenderPipeline } from '../../src/pipeline/render.ts';
import { MemoryStorage } from '../../src/storage/memory-storage.ts';
import type {
  AnalysisResult,
  ContextPackage,
  KnowledgeBoundary,
  NarrativeEvent,
  RenderJob,
  SceneSpecification,
  SystemContext,
  WorldState,
} from '../../src/types/index.ts';
import { ResultAggregator } from '../../src/validator/aggregator.ts';
import { makeAnalysisResult } from '../fixtures/mock-pass2-helpers.ts';

// ============================================================================
// Test fixtures
// ============================================================================

function makeEvent(id: string): NarrativeEvent {
  return {
    id,
    event: 'Test event',
    narrativeOrder: 1,
    title: 'Test',
    storyTime: { type: 'absolute' as const, value: 'start' },
    sceneType: 'linear',
    pov: { character: 'entity_1', type: 'third_person_limited' },
    sceneBrief: 'A test scene.',
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'genesis',
    branchExistence: { type: 'all' as const },
    participants: { entities: ['entity_1'] },
    styleGuidance: undefined,
  };
}

function makeContext(eventId: string): ContextPackage {
  return {
    eventId,
    systemContext: {
      genre: 'literary',
      style: 'neutral',
      narrativeRules: [],
    } satisfies SystemContext,
    sceneSpec: {
      goal: 'Advance plot',
      povType: 'third_person',
      povCharacter: 'narrator',
      conflict: 'none',
      expectedOutcome: 'Scene rendered',
    } satisfies SceneSpecification,
    characterSnapshots: [],
    relationshipContext: [],
    worldFacts: [],
    knowledgeBoundary: {
      entityId: 'narrator',
      knownFacts: [],
      restrictedEntities: [],
    } satisfies KnowledgeBoundary,
    activeThreads: [],
    previousSceneSummary: '',
    markdown: '',
  };
}

function makeJob(id: string): RenderJob {
  return {
    event: makeEvent(id),
    stateBefore: {
      entities: {},
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    },
    context: makeContext(id),
    chapter: 1,
  };
}

/**
 * Build a pipeline with a ResultAggregator and MockPass2Provider.
 */
function buildPipeline(entry: MockPass2Entry, maxRetries = 1): RenderPipeline {
  const provider = new MockPass2Provider({ entries: { test: entry } });
  const aggregator = new ResultAggregator();
  return new RenderPipeline({
    provider,
    model: 'mock-pass2',
    cacheDir: '/tmp/test-cache',
    storage: new MemoryStorage(),
    skipCache: true,
    maxRetries,
    aggregator,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('dynamic schema path', () => {
  it('validates all 14 analysis blocks when aggregator is present', async () => {
    const entry = makeAnalysisResult('test');
    const pipeline = buildPipeline(entry, 1);
    const result = await pipeline.renderScene(makeJob('test'));

    expect(result.analysis).not.toBeNull();
    const a = result.analysis!.analysis;

    // 1. postconditions
    expect(a).toHaveProperty('postconditions');
    expect(a['postconditions']).toEqual({ covered: [], dropped: [] });

    // 2. preconditions
    expect(a).toHaveProperty('preconditions');
    expect(a['preconditions']).toEqual({ violated: [] });

    // 3. pov
    expect(a).toHaveProperty('pov');
    expect(a['pov']).toMatchObject({ consistent: true });

    // 4. inventedDetails
    expect(a).toHaveProperty('inventedDetails');

    // 5. quality
    expect(a).toHaveProperty('quality');
    expect(a['quality']).toHaveProperty('proseScore');

    // 6. threadProgressAchieved
    expect(a).toHaveProperty('threadProgressAchieved');

    // 7. foreshadowingDeployed
    expect(a).toHaveProperty('foreshadowingDeployed');

    // 8. narrativeChecks
    expect(a).toHaveProperty('narrativeChecks');

    // 9. appearanceChecks
    expect(a).toHaveProperty('appearanceChecks');

    // 10. characterReferences
    expect(a).toHaveProperty('characterReferences');

    // 11. tenseDetected
    expect(a).toHaveProperty('tenseDetected');
    expect(a['tenseDetected']).toBe('past');

    // 12. conflictAnalysis
    expect(a).toHaveProperty('conflictAnalysis');

    // 13. ruleChecks
    expect(a).toHaveProperty('ruleChecks');

    // 14. knowledgeChecks
    expect(a).toHaveProperty('knowledgeChecks');

    // No pass2 rejection
    expect(result.pass2Rejection).toBeUndefined();
    expect(result.needsReview).toBe(false);
  });

  it('rejects analysis missing a required block (tenseDetected)', async () => {
    // Build analysis with all 14 blocks except tenseDetected
    const missingBlock: AnalysisResult = {
      eventId: 'test',
      analysis: {
        postconditions: { covered: [], dropped: [] },
        preconditions: { violated: [] },
        pov: { consistent: true, leaks: [] },
        inventedDetails: [],
        quality: {
          proseScore: 3,
          maxScore: 5,
          strengths: [],
          weaknesses: [],
          estimatedWordCount: 50,
        },
        threadProgressAchieved: [],
        foreshadowingDeployed: [],
        narrativeChecks: [],
        appearanceChecks: [],
        characterReferences: [],
        // tenseDetected is intentionally missing
        conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
        ruleChecks: [],
        knowledgeChecks: [],
      },
    };

    const entry: MockPass2Entry = {
      prose: 'Test prose for missing block scenario.',
      analysis: missingBlock,
    };

    // Use 0 retries so the first failure is terminal
    const pipeline = buildPipeline(entry, 0);
    const result = await pipeline.renderScene(makeJob('test'));

    expect(result.analysis).toBeNull();
    expect(result.pass2Rejection).toBe('validation');
    expect(result.errors.some((e) => e.includes('schema validation'))).toBe(true);
    expect(result.needsReview).toBe(true);
  });

  it('rejects analysis missing a required block (conflictAnalysis)', async () => {
    const missingBlock: AnalysisResult = {
      eventId: 'test',
      analysis: {
        postconditions: { covered: [], dropped: [] },
        preconditions: { violated: [] },
        pov: { consistent: true, leaks: [] },
        inventedDetails: [],
        quality: {
          proseScore: 3,
          maxScore: 5,
          strengths: [],
          weaknesses: [],
          estimatedWordCount: 50,
        },
        threadProgressAchieved: [],
        foreshadowingDeployed: [],
        narrativeChecks: [],
        appearanceChecks: [],
        characterReferences: [],
        tenseDetected: 'past',
        // conflictAnalysis is intentionally missing
        ruleChecks: [],
        knowledgeChecks: [],
      },
    };

    const entry: MockPass2Entry = {
      prose: 'Test prose for missing conflictAnalysis.',
      analysis: missingBlock,
    };

    const pipeline = buildPipeline(entry, 0);
    const result = await pipeline.renderScene(makeJob('test'));

    expect(result.analysis).toBeNull();
    expect(result.pass2Rejection).toBe('validation');
    expect(result.needsReview).toBe(true);
  });

  it('rejects analysis missing a required block (ruleChecks)', async () => {
    const missingBlock: AnalysisResult = {
      eventId: 'test',
      analysis: {
        postconditions: { covered: [], dropped: [] },
        preconditions: { violated: [] },
        pov: { consistent: true, leaks: [] },
        inventedDetails: [],
        quality: {
          proseScore: 3,
          maxScore: 5,
          strengths: [],
          weaknesses: [],
          estimatedWordCount: 50,
        },
        threadProgressAchieved: [],
        foreshadowingDeployed: [],
        narrativeChecks: [],
        appearanceChecks: [],
        characterReferences: [],
        tenseDetected: 'past',
        conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
        // ruleChecks is intentionally missing
        knowledgeChecks: [],
      },
    };

    const entry: MockPass2Entry = {
      prose: 'Test prose for missing ruleChecks.',
      analysis: missingBlock,
    };

    const pipeline = buildPipeline(entry, 0);
    const result = await pipeline.renderScene(makeJob('test'));

    expect(result.analysis).toBeNull();
    expect(result.pass2Rejection).toBe('validation');
    expect(result.needsReview).toBe(true);
  });

  it('rejects analysis missing a required block (knowledgeChecks)', async () => {
    const missingBlock: AnalysisResult = {
      eventId: 'test',
      analysis: {
        postconditions: { covered: [], dropped: [] },
        preconditions: { violated: [] },
        pov: { consistent: true, leaks: [] },
        inventedDetails: [],
        quality: {
          proseScore: 3,
          maxScore: 5,
          strengths: [],
          weaknesses: [],
          estimatedWordCount: 50,
        },
        threadProgressAchieved: [],
        foreshadowingDeployed: [],
        narrativeChecks: [],
        appearanceChecks: [],
        characterReferences: [],
        tenseDetected: 'past',
        conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
        ruleChecks: [],
        // knowledgeChecks is intentionally missing
      },
    };

    const entry: MockPass2Entry = {
      prose: 'Test prose for missing knowledgeChecks.',
      analysis: missingBlock,
    };

    const pipeline = buildPipeline(entry, 0);
    const result = await pipeline.renderScene(makeJob('test'));

    expect(result.analysis).toBeNull();
    expect(result.pass2Rejection).toBe('validation');
    expect(result.needsReview).toBe(true);
  });

  it('getCombinedValidationSchema includes all analysis fields', () => {
    const aggregator = new ResultAggregator();
    const schema = aggregator.getCombinedValidationSchema();
    const keys = Object.keys(schema.shape);

    // All 14 original fields must be present
    expect(keys).toContain('postconditions');
    expect(keys).toContain('preconditions');
    expect(keys).toContain('pov');
    expect(keys).toContain('inventedDetails');
    expect(keys).toContain('quality');
    expect(keys).toContain('threadProgressAchieved');
    expect(keys).toContain('foreshadowingDeployed');
    expect(keys).toContain('narrativeChecks');
    expect(keys).toContain('appearanceChecks');
    expect(keys).toContain('characterReferences');
    expect(keys).toContain('tenseDetected');
    expect(keys).toContain('conflictAnalysis');
    expect(keys).toContain('ruleChecks');
    expect(keys).toContain('knowledgeChecks');
    // S6 Genette dimension fields (optional — reference data predates them)
    expect(keys).toContain('durationDetected');
    expect(keys).toContain('frequencyDetected');
    expect(keys).toContain('voiceDetected');
    expect(keys).toContain('anachronyDetected');
    expect(keys).toContain('focalizationDetected');

    // The original 14 blocks stay strictly required; only the S6 dimension
    // blocks are optional (pre-existing mock reference data lacks them).
    const OPTIONAL_KEYS: Record<string, true> = {
      durationDetected: true,
      frequencyDetected: true,
      voiceDetected: true,
      anachronyDetected: true,
      focalizationDetected: true,
    };
    for (const key of keys) {
      const fieldSchema = schema.shape[key];
      expect(fieldSchema.isOptional?.()).toBe(OPTIONAL_KEYS[key] === true);
    }
  });
});

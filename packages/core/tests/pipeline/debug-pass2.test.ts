import { describe, it, expect } from 'vitest';
import { RenderPipeline } from '../../src/pipeline/render.ts';
import type { RenderJob, Pass2RejectionCategory } from '../../src/pipeline/render.ts';
import { MockProvider } from '../../src/ai/providers/mock.ts';
import type { MockProviderOptions } from '../../src/ai/providers/mock.ts';
import { MemoryStorage } from '../../src/storage/memory-storage.ts';
import type { NarrativeEvent, WorldState, ContextPackage, SystemContext, SceneSpecification, KnowledgeBoundary } from '../../src/types/index.ts';
import { MockPass2Provider } from '../../src/ai/providers/mock-pass2.ts';
import { ResultAggregator } from '../../src/validator/aggregator.ts';
import { makeAnalysisResult } from '../fixtures/mock-pass2-helpers.ts';

const VALID_ANALYSIS_JSON = JSON.stringify({
  eventId: 'evt_test', analysis: {
    postconditions: { covered: [], dropped: [] }, preconditions: { violated: [] },
    pov: { consistent: true, leaks: [] }, inventedDetails: [],
    quality: { proseScore: 80, maxScore: 100, strengths: [], weaknesses: [], estimatedWordCount: 300 },
    threadProgressAchieved: [], foreshadowingDeployed: [],
    narrativeChecks: [], appearanceChecks: [], characterReferences: [],
    tenseDetected: 'past', conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
    ruleChecks: [], knowledgeChecks: [],
  },
});

function makeEvent(id: string): NarrativeEvent { return {
  id, event: 'Test event', narrativeOrder: 1, title: 'Test',
  storyTime: { type: 'absolute' as const, value: 'start' }, sceneType: 'linear',
  pov: { perspective: 'neutral', entityId: 'entity_1' as const }, sceneBrief: 'A test scene.',
  preconditions: [], postconditions: [], threadProgress: [], foreshadowing: [],
  relationshipEffects: [], ruleEffects: [], source: 'genesis',
  branchExistence: { type: 'all' as const }, participants: { entities: ['entity_1'] },
}; }

function makeContext(eventId: string): ContextPackage { return {
  eventId, systemContext: { genre: 'literary', style: 'neutral', narrativeRules: [] } satisfies SystemContext,
  sceneSpec: { goal: 'Advance plot', povType: 'third_person', povCharacter: 'narrator', conflict: 'none', expectedOutcome: 'Scene rendered' } satisfies SceneSpecification,
  characterSnapshots: [], relationshipContext: [], worldFacts: [],
  knowledgeBoundary: { entityId: 'narrator', knownFacts: [], restrictedEntities: [] } satisfies KnowledgeBoundary,
  activeThreads: [], previousSceneSummary: '', markdown: '',
}; }

function makeJob(id: string): RenderJob {
  return { event: makeEvent(id), stateBefore: { entities: {}, relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [] }, context: makeContext(id), chapter: 1 };
}

function makePipeline(opts: MockProviderOptions = {}) {
  const provider = new MockProvider(opts);
  return { pipeline: new RenderPipeline({ provider, model: 'mock-model', cacheDir: '/tmp/test-cache', storage: new MemoryStorage(), skipCache: true, maxRetries: 3 }), provider };
}

/**
 * Build a pipeline WITH a ResultAggregator so getCombinedValidationSchema()
 * is exercised, using MockPass2Provider for predictable Pass 2 analysis.
 */
function makePipelineWithAggregator(entry: MockPass2Entry) {
  const provider = new MockPass2Provider({ entries: { test: entry } });
  const aggregator = new ResultAggregator();
  return new RenderPipeline({
    provider,
    model: 'mock-pass2',
    cacheDir: '/tmp/test-cache',
    storage: new MemoryStorage(),
    skipCache: true,
    maxRetries: 1,
    aggregator,
  });
}

describe('dynamic schema path with aggregator', () => {
  it('parses analysis with dynamic schema from aggregator', async () => {
    const entry = makeAnalysisResult('test');
    const pipeline = makePipelineWithAggregator(entry);
    const result = await pipeline.renderScene(makeJob('test'));

    expect(result.analysis).not.toBeNull();
    expect(result.analysis!.eventId).toBe('test');
    // All 14 blocks should be present in the parsed analysis
    const a = result.analysis!.analysis;
    expect(a).toHaveProperty('postconditions');
    expect(a).toHaveProperty('preconditions');
    expect(a).toHaveProperty('pov');
    expect(a).toHaveProperty('inventedDetails');
    expect(a).toHaveProperty('quality');
    expect(a).toHaveProperty('threadProgressAchieved');
    expect(a).toHaveProperty('foreshadowingDeployed');
    expect(a).toHaveProperty('narrativeChecks');
    expect(a).toHaveProperty('appearanceChecks');
    expect(a).toHaveProperty('characterReferences');
    expect(a).toHaveProperty('tenseDetected');
    expect(a).toHaveProperty('conflictAnalysis');
    expect(a).toHaveProperty('ruleChecks');
    expect(a).toHaveProperty('knowledgeChecks');
    // Schema validation passed — no pass2 rejection
    expect(result.pass2Rejection).toBeUndefined();
  });
});

describe('debug pass2 rejection field', () => {
  it('generator returning empty', async () => {
    const { pipeline } = makePipeline({
      generator: (req) => {
        if (req.responseFormat?.type === 'json_object') return '';
        return 'Some prose for Pass 1.';
      },
    });
    const result = await pipeline.renderScene(makeJob('evt_empty_p2'));
    console.error('PASS2_REJECTION:', result.pass2Rejection);
    console.error('ERRORS:', JSON.stringify(result.errors));
    console.error('ANALYSIS:', result.analysis);
    console.error('KEYS:', Object.keys(result));
    expect(result.analysis).toBeNull();
    expect(result.pass2Rejection).toBe('empty');
  });

  it('responses with empty string', async () => {
    const { pipeline } = makePipeline({
      responses: ['Some prose.', '', '', '', ''],
    });
    const result = await pipeline.renderScene(makeJob('evt_empty_r2'));
    console.error('PASS2_REJECTION:', result.pass2Rejection);
    console.error('ERRORS:', JSON.stringify(result.errors));
    expect(result.pass2Rejection).toBe('empty');
  });
});

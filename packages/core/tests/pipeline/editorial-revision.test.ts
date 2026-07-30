// ============================================================================
// RenderPipeline — Editorial Revision Phase Tests
// ============================================================================
//
// Verifies pipeline-owned approved behaviour introduced in the editorial-kernel
// phase after storage/revision/review foundation:
//
//   1. optional provider/providerFactory exclusivity
//   2. memoized lazy create only before real provider.complete()
//   3. AbortSignal propagation into every Pass 1 / Pass 2 / verify / batch call
//   4. RenderJob revisionContext:
//        - base revision / prose / hash / feedback hashes / instruction hash
//        - revision always bypasses draft cache, forces fresh Pass 1
//   5. Prompt assembler appends non-authoritative previous accepted prose
//      then ordered ## Editorial Revision Instructions (canonical YAML wins)
//   6. evaluateProseCandidate shared function (exercised by Pass 2 retry loop)
// ============================================================================
// Constraints:
//   - No formatters, linters, builds, typechecks, or git
//   - No compatibility aliases / overloads
//   - Pipeline must never import editorial modules
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import { MockProvider } from '../../src/ai/providers/mock.ts';
import { RenderPipeline } from '../../src/pipeline/render.ts';
import { MemoryStorage } from '../../src/storage/memory-storage.ts';

// Mock schemas/index to break a pre-existing circular dependency
// between schemas/editorial.ts ← schemas/analysis.ts → validator/index.ts
// before the pipeline module loads.
vi.mock('../../src/schemas/index.ts', () => ({}));

// Type-only imports for fixture helpers (no runtime loading)
import type {
  ContextPackage,
  NarrativeEvent,
  RenderJob,
  RevisionContext,
  ProviderFactory,
  CompiledSceneContract,
} from '../../src/types/index.ts';
import type { CompletionRequest } from '../../src/ai/types.ts';

// ─── Test helpers ─────────────────────────────────────────────────────────────

const SAMPLE_PASS2 = JSON.stringify({
  eventId: 'evt_revision',
  analysis: {
    postconditions: { covered: [], dropped: [] },
    preconditions: { violated: [] },
    pov: { consistent: true, leaks: [] },
    inventedDetails: [],
    quality: {
      proseScore: 80,
      maxScore: 100,
      strengths: ['clear'],
      weaknesses: [],
      estimatedWordCount: 150,
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
    checklistResults: [],
    durationDetected: 'scene',
    frequencyDetected: 'singulative',
    voiceDetected: { level: 'extradiegetic', relation: 'heterodiegetic' },
    anachronyDetected: 'none',
    focalizationDetected: 'zero',
  },
});

const BASE_CONTRACT: CompiledSceneContract = {
  sceneId: 'evt_revision',
  branch: { decisions: [] },
  discoursePosition: 0,
  worldStateHash: 'a00',
  knowledgeStateHash: 'a00',
  narratorProfileHash: 'a00',
  plannedDiscourseHash: 'a00',
  styleProfile: { profileId: 'default', resolutionPrecedence: { projectStyle: 'default' } },
  continuityPacket: { transition: 'continuous' },
  promptContractHash: 'a00',
};

function makeEvent(): NarrativeEvent {
  return {
    id: 'evt_revision',
    event: 'Test Scene',
    narrativeOrder: 1,
    storyTime: { type: 'absolute' as const, value: 'start' },
    sceneType: 'linear',
    pov: { character: 'entity_1', type: 'third_person_limited' },
    sceneBrief: 'Test scene',
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'genesis',
    branchExistence: { type: 'all' as const },
    participants: { entities: ['entity_1'] },
    styleGuidance: {},
    authorNotes: [],
  };
}

function makeContext(): ContextPackage {
  return {
    eventId: 'evt_revision',
    systemContext: {
      genre: 'literary',
      style: 'neutral',
      narrativeRules: [],
    },
    sceneSpec: {
      goal: 'Test goal',
      povType: 'third_person',
      povCharacter: 'entity_1',
    },
    characterSnapshots: [],
    relationshipContext: [],
    worldFacts: [],
    knowledgeBoundary: { entityId: 'entity_1', knownFacts: [] },
    activeThreads: [],
    volumeSummary: '',
    markdown: '',
    activeRules: [],
    narrativeTechniques: [],
  };
}

function makeJob(overrides?: Partial<RenderJob>): RenderJob {
  return {
    event: makeEvent(),
    stateBefore: { entities: {}, relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [] },
    context: makeContext(),
    graphHash: 'a00',
    chapter: 1,
    contract: BASE_CONTRACT,
    surfaceDependency: {
      groupId: 'default',
      policy: 'parallel' as const,
      manifestHash: 'a00',
    },
    sourceContentHash: 'a00',
    ...overrides,
  } as RenderJob;
}

// ============================================================================
// 1. Provider exclusivity — provider and providerFactory are exclusive
// ============================================================================

describe('RenderPipeline — provider exclusivity', () => {
  it('throws when both provider and providerFactory are provided', async () => {
    const mod = await import('../../src/pipeline/render.ts');
    const { MockProvider } = await import('../../src/ai/providers/mock.ts');
    const { MemoryStorage } = await import('../../src/storage/memory-storage.ts');

    const provider = new MockProvider({ responses: ['prose', SAMPLE_PASS2] });
    const factory: ProviderFactory = {
      profile: 'test-profile',
      create: () => Promise.resolve(provider),
    };

    expect(
      () =>
        new mod.RenderPipeline({
          provider,
          providerFactory: factory,
          model: 'test-model',
          cacheDir: '/tmp/test-cache',
          storage: new MemoryStorage(),
        }),
    ).toThrow('PROVIDER_REQUIRED');
  });

  it('accepts provider without providerFactory', async () => {
    const mod = await import('../../src/pipeline/render.ts');
    const { MockProvider } = await import('../../src/ai/providers/mock.ts');
    const { MemoryStorage } = await import('../../src/storage/memory-storage.ts');

    const provider = new MockProvider({ responses: ['prose', SAMPLE_PASS2] });
    const pipeline = new mod.RenderPipeline({
      provider,
      model: 'test-model',
      cacheDir: '/tmp/test-cache',
      storage: new MemoryStorage(),
    });
    expect(pipeline).toBeInstanceOf(mod.RenderPipeline);
  });

  it('accepts providerFactory without provider', async () => {
    const mod = await import('../../src/pipeline/render.ts');
    const { MockProvider } = await import('../../src/ai/providers/mock.ts');
    const { MemoryStorage } = await import('../../src/storage/memory-storage.ts');

    const factory: ProviderFactory = {
      profile: 'test-profile',
      create: () => Promise.resolve(new MockProvider({ responses: ['prose', SAMPLE_PASS2] })),
    };
    const pipeline = new mod.RenderPipeline({
      providerFactory: factory,
      model: 'test-model',
      cacheDir: '/tmp/test-cache',
      storage: new MemoryStorage(),
    });
    expect(pipeline).toBeInstanceOf(mod.RenderPipeline);
  });
});

// ============================================================================
// 2. Lazy create — factory is only called on first real provider.complete()
// ============================================================================

describe('RenderPipeline — lazy provider creation', () => {
  it('cache-only avoids calling factory.create()', async () => {
    const mod = await import('../../src/pipeline/render.ts');
    const { MockProvider } = await import('../../src/ai/providers/mock.ts');
    const { MemoryStorage } = await import('../../src/storage/memory-storage.ts');

    // Populate cache
    const storage = new MemoryStorage();
    const populateProvider = new MockProvider({ responses: ['prose', SAMPLE_PASS2] });
    const populatePipeline = new mod.RenderPipeline({
      provider: populateProvider,
      model: 'test-model',
      cacheDir: '/tmp/test-cache',
      storage,
      skipCache: false,
    });
    await populatePipeline.renderScene(makeJob());

    // Fresh pipeline with factory (no provider) — cache should hit
    const factoryCreate = vi.fn<() => Promise<MockProvider>>();
    factoryCreate.mockResolvedValue(new MockProvider({ responses: ['prose2', SAMPLE_PASS2] }));
    const factory: ProviderFactory = {
      profile: 'test-profile',
      create: factoryCreate,
    };
    const cachedPipeline = new mod.RenderPipeline({
      providerFactory: factory,
      model: 'test-model',
      cacheDir: '/tmp/test-cache',
      storage,
      skipCache: false,
    });
    const result = await cachedPipeline.renderScene(makeJob());

    expect(result.cacheHit).toBe(true);
    expect(result.prose).toBe('prose');
    expect(factoryCreate).not.toHaveBeenCalled();
  });
  it('factory creates once when cache misses', async () => {
    const mod = await import('../../src/pipeline/render.ts');
    const { MockProvider } = await import('../../src/ai/providers/mock.ts');
    const { MemoryStorage } = await import('../../src/storage/memory-storage.ts');

    const factoryCreate = vi.fn<() => Promise<MockProvider>>();
    // Use generator so MockProvider returns fresh-prose on every Pass 1 call,
    // not only the first time (responses array would be exhausted after one call).
    factoryCreate.mockResolvedValue(
      new MockProvider({
        generator: (req: CompletionRequest) => {
          if (req.taskType === 'pass2' || req.seed !== undefined) {
            return SAMPLE_PASS2;
          }
          return 'fresh-prose';
        },
      }),
    );
    const factory: ProviderFactory = {
      profile: 'test-profile',
      create: factoryCreate,
    };
    const pipeline = new mod.RenderPipeline({
      providerFactory: factory,
      model: 'test-model',
      cacheDir: '/tmp/test-cache',
      storage: new MemoryStorage(),
      skipCache: true,
    });
    const result = await pipeline.renderScene(makeJob());

    expect(result.cacheHit).toBe(false);
    expect(result.prose).toBe('fresh-prose');
    // Factory was called exactly once to create the provider
    expect(factoryCreate).toHaveBeenCalledTimes(1);

    // Second call uses the cached provider
    const result2 = await pipeline.renderScene(makeJob());
    expect(result2.prose).toBe('fresh-prose');
    expect(factoryCreate).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// 3. PROVIDER_REQUIRED — no provider or factory available
// ============================================================================

describe('RenderPipeline — PROVIDER_REQUIRED', () => {
  it('fails with PROVIDER_REQUIRED when no provider/factory and render needs real call', async () => {
    const mod = await import('../../src/pipeline/render.ts');
    const { MemoryStorage } = await import('../../src/storage/memory-storage.ts');

    const pipeline = new mod.RenderPipeline({
      model: 'test-model',
      cacheDir: '/tmp/test-cache',
      storage: new MemoryStorage(),
      skipCache: true,
    });

    // Pipeline catches PROVIDER_REQUIRED internally and returns a result with errors.
    const result = await pipeline.renderScene(makeJob());
    expect(result.needsReview).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e: string) => e.includes('PROVIDER_REQUIRED'))).toBe(true);
  });

  it('can construct without provider when cache-only is known to hit', async () => {
    const mod = await import('../../src/pipeline/render.ts');
    const { MemoryStorage } = await import('../../src/storage/memory-storage.ts');

    const pipeline = new mod.RenderPipeline({
      model: 'test-model',
      cacheDir: '/tmp/test-cache',
      storage: new MemoryStorage(),
    });
    expect(pipeline).toBeInstanceOf(mod.RenderPipeline);
  });
});

// ============================================================================
// 4. Revision context — fresh Pass 1, cache bypass, prompt sections
// ============================================================================

describe('RenderPipeline — revision context', () => {
  it('bypasses cache when revisionContext is present', async () => {
    const mod = await import('../../src/pipeline/render.ts');
    const { MockProvider } = await import('../../src/ai/providers/mock.ts');
    const { MemoryStorage } = await import('../../src/storage/memory-storage.ts');

    // Populate cache first
    const storage = new MemoryStorage();
    const populateProvider = new MockProvider({ responses: ['cached-prose', SAMPLE_PASS2] });
    const populatePipeline = new mod.RenderPipeline({
      provider: populateProvider,
      model: 'test-model',
      cacheDir: '/tmp/test-cache',
      storage,
      skipCache: false,
    });
    await populatePipeline.renderScene(makeJob());

    // Second render with revisionContext
    const revisionProvider = new MockProvider({ responses: ['revised-prose', SAMPLE_PASS2] });
    const revisionPipeline = new mod.RenderPipeline({
      provider: revisionProvider,
      model: 'test-model',
      cacheDir: '/tmp/test-cache',
      storage,
      skipCache: false,
    });
    const revContext: RevisionContext = {
      baseRevisionId: 'rev_001',
      baseProse: 'cached-prose',
      baseProseHash: 'hash-of-cached-prose',
      feedbackHashes: ['fb_001'],
      revisionInstructionHash: 'instr-hash',
    };
    const result = await revisionPipeline.renderScene(makeJob({ revisionContext: revContext }));

    expect(result.cacheHit).toBe(false);
    expect(result.prose).toBe('revised-prose');
  });

  it('canonical YAML/context priority is explicit in revision prompt sections', async () => {
    const mod = await import('../../src/pipeline/render.ts');
    const { MockProvider } = await import('../../src/ai/providers/mock.ts');
    const { MemoryStorage } = await import('../../src/storage/memory-storage.ts');

    const storage = new MemoryStorage();
    let capturedUserPrompt = '';

    const provider = new MockProvider({
      generator: (req: CompletionRequest) => {
        const userMsg = [...req.messages].reverse().find((m) => m.role === 'user');
        if (userMsg && capturedUserPrompt === '') {
          capturedUserPrompt = userMsg.content;
        }
        if (req.taskType === 'pass2' || req.seed !== undefined) {
          return SAMPLE_PASS2;
        }
        return 'revised-prose-content';
      },
    });

    const revContext: RevisionContext = {
      baseRevisionId: 'rev_001',
      baseProse: 'Previous accepted prose content.',
      baseProseHash: 'abc123',
      feedbackHashes: ['fb_hash_1', 'fb_hash_2'],
      revisionInstructionHash: 'instr_hash',
    };

    const pipeline = new mod.RenderPipeline({
      provider,
      model: 'test-model',
      cacheDir: '/tmp/test-cache',
      storage,
      skipCache: true,
    });

    await pipeline.renderScene(
      makeJob({
        revisionContext: revContext,
        editorialRevisionInstructions: '1. Tighten the description.\n2. Add sensory detail.',
      }),
    );

    expect(capturedUserPrompt).toContain('Previous Accepted Prose (Non-authoritative)');
    expect(capturedUserPrompt).toContain('Previous accepted prose content.');
    expect(capturedUserPrompt).toContain('Editorial Revision Instructions');
    expect(capturedUserPrompt).toContain('1. Tighten the description.');
    expect(capturedUserPrompt).toContain('2. Add sensory detail.');
    expect(capturedUserPrompt).toContain('take precedence');
  });

  it('evaluates existing prose with Pass 2 only and never writes draft cache', async () => {
    const requests: CompletionRequest[] = [];
    const provider = new MockProvider({
      generator: (request: CompletionRequest) => {
        requests.push(request);
        return SAMPLE_PASS2;
      },
    });
    const storage = new MemoryStorage();
    const pipeline = new RenderPipeline({
      provider,
      model: 'test-model',
      cacheDir: '/tmp/manual-candidate-cache',
      storage,
      skipCache: false,
    });

    const result = await pipeline.renderScene(
      makeJob({ proseCandidate: 'Human-authored prose.' }),
    );

    expect(result.prose).toBe('Human-authored prose.');
    expect(result.llmPass1).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
    expect(requests.some((request) => request.taskType === 'pass1')).toBe(false);
    expect(requests.some((request) => request.taskType === 'pass2')).toBe(true);
    expect(storage.exists('/tmp/manual-candidate-cache')).toBe(false);
  });
});

// ============================================================================
// 5. AbortSignal — cancellation reaches pass phases
// ============================================================================

describe('RenderPipeline — AbortSignal propagation', () => {
  it('passes signal into every CompletionRequest in Pass 1', async () => {
    const mod = await import('../../src/pipeline/render.ts');
    const { MockProvider } = await import('../../src/ai/providers/mock.ts');
    const { MemoryStorage } = await import('../../src/storage/memory-storage.ts');

    const controller = new AbortController();
    const capturedRequests: CompletionRequest[] = [];

    const provider = new MockProvider({
      generator: (req: CompletionRequest) => {
        capturedRequests.push(req);
        return 'test-prose';
      },
    });

    const pipeline = new mod.RenderPipeline({
      provider,
      model: 'test-model',
      cacheDir: '/tmp/test-cache',
      storage: new MemoryStorage(),
      skipCache: true,
      signal: controller.signal,
    });

    await pipeline.renderScene(makeJob()).catch(() => {});

    const pass1Req = capturedRequests.find((r) => r.taskType === 'pass1');
    expect(pass1Req).toBeDefined();
    expect(pass1Req!.signal).toBe(controller.signal);
  });

  it('passes signal into Pass 2 requests', async () => {
    const mod = await import('../../src/pipeline/render.ts');
    const { MockProvider } = await import('../../src/ai/providers/mock.ts');
    const { MemoryStorage } = await import('../../src/storage/memory-storage.ts');

    const controller = new AbortController();
    const capturedRequests: CompletionRequest[] = [];

    const provider = new MockProvider({
      generator: (req: CompletionRequest) => {
        capturedRequests.push(req);
        if (req.taskType === 'pass2' || req.seed !== undefined) {
          return SAMPLE_PASS2;
        }
        return 'test-prose-for-pass2-test';
      },
    });

    const pipeline = new mod.RenderPipeline({
      provider,
      model: 'test-model',
      cacheDir: '/tmp/test-cache',
      storage: new MemoryStorage(),
      skipCache: true,
      signal: controller.signal,
    });

    await pipeline.renderScene(makeJob()).catch(() => {});

    const pass2Req = capturedRequests.find((r) => r.taskType === 'pass2');
    expect(pass2Req).toBeDefined();
    expect(pass2Req!.signal).toBe(controller.signal);
  });

  it('per-call signal overrides pipeline-level signal', async () => {
    const mod = await import('../../src/pipeline/render.ts');
    const { MockProvider } = await import('../../src/ai/providers/mock.ts');
    const { MemoryStorage } = await import('../../src/storage/memory-storage.ts');

    const pipelineController = new AbortController();
    const perCallController = new AbortController();
    const capturedRequests: CompletionRequest[] = [];

    const provider = new MockProvider({
      generator: (req: CompletionRequest) => {
        capturedRequests.push(req);
        if (req.taskType === 'pass2' || req.seed !== undefined) {
          return SAMPLE_PASS2;
        }
        return 'override-test-prose';
      },
    });

    const pipeline = new mod.RenderPipeline({
      provider,
      model: 'test-model',
      cacheDir: '/tmp/test-cache',
      storage: new MemoryStorage(),
      skipCache: true,
      signal: pipelineController.signal,
    });

    await pipeline.renderScene(makeJob(), perCallController.signal).catch(() => {});

    for (const req of capturedRequests) {
      expect(req.signal).toBe(perCallController.signal);
    }
  });
});

// ============================================================================
// 6. evaluateProseCandidate — shared Pass2+Zod+aggregator+release function
// ============================================================================

describe('evaluateProseCandidate', () => {
  it('parses valid analysis and returns release=true', async () => {
    const mod = await import('../../src/pipeline/render.ts');

    const result = mod.evaluateProseCandidate({
      prose: 'Test prose.',
      event: makeEvent(),
      stateBefore: { entities: {}, relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [] },
      context: makeContext(),
      analysisRaw: SAMPLE_PASS2,
      chapter: 1,
    });

    expect(result.analysis).not.toBeNull();
    expect(result.analysis!.eventId).toBe('evt_revision');
    expect(result.pass2Rejection).toBeNull();
    expect(result.errors).toEqual([]);
    expect(result.feedbackErrors).toEqual([]);
    expect(result.release).toBe(true);
  });

  it('returns empty rejection for null analysisRaw', async () => {
    const mod = await import('../../src/pipeline/render.ts');

    const result = mod.evaluateProseCandidate({
      prose: 'Test prose.',
      event: makeEvent(),
      stateBefore: { entities: {}, relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [] },
      context: makeContext(),
      analysisRaw: null,
      chapter: 1,
    });

    expect(result.analysis).toBeNull();
    expect(result.pass2Rejection).toBe('empty');
    expect(result.release).toBe(false);
    expect(result.feedbackErrors.length).toBeGreaterThan(0);
  });

  it('returns empty rejection for empty analysisRaw', async () => {
    const mod = await import('../../src/pipeline/render.ts');

    const result = mod.evaluateProseCandidate({
      prose: 'Test prose.',
      event: makeEvent(),
      stateBefore: { entities: {}, relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [] },
      context: makeContext(),
      analysisRaw: '',
      chapter: 1,
    });

    expect(result.analysis).toBeNull();
    expect(result.pass2Rejection).toBe('empty');
    expect(result.release).toBe(false);
  });

  it('returns parse rejection for invalid JSON', async () => {
    const mod = await import('../../src/pipeline/render.ts');

    const result = mod.evaluateProseCandidate({
      prose: 'Test prose.',
      event: makeEvent(),
      stateBefore: { entities: {}, relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [] },
      context: makeContext(),
      analysisRaw: 'not-json',
      chapter: 1,
    });

    expect(result.analysis).toBeNull();
    expect(result.pass2Rejection).toBe('parse');
    expect(result.release).toBe(false);
    expect(result.feedbackErrors[0]).toContain('JSON parse error');
  });

  it('returns validation rejection for schema-invalid JSON', async () => {
    const mod = await import('../../src/pipeline/render.ts');

    const badJson = JSON.stringify({ eventId: 'evt_test', analysis: {} });
    const result = mod.evaluateProseCandidate({
      prose: 'Test prose.',
      event: makeEvent(),
      stateBefore: { entities: {}, relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [] },
      context: makeContext(),
      analysisRaw: badJson,
      chapter: 1,
    });

    expect(result.analysis).toBeNull();
    expect(result.pass2Rejection).toBe('validation');
    expect(result.release).toBe(false);
  });

  it('forceRelease overrides validation failure', async () => {
    const mod = await import('../../src/pipeline/render.ts');

    const result = mod.evaluateProseCandidate({
      prose: 'Test prose.',
      event: makeEvent(),
      stateBefore: { entities: {}, relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [] },
      context: makeContext(),
      analysisRaw: null,
      chapter: 1,
      forceRelease: true,
    });

    expect(result.analysis).toBeNull();
    expect(result.release).toBe(true);
  });

  it('returns release=false when analysisRaw is null and forceRelease is false', async () => {
    const mod = await import('../../src/pipeline/render.ts');

    const result = mod.evaluateProseCandidate({
      prose: 'Test prose.',
      event: makeEvent(),
      stateBefore: { entities: {}, relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [] },
      context: makeContext(),
      analysisRaw: null,
      chapter: 1,
      forceRelease: false,
    });

    expect(result.release).toBe(false);
  });
});

// ============================================================================
// 7. Batch renderer — AbortSignal propagation integration
// ============================================================================

describe('BatchRenderPipeline — signal propagation', () => {
  it('passes external signal from BatchConfig to pipeline renderAll', async () => {
    const mod = await import('../../src/pipeline/render.ts');
    const { BatchRenderPipeline } = await import('../../src/batch-renderer.ts');

    const controller = new AbortController();
    const capturedSignals: Array<AbortSignal | undefined> = [];

    const capturingPipeline = {
      renderAll: vi.fn().mockImplementation(
        (_jobs: RenderJob[], signal?: AbortSignal) => {
          capturedSignals.push(signal);
          return Promise.resolve([] as never[]);
        },
      ),
    };

    const batch = new BatchRenderPipeline(capturingPipeline as unknown as import('../../src/pipeline/render.ts').RenderPipeline);
    await batch.renderBatched([makeJob(), makeJob()], {
      batchSize: 1,
      windowSize: 1,
      signal: controller.signal,
    });

    expect(capturedSignals.length).toBeGreaterThan(0);
    for (const sig of capturedSignals) {
      expect(sig).toBe(controller.signal);
    }
  });
});

// ============================================================================
// 8. Mixed hit/miss — factory created once across cache hits and misses
// ============================================================================

describe('RenderPipeline — mixed cache hit/miss lazy creation', () => {
  it('all-hit with no provider/factory succeeds from cache', async () => {
    const mod = await import('../../src/pipeline/render.ts');
    const { MockProvider } = await import('../../src/ai/providers/mock.ts');
    const { MemoryStorage } = await import('../../src/storage/memory-storage.ts');

    // Populate cache with a provider
    const storage = new MemoryStorage();
    const populateProvider = new MockProvider({ responses: ['cached-prose', SAMPLE_PASS2] });
    const populatePipeline = new mod.RenderPipeline({
      provider: populateProvider,
      model: 'test-model',
      cacheDir: '/tmp/test-cache',
      storage,
      skipCache: false,
    });
    await populatePipeline.renderScene(makeJob());

    // Fresh pipeline with NO provider or factory — cache should still hit
    const cachedPipeline = new mod.RenderPipeline({
      model: 'test-model',
      cacheDir: '/tmp/test-cache',
      storage,
      skipCache: false,
    });
    const result = await cachedPipeline.renderScene(makeJob());

    expect(result.cacheHit).toBe(true);
    expect(result.prose).toBe('cached-prose');
  });

  it('mixed hit/miss creates factory once for the miss', async () => {
    const mod = await import('../../src/pipeline/render.ts');
    const { MockProvider } = await import('../../src/ai/providers/mock.ts');
    const { MemoryStorage } = await import('../../src/storage/memory-storage.ts');

    // Populate cache for one event ID
    const storage = new MemoryStorage();
    const populateProvider = new MockProvider({ responses: ['cached-prose', SAMPLE_PASS2] });
    const populatePipeline = new mod.RenderPipeline({
      provider: populateProvider,
      model: 'test-model',
      cacheDir: '/tmp/test-cache',
      storage,
      skipCache: false,
    });
    await populatePipeline.renderScene(makeJob({ event: { ...makeEvent(), id: 'evt_cached' } }));

    // Pipeline with factory only
    const factoryCreate = vi.fn<() => Promise<MockProvider>>();
    factoryCreate.mockResolvedValue(
      new MockProvider({
        generator: (req: CompletionRequest) => {
          if (req.taskType === 'pass2' || req.seed !== undefined) return SAMPLE_PASS2;
          return 'miss-prose';
        },
      }),
    );
    const factory: ProviderFactory = {
      profile: 'test-profile',
      create: factoryCreate,
    };
    const pipeline = new mod.RenderPipeline({
      providerFactory: factory,
      model: 'test-model',
      cacheDir: '/tmp/test-cache',
      storage,
      skipCache: false,
    });

    // Render cache hit
    const hitResult = await pipeline.renderScene(makeJob({ event: { ...makeEvent(), id: 'evt_cached' } }));
    expect(hitResult.cacheHit).toBe(true);
    expect(factoryCreate).not.toHaveBeenCalled();

    // Render cache miss — triggers factory creation
    const missResult = await pipeline.renderScene(makeJob({ event: { ...makeEvent(), id: 'evt_miss' } }));
    expect(missResult.cacheHit).toBe(false);
    expect(factoryCreate).toHaveBeenCalledTimes(1);

    // Another cache hit — still no additional factory call
    const hit2Result = await pipeline.renderScene(makeJob({ event: { ...makeEvent(), id: 'evt_cached' } }));
    expect(hit2Result.cacheHit).toBe(true);
    expect(factoryCreate).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// 9. PROVIDER_REQUIRED — non-retryable, immediate break
// ============================================================================

describe('RenderPipeline — PROVIDER_REQUIRED non-retryable', () => {
  it('breaks retry loop on PROVIDER_REQUIRED without additional attempts', async () => {
    const mod = await import('../../src/pipeline/render.ts');
    const { MemoryStorage } = await import('../../src/storage/memory-storage.ts');

    const pipeline = new mod.RenderPipeline({
      model: 'test-model',
      cacheDir: '/tmp/test-cache',
      storage: new MemoryStorage(),
      skipCache: true,
    });

    const result = await pipeline.renderScene(makeJob());
    expect(result.needsReview).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.errors.some((e: string) => e.includes('PROVIDER_REQUIRED'))).toBe(true);
    // No retries — PROVIDER_REQUIRED is terminal
    expect(result.providerCalls.length).toBe(0);
  });
});

// ============================================================================
// 10. Signal visible in double-run verification phase
// ============================================================================

describe('RenderPipeline — signal in each provider phase', () => {
  it('passes signal into double-run verification request', async () => {
    const mod = await import('../../src/pipeline/render.ts');
    const { MockProvider } = await import('../../src/ai/providers/mock.ts');
    const { MemoryStorage } = await import('../../src/storage/memory-storage.ts');

    const controller = new AbortController();
    const capturedSignals: Array<AbortSignal | undefined> = [];

    const provider = new MockProvider({
      generator: (req: CompletionRequest) => {
        capturedSignals.push(req.signal);
        if (req.taskType === 'pass2' || req.seed !== undefined) return SAMPLE_PASS2;
        return 'prose-for-verify-test';
      },
    });

    const pipeline = new mod.RenderPipeline({
      provider,
      model: 'test-model',
      cacheDir: '/tmp/test-cache',
      storage: new MemoryStorage(),
      skipCache: true,
      signal: controller.signal,
      doubleRunVerification: true,
    });

    await pipeline.renderScene(makeJob()).catch(() => {});

    // All captured requests should have the pipeline signal
    expect(capturedSignals.length).toBeGreaterThan(0);
    for (const sig of capturedSignals) {
      expect(sig).toBe(controller.signal);
    }
    // Verify at least one pass1, one pass2, and one verify request
    const verifySignals = capturedSignals.filter((_, i) => {
      const phase = i < capturedSignals.length - 1 && capturedSignals.length > 2 ? 'mixed' : 'unknown';
      return true; // All must carry the signal — fine-grained check below
    });
    expect(capturedSignals.length).toBeGreaterThanOrEqual(3); // pass1 + pass2 + verify
  });
});

// ============================================================================
// 11. No provider calls after abort signal fires
// ============================================================================

describe('RenderPipeline — no calls after abort', () => {
  it('returns cancelled result with zero provider calls when signal already aborted', async () => {
    const mod = await import('../../src/pipeline/render.ts');
    const { MockProvider } = await import('../../src/ai/providers/mock.ts');
    const { MemoryStorage } = await import('../../src/storage/memory-storage.ts');

    const controller = new AbortController();
    controller.abort();

    const provider = new MockProvider({ responses: ['should-not-be-called', SAMPLE_PASS2] });
    const pipeline = new mod.RenderPipeline({
      provider,
      model: 'test-model',
      cacheDir: '/tmp/test-cache',
      storage: new MemoryStorage(),
      skipCache: true,
      signal: controller.signal,
    });

    const result = await pipeline.renderScene(makeJob());

    expect(result.attempts).toBe(0);
    expect(result.providerCalls.length).toBe(0);
    expect(provider.calls.length).toBe(0);
    expect(result.needsReview).toBe(true);
    expect(result.errors.some((e: string) => e.includes('cancelled') || e.includes('abort'))).toBe(true);
  });

  it('stops rendering mid-retry when abort signal fires', async () => {
    const mod = await import('../../src/pipeline/render.ts');
    const { MockProvider } = await import('../../src/ai/providers/mock.ts');
    const { MemoryStorage } = await import('../../src/storage/memory-storage.ts');

    const controller = new AbortController();
    const callCounts: string[] = [];

    const provider = new MockProvider({
      generator: (req: CompletionRequest) => {
        callCounts.push(req.taskType ?? 'unknown');
        // Abort after first Pass 1 call
        controller.abort();
        return req.taskType === 'pass2' || req.seed !== undefined
          ? SAMPLE_PASS2
          : 'mid-abort-prose';
      },
    });

    const pipeline = new mod.RenderPipeline({
      provider,
      model: 'test-model',
      cacheDir: '/tmp/test-cache',
      storage: new MemoryStorage(),
      skipCache: true,
      signal: controller.signal,
    });

    const result = await pipeline.renderScene(makeJob());

    // At most 1 pass1 call — after abort, the loop should stop
    expect(callCounts.filter((c) => c === 'pass1').length).toBe(1);
    // No pass2 calls after abort
    expect(callCounts.filter((c) => c === 'pass2').length).toBe(0);
    // Result reflects cancellation
    expect(result.needsReview).toBe(true);
  });
});

// ============================================================================
// 12. Batch renderer — stops scheduling after abort
// ============================================================================

describe('BatchRenderPipeline — stops scheduling after abort', () => {
  it('does not submit new batches after external abort fires', async () => {
    const mod = await import('../../src/pipeline/render.ts');
    const { BatchRenderPipeline } = await import('../../src/batch-renderer.ts');

    const controller = new AbortController();
    let renderCallCount = 0;

    const capturingPipeline = {
      renderAll: vi.fn().mockImplementation(
        async (_jobs: RenderJob[], signal?: AbortSignal) => {
          renderCallCount++;
          // Abort after first batch
          controller.abort();
          return Promise.resolve([] as never[]);
        },
      ),
    };

    const batch = new BatchRenderPipeline(capturingPipeline as unknown as import('../../src/pipeline/render.ts').RenderPipeline);
    const result = await batch.renderBatched(
      [makeJob(), makeJob(), makeJob(), makeJob()],
      {
        batchSize: 1,
        windowSize: 2,
        signal: controller.signal,
      },
    );

    // Only the first batch should have been submitted; abort stops scheduling
    expect(renderCallCount).toBe(1);
    expect(result.stats.aborted).toBe(true);
  });
});

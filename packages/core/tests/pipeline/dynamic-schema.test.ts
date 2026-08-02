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
import { z } from 'zod';
import type { MockPass2Entry } from '../../src/ai/providers/mock-pass2.ts';
import { MockPass2Provider } from '../../src/ai/providers/mock-pass2.ts';
import { type RenderJob, RenderPipeline } from '../../src/pipeline/render.ts';
import { createRuntimeServices } from '../fixtures/runtime-services.ts';
import type {
  ContextPackage,
  KnowledgeBoundary,
  NarrativeEvent,
  SceneSpecification,
  SystemContext,
  WorldState,
} from '../../src/types/index.ts';
import { ResultAggregator } from '../../src/validator/aggregator.ts';
import { createBuiltInValidators } from '../../src/validator/builtins.ts';
import {
  makeAnalysisResult,
  makeObservations,
  makeProtocol,
} from '../fixtures/mock-pass2-helpers.ts';

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
    beats: ['A test scene.'],
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'event_file',
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
      beats: ['Advance plot'],
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
    markdown: '',
    narrativeTechniques: [],
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
    sourceContentHash: 'source-dynamic',
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
    },
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
    runtimeServices: createRuntimeServices({ provider }).services,
    skipCache: true,
    maxRetries,
    aggregator,
    validatorPolicyId: 'test-policy-v1',
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

    expect(
      result.analysis,
      `${result.errors.join('\n')}\n${JSON.stringify(result.requestRecords.at(-1))}`,
    ).not.toBeNull();
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

  /**
   * Build a MockPass2Entry whose analysis omits `missingField` from the
   * canonical payload while still carrying a `produced` observation for it.
   * Under the current contract a produced observation without its canonical
   * payload is a pairing violation, so the dynamic-schema path rejects it
   * exactly like the old "required block missing" rule did.
   */
  function makeEntryMissingBlock(missingField: string, prose: string): MockPass2Entry {
    const content: Record<string, unknown> = {
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
      knowledgeChecks: [],
      checklistResults: [],
    };
    delete content[missingField];
    const observations = makeObservations(content, prose);
    observations[missingField] = { disposition: 'produced', evidence: [prose.trim().slice(0, 24)] };
    return {
      prose,
      analysis: {
        eventId: 'test',
        protocol: makeProtocol(prose),
        observations,
        analysis: content,
      },
    };
  }

  it('rejects analysis missing a required block (tenseDetected)', async () => {
    const entry = makeEntryMissingBlock('tenseDetected', 'Test prose for missing block scenario.');
    const pipeline = buildPipeline(entry, 0);
    const result = await pipeline.renderScene(makeJob('test'));

    expect(result.analysis).toBeNull();
    expect(result.pass2Rejection).toBe('validation');
    expect(result.errors.some((e) => e.includes('schema validation'))).toBe(true);
    expect(result.needsReview).toBe(true);
  });

  it('rejects analysis missing a required block (conflictAnalysis)', async () => {
    const entry = makeEntryMissingBlock(
      'conflictAnalysis',
      'Test prose for missing conflictAnalysis.',
    );
    const pipeline = buildPipeline(entry, 0);
    const result = await pipeline.renderScene(makeJob('test'));

    expect(result.analysis).toBeNull();
    expect(result.pass2Rejection).toBe('validation');
    expect(result.errors.some((e) => e.includes('schema validation'))).toBe(true);
    expect(result.needsReview).toBe(true);
  });

  it('rejects analysis missing a required block (ruleChecks)', async () => {
    const entry = makeEntryMissingBlock('ruleChecks', 'Test prose for missing ruleChecks.');
    const pipeline = buildPipeline(entry, 0);
    const result = await pipeline.renderScene(makeJob('test'));

    expect(result.analysis).toBeNull();
    expect(result.pass2Rejection).toBe('validation');
    expect(result.errors.some((e) => e.includes('schema validation'))).toBe(true);
    expect(result.needsReview).toBe(true);
  });

  it('rejects analysis missing a required block (knowledgeChecks)', async () => {
    const entry = makeEntryMissingBlock(
      'knowledgeChecks',
      'Test prose for missing knowledgeChecks.',
    );
    const pipeline = buildPipeline(entry, 0);
    const result = await pipeline.renderScene(makeJob('test'));

    expect(result.analysis).toBeNull();
    expect(result.pass2Rejection).toBe('validation');
    expect(result.errors.some((e) => e.includes('schema validation'))).toBe(true);
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

// ============================================================================
// AnalysisContract — Tests for getAnalysisContract(), overrides, active rules
// ============================================================================

describe('analysis contract', () => {
  it('getAnalysisContract returns deterministic requirements, schema, and hash', () => {
    const aggregator = new ResultAggregator();
    const contract = aggregator.getAnalysisContract();

    // Returns all three fields
    expect(contract).toHaveProperty('requirements');
    expect(contract).toHaveProperty('combinedSchema');
    expect(contract).toHaveProperty('hash');

    // Requirements is a non-empty array
    expect(contract.requirements.length).toBeGreaterThan(0);
    // Schema has shape keys matching top-level fields
    const schemaKeys = Object.keys(contract.combinedSchema.shape).sort();
    expect(schemaKeys.length).toBeGreaterThan(0);

    // Hash is a 64-char hex string
    expect(contract.hash).toMatch(/^[0-9a-f]{64}$/);

    // Deterministic: same call produces same result
    const contract2 = aggregator.getAnalysisContract();
    expect(contract2.hash).toBe(contract.hash);
  });

  it('getAnalysisContract and getAnalysisRequirements produce same field set', () => {
    const aggregator = new ResultAggregator();
    const contract = aggregator.getAnalysisContract();
    const reqFields = new Set(contract.requirements.map((r) => r.field));

    // Every top-level schema field should have at least one requirement
    // (some top-level fields may be populated by dotted-path requirements)
    const schemaFields = Object.keys(contract.combinedSchema.shape);
    for (const sf of schemaFields) {
      const hasDirect = reqFields.has(sf);
      const hasDotted = [...reqFields].some((f) => f.startsWith(sf + '.'));
      expect(hasDirect || hasDotted).toBe(true);
    }
  });

  it('getAnalysisContract and getCombinedValidationSchema produce same schema keys', () => {
    const aggregator = new ResultAggregator();
    const contract = aggregator.getAnalysisContract();
    const directSchema = aggregator.getCombinedValidationSchema();

    // Same field set
    expect(Object.keys(contract.combinedSchema.shape).sort()).toEqual(
      Object.keys(directSchema.shape).sort(),
    );
  });

  it('overrides with off excludes validators from contract', () => {
    const aggregator = new ResultAggregator();
    // Turn off POVValidator
    const contract = aggregator.getAnalysisContract({ pov: 'off' });
    const reqFields = contract.requirements.map((r) => r.field);

    // POV-related fields should be absent
    expect(reqFields).not.toContain('pov');
    expect(Object.keys(contract.combinedSchema.shape)).not.toContain('pov');

    // Other fields still present
    expect(reqFields).toContain('narrativeChecks');
    expect(Object.keys(contract.combinedSchema.shape)).toContain('preconditions');
  });

  it('override off on non-existent validator is a no-op', () => {
    const aggregator = new ResultAggregator();
    const contract = aggregator.getAnalysisContract({ NonExistentValidator: 'off' });
    const noOverride = aggregator.getAnalysisContract({});

    // Same requirements (no validator was actually excluded)
    expect(contract.requirements.map((r) => r.field).sort()).toEqual(
      noOverride.requirements.map((r) => r.field).sort(),
    );
    expect(contract.hash).toBe(noOverride.hash);
  });

  it('different overrides produce different hashes', () => {
    const aggregator = new ResultAggregator();
    const full = aggregator.getAnalysisContract();
    const filtered = aggregator.getAnalysisContract({ pov: 'off' });

    expect(filtered.hash).not.toBe(full.hash);
  });

  it('hash is deterministic across calls', () => {
    const aggregator = new ResultAggregator();
    const a = aggregator.getAnalysisContract();
    const b = aggregator.getAnalysisContract();
    const c = aggregator.getAnalysisContract({});
    expect(a.hash).toBe(b.hash);
    expect(b.hash).toBe(c.hash);
  });

  it('plugin validator contributes requirements to contract', () => {
    const pluginValidator = {
      name: 'PluginTestValidator',
      category: 'prose_quality' as const,
      validatePre: () => [],
      getAnalysisRequirements: () => [
        {
          field: 'pluginChecks',
          attributes: ['pluginAttr'],
          instruction: 'pluginChecks: validate plugin attributes',
          schema: z.object({ pluginAttr: z.array(z.string()) }),
        },
      ],
    };
    const aggregator = new ResultAggregator([...createBuiltInValidators(), pluginValidator]);
    const contract = aggregator.getAnalysisContract();
    const reqFields = contract.requirements.map((r) => r.field);
    expect(reqFields).toContain('pluginChecks');
    const schemaKeys = Object.keys(contract.combinedSchema.shape);
    expect(schemaKeys).toContain('pluginChecks');
    // Verify existing blocks still present
    expect(reqFields).toContain('narrativeChecks');
    expect(reqFields).toContain('pov.leaks');
  });

  it('plugin validator requirements appear in combine schema and parse', () => {
    const pluginValidator = {
      name: 'PluginTestValidator',
      category: 'prose_quality' as const,
      validatePre: () => [],
      getAnalysisRequirements: () => [
        {
          field: 'pluginTestField',
          attributes: [],
          instruction: 'pluginTestField: test',
          schema: z.object({ testValue: z.string() }),
        },
      ],
    };
    const aggregator = new ResultAggregator([...createBuiltInValidators(), pluginValidator]);

    const contract = aggregator.getAnalysisContract();
    // Requirements include plugin field
    expect(contract.requirements.some((r) => r.field === 'pluginTestField')).toBe(true);

    // Combined schema includes plugin field
    expect(contract.combinedSchema.shape['pluginTestField']).toBeDefined();

    // getAnalysisRequirements also has it (delegates to contract)
    const reqs = aggregator.getAnalysisRequirements();
    expect(reqs.some((r) => r.field === 'pluginTestField')).toBe(true);

    // getCombinedValidationSchema also has it (delegates to contract)
    const schema = aggregator.getCombinedValidationSchema();
    expect(schema.shape['pluginTestField']).toBeDefined();
  });

  it('activeRules from context are passed to Pass 2 analysis input', async () => {
    const entry = makeAnalysisResult('test');
    const provider = new MockPass2Provider({ entries: { test: entry } });
    const aggregator = new ResultAggregator();
    const pipeline = new RenderPipeline({
      provider,
      model: 'mock-pass2',
      runtimeServices: createRuntimeServices({ provider }).services,
      skipCache: true,
      maxRetries: 1,
      aggregator,
      validatorPolicyId: 'test-policy-v1',
    });

    const job = makeJob('test');
    job.context.activeRules = [
      {
        ruleId: 'rule_1',
        name: 'Magic Systems',
        statement: 'Magic must have a cost',
        category: 'world',
        source: 'test',
      },
    ];

    const result = await pipeline.renderScene(job);
    expect(result.analysis, result.errors.join('\n')).not.toBeNull();
    // The prompt render-analysis.ts includes Active World Rules section when
    // input.activeRules is non-empty — the mock won't surface it in output,
    // but the pipeline should not crash and analysis should be valid.
    expect(result.analysis!.eventId).toBe('test');
  });

  it('pipeline uses analysisContract schema when provided', async () => {
    const aggregator = new ResultAggregator();
    const contract = aggregator.getAnalysisContract();
    const entry = makeAnalysisResult('test');
    const provider = new MockPass2Provider({ entries: { test: entry } });

    const pipeline = new RenderPipeline({
      provider,
      model: 'mock-pass2',
      runtimeServices: createRuntimeServices({ provider }).services,
      skipCache: true,
      maxRetries: 1,
      aggregator,
      // Pass the pre-computed analysis contract
      analysisContract: contract,
      validatorPolicyId: 'test-policy-v1',
    });

    const result = await pipeline.renderScene(makeJob('test'));
    expect(result.analysis, result.errors.join('\n')).not.toBeNull();
    expect(result.analysis!.eventId).toBe('test');
  });

  it('override off excludes requirement fields from contract', () => {
    const aggregator = new ResultAggregator();
    // Turn off a validator that contributes 'pov' field
    const contract = aggregator.getAnalysisContract({ pov: 'off' });
    expect(contract.requirements.some((r) => r.field === 'pov')).toBe(false);

    // Turn off a different validator
    const contract2 = aggregator.getAnalysisContract({ knowledge: 'off' });
    expect(contract2.requirements.some((r) => r.field === 'knowledgeChecks')).toBe(false);
  });

  it('getAnalysisRequirements delegates to getAnalysisContract and includes plugins', () => {
    const pluginValidator = {
      name: 'DelegationPlugin',
      category: 'prose_quality' as const,
      validatePre: () => [],
      getAnalysisRequirements: () => [
        {
          field: 'delegationTest',
          attributes: [],
          instruction: 'delegationTest: verify delegation works',
          schema: z.object({ ok: z.boolean() }),
        },
      ],
    };
    const aggregator = new ResultAggregator([...createBuiltInValidators(), pluginValidator]);

    // getAnalysisRequirements is a delegate — it should include plugin fields
    const reqs = aggregator.getAnalysisRequirements();
    expect(reqs.some((r) => r.field === 'delegationTest')).toBe(true);
  });
});

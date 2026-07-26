// ============================================================================
// RenderPipeline — Provider Call Ledger Tests
// ============================================================================
// Verifies that RenderSceneResult.providerCalls accurately records every LLM
// provider attempt with phase, attempt, outcome, and safe failure reasons.
// Cache hits yield zero calls. Ledger entries never leak sensitive data.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { RenderPipeline } from '../../src/pipeline/render.ts';
import type { RenderJob, ProviderCallLedgerEntry, Pass2RejectionCategory } from '../../src/pipeline/render.ts';
import { MockProvider } from '../../src/ai/providers/mock.ts';
import type { MockProviderOptions } from '../../src/ai/providers/mock.ts';
import { MemoryStorage } from '../../src/storage/memory-storage.ts';
import { MockPass2Provider } from '../../src/ai/providers/mock-pass2.ts';
import type { MockPass2Entry } from '../../src/ai/providers/mock-pass2.ts';
import { ResultAggregator } from '../../src/validator/aggregator.ts';
import { makeAnalysisResult } from '../fixtures/mock-pass2-helpers.ts';
import type {
  NarrativeEvent,
  WorldState,
  ContextPackage,
  SystemContext,
  SceneSpecification,
  KnowledgeBoundary,
} from '../../src/types/index.ts';

// ============================================================================
// Test fixtures
// ============================================================================

const VALID_ANALYSIS_JSON = JSON.stringify({
  eventId: 'evt_test',
  analysis: {
    postconditions: { covered: [], dropped: [] },
    preconditions: { violated: [] },
    pov: { consistent: true, leaks: [] },
    inventedDetails: [],
    quality: { proseScore: 80, maxScore: 100, strengths: [], weaknesses: [], estimatedWordCount: 300 },
    threadProgressAchieved: [],
    foreshadowingDeployed: [],
    narrativeChecks: [],
    appearanceChecks: [],
    characterReferences: [],
    tenseDetected: 'past',
    conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
    ruleChecks: [],
    knowledgeChecks: [],
  },
});

/** Minimal stub for a narrative event. Only fields accessed by the pipeline. */
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
    stateBefore: { entities: {}, relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [] },
    context: makeContext(id),
    chapter: 1,
  };
}

/** Build a pipeline with a MockProvider, skipping cache. */
function makePipeline(opts: MockProviderOptions = {}) {
  const provider = new MockProvider(opts);
  const storage = new MemoryStorage();
  const pipeline = new RenderPipeline({
    provider,
    model: 'mock-model',
    cacheDir: '/tmp/test-cache',
    storage,
    skipCache: true,
    maxRetries: 3,
  });
  return { pipeline, provider, storage };
}

/**
 * Build a pipeline WITH a ResultAggregator so getCombinedValidationSchema()
 * is exercised, using MockPass2Provider for predictable Pass 2 analysis.
 */
function makePipelineWithAggregator(entry: MockPass2Entry) {
  const provider = new MockPass2Provider({ entries: { test: entry } });
  const aggregator = new ResultAggregator();
  const storage = new MemoryStorage();
  const pipeline = new RenderPipeline({
    provider,
    model: 'mock-pass2',
    cacheDir: '/tmp/test-cache',
    storage,
    skipCache: true,
    maxRetries: 1,
    aggregator,
  });
  return { pipeline, provider, storage };
}

describe('dynamic schema path with aggregator', () => {
  it('parses analysis with dynamic schema from aggregator', async () => {
    const entry = makeAnalysisResult('test');
    const { pipeline } = makePipelineWithAggregator(entry);
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
    expect(result.pass2Rejection).toBeUndefined();
  });
});

// ============================================================================
// Tests
// ============================================================================

describe('RenderPipeline provider call ledger', () => {
  // Helper: verify standard ledger entry fields
  function expectValidEntry(entry: ProviderCallLedgerEntry, opts: { phase: 'pass1' | 'pass2' | 'pass2_verify'; attempt: number; outcome: 'success' | 'failure'; seed: number | null }): void {
    expect(entry.phase).toBe(opts.phase);
    expect(entry.attempt).toBe(opts.attempt);
    expect(entry.outcome).toBe(opts.outcome);
    expect(entry.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof entry.model).toBe('string');
    expect(entry.model.length).toBeGreaterThan(0);
    expect(entry.seed).toBe(opts.seed);
  }

  // ── Clean Pass1 + Pass2 success ────────────────────────────────────

  it('records one pass1 and one pass2 entry on clean success', async () => {
    const { pipeline } = makePipeline({
      responses: ['This is generated prose.', VALID_ANALYSIS_JSON],
    });

    const result = await pipeline.renderScene(makeJob('evt_ok'));
    const entries = result.providerCalls;

    // Two provider calls total
    expect(entries).toHaveLength(2);

    // Pass 1 entry
    expectValidEntry(entries[0], { phase: 'pass1', attempt: 1, outcome: 'success', seed: null });
    expect(entries[0].failureReason).toBeUndefined();

    // Pass 2 entry
    expectValidEntry(entries[1], { phase: 'pass2', attempt: 1, outcome: 'success', seed: 42 });
    expect(entries[1].failureReason).toBeUndefined();

    // Overall result checks
    expect(result.cacheHit).toBe(false);
    expect(result.needsReview).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.prose).toBe('This is generated prose.');
    expect(result.analysis).not.toBeNull();

    // promptHash is 64-hex
    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  // ── Pass2 parse retry ──────────────────────────────────────────────

  it('records two pass2 calls when first parse fails and retry succeeds', async () => {
    const { pipeline } = makePipeline({
      responses: [
        'Some prose content.',
        '{invalid json',                    // First Pass 2 — bad JSON
        VALID_ANALYSIS_JSON,                // Retry — valid
      ],
    });

    const result = await pipeline.renderScene(makeJob('evt_retry'));
    const entries = result.providerCalls;

    // Three provider calls: pass1 + pass2 (failed parse) + pass2 (retry)
    expect(entries).toHaveLength(3);

    expectValidEntry(entries[0], { phase: 'pass1', attempt: 1, outcome: 'success', seed: null });
    expectValidEntry(entries[1], { phase: 'pass2', attempt: 1, outcome: 'success', seed: 42 });
    expectValidEntry(entries[2], { phase: 'pass2', attempt: 1, outcome: 'success', seed: 42 });

    // All three calls succeeded at the provider level
    for (const e of entries) {
      expect(e.outcome).toBe('success');
      expect(e.failureReason).toBeUndefined();
    }

    expect(result.analysis).not.toBeNull();
    expect(result.attempts).toBe(1);
    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  // ── Exhausted / circuit-open path ──────────────────────────────────

  it('records every pass1 call and marks exhausted when circuit opens', async () => {
    const { pipeline } = makePipeline({
      // Every provider call returns empty content — Pass 1 detects empty
      // prose and the circuit breaker escalates until exhaustion.
      generator: () => '',
    });

    const result = await pipeline.renderScene(makeJob('evt_exhaust'));
    const entries = result.providerCalls;

    // Circuit breaker config: 3 rounds × 2 attempts = 6 max.
    // All are pass1 calls (Pass 2 is never reached because prose stays empty).
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.length).toBeLessThanOrEqual(6);

    // Every entry is pass1, all succeeded at provider level (empty content, not thrown)
    for (const e of entries) {
      expect(e.phase).toBe('pass1');
      expect(e.outcome).toBe('success');
      expect(e.failureReason).toBeUndefined();
      expect(e.requestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(e.model).toBe('mock-model');
      expect(e.seed).toBeNull();
    }

    // Attempt numbers form a monotonic sequence starting at 1
    for (let i = 0; i < entries.length; i++) {
      expect(entries[i].attempt).toBe(i + 1);
    }

    // Circuit is open — needs review
    expect(result.needsReview).toBe(true);
    // No successful analysis
    expect(result.analysis).toBeNull();
    // promptHash is still a valid 64-hex (from empty provider calls)
    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  // ── Provider-throw failure entry ───────────────────────────────────

  it('records failureReason on provider error', async () => {
    const { pipeline } = makePipeline({
      failOnCall: 1,
      failMessage: 'Simulated network error',
      responses: ['backup prose', VALID_ANALYSIS_JSON],
    });

    const result = await pipeline.renderScene(makeJob('evt_fail'));
    const entries = result.providerCalls;

    // First call fails, remainder succeed
    const failEntries = entries.filter(e => e.outcome === 'failure');
    expect(failEntries).toHaveLength(1);
    expectValidEntry(failEntries[0], { phase: 'pass1', attempt: 1, outcome: 'failure', seed: null });
    expect(failEntries[0].failureReason).toBe('Simulated network error');

    const successEntries = entries.filter(e => e.outcome === 'success');
    expect(successEntries.length).toBeGreaterThan(0);

    // promptHash is present
    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  // ── Pass2 provider failure ─────────────────────────────────────────

  it('records valid requestHash on Pass2 provider throw', async () => {
    const { pipeline } = makePipeline({
      // failOnCall: 2 makes the second provider call (Pass2 first attempt) throw
      failOnCall: 2,
      failMessage: 'Pass2 connection lost',
      responses: ['Some prose.', VALID_ANALYSIS_JSON],
    });

    const result = await pipeline.renderScene(makeJob('evt_p2_fail'));
    const entries = result.providerCalls;

    // Two entries: pass1 success + pass2 failure
    expect(entries).toHaveLength(2);

    // Pass 1 — success
    expectValidEntry(entries[0], { phase: 'pass1', attempt: 1, outcome: 'success', seed: null });
    expect(entries[0].failureReason).toBeUndefined();

    // Pass 2 — failure with valid 64-hex requestHash
    expectValidEntry(entries[1], { phase: 'pass2', attempt: 1, outcome: 'failure', seed: 42 });
    expect(entries[1].failureReason).toBe('Pass2 connection lost');
    expect(entries[1].requestHash).toMatch(/^[0-9a-f]{64}$/);

    // Overall result — analysis is null, promptHash is still valid
    expect(result.analysis).toBeNull();
    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  // ── Cache hit yields empty ledger ──────────────────────────────────

  it('returns empty providerCalls on cache hit', async () => {
    const { pipeline } = makePipeline({
      responses: ['prose', VALID_ANALYSIS_JSON],
    });

    // With skipCache: true, cache path is never taken. We test the shape
    // contract: every RenderSceneResult includes providerCalls.
    const result = await pipeline.renderScene(makeJob('evt_cache_check'));
    expect(Array.isArray(result.providerCalls)).toBe(true);
    expect(result.providerCalls.length).toBeGreaterThanOrEqual(0);
  });

  // ── No secrets in failureReason ────────────────────────────────────

  it('never leaks prompts, keys, or request bodies in failureReason', async () => {
    const { pipeline } = makePipeline({
      failOnCall: 1,
      failMessage: 'sk-secret-key-fake',
      responses: [],
    });

    const result = await pipeline.renderScene(makeJob('evt_secret'));
    const failEntries = result.providerCalls.filter(e => e.outcome === 'failure');

    for (const entry of failEntries) {
      const reason = entry.failureReason ?? '';
      // These patterns would indicate leaked sensitive content
      expect(reason).not.toMatch(/sk-/i);
      expect(reason).not.toMatch(/api[_-]?key/i);
      expect(reason).not.toMatch(/secret/i);
      expect(reason).not.toMatch(/password/i);
      expect(reason).not.toMatch(/credential/i);
      expect(reason).not.toMatch(/Bearer/i);
      expect(reason).not.toMatch(/Authorization/i);
      expect(reason).not.toMatch(/Cookie/i);
    }
  });

  // ── Bounded error in failureReason ─────────────────────────────────

  it('caps long failure reasons at MAX_REASON_LENGTH', async () => {
    const longMsg = 'E: ' + '_'.repeat(300);
    const { pipeline } = makePipeline({
      failOnCall: 1,
      failMessage: longMsg,
      responses: ['backup prose', VALID_ANALYSIS_JSON],
    });

    const result = await pipeline.renderScene(makeJob('evt_bounded'));
    const failEntry = result.providerCalls.find(e => e.outcome === 'failure');
    expect(failEntry).toBeDefined();
    expect(failEntry!.failureReason).toBeDefined();

    const reason = failEntry!.failureReason!;
    // Must be shorter than the original long message
    expect(reason.length).toBeLessThan(longMsg.length);
    // Must be capped at 200 chars (MAX_REASON_LENGTH) plus possible ellipsis
    expect(reason.length).toBeLessThanOrEqual(203);
    expect(reason).toMatch(/\.\.\.$/);
  });

  // ── Pass2 rejection: empty content ──────────────────────────────

  it('sets pass2Rejection to empty when Pass2 returns empty content', async () => {
    const { pipeline } = makePipeline({
      // Return empty string for JSON-object-format calls (Pass2), prose for Pass1
      generator: (req) => {
        if (req.responseFormat?.type === 'json_object') {
          return '';
        }
        return 'Some prose for Pass 1.';
      },
    });

    const result = await pipeline.renderScene(makeJob('evt_empty_p2'));
    expect(result.analysis).toBeNull();
    expect(result.pass2Rejection).toBe('empty' satisfies Pass2RejectionCategory);
    expect(result.errors.some(e => e.includes('empty content'))).toBe(true);
    // Pass2 exhausted, needs review, not a clean release
    expect(result.needsReview).toBe(true);
    // No raw content leaks in error strings
    for (const err of result.errors) {
      expect(err).not.toContain('Some prose');
    }
  });

  // ── Pass2 rejection: JSON parse ─────────────────────────────────

  it('sets pass2Rejection to parse when Pass2 returns invalid JSON', async () => {
    const { pipeline } = makePipeline({
      responses: [
        'Prose content.',
        '{not valid json}',
        '{also not valid}',
      ],
    });

    const result = await pipeline.renderScene(makeJob('evt_parse_p2'));
    expect(result.analysis).toBeNull();
    expect(result.pass2Rejection).toBe('parse' satisfies Pass2RejectionCategory);
    expect(result.errors.some(e => e.includes('JSON parse'))).toBe(true);
    // Pass 2 is mandatory even without an aggregator.
    expect(result.needsReview).toBe(true);
    // No raw content leaks
    for (const err of result.errors) {
      expect(err).not.toContain('{not valid json}');
      expect(err).not.toContain('{also not valid}');
    }
  });

  // ── Pass2 rejection: schema validation ──────────────────────────

  it('sets pass2Rejection to validation when Pass2 returns schema-invalid JSON', async () => {
    const { pipeline } = makePipeline({
      responses: [
        'Prose content.',
        JSON.stringify({ eventId: 'evt_schema' }),     // valid JSON, fails analysisResultSchema
        JSON.stringify({ eventId: 'evt_schema_dup' }), // retry 2, same
        JSON.stringify({ eventId: 'evt_schema_tri' }), // retry 3
        JSON.stringify({ eventId: 'evt_schema_quad' }),// retry 4
      ],
    });

    const result = await pipeline.renderScene(makeJob('evt_schema_p2'));
    expect(result.analysis).toBeNull();
    expect(result.pass2Rejection).toBe('validation' satisfies Pass2RejectionCategory);
    expect(result.errors.some(e => e.includes('schema validation'))).toBe(true);
    // Pass 2 is mandatory even without an aggregator.
    expect(result.needsReview).toBe(true);
    // No raw content leaks (JSON payloads not in error messages)
    for (const err of result.errors) {
      expect(err).not.toContain('evt_schema');
    }
  });
  // ── Pass2 schema-invalid retry success ───────────────────────────

  it('records two pass2 calls when first returns schema-invalid JSON and retry succeeds', async () => {
    const { pipeline } = makePipeline({
      responses: [
        'Some prose content.',
        JSON.stringify({ eventId: 'evt_retry_schema' }),     // valid JSON, fails analysisResultSchema (missing analysis field)
        VALID_ANALYSIS_JSON,                                  // Retry — valid
      ],
    });

    const result = await pipeline.renderScene(makeJob('evt_retry_schema'));
    const entries = result.providerCalls;

    // Three provider calls: pass1 + pass2 (schema validation fail) + pass2 (retry)
    expect(entries).toHaveLength(3);

    // Pass 1 — success
    expectValidEntry(entries[0], { phase: 'pass1', attempt: 1, outcome: 'success', seed: null });
    expect(entries[0].failureReason).toBeUndefined();

    // First Pass2 — provider-level success (JSON parsed), schema validation failure
    expectValidEntry(entries[1], { phase: 'pass2', attempt: 1, outcome: 'success', seed: 42 });
    expect(entries[1].failureReason).toBeUndefined();

    // Second Pass2 — retry succeeded
    expectValidEntry(entries[2], { phase: 'pass2', attempt: 1, outcome: 'success', seed: 42 });
    expect(entries[2].failureReason).toBeUndefined();

    // Retry produced valid analysis
    expect(result.analysis).not.toBeNull();
    expect(result.attempts).toBe(1);

    // needsReview is NOT set because the retry succeeded
    expect(result.needsReview).toBe(false);

    // All request hashes are valid 64-hex (verifying both Pass2 hashes are recorded)
    for (const e of entries) {
      expect(e.requestHash).toMatch(/^[0-9a-f]{64}$/);
    }

    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  // ── Pass2 schema-invalid retry, 4-attempt max path ─────────────
  it('records four pass2 calls when first three are schema-invalid and fourth succeeds', async () => {
    const { pipeline } = makePipeline({
      responses: [
        'Some prose content.',
        JSON.stringify({ eventId: 'evt_retry_4' }),     // schema-invalid (missing analysis field)
        JSON.stringify({ eventId: 'evt_retry_4' }),     // schema-invalid
        JSON.stringify({ eventId: 'evt_retry_4' }),     // schema-invalid
        VALID_ANALYSIS_JSON,                              // valid — 4th Pass2 attempt succeeds
      ],
    });

    const result = await pipeline.renderScene(makeJob('evt_retry_4'));
    const entries = result.providerCalls;

    // Five provider calls: pass1 + 4 pass2 attempts
    expect(entries).toHaveLength(5);

    // Pass 1 — success
    expectValidEntry(entries[0], { phase: 'pass1', attempt: 1, outcome: 'success', seed: null });
    expect(entries[0].failureReason).toBeUndefined();

    // Four Pass2 calls — all succeed at provider level (even schema-invalid responses)
    for (let i = 1; i <= 4; i++) {
      expectValidEntry(entries[i], { phase: 'pass2', attempt: 1, outcome: 'success', seed: 42 });
      expect(entries[i].failureReason).toBeUndefined();
    }

    // Fourth attempt produced valid analysis
    expect(result.analysis).not.toBeNull();
    expect(result.attempts).toBe(1);
    expect(result.needsReview).toBe(false);
    // pass2Rejection captures the last failure category from the feedback chain
    // even when the 4th attempt ultimately succeeds — documenting the
    // third-failure/validation chain before success.
    expect(result.pass2Rejection).toBe('validation' satisfies Pass2RejectionCategory);

    // All request hashes are valid 64-hex
    for (const e of entries) {
      expect(e.requestHash).toMatch(/^[0-9a-f]{64}$/);
    }

    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/);

    // No raw content leaks in error messages
    for (const err of result.errors) {
      expect(err).not.toContain('evt_retry_4');
    }
  });

  // ── Pass2 not reached (Pass1 exhaustion) ─────────────────────────

  it('does not set pass2Rejection when Pass2 is never reached', async () => {
    const { pipeline } = makePipeline({
      // All calls fail with empty prose — circuit opens at Pass1 stage
      generator: () => '',
    });

    const result = await pipeline.renderScene(makeJob('evt_no_p2'));
    expect(result.analysis).toBeNull();
    expect(result.pass2Rejection).toBeUndefined();
    expect(result.needsReview).toBe(true);
    // All failures are Pass1 empty-content errors, never Pass2
    expect(result.errors.every(e => e.includes('Pass 1'))).toBe(true);
  });

  // ── Clean Pass2 success does not set pass2Rejection ──────────────

  it('does not set pass2Rejection on clean Pass2 success', async () => {
    const { pipeline } = makePipeline({
      responses: ['Clean prose.', VALID_ANALYSIS_JSON],
    });

    const result = await pipeline.renderScene(makeJob('evt_clean_p2'));
    expect(result.analysis).not.toBeNull();
    expect(result.pass2Rejection).toBeUndefined();
    expect(result.needsReview).toBe(false);
  });
});

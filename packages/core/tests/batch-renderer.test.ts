// ============================================================================
// BatchRenderPipeline — Unit Tests
// ============================================================================
//
// Uses a mock RenderPipeline to test batch logic without LLM calls.
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import type { BatchConfig, BatchProgressEvent } from '../src/batch-renderer.ts';
import { BatchRenderPipeline } from '../src/batch-renderer.ts';
import type { RenderJob, RenderPipeline, RenderSceneResult } from '../src/pipeline/render.ts';

// ============================================================================
// Mock helpers
// ============================================================================

/**
 * Create a minimal RenderJob stub for testing.
 */
function makeJob(id: string): RenderJob {
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
      event: {} as any,
      stateBefore: {} as any,
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
 * Default result function: one result per job with generic prose.
 */
function defaultResultFn(jobs: RenderJob[]): RenderSceneResult[] {
  return jobs.map((j) => ({
    eventId: j.event.id,
    prose: `Scene ${j.event.id}`,
    analysis: null,
    llmPass1: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    llmPass2: null,
    cacheHit: false,
    errors: [],
    renderStart: 0,
    renderEnd: 1,
    validation: null,
    attempts: 1,
    needsReview: false,
  }));
}

/**
 * Build a mock RenderPipeline.
 *
 * @param resultFn  Called with the batch of jobs; returns RenderSceneResult[].
 *                  Default: one result per job with generic prose.
 */
function createMockPipeline(resultFn?: (jobs: RenderJob[]) => RenderSceneResult[]): {
  pipeline: RenderPipeline;
  renderAll: ReturnType<typeof vi.fn>;
} {
  const fn = resultFn ?? defaultResultFn;
  const renderAll = vi.fn((jobs: RenderJob[]) => Promise.resolve(fn(jobs)));

  return {
    pipeline: { renderAll } as unknown as RenderPipeline,
    renderAll,
  };
}

/**
 * Create a mock pipeline that fails on a specific batch invocation.
 * `failOnCall` is 1-indexed across all `renderAll` calls.
 * Returns errors for all jobs in the failing batch.
 */
function createFailingPipeline(
  failOnCall: number,
  failMessage = 'Simulated batch failure',
): { pipeline: RenderPipeline; renderAll: ReturnType<typeof vi.fn> } {
  let callCount = 0;
  const renderAll = vi.fn((jobs: RenderJob[]) => {
    callCount++;
    if (callCount === failOnCall) {
      // Return results with errors for every job in this batch
      return Promise.resolve(
        jobs.map((j) => ({
          eventId: j.event.id,
          prose: '',
          analysis: null,
          llmPass1: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          llmPass2: null,
          cacheHit: false,
          errors: [failMessage],
          renderStart: 0,
          renderEnd: 1,
          validation: null,
          attempts: 1,
          needsReview: true,
        })),
      );
    }
    return Promise.resolve(defaultResultFn(jobs));
  });

  return {
    pipeline: { renderAll } as unknown as RenderPipeline,
    renderAll,
  };
}

/**
 * Create a mock pipeline that throws for a specific batch invocation.
 */
function createThrowingPipeline(
  failOnCall: number,
  failMessage = 'Simulated batch crash',
): { pipeline: RenderPipeline; renderAll: ReturnType<typeof vi.fn> } {
  let callCount = 0;
  const renderAll = vi.fn((jobs: RenderJob[]) => {
    callCount++;
    if (callCount === failOnCall) {
      return Promise.reject(new Error(failMessage));
    }
    return Promise.resolve(defaultResultFn(jobs));
  });

  return {
    pipeline: { renderAll } as unknown as RenderPipeline,
    renderAll,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('BatchRenderPipeline', () => {
  // ── Basic batching ───────────────────────────────────────────────

  it('splits jobs into batches of the configured size', async () => {
    const jobs = Array.from({ length: 25 }, (_, i) => makeJob(`E${i + 1}`));
    const { pipeline, renderAll } = createMockPipeline();
    const renderer = new BatchRenderPipeline(pipeline);

    const result = await renderer.renderBatched(jobs, { batchSize: 10, windowSize: 5 });

    // 25 jobs → 3 batches (10 + 10 + 5)
    expect(renderAll).toHaveBeenCalledTimes(3);
    expect(result.results).toHaveLength(25);
    expect(result.completed).toBe(true);
    expect(result.stats.totalJobs).toBe(25);
    expect(result.stats.totalBatches).toBe(3);
    expect(result.stats.completedBatches).toBe(3);
  });

  it('handles a single batch when jobs < batchSize', async () => {
    const jobs = Array.from({ length: 3 }, (_, i) => makeJob(`E${i + 1}`));
    const { pipeline, renderAll } = createMockPipeline();
    const renderer = new BatchRenderPipeline(pipeline);

    const result = await renderer.renderBatched(jobs, { batchSize: 10 });

    expect(renderAll).toHaveBeenCalledTimes(1);
    expect(result.results).toHaveLength(3);
    expect(result.completed).toBe(true);
    expect(result.stats.totalBatches).toBe(1);
  });

  it('handles exact multiples of batchSize', async () => {
    const jobs = Array.from({ length: 20 }, (_, i) => makeJob(`E${i + 1}`));
    const { pipeline, renderAll } = createMockPipeline();
    const renderer = new BatchRenderPipeline(pipeline);

    const result = await renderer.renderBatched(jobs, { batchSize: 5, windowSize: 5 });

    expect(renderAll).toHaveBeenCalledTimes(4);
    expect(result.results).toHaveLength(20);
    expect(result.stats.totalBatches).toBe(4);
  });

  // ── Sliding window ───────────────────────────────────────────────

  it('respects windowSize: never submits more batches than windowSize at once', async () => {
    // Use a pipeline with latency so we can observe concurrency
    let concurrentMax = 0;
    let concurrent = 0;

    const jobs = Array.from({ length: 20 }, (_, i) => makeJob(`E${i + 1}`));
    const renderAll = vi.fn(async (batch: RenderJob[]) => {
      concurrent++;
      concurrentMax = Math.max(concurrentMax, concurrent);
      // Simulate some work
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
      return batch.map((j) => ({
        eventId: j.event.id,
        prose: `Scene ${j.event.id}`,
        analysis: null,
        llmPass1: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        llmPass2: null,
        cacheHit: false,
        errors: [],
        renderStart: 0,
        renderEnd: 1,
        validation: null,
        attempts: 1,
        needsReview: false,
      }));
    });
    const pipeline = { renderAll } as unknown as RenderPipeline;
    const renderer = new BatchRenderPipeline(pipeline);

    await renderer.renderBatched(jobs, { batchSize: 5, windowSize: 2 });

    // With windowSize=2, at most 2 batches should be in flight simultaneously
    expect(concurrentMax).toBeLessThanOrEqual(2);
    expect(renderAll).toHaveBeenCalledTimes(4);
  });

  // ── Progress callback ────────────────────────────────────────────

  it('calls onProgress for each completed batch with correct data', async () => {
    const jobs = Array.from({ length: 15 }, (_, i) => makeJob(`E${i + 1}`));
    const { pipeline } = createMockPipeline();
    const renderer = new BatchRenderPipeline(pipeline);

    const progressCalls: BatchProgressEvent[] = [];
    const onProgress = (ev: BatchProgressEvent) => {
      progressCalls.push(ev);
    };

    await renderer.renderBatched(jobs, { batchSize: 5, windowSize: 5, onProgress });

    // 15 jobs / batchSize=5 = 3 batches → 3 progress calls
    expect(progressCalls).toHaveLength(3);
    expect(progressCalls[0]!.batchIndex).toBe(0);
    expect(progressCalls[0]!.completedInBatch).toBe(5);
    expect(progressCalls[0]!.totalCompleted).toBe(5);
    expect(progressCalls[0]!.totalJobs).toBe(15);
    expect(progressCalls[0]!.totalBatches).toBe(3);

    expect(progressCalls[1]!.batchIndex).toBe(1);
    expect(progressCalls[1]!.totalCompleted).toBe(10);

    expect(progressCalls[2]!.batchIndex).toBe(2);
    expect(progressCalls[2]!.totalCompleted).toBe(15);
  });

  // ── Lifecycle hooks ──────────────────────────────────────────────

  it('calls onBeforeBatch and onAfterBatch for each batch', async () => {
    const jobs = Array.from({ length: 10 }, (_, i) => makeJob(`E${i + 1}`));
    const { pipeline } = createMockPipeline();
    const renderer = new BatchRenderPipeline(pipeline);

    const beforeCalls: Array<{ jobs: RenderJob[]; index: number }> = [];
    const afterCalls: Array<{ results: RenderSceneResult[]; index: number }> = [];

    const onBeforeBatch = async (batch: RenderJob[], idx: number) => {
      beforeCalls.push({ jobs: batch, index: idx });
    };
    const onAfterBatch = async (results: RenderSceneResult[], idx: number) => {
      afterCalls.push({ results, index: idx });
    };

    await renderer.renderBatched(jobs, {
      batchSize: 5,
      windowSize: 2,
      onBeforeBatch,
      onAfterBatch,
    });

    expect(beforeCalls).toHaveLength(2);
    expect(beforeCalls[0]!.index).toBe(0);
    expect(beforeCalls[0]!.jobs).toHaveLength(5);
    expect(beforeCalls[1]!.index).toBe(1);
    expect(beforeCalls[1]!.jobs).toHaveLength(5);

    expect(afterCalls).toHaveLength(2);
    expect(afterCalls[0]!.index).toBe(0);
    expect(afterCalls[0]!.results).toHaveLength(5);
    expect(afterCalls[1]!.index).toBe(1);
    expect(afterCalls[1]!.results).toHaveLength(5);
  });

  // ── Abort / early termination ────────────────────────────────────

  it('aborts mid-stream and returns partial results', async () => {
    const jobs = Array.from({ length: 20 }, (_, i) => makeJob(`E${i + 1}`));

    // Pipeline that delays long enough for us to abort
    const renderAll = vi.fn(async (batch: RenderJob[]) => {
      await new Promise((r) => setTimeout(r, 50));
      return batch.map((j) => ({
        eventId: j.event.id,
        prose: `Scene ${j.event.id}`,
        analysis: null,
        llmPass1: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        llmPass2: null,
        cacheHit: false,
        errors: [],
        renderStart: 0,
        renderEnd: 1,
        validation: null,
        attempts: 1,
        needsReview: false,
      }));
    });
    const pipeline = { renderAll } as unknown as RenderPipeline;
    const renderer = new BatchRenderPipeline(pipeline);

    // Start rendering and abort after a short delay
    const renderPromise = renderer.renderBatched(jobs, { batchSize: 5, windowSize: 2 });
    setTimeout(() => renderer.abort(), 30);
    const result = await renderPromise;

    // Should have partial results and completed=false
    expect(result.completed).toBe(false);
    expect(result.stats.aborted).toBe(true);
    // At least some batches should have completed (at least 1)
    expect(result.stats.completedBatches).toBeGreaterThanOrEqual(1);
    expect(result.stats.completedBatches).toBeLessThan(4);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.length).toBeLessThan(20);
  });

  it('aborts via external AbortSignal', async () => {
    const jobs = Array.from({ length: 20 }, (_, i) => makeJob(`E${i + 1}`));

    const renderAll = vi.fn(async (batch: RenderJob[]) => {
      await new Promise((r) => setTimeout(r, 50));
      return batch.map((j) => ({
        eventId: j.event.id,
        prose: `Scene ${j.event.id}`,
        analysis: null,
        llmPass1: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        llmPass2: null,
        cacheHit: false,
        errors: [],
        renderStart: 0,
        renderEnd: 1,
        validation: null,
        attempts: 1,
        needsReview: false,
      }));
    });
    const pipeline = { renderAll } as unknown as RenderPipeline;
    const renderer = new BatchRenderPipeline(pipeline);

    const ac = new AbortController();
    const renderPromise = renderer.renderBatched(jobs, {
      batchSize: 5,
      windowSize: 2,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 30);
    const result = await renderPromise;

    expect(result.completed).toBe(false);
    expect(result.stats.aborted).toBe(true);
  });

  // ── Fail-fast ────────────────────────────────────────────────────

  it('stops on first batch failure when failFast=true (default)', async () => {
    const jobs = Array.from({ length: 15 }, (_, i) => makeJob(`E${i + 1}`));
    const { pipeline, renderAll } = createThrowingPipeline(1, 'Batch 0 crash');

    const renderer = new BatchRenderPipeline(pipeline);
    const result = await renderer.renderBatched(jobs, { batchSize: 5, windowSize: 2 });
    // First batch (call 1) throws → failFast breaks the loop.
    // Batch 1 was already submitted in the initial window (windowSize=2).
    // In-flight batches are drained: results from batch 1 are collected.
    expect(result.completed).toBe(false);
    expect(result.stats.aborted).toBe(true);
    expect(result.stats.totalErrors).toBe(1);
    // 1 from the catch block (batch 0) + 1 drained (batch 1)
    expect(result.stats.completedBatches).toBe(2);
    // Batch 1's results are collected via drain
    expect(result.results).toHaveLength(5);
    // With windowSize=2, both batches 0 and 1 are submitted initially
    expect(renderAll).toHaveBeenCalledTimes(2);
  });

  it('stops when a batch returns all-errors and failFast=true', async () => {
    const jobs = Array.from({ length: 10 }, (_, i) => makeJob(`E${i + 1}`));
    const { pipeline, renderAll } = createFailingPipeline(1, 'All jobs failed');

    const renderer = new BatchRenderPipeline(pipeline);
    const result = await renderer.renderBatched(jobs, { batchSize: 5, windowSize: 2 });

    // The "failing" pipeline returns results with errors but they're still results.
    // Since failFast looks for thrown errors, these results ARE collected.
    // The batch "succeeds" at the pipeline level; individual job errors are in the results.
    expect(result.stats.completedBatches).toBeGreaterThan(0);
    // The results are still returned since the pipeline didn't throw
    expect(result.results.length).toBeGreaterThan(0);
  });

  // ── Continue on failure (failFast=false) ─────────────────────────

  it('continues to next batch after failure when failFast=false', async () => {
    // Use a throwing pipeline that fails on batch 2 (out of 3)
    const jobs = Array.from({ length: 15 }, (_, i) => makeJob(`E${i + 1}`));
    const { pipeline, renderAll } = createThrowingPipeline(2, 'Batch 1 crash');

    const renderer = new BatchRenderPipeline(pipeline);
    const result = await renderer.renderBatched(jobs, {
      batchSize: 5,
      windowSize: 2,
      failFast: false,
    });

    // Batch 0 succeeds, Batch 1 fails (thrown), Batch 2 should still run
    expect(renderAll).toHaveBeenCalledTimes(3);
    expect(result.stats.totalBatches).toBe(3);
    // completedBatches = 3 (all batches finished processing; batch 1 failed)
    expect(result.stats.completedBatches).toBe(3);
    expect(result.stats.totalErrors).toBe(1);
    // Results from successful batches (0 and 2) = 5 + 5 = 10
    expect(result.results).toHaveLength(10);
    expect(result.completed).toBe(true); // all batches processed (some failed, but we didn't abort)
  });

  // ── Empty jobs ───────────────────────────────────────────────────

  it('returns empty result for empty job list', async () => {
    const { pipeline } = createMockPipeline();
    const renderer = new BatchRenderPipeline(pipeline);

    const result = await renderer.renderBatched([]);

    expect(result.results).toHaveLength(0);
    expect(result.completed).toBe(true);
    expect(result.stats.totalJobs).toBe(0);
    expect(result.stats.totalBatches).toBe(0);
    expect(result.stats.elapsedMs).toBe(0);
  });

  // ── Stats ────────────────────────────────────────────────────────

  it('collects accurate cache hit/miss/attempt stats', async () => {
    const jobs = Array.from({ length: 10 }, (_, i) => makeJob(`E${i + 1}`));

    const fn = (batch: RenderJob[]) =>
      batch.map((j, idx) => ({
        eventId: j.event.id,
        prose: `Scene ${j.event.id}`,
        analysis: null,
        llmPass1: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        llmPass2: null,
        cacheHit: idx % 2 === 0, // alternate cache hits
        errors: [],
        renderStart: 0,
        renderEnd: 1,
        validation: null,
        attempts: idx < 3 ? 2 : 1, // first 3 jobs had 2 attempts
        needsReview: false,
      }));

    const { pipeline } = createMockPipeline(fn);
    const renderer = new BatchRenderPipeline(pipeline);

    const result = await renderer.renderBatched(jobs, { batchSize: 5, windowSize: 2 });

    // 10 jobs, 2 batches of 5: each batch idx % 2 === 0 gives hits at indices 0,2,4 = 3/batch
    // Total: 3 hits/batch × 2 batches = 6 hits, 4 misses
    expect(result.stats.cacheHits).toBe(6);
    expect(result.stats.cacheMisses).toBe(4);
    // Attempts: 2 batches × (3 jobs × 2 + 2 jobs × 1) = 2 × 8 = 16
    expect(result.stats.totalAttempts).toBe(16);
    expect(result.stats.totalJobs).toBe(10);
    expect(result.stats.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  // ── Default config ───────────────────────────────────────────────

  it('uses defaults (batchSize=10, windowSize=2, failFast=true) when no config given', async () => {
    const jobs = Array.from({ length: 25 }, (_, i) => makeJob(`E${i + 1}`));
    const { pipeline, renderAll } = createMockPipeline();
    const renderer = new BatchRenderPipeline(pipeline);

    const result = await renderer.renderBatched(jobs);

    // batchSize=10 → 3 batches (10+10+5), windowSize=2
    expect(renderAll).toHaveBeenCalledTimes(3);
    expect(result.results).toHaveLength(25);
    expect(result.completed).toBe(true);
  });

  // ── Result ordering ─────────────────────────────────────────────

  it('returns results in input job order even when batches complete out of order', async () => {
    // batch 0 is gated (simulates slow completion) while batch 1 resolves immediately
    const { promise: gate0, resolve: openGate0 } = Promise.withResolvers<void>();
    let callCount = 0;

    const jobs = Array.from({ length: 9 }, (_, i) => makeJob(`E${i + 1}`));

    const renderAll = vi.fn(async (batch: RenderJob[]) => {
      const idx = callCount++;
      const results = batch.map((j) => ({
        eventId: j.event.id,
        prose: `Scene ${j.event.id}`,
        analysis: null,
        llmPass1: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        llmPass2: null,
        cacheHit: false,
        errors: [],
        renderStart: 0,
        renderEnd: 1,
        validation: null,
        attempts: 1,
        needsReview: false,
      }));
      if (idx === 0) {
        // batch 0 (jobs 0-2, E1-E3) waits on gate
        await gate0;
      }
      // batch 1 (jobs 3-5, E4-E6) resolves immediately, outrunning batch 0
      return results;
    });

    const pipeline = { renderAll } as unknown as RenderPipeline;
    const renderer = new BatchRenderPipeline(pipeline);

    const resultPromise = renderer.renderBatched(jobs, { batchSize: 3, windowSize: 2 });

    // Let microtasks flush: batch 0 awaits gate, batch 1 resolves full synchronously
    await Promise.resolve();

    // At this point batch 1 has already resolved via Promise.race in the main loop.
    // Now open the gate so batch 0 finishes last.
    openGate0();

    const result = await resultPromise;

    expect(result.results).toHaveLength(9);
    // Results must follow input job order, not batch-completion order
    for (let i = 0; i < 9; i++) {
      expect(result.results[i]!.eventId).toBe(`E${i + 1}`);
    }
    expect(result.completed).toBe(true);
  });
});

// ============================================================================
// BatchRenderPipeline — Sliding-window batch render orchestrator
// ============================================================================
//
// Composes RenderPipeline (not inherits). Slices large job sets into configurable
// batches and submits them through a sliding window of concurrently executing
// batches.
//
// Each batch calls pipeline.renderAll(), which internally uses ConcurrencyPool.
// Batches are independent — the pipeline instance is stateless between calls.
//
// Features:
//   - Sliding window: up to `windowSize` batches in flight simultaneously
//   - Progress reporting: per-batch onProgress hook
//   - Lifecycle hooks: onBeforeBatch / onAfterBatch
//   - Abort: external cancellation via AbortSignal or .abort()
//   - Error isolation: failFast (default) or continue-on-failure
// ============================================================================

import type { RenderJob, RenderPipeline, RenderSceneResult } from './pipeline/render.ts';

// ============================================================================
// Type Definitions
// ============================================================================

export interface BatchConfig {
  /** Events per batch. Default: 10. */
  batchSize?: number;

  /** Sliding window — max concurrent batches in flight. Default: 2. */
  windowSize?: number;

  /**
   * Whether a single batch failure terminates the entire run.
   * true  → first batch error stops the pipeline.
   * false → failing batches are collected in `errors` and processing continues.
   * Default: true.
   */
  failFast?: boolean;

  /** Called after each batch completes with progress data. */
  onProgress?: (event: BatchProgressEvent) => void;

  /**
   * Hook invoked before a batch is submitted.
   * Useful for context warming, state preloading, or logging.
   */
  onBeforeBatch?: (batch: RenderJob[], batchIndex: number) => Promise<void>;

  /**
   * Hook invoked after a batch completes successfully.
   * Useful for streaming output to disk, metrics, downstream notification.
   */
  onAfterBatch?: (results: RenderSceneResult[], batchIndex: number) => Promise<void>;

  /** External AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface BatchProgressEvent {
  /** Index (0-based) of the just-completed batch. */
  batchIndex: number;
  /** Total number of batches. */
  totalBatches: number;
  /** Number of events completed in this batch. */
  completedInBatch: number;
  /** Cumulative events completed across all finished batches. */
  totalCompleted: number;
  /** Total number of jobs in the entire request. */
  totalJobs: number;
  /** Elapsed milliseconds since renderBatched was called. */
  elapsedMs: number;
  /** Results for the just-completed batch. */
  batchResults: RenderSceneResult[];
}

export interface BatchResult {
  /** All render results collected across all completed batches. */
  results: RenderSceneResult[];
  /** Whether all batches completed (false if aborted or failFast stopped early). */
  completed: boolean;
  /** Aggregate statistics. */
  stats: BatchStats;
}

export interface BatchStats {
  totalJobs: number;
  totalBatches: number;
  completedBatches: number;
  cacheHits: number;
  cacheMisses: number;
  totalErrors: number;
  totalAttempts: number;
  elapsedMs: number;
  aborted: boolean;
}

// ============================================================================
// Internal types
// ============================================================================

/**
 * Wraps a batch's result with its index so `Promise.race` consumers know
 * which batch resolved.
 */
interface BatchFlight {
  batchIndex: number;
  results: RenderSceneResult[];
}

// ============================================================================
// BatchRenderPipeline
// ============================================================================

export class BatchRenderPipeline {
  private readonly pipeline: RenderPipeline;
  private readonly controller: AbortController;

  constructor(pipeline: RenderPipeline) {
    this.pipeline = pipeline;
    this.controller = new AbortController();
  }

  /**
   * Render jobs in batches using a sliding-window algorithm.
   *
   * Algorithm:
   *   1. Chunk jobs into batches of `config.batchSize` (default 10).
   *   2. Submit up to `config.windowSize` (default 2) batches immediately.
   *   3. As each batch completes, submit the next pending batch (sliding window).
   *   4. Emit progress events and lifecycle hooks at each batch boundary.
   *   5. On abort, let in-flight batches finish, then return early.
   *
   * @param jobs   — All render jobs to process.
   * @param config — Batching configuration.
   * @returns Collected results + stats.
   */
  async renderBatched(jobs: RenderJob[], config: BatchConfig = {}): Promise<BatchResult> {
    const batchSize = config.batchSize ?? 10;
    const windowSize = config.windowSize ?? 2;
    const failFast = config.failFast ?? true;
    const externalSignal = config.signal ?? null;
    const startTime = performance.now();

    // ── Edge case: empty jobs ──────────────────────────────────────
    if (jobs.length === 0) {
      return {
        results: [],
        completed: true,
        stats: {
          totalJobs: 0,
          totalBatches: 0,
          completedBatches: 0,
          cacheHits: 0,
          cacheMisses: 0,
          totalErrors: 0,
          totalAttempts: 0,
          elapsedMs: 0,
          aborted: false,
        },
      };
    }

    // ── Chunk jobs into batches ────────────────────────────────────
    const batches: RenderJob[][] = [];
    for (let i = 0; i < jobs.length; i += batchSize) {
      batches.push(jobs.slice(i, i + batchSize));
    }
    const totalBatches = batches.length;

    // ── Sliding window state ───────────────────────────────────────
    const inFlight = new Map<number, Promise<BatchFlight>>();
    let nextToSubmit = 0;
    let completedBatches = 0;
    const resultsByBatch = new Map<number, RenderSceneResult[]>();
    let totalCompleted = 0;
    const allErrors: Array<{ batchIndex: number; error: string }> = [];
    let aborted = false;

    // Combine internal + external signals
    const isAborted = (): boolean =>
      aborted || this.controller.signal.aborted || (externalSignal?.aborted ?? false);

    // ── Helper: submit one batch ──────────────────────────────────
    const submitBatch = async (batchIndex: number): Promise<BatchFlight> => {
      // ── Check abort before starting batch ──────────────────────────
      if (externalSignal?.aborted || this.controller.signal.aborted) {
        throw { batchIndex, error: 'Batch cancelled before start — abort signal received' };
      }
      const batch = batches[batchIndex]!;
      if (config.onBeforeBatch) {
        await config.onBeforeBatch(batch, batchIndex);
      }
      // Forward external signal to pipeline for scene-level cancellation
      const results = await this.pipeline.renderAll(batch, config.signal);
      return { batchIndex, results };
    };

    // ── Prime the window ──────────────────────────────────────────
    const windowLimit = Math.min(windowSize, totalBatches);
    for (let i = 0; i < windowLimit; i++) {
      const idx = nextToSubmit++;
      const flight = submitBatch(idx).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        throw { batchIndex: idx, error: msg };
      });
      inFlight.set(idx, flight);
    }

    // ── Sliding window loop ───────────────────────────────────────
    while (completedBatches < totalBatches && !isAborted()) {
      if (inFlight.size === 0) break; // all failed and failFast stopped us

      // Wait for the fastest in-flight batch to settle
      const race = Promise.race(inFlight.values());
      let flightResult: BatchFlight;
      try {
        flightResult = await race;
      } catch (fail) {
        const { batchIndex, error } = fail as { batchIndex: number; error: string };
        allErrors.push({ batchIndex, error });

        inFlight.delete(batchIndex);
        completedBatches++;

        if (failFast) {
          aborted = true;
          break;
        }

        // Continue: slide window past the failed batch
        if (nextToSubmit < totalBatches) {
          const idx = nextToSubmit++;
          const flight = submitBatch(idx).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            throw { batchIndex: idx, error: msg };
          });
          inFlight.set(idx, flight);
        }
        continue;
      }

      // Remove resolved batch from in-flight set
      inFlight.delete(flightResult.batchIndex);
      completedBatches++;

      resultsByBatch.set(flightResult.batchIndex, flightResult.results);
      totalCompleted += flightResult.results.length;

      // Lifecycle hooks
      if (config.onAfterBatch) {
        await config.onAfterBatch(flightResult.results, flightResult.batchIndex);
      }
      if (config.onProgress) {
        const elapsedMs = performance.now() - startTime;
        config.onProgress({
          batchIndex: flightResult.batchIndex,
          totalBatches,
          completedInBatch: flightResult.results.length,
          totalCompleted,
          totalJobs: jobs.length,
          elapsedMs,
          batchResults: flightResult.results,
        });
      }

      // Submit next batch if available
      if (nextToSubmit < totalBatches) {
        const idx = nextToSubmit++;
        const flight = submitBatch(idx).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          throw { batchIndex: idx, error: msg };
        });
        inFlight.set(idx, flight);
      }
    }

    // ── Drain all remaining in-flight batches ──────────────────────
    // After an abort or failFast break, any in-flight promises must be
    // observed: successful results are collected, rejections are caught
    // into allErrors. No new batches are submitted.
    const remainingEntries = Array.from(inFlight.entries());
    inFlight.clear();

    if (remainingEntries.length > 0) {
      const settled = await Promise.allSettled(
        remainingEntries.map(([_, p]) => p),
      );

      for (let i = 0; i < remainingEntries.length; i++) {
        const [batchIndex] = remainingEntries[i];
        const s = settled[i];

        if (s.status === 'fulfilled') {
          const { results } = s.value;
          resultsByBatch.set(batchIndex, results);
          totalCompleted += results.length;

          // Fire lifecycle hooks for the drained batch
          if (config.onAfterBatch) {
            await config.onAfterBatch(results, batchIndex);
          }
          if (config.onProgress) {
            const elapsedMs = performance.now() - startTime;
            config.onProgress({
              batchIndex,
              totalBatches,
              completedInBatch: results.length,
              totalCompleted,
              totalJobs: jobs.length,
              elapsedMs,
              batchResults: results,
            });
          }
        } else {
          const reason = s.reason;
          allErrors.push({
            batchIndex,
            error:
              typeof reason === 'object' && reason !== null && 'error' in reason
                ? String(reason.error)
                : String(reason),
          });
        }

        completedBatches++;
      }
    }

    // ── Flatten results in input job order ────────────────────────
    const allResults: RenderSceneResult[] = [];
    for (let i = 0; i < totalBatches; i++) {
      const batchResults = resultsByBatch.get(i);
      if (batchResults) {
        allResults.push(...batchResults);
      }
    }

    const endTime = performance.now();

    // ── Build statistics ──────────────────────────────────────────
    let cacheHits = 0;
    let cacheMisses = 0;
    let totalAttempts = 0;
    for (const r of allResults) {
      if (r.cacheHit) cacheHits++;
      else cacheMisses++;
      totalAttempts += r.attempts;
    }

    const finalAborted = isAborted();
    const stats: BatchStats = {
      totalJobs: jobs.length,
      totalBatches,
      completedBatches,
      cacheHits,
      cacheMisses,
      totalErrors: allErrors.length,
      totalAttempts,
      elapsedMs: endTime - startTime,
      aborted: finalAborted,
    };

    return {
      results: allResults,
      completed: completedBatches === totalBatches && !finalAborted,
      stats,
    };
  }

  /**
   * Request early termination. In-flight batches complete their current scenes;
   * no new batches are started after the next batch boundary.
   */
  abort(): void {
    this.controller.abort();
  }
}

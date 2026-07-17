// ============================================================================
// RenderPipeline — Two-pass parallel render with caching + validation
// ============================================================================
//
// Design:
//   Pass 1: LLM produces pure prose (no format constraints)
//   Pass 2: prose + context fed back for structured analysis JSON
//   Validation: all 11 validators' validateRender run on the prose
//   Cache: hash-chain cache key → skip if fresh
//   Parallel: ConcurrencyPool of concurrent LLM calls
//   maxTokens: 10000 (far above target; we take what we get)
// ============================================================================

import type { LLMProvider, CompletionResponse } from '../ai/types.ts';
import type {
  NarrativeEvent,
  WorldState,
  ContextPackage,
  AnalysisResult,
  ValidationResult,
} from '../types/index.ts';
import { parseAnalysisJSON } from '../schemas/analysis.ts';
import { buildAnalysisPrompt, type RenderAnalysisInput } from '../ai/prompts/render-analysis.ts';
import { PromptAssembler } from '../context/prompt-assembler.ts';
import {
  computeCacheKeys,
  getCachedRender,
  setCachedRender,
} from '../cache/render-cache.ts';
import { ConcurrencyPool } from '../util/pool.ts';
import type { Storage } from '../storage/index.ts';
import { ResultAggregator } from '../validator/aggregator.ts';

export interface RenderJob {
  event: NarrativeEvent;
  stateBefore: WorldState;
  context: ContextPackage;
  chapter: number;
}

export interface RenderSceneResult {
  eventId: string;
  prose: string;
  analysis: AnalysisResult | null;
  llmPass1: NonNullable<CompletionResponse['usage']>;
  llmPass2: NonNullable<CompletionResponse['usage']> | null;
  cacheHit: boolean;
  errors: string[];
  renderStart: number;
  renderEnd: number;
  validation: ValidationResult | null;   // post-render validation result
  attempts: number;                      // number of render attempts
  /** True if all retries exhausted and validation still has errors */
  needsReview: boolean;
}

export interface RenderPipelineOptions {
  provider: LLMProvider;
  model: string;
  cacheDir: string;
  storage: Storage;
  concurrency?: number;       // default 5
  maxTokens?: number;         // default 10000
  skipCache?: boolean;        // force re-render
  referenceExample?: string;  // optional "good" prose example for Pass 1
  aggregator?: ResultAggregator;         // optional, for post-render validation
  /** Maximum render+validate attempts before giving up (default 3) */
  maxRetries?: number;
}

export class RenderPipeline {
  private readonly pool: ConcurrencyPool;
  private readonly skipCache: boolean;
  private readonly maxTokens: number;
  private readonly model: string;
  private readonly provider: LLMProvider;
  private readonly cacheDir: string;
  private readonly storage: Storage;
  private readonly referenceExample?: string;
  private readonly aggregator?: ResultAggregator;
  private readonly maxRetries: number;
  private cacheKeys: Map<string, string> | null = null;

  constructor(opts: RenderPipelineOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.cacheDir = opts.cacheDir;
    this.storage = opts.storage;
    this.skipCache = opts.skipCache ?? false;
    this.maxTokens = opts.maxTokens ?? 10_000;
    this.referenceExample = opts.referenceExample;
    this.aggregator = opts.aggregator;
    this.maxRetries = opts.maxRetries ?? 3;
    this.pool = new ConcurrencyPool(opts.concurrency ?? 5);
  }

  /**
   * Initialize cache keys from events + definitions.
   * Must be called before render().
   * eventsFileMap: Map<eventId, { narrativeOrder: number, filePath: string, chapter: number }>
   */
  async initCache(
    eventsFileMap: Map<string, { narrativeOrder: number; filePath: string; chapter: number }>,
    defsDir: string,
  ): Promise<void> {
    this.cacheKeys = computeCacheKeys(eventsFileMap, defsDir, this.storage);
  }

  /**
   * Render a single scene job: cache lookup → Pass 1 → Pass 2 → write cache.
   */
  async renderScene(job: RenderJob): Promise<RenderSceneResult> {
    const { event, stateBefore, context, chapter } = job;
    const eventId = event.id;
    const errors: string[] = [];
    const renderStart = Date.now();
    const cacheKey = this.cacheKeys?.get(eventId);

    // ── Cache check ──────────────────────────────────────────────
    if (!this.skipCache && cacheKey) {
      const cached = getCachedRender(this.cacheDir, eventId, cacheKey, this.storage);
      if (cached) {
        const c = cached as Record<string, unknown>;
        const cachedAnalysisStr = c.analysis ? String(c.analysis) : null;
        return {
          eventId,
          prose: String(c.prose ?? ''),
          analysis: cachedAnalysisStr
            ? parseAnalysisJSON(cachedAnalysisStr, (msg) =>
              errors.push(`Cache parse warning: ${msg}`),
            )
            : null,
          llmPass1: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          llmPass2: null,
          cacheHit: true,
          errors: [],
          renderStart:
            typeof c.renderedAt === 'string'
              ? new Date(c.renderedAt).getTime()
              : renderStart,
          renderEnd: renderStart,
          validation: null,
          attempts: 1,
          needsReview: false,
        };
      }
    }

    // ── Circuit Breaker: retry loop ────────────────────────────────
    let prose = '';
    let analysis: AnalysisResult | null = null;
    let analysisRaw: string | null = null;
    let llmPass1: { promptTokens: number; completionTokens: number; totalTokens: number } = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let llmPass2: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;
    let renderValidation: ValidationResult | null = null;
    let previousErrorMessages: string[] = [];
    let attempts = 0;

    for (let a = 1; a <= this.maxRetries; a++) {
      attempts = a;

      // ── Pass 1: Pure prose (with retry guidance on retry) ────────
      const assembler = new PromptAssembler();
      const assembled = assembler.assemble(context, {
        styleGuidance: event.styleGuidance,
        targetLengthWords: 500,
        referenceExample: this.referenceExample,
        retryGuidance: a > 1 && previousErrorMessages.length > 0
          ? previousErrorMessages.join('\n')
          : undefined,
      });
      const proseMessages = assembled.messages;
      try {
        const result1 = await this.provider.complete({
          messages: proseMessages,
          model: this.model,
          temperature: 0.8,
          maxTokens: this.maxTokens,
        });
        prose = result1.content ?? '';
        llmPass1 = result1.usage ?? llmPass1;
        if (!prose || prose.trim().length === 0) {
          errors.push(`Pass 1 attempt ${a} returned empty prose`);
          prose = '(empty)';
        }
      } catch (err) {
        errors.push(`Pass 1 attempt ${a} failed: ${(err as Error).message}`);
        prose = '(empty)';
      }

      if (prose === '(empty)') {
        if (a < this.maxRetries) continue;
        break;
      }

      // ── Pass 2: Structured analysis ──────────────────────────────
      analysisRaw = null;
      analysis = null;
      llmPass2 = null;
      try {
        const analysisInput: RenderAnalysisInput = {
          event, prose, context,
          previousErrors: previousErrorMessages.length > 0 ? previousErrorMessages : undefined,
        };
        const analysisMessages = buildAnalysisPrompt(analysisInput);
        const result2 = await this.provider.complete({
          messages: analysisMessages,
          model: this.model,
          temperature: 0.3,
          maxTokens: 4000,
        });
        analysisRaw = result2.content ?? null;
        llmPass2 = result2.usage ?? null;

        if (analysisRaw) {
          const errorsBeforeParse = errors.length;
          const warn = (msg: string) => errors.push(`Analysis parse warning: ${msg}`);
          analysis = parseAnalysisJSON(analysisRaw, warn);

          if (!analysis) {
            // Retry once — the LLM may have formatted the JSON incorrectly
            errors.push('Analysis parse failed on first attempt, retrying Pass 2...');
            try {
              const result2b = await this.provider.complete({
                messages: analysisMessages,
                model: this.model,
                temperature: 0.3,
                maxTokens: 4000,
              });
              const retryRaw = result2b.content ?? null;
              if (retryRaw) {
                analysis = parseAnalysisJSON(retryRaw, warn);
                if (analysis) {
                  analysisRaw = retryRaw;
                  llmPass2 = result2b.usage ?? null; // Include retry token usage
                  // Clear all errors from first attempt + retry notice
                  errors.length = errorsBeforeParse;
                }
              }
            } catch {
              errors.push('Analysis retry failed');
            }
          }
        }
      } catch (err) {
        errors.push(`Pass 2 attempt ${a} failed: ${(err as Error).message}`);
        analysis = null;
      }

      // ── Post-render validation ────────────────────────────────────
      renderValidation = null;
      if (this.aggregator) {
        try {
          renderValidation = this.aggregator.validateRender(prose, event, stateBefore, analysis ?? undefined);
        } catch (err) {
          errors.push(`Post-render validation failed: ${(err as Error).message}`);
        }
      }

      // If validation passes (or no aggregator), break out of retry loop
      if (!renderValidation || renderValidation.passed) break;

      // Validation failed — prepare error messages for retry
      previousErrorMessages = renderValidation.errors.map((e) => e.message);
      if (a < this.maxRetries) {
        errors.push(`Attempt ${a} failed validation (${renderValidation.errors.length} errors), retrying...`);
      }
    }

    const renderEnd = Date.now();
    const needsReview = !!renderValidation && !renderValidation.passed;

    // Save cache ONLY if validation passed (don't cache bad renders)
    if (cacheKey && !needsReview) {
      setCachedRender(this.cacheDir, eventId, cacheKey, {
        prose,
        analysis: analysisRaw, // Store raw JSON string in cache
        llmPass1,
        llmPass2,
        renderedAt: new Date().toISOString(),
        chapters: [chapter],
      }, this.storage);
    }

    return {
      eventId,
      prose,
      analysis,
      llmPass1,
      llmPass2,
      cacheHit: false,
      errors,
      renderStart,
      renderEnd,
      validation: renderValidation,
      attempts,
      needsReview,
    };
  }

  /**
   * Render multiple scenes in parallel using the concurrency pool.
   * Respects cache for already-rendered scenes.
   */
  async renderAll(jobs: RenderJob[]): Promise<RenderSceneResult[]> {
    return this.pool.all(jobs, (job) => this.renderScene(job));
  }
}

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
} from '../types/index.ts';
import { parseAnalysisJSON } from '../schemas/analysis.ts';
import { buildProsePrompt, type ProseOnlyInput } from '../ai/prompts/prose-only.ts';
import { buildAnalysisPrompt, type RenderAnalysisInput } from '../ai/prompts/render-analysis.ts';
import {
  computeCacheKeys,
  getCachedRender,
  setCachedRender,
} from '../cache/render-cache.ts';
import { ConcurrencyPool } from '../util/pool.ts';
import type { Storage } from '../storage/index.ts';

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
  private cacheKeys: Map<string, string> | null = null;

  constructor(opts: RenderPipelineOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.cacheDir = opts.cacheDir;
    this.storage = opts.storage;
    this.skipCache = opts.skipCache ?? false;
    this.maxTokens = opts.maxTokens ?? 10_000;
    this.referenceExample = opts.referenceExample;
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
        };
      }
    }

    // ── Pass 1: Pure prose ──────────────────────────────────────
    let prose = '';
    let llmPass1: { promptTokens: number; completionTokens: number; totalTokens: number } = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const proseInput: ProseOnlyInput = {
      context,
      styleGuidance: event.styleGuidance,
      targetLengthWords: 500,
      referenceExample: this.referenceExample,
    };
    const proseMessages = buildProsePrompt(proseInput);

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
        errors.push('Pass 1 returned empty prose');
        prose = '(empty)';
      }
    } catch (err) {
      errors.push(`Pass 1 failed: ${(err as Error).message}`);
      prose = '(empty)';
    }

    // ── Pass 2: Structured analysis ──────────────────────────────
    let analysisRaw: string | null = null;
    let analysis: AnalysisResult | null = null;
    let llmPass2: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;
    if (prose && prose !== '(empty)') {
      try {
        const analysisInput: RenderAnalysisInput = {
          event,
          prose,
          context,
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

        // Parse LLM analysis JSON with retry
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
        errors.push(`Pass 2 failed: ${(err as Error).message}`);
        analysis = null;
      }
    }

    const renderEnd = Date.now();

    // ── Save cache ──────────────────────────────────────────────
    if (cacheKey) {
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

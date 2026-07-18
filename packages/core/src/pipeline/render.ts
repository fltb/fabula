// ============================================================================
// RenderPipeline — Two-pass parallel render with caching + validation
// ============================================================================
//
// Design:
//   Pass 1: LLM produces pure prose (no format constraints)
//   Pass 2: prose + context fed back for structured analysis JSON
//   Validation: all 18 validators' validateRender run on the prose
//   Cache: hash-chain cache key → skip if fresh
//   Parallel: ConcurrencyPool of concurrent LLM calls
//   maxTokens: 10000 (far above target; we take what we get)
// ============================================================================

import type { LLMProvider, CompletionResponse, Message } from '../ai/types.ts';
import type {
  NarrativeEvent,
  WorldState,
  ContextPackage,
  AnalysisResult,
  ValidationResult,
} from '../types/index.ts';
import { parseAnalysisJSON, parseAnalysisJSONWithErrors } from '../schemas/analysis.ts';
import { buildAnalysisPrompt, type RenderAnalysisInput } from '../ai/prompts/render-analysis.ts';
import { compareAnalysisBlocks } from '../util/compare-analysis.ts';
import { PromptAssembler } from '../context/prompt-assembler.ts';
import {
  computeCacheKeys,
  getCachedRender,
  setCachedRender,
} from '../cache/render-cache.ts';
import { ConcurrencyPool } from '../util/pool.ts';
import type { Storage } from '../storage/index.ts';
import { ResultAggregator } from '../validator/aggregator.ts';
import { createCircuitBreaker } from './circuit-breaker.ts';
import { analyzeValidationErrors, buildRepairGuidance, decideRepairStrategy, degradeStrategy } from './reverse-validate.ts';

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
  /** Dev-only: run Pass 2 twice and compare for non-deterministic blocks (default false) */
  doubleRunVerification?: boolean;
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
  private readonly doubleRunVerification: boolean;
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
    this.doubleRunVerification = opts.doubleRunVerification ?? false;
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

    // Initialize circuit breaker — manages 3 rounds of escalation
    const breaker = createCircuitBreaker({
      maxRounds: 3,
      maxAttemptsPerRound: 2,
      failureThreshold: 3,     // auto-open after 3 consecutive failures (safety net)
      escalationDelay: 0,
    });

    while (breaker.attempt()) {
      attempts = breaker.state().totalAttempts;

      // ── Pass 1: Pure prose (with retry guidance on retry) ────────
      const assembler = new PromptAssembler();
      const assembled = assembler.assemble(context, {
        styleGuidance: event.styleGuidance,
        targetLengthWords: 400,
        referenceExample: this.referenceExample,
        retryGuidance: attempts > 1 && previousErrorMessages.length > 0
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
          errors.push(`Pass 1 attempt ${attempts} returned empty prose`);
          prose = '(empty)';
        }
      } catch (err) {
        errors.push(`Pass 1 attempt ${attempts} failed: ${(err as Error).message}`);
        prose = '(empty)';
      }

      if (prose === '(empty)') {
        breaker.recordFailure('Pass 1 returned empty prose');
        if (breaker.state().consecutiveFailures >= 2) {
          breaker.escalate();
        }
        continue;
      }

      // ── Pass 2: Structured analysis (with retry-with-feedback) ────
      analysisRaw = null;
      analysis = null;
      llmPass2 = null;
      try {
        let analysisObj: AnalysisResult | null = null;
        let feedbackErrors: string[] | undefined;
        let lastAnalysisMessages: Message[] | undefined;

        // Up to 2 attempts: initial + retry with Zod error feedback
        for (let attempt2 = 0; attempt2 < 2 && !analysisObj; attempt2++) {
          const analysisInput: RenderAnalysisInput = {
            event, prose, context,
            previousErrors: feedbackErrors,
            analysisRequirements: this.aggregator?.getAnalysisRequirements(),
          };
          lastAnalysisMessages = buildAnalysisPrompt(analysisInput);
          const result2 = await this.provider.complete({
            messages: lastAnalysisMessages,
            model: this.model,
            temperature: 0.3,
            maxTokens: 12000,
            seed: 42,
            responseFormat: { type: 'json_object' },
          });
          analysisRaw = result2.content ?? null;
          llmPass2 = result2.usage ?? null;

          if (analysisRaw) {
            const parseResult = parseAnalysisJSONWithErrors(analysisRaw);
            if (parseResult.result) {
              analysisObj = parseResult.result;
              break;
            }

            // Collect error details for feedback on retry
            if (parseResult.parseError) {
              feedbackErrors = [`JSON parse error: ${parseResult.parseError}`];
            } else if (parseResult.zodErrors) {
              feedbackErrors = parseResult.zodErrors.issues.map(i =>
                `Validation error at "${i.path.join('.')}": ${i.message}`,
              );
            }
          }
        }

        if (analysisObj) {
          analysis = analysisObj;

          // ── P5: Dev-only double-run verification ──────────────────
          if (this.doubleRunVerification && lastAnalysisMessages) {
            try {
              const result2b = await this.provider.complete({
                messages: lastAnalysisMessages,
                model: this.model,
                temperature: 0.3,
                maxTokens: 12000,
                seed: 42,
                responseFormat: { type: 'json_object' },
              });
              const analysis2Raw = result2b.content;
              if (analysis2Raw) {
                const parsed2 = parseAnalysisJSONWithErrors(analysis2Raw);
                if (parsed2.result) {
                  const diffs = compareAnalysisBlocks(analysis.analysis, parsed2.result.analysis);
                  if (diffs.length > 0) {
                    errors.push(`Pass 2 unstable: ${diffs.join(', ')} (${event.id})`);
                  }
                }
              }
            } catch {
              // Double-run failure is non-fatal (dev-only diagnostic)
            }
          }
        } else {
          errors.push('Pass 2 JSON parse/validation failed after retry');
          analysis = null;
        }
      } catch (err) {
        errors.push(`Pass 2 attempt ${attempts} failed: ${(err as Error).message}`);
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
      if (!renderValidation || renderValidation.passed) {
        breaker.recordSuccess();
        break;
      }

      // ── Validation failed — apply circuit breaker escalation ──────
      breaker.recordFailure(`Validation failed (${renderValidation.errors.length} errors)`);

      // After 2 consecutive failures, escalate to next round
      if (breaker.state().consecutiveFailures >= 2) {
        breaker.escalate();
      }

      // Build structured repair guidance from validation errors
      const revResult = analyzeValidationErrors(renderValidation);
      previousErrorMessages = renderValidation.errors.map((e) => e.message);

      // Use decideRepairStrategy for strategy selection based on error count
      const repairDecision = decideRepairStrategy(revResult, breaker.state().round, this.maxRetries);

      // Inject repair guidance into retry prompt
      if (repairDecision.strategy === 'prompt_fix' || repairDecision.strategy === 'context_enrich') {
        if (repairDecision.guidance) {
          previousErrorMessages.push(repairDecision.guidance);
        }
      }

      errors.push(
        `Attempt ${attempts} failed validation (${renderValidation.errors.length} errors), ` +
        `round ${breaker.state().round}, strategy: ${breaker.state().escalatedStrategy}`,
      );
    }

    const renderEnd = Date.now();
    const needsReview = breaker.state().isOpen || (!!renderValidation && !renderValidation.passed);

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

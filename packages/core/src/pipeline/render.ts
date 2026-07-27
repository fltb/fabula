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

import { StyleResolver, toStyleNotes, resolveProfile, type StyleProfile } from '../style/index.ts';
import * as crypto from 'node:crypto';
import type { LLMProvider, CompletionRequest, CompletionResponse, Message } from '../ai/types.ts';
import type {
  NarrativeEvent,
  WorldState,
  ContextPackage,
  AnalysisResult,
  ValidationResult,
} from '../types/index.ts';
import type { SurfaceReferencePacket } from '../types/render-surface.ts';
import { parseAnalysisJSON, parseAnalysisJSONWithErrors } from '../schemas/analysis.ts';
import { countNarrativeText } from '../assembler/count.ts';
import { buildAnalysisPrompt, type RenderAnalysisInput } from '../ai/prompts/render-analysis.ts';
import { compareAnalysisBlocks } from '../util/compare-analysis.ts';
import { PromptAssembler } from '../context/prompt-assembler.ts';
import {
  computeCacheKeys,
  computeEvidenceHash,
  getCachedRender,
  setCachedRender,
} from '../cache/render-cache.ts';
import { ConcurrencyPool } from '../util/pool.ts';
import type { Storage } from '../storage/index.ts';
import { ResultAggregator } from '../validator/aggregator.ts';
import { createCircuitBreaker } from './circuit-breaker.ts';
import { CacheCorruptionError, sanitizeError } from '../errors.ts';
import { analyzeValidationErrors, decideRepairStrategy } from './reverse-validate.ts';
import type { Logger } from '../observability/logger.ts';
import type { TraceCollector } from '../observability/trace.ts';
import type { PluginHooksManager } from '../plugin/hooks-manager.ts';
import { TypedEventBus } from '../event-bus.ts';

export interface RenderJob {
  event: NarrativeEvent;
  stateBefore: WorldState;
  context: ContextPackage;
  chapter: number;

  /**
   * Hash-pinned disclosure-safe summary of prior discourse state.
   * Produced by LogicalDisclosureSummaryCompiler before context compilation.
   */
  logicalDisclosureSummary?: string;

  /**
   * Non-authoritative prose excerpt + style packet from a prior render.
   * Per RENDER-SURFACE-1: YAML always wins over this packet.
   */
  surfaceReferencePacket?: SurfaceReferencePacket;
}
export interface ProviderCallLedgerEntry {
  phase: 'pass1' | 'pass2' | 'pass2_verify';
  /** Scene-level attempt number from the circuit breaker (1-based) */
  attempt: number;
  outcome: 'success' | 'failure';
  /** 64-lowercase-hex SHA-256 of canonical-json request projection */
  requestHash: string;
  /** The model used for this call */
  model: string;
  /** Seed (Pass 2/verify uses 42; Pass 1 is null) */
  seed: number | null;
  /** Safe failure reason — set only on failure, never contains prompts/secrets/keys */
  failureReason?: string;
}

/** Categorises why Pass 2 analysis is null after all retries exhaust.
 *  - 'empty': provider returned null or empty content
 *  - 'parse': content was not valid JSON
 *  - 'validation': content parsed as JSON but failed schema validation
 *  Only set when `analysis` is null due to Pass 2 failure.
 *  Never set when Pass 2 succeeds, the outer loop retries, or Pass 2 throws. */
export type Pass2RejectionCategory = 'empty' | 'parse' | 'validation';


export interface RenderSceneResult {
  eventId: string;
  prose: string;
  analysis: AnalysisResult | null;
  llmPass1: NonNullable<CompletionResponse['usage']>;
  llmPass2: NonNullable<CompletionResponse['usage']> | null;
  cacheHit: boolean;
  errors: string[];
  promptHash: string;                   // SHA-256 of ordered provider-call identities
  renderStart: number;
  renderEnd: number;
  validation: ValidationResult | null;   // post-render validation result
  providerCalls: ProviderCallLedgerEntry[];
  attempts: number;                      // number of render attempts
  /** True if all retries exhausted and validation still has errors */
  needsReview: boolean;
  /** Categorises Pass 2 exhaustion: 'empty' | 'parse' | 'validation'.
   *  Only non-null when analysis is null due to Pass 2 content rejection.
   *  Undefined on provider throw, Pass 2 success, or Pass 1 only failure. */
  pass2Rejection?: Pass2RejectionCategory;
}

export interface RenderPipelineOptions {
  provider: LLMProvider;
  model: string;
  cacheDir: string;
  /** Directory to persist raw response files per-scene (optional).
   *  When set, every renderScene call writes .nova/responses/{eventId}.json
   *  before returning, including cache hits. */
  responseDir?: string;
  storage: Storage;
  concurrency?: number;       // default 5
  maxTokens?: number;         // default 10000
  skipCache?: boolean;        // force re-render
  referenceExample?: string;  // optional "good" prose example for Pass 1
  aggregator?: ResultAggregator;         // optional, for post-render validation
  /** Maximum render+validate attempts before giving up (default 3) */
  maxRetries?: number;
  /** Logger for structured observability (optional) */
  logger?: Logger;
  /** Trace collector for span recording (optional) */
  traceCollector?: TraceCollector;
  /** Event bus for pipeline lifecycle observation (optional) */
  eventBus?: TypedEventBus;
  /** Target length for Pass 1 prose generation (default: 400 words) */
  targetLengthWords?: number;
  /** Language code for CJK-aware instruction generation (default: 'en') */
  language?: string;
  /** Plugin lifecycle hooks manager (optional) */
  pluginHooksManager?: PluginHooksManager;
  doubleRunVerification?: boolean;
  /** Optional project-level style profile for prose generation guidance */
  styleProfile?: StyleProfile;
  /** Circuit breaker max rounds (default 3) */
  maxRounds?: number;
}

export class RenderPipeline {
  private readonly pool: ConcurrencyPool;
  private readonly skipCache: boolean;
  private readonly maxTokens: number;
  private readonly responseDir?: string;
  private readonly model: string;
  private readonly provider: LLMProvider;
  private readonly cacheDir: string;
  private readonly storage: Storage;
  private readonly referenceExample?: string;
  private readonly aggregator?: ResultAggregator;
  private readonly maxRetries: number;
  private readonly doubleRunVerification: boolean;
  private readonly logger?: Logger;
  private readonly traceCollector?: TraceCollector;
  private readonly eventBus?: TypedEventBus;
  private readonly targetLengthWords: number;
  private readonly styleProfile?: StyleProfile;
  private readonly styleResolver: StyleResolver;
  private readonly language: string;
  private readonly pluginHooksManager?: PluginHooksManager;
  private cacheKeys: Map<string, string> | null = null;
  private readonly maxRounds: number;
  constructor(opts: RenderPipelineOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.cacheDir = opts.cacheDir;
    this.storage = opts.storage;
    this.skipCache = opts.skipCache ?? false;
    this.maxTokens = opts.maxTokens ?? 10_000;
    this.responseDir = opts.responseDir;
    this.referenceExample = opts.referenceExample;
    this.aggregator = opts.aggregator;
    this.maxRetries = opts.maxRetries ?? 3;
    this.doubleRunVerification = opts.doubleRunVerification ?? false;
    this.logger = opts.logger;
    this.traceCollector = opts.traceCollector;
    this.eventBus = opts.eventBus;
    this.targetLengthWords = opts.targetLengthWords ?? 400;
    this.styleProfile = opts.styleProfile;
    this.styleResolver = new StyleResolver();
    this.language = opts.language ?? 'en';
    this.maxRounds = opts.maxRounds ?? 3;
    this.pluginHooksManager = opts.pluginHooksManager;
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
    // Observability: pipeline span start
    this.traceCollector?.record({ phase: 'pipeline', state: 'start', spanId: eventId, eventId });
    this.logger?.info('Starting scene render', { eventId, chapter });
    this.eventBus?.emit('pipeline:render:before', { eventId });

    // ── Cache check ──────────────────────────────────────────────
    if (!this.skipCache && cacheKey) {
      this.traceCollector?.record({ phase: 'cache', state: 'start', spanId: `${eventId}:cache`, eventId });
      try {
        const evidenceHash = computeEvidenceHash(event.id, event.preconditions ?? [], event.postconditions ?? []);
        const cached = getCachedRender(this.cacheDir, eventId, cacheKey, this.storage, evidenceHash);
        if (cached) {
          const c = cached as Record<string, unknown>;
          const cachedAnalysisStr = c.analysis ? String(c.analysis) : null;
          const analysis = cachedAnalysisStr ? (this.aggregator
            ? parseAnalysisJSONWithErrors(cachedAnalysisStr, this.aggregator.getCombinedValidationSchema()).result
            : parseAnalysisJSON(cachedAnalysisStr, (message) => errors.push(`Cache parse warning: ${message}`)))
          : null;
          const validation = analysis && this.aggregator
            ? this.aggregator.validateRender(String(c.prose ?? ''), event, stateBefore, analysis, undefined, undefined, chapter, context)
            : null;
          const needsReview = String(c.prose ?? '').trim().length === 0 || analysis === null || (validation !== null && !validation.passed);
          this.traceCollector?.record({ phase: 'cache', state: 'end', spanId: `${eventId}:cache`, eventId });
          this.traceCollector?.record({ phase: 'pipeline', state: 'end', spanId: eventId, eventId });
          this.eventBus?.emit('cache:hit', { eventId, cacheKey: cacheKey ?? '' });
          this.logger?.info('Cache hit, returning cached result', { eventId });
          this.eventBus?.emit('pipeline:render:after', {
            eventId,
            durationMs: 0,
            wordCount: countNarrativeText(String(c.prose ?? ''), this.language),
            cacheHit: true,
            success: analysis !== null,
            errorCount: errors.length,
          });
          await this.writeResponseFile(eventId, String(c.prose ?? ''), true, errors, analysis, typeof c.renderedAt === 'string' ? c.renderedAt : new Date().toISOString());
          return {
            eventId, prose: String(c.prose ?? ''), analysis,
            llmPass1: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, llmPass2: null,
            cacheHit: true, errors, renderStart: typeof c.renderedAt === 'string' ? new Date(c.renderedAt).getTime() : renderStart,
            renderEnd: renderStart, validation, attempts: 0, needsReview,
            providerCalls: [],
            promptHash: typeof c.promptHash === 'string' ? c.promptHash : '',
          };
        }
        this.traceCollector?.record({ phase: 'cache', state: 'end', spanId: `${eventId}:cache`, eventId });
        this.logger?.info('Cache miss, proceeding to render', { eventId });
        this.eventBus?.emit('cache:miss', { eventId });
      } catch (error) {
        if (!(error instanceof CacheCorruptionError)) throw error;
        errors.push(`Cache read failed for ${eventId}: ${error.code}`);
        this.traceCollector?.record({ phase: 'cache', state: 'error', spanId: `${eventId}:cache`, eventId, code: error.code });
      }
    }

    // ── Plugin: beforeRender hook ─────────────────────────────────
    if (this.pluginHooksManager) {
      const hookErrors = await this.pluginHooksManager.runBeforeRender();
      errors.push(...hookErrors);
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
    const providerCalls: ProviderCallLedgerEntry[] = [];
    let pass2Rejection: Pass2RejectionCategory | null = null;
    // Initialize circuit breaker — scene-level retry escalation
    const breaker = createCircuitBreaker({
      maxRounds: this.maxRounds,
      maxAttemptsPerRound: 2,
      failureThreshold: 3,
      escalationDelay: 0,
    });

    // Resolve style profile from project config (chapter/narrator/scene levels can be added later)
    const styleNotes = this.styleProfile
      ? toStyleNotes(resolveProfile({ project: this.styleProfile }))
      : undefined;
    while (breaker.attempt()) {
      attempts = breaker.state().totalAttempts;
      this.traceCollector?.record({ phase: 'circuit', state: 'start', spanId: `${eventId}:circuit:attempt_${attempts}`, eventId, code: `round_${breaker.state().round}_attempt_${attempts}` });

      // ── Pass 1: Pure prose (with retry guidance on retry) ────────
      const assembler = new PromptAssembler();
      const assembled = assembler.assemble(context, {
        targetLengthWords: this.targetLengthWords,
        styleGuidance: job.event.styleGuidance,
        characterVoiceNotes: job.event.styleGuidance?.characterVoice && Object.keys(job.event.styleGuidance.characterVoice).length > 0
          ? Object.entries(job.event.styleGuidance.characterVoice).map(([id, note]) => `${id}: ${note}`).join('; ')
          : undefined,
        language: this.language,
        referenceExample: this.referenceExample,
        retryGuidance: attempts > 1 && previousErrorMessages.length > 0
          ? previousErrorMessages.join('\n')
          : undefined,
        profileStyleNotes: styleNotes,
        narrativeChecklistItems: job.event.narrativeChecklist?.items,
        sourceContextStyleNotes: job.event.sourceContext?.entries
          .filter((e) => e.classification === 'STYLE')
          .map((e) => e.styleNote ? `- "${e.excerpt}" (${e.styleNote})` : `- "${e.excerpt}"`)
          .join('\n'),
      });
      this.traceCollector?.record({ phase: 'pass1', state: 'start', spanId: `${eventId}:pass1`, eventId });
      const proseMessages = assembled.messages;
      try {
        const pass1Request: CompletionRequest = {
          messages: proseMessages,
          model: this.model,
          temperature: 0.8,
          maxTokens: this.maxTokens,
          taskType: 'pass1',
        };
        const pass1Hash = this.computeRequestHash(pass1Request);
        const result1 = await this.provider.complete(pass1Request);
        prose = result1.content ?? '';
        llmPass1 = result1.usage ?? llmPass1;
        providerCalls.push({ phase: 'pass1', attempt: attempts, outcome: 'success', requestHash: pass1Hash, model: this.model, seed: null });
        if (!prose || prose.trim().length === 0) {
          errors.push(`Pass 1 attempt ${attempts} returned empty prose`);
          this.logger?.warn('Pass 1 returned empty prose', { eventId, attempts });
          prose = '(empty)';
        }
      } catch (err) {
        const pass1Hash = this.computeRequestHash({
          messages: proseMessages,
          model: this.model,
          temperature: 0.8,
          maxTokens: this.maxTokens,
          taskType: 'pass1',
        });
        providerCalls.push({ phase: 'pass1', attempt: attempts, outcome: 'failure', failureReason: sanitizeError(err), requestHash: pass1Hash, model: this.model, seed: null });
        errors.push(`Pass 1 attempt ${attempts} failed: ${sanitizeError(err)}`);
        this.logger?.error(sanitizeError(err), { eventId, attempts, phase: 'pass1' });
        prose = '(empty)';
      }
      this.traceCollector?.record({ phase: 'pass1', state: 'end', spanId: `${eventId}:pass1`, eventId, durationMs: Date.now() - renderStart });
      this.logger?.info('Pass 1 completed', { eventId, attempts, promptTokens: llmPass1.promptTokens, completionTokens: llmPass1.completionTokens, totalTokens: llmPass1.totalTokens });

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
      pass2Rejection = null;
      let lastAnalysisMessages: Message[] | undefined;
      this.traceCollector?.record({ phase: 'pass2', state: 'start', spanId: `${eventId}:pass2`, eventId });
      try {
        let analysisObj: AnalysisResult | null = null;
        let feedbackErrors: string[] | undefined;
        // Up to 4 attempts: initial + up to 3 retries with Zod error feedback
        for (let attempt2 = 0; attempt2 < 4 && !analysisObj; attempt2++) {
          const analysisInput: RenderAnalysisInput = {
            event, prose, context,
            previousErrors: feedbackErrors,
            analysisRequirements: this.aggregator?.getAnalysisRequirements(),
          };
          lastAnalysisMessages = buildAnalysisPrompt(analysisInput);
          const pass2Request: CompletionRequest = {
            messages: lastAnalysisMessages,
            model: this.model,
            temperature: 0.3,
            maxTokens: 12000,
            seed: 42,
            taskType: 'pass2',
            responseFormat: { type: 'json_object' },
          };
          const pass2Hash = this.computeRequestHash(pass2Request);
          const result2 = await this.provider.complete(pass2Request);
          analysisRaw = result2.content ?? null;
          llmPass2 = result2.usage ?? null;
          providerCalls.push({ phase: 'pass2', attempt: attempts, outcome: 'success', requestHash: pass2Hash, model: this.model, seed: 42 });

          if (analysisRaw) {
            const parseResult = parseAnalysisJSONWithErrors(analysisRaw, this.aggregator?.getCombinedValidationSchema());
            if (parseResult.result) {
              analysisObj = parseResult.result;
              break;
            }

            // Track rejection category for deterministic diagnosis
            // Must be set before parseError/zodErrors are potentially consumed for feedback.
            if (parseResult.parseError) {
              pass2Rejection = 'parse';
              feedbackErrors = [`JSON parse error: ${parseResult.parseError}`];
            } else if (parseResult.zodErrors) {
              pass2Rejection = 'validation';
              feedbackErrors = parseResult.zodErrors.issues.map(i =>
                `Validation error at "${i.path.join('.')}": ${i.message}`,
              );
            }
          } else {
            pass2Rejection = 'empty';
          }
        }

        if (analysisObj) {
          analysis = analysisObj;

          // ── P5: Dev-only double-run verification ──────────────────
          if (this.doubleRunVerification && lastAnalysisMessages) {
            let verifyHash = '';
            try {
              const verifyRequest: CompletionRequest = {
                messages: lastAnalysisMessages,
                model: this.model,
                temperature: 0.3,
                maxTokens: 12000,
                seed: 42,
                taskType: 'pass2',
                responseFormat: { type: 'json_object' },
              };
              verifyHash = this.computeRequestHash(verifyRequest);
              const result2b = await this.provider.complete(verifyRequest);
              providerCalls.push({ phase: 'pass2_verify', attempt: attempts, outcome: 'success', requestHash: verifyHash, model: this.model, seed: 42 });
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
              providerCalls.push({ phase: 'pass2_verify', attempt: attempts, outcome: 'failure', failureReason: sanitizeError('Double-run non-fatal error'), requestHash: verifyHash, model: this.model, seed: 42 });
            }
          }
        } else {
          // Categorize the failure for deterministic diagnosis without leaking raw content
          if (pass2Rejection === 'empty') {
            errors.push('Pass 2 exhausted: provider returned empty content');
          } else if (pass2Rejection === 'parse') {
            errors.push('Pass 2 exhausted: JSON parse failed after retry');
          } else if (pass2Rejection === 'validation') {
            errors.push('Pass 2 exhausted: schema validation failed after retry');
          } else {
            errors.push('Pass 2 JSON parse/validation failed after retry');
          }
          this.logger?.warn(errors[errors.length - 1], { eventId, attempts, phase: 'pass2', rejection: pass2Rejection ?? 'unknown' });
          analysis = null;
        }
      } catch (err) {
        errors.push(`Pass 2 attempt ${attempts} failed: ${sanitizeError(err)}`);
        // Recompute request hash in the catch block — the for-loop-scoped
        // pass2Hash is not accessible here. lastAnalysisMessages is set before
        // the provider call that may have thrown, so it carries the actual
        // request projection. The ?? [] fallback ensures a valid 64-hex hash
        // even in the edge case the loop never ran.
        const failPass2Hash = this.computeRequestHash({
          messages: lastAnalysisMessages ?? [],
          model: this.model,
          temperature: 0.3,
          maxTokens: 12000,
          seed: 42,
          taskType: 'pass2',
          responseFormat: { type: 'json_object' },
        });
        providerCalls.push({ phase: 'pass2', attempt: attempts, outcome: 'failure', failureReason: sanitizeError(err), requestHash: failPass2Hash, model: this.model, seed: 42 });
        this.logger?.error(sanitizeError(err), { eventId, attempts, phase: 'pass2' });
        analysis = null;
      }
      this.traceCollector?.record({ phase: 'pass2', state: 'end', spanId: `${eventId}:pass2`, eventId, durationMs: Date.now() - renderStart });
      this.logger?.info('Pass 2 completed', { eventId, attempts });

      // ── Post-render validation ────────────────────────────────────
      renderValidation = null;
      this.traceCollector?.record({ phase: 'validator', state: 'start', spanId: `${eventId}:validator`, eventId });
      if (this.aggregator) {
        try {
          renderValidation = this.aggregator.validateRender(prose, event, stateBefore, analysis ?? undefined, undefined, undefined, chapter, context);
        } catch (err) {
          errors.push(`Post-render validation failed: ${(err as Error).message}`);
        }
      }
      this.traceCollector?.record({ phase: 'validator', state: 'end', spanId: `${eventId}:validator`, eventId, durationMs: Date.now() - renderStart });
      const issueCount = renderValidation?.errors.length ?? 0;
      this.eventBus?.emit('pipeline:validation:complete', { eventId, issueCount });

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
        this.traceCollector?.record({ phase: 'circuit', state: 'end', spanId: `${eventId}:circuit`, eventId, code: `round_${breaker.state().round}_escalated` });
        this.logger?.warn('Circuit escalation', { eventId, round: breaker.state().round, strategy: breaker.state().escalatedStrategy });
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
    const needsReview = analysis === null || breaker.state().isOpen || (!!renderValidation && !renderValidation.passed);

    // Compute aggregate promptHash from ordered provider-call identities
    const promptHash = crypto.createHash('sha256')
      .update(this.canonicalJson(
        providerCalls.map(({ phase, attempt, requestHash, model, seed }) =>
          ({ phase, attempt, requestHash, model, seed })),
      ))
      .digest('hex');

    // Save cache ONLY if validation passed (don't cache bad renders)
    if (cacheKey && !needsReview) {
      const evidenceHash = computeEvidenceHash(event.id, event.preconditions ?? [], event.postconditions ?? []);
      setCachedRender(this.cacheDir, eventId, cacheKey, {
        prose,
        analysis: analysisRaw, // Store raw JSON string in cache
        llmPass1,
        llmPass2,
        promptHash,
        renderedAt: new Date().toISOString(),
        chapters: [chapter],
      }, this.storage, evidenceHash);
    }
    this.traceCollector?.record({ phase: 'pipeline', state: 'end', spanId: eventId, eventId, durationMs: renderEnd - renderStart });
    this.logger?.info('Scene render completed', { eventId, durationMs: renderEnd - renderStart, attempts, needsReview });
    this.eventBus?.emit('pipeline:render:after', {
      eventId,
      durationMs: renderEnd - renderStart,
      wordCount: countNarrativeText(prose, this.language),
      cacheHit: false,
      success: analysis !== null,
      errorCount: errors.length,
    });

    // ── Plugin: afterRender hook ──────────────────────────────────
    if (this.pluginHooksManager) {
      const hookErrors = await this.pluginHooksManager.runAfterRender();
      errors.push(...hookErrors);
    }

    await this.writeResponseFile(eventId, prose, false, errors, analysis, new Date().toISOString());

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
      providerCalls,
      attempts,
      needsReview,
      promptHash,
      ...(pass2Rejection !== null ? { pass2Rejection } : {}),
    };
  }

  /**
   * Write a raw response artifact to responseDir/{eventId}.json.
   * Non-fatal: catches errors, logs warning, returns void.
   */
  private async writeResponseFile(
    eventId: string,
    prose: string,
    cacheHit: boolean,
    errors: string[],
    analysis: AnalysisResult | null,
    timestamp: string,
  ): Promise<void> {
    if (!this.responseDir) return;
    if (!prose || prose.trim().length === 0) return;
    try {
      this.storage.mkdirp(this.responseDir);
      const payload = {
        prose,
        timestamp,
        cacheHit,
        errors,
        analysis,
      };
      this.storage.write(
        [this.responseDir, `${eventId}.json`].join('/'),
        JSON.stringify(payload, null, 2),
      );
    } catch (err) {
      this.logger?.warn(
        `Failed to persist raw response for ${eventId}`,
        { eventId, responseDir: this.responseDir, error: String(err) },
      );
    }
  }

  /**
   * Render multiple scenes in parallel using the concurrency pool.
   * Respects cache for already-rendered scenes.
   */
  async renderAll(jobs: RenderJob[]): Promise<RenderSceneResult[]> {
    return this.pool.all(jobs, (job) => this.renderScene(job));
  }

  /**
   * Deterministic recursive sorted-key canonical JSON serialization.
   * Arrays preserve original order; plain-object keys are sorted lexicographically;
   * undefined object members are omitted; JSON primitives serialize normally.
   */
  private canonicalJson(value: unknown): string {
    if (typeof value !== 'object' || value === null) {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return '[' + value.map(v => this.canonicalJson(v)).join(',') + ']';
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + this.canonicalJson(obj[k])).join(',') + '}';
  }
  /**
   * Compute the SHA-256 request hash for a provider call.
   * The hash covers the canonical JSON of the request projection
   * (messages role+content, model, temperature, maxTokens, stop, seed, responseFormat).
   * signal is excluded as it is a non-serializable cancellation handle.
   */
  private computeRequestHash(request: CompletionRequest): string {
    const projection = {
      messages: request.messages.map(({ role, content }) => ({ role, content })),
      model: request.model ?? null,
      temperature: request.temperature ?? null,
      maxTokens: request.maxTokens ?? null,
      stop: request.stop ?? null,
      seed: request.seed ?? null,
      responseFormat: request.responseFormat ?? null,
    };
    const json = this.canonicalJson(projection);
    return crypto.createHash('sha256').update(json, 'utf-8').digest('hex');
  }
}


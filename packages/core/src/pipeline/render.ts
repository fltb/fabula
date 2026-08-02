// ============================================================================
// RenderPipeline — Two-pass parallel render with caching + validation
// ============================================================================
import type { JsonValue } from '../contracts/json.ts';
// Design:
//   Pass 1: LLM produces pure prose (no format constraints)
//   Pass 2: prose + context fed back for structured analysis JSON
//   Validation: all validators' validatePost run on the prose
//   Cache: hash-chain cache key → skip if fresh
//   Parallel: ConcurrencyPool of concurrent LLM calls
//   maxTokens: 10000 (far above target; we take what we get)
// ============================================================================

import {
  type BuildAnalysisPromptResult,
  buildAnalysisPrompt,
  type RenderAnalysisInput,
  type ValidationKeyMaterial,
} from '../ai/prompts/render-analysis.ts';
import type { CompletionRequest, CompletionResponse, LLMProvider, Message } from '../ai/types.ts';
import { countNarrativeText } from '../assembler/count.ts';
import {
  buildAttemptKeyMaterial,
  buildLogicalKeyMaterial,
  buildSurfaceKeyMaterial,
  buildValidationKeyMaterial,
  type CacheDiagnostics,
  computeEvidenceHash,
  getCachedRender,
  setCachedRender,
  sha256Canonical,
} from '../cache/render-cache.ts';
import { PromptAssembler } from '../context/prompt-assembler.ts';
import { sanitizeError } from '../errors.ts';
import type { TypedEventBus } from '../event-bus.ts';
import type { Logger } from '../observability/logger.ts';
import type { TraceCollector } from '../observability/trace.ts';
import type { PluginHooksManager } from '../plugin/hooks-manager.ts';
import type { BuildPromptInput, PromptDecoration } from '../plugin/types.ts';
import { parseAnalysisJSON, parseAnalysisJSONWithErrors } from '../schemas/analysis.ts';
import type { CoreRuntimeServices, PromptTemplateCatalog } from '../ports/runtime-services.ts';
import type { LayeredCacheKey } from '../ports/render-cache-repository.ts';
import { type StyleProfile, StyleResolver, toStyleNotes } from '../style/index.ts';
import type { ValidationKey } from '../types/discourse.ts';
import type {
  AnalysisResult,
  CompiledSceneContract,
  ContextPackage,
  EntityLookup,
  GameDialogueChoice,
  NarrativeEvent,
  ProviderFactory,
  RevisionContext,
  SurfaceReferencePacket,
  ValidationIssue,
  ValidationResult,
  WorldState,
} from '../types/index.ts';
import { compareAnalysisBlocks } from '../util/compare-analysis.ts';
import { ConcurrencyPool } from '../util/pool.ts';
import type { AnalysisContract, ResultAggregator } from '../validator/aggregator.ts';
import { analysisContentSchema } from '../validator/index.ts';
import { createCircuitBreaker } from './circuit-breaker.ts';
function toJsonValue(value: unknown): JsonValue | null {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const values: JsonValue[] = [];
    for (const item of value) { const converted = toJsonValue(item); if (converted === null && item !== null) return null; values.push(converted); }
    return values;
  }
  if (typeof value === 'object') {
    const object: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) { const converted = toJsonValue(item); if (converted === null && item !== null) return null; object[key] = converted; }
    return object;
  }
  return null;
}
function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
import { analyzeValidationErrors, decideRepairStrategy } from './reverse-validate.ts';

/**
 * Single Pass 2 sampling configuration — the ONE source of truth for both
 * the provider request and `samplingConfigHash`. Never duplicate these
 * values inline in requests.
 */
export const PASS2_SAMPLING_CONFIG = {
  temperature: 0.3,
  maxTokens: 12000,
  seed: 42,
  responseFormat: { type: 'json_object' },
} as const;

/** Stable reference-policy version shared with the render-cache validation layer. */
export const PASS2_REFERENCE_POLICY_VERSION = '1';

/** Canonical PromptTemplateCatalog name for the Pass 1 prose template. */
export const PASS1_PROMPT_TEMPLATE_NAME = 'pass1';

export interface RenderJob {
  event: NarrativeEvent;
  stateBefore: WorldState;
  context: ContextPackage;
  chapter: number;

  /** Deterministic player-choice data owned by a decision scene. */
  gameDialogue?: {
    choices: readonly GameDialogueChoice[];
  };

  /** Compiled scene contract — deterministic pre-prose contract with
   *  branch/discourse position, boundary hashes, style profile, etc.
   *  Every scene has one before prose (RENDER-SURFACE-1 §2). */
  contract: CompiledSceneContract;

  /** Surface dependency graph edge for this job.
   *  Determines ordering, predecessor waiting, and fallback policy
   *  within a surface dependency graph lane. */
  surfaceDependency: {
    groupId: string;
    laneId?: string;
    predecessorEventId?: string;
    policy: 'parallel' | 'serial_surface' | 'fallback_without_surface';
    manifestHash: string;
  };

  /**
   * Canonical graph hash from sha256Canonical({story, discourse}).
   * Produced by compiled narrative graphs for identity caching.
   */
  graphHash: string;

  /**
   * Canonical source-content hash computed from sorted event file paths +
   * definition bytes under project-relative paths, and branch/discourse scope.
   * Injected by API before RenderPipeline cache use.
   * A source read failure is a hard render configuration failure.
   */
  sourceContentHash: string;

  /**
   * Hash-pinned disclosure-safe summary of prior discourse state.
   * Produced by LogicalDisclosureSummaryCompiler before context compilation.
   */
  logicalDisclosureSummary?: string;

  /**
   * Non-authoritative prose excerpt + style packet from a prior render.
   * Per RENDER-SURFACE-1: YAML always wins over this packet.
   */

  /**
   * Revision context for editorial revision. When present, the draft
   * cache is bypassed and a fresh Pass 1 is forced.
   */
  revisionContext?: RevisionContext;

  /**
   * YAML-authored editorial revision instructions.
   * Injected into the Pass 1 prompt as ## Editorial Revision Instructions.
   * Canonical YAML takes precedence over non-authoritative context.
   */
  editorialRevisionInstructions?: string;

  /** Review IDs whose canonical feedback is applied to this scene. */
  editorialReviewIds?: readonly string[];

  /** Existing human or historical prose to evaluate without a Pass 1 call. */
  proseCandidate?: string;

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
export interface RenderRequestRecord {
  phase: 'pass1' | 'pass2';
  attempt: number;
  requestHash: string;
  messages: readonly Message[];
  responseContent?: string | null;
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
  promptHash: string; // SHA-256 of ordered provider-call identities
  renderStart: number;
  renderEnd: number;
  validation: ValidationResult | null; // post-render validation result
  providerCalls: ProviderCallLedgerEntry[];
  /** Actual provider requests for fresh candidates; empty for cache hits. */
  requestRecords: RenderRequestRecord[];
  attempts: number; // number of render attempts
  /** True if all retries exhausted and validation still has errors */
  needsReview: boolean;
  /** Categorises Pass 2 exhaustion: 'empty' | 'parse' | 'validation'.
   *  Only non-null when analysis is null due to Pass 2 content rejection.
   *  Undefined on provider throw, Pass 2 success, or Pass 1 only failure. */
  pass2Rejection?: Pass2RejectionCategory;
}

export interface RenderPipelineOptions {
  provider?: LLMProvider;
  model: string;
  runtimeServices: Pick<CoreRuntimeServices, 'renderCache' | 'promptTemplates'>;
  /** Optional factory for lazy provider creation. Mutually exclusive with provider. */
  providerFactory?: ProviderFactory;
  /** Optional pipeline-level AbortSignal for cancellation. */
  signal?: AbortSignal;
  concurrency?: number; // default 5
  maxTokens?: number; // default 10000
  skipCache?: boolean; // force re-render
  referenceExample?: string; // optional "good" prose example for Pass 1
  aggregator?: ResultAggregator; // optional, for post-render validation
  /** Entity lookup for validator access to entity definitions (optional) */
  entities?: EntityLookup;
  /** Per-validator severity overrides (optional) */
  validatorOverrides?: Record<string, 'off' | 'warning' | 'error'>;
  /** Pre-computed analysis contract for consistent Pass 2 schema (optional) */
  analysisContract?: AnalysisContract;
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
  /** Stable provider profile identifier for lazy resolution */
  providerProfile?: string;
  /** REQUIRED validator policy identity (editorial: plan.planSummary.validationIdentity). */
  validatorPolicyId: string;
}

export class RenderPipeline {
  private readonly pool: ConcurrencyPool;
  private readonly skipCache: boolean;
  private readonly maxTokens: number;
  private readonly model: string;
  private provider: LLMProvider | undefined;
  private readonly providerFactory?: ProviderFactory;
  private _resolvedProvider: LLMProvider | undefined;
  private readonly promptTemplates?: PromptTemplateCatalog;
  private readonly pipelineSignal?: AbortSignal;
  private readonly renderCache: CoreRuntimeServices['renderCache'];
  private readonly aggregator?: ResultAggregator;
  private readonly entities?: EntityLookup;
  private readonly validatorOverrides?: Record<string, 'off' | 'warning' | 'error'>;
  private readonly analysisContract?: AnalysisContract;
  private readonly maxRetries: number;
  private readonly doubleRunVerification: boolean;
  private readonly logger?: Logger;
  private readonly traceCollector?: TraceCollector;
  private readonly eventBus?: TypedEventBus;
  private readonly targetLengthWords: number;
  private readonly maxRounds: number;
  private readonly styleProfile?: StyleProfile;
  private readonly styleResolver: StyleResolver;
  private readonly language: string;
  private readonly pluginHooksManager?: PluginHooksManager;
  private readonly referenceExample?: string;
  private readonly providerProfile?: string;
  private readonly validatorPolicyId: string;
  constructor(opts: RenderPipelineOptions) {
    if (opts.provider && opts.providerFactory) {
      throw new Error('PROVIDER_REQUIRED: Cannot provide both provider and providerFactory');
    }
    if (!opts.validatorPolicyId) {
      throw new Error('VALIDATOR_POLICY_REQUIRED: validatorPolicyId must be non-empty');
    }
    this.provider = opts.provider;
    this.providerFactory = opts.providerFactory;
    this.renderCache = opts.runtimeServices.renderCache;
    this.promptTemplates = opts.runtimeServices.promptTemplates;
    this.pipelineSignal = opts.signal;
    this.model = opts.model;
    this.renderCache = opts.runtimeServices.renderCache;
    this.skipCache = opts.skipCache ?? false;
    this.maxTokens = opts.maxTokens ?? 10_000;
    this.referenceExample = opts.referenceExample;
    this.aggregator = opts.aggregator;
    this.entities = opts.entities;
    this.validatorOverrides = opts.validatorOverrides;
    this.analysisContract = opts.analysisContract;
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
    this.providerProfile = opts.providerProfile;
    this.validatorPolicyId = opts.validatorPolicyId;
    this.pool = new ConcurrencyPool(opts.concurrency ?? 5);
  }

  /**
   * Resolve the LLM provider lazily. If a providerFactory is configured,
   * it is called exactly once and the result is memoized. Throws
   * PROVIDER_REQUIRED if no provider or factory is available.
   */
  private async resolveProvider(): Promise<LLMProvider> {
    if (this._resolvedProvider) return this._resolvedProvider;
    if (this.providerFactory) {
      this._resolvedProvider = await this.providerFactory.create();
      return this._resolvedProvider;
    }
    if (this.provider) return this.provider;
    throw new Error('PROVIDER_REQUIRED: No provider or providerFactory configured');
  }

  /**
   * Deterministic provider identity for the measurement protocol — resolved
   * from construction options only, never from a live provider, so the
   * cache-hit reparse path can reconstruct the protocol without any call.
   */
  private providerIdentity(): string {
    if (this.providerProfile) return this.providerProfile;
    if (this.provider) return this.provider.name;
    if (this.providerFactory) return this.providerFactory.profile;
    return this.model;
  }

  /**
   * Build the protocol material shared by every Pass 2 sub-attempt and the
   * cache reparse. Only `analysisPromptHash` is derived per prompt (two-phase
   * construction in buildAnalysisPrompt); every other field is fixed for the
   * scene round.
   */
  private protocolMaterial(prose: string): ValidationKeyMaterial {
    return {
      proseHash: sha256Canonical(prose),
      analysisSchema:
        this.analysisContract?.hash ??
        this.aggregator?.getAnalysisContract(this.validatorOverrides).hash ??
        sha256Canonical(Object.keys(analysisContentSchema.shape).sort()),
      model: this.model,
      provider: this.providerIdentity(),
      samplingConfigHash: sha256Canonical(PASS2_SAMPLING_CONFIG),
      validatorPolicy: this.validatorPolicyId,
      referencePolicy: PASS2_REFERENCE_POLICY_VERSION,
    };
  }
  /**
   * Render a single scene job: cache lookup → Pass 1 → Pass 2 → write cache.
   *
   * @param job - The render job.
   * @param signal - Optional per-call AbortSignal. Overrides the pipeline-level signal.
   */
  async renderScene(job: RenderJob, signal?: AbortSignal): Promise<RenderSceneResult> {
    const { event, stateBefore, context, chapter } = job;
    const eventId = event.id;
    const errors: string[] = [];
    const requestRecords: RenderRequestRecord[] = [];
    // Effective signal: per-call overrides pipeline-level
    const effectiveSignal = signal ?? this.pipelineSignal;
    // Compute canonical cache key from deterministic job inputs (logical + surface layers only).
    // All identity-determining fields flow through canonical JSON → SHA-256.
    const logicalKeyStr = buildLogicalKeyMaterial({
      sourceContentHash: job.sourceContentHash,
      sceneContractHash: job.contract.promptContractHash,
      worldStateHash: job.contract.worldStateHash,
      plannedDiscourseHash: job.contract.plannedDiscourseHash,
      branchDiscourseScopeHash: job.contract.plannedDiscourseHash,
      logicalDisclosureSummaryHash: job.logicalDisclosureSummary
        ? sha256Canonical(job.logicalDisclosureSummary)
        : undefined,
      catalogVersionHashes: { default: job.contract.catalogHash ?? '' },
      graphHash: job.graphHash,
      styleProfileHash: sha256Canonical(job.contract.styleProfile),
      promptProviderId: this.model,
      promptProviderVersion: this.model,
      language: this.language,
      targetLengthWords: this.targetLengthWords,
      analysisContractHash: this.aggregator
        ? this.aggregator.getAnalysisContract(this.validatorOverrides).hash
        : undefined,
      validatorOverrideHash: this.validatorOverrides
        ? sha256Canonical(this.validatorOverrides)
        : undefined,
      pluginIdentityHash: this.pluginHooksManager
        ? sha256Canonical(this.pluginHooksManager.getPluginIdentities())
        : undefined,
    });
    const surfaceKeyStr = buildSurfaceKeyMaterial({
      logicalKeyString: logicalKeyStr,
      groupManifestHash: job.surfaceDependency.manifestHash,
      surfacePolicyHash: sha256Canonical(job.surfaceDependency.policy),
      sourceProseHashes: job.surfaceReferencePacket
        ? [job.surfaceReferencePacket.sourceProseHash]
        : [],
      extractorVersion: '1',
    });
    const cacheKey = sha256Canonical({ logical: logicalKeyStr, surface: surfaceKeyStr });
    const cacheDiagnostics: CacheDiagnostics[] = [];
    // Observability: pipeline span start
    this.traceCollector?.record({ phase: 'pipeline', state: 'start', spanId: eventId, eventId });
    this.logger?.info('Starting scene render', { eventId, chapter });
    this.eventBus?.emit('pipeline:render:before', { eventId });
    const renderStart = Date.now();

    // ── Cache check with layered diagnostics ──────────────────────
    // Revisions and externally supplied prose never use the draft cache.
    if (job.revisionContext || job.proseCandidate !== undefined) {
      this.logger?.info('Fresh candidate path, bypassing cache', { eventId });
      this.eventBus?.emit('cache:miss', { eventId });
    } else if (!this.skipCache && cacheKey) {
      this.traceCollector?.record({
        phase: 'cache',
        state: 'start',
        spanId: `${eventId}:cache`,
        eventId,
      });
      const evidenceHash = computeEvidenceHash(
        event.id,
        event.preconditions ?? [],
        event.postconditions ?? [],
      );
      const cacheLookupKey: LayeredCacheKey = {
        version: 1,
        sourceHash: job.sourceContentHash,
        layers: { eventId, logical: logicalKeyStr, surface: surfaceKeyStr },
      };
      const cached = await getCachedRender(
        this.renderCache,
        { key: cacheLookupKey, eventId, evidenceHash },
        cacheDiagnostics,
      );
      if (cached) {
        const c = isJsonObject(cached.output) ? cached.output : {};
        // Always re-parse and re-validate cached analysis under the CURRENT
        // expected protocol. The protocol is reconstructed deterministically
        // from the cached prose + current config + prompt material; any
        // mismatch (stale prompt/schema/sampling/policy) fails closed and the
        // entry is treated as a cache miss.
        const cachedProse = String(c.prose ?? '');
        const cachedAnalysisStr = c.analysis ? JSON.stringify(c.analysis) : null;
        let analysis: AnalysisResult | null = null;
        if (cachedAnalysisStr) {
          // Reconstruct the exact expected protocol for a fresh Pass 2 run
          // (no previous errors) so the cached response is validated against
          // the prompt it would be produced under today.
          let pass2Decorations: readonly PromptDecoration[] = [];
          if (this.pluginHooksManager) {
            try {
              pass2Decorations = await this.pluginHooksManager.runOnBuildPass2Prompt({
                phase: 'pass2',
                eventId: event.id,
                chapter,
                attempt: 1,
                contractHash: job.contract.promptContractHash,
                messages: [],
              });
            } catch (err) {
              errors.push(`Cache reparse decoration hook failed: ${sanitizeError(err)}`);
            }
          }
          const cachedProtocol = buildAnalysisPrompt(
            {
              event,
              prose: cachedProse,
              context,
              activeRules: context.activeRules,
              analysisRequirements:
                this.analysisContract?.requirements ?? this.aggregator?.getAnalysisRequirements(),
              pluginDecorations: pass2Decorations,
            },
            this.protocolMaterial(cachedProse),
          ).protocol;
          const schema =
            this.analysisContract?.combinedSchema ?? this.aggregator?.getCombinedValidationSchema();
          if (schema) {
            analysis = parseAnalysisJSONWithErrors(
              cachedAnalysisStr,
              schema,
              cachedProtocol,
              cachedProse,
            ).result;
          } else {
            analysis = parseAnalysisJSON(
              cachedAnalysisStr,
              (message) => errors.push(`Cache parse warning: ${message}`),
              cachedProtocol,
              cachedProse,
            );
          }
        }

        // If analysis is null after re-parse, this is NOT a valid cache hit.
        // Never return cacheHit: true with null analysis.
        if (analysis === null) {
          this.traceCollector?.record({
            phase: 'cache',
            state: 'end',
            spanId: `${eventId}:cache`,
            eventId,
          });
          this.logger?.info('Cache stale — analysis re-parse failed, proceeding to render', {
            eventId,
          });
          this.eventBus?.emit('cache:miss', { eventId });
        } else {
          const validation =
            analysis && this.aggregator
              ? this.aggregator.validatePost(
                  String(c.prose ?? ''),
                  event,
                  stateBefore,
                  analysis,
                  this.validatorOverrides,
                  this.entities,
                  chapter,
                  context,
                )
              : null;
          const needsReview =
            String(c.prose ?? '').trim().length === 0 ||
            (validation !== null && !validation.passed);
          this.traceCollector?.record({
            phase: 'cache',
            state: 'end',
            spanId: `${eventId}:cache`,
            eventId,
          });
          this.traceCollector?.record({
            phase: 'pipeline',
            state: 'end',
            spanId: eventId,
            eventId,
          });
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
          return {
            eventId,
            prose: String(c.prose ?? ''),
            analysis,
            llmPass1: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            llmPass2: null,
            cacheHit: true,
            errors,
            renderStart:
              typeof c.renderedAt === 'string' ? new Date(c.renderedAt).getTime() : renderStart,
            renderEnd: renderStart,
            validation,
            attempts: 0,
            needsReview,
            providerCalls: [],
            promptHash: typeof c.promptHash === 'string' ? c.promptHash : '',
            requestRecords,
          };
        }
      } else {
        this.traceCollector?.record({
          phase: 'cache',
          state: 'end',
          spanId: `${eventId}:cache`,
          eventId,
        });
        this.logger?.info('Cache miss, proceeding to render', { eventId });
        this.eventBus?.emit('cache:miss', { eventId });
      }
      // Cache diagnostics for observability
      if (cacheDiagnostics.length > 0) {
        this.logger?.info('Cache diagnostics', {
          eventId,
          diagnostics: cacheDiagnostics
            .map((d) => `${d.diagnosis}${d.detail ? `: ${d.detail}` : ''}`)
            .join('; '),
        });
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
    let llmPass1: { promptTokens: number; completionTokens: number; totalTokens: number } = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    let llmPass2: { promptTokens: number; completionTokens: number; totalTokens: number } | null =
      null;
    let renderValidation: ValidationResult | null = null;
    let previousErrorMessages: string[] = [];
    let attempts = 0;
    const providerCalls: ProviderCallLedgerEntry[] = [];
    let pass2Rejection: Pass2RejectionCategory | null = null;
    let lastProtocol: ValidationKey | undefined;
    // Initialize circuit breaker — scene-level retry escalation
    const breaker = createCircuitBreaker({
      maxRounds: this.maxRounds,
      maxAttemptsPerRound: 2,
      failureThreshold: 3,
    });
    // Resolve style profile from project config (chapter/narrator/scene levels can be added later)
    const styleNotes = this.styleProfile
      ? toStyleNotes(this.styleResolver.resolve({ project: this.styleProfile }).simple)
      : undefined;
    // ── Check abort before entering retry loop ─────────────────────
    if (effectiveSignal?.aborted) {
      errors.push('Render cancelled before Pass 1');
      this.logger?.info('Abort signal received, skipping render', { eventId });
      this.traceCollector?.record({ phase: 'pipeline', state: 'end', spanId: eventId, eventId });
      return {
        eventId,
        prose: '',
        analysis: null,
        llmPass1: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        llmPass2: null,
        cacheHit: false,
        errors: [...errors],
        renderStart,
        renderEnd: Date.now(),
        validation: null,
        attempts: 0,
        needsReview: true,
        providerCalls: [],
        promptHash: '',
        requestRecords,
      };
    }
    // Resolve the optional custom Pass 1 template from the injected catalog.
    // A missing entry or a failing catalog falls back to the built-in template.
    let pass1TemplateText: string | undefined;
    try {
      const template = await this.promptTemplates?.get({ name: PASS1_PROMPT_TEMPLATE_NAME });
      pass1TemplateText = template?.template;
    } catch (err) {
      this.logger?.warn('Pass 1 template catalog lookup failed; using built-in template', {
        eventId,
        error: sanitizeError(err),
      });
    }
    while (breaker.attempt()) {
      attempts = breaker.state().totalAttempts;
      // ── Check abort before each retry attempt ────────────────────
      if (effectiveSignal?.aborted) {
        errors.push('Render cancelled — abort signal received');
        this.logger?.info('Abort signal during retry loop, stopping', { eventId });
        break;
      }
      this.traceCollector?.record({
        phase: 'circuit',
        state: 'start',
        spanId: `${eventId}:circuit:attempt_${attempts}`,
        eventId,
        code: `round_${breaker.state().round}_attempt_${attempts}`,
      });

      if (job.proseCandidate !== undefined) {
        prose = job.proseCandidate;
        if (prose.trim().length === 0) {
          errors.push('Existing prose candidate is empty');
          breaker.recordFailure('Existing prose candidate is empty');
          break;
        }
      } else {
        // ── Collect plugin decorations for Pass 1 ───────────────────
        let pass1Decorations: readonly PromptDecoration[] = [];
        if (this.pluginHooksManager) {
          const buildInput: BuildPromptInput = {
            phase: 'pass1',
            eventId: event.id,
            chapter,
            attempt: attempts,
            contractHash: job.contract.promptContractHash,
            messages: [],
          };
          try {
            pass1Decorations = await this.pluginHooksManager.runOnBuildPass1Prompt(buildInput);
          } catch (err) {
            errors.push(`Pass 1 decoration hook failed: ${sanitizeError(err)}`);
            // Hard failure — break out of retry loop
            breaker.recordFailure('Pass 1 decoration hook failed');
            break;
          }
        }

        const assembler = new PromptAssembler(pass1TemplateText);
        const assembled = assembler.assemble(context, {
          targetLengthWords: this.targetLengthWords,
          styleGuidance: job.event.styleGuidance,
          characterVoiceNotes:
            job.event.styleGuidance?.characterVoice &&
            Object.keys(job.event.styleGuidance.characterVoice).length > 0
              ? Object.entries(job.event.styleGuidance.characterVoice)
                  .map(([id, note]) => `${id}: ${note}`)
                  .join('; ')
              : undefined,
          language: this.language,
          referenceExample: this.referenceExample,
          retryGuidance:
            attempts > 1 && previousErrorMessages.length > 0
              ? previousErrorMessages.join('\n')
              : undefined,
          profileStyleNotes: styleNotes,
          narrativeChecklistItems: job.event.narrativeChecklist?.items,
          sourceContextStyleNotes: job.event.sourceContext?.entries
            .filter((e) => e.classification === 'STYLE')
            .map((e) => (e.styleNote ? `- "${e.excerpt}" (${e.styleNote})` : `- "${e.excerpt}"`))
            .join('\n'),
          logicalDisclosureSummary: job.logicalDisclosureSummary,
          surfaceReferencePacket: job.surfaceReferencePacket,
          decorations: pass1Decorations.length > 0 ? [...pass1Decorations] : undefined,
          gameDialogue: job.gameDialogue,
          previousAcceptedProse: job.revisionContext?.baseProse,
          editorialRevisionInstructions: job.editorialRevisionInstructions,
        });
        this.traceCollector?.record({
          phase: 'pass1',
          state: 'start',
          spanId: `${eventId}:pass1`,
          eventId,
        });
        const proseMessages = assembled.messages;
        try {
          const pass1Request: CompletionRequest = {
            messages: proseMessages,
            model: this.model,
            temperature: 0.8,
            maxTokens: this.maxTokens,
            taskType: 'pass1',
            signal: effectiveSignal,
          };
          // ── Check abort before Pass 1 provider call ─────────────────
          if (effectiveSignal?.aborted) {
            throw new Error('ABORTED: Render cancelled before Pass 1 provider call');
          }
          const pass1Hash = this.computeRequestHash(pass1Request);
          const result1 = await (await this.resolveProvider()).complete(pass1Request);
          prose = result1.content ?? '';
          llmPass1 = result1.usage ?? llmPass1;
          requestRecords.push({
            phase: 'pass1',
            attempt: attempts,
            requestHash: pass1Hash,
            messages: [...proseMessages],
            responseContent: result1.content ?? null,
          });
          providerCalls.push({
            phase: 'pass1',
            attempt: attempts,
            outcome: 'success',
            requestHash: pass1Hash,
            model: this.model,
            seed: null,
          });
          if (!prose || prose.trim().length === 0) {
            errors.push(`Pass 1 attempt ${attempts} returned empty prose`);
            this.logger?.warn('Pass 1 returned empty prose', { eventId, attempts });
            previousErrorMessages = [`Pass 1 attempt ${attempts} returned empty prose`];
            breaker.recordFailure('Pass 1 returned empty prose');
            if (breaker.state().consecutiveFailures >= 2) {
              breaker.escalate();
            }
            continue;
          }
        } catch (err) {
          const errStr = String(err);
          if (errStr.includes('PROVIDER_REQUIRED')) {
            errors.push(`PROVIDER_REQUIRED: ${sanitizeError(err)}`);
            this.logger?.error('PROVIDER_REQUIRED — no provider available', { eventId, attempts });
            break;
          }
          const pass1Hash = this.computeRequestHash({
            messages: proseMessages,
            model: this.model,
            temperature: 0.8,
            maxTokens: this.maxTokens,
            taskType: 'pass1',
          });
          requestRecords.push({
            phase: 'pass1',
            attempt: attempts,
            requestHash: pass1Hash,
            messages: [...proseMessages],
          });
          // Detect timeout before recording — so we can normalize the failure reason
          const isTimeout = /timeout/i.test(errStr) || errStr.includes('timed out');
          providerCalls.push({
            phase: 'pass1',
            attempt: attempts,
            outcome: 'failure',
            failureReason: isTimeout ? `timeout — ${sanitizeError(err)}` : sanitizeError(err),
            requestHash: pass1Hash,
            model: this.model,
            seed: null,
          });
          // Timeout — only retry with a material mutation
          if (isTimeout) {
            errors.push(
              `Pass 1 attempt ${attempts} timed out — only retrying with material mutation`,
            );
            this.logger?.warn('Pass 1 timeout', { eventId, attempts });
            // A timeout without prior material mutation (different model/routing/deadline)
            // is NOT retryable. Let circuit breaker handle it.
            breaker.recordFailure('Pass 1 timeout — no material mutation');
            if (breaker.state().consecutiveFailures >= 2) {
              breaker.escalate();
            }
            continue;
          }
          // All other provider exceptions are hard failures, NOT retried with '(empty)'.
          errors.push(`Pass 1 attempt ${attempts} failed: ${sanitizeError(err)}`);
          this.logger?.error(sanitizeError(err), { eventId, attempts, phase: 'pass1' });
          breaker.recordFailure('Pass 1 provider error');
          if (breaker.state().consecutiveFailures >= 2) {
            breaker.escalate();
          }
          continue;
        }
        this.traceCollector?.record({
          phase: 'pass1',
          state: 'end',
          spanId: `${eventId}:pass1`,
          eventId,
          durationMs: Date.now() - renderStart,
        });
        this.logger?.info('Pass 1 completed', {
          eventId,
          attempts,
          promptTokens: llmPass1.promptTokens,
          completionTokens: llmPass1.completionTokens,
          totalTokens: llmPass1.totalTokens,
        });
      }

      // ── Pass 2: Structured analysis (with retry-with-feedback) ────
      analysisRaw = null;
      analysis = null;
      llmPass2 = null;
      pass2Rejection = null;
      let lastAnalysisMessages: Message[] | undefined;
      this.traceCollector?.record({
        phase: 'pass2',
        state: 'start',
        spanId: `${eventId}:pass2`,
        eventId,
      });
      try {
        let analysisObj: AnalysisResult | null = null;
        let feedbackErrors: string[] | undefined;
        // Up to 4 attempts: initial + up to 3 retries with Zod error feedback
        // ── Collect plugin decorations for Pass 2 ───────────────────
        let pass2Decorations: readonly PromptDecoration[] = [];
        if (this.pluginHooksManager) {
          const p2Input: BuildPromptInput = {
            phase: 'pass2',
            eventId: event.id,
            chapter,
            attempt: attempts,
            contractHash: job.contract.promptContractHash,
            messages: [],
          };
          try {
            pass2Decorations = await this.pluginHooksManager.runOnBuildPass2Prompt(p2Input);
          } catch (err) {
            errors.push(`Pass 2 decoration hook failed: ${sanitizeError(err)}`);
            // Hard failure — decoration transform exceptions abort the scene
            analysis = null;
            break;
          }
        }

        for (let attempt2 = 0; attempt2 < 4 && !analysisObj; attempt2++) {
          // ── Check abort before Pass 2 retry ──────────────────────
          if (effectiveSignal?.aborted) {
            errors.push('Render cancelled during Pass 2 retry');
            this.logger?.info('Abort signal during Pass 2 retry', { eventId, attempts, attempt2 });
            break;
          }
          const analysisInput: RenderAnalysisInput = {
            event,
            prose,
            context,
            previousErrors: feedbackErrors,
            activeRules: context.activeRules,
            analysisRequirements:
              this.analysisContract?.requirements ?? this.aggregator?.getAnalysisRequirements(),
            pluginDecorations: pass2Decorations,
          };
          // Two-phase prompt construction: analysisPromptHash is derived from
          // the canonical prompt material (incl. decorations), then the final
          // prompt embeds the REAL protocol — never a placeholder.
          const built: BuildAnalysisPromptResult = buildAnalysisPrompt(
            analysisInput,
            this.protocolMaterial(prose),
          );
          lastAnalysisMessages = built.messages;
          lastProtocol = built.protocol;
          const pass2Request: CompletionRequest = {
            messages: lastAnalysisMessages,
            model: this.model,
            temperature: PASS2_SAMPLING_CONFIG.temperature,
            maxTokens: PASS2_SAMPLING_CONFIG.maxTokens,
            seed: PASS2_SAMPLING_CONFIG.seed,
            taskType: 'pass2',
            responseFormat: { ...PASS2_SAMPLING_CONFIG.responseFormat },
            signal: effectiveSignal,
          };
          const pass2Hash = this.computeRequestHash(pass2Request);
          const result2 = await (await this.resolveProvider()).complete(pass2Request);
          analysisRaw = result2.content ?? null;
          llmPass2 = result2.usage ?? null;
          requestRecords.push({
            phase: 'pass2',
            attempt: attempt2 + 1,
            requestHash: pass2Hash,
            messages: [...lastAnalysisMessages],
            responseContent: result2.content ?? null,
          });
          providerCalls.push({
            phase: 'pass2',
            attempt: attempts,
            outcome: 'success',
            requestHash: pass2Hash,
            model: this.model,
            seed: 42,
          });

          if (analysisRaw) {
            const parseResult = parseAnalysisJSONWithErrors(
              analysisRaw,
              this.analysisContract?.combinedSchema ??
                this.aggregator?.getCombinedValidationSchema(),
              lastProtocol,
              prose,
            );
            if (parseResult.result) {
              analysisObj = parseResult.result;
              pass2Rejection = null;
              break;
            }

            // Track rejection category for deterministic diagnosis
            // Must be set before parseError/zodErrors are potentially consumed for feedback.
            if (parseResult.parseError) {
              pass2Rejection = 'parse';
              feedbackErrors = [
                `JSON parse error (sub-attempt ${attempt2 + 1}): ${parseResult.parseError}`,
              ];
            } else if (parseResult.zodErrors) {
              pass2Rejection = 'validation';
              feedbackErrors = parseResult.zodErrors.issues.map(
                (i) =>
                  `Validation error (sub-attempt ${attempt2 + 1}) at "${i.path.join('.')}": ${i.message}`,
              );
            }
          } else {
            pass2Rejection = 'empty';
            // Empty content retry must still mutate the request identity
            // by providing structured feedback — never a blind retry.
            feedbackErrors = [
              `Pass 2 sub-attempt ${attempt2 + 1} returned empty. Please provide a valid structured JSON analysis for the scene.`,
            ];
          }
        }

        if (analysisObj) {
          analysis = analysisObj;

          // ── P5: Dev-only double-run verification ──────────────────
          if (
            this.doubleRunVerification &&
            effectiveSignal?.aborted !== true &&
            lastAnalysisMessages
          ) {
            let verifyHash = '';
            try {
              const verifyRequest: CompletionRequest = {
                messages: lastAnalysisMessages,
                model: this.model,
                temperature: PASS2_SAMPLING_CONFIG.temperature,
                maxTokens: PASS2_SAMPLING_CONFIG.maxTokens,
                seed: PASS2_SAMPLING_CONFIG.seed,
                taskType: 'pass2',
                responseFormat: { ...PASS2_SAMPLING_CONFIG.responseFormat },
                signal: effectiveSignal,
              };
              verifyHash = this.computeRequestHash(verifyRequest);
              const result2b = await (await this.resolveProvider()).complete(verifyRequest);
              providerCalls.push({
                phase: 'pass2_verify',
                attempt: attempts,
                outcome: 'success',
                requestHash: verifyHash,
                model: this.model,
                seed: 42,
              });
              const analysis2Raw = result2b.content;
              if (analysis2Raw) {
                // Double-run responses are validated against the SAME expected
                // protocol and prose as the primary run — mismatch fails closed.
                const parsed2 = parseAnalysisJSONWithErrors(
                  analysis2Raw,
                  this.analysisContract?.combinedSchema ??
                    this.aggregator?.getCombinedValidationSchema(),
                  lastProtocol,
                  prose,
                );
                if (parsed2.result) {
                  const diffs = compareAnalysisBlocks(analysis.analysis, parsed2.result.analysis);
                  if (diffs.length > 0) {
                    errors.push(`Pass 2 unstable: ${diffs.join(', ')} (${event.id})`);
                  }
                }
              }
            } catch {
              providerCalls.push({
                phase: 'pass2_verify',
                attempt: attempts,
                outcome: 'failure',
                failureReason: sanitizeError('Double-run non-fatal error'),
                requestHash: verifyHash,
                model: this.model,
                seed: 42,
              });
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
            errors.push('Pass 2 exhausted after retry');
          }
          this.logger?.warn(errors[errors.length - 1], {
            eventId,
            attempts,
            phase: 'pass2',
            rejection: pass2Rejection ?? 'unknown',
          });
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
          temperature: PASS2_SAMPLING_CONFIG.temperature,
          maxTokens: PASS2_SAMPLING_CONFIG.maxTokens,
          seed: PASS2_SAMPLING_CONFIG.seed,
          taskType: 'pass2',
          responseFormat: { ...PASS2_SAMPLING_CONFIG.responseFormat },
        });
        providerCalls.push({
          phase: 'pass2',
          attempt: attempts,
          outcome: 'failure',
          failureReason: sanitizeError(err),
          requestHash: failPass2Hash,
          model: this.model,
          seed: 42,
        });
        this.logger?.error(sanitizeError(err), { eventId, attempts, phase: 'pass2' });
        analysis = null;
      }
      this.traceCollector?.record({
        phase: 'pass2',
        state: 'end',
        spanId: `${eventId}:pass2`,
        eventId,
        durationMs: Date.now() - renderStart,
      });
      this.logger?.info('Pass 2 completed', { eventId, attempts });

      // ── Post-render validation ────────────────────────────────────
      renderValidation = null;
      this.traceCollector?.record({
        phase: 'validator',
        state: 'start',
        spanId: `${eventId}:validator`,
        eventId,
      });
      if (this.aggregator) {
        try {
          renderValidation = this.aggregator.validatePost(
            prose,
            event,
            stateBefore,
            analysis ?? undefined,
            this.validatorOverrides,
            this.entities,
            chapter,
            context,
          );
        } catch (err) {
          errors.push(`Post-render validation failed: ${(err as Error).message}`);
        }
      }
      this.traceCollector?.record({
        phase: 'validator',
        state: 'end',
        spanId: `${eventId}:validator`,
        eventId,
        durationMs: Date.now() - renderStart,
      });
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
        this.traceCollector?.record({
          phase: 'circuit',
          state: 'end',
          spanId: `${eventId}:circuit`,
          eventId,
          code: `round_${breaker.state().round}_escalated`,
        });
        this.logger?.warn('Circuit escalation', {
          eventId,
          round: breaker.state().round,
          strategy: breaker.state().escalatedStrategy,
        });
      }

      // Build structured repair guidance from validation errors
      const revResult = analyzeValidationErrors(renderValidation);
      previousErrorMessages = renderValidation.errors.map((e: ValidationIssue) => e.message);

      // Use decideRepairStrategy for strategy selection based on error count
      const repairDecision = decideRepairStrategy(
        revResult,
        breaker.state().round,
        this.maxRetries,
      );

      // Inject repair guidance into retry prompt
      if (
        repairDecision.strategy === 'prompt_fix' ||
        repairDecision.strategy === 'context_enrich'
      ) {
        if (repairDecision.guidance) {
          previousErrorMessages.push(repairDecision.guidance);
        }
      }

      errors.push(
        `Attempt ${attempts} failed validation (${renderValidation.errors.length} errors), ` +
          `round ${breaker.state().round}, strategy: ${breaker.state().escalatedStrategy}`,
      );
      if (job.proseCandidate !== undefined) break;
    }

    const renderEnd = Date.now();
    const needsReview =
      analysis === null ||
      breaker.state().isOpen ||
      (!!renderValidation && !renderValidation.passed);

    const promptHash = sha256Canonical(
      providerCalls.map(({ phase, attempt, requestHash, model, seed }) => ({
        phase,
        attempt,
        requestHash,
        model,
        seed,
      })),
    );

    // Save cache ONLY if validation passed (don't cache bad renders)
    // Cache only analysable, no-error candidates (warning-only ok)
    const hasErrorIssues = renderValidation?.errors.some((e: ValidationIssue) => e.severity === 'error') ?? false;
    const isCacheable = job.proseCandidate === undefined && analysis !== null && !hasErrorIssues;
    if (cacheKey && isCacheable) {
      const evidenceHash = computeEvidenceHash(event.id, event.preconditions ?? [], event.postconditions ?? []);
      const cacheKeyRecord: LayeredCacheKey = { version: 1, sourceHash: job.sourceContentHash, layers: { eventId, logical: logicalKeyStr, surface: surfaceKeyStr } };
      let cacheAnalysis: JsonValue | null;
      try { cacheAnalysis = toJsonValue(analysisRaw ? JSON.parse(analysisRaw) : null); } catch { cacheAnalysis = null; }
      if (cacheAnalysis !== null && typeof cacheAnalysis === 'object' && !Array.isArray(cacheAnalysis)) {
        const output: JsonValue = { prose, analysis: cacheAnalysis, evidenceHash, llmPass1, llmPass2, promptHash, renderedAt: new Date().toISOString(), chapters: [chapter] };
        await setCachedRender(this.renderCache, cacheKeyRecord, { version: 1, key: cacheKeyRecord, recordHash: sha256Canonical({ key: cacheKeyRecord, output }), output });
      }
    }
    this.traceCollector?.record({
      phase: 'pipeline',
      state: 'end',
      spanId: eventId,
      eventId,
      durationMs: renderEnd - renderStart,
    });
    this.logger?.info('Scene render completed', {
      eventId,
      durationMs: renderEnd - renderStart,
      attempts,
      needsReview,
    });
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
      requestRecords,
      attempts,
      needsReview,
      promptHash,
      ...(pass2Rejection !== null ? { pass2Rejection } : {}),
    };
  }

  /**
   * Render multiple scenes in parallel using the concurrency pool.
   * Respects cache for already-rendered scenes.
   *
   * @param jobs - Render jobs to process.
   * @param signal - Optional AbortSignal passed through to each renderScene call.
   */
  async renderAll(jobs: RenderJob[], signal?: AbortSignal): Promise<RenderSceneResult[]> {
    return this.pool.all(jobs, (job) => this.renderScene(job, signal));
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
      return `[${value.map((v) => this.canonicalJson(v)).join(',')}]`;
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${this.canonicalJson(obj[k])}`).join(',')}}`;
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
    return sha256Canonical(projection);
  }
}

// ============================================================================
// evaluateProseCandidate — Shared Pass2+Zod+aggregator+release function
// ============================================================================
// Used by RenderPipeline's Pass 2 retry loop and available as a module export
// for external consumers (e.g. editorial service).
//
// Returns the parsed analysis (or null), rejection category, errors,
// feedback errors for retry, and a release verdict.
// ============================================================================

export interface EvaluateProseCandidateInput {
  prose: string;
  event: NarrativeEvent;
  stateBefore: WorldState;
  context: ContextPackage;
  analysisRaw: string | null;
  chapter: number;
  forceRelease?: boolean;
  aggregator?: ResultAggregator;
  validatorOverrides?: Record<string, 'off' | 'warning' | 'error'>;
  entities?: EntityLookup;
  analysisContract?: AnalysisContract;
  /**
   * Expected measurement protocol for fail-closed comparison. When provided,
   * the parsed response protocol must match EVERY field or the candidate is
   * rejected. Callers that generated the response (e.g. via the pipeline)
   * MUST pass it; callers only inspecting foreign persisted responses may
   * omit it.
   */
  expectedProtocol?: ValidationKey | null;
}

export interface EvaluateProseCandidateResult {
  analysis: AnalysisResult | null;
  pass2Rejection: Pass2RejectionCategory | null;
  errors: string[];
  feedbackErrors: string[];
  release: boolean;
}

export function evaluateProseCandidate(
  input: EvaluateProseCandidateInput,
): EvaluateProseCandidateResult {
  const errors: string[] = [];
  let feedbackErrors: string[] = [];
  let analysis: AnalysisResult | null = null;
  let pass2Rejection: Pass2RejectionCategory | null = null;

  const raw = input.analysisRaw;
  if (!raw || raw.trim().length === 0) {
    pass2Rejection = 'empty';
    feedbackErrors = [
      'Pass 2 returned empty content. Please provide a valid structured JSON analysis for the scene.',
    ];
  } else {
    const schema =
      input.analysisContract?.combinedSchema ?? input.aggregator?.getCombinedValidationSchema();
    const parseResult = parseAnalysisJSONWithErrors(
      raw,
      schema,
      input.expectedProtocol ?? null,
      input.prose,
    );

    if (parseResult.result) {
      analysis = parseResult.result;
      pass2Rejection = null;

      // Run aggregator validation if available
      if (input.aggregator) {
        const validation = input.aggregator.validatePost(
          input.prose,
          input.event,
          input.stateBefore,
          analysis,
          input.validatorOverrides,
          input.entities,
          input.chapter,
          input.context,
        );
        if (!validation.passed) {
          errors.push(...validation.errors.map((e: { message: string }) => e.message));
        }
      }
    } else {
      if (parseResult.parseError) {
        pass2Rejection = 'parse';
        feedbackErrors = [`JSON parse error: ${parseResult.parseError}`];
      } else if (parseResult.zodErrors) {
        pass2Rejection = 'validation';
        feedbackErrors = parseResult.zodErrors.issues.map(
          (i: { path: (string | number)[]; message: string }) =>
            `Validation error at "${i.path.join('.')}": ${i.message}`,
        );
      }
      errors.push(
        pass2Rejection === 'parse'
          ? 'Pass 2 analysis JSON parse failed'
          : 'Pass 2 analysis validation failed',
      );
    }
  }

  const release = analysis !== null || input.forceRelease === true;

  return { analysis, pass2Rejection, errors, feedbackErrors, release };
}

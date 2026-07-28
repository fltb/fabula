// ============================================================================
// ResultAggregator — Collect, grade, and output validation results
// ============================================================================

import * as crypto from 'node:crypto';
import { z } from 'zod';
import { logger } from '../observability/logger.js';
import { ConfigError } from '../errors.ts';
import { canonicalJson, computeSha256Hex } from '../render/scene-contract.ts';
import type { TraceCollector } from '../observability/trace.ts';
import type { PluginValidator } from '../plugin/validator-registry.js';
import type { EventStore } from '../state/event-store.js';
import type {
  AnalysisBlockRequirement,
  AnalysisResult,
  ContextPackage,
  EntityId,
  EntityRegistry,
  EpistemicLedger,
  NarrativeEvent,
  PostRenderInput,
  PreRenderInput,
  ValidationIssue,
  ValidationResult,
  Validator,
  WorldState,
} from '../types/index.js';
import { AliasValidator } from './alias.js';
import { AnachronyConsistencyValidator } from './anachrony-consistency.js';
import { AppearanceValidator } from './appearance.js';
import { buildContext, makeIssue } from './base.js';
import { BranchMergeValidator } from './branch-merge.js';
import { CausalityValidator } from './causality.js';
import { CharacterStateValidator } from './character-state.js';
import { ConflictValidator } from './conflict.js';
import { DiscourseValidator } from './discourse.js';
import { DiscourseBalanceValidator } from './discourse-balance.js';
import { DurationConsistencyValidator } from './duration-consistency.js';
import { FactualDetailValidator } from './factual-detail.js';
import { FocalizationConsistencyValidator } from './focalization-consistency.js';
import { ForeshadowingValidator } from './foreshadowing.js';
import { FrequencyConsistencyValidator } from './frequency-consistency.js';
import { KnowledgeValidator } from './knowledge.js';
import { PacingValidator } from './pacing.js';
import { POVValidator } from './pov.js';
import { PronounValidator } from './pronoun.js';
import { QualityValidator } from './quality.js';
import { ReachabilityValidator } from './reachability.js';
import { TenseConsistencyValidator } from './tense-consistency.js';
import { ThreadProgressValidator } from './thread-progress.js';
import { TimelineValidator } from './timeline.js';
import { VoiceConsistencyValidator } from './voice-consistency.js';
import { VoiceDriftDetector } from './voice-drift.js';
import { WorldRuleValidator } from './world-rule.js';
// ============================================================================
// AnalysisContract — Deterministic validation contract from enabled validators
// ============================================================================

/**
 * A deterministic contract derived from all enabled builtin + plugin validators.
 * Returned by {@link ResultAggregator.getAnalysisContract}.
 * The `hash` covers requirements and schema shape for cache identity.
 */
export interface AnalysisContract {
  /** Merged analysis block requirements from all enabled validators */
  requirements: AnalysisBlockRequirement[];
  /** Combined Zod schema for Pass 2 JSON validation */
  combinedSchema: z.ZodObject<Record<string, z.ZodTypeAny>>;
  /** SHA-256 hash of the canonical requirements + schema shape */
  hash: string;
}

export class ResultAggregator {
  private validators: Validator[];
  private pluginValidators: PluginValidator[];
  private eventStore?: EventStore;
  private traceCollector?: TraceCollector;

  constructor(
    customValidators?: Validator[],
    pluginValidators?: PluginValidator[],
    eventStore?: EventStore,
    traceCollector?: TraceCollector,
  ) {
    this.eventStore = eventStore;
    this.traceCollector = traceCollector;
    this.validators = customValidators ?? [
      new TimelineValidator(),
      new CharacterStateValidator(),
      new KnowledgeValidator(),
      new WorldRuleValidator(),
      new CausalityValidator(),
      new ForeshadowingValidator(),
      new POVValidator(),
      new FactualDetailValidator(),
      new VoiceDriftDetector(),
      new BranchMergeValidator(),
      new ReachabilityValidator(),
      new PacingValidator(),
      new TenseConsistencyValidator(),
      new DiscourseBalanceValidator(),
      new AliasValidator(),
      new PronounValidator(),
      new AppearanceValidator(),
      new ConflictValidator(),
      new QualityValidator(),
      new ThreadProgressValidator(),
      new DurationConsistencyValidator(),
      new FrequencyConsistencyValidator(),
      new VoiceConsistencyValidator(),
      new AnachronyConsistencyValidator(),
      new FocalizationConsistencyValidator(),
      new DiscourseValidator(),
    ];
    this.pluginValidators = pluginValidators ?? [];
  }

  /**
   * Register additional plugin validators after construction.
   */
  addPluginValidators(validators: PluginValidator[]): void {
    this.pluginValidators = [...this.pluginValidators, ...validators];
  }

  /**
   * Compute a deterministic identity for the active validator set.
   * Returns a SHA-256 hash of sorted builtin + plugin validator names.
   * Changes when validators are added/removed or their severity overrides change.
   */
  getValidatorIdentity(): string {
    const names = [
      ...this.validators.map((v) => v.name),
      ...this.pluginValidators.map((v) => v.name),
    ].sort();
    return computeSha256Hex(canonicalJson({ validators: names }));
  }

  /**
   * Run all validators' validatePost/validateRender against rendered prose.
   * Optionally accepts parsed AnalysisResult from LLM Pass 2.
   */
  validateRender(
    prose: string,
    event: NarrativeEvent,
    state: WorldState,
    analysis?: AnalysisResult,
    overrides?: Record<string, 'off' | 'warning' | 'error'>,
    registry?: EntityRegistry,
    chapter: number = 1,
    context?: ContextPackage,
  ): ValidationResult {
    const allIssues: ValidationIssue[] = [];
    const chapterValue = chapter; // Use the parameter (defaults to 1)
    for (const validator of this.validators) {
      const override = overrides?.[validator.name];
      if (override === 'off') continue;

      const valSpanId = `${event.id}:validator:${validator.name}`;
      const startTime = Date.now();
      this.traceCollector?.record({
        phase: 'validator',
        state: 'start',
        spanId: valSpanId,
        eventId: event.id,
      });

      if (validator.validatePost) {
        const input: PostRenderInput = {
          event,
          worldState: state,
          prose,
          analysis: analysis ?? null,
          chapter: chapterValue,
          entityRegistry: registry,
          context,
        };
        const issues = validator.validatePost(input);
        for (const issue of issues) {
          if (override === 'error') {
            issue.severity = 'error';
          } else if (override === 'warning' && issue.severity !== 'error') {
            issue.severity = 'warning';
          }
          allIssues.push(issue);
        }
      } else if (validator.validateRender) {
        // Old path fallback: validateRender
        const issues = validator.validateRender(prose, event, state, analysis);
        for (const issue of issues) {
          if (override === 'error') {
            issue.severity = 'error';
          } else if (override === 'warning' && issue.severity !== 'error') {
            issue.severity = 'warning';
          }
          allIssues.push(issue);
        }
      }

      this.traceCollector?.record({
        phase: 'validator',
        state: 'end',
        spanId: valSpanId,
        eventId: event.id,
        durationMs: Date.now() - startTime,
      });
    }

    // Plugin validators with validatePost
    for (const plugin of this.pluginValidators) {
      const override = overrides?.[plugin.name];
      if (override === 'off') continue;
      if (!plugin.validatePost) continue;

      try {
        const input: PostRenderInput = {
          event,
          worldState: state,
          prose,
          analysis: analysis ?? null,
          chapter: chapterValue,
          entityRegistry: registry,
          context,
        };
        const issues = plugin.validatePost(input);
        for (const issue of issues) {
          if (override === 'error') {
            issue.severity = 'error';
          } else if (override === 'warning' && issue.severity !== 'error') {
            issue.severity = 'warning';
          }
          allIssues.push(issue);
        }
      } catch (err) {
        allIssues.push(
          makeIssue(
            this.constructor.name,
            event.id,
            'system',
            'error',
            `Plugin "${plugin.name}" validatePost failed: ${(err as Error).message}`,
            'Check the plugin implementation.',
            'manual',
          ),
        );
      }
    }

    const errors = allIssues.filter((i) => i.severity === 'error');
    const warnings = allIssues.filter((i) => i.severity === 'warning');
    const infos = allIssues.filter((i) => i.severity === 'info');

    return {
      passed: errors.length === 0,
      errors,
      warnings,
      infos,
    };
  }

  /**
   * Run all validators against an event.
   */
  validate(
    event: NarrativeEvent,
    state: WorldState,
    registry: EntityRegistry,
    events: NarrativeEvent[],
    chapter: number,
    overrides?: Record<string, 'off' | 'warning' | 'error'>,
  ): ValidationResult {
    const allIssues: ValidationIssue[] = [];

    for (const validator of this.validators) {
      // Check if validator is disabled
      const override = overrides?.[validator.name];
      if (override === 'off') continue;

      const valSpanId = `${event.id}:validator:${validator.name}`;
      const startTime = Date.now();
      this.traceCollector?.record({
        phase: 'validator',
        state: 'start',
        spanId: valSpanId,
        eventId: event.id,
      });

      // New path: validatePre
      if (validator.validatePre) {
        const input: PreRenderInput = {
          event,
          worldState: state,
          events,
          entityRegistry: registry,
          chapter,
          eventStore: this.eventStore,
          queryState: (entityId: EntityId, attr: string) => state.entities[entityId]?.[attr],
          getKnowledge: (_characterId: EntityId) =>
            state.epistemicLedger ?? { claims: {}, bySubject: {}, byProposition: {}, actLog: [] },
          getThreadProgress: (threadId: string) => state.threads[threadId] ?? null,
        };
        const issues = validator.validatePre(input);
        for (const issue of issues) {
          if (override === 'error') {
            issue.severity = 'error';
          } else if (override === 'warning' && issue.severity !== 'error') {
            issue.severity = 'warning';
          }
          allIssues.push(issue);
        }
        this.traceCollector?.record({
          phase: 'validator',
          state: 'end',
          spanId: valSpanId,
          eventId: event.id,
          durationMs: Date.now() - startTime,
        });
        continue;
      }

      // Old path fallback: validate
      if (validator.validate) {
        const context = buildContext(event, state, registry, events, chapter);
        const issues = validator.validate(event, context);

        // Apply severity override
        for (const issue of issues) {
          if (override === 'error') {
            issue.severity = 'error';
          } else if (override === 'warning') {
            issue.severity = issue.severity === 'error' ? 'error' : 'warning';
          }
          allIssues.push(issue);
        }
      }

      this.traceCollector?.record({
        phase: 'validator',
        state: 'end',
        spanId: valSpanId,
        eventId: event.id,
        durationMs: Date.now() - startTime,
      });
    }

    // Run plugin validators (still use ValidatorContext)
    if (this.pluginValidators.length > 0) {
      const context = buildContext(event, state, registry, events, chapter);
      for (const pv of this.pluginValidators) {
        try {
          const result = pv.validate(context);
          for (const issue of result.errors) allIssues.push(issue as unknown as ValidationIssue);
          for (const issue of result.warnings) allIssues.push(issue as unknown as ValidationIssue);
        } catch (err) {
          allIssues.push(
            makeIssue(
              this.constructor.name,
              event.id,
              'system',
              'error',
              `Plugin validator "${pv.name}" failed: ${(err as Error).message}`,
              'Check the plugin implementation.',
              'manual',
            ),
          );
        }
      }
    }

    const errors = allIssues.filter((i) => i.severity === 'error');
    const warnings = allIssues.filter((i) => i.severity === 'warning');
    const infos = allIssues.filter((i) => i.severity === 'info');

    return {
      passed: errors.length === 0,
      errors,
      warnings,
      infos,
    };
  }

  /**
   * Run all validators against all events in order.
   */
  validateAll(
    events: NarrativeEvent[],
    state: WorldState,
    registry: EntityRegistry,
    overrides?: Record<string, 'off' | 'warning' | 'error'>,
    stateBeforeByEventId?: Map<string, WorldState>,
  ): Map<string, ValidationResult> {
    const results = new Map<string, ValidationResult>();

    for (const event of events) {
      if (event.id === 'system:genesis') continue;

      const chapter = Math.max(1, Math.ceil(event.narrativeOrder / 3));
      const eventState = stateBeforeByEventId?.get(event.id) ?? state;
      const result = this.validate(event, eventState, registry, events, chapter, overrides);
      results.set(event.id, result);
    }

    return results;
  }

  /** List all registered validators */
  listValidators(): Array<{ name: string; category: string }> {
    return this.validators.map((v) => ({
      name: v.name,
      category: v.category,
    }));
  }

  /**
   * Look up a validator's category by name. Throws if no validator with that name exists.
   */
  getValidatorCategory(name: string): Validator['category'] {
    const validator = this.validators.find((v) => v.name === name);
    if (!validator) {
      throw new Error(`Unknown validator: "${name}". No validator registered with that name.`);
    }
    return validator.category;
  }

  /**
   * Collect analysis block requirements from all validators that provide them.
   * These drive dynamic construction of the Pass 2 JSON template + instructions.
   * Delegates to getAnalysisContract() for deterministic merged output.
   */
  getAnalysisRequirements(): AnalysisBlockRequirement[] {
    return this.getAnalysisContract({}).requirements;
  }

  /**
   * Build a runtime Zod schema from all validator analysis blocks,
   * including plugin validators. Use this for Pass 2 JSON validation.
   * Delegates to getAnalysisContract() for deterministic merged output.
   */
  getCombinedValidationSchema(): z.ZodObject<Record<string, z.ZodTypeAny>> {
    return this.getAnalysisContract({}).combinedSchema;
  }

  /**
   * Get a deterministic analysis contract from all enabled builtin + plugin
   * validators, excluding any validator whose override is 'off'.
   *
   * Returns merged requirements, combined validation schema, and a SHA-256
   * fingerprint of the contract for cache identity.
   *
   * Throws {@link ConfigError} on:
   * - Incompatible schemas for the same field from different validators
   * - Duplicate attribute ownership across validators for the same field
   */
  getAnalysisContract(
    overrides?: Record<string, 'off' | 'warning' | 'error'>,
  ): AnalysisContract {
    // ── Filter enabled validators ────────────────────────────────
    const enabledValidators = this.validators.filter(
      (v) => overrides?.[v.name] !== 'off',
    );
    const enabledPluginValidators = this.pluginValidators.filter(
      (v) => overrides?.[v.name] !== 'off',
    );

    // ── Collect raw requirements from all enabled validators ──────
    const raw: AnalysisBlockRequirement[] = [];
    for (const v of enabledValidators) {
      if (v.getAnalysisRequirements) raw.push(...v.getAnalysisRequirements());
    }
    for (const v of enabledPluginValidators) {
      if (v.getAnalysisRequirements) raw.push(...v.getAnalysisRequirements());
    }

    // ── Merge by field, detecting attribute / schema conflicts ──
    const merged = new Map<string, AnalysisBlockRequirement>();
    for (const req of raw) {
      const existing = merged.get(req.field);
      if (!existing) {
        merged.set(req.field, { ...req, attributes: [...(req.attributes ?? [])] });
      } else {
        // Detect incompatible schemas for same dotted field
        const areCompatible = JSON.stringify(existing.schema) === JSON.stringify(req.schema);
        if (!areCompatible) {
          throw new ConfigError(
            `Incompatible schema for analysis field "${req.field}": ` +
              `validators contributed conflicting schemas.`,
          );
        }
        // Detect duplicate attribute ownership
        if (req.attributes && req.attributes.length > 0) {
          const existingAttrs = new Set(existing.attributes ?? []);
          for (const attr of req.attributes) {
            if (existingAttrs.has(attr)) {
              throw new ConfigError(
                `Duplicate attribute "${attr}" in field "${req.field}": ` +
                  `each attribute must be unique per field.`,
              );
            }
            existingAttrs.add(attr);
          }
          existing.attributes = [...existingAttrs];
        }
        // Merge instructions
        existing.instruction = existing.instruction + '\n\n' + req.instruction;
      }
    }
    const requirements = [...merged.values()];

    // ── Build combined schema, detecting top-level field conflicts ──
    const shape: Record<string, z.ZodTypeAny> = {};
    const fieldSources = new Map<string, string>();
    const pluginNames = new Set(enabledPluginValidators.map((p) => p.name));
    const allEnabled: Array<Validator | PluginValidator> = [
      ...enabledValidators,
      ...enabledPluginValidators,
    ];
    for (const v of allEnabled) {
      if (v.getAnalysisRequirements) {
        for (const req of v.getAnalysisRequirements()) {
          const tf = req.field.includes('.') ? req.field.split('.')[0] : req.field;
          const existingShape = shape[tf];
          if (existingShape !== undefined) {
            const existingSource = fieldSources.get(tf) ?? 'unknown';
            const currentSource = v.name;
            const areCompatible = JSON.stringify(existingShape) === JSON.stringify(req.schema);
            if (!areCompatible) {
              throw new ConfigError(
                `Schema conflict for field "${tf}": validators "${existingSource}" ` +
                  `and "${currentSource}" have incompatible schemas.`,
              );
            }
          } else {
            fieldSources.set(tf, v.name);
            // Plugin fields without validatePost consumer are optional
            // (they declare analysis needs but can't post-consume them)
            const isPluginWithoutPost =
              pluginNames.has(v.name) && !('validatePost' in v);
            shape[tf] = isPluginWithoutPost ? req.schema.optional() : req.schema;
          }
        }
      }
    }
    const combinedSchema = z.object(shape);

    // ── Compute deterministic SHA-256 fingerprint ─────────────────
    // Hash covers sorted requirements (by field) and schema shape keys
    // for cache identity. Schema shapes are already validated as compatible,
    // so sorted field+type pairs are sufficient for identity.
    const sortedRequirements = [...requirements].sort((a, b) =>
      a.field.localeCompare(b.field),
    );
    const schemaEntries = Object.keys(shape).sort().map((k) => ({
      field: k,
      optional: shape[k].isOptional?.() ?? false,
    }));
    const hashInput = canonicalJson({
      requirements: sortedRequirements,
      schema: schemaEntries,
    });
    const hash = computeSha256Hex(hashInput);

    return { requirements, combinedSchema, hash };
  }
}

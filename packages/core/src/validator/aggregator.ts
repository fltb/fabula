// ============================================================================
// ResultAggregator — Collect, grade, and output validation results
// ============================================================================

import { z } from 'zod';
import { ConfigError } from '../errors.ts';
import type { TraceCollector } from '../observability/trace.ts';
import type { PluginValidator } from '../plugin/validator-registry.js';
import { canonicalJson, computeSha256Hex } from '../render/scene-contract.ts';
import type { EventStore } from '../state/event-store.js';
import type {
  AnalysisBlockRequirement,
  AnalysisObservation,
  AnalysisResult,
  ContextPackage,
  EntityId,
  EntityRegistry,
  EntityTypeCatalog,
  NarrativeEvent,
  ObservationRef,
  PostRenderInput,
  PreRenderInput,
  ValidationIssue,
  ValidationResult,
  ValidationRunOptions,
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
import { ChecklistValidator } from './checklist.js';
import { ConflictValidator } from './conflict.js';
import { DiscourseValidator } from './discourse.js';
import { DiscourseBalanceValidator } from './discourse-balance.js';
import { DurationConsistencyValidator } from './duration-consistency.js';
import { FactualDetailValidator } from './factual-detail.js';
import { FocalizationConsistencyValidator } from './focalization-consistency.js';
import { ForeshadowingValidator } from './foreshadowing.js';
import { FrequencyConsistencyValidator } from './frequency-consistency.js';
import { KnowledgeValidator } from './knowledge.js';
import { NarrativeTechniqueValidator } from './narrative-technique.js';
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
  private entityTypeCatalog?: EntityTypeCatalog;
  constructor(
    customValidators?: Validator[],
    pluginValidators?: PluginValidator[],
    eventStore?: EventStore,
    traceCollector?: TraceCollector,
    entityTypeCatalog?: EntityTypeCatalog,
  ) {
    this.eventStore = eventStore;
    this.traceCollector = traceCollector;
    this.entityTypeCatalog = entityTypeCatalog;
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
      new ChecklistValidator(),
      new NarrativeTechniqueValidator(),
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

  /** Deterministic built-in and plugin validator identities for provenance. */
  listValidatorIdentities(builtInVersion: string): Array<{ name: string; version: string }> {
    return [
      ...this.validators.map((validator) => ({
        name: validator.name,
        version: builtInVersion,
      })),
      ...this.pluginValidators.map((validator) => ({
        name: validator.name,
        version: validator.version ?? builtInVersion,
      })),
    ].sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
    );
  }

  /**
   * Run all validators' validatePost/validateRender against rendered prose.
   * Optionally accepts parsed AnalysisResult from LLM Pass 2.
   *
   * Pass 2 integration:
   * 1. Uncertainty preflight — a validator whose required field was
   *    `abstained`/`ambiguous` is NOT handed the missing payload; instead the
   *    aggregator emits one `analysis_uncertainty` finding per (validator, field)
   *    with `observationRef.field`, default severity `warning` (existing
   *    overrides still apply; severity is never derived from the disposition).
   * 2. Field attribution — findings on a produced single-object field get the
   *    field reference auto-filled; array/multi-field consumers provide exact
   *    RFC 6901 pointers at their issue-construction site.
   * 3. Pointer validation — every `observationRef` must reference an existing
   *    observation; every `analysisPointer` must be a valid RFC 6901 pointer
   *    whose first segment matches `field` and that resolves into
   *    `AnalysisResult.analysis`. Invalid references are rejected (fail closed
   *    as `compiler_invariant` errors).
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
    const observations = analysis?.observations ?? {};

    // ── Uncertainty preflight: fields that were abstained/ambiguous ──
    const uncertainFieldsByValidator = new Map<string, string[]>();
    const collectUncertainFields = (v: {
      name: string;
      getAnalysisRequirements?(): AnalysisBlockRequirement[];
    }): string[] => {
      if (overrides?.[v.name] === 'off') return [];
      let fields: string[] = [];
      try {
        fields = (v.getAnalysisRequirements?.() ?? []).map((req) => req.field.split('.')[0]);
      } catch {
        fields = [];
      }
      return [...new Set(fields)].filter((field) => {
        const obs = observations[field];
        return obs !== undefined && obs.disposition !== 'produced';
      });
    };
    for (const validator of this.validators) {
      const uncertain = collectUncertainFields(validator);
      if (uncertain.length > 0) uncertainFieldsByValidator.set(validator.name, uncertain);
    }
    for (const plugin of this.pluginValidators) {
      const uncertain = collectUncertainFields(plugin);
      if (uncertain.length > 0) uncertainFieldsByValidator.set(plugin.name, uncertain);
    }

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

      const uncertainFields = uncertainFieldsByValidator.get(validator.name);
      if (uncertainFields && uncertainFields.length > 0) {
        // Do not hand the missing payload to the validator.
        for (const field of uncertainFields) {
          // Preflight already guarantees a non-produced observation for this
          // field; narrow so only abstained/ambiguous reaches the helper.
          const observation = observations[field];
          if (observation !== undefined && observation.disposition !== 'produced') {
            const issue = this.makeUncertaintyIssue(validator.name, event.id, field, observation);
            this.applySeverityOverride(issue, override);
            allIssues.push(issue);
          }
        }
      } else if (validator.validatePost) {
        const input: PostRenderInput = {
          event,
          worldState: state,
          prose,
          analysis: analysis ?? null,
          chapter: chapterValue,
          entityRegistry: registry,
          entityTypeCatalog: this.entityTypeCatalog,
          context,
        };
        const issues = validator.validatePost(input);
        for (const issue of issues) {
          this.applySeverityOverride(issue, override);
          allIssues.push(issue);
        }
      } else if (validator.validateRender) {
        // Old path fallback: validateRender
        const issues = validator.validateRender(prose, event, state, analysis);
        for (const issue of issues) {
          this.applySeverityOverride(issue, override);
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

      const uncertainFields = uncertainFieldsByValidator.get(plugin.name);
      if (uncertainFields && uncertainFields.length > 0) {
        for (const field of uncertainFields) {
          const observation = observations[field];
          if (observation !== undefined && observation.disposition !== 'produced') {
            const issue = this.makeUncertaintyIssue(plugin.name, event.id, field, observation);
            this.applySeverityOverride(issue, override);
            allIssues.push(issue);
          }
        }
        continue;
      }

      try {
        const input: PostRenderInput = {
          event,
          worldState: state,
          prose,
          analysis: analysis ?? null,
          chapter: chapterValue,
          entityRegistry: registry,
          entityTypeCatalog: this.entityTypeCatalog,
        };
        const issues = plugin.validatePost(input);
        for (const issue of issues) {
          this.applySeverityOverride(issue, override);
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

    // ── Field attribution + RFC 6901 pointer validation ────────────
    const finalIssues = this.finalizeObservationRefs(allIssues, analysis);

    const errors = finalIssues.filter((i) => i.severity === 'error');
    const warnings = finalIssues.filter((i) => i.severity === 'warning');
    const infos = finalIssues.filter((i) => i.severity === 'info');

    return {
      passed: errors.length === 0,
      errors,
      warnings,
      infos,
    };
  }

  /**
   * Apply an existing severity override to an issue, preserving the original
   * severity when no override applies. Uncertainty severity is never derived
   * from the observation disposition — only explicit overrides change it.
   */
  private applySeverityOverride(
    issue: ValidationIssue,
    override: 'off' | 'warning' | 'error' | undefined,
  ): void {
    if (override === 'error') {
      issue.severity = 'error';
    } else if (override === 'warning' && issue.severity !== 'error') {
      issue.severity = 'warning';
    }
  }

  /**
   * Stable `analysis_uncertainty` finding for one (validator, field) pair whose
   * Pass 2 measurement was abstained/ambiguous. Default severity is `warning`;
   * the existing override map can promote or demote it.
   */
  private makeUncertaintyIssue(
    validator: string,
    eventId: string,
    field: string,
    observation: Exclude<AnalysisObservation, { disposition: 'produced' }>,
  ): ValidationIssue {
    const detail =
      observation.disposition === 'abstained'
        ? `reason: ${observation.reason}`
        : `alternatives: ${observation.alternatives.length} competing readings with prose evidence`;
    return makeIssue(
      validator,
      eventId,
      'system',
      'warning',
      `Pass 2 measurement for analysis field "${field}" is ${observation.disposition} (${detail}) — validator "${validator}" was not evaluated against uncertain prose evidence`,
      'Review the measurement uncertainty in Pass 2, or waive this finding if the uncertainty is acceptable.',
      'manual',
      undefined,
      undefined,
      undefined,
      'analysis_uncertainty',
      { field },
    );
  }

  /**
   * Auto-fill field references for produced single-object fields and validate
   * every observationRef. Invalid references are rejected and replaced by a
   * fail-closed `compiler_invariant` error so misaligned findings can never
   * pass the release gate under a false attribution.
   */
  private finalizeObservationRefs(
    issues: ValidationIssue[],
    analysis: AnalysisResult | null | undefined,
  ): ValidationIssue[] {
    if (!analysis || !analysis.observations) return issues;
    const observations = analysis.observations;

    // Single-requirement validators with a non-array (single-object) field get
    // the field reference auto-filled for findings lacking an explicit ref.
    const autoFillField = new Map<string, string>();
    for (const v of [...this.validators, ...this.pluginValidators]) {
      let requirements: AnalysisBlockRequirement[] = [];
      try {
        requirements = v.getAnalysisRequirements?.() ?? [];
      } catch {
        requirements = [];
      }
      if (requirements.length !== 1) continue;
      if (isArrayLikeSchema(requirements[0].schema)) continue;
      autoFillField.set(v.name, requirements[0].field.split('.')[0]);
    }

    const finalIssues: ValidationIssue[] = [];
    for (const issue of issues) {
      let ref = issue.observationRef;
      if (ref === undefined) {
        const field = autoFillField.get(issue.validator);
        if (field !== undefined && observations[field] !== undefined) ref = { field };
      }
      if (ref === undefined) {
        finalIssues.push(issue);
        continue;
      }
      const invalidReason = invalidObservationRefReason(ref, observations, analysis.analysis);
      if (invalidReason !== null) {
        finalIssues.push(
          makeIssue(
            issue.validator,
            issue.event,
            'system',
            'error',
            `Invalid observationRef on finding from validator "${issue.validator}": ${invalidReason}`,
            'Fix the validator to emit an observationRef whose field and RFC 6901 pointer resolve into the Pass 2 analysis, or drop the reference.',
            'manual',
            undefined,
            undefined,
            undefined,
            'compiler_invariant',
          ),
        );
        continue;
      }
      finalIssues.push({ ...issue, observationRef: ref });
    }
    return finalIssues;
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
    options: ValidationRunOptions = {},
  ): ValidationResult {
    const { overrides, story } = options;
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
          entityTypeCatalog: this.entityTypeCatalog,
          queryState: (entityId: EntityId, attr: string) => state.entities[entityId]?.[attr],
          getKnowledge: (_characterId: EntityId) =>
            state.epistemicLedger ?? { claims: {}, bySubject: {}, byProposition: {}, actLog: [] },
          getThreadProgress: (threadId: string) => state.threads[threadId] ?? null,
          story,
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
    options: ValidationRunOptions = {},
  ): Map<string, ValidationResult> {
    const { overrides, stateBeforeByEventId, story } = options;
    const results = new Map<string, ValidationResult>();

    for (const event of events) {
      const chapter = Math.max(1, Math.ceil(event.narrativeOrder / 3));
      const eventState = stateBeforeByEventId?.get(event.id) ?? state;
      const result = this.validate(event, eventState, registry, events, chapter, {
        overrides,
        story,
      });
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
  getAnalysisContract(overrides?: Record<string, 'off' | 'warning' | 'error'>): AnalysisContract {
    // ── Filter enabled validators ────────────────────────────────
    const enabledValidators = this.validators.filter((v) => overrides?.[v.name] !== 'off');
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
            const isPluginWithoutPost = pluginNames.has(v.name) && !('validatePost' in v);
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
    const sortedRequirements = [...requirements].sort((a, b) => a.field.localeCompare(b.field));
    const schemaEntries = Object.keys(shape)
      .sort()
      .map((k) => ({
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

// ============================================================================
// ObservationRef validation helpers (RFC 6901)
// ============================================================================

/** True when the schema describes an array-shaped block (or an optional array). */
function isArrayLikeSchema(schema: z.ZodTypeAny): boolean {
  if (schema instanceof z.ZodArray) return true;
  if (schema instanceof z.ZodOptional) {
    return isArrayLikeSchema(schema._def.innerType as z.ZodTypeAny);
  }
  return false;
}

/**
 * Resolve an RFC 6901 JSON pointer against a payload root.
 * Returns the resolved value on success; the `ok` flag is false for
 * malformed pointers, missing object keys, and out-of-range array indices.
 */
function resolveJsonPointer(
  root: unknown,
  pointer: string,
): { ok: true; value: unknown } | { ok: false } {
  if (pointer === '') return { ok: true, value: root };
  if (!pointer.startsWith('/')) return { ok: false };
  const segments = pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return { ok: false };
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return { ok: false };
      const index = Number(segment);
      if (index >= current.length) return { ok: false };
      current = current[index];
    } else if (Object.hasOwn(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return { ok: false };
    }
  }
  return { ok: true, value: current };
}

/**
 * Validate an observationRef against the observation map and the analysis
 * payload. Returns a human-readable reason when invalid, `null` when valid.
 * A pointer must resolve into `AnalysisResult.analysis` and its first segment
 * must equal `observationRef.field`.
 */
function invalidObservationRefReason(
  ref: ObservationRef,
  observations: Record<string, AnalysisObservation>,
  payload: Record<string, unknown>,
): string | null {
  if (observations[ref.field] === undefined) {
    return `observationRef.field "${ref.field}" does not match any Pass 2 observation`;
  }
  if (ref.analysisPointer !== undefined) {
    const pointer = ref.analysisPointer;
    if (!pointer.startsWith('/')) {
      return `analysisPointer "${pointer}" is not an RFC 6901 pointer`;
    }
    const firstSegment = pointer.split('/')[1] ?? '';
    if (firstSegment !== ref.field) {
      return `analysisPointer "${pointer}" first segment "${firstSegment}" does not match observationRef.field "${ref.field}"`;
    }
    if (!resolveJsonPointer(payload, pointer).ok) {
      return `analysisPointer "${pointer}" does not resolve into AnalysisResult.analysis`;
    }
  }
  return null;
}

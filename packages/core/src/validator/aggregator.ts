// ============================================================================
// ResultAggregator — Collect, grade, and output validation results
// ============================================================================

import { z } from 'zod';
import type {
  NarrativeEvent,
  WorldState,
  EntityRegistry,
  EntityId,
  ValidationIssue,
  ValidationResult,
  AnalysisResult,
  PreRenderInput,
  PostRenderInput,
  KnowledgeState,
  AnalysisBlockRequirement,
} from '../types/index.js';
import type { Validator } from '../types/index.js';
import type { PluginValidator } from '../plugin/validator-registry.js';
import { buildContext, makeIssue } from './base.js';
import { TimelineValidator } from './timeline.js';
import { CharacterStateValidator } from './character-state.js';
import { KnowledgeValidator } from './knowledge.js';
import { WorldRuleValidator } from './world-rule.js';
import { CausalityValidator } from './causality.js';
import { ForeshadowingValidator } from './foreshadowing.js';
import { POVValidator } from './pov.js';
import { FactualDetailValidator } from './factual-detail.js';
import { VoiceDriftDetector } from './voice-drift.js';
import { BranchMergeValidator } from './branch-merge.js';
import { ReachabilityValidator } from './reachability.js';
import { PacingValidator } from './pacing.js';
import { TenseConsistencyValidator } from './tense-consistency.js';
import { DiscourseBalanceValidator } from './discourse-balance.js';
import { AliasValidator } from './alias.js';
import { PronounValidator } from './pronoun.js';
import { AppearanceValidator } from './appearance.js';
import { ConflictValidator } from './conflict.js';
import { QualityValidator } from './quality.js';
import { ThreadProgressValidator } from './thread-progress.js';

import type { EventStore } from '../state/event-store.js';

export class ResultAggregator {
  private validators: Validator[];
  private pluginValidators: PluginValidator[];
  private eventStore?: EventStore;

  constructor(
    customValidators?: Validator[],
    pluginValidators?: PluginValidator[],
    eventStore?: EventStore,
  ) {
    this.eventStore = eventStore;
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
  ): ValidationResult {
    const allIssues: ValidationIssue[] = [];
    const chapterValue = chapter; // Use the parameter (defaults to 1)

    for (const validator of this.validators) {
      const override = overrides?.[validator.name];
      if (override === 'off') continue;

      if (validator.validatePost) {
        const input: PostRenderInput = { event, worldState: state, prose, analysis: analysis ?? null, chapter: chapterValue, entityRegistry: registry };
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
          getKnowledge: () => ({ worldTruth: [], characterKnowledge: {}, readerKnowledge: [], narratorKnowledge: [] } as KnowledgeState),
          getThreadProgress: (threadId: string) => state.threads[threadId] ?? { progress: 0, total: 0 },
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
          allIssues.push(makeIssue(
            this.constructor.name,
            event.id,
            'system',
            'error',
            `Plugin validator "${pv.name}" failed: ${(err as Error).message}`,
            'Check the plugin implementation.',
            'manual',
          ));
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
   * Merges requirements by field, detecting attribute conflicts on shared fields.
   */
  getAnalysisRequirements(): AnalysisBlockRequirement[] {
    const all: AnalysisBlockRequirement[] = [];
    for (const validator of this.validators) {
      if (validator.getAnalysisRequirements) {
        all.push(...validator.getAnalysisRequirements());
      }
    }

    // Merge requirements by field, detecting attribute conflicts
    const merged = new Map<string, AnalysisBlockRequirement>();
    for (const req of all) {
      const existing = merged.get(req.field);
      if (!existing) {
        merged.set(req.field, { ...req, attributes: [...(req.attributes ?? [])] });
      } else {
        // Check for attribute conflicts
        if (req.attributes && req.attributes.length > 0) {
          const existingAttrs = new Set(existing.attributes ?? []);
          for (const attr of req.attributes) {
            if (existingAttrs.has(attr)) {
              throw new Error(
                `AnalysisBlockRequirement conflict: attribute "${attr}" in field "${req.field}" ` +
                `is claimed by multiple validators. Each attribute must be unique per field.`,
              );
            }
            existingAttrs.add(attr);
          }
          existing.attributes = [...existingAttrs];
        }
        // Merge instructions
        existing.instruction = existing.instruction + '\n\n' + req.instruction;
        // Keep first schema (structurally identical for same field)
      }
    }

    return [...merged.values()];
  }

  /**
   * Build a runtime Zod schema from all validator analysis blocks,
   * including plugin validators. Use this for Pass 2 JSON validation.
   */
  getCombinedValidationSchema(): z.ZodObject<Record<string, z.ZodTypeAny>> {
    const shape: Record<string, z.ZodTypeAny> = {};
    const allValidators: Array<Validator | PluginValidator> = [
      ...this.validators,
      ...this.pluginValidators,
    ];
    for (const validator of allValidators) {
      if (validator.getAnalysisRequirements) {
        for (const req of validator.getAnalysisRequirements()) {
          const tf = req.field.includes('.') ? req.field.split('.')[0] : req.field;
          shape[tf] = req.schema;
        }
      }
    }
    return z.object(shape);
  }
}

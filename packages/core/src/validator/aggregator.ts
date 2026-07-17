// ============================================================================
// ResultAggregator — Collect, grade, and output validation results
// ============================================================================

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

export class ResultAggregator {
  private validators: Validator[];
  private pluginValidators: PluginValidator[];

  constructor(
    customValidators?: Validator[],
    pluginValidators?: PluginValidator[],
  ) {
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
  ): ValidationResult {
    const allIssues: ValidationIssue[] = [];
    const chapter = 1; // Caller should provide — current validators derive it internally

    for (const validator of this.validators) {
      const override = overrides?.[validator.name];
      if (override === 'off') continue;

      // New path: validatePost
      if (validator.validatePost) {
        const input: PostRenderInput = { event, worldState: state, prose, analysis: analysis ?? null, chapter };
        const issues = validator.validatePost(input);
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

      // Old path fallback: validateRender
      if (validator.validateRender) {
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
          queryState: (entityId: EntityId, attr: string) => state.entities[entityId]?.[attr],
          getKnowledge: () => ({ worldTruth: [], characterKnowledge: {}, readerKnowledge: [], narratorKnowledge: [] } as KnowledgeState),
          getThreadProgress: (threadId: string) => state.threads[threadId] ?? { progress: 0, total: 0 },
          getRuleEvidence: () => [],
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
  ): Map<string, ValidationResult> {
    const results = new Map<string, ValidationResult>();

    for (const event of events) {
      if (event.id === 'system:genesis') continue;

      const chapter = Math.max(1, Math.ceil(event.narrativeOrder / 3));
      const result = this.validate(event, state, registry, events, chapter, overrides);
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
}

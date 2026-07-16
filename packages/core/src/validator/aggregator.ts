// ============================================================================
// ResultAggregator — Collect, grade, and output validation results
// ============================================================================

import type {
  NarrativeEvent,
  WorldState,
  EntityRegistry,
  ValidationIssue,
  ValidationResult,
} from '../types/index.js';
import type { Validator } from '../types/index.js';
import { buildContext } from './base.js';
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

  constructor(customValidators?: Validator[]) {
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
    const context = buildContext(event, state, registry, events, chapter);
    const allIssues: ValidationIssue[] = [];

    for (const validator of this.validators) {
      // Check if validator is disabled
      const override = overrides?.[validator.name];
      if (override === 'off') continue;

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
  listValidators(): Array<{ name: string; category: string; requiresLLM: boolean }> {
    return this.validators.map((v) => ({
      name: v.name,
      category: v.category,
      requiresLLM: v.requiresLLM,
    }));
  }
}

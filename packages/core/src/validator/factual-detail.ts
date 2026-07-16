// ============================================================================
// FactualDetailValidator — LLM-assisted detail checking
// ============================================================================

import type {
  NarrativeEvent,
  Validator,
  ValidatorContext,
  ValidationIssue,
  WorldState,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class FactualDetailValidator implements Validator {
  name = 'factual_detail';
  category = 'factual_detail' as const;
  requiresLLM = true;

  validate(event: NarrativeEvent, context: ValidatorContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Deterministic part: check entity attribute consistency
    for (const pc of event.preconditions) {
      const entity = context.entityRegistry.resolve(pc.entityId);
      if (!entity) continue;

      const currentValue = context.queryState(pc.entityId, pc.attribute);
      const currentTraits = entity.state['traits'] as string[] | undefined;

      // Check trait-level contradictions
      if (pc.attribute === 'traits' && currentTraits) {
        const requestedTraits = Array.isArray(pc.value) ? pc.value : [pc.value];
        for (const trait of requestedTraits) {
          if (currentTraits.includes(trait as string)) {
            issues.push(makeIssue(
              this.name, event.id, pc.entityId, 'info',
              `Trait "${trait}" confirmed for "${pc.entityId}"`,
              'No action needed.',
              'manual',
            ));
          }
        }
      }
    }

    // Check for naming inconsistencies: entity IDs should match across references
    for (const pc of event.preconditions) {
      if (pc.value === 'changed' || pc.value === 'resolved' || pc.value === 'updated') {
        issues.push(makeIssue(
          this.name, event.id, pc.entityId, 'warning',
          `Placeholder value "${pc.value}" used for "${pc.entityId}.${pc.attribute}" — this is not a verifiable fact`,
          'Use a specific, concrete value instead of a placeholder.',
          'change_value',
          pc.attribute,
        ));
      }
    }

    return issues;
  }

  validateRender(prose: string, event: NarrativeEvent, state: WorldState): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const ordinals = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

    const allFacts = [...event.preconditions, ...event.postconditions];
    for (const fact of allFacts) {
      const val = fact.value;
      if (val === null || val === undefined) continue;

      const valStr = String(val);

      // Exact match
      if (prose.includes(valStr)) continue;

      // Ordinal form for small integers: "3" -> "third"
      const num = Number(valStr);
      if (!isNaN(num) && Number.isInteger(num) && num >= 1 && num <= 10) {
        if (new RegExp(`\\b${ordinals[num]}\\b`, 'i').test(prose)) continue;
      }

      // Number + unit pattern: "3 hours", "midnight of the third day"
      if (!isNaN(num)) {
        const unitPattern = new RegExp(
          `\\b${valStr}\\s+(hours?|minutes?|days?|weeks?|months?|o'clock|am|pm|%|percent|dollars?|miles?|feet?|degrees?)`,
          'i',
        );
        if (unitPattern.test(prose)) continue;
      }

      issues.push(makeIssue(
        this.name, event.id, fact.entityId, 'warning',
        `Prose does not mention factual detail "${fact.entityId}.${fact.attribute} = ${valStr}"`,
        'Include this factual detail in the narrative prose.',
        'edit_file',
        fact.attribute,
      ));
    }

    return issues;
  }
}

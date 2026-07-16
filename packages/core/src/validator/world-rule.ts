// ============================================================================
// WorldRuleValidator — Enforce logical_consequences from rule definitions
// ============================================================================

import type {
  NarrativeEvent,
  Validator,
  ValidatorContext,
  ValidationIssue,
  WorldState,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class WorldRuleValidator implements Validator {
  name = 'world_rule';
  category = 'worldbuilding' as const;
  requiresLLM = false;

  validate(event: NarrativeEvent, context: ValidatorContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check postconditions against world rules
    for (const pc of event.postconditions) {
      const entity = context.entityRegistry.resolve(pc.entityId);
      if (!entity) continue;

      // Check: entity_kind == 'character' AND traits contains 'hextech_augmented'
      const traits = entity.state['traits'] as string[] | undefined;
      if (traits?.includes('hextech_augmented') && pc.attribute === 'condition') {
        if (
          pc.value !== 'operational' &&
          pc.value !== 'healthy'
        ) {
          issues.push(makeIssue(
            this.name, event.id, pc.entityId, 'warning',
            `Hextech-augmented character "${pc.entityId}" has condition "${pc.value}" — hextech augmentations should remain operational`,
            'Ensure hextech-augmented characters maintain operational physical state.',
            'change_value',
            'condition',
          ));
        }
      }

      // Check: condition contains 'shimmer' → status != 'healthy'
      const condition = context.queryState(pc.entityId, 'condition');
      if (
        typeof condition === 'string' &&
        condition.includes('shimmer') &&
        pc.attribute === 'status' &&
        pc.value === 'healthy'
      ) {
        issues.push(makeIssue(
          this.name, event.id, pc.entityId, 'error',
          `Character "${pc.entityId}" has shimmer damage but is set to healthy status (violates shimmer rule)`,
          'Shimmer-damaged characters cannot be healthy. Use "stable" or "deteriorating" instead.',
          'change_value',
          'status',
        ));
      }
    }

    return issues;
  }

  validateRender(prose: string, event: NarrativeEvent, state: WorldState): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const lowerProse = prose.toLowerCase();

    // Check each active rule for possible prose violations
    for (const [ruleId, ruleData] of Object.entries(state.rules)) {
      if ((ruleData.activeEvidence ?? 0) <= 0) continue;

      const ruleLower = ruleId.toLowerCase();

      // Duration/time rules: flag mention of large time skips
      if (/duration|time|day|week|month/.test(ruleLower)) {
        const skipPatterns = ['a week later', 'weeks later', 'a month later', 'months later', 'days later'];
        for (const pat of skipPatterns) {
          if (lowerProse.includes(pat)) {
            issues.push(makeIssue(
              this.name, event.id, event.pov.character, 'warning',
              `Active rule "${ruleId}" may be violated: prose mentions "${pat}" which implies a time skip`,
              'Ensure time progression respects the limits set by active world rules.',
              'edit_file',
              'prose',
            ));
            break;
          }
        }
      }

      // Travel/distance rules: flag instant movement
      if (/distance|travel|move|location/.test(ruleLower)) {
        if (/\b(teleported|appeared suddenly|materialized|instantly arrived)\b/i.test(prose)) {
          issues.push(makeIssue(
            this.name, event.id, event.pov.character, 'warning',
            `Active rule "${ruleId}" may be violated: prose suggests instant travel`,
            'Ensure character movement respects the distance/travel rules of the world.',
            'edit_file',
            'prose',
          ));
        }
      }
    }

    return issues;
  }
}

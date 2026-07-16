// ============================================================================
// WorldRuleValidator — Enforce logical_consequences from rule definitions
// ============================================================================

import type {
  NarrativeEvent,
  Validator,
  ValidatorContext,
  ValidationIssue,
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
}

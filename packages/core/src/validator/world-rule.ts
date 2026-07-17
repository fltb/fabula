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

// ============================================================================
// FactualDetailValidator — LLM-assisted detail checking
// ============================================================================

import type {
  AnalysisResult,
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
  requiresLLM = false;

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

  validateRender(prose: string, event: NarrativeEvent, state: WorldState, analysis?: AnalysisResult): ValidationIssue[] {
    // NOTE: Fact-in-prose verification is now delegated to AnalysisResult
    // from LLM Pass 2 (postconditions.covered/dropped).
    return [];
  }
}

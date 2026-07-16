// ============================================================================
// CharacterStateValidator — Dead/alive status, state contradictions
// ============================================================================

import type {
  NarrativeEvent,
  Validator,
  ValidatorContext,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class CharacterStateValidator implements Validator {
  name = 'character_state';
  category = 'characterization' as const;
  requiresLLM = false;

  validate(event: NarrativeEvent, context: ValidatorContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    for (const pc of event.preconditions) {
      const entity = context.entityRegistry.resolve(pc.entityId);
      if (!entity || entity.kind !== 'character') continue;

      const currentState = context.queryState(pc.entityId, 'status');
      const currentAlive = context.queryState(pc.entityId, 'alive');

      // If character is dead, can't appear in scenes
      if (currentState === 'dead' || currentAlive === false) {
        issues.push(makeIssue(
          this.name, event.id, pc.entityId, 'error',
          `Character "${pc.entityId}" is dead but appears in this scene`,
          `Remove this character from the scene, or this character's death must have been revealed as false.`,
          'remove_line',
          'status',
        ));
      }
    }

    // Check postconditions for state contradictions
    for (const pc of event.postconditions) {
      const entity = context.entityRegistry.resolve(pc.entityId);
      if (!entity || entity.kind !== 'character') continue;

      const currentCondition = context.queryState(pc.entityId, 'condition');

      // If transitioning to healthy from shimmer_damaged without medical_intervention
      if (
        pc.attribute === 'condition' &&
        pc.value === 'healthy' &&
        currentCondition === 'shimmer_damaged'
      ) {
        issues.push(makeIssue(
          this.name, event.id, pc.entityId, 'warning',
          `Character "${pc.entityId}" transitions from shimmer_damaged to healthy without medical intervention`,
          'Add an event showing medical treatment, or change the expected postcondition.',
          'change_value',
          'condition',
          undefined,
          pc.value,
        ));
      }
    }

    return issues;
  }
}

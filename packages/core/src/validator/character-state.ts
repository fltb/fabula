// ============================================================================
// CharacterStateValidator — Dead/alive status, state contradictions
// ============================================================================

import type {
  NarrativeEvent,
  Validator,
  ValidatorContext,
  ValidationIssue,
  WorldState,
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

  validateRender(prose: string, event: NarrativeEvent, state: WorldState): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const lowerProse = prose.toLowerCase();

    for (const pc of event.preconditions) {
      const entityId = pc.entityId;
      if (!entityId) continue;

      const expectedValue = String(pc.value ?? '').toLowerCase();
      if (!expectedValue || expectedValue === 'true' || expectedValue === 'false') continue;

      const entityLower = entityId.toLowerCase();

      // Only check if the entity is mentioned in the prose
      const entityPos = lowerProse.indexOf(entityLower);
      if (entityPos === -1) continue;

      // Look near the entity mention for the expected state value
      const start = Math.max(0, entityPos - 100);
      const end = Math.min(lowerProse.length, entityPos + 100);
      const vicinity = lowerProse.slice(start, end);

      if (!vicinity.includes(expectedValue)) {
        issues.push(makeIssue(
          this.name, event.id, entityId, 'info',
          `Expected "${entityId}" to be "${pc.attribute}=${pc.value}" per preconditions, but prose near "${entityId}" doesn't reflect it`,
          `Describe ${entityId}'s state (${expectedValue}) in the prose to stay consistent with established facts.`,
          'edit_file',
          pc.attribute,
        ));
      }
    }

    return issues;
  }
}

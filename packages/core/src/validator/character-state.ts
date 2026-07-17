// ============================================================================
// CharacterStateValidator — Dead/alive status, state contradictions
// ============================================================================

import type {
  PreRenderInput,
  Validator,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class CharacterStateValidator implements Validator {
  name = 'character_state';
  category = 'characterization' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    for (const pc of input.event.preconditions) {
      const entity = input.entityRegistry.resolve(pc.entityId);
      if (!entity || entity.kind !== 'character') continue;

      const currentState = input.queryState(pc.entityId, 'status');
      const currentAlive = input.queryState(pc.entityId, 'alive');

      // If character is dead, can't appear in scenes
      if (currentState === 'dead' || currentAlive === false) {
        issues.push(makeIssue(
          this.name, input.event.id, pc.entityId, 'error',
          `Character "${pc.entityId}" is dead but appears in this scene`,
          `Remove this character from the scene, or this character's death must have been revealed as false.`,
          'remove_line',
          'status',
        ));
      }
    }

    return issues;
  }
}

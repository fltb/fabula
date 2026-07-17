// ============================================================================
// CharacterStateValidator — Dead/alive status, state contradictions
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

    return issues;
  }

  validateRender(prose: string, event: NarrativeEvent, state: WorldState, analysis?: AnalysisResult): ValidationIssue[] {
    // NOTE: Prose-level precondition/postcondition checking is now delegated
    // to AnalysisResult from LLM Pass 2.
    return [];
  }
}

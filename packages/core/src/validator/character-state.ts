// ============================================================================
// CharacterStateValidator — Dead/alive status, state contradictions
// ============================================================================

import type {
  PostRenderInput,
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

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!input.analysis) return issues;

    const narrativeChecks = input.analysis.analysis.narrativeChecks ?? [];
    for (const check of narrativeChecks) {
      if (check.attribute !== 'character_state') continue;
      if (check.matchLevel === 'absent' || check.matchLevel === 'contradicted') {
        issues.push(makeIssue(
          'character_state',
          input.event.id,
          check.entityId,
          'warning',
          `Character state mismatch: ${check.hint} — ${check.evidence}`,
          'Review character state consistency in prose',
          'edit_file',
          'state',
        ));
      }
    }
    return issues;
  }

  getAnalysisRequirements() {
    return [{
      field: 'narrativeChecks',
      attributes: ['character_state'],
      schemaExample: { entityId: 'char_001', attribute: 'character_state', hint: '...', evidence: '...', matchLevel: 'exact' },
      instruction: 'narrativeChecks[character_state]: For each character, check if the prose depicts their state (alive/dead status, location, emotional state) consistently with the event\'s preconditions. Use the narrativeChecks block with attribute "character_state" to report any contradictions where the prose shows a character in a state that conflicts with established preconditions.',
    }];
  }
}
